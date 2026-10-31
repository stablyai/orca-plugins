// Reads and writes markup stored inside the image file itself.
//
// A saved file is the flattened image (markup burned in, so every other viewer, agent and upload
// shows it) plus one private block holding the markup scene and the original file's exact bytes.
// Markup reopens the original with editable shapes; clearing every shape saves the original back
// byte for byte. PNG keeps the block in an `orCA` chunk (ancillary, private, unsafe to copy, so
// spec-following editors drop it when they change the pixels). JPEG keeps it in APP9 segments.
//
// The block also records a CRC of the flattened pixels it was written with. If another tool has
// since changed the image but kept the block, the CRC no longer matches and the file opens as a
// plain image instead of resurrecting a stale original over someone else's edit.

const PAYLOAD_VERSION = 1
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_CHUNK = 'orCA'
const JPEG_MARKER = 0xe9 // APP9
const JPEG_SIGNATURE = 'ORCA-MARKUP\0'
// Segment length is a u16 that counts itself: 65535 - 2 (length) - 12 (signature) - 4 (index, count).
const JPEG_SEGMENT_DATA = 65517

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 of bytes[start, end), continuing from `crc` (pass the previous result, or omit). */
export function crc32(bytes, start = 0, end = bytes.length, crc = 0) {
  let c = ~crc >>> 0
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

const ascii = (text) => Uint8Array.from(text, (ch) => ch.charCodeAt(0))
const readU32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
const writeU32 = (b, i, v) => {
  b[i] = v >>> 24
  b[i + 1] = (v >>> 16) & 0xff
  b[i + 2] = (v >>> 8) & 0xff
  b[i + 3] = v & 0xff
}
const readU16 = (b, i) => (b[i] << 8) | b[i + 1]
const writeU16 = (b, i, v) => {
  b[i] = v >>> 8
  b[i + 1] = v & 0xff
}
const startsWith = (b, offset, prefix) => {
  if (offset + prefix.length > b.length) return false
  for (let i = 0; i < prefix.length; i++) if (b[offset + i] !== prefix[i]) return false
  return true
}

/** 'png', 'jpeg', or the decodable-but-not-savable 'webp' | 'gif' | 'bmp' | 'avif'; null otherwise. */
export function detectFormat(bytes) {
  if (startsWith(bytes, 0, PNG_SIGNATURE)) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (startsWith(bytes, 0, ascii('RIFF')) && startsWith(bytes, 8, ascii('WEBP'))) return 'webp'
  if (startsWith(bytes, 0, ascii('GIF8'))) return 'gif'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  if (startsWith(bytes, 4, ascii('ftyp')) && (startsWith(bytes, 8, ascii('avif')) || startsWith(bytes, 8, ascii('avis')))) return 'avif'
  return null
}

export const SAVABLE_FORMATS = new Set(['png', 'jpeg'])

function encodePayload(contentCrc, scene, original) {
  const json = new TextEncoder().encode(JSON.stringify(scene))
  const out = new Uint8Array(9 + json.length + original.length)
  out[0] = PAYLOAD_VERSION
  writeU32(out, 1, contentCrc)
  writeU32(out, 5, json.length)
  out.set(json, 9)
  out.set(original, 9 + json.length)
  return out
}

function decodePayload(payload) {
  if (payload.length < 9 || payload[0] !== PAYLOAD_VERSION) return null
  const contentCrc = readU32(payload, 1)
  const jsonLength = readU32(payload, 5)
  if (9 + jsonLength > payload.length) return null
  let scene
  try {
    scene = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(9, 9 + jsonLength)))
  } catch {
    return null
  }
  return { contentCrc, scene, original: payload.subarray(9 + jsonLength) }
}

// ---- PNG ----

/** Chunks as { type, start (of the length field), dataStart, dataEnd, end }; null if malformed. */
function pngChunks(bytes) {
  if (!startsWith(bytes, 0, PNG_SIGNATURE)) return null
  const chunks = []
  let at = 8
  while (at + 12 <= bytes.length) {
    const length = readU32(bytes, at)
    const dataStart = at + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) return null
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    chunks.push({ type, start: at, dataStart, dataEnd, end: dataEnd + 4 })
    at = dataEnd + 4
    if (type === 'IEND') return chunks
  }
  return null
}

function pngPixelCrc(bytes, chunks) {
  let crc = 0
  for (const chunk of chunks) if (chunk.type === 'IDAT') crc = crc32(bytes, chunk.dataStart, chunk.dataEnd, crc)
  return crc
}

