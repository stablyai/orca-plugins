// The canvas's scroll and zoom in this tab. Orca keeps it (`orca.document.setViewState`) while it
// runs and hands it back when the tab's editor opens again, so switching tabs keeps the drawing
// where it was. It never reaches the file. An Orca without view state scrolls to the content.

/** Wait after the canvas stops moving before keeping its view: every post spends frame budget. */
const KEEP_AFTER_MS = 200

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** The kept view as Excalidraw appState fields, or null when there is none. */
export function keptView(documentApi = globalThis.orca?.document) {
  const view = typeof documentApi?.getViewState === 'function' ? documentApi.getViewState() : null
  if (!view || !finite(view.scrollX) || !finite(view.scrollY) || !finite(view.zoom) || view.zoom <= 0) {
    return null
  }
  return { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom } }
}

/** `keep(appState)` for each canvas change; the view is kept once the canvas rests. */
export function viewKeeper(documentApi = globalThis.orca?.document, delayMs = KEEP_AFTER_MS) {
  if (typeof documentApi?.setViewState !== 'function') {
    return () => {}
  }
  const shown = keptView(documentApi)
  let kept = shown && JSON.stringify({ scrollX: shown.scrollX, scrollY: shown.scrollY, zoom: shown.zoom.value })
  let latest = null
  let timer = null
  const send = () => {
    timer = null
    const next = JSON.stringify(latest)
    if (next !== kept) {
      kept = next
      documentApi.setViewState(latest)
    }
  }
  return (appState) => {
    latest = { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value }
    clearTimeout(timer)
    timer = setTimeout(send, delayMs)
  }
}
