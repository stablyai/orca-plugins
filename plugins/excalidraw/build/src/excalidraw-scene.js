// Scene parsing and `source` preservation, after stablyai/orca#27413 by Roughriver74.

export const EMPTY_EXCALIDRAW_SCENE = '{"type":"excalidraw"}'

/**
 * Parses a `.excalidraw` document; an empty file is a blank scene. Throws a readable Error
 * otherwise, about `subject` (the file, or the scene an image embeds).
 */
export function parseExcalidrawScene(text, subject = 'the file') {
  let data
  try {
    data = JSON.parse(text.trim() === '' ? EMPTY_EXCALIDRAW_SCENE : text)
  } catch (error) {
    throw new Error(`${subject} is not valid JSON (${error.message})`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data) || data.type !== 'excalidraw') {
    throw new Error(`${subject} is not an Excalidraw scene (expected "type": "excalidraw")`)
  }
  if (data.elements !== undefined && !Array.isArray(data.elements)) {
    throw new Error('"elements" must be an array')
  }
  return { data, source: typeof data.source === 'string' ? data.source : undefined }
}

/** Restores the file's original `source` so saving from Orca does not rewrite it. */
export function withExcalidrawSceneSource(json, source) {
  if (source === undefined) {
    return json
  }
  return JSON.stringify({ ...JSON.parse(json), source }, null, 2)
}
