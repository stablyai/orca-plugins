// The scene that `.excalidraw.svg` and `.excalidraw.png` images carry, read and written in
// Excalidraw's own format (its data/encode.ts, data/image.ts and scene/export.ts), so Excalidraw
// opens what Orca saves and Orca opens what Excalidraw exports with "Embed scene".
import { deflate, inflate } from 'pako'

export const EXCALIDRAW_MIME = 'application/vnd.excalidraw+json'

const NO_SCENE = 'has no embedded Excalidraw scene (export it from Excalidraw with "Embed scene" on)'

function toByteString(bytes) {
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return text
}

function fromByteString(text) {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index++) {
    bytes[index] = text.charCodeAt(index)
  }
  return bytes
}

/** Excalidraw's `encode`: the scene JSON deflated, as a byte string. */
function encodePayload(json) {
  return { version: '1', encoding: 'bstring', compressed: true, encoded: toByteString(deflate(json)) }
}

/** Excalidraw's `decode`, plus the old payloads that held the scene JSON itself. */
function decodePayload(json) {
  let data
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('its embedded Excalidraw scene is damaged')
  }
  if (!('encoded' in data)) {
    if (data.type === 'excalidraw') {
      return json
    }
    throw new Error('its embedded Excalidraw scene is damaged')
  }
  if (data.encoding !== 'bstring' || typeof data.encoded !== 'string') {
    throw new Error(`its embedded Excalidraw scene has an unknown encoding (${String(data.encoding)})`)
  }
  try {
    return data.compressed
      ? inflate(fromByteString(data.encoded), { to: 'string' })
      : new TextDecoder().decode(fromByteString(data.encoded))
  } catch {
    throw new Error('its embedded Excalidraw scene is damaged')
  }
}

// --- SVG: the scene is base64 in comments inside <metadata>.

const SVG_PAYLOAD_TYPE = `<!-- payload-type:${EXCALIDRAW_MIME} -->`
const SVG_PAYLOAD = /<!-- payload-start -->\s*(.+?)\s*<!-- payload-end -->/
const SVG_PAYLOAD_SPAN = /<!-- payload-type:application\/vnd\.excalidraw\+json -->[^]*?<!-- payload-end -->/
const SVG_ROOT = /<svg\b[^>]*?(\/?)>/
const SVG_EMPTY_METADATA = /<metadata\s*(?:\/>|>\s*<\/metadata>)/

/** The scene JSON an Excalidraw SVG embeds. Throws a readable Error when there is none. */
export function readSvgScene(svg) {
  if (!SVG_ROOT.test(svg)) {
    throw new Error('the file is not an SVG image')
  }
  if (!svg.includes(SVG_PAYLOAD_TYPE)) {
    throw new Error(`the SVG ${NO_SCENE}`)
  }
  const payload = SVG_PAYLOAD.exec(svg)?.[1]
  if (payload === undefined) {
    throw new Error('its embedded Excalidraw scene is damaged')
  }
  let json
  try {
    json = atob(payload)
  } catch {
    throw new Error('its embedded Excalidraw scene is damaged')
  }
  // Why: version 1 held UTF-8 JSON; version 2 holds byte-string JSON (Excalidraw's base64ToString).
  const version = /<!-- payload-version:(\d+) -->/.exec(svg)?.[1] ?? '1'
  return decodePayload(version === '1' ? new TextDecoder().decode(fromByteString(json)) : json)
}

/** The SVG with `sceneJson` as its embedded scene, in place of any scene it had. */
export function embedSvgScene(svg, sceneJson) {
  const payload =
    `${SVG_PAYLOAD_TYPE}<!-- payload-version:2 --><!-- payload-start -->` +
    `${btoa(JSON.stringify(encodePayload(sceneJson)))}<!-- payload-end -->`
  if (SVG_PAYLOAD_SPAN.test(svg)) {
    return svg.replace(SVG_PAYLOAD_SPAN, () => payload)
  }
  if (SVG_EMPTY_METADATA.test(svg)) {
    return svg.replace(SVG_EMPTY_METADATA, () => `<metadata>${payload}</metadata>`)
  }
  if (!SVG_ROOT.test(svg)) {
    throw new Error('the file is not an SVG image')
  }
  return svg.replace(SVG_ROOT, (root, selfClosing) =>
    selfClosing
      ? `${root.slice(0, -2).trimEnd()}><metadata>${payload}</metadata></svg>`
      : `${root}<metadata>${payload}</metadata>`
  )
}

