// The drawing's document sync, on Orca's `orca.document.session()`: Orca keeps the buffer, dirty
// state, saving and flushes; this file only says how a scene is read, written and merged.
import { parseExcalidrawScene, withExcalidrawSceneSource } from './excalidraw-scene.js'

/** The canvas settings a `.excalidraw` file keeps; selection, scroll and zoom never reach it. */
export const SAVED_APP_STATE = ['viewBackgroundColor', 'gridModeEnabled', 'gridSize', 'gridStep']

export function pickSavedAppState(appState = {}) {
  return Object.fromEntries(SAVED_APP_STATE.filter((key) => key in appState).map((key) => [key, appState[key]]))
}

/** A file's text as `{ elements, appState, files, source }`, or `{ error }` when it is no scene. */
export function decodeScene(text) {
  try {
    const { data, source } = parseExcalidrawScene(text)
    return { elements: data.elements ?? [], appState: pickSavedAppState(data.appState), files: data.files ?? {}, source }
  } catch (error) {
    return { error: error.message }
  }
}

const live = (element) => (element && !element.isDeleted ? element : undefined)
// Why the nonce too: different edits can reach the same version; Excalidraw tells them apart by it.
const sameElement = (a, b) =>
  a === b || (a !== undefined && b !== undefined && a.version === b.version && a.versionNonce === b.versionNonce)

/**
 * Three-way merge by element id: what this canvas changed since `base` wins, everything else comes
 * from `outside` (an agent or another editor). Canvas settings merge the same way, field by field.
 */
export function mergeScenes(base, outside, mine) {
  if (base.error || outside.error || mine.error) {
    return outside
  }
  const byId = (scene) => new Map(scene.elements.map((element) => [element.id, element]))
  const [was, theirs, ours] = [byId(base), byId(outside), byId(mine)]
  const ids = [...new Set([...theirs.keys(), ...ours.keys()])]
  const elements = ids
    .map((id) => {
      const mineChanged = !sameElement(live(was.get(id)), live(ours.get(id)))
      return live(mineChanged ? ours.get(id) : theirs.get(id))
    })
    .filter(Boolean)
  const appState = { ...outside.appState }
  for (const key of SAVED_APP_STATE) {
    if (mine.appState[key] !== base.appState[key]) {
      appState[key] = mine.appState[key]
    }
  }
  return { elements, appState, files: { ...outside.files, ...mine.files }, source: outside.source }
}

/** Orca's document session for a drawing; `serialize` writes a scene as Excalidraw does. */
export function openSceneSession(serialize) {
  return globalThis.orca.document.session({
    decode: (content) => decodeScene(content.text),
    encode: (scene) => ({ kind: 'text', text: withExcalidrawSceneSource(serialize(scene), scene.source) }),
    merge: mergeScenes
  })
}
