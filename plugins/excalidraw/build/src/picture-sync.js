// Keeps the picture of an `.excalidraw.svg` or `.excalidraw.png` drawing in step with its scene.
// The session's encode is synchronous, so an edit saves its scene at once inside the last picture
// (the scene is then `stale`); this draws the picture again once the canvas is idle, and sends it.

/**
 * How long a save may take here. Orca gives an editor's whole flush 1 s, timed on its side, so the
 * rest is left for the messages and for the frame being busy when the save comes.
 */
export const FLUSH_BUDGET_MS = 800
const IDLE_MS = 300
// The host's part of sending one edit: posting it, applying it and answering.
const HOST_MS = 100

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

/**
 * `render(scene)` draws a scene's picture. Make this before the session opens, with `timing` passed
 * to `openSceneSession`, then `attach` the session: this save handler must run before the
 * session's, which encodes the scene at once, so the whole save is timed. Call `schedule()` after
 * each canvas edit; outside changes that need a new picture (merges) and saves are handled here.
 */
export function syncPicture({ render, onError, idleMs = IDLE_MS, budgetMs = FLUSH_BUDGET_MS }) {
  // The session's last encode and decode: sending the picture takes one of each.
  const timing = { encodeMs: 0, decodeMs: 0 }
  let doc = null
  let replaced = null
  let timer = null
  let drawing = null
  // Why: a scene that failed to draw is not retried until it changes, so a save shows one error.
  let failed = null
  // A picture drawn during a save waits for it, so only the save decides whether it is sent then.
  let saving = 0
  let held = null
  let disposed = false

  const needsDrawing = (scene) =>
    !disposed && !scene.error && scene.stale === true && scene !== failed && scene !== held?.scene

  function apply(scene, image) {
    // Only the scene it shows may carry it; a newer scene gets its own.
    if (disposed || doc.value !== scene) {
      return
    }
    if (saving > 0) {
      held = { scene, image }
      return
    }
    doc.change({ ...scene, image, stale: false })
  }

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
        (image) => apply(scene, image),
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

  /** Draws the newest scene now, and sends it too if that still fits in the save's time. */
  async function settle() {
    const started = performance.now()
    if (!doc || !needsDrawing(doc.value) || doc.readOnly) {
      return
    }
    // Why counted: past Orca's deadline the save fails, though the scene it holds is current.
    const left = () => budgetMs - (performance.now() - started) - (timing.encodeMs + timing.decodeMs + HOST_MS)
    saving += 1
    try {
      // The save begins by sending the new scene in the old picture.
      await doc.flush()
      // Why not drawn alongside: drawing a large scene slows that send, and the picture would not fit.
      if (left() <= 0) {
        return
      }
      const drawn = (async () => {
        await draw()
        // The drawing under way may have been of an older scene.
        await draw()
      })()
      await Promise.race([drawn, delay(left())])
      if (held && held.scene === doc.value && left() >= 0) {
        const { scene, image } = held
        held = null
        doc.change({ ...scene, image, stale: false })
        await doc.flush()
      }
    } finally {
      saving -= 1
      // A picture the save left out is sent after it, marking the tab changed again.
      if (saving === 0 && held) {
        const { scene, image } = held
        held = null
        apply(scene, image)
      }
    }
  }

  const flushes = globalThis.orca.on('editor.flush', settle)
  return {
    timing,
    schedule,
    attach(session) {
      doc = session
      // A file renamed from another format opens without its picture.
      if (needsDrawing(doc.value)) {
        schedule()
      }
      replaced = doc.onReplace((scene) => {
        if (needsDrawing(scene)) {
          schedule()
        }
      })
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      replaced?.dispose()
      flushes.dispose()
    }
  }
}