/** How an Excalidraw SVG was exported: its scale, whether it has a background, and dark mode. */
export function readSvgLook(svg) {
  const root = SVG_ROOT.exec(svg)?.[0] ?? ''
  const attribute = (name) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(root)?.[1]
  const width = Number(attribute('width'))
  const viewBoxWidth = Number(attribute('viewBox')?.trim().split(/[\s,]+/)[2])
  const scale = width > 0 && viewBoxWidth > 0 ? Math.round((width / viewBoxWidth) * 100) / 100 : 1
  return {
    scale,
    // Excalidraw draws the background as a rect at 0,0 right after <defs>.
    background: /<\/defs>\s*<rect x="0" y="0"/.test(svg),
    dark: /^\s*invert\(/.test(attribute('filter') ?? '')
  }
}

/** An empty Excalidraw SVG, until the first drawing replaces it. */
export const BLANK_SVG =
  '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">' +
  '<!-- svg-source:excalidraw --><metadata></metadata><defs></defs></svg>'

// --- PNG: the scene is a tEXt chunk keyed by Excalidraw's MIME type.

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return c >>> 0
})

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const latin1 = (bytes) => toByteString(bytes)

/** A PNG's chunks as `{ name, data }`. Throws a readable Error when it is no PNG. */
export function readPngChunks(bytes) {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('the file is not a PNG image')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks = []
  for (let at = 8; at < bytes.length; ) {
    if (at + 12 > bytes.length) {
      throw new Error('the PNG image is damaged')
    }
    const length = view.getUint32(at)
    const end = at + 12 + length
    if (end > bytes.length) {
      throw new Error('the PNG image is damaged')
    }
    const name = latin1(bytes.subarray(at + 4, at + 8))
    chunks.push({ name, data: bytes.subarray(at + 8, at + 8 + length) })
    if (name === 'IEND') {
      break
    }
    at = end
  }
  if (chunks[0]?.name !== 'IHDR' || chunks.at(-1)?.name !== 'IEND') {
    throw new Error('the PNG image is damaged')
  }
  return chunks
}

/** The PNG file made of `chunks`, each with its CRC. */
export function writePngChunks(chunks) {
  const out = new Uint8Array(8 + chunks.reduce((sum, chunk) => sum + 12 + chunk.data.length, 0))
  const view = new DataView(out.buffer)
  out.set(PNG_SIGNATURE)
  let at = 8
  for (const { name, data } of chunks) {
    view.setUint32(at, data.length)
    const typed = out.subarray(at + 4, at + 8 + data.length)
    typed.set(fromByteString(name))
    typed.set(data, 4)
    view.setUint32(at + 8 + data.length, crc32(typed))
    at += 12 + data.length
  }
  return out
}

const sceneChunk = (chunk) => {
  if (chunk.name !== 'tEXt') return undefined
  const separator = chunk.data.indexOf(0)
  return separator !== -1 && latin1(chunk.data.subarray(0, separator)) === EXCALIDRAW_MIME
    ? latin1(chunk.data.subarray(separator + 1))
    : undefined
}

/** The scene JSON an Excalidraw PNG embeds. Throws a readable Error when there is none. */
export function readPngScene(bytes) {
  const text = readPngChunks(bytes).map(sceneChunk).find((found) => found !== undefined)
  if (text === undefined) {
    throw new Error(`the PNG ${NO_SCENE}`)
  }
  return decodePayload(text)
}

/** The PNG with `sceneJson` as its embedded scene, in place of any scene it had. */
export function embedPngScene(bytes, sceneJson) {
  const chunks = readPngChunks(bytes).filter((chunk) => sceneChunk(chunk) === undefined)
  // Latin-1 by construction: a byte string inside JSON, whose escapes keep out NUL.
  const text = fromByteString(`${EXCALIDRAW_MIME}\0${JSON.stringify(encodePayload(sceneJson))}`)
  // Why right after IHDR: Excalidraw reads only the first tEXt chunk of a PNG.
  chunks.splice(1, 0, { name: 'tEXt', data: text })
  return writePngChunks(chunks)
}

/** A PNG's size in pixels, from its header. */
export function readPngSize(bytes) {
  const header = readPngChunks(bytes)[0].data
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  return { width: view.getUint32(0), height: view.getUint32(4) }
}

/** A transparent 1×1 PNG, until the first drawing replaces it. */
export function blankPng() {
  const header = new Uint8Array(13)
  new DataView(header.buffer).setUint32(0, 1)
  new DataView(header.buffer).setUint32(4, 1)
  header.set([8, 6, 0, 0, 0], 8)
  return writePngChunks([
    { name: 'IHDR', data: header },
    { name: 'IDAT', data: deflate(new Uint8Array(5)) },
    { name: 'IEND', data: new Uint8Array(0) }
  ])
}
