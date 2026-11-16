// The canvas's scroll and zoom in this tab. Orca keeps it (`orca.document.setViewState`) while it
// runs and hands it back when the tab's editor opens again, so switching tabs keeps the drawing
// where it was. It never reaches the file. An Orca without view state scrolls to the content.

/** At most one post per this many ms while the canvas moves: every post spends frame budget. */
const KEEP_EVERY_MS = 200

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** The kept view as Excalidraw appState fields, or null when there is none. */
export function keptView(documentApi = globalThis.orca?.document) {
  const view = typeof documentApi?.getViewState === 'function' ? documentApi.getViewState() : null
  if (!view || !finite(view.scrollX) || !finite(view.scrollY) || !finite(view.zoom) || view.zoom <= 0) {
    return null
  }
  return { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom } }
}

/**
 * `keep(appState)` for each canvas change. A moved view is kept at once, then at most every
 * `everyMs` while it keeps moving, ending with where it stopped. Why not only once it rests: Orca
 * unloads the frame on a tab switch, so a view still waiting would be lost.
 */
export function viewKeeper(documentApi = globalThis.orca?.document, everyMs = KEEP_EVERY_MS) {
  if (typeof documentApi?.setViewState !== 'function') {
    return () => {}
  }
  const shown = keptView(documentApi)
  let kept = shown && JSON.stringify({ scrollX: shown.scrollX, scrollY: shown.scrollY, zoom: shown.zoom.value })
  let latest = null
  let timer = null
  const send = () => {
    const next = JSON.stringify(latest)
    if (next !== kept) {
      kept = next
      documentApi.setViewState(latest)
    }
  }
  const cool = () => {
    timer = null
    if (JSON.stringify(latest) !== kept) {
      send()
      timer = setTimeout(cool, everyMs)
    }
  }
  return (appState) => {
    latest = { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value }
    if (timer === null && JSON.stringify(latest) !== kept) {
      send()
      timer = setTimeout(cool, everyMs)
    }
  }
}
