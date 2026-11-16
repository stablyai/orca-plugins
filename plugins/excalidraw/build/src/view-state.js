// The canvas's scroll and zoom in this tab. Orca keeps it (`orca.document.setViewState`) while it
// runs and hands it back when the tab's editor opens again, so switching tabs keeps the drawing
// where it was. It never reaches the file. An Orca without view state scrolls to the content.

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
 * `keep(appState)` for each canvas change: posts the view whenever it moved. Why not debounced:
 * Orca unloads the frame on a tab switch, and a view waiting on a timer would go with it. Excalidraw
 * reports a pan at most once a frame, which Orca's view lane takes.
 */
export function viewKeeper(documentApi = globalThis.orca?.document) {
  if (typeof documentApi?.setViewState !== 'function') {
    return () => {}
  }
  const shown = keptView(documentApi)
  let kept = shown && JSON.stringify({ scrollX: shown.scrollX, scrollY: shown.scrollY, zoom: shown.zoom.value })
  return (appState) => {
    const view = { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value }
    const next = JSON.stringify(view)
    if (next !== kept) {
      kept = next
      documentApi.setViewState(view)
    }
  }
}
