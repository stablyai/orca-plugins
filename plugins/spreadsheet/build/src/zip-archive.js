// Reads and rewrites the zip a workbook lives in. Reading inflates every entry up front, counting the
// bytes that really come out (declared sizes can lie), so only the inflated total caps a zip bomb.
// Writing copies each untouched entry's compressed bytes as they were and deflates only new parts.
import { deflateSync, inflateSync } from 'fflate'
import { OFFICE_ZIP_MAX_ENTRIES, OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES } from './zip-budget.js'

const LOCAL_HEADER = 0x04034b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const END_RECORD_BYTES = 22
const CENTRAL_ENTRY_BYTES = 46
const LOCAL_HEADER_BYTES = 30
const ZIP64_MARKER = 0xffffffff
const STORED = 0
const DEFLATED = 8
// Bit 3: sizes follow the data; bit 11: the name is UTF-8. Only bit 11 survives a rewrite.
const UTF8_FLAG = 0x800

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function findEnd(view) {
  const last = view.byteLength - END_RECORD_BYTES
  for (let offset = last; offset >= Math.max(0, last - 0xffff); offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset
  }
  return -1
}

/**
 * @typedef {{ name: string, data: Uint8Array, method: number, crc: number, raw: Uint8Array | null,
 *   time: number, date: number, flags: number }} ZipEntry
 * @returns {{ status: 'ok', entries: ZipEntry[] } | { status: 'too-large' | 'corrupt' }}
 */
export function readZip(bytes, maxBytes = OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = findEnd(view)
  if (end < 0) return { status: 'corrupt' }
  const count = view.getUint16(end + 10, true)
  if (count > OFFICE_ZIP_MAX_ENTRIES) return { status: 'too-large' }
  let offset = view.getUint32(end + 16, true)
  const decoder = new TextDecoder()
  const entries = []
  let total = 0
  for (let index = 0; index < count; index++) {
    if (offset + CENTRAL_ENTRY_BYTES > view.byteLength) return { status: 'corrupt' }
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY) return { status: 'corrupt' }
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const time = view.getUint16(offset + 12, true)
    const date = view.getUint16(offset + 14, true)
    const crc = view.getUint32(offset + 16, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const declaredSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    // Workbooks this size never need ZIP64; its sizes live where this walk does not check them.
    if (compressedSize === ZIP64_MARKER || declaredSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      return { status: 'too-large' }
    }
    const nameStart = offset + CENTRAL_ENTRY_BYTES
    if (nameStart + nameLength > view.byteLength) return { status: 'corrupt' }
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    offset = nameStart + nameLength + extraLength + commentLength
    if (localOffset + LOCAL_HEADER_BYTES > view.byteLength) return { status: 'corrupt' }
    if (view.getUint32(localOffset, true) !== LOCAL_HEADER) return { status: 'corrupt' }
    const dataStart =
      localOffset + LOCAL_HEADER_BYTES + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    if (dataStart + compressedSize > view.byteLength) return { status: 'corrupt' }
    const raw = bytes.subarray(dataStart, dataStart + compressedSize)
    if (total + declaredSize > maxBytes) return { status: 'too-large' }
    let data
    if (method === STORED) {
      data = raw
    } else if (method === DEFLATED) {
      // Why one byte over: fflate stops at the end of `out`, so a full buffer means the size lied.
      try {
        data = inflateSync(raw, { out: new Uint8Array(declaredSize + 1) })
      } catch {
        return { status: 'corrupt' }
      }
    } else {
      return { status: 'corrupt' }
    }
    if (data.byteLength !== declaredSize) return { status: 'corrupt' }
    total += data.byteLength
    if (!name.endsWith('/')) entries.push({ name, data, method, crc, raw, time, date, flags: flags & UTF8_FLAG })
  }
  return { status: 'ok', entries }
}

/**
 * A zip of `entries` in order. An entry whose `raw` compressed bytes are still set is copied as it
 * was; any other is deflated (or stored when `method` is 0, as ODF's `mimetype` must be).
 */
export function writeZip(entries) {
  const encoder = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    let { raw, method, crc } = entry
    if (!raw) {
      crc = crc32(entry.data)
      method = method === STORED ? STORED : DEFLATED
      // Level 1: a large sheet deflates several times faster, for a file a little larger.
      raw = method === STORED ? entry.data : deflateSync(entry.data, { level: 1 })
    }
    const flags = UTF8_FLAG
    const local = new DataView(new ArrayBuffer(LOCAL_HEADER_BYTES))
    local.setUint32(0, LOCAL_HEADER, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, flags, true)
    local.setUint16(8, method, true)
    local.setUint16(10, entry.time ?? 0, true)
    local.setUint16(12, entry.date ?? 0x21, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, raw.byteLength, true)
    local.setUint32(22, entry.data.byteLength, true)
    local.setUint16(26, nameBytes.byteLength, true)
    const record = new DataView(new ArrayBuffer(CENTRAL_ENTRY_BYTES))
    record.setUint32(0, CENTRAL_DIRECTORY_ENTRY, true)
    record.setUint16(4, 20, true)
    record.setUint16(6, 20, true)
    record.setUint16(8, flags, true)
    record.setUint16(10, method, true)
    record.setUint16(12, entry.time ?? 0, true)
    record.setUint16(14, entry.date ?? 0x21, true)
    record.setUint32(16, crc, true)
    record.setUint32(20, raw.byteLength, true)
    record.setUint32(24, entry.data.byteLength, true)
    record.setUint16(28, nameBytes.byteLength, true)
    record.setUint32(42, offset, true)
    parts.push(new Uint8Array(local.buffer), nameBytes, raw)
    central.push(new Uint8Array(record.buffer), nameBytes)
    offset += LOCAL_HEADER_BYTES + nameBytes.byteLength + raw.byteLength
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0)
  const end = new DataView(new ArrayBuffer(END_RECORD_BYTES))
  end.setUint32(0, END_OF_CENTRAL_DIRECTORY, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  return concat([...parts, ...central, new Uint8Array(end.buffer)])
}

/** A stored (uncompressed) zip of the entries, which SheetJS reads without inflating again. */
export function storedZip(entries) {
  return writeZip(entries.map((entry) => ({ name: entry.name, data: entry.data, method: STORED, raw: null })))
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}