function readPngMarkup(bytes) {
  const chunks = pngChunks(bytes)
  const block = chunks?.find((chunk) => chunk.type === PNG_CHUNK)
  if (!block) return null
  const decoded = decodePayload(bytes.subarray(block.dataStart, block.dataEnd))
  if (!decoded || decoded.contentCrc !== pngPixelCrc(bytes, chunks)) return null
  return decoded
}

function writePngMarkup(flattened, original, scene) {
  const chunks = pngChunks(flattened)
  if (!chunks) throw new Error('the encoder returned an unreadable PNG')
  const payload = encodePayload(pngPixelCrc(flattened, chunks), scene, original)
  const kept = chunks.filter((chunk) => chunk.type !== PNG_CHUNK)
  const keptLength = kept.reduce((sum, chunk) => sum + chunk.end - chunk.start, 0)
  const out = new Uint8Array(8 + keptLength + 12 + payload.length)
  out.set(PNG_SIGNATURE, 0)
  let at = 8
  for (const chunk of kept) {
    if (chunk.type === 'IEND') {
      writeU32(out, at, payload.length)
      out.set(ascii(PNG_CHUNK), at + 4)
      out.set(payload, at + 8)
      writeU32(out, at + 8 + payload.length, crc32(out, at + 4, at + 8 + payload.length))
      at += 12 + payload.length
    }
    out.set(flattened.subarray(chunk.start, chunk.end), at)
    at += chunk.end - chunk.start
  }
  return out
}

// ---- JPEG ----

/** Marker segments before the scan as { marker, start, end }; null if malformed. */
function jpegSegments(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const segments = []
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    if (marker === 0xff) {
      at++ // fill byte
      continue
    }
    if (marker === 0xda || marker === 0xd9) return { segments, scanStart: at }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2
      continue
    }
    const end = at + 2 + readU16(bytes, at + 2)
    if (end > bytes.length) return null
    segments.push({ marker, start: at, end })
    at = end
  }
  return null
}

const JPEG_SIGNATURE_BYTES = ascii(JPEG_SIGNATURE)
const JPEG_HEADER = 4 + JPEG_SIGNATURE_BYTES.length + 4
// Why the length check: a short (malformed) segment must not read its signature from the next one.
const isOurSegment = (bytes, segment) =>
  segment.marker === JPEG_MARKER &&
  segment.end - segment.start >= JPEG_HEADER &&
  startsWith(bytes, segment.start + 4, JPEG_SIGNATURE_BYTES)

function readJpegMarkup(bytes) {
  const parsed = jpegSegments(bytes)
  if (!parsed) return null
  const ours = parsed.segments.filter((segment) => isOurSegment(bytes, segment))
  if (ours.length === 0) return null
  const dataOffset = JPEG_HEADER
  const count = readU16(bytes, ours[0].start + dataOffset - 2)
  if (ours.length !== count) return null
  let total = 0
  for (let i = 0; i < ours.length; i++) {
    if (readU16(bytes, ours[i].start + dataOffset - 4) !== i) return null
    total += ours[i].end - ours[i].start - dataOffset
  }
  const payload = new Uint8Array(total)
  let at = 0
  for (const segment of ours) {
    payload.set(bytes.subarray(segment.start + dataOffset, segment.end), at)
    at += segment.end - segment.start - dataOffset
  }
  const decoded = decodePayload(payload)
  if (!decoded) return null
  // The pixel CRC covers the encoder's file, which is this file minus our segments.
  let crc = 0
  let from = 0
  for (const segment of ours) {
    crc = crc32(bytes, from, segment.start, crc)
    from = segment.end
  }
  crc = crc32(bytes, from, bytes.length, crc)
  return decoded.contentCrc === crc ? decoded : null
}

function withoutOurSegments(bytes, segments) {
  const ours = segments.filter((segment) => isOurSegment(bytes, segment))
  if (ours.length === 0) return bytes
  const out = new Uint8Array(bytes.length - ours.reduce((sum, segment) => sum + segment.end - segment.start, 0))
  let at = 0
  let from = 0
  for (const segment of ours) {
    out.set(bytes.subarray(from, segment.start), at)
    at += segment.start - from
    from = segment.end
  }
  out.set(bytes.subarray(from), at)
  return out
}

