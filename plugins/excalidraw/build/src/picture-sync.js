// Keeps the picture of an `.excalidraw.svg` or `.excalidraw.png` drawing in step with its scene.
// The session's encode is synchronous, so an edit saves its scene at once inside the last picture
// (the scene is then `stale`); this draws the picture again once the canvas is idle, and sends it.

/** How long a save waits for the picture: Orca gives an editor's whole flush 1 s. */
export const FLUSH_WAIT_MS = 700
const IDLE_MS = 300

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `render(scene)` draws a scene's picture. Call `schedule()` after each canvas edit; outside
 * changes that need a new picture (merges) and saves are handled here.
 */
export function syncPicture(doc, { render, onError, idleMs = IDLE_MS, flushWaitMs = FLUSH_WAIT_MS }) {
  let timer = null
  let drawing = null
  // Why: a scene that failed to draw is not retried until it changes, so a save shows one error.
  let failed = null
  let disposed = false

  const needsDrawing = (scene) => !disposed && !scene.error && scene.stale === true && scene !== failed

  function draw() {
    clearTimeout(timer)
    timer = null
    if (drawing) {
      return drawing
    }
    const scene = doc.value
    if (!needsDrawing(scene)) {
      return Promise.resolve()
    }
    drawing = Promise.resolve()
      .then(() => render(scene))
      .then(
        (image) => {
          // Only the scene it shows may carry it; a newer scene gets its own.
          if (!disposed && doc.value === scene) {
            doc.change({ ...scene, image, stale: false })
          }
        },
        (error) => {
          failed = scene
          onError(error)
        }
      )
      .finally(() => {
        drawing = null
        if (timer === null && needsDrawing(doc.value)) {
          schedule()
        }
      })
    return drawing
  }

  function schedule() {
    clearTimeout(timer)
    timer = disposed ? null : setTimeout(draw, idleMs)
  }

  /** Draws the newest scene now, waiting at most `flushWaitMs`, and sends it. */
  async function settle() {
    if (!needsDrawing(doc.value) || doc.readOnly) {
      return
    }
    const drawn = (async () => {
      await draw()
      // The drawing under way may have been of an older scene.
      await draw()
    })()
    // Why bounded: past Orca's deadline the save fails; the scene saved is current either way,
    // and a late picture marks the tab changed again.
    await Promise.race([drawn, delay(flushWaitMs)])
    await doc.flush()
  }

  const replaced = doc.onReplace((scene) => {
    if (needsDrawing(scene)) {
      schedule()
    }
  })
  const flushes = globalThis.orca.on('editor.flush', settle)
  return {
    schedule,
    settle,
    dispose() {
      disposed = true
      clearTimeout(timer)
      replaced.dispose()
      flushes.dispose()
    }
  }
}
