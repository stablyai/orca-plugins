// Draws the picture of an `.excalidraw.svg` or `.excalidraw.png` drawing as Excalidraw exports it,
// keeping the file's export options (its look): scale, background and dark mode. Excalidraw keeps
// none of them in the scene, so they are read from the picture itself, unless the person picked
// others for this file (`scene.look`). A file without a picture yet gets the last look picked.
import { MIME_TYPES, exportToBlob, exportToSvg, getCommonBounds, getNonDeletedElements, restoreElements } from '@excalidraw/excalidraw'
import { notePngLook, readNotedPngLook, readPngScene, readPngSize, readSvgLook } from './excalidraw-image.js'
import { parseExcalidrawScene } from './excalidraw-scene.js'

// Excalidraw's DEFAULT_EXPORT_PADDING and its export dialog's scales.
const PADDING = 10
export const SCALES = [1, 2, 3]
/** Excalidraw's export defaults, for a new file until the person picks a look. */
const DEFAULT_LOOK = Object.freeze({ scale: 1, background: true, dark: false })
const LOOK_KEY = 'orca-excalidraw-picture-look'

const isLook = (look) =>
  SCALES.includes(look?.scale) && typeof look.background === 'boolean' && typeof look.dark === 'boolean'

/** The look a new picture gets: the last one picked in any file (kept like the library). */
function newLook() {
  try {
    const look = JSON.parse(localStorage.getItem(LOOK_KEY))
    return isLook(look) ? look : DEFAULT_LOOK
  } catch {
    return DEFAULT_LOOK
  }
}

/** Keeps `look` for the pictures of new files too. */
export function rememberLook(look) {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look))
  } catch {}
}

// Why by identity: a PNG's look takes decoding it, and each picture keeps its look.
const pngLooks = new WeakMap()

/** The first pixel of an image, or of a CSS color, as RGBA. */
function pixelOf(source) {
  const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
  if (typeof source === 'string') {
    context.fillStyle = source
    context.fillRect(0, 0, 1, 1)
  } else {
    context.drawImage(source, 0, 0)
  }
  return context.getImageData(0, 0, 1, 1).data
}

/** A PNG export's look: its scale from its size and scene, background and dark mode from a corner. */
async function readPngLook(bytes) {
  const noted = readNotedPngLook(bytes)
  if (noted) {
    return noted
  }
  const { width } = readPngSize(bytes)
  let scale = DEFAULT_LOOK.scale
  let viewBackgroundColor = '#ffffff'
  try {
    const { data } = parseExcalidrawScene(readPngScene(bytes))
    viewBackgroundColor = data.appState?.viewBackgroundColor ?? viewBackgroundColor
    const [minX, , maxX] = getCommonBounds(getNonDeletedElements(restoreElements(data.elements ?? [], null)))
    const ratio = width / (maxX - minX + 2 * PADDING)
    if (Number.isFinite(ratio) && ratio > 0) {
      scale = SCALES.reduce((best, next) => (Math.abs(next - ratio) < Math.abs(best - ratio) ? next : best))
    }
  } catch {
    // A picture without a readable scene keeps the default scale.
  }
  // The top-left corner is export padding: the background, or nothing.
  const bitmap = await createImageBitmap(new Blob([bytes], { type: MIME_TYPES.png }), 0, 0, 1, 1)
  let corner
  try {
    corner = pixelOf(bitmap)
  } finally {
    bitmap.close()
  }
  const background = corner[3] > 0
  // Dark mode draws the background through Excalidraw's invert filter.
  const expected = pixelOf(viewBackgroundColor)
  const distance = [0, 1, 2].reduce((sum, channel) => sum + Math.abs(corner[channel] - expected[channel]), 0)
  return { scale, background, dark: background && distance > 96 }
}

/** How the scene's picture is drawn: as picked for this file, as its picture was, or as new. */
export function lookOf(scene) {
  if (isLook(scene.look)) {
    return Promise.resolve(scene.look)
  }
  if (!scene.image) {
    return Promise.resolve(newLook())
  }
  if (scene.format === 'svg') {
    return Promise.resolve(readSvgLook(scene.image))
  }
  let look = pngLooks.get(scene.image)
  if (!look) {
    look = readPngLook(scene.image).catch((error) => {
      console.error(error)
      return DEFAULT_LOOK
    })
    pngLooks.set(scene.image, look)
  }
  return look
}

/** The scene's picture, without the scene: the session's encode embeds it. */
export async function drawPicture(scene) {
  const look = await lookOf(scene)
  const elements = getNonDeletedElements(scene.elements)
  const appState = {
    ...scene.appState,
    exportBackground: look.background,
    exportWithDarkMode: look.dark,
    exportScale: look.scale,
    exportEmbedScene: false
  }
  if (scene.format === 'svg') {
    const svg = await exportToSvg({ elements, appState, files: scene.files, exportPadding: PADDING })
    return svg.outerHTML
  }
  const blob = await exportToBlob({
    elements,
    appState,
    files: scene.files,
    mimeType: MIME_TYPES.png,
    exportPadding: PADDING,
    getDimensions: (width, height) => ({ width: width * look.scale, height: height * look.scale, scale: look.scale })
  })
  const image = notePngLook(new Uint8Array(await blob.arrayBuffer()), look)
  pngLooks.set(image, Promise.resolve(look))
  return image
}
