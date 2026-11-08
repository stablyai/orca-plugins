// The drawing's document sync, on Orca's `orca.document.session()`: Orca keeps the buffer, dirty
// state, saving and flushes; this file only says how a scene is read, written and merged.
import { parseExcalidrawScene, withExcalidrawSceneSource } from './excalidraw-scene.js'
import { BLANK_SVG, blankPng, embedPngScene, embedSvgScene, isPng, readPngScene, readSvgLook, readSvgScene } from './excalidraw-image.js'

/** The canvas settings a `.excalidraw` file keeps; selection, scroll and zoom never reach it. */
export const SAVED_APP_STATE = ['viewBackgroundColor', 'gridModeEnabled', 'gridSize', 'gridStep']

export function pickSavedAppState(appState = {}) {
  return Object.fromEntries(SAVED_APP_STATE.filter((key) => key in appState).map((key) => [key, appState[key]]))
}

function sceneOf(json, subject) {
  const { data, source } = parseExcalidrawScene(json, subject)
  return { elements: data.elements ?? [], appState: pickSavedAppState(data.appState), files: data.files ?? {}, source }
}

/**
 * A `.excalidraw` file's text as `{ format: 'json', elements, appState, files, source }`, or
 * `{ format, error }` when it is no scene.
 */
export function decodeScene(text) {
  try {
    return { format: 'json', ...sceneOf(text) }
  } catch (error) {
    return { format: 'json', error: error.message }
  }
}

const JSON_TEXT = /^\s*\{/

/**
 * A file renamed from another Excalidraw format (`.excalidraw`, or `.excalidraw.svg` to `.png`), as
 * its scene JSON and, from an SVG, its look; undefined when the file is in its own format.
 */
function renamedScene(format, image) {
  if (format === 'svg') {
    return JSON_TEXT.test(image) ? { json: image } : undefined
  }
  if (isPng(image)) {
    return undefined
  }
  const text = new TextDecoder().decode(image)
  if (JSON_TEXT.test(text)) {
    return { json: text }
  }
  return /^\s*(<\?xml[^>]*>\s*)?<svg\b/.test(text) ? { json: readSvgScene(text), look: readSvgLook(text) } : undefined
}

/**
 * An `.excalidraw.svg` (text) or `.excalidraw.png` (bytes) file as the scene it embeds, plus
 * `image`: the picture as last drawn, and `stale`: whether the scene changed since. An empty file
 * is a blank scene with no picture yet. A file renamed from another Excalidraw format opens as its
 * scene, with no picture: drawing one converts it, as a change that the next save writes.
 */
export function decodeImageScene(content) {
  const format = content.kind === 'bytes' ? 'png' : 'svg'
  try {
    const image = format === 'png' ? new Uint8Array(content.bytes) : content.text
    if (format === 'png' ? image.length === 0 : image.trim() === '') {
      return { format, ...sceneOf(''), image: null, stale: false }
    }
    const renamed = renamedScene(format, image)
    if (renamed) {
      return { format, ...sceneOf(renamed.json), ...(renamed.look && { look: renamed.look }), image: null, stale: true }
    }
    const json = format === 'png' ? readPngScene(image) : readSvgScene(image)
    return { format, ...sceneOf(json, 'its embedded scene'), image, stale: false }
  } catch (error) {
    return { format, error: error.message }
  }
}

/** The file for a scene: its JSON, or its picture with the scene embedded in Excalidraw's format. */
export function encodeScene(scene, serialize) {
  const json = withExcalidrawSceneSource(serialize(scene), scene.source)
  if (scene.format === 'svg') {
    return { kind: 'text', text: embedSvgScene(scene.image ?? BLANK_SVG, json) }
  }
  if (scene.format === 'png') {
    return { kind: 'bytes', bytes: embedPngScene(scene.image ?? blankPng(), json).buffer }
  }
  return { kind: 'text', text: json }
}

/** The scene after a canvas edit: its picture, if it has one, no longer shows it. */
export const editedScene = (scene, parts) => ({ ...scene, ...parts, ...(scene.format === 'json' ? {} : { stale: true }) })

const live = (element) => (element && !element.isDeleted ? element : undefined)
// Why the nonce too: different edits can reach the same version; Excalidraw tells them apart by it.
const sameElement = (a, b) =>
  a === b || (a !== undefined && b !== undefined && a.version === b.version && a.versionNonce === b.versionNonce)

/**
 * Three-way merge by element id: what this canvas changed since `base` wins, everything else comes
 * from `outside` (an agent or another editor). Canvas settings merge the same way, field by field.
 * An image keeps the outside picture until the editor draws the merged scene.
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
  // A look picked here wins, as a canvas change does.
  const look = mine.look !== base.look && mine.look ? { look: mine.look } : {}
  return editedScene(outside, { elements, appState, files: { ...outside.files, ...mine.files }, ...look })
}

/**
 * Orca's document session for a drawing; `serialize` writes a scene as Excalidraw does. `image`
 * opens `.excalidraw.svg` and `.excalidraw.png` files instead of `.excalidraw` ones. `timing`, if
 * given, gets how long the last encode and decode took, as `encodeMs` and `decodeMs`.
 */
export function openSceneSession(serialize, { image = false, timing } = {}) {
  const timed = (key, fn) => (value) => {
    const started = performance.now()
    try {
      return fn(value)
    } finally {
      if (timing) {
        timing[key] = performance.now() - started
      }
    }
  }
  return globalThis.orca.document.session({
    decode: timed('decodeMs', (content) => (image ? decodeImageScene(content) : decodeScene(content.text))),
    encode: timed('encodeMs', (scene) => encodeScene(scene, serialize)),
    merge: mergeScenes
  })
}