function writeJpegMarkup(encoded, original, scene) {
  const existing = jpegSegments(encoded)
  if (!existing) throw new Error('the encoder returned an unreadable JPEG')
  const flattened = withoutOurSegments(encoded, existing.segments)
  const parsed = flattened === encoded ? existing : jpegSegments(flattened)
  const payload = encodePayload(crc32(flattened), scene, original)
  const count = Math.ceil(payload.length / JPEG_SEGMENT_DATA)
  if (count > 0xffff) throw new Error('markup is too large to store in a JPEG')
  // JFIF requires APP0 straight after SOI, so the block goes after it when present.
  const first = parsed.segments[0]
  const insertAt = first && first.marker === 0xe0 ? first.end : 2
  const header = JPEG_HEADER
  const out = new Uint8Array(flattened.length + count * header + payload.length)
  out.set(flattened.subarray(0, insertAt), 0)
  let at = insertAt
  for (let i = 0; i < count; i++) {
    const data = payload.subarray(i * JPEG_SEGMENT_DATA, (i + 1) * JPEG_SEGMENT_DATA)
    out[at] = 0xff
    out[at + 1] = JPEG_MARKER
    writeU16(out, at + 2, header - 2 + data.length)
    out.set(JPEG_SIGNATURE_BYTES, at + 4)
    writeU16(out, at + 4 + JPEG_SIGNATURE_BYTES.length, i)
    writeU16(out, at + 6 + JPEG_SIGNATURE_BYTES.length, count)
    out.set(data, at + header)
    at += header + data.length
  }
  out.set(flattened.subarray(insertAt), at)
  return out
}

// ---- public ----

/**
 * The markup a saved file carries, { scene, original } with `original` a view into `bytes`; else
 * null. The original must be the file's own format, as this plugin writes it.
 */
export function readMarkup(bytes, format = detectFormat(bytes)) {
  const markup = format === 'png' ? readPngMarkup(bytes) : format === 'jpeg' ? readJpegMarkup(bytes) : null
  return markup && detectFormat(markup.original) === format ? markup : null
}

const readU16LE = (b, i) => b[i] | (b[i + 1] << 8)
const readU24LE = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/**
 * [width, height] from the file header, without decoding; null when unknown (AVIF, or a header
 * this reader does not understand). Lets the editor refuse a decompression bomb before decoding.
 */
export function imageSize(bytes, format = detectFormat(bytes)) {
  if (format === 'png') return bytes.length >= 24 ? [readU32(bytes, 16), readU32(bytes, 20)] : null
  if (format === 'gif') return bytes.length >= 10 ? [readU16LE(bytes, 6), readU16LE(bytes, 8)] : null
  if (format === 'bmp') {
    if (bytes.length < 26) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return [Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true))]
  }
  if (format === 'webp' && bytes.length >= 30) {
    if (startsWith(bytes, 12, ascii('VP8X'))) return [1 + readU24LE(bytes, 24), 1 + readU24LE(bytes, 27)]
    if (startsWith(bytes, 12, ascii('VP8L'))) {
      const b = bytes.subarray(21, 25)
      return [1 + (b[0] | ((b[1] & 0x3f) << 8)), 1 + ((b[1] >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10))]
    }
    if (startsWith(bytes, 12, ascii('VP8 '))) return [readU16LE(bytes, 26) & 0x3fff, readU16LE(bytes, 28) & 0x3fff]
    return null
  }
  if (format === 'jpeg') {
    // SOF follows the segments before the scan; walk them the same way the container does.
    let at = 2
    while (at + 9 <= bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1]
      if (marker === 0xff) {
        at++
        continue
      }
      if (marker === 0xda || marker === 0xd9) return null
      if (SOF_MARKERS.has(marker)) return [readU16(bytes, at + 7), readU16(bytes, at + 5)]
      at += 2 + readU16(bytes, at + 2)
    }
  }
  return null
}

/** Wraps freshly encoded `flattened` bytes with the scene and the original file. */
export function writeMarkup(format, flattened, original, scene) {
  if (format === 'png') return writePngMarkup(flattened, original, scene)
  if (format === 'jpeg') return writeJpegMarkup(flattened, original, scene)
  throw new Error(`cannot save markup into ${format} files`)
}

/** Byte equality, comparing 4 bytes at a time when both views are aligned. */
export function sameBytes(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  let i = 0
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const words = a.length >>> 2
    const wa = new Uint32Array(a.buffer, a.byteOffset, words)
    const wb = new Uint32Array(b.buffer, b.byteOffset, words)
    for (; i < words; i++) if (wa[i] !== wb[i]) return false
    i = words << 2
  }
  for (; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
