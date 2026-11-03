// The image's document sync, on Orca's `orca.document.session()`: Orca keeps the buffer, dirty
// state, saving and flushes; this file says how a file is read, written and merged.
//
// A value is { file, format, original, shapes, hadMarkup, stale? }: `file` is the whole file the
// value saves as, `original` the image under the markup and `shapes` the markup. Encoding a scene
// into a file is asynchronous (the editor does it before `change`), so `encode` only hands over
// `file`. A merge that moved markup onto a new image can't encode, so it returns `stale: true`
// with the outside file; the editor encodes it and sends the result as its next change.
import { SAVABLE_FORMATS, detectFormat, imageSize, readMarkup, sameBytes } from './container.js'
import { parseScene, serializeScene } from './scene.js'

/** A file's bytes as a value; a file this plugin did not write is an original with no shapes. */
export function decodeImage(content) {
  const file = new Uint8Array(content.bytes)
  const format = detectFormat(file)
  const plain = { file, format, original: file, shapes: [], hadMarkup: false }
  if (!SAVABLE_FORMATS.has(format)) return plain
  let markup = null
  try {
    markup = readMarkup(file, format)
  } catch {
    // Malformed markup data: open the file as a plain image.
  }
  const size = markup && imageSize(markup.original)
  const shapes = size && parseScene(markup.scene, size[0], size[1])
  if (!shapes) return plain
  return { file, format, original: markup.original.slice(), shapes, hadMarkup: shapes.length > 0 }
}

const exactBuffer = (bytes) =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer

export const encodeImage = (value) => ({ kind: 'bytes', bytes: exactBuffer(value.file) })

/** A shape's identity across files: what the file stores of it. Ids are per load and not saved. */
const shapeKey = (shape) => JSON.stringify(serializeScene([shape], 0, 0).shapes[0])

/**
 * Three-way merge: the outside file's image and its shapes, with the shapes this editor added
 * since `base` on top and the ones it removed gone. An agent rewriting a screenshot under unsaved
 * markup gets the markup moved onto its new image, not dropped.
 */
export function mergeImages(base, outside, mine) {
  // Orca sent back what this editor already had (say, its own edit, saved): nothing to merge.
  if (sameFile(base, outside)) return mine
  const baseKeys = new Set(base.shapes.map(shapeKey))
  const mineKeys = new Set(mine.shapes.map(shapeKey))
  const removed = (shape) => baseKeys.has(shapeKey(shape)) && !mineKeys.has(shapeKey(shape))
  const kept = outside.shapes.filter((shape) => !removed(shape))
  const keptKeys = new Set(kept.map(shapeKey))
  const added = mine.shapes.filter((shape) => !baseKeys.has(shapeKey(shape)) && !keptKeys.has(shapeKey(shape)))
  if (added.length === 0 && kept.length === outside.shapes.length) return outside
  const shapes = [...kept, ...added]
  // Only PNG and JPEG keep markup; on another format the shapes still show until the tab closes.
  return { ...outside, shapes, hadMarkup: outside.hadMarkup, stale: true }
}

/** Whether two values save as the same file. */
export const sameFile = (a, b) => a === b || sameBytes(a.file, b.file)

/** Orca's document session for an image. */
export function openImageSession() {
  return globalThis.orca.document.session({
    decode: decodeImage,
    encode: encodeImage,
    merge: mergeImages,
    // The editor already waits for a pause and the encode before each change.
    debounceMs: 0
  })
}
