// Adapted from Kazuki Hanai's DOCX preview in stablyai/orca#35061, commit
// ba58f712a5ca51073df93397b7520f8c3fa12bca (MIT; see THIRD_PARTY_NOTICES.txt).
// The plugin sandbox cannot create workers. Yield between bounded inflate chunks instead.
import { Inflate } from 'fflate'

export const ARCHIVE_LIMITS = {
  maxEntries: 2000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxMarkupPartBytes: 32 * 1024 * 1024
}

export class ArchiveRejectedError extends Error {
  constructor(reason) {
    super(reason === 'too-large'
      ? 'This document expands past the preview size limit.'
      : 'This document is damaged, encrypted, or uses an unsupported archive format.')
    this.reason = reason
  }
}

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const CHUNK_BYTES = 16 * 1024
const unsupported = () => { throw new ArchiveRejectedError('unsupported') }
const tooLarge = () => { throw new ArchiveRejectedError('too-large') }

/**
 * Inflate every entry at the same offsets jszip reads; do not trust size declarations alone.
 * Resolves with the inflated bytes of the entries named in `keep`.
 */
export async function inspectArchive(bytes, {
  limits = ARCHIVE_LIMITS,
  keep = [],
  cancelled = () => false,
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0))
} = {}) {
  const kept = new Map()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let lastYield = performance.now()
  const checkpoint = async () => {
    if (cancelled()) throw new DOMException('Superseded document', 'AbortError')
    if (performance.now() - lastYield >= 12) {
      await yieldControl()
      lastYield = performance.now()
      if (cancelled()) throw new DOMException('Superseded document', 'AbortError')
    }
  }
  const requireRange = (start, length) => {
    if (start < 0 || length < 0 || start + length > bytes.byteLength) unsupported()
  }
  let end = -1
  // Match jszip's last signature, including a forged signature in a comment. Never fall back
  // to an earlier archive that our parser checks while jszip reads a different one.
  for (let at = bytes.byteLength - 4; at >= 0; at--) {
    if (view.getUint32(at, true) === END) {
      end = at
      break
    }
  }
  if (end < 0 || end + 22 > bytes.byteLength || end + 22 + view.getUint16(end + 20, true) !== bytes.byteLength) unsupported()
  const records = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  const directoryOffset = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 ||
    records === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff ||
    directoryOffset + directorySize !== end) unsupported()

  let totalBytes = 0
  let entries = 0
  let cursor = directoryOffset
  while (cursor + 4 <= end && view.getUint32(cursor, true) === CENTRAL) {
    if (++entries > limits.maxEntries) tooLarge()
    requireRange(cursor, 46)
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const declaredSize = view.getUint32(cursor + 24, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + view.getUint16(cursor + 28, true)))
    if ((flags & 1) || (method !== 0 && method !== 8) || compressedSize === 0xffffffff ||
      declaredSize === 0xffffffff || localOffset === 0xffffffff) unsupported()
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true)
    if (cursor > end) unsupported()
    requireRange(localOffset, 30)
    if (view.getUint32(localOffset, true) !== LOCAL) unsupported()
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    requireRange(dataStart, compressedSize)
    if (declaredSize > limits.maxTotalBytes - totalBytes) tooLarge()
    const sniffer = new MarkupSniffer()
    const chunks = keep.includes(name) ? [] : null
    let size = 0
    const accept = (chunk) => {
      chunks?.push(chunk.slice())
      size += chunk.byteLength
      if (size > declaredSize) unsupported()
      if (sniffer.feed(chunk) && size > limits.maxMarkupPartBytes) tooLarge()
    }
    const data = bytes.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) {
      accept(data)
    } else {
      try {
        const inflate = new Inflate(accept)
        for (let offset = 0; offset < data.byteLength; offset += CHUNK_BYTES) {
          const next = Math.min(offset + CHUNK_BYTES, data.byteLength)
          inflate.push(data.subarray(offset, next), next === data.byteLength)
          await checkpoint()
        }
        if (data.byteLength === 0) inflate.push(data, true)
      } catch (error) {
        if (error instanceof ArchiveRejectedError || error?.name === 'AbortError') throw error
        unsupported()
      }
    }
    if (size !== declaredSize) unsupported()
    if (chunks) kept.set(name, concat(chunks, size))
    totalBytes += size
    await checkpoint()
  }
  if (entries === 0 || cursor !== end) unsupported()
  return kept
}

function concat(chunks, size) {
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

class MarkupSniffer {
  verdict = null
  seen = 0

  feed(chunk) {
    const bom = [0xef, 0xbb, 0xbf]
    for (let index = 0; this.verdict === null && index < chunk.byteLength; index++) {
      const byte = chunk[index]
      const isBom = this.seen < bom.length && byte === bom[this.seen]
      this.seen++
      if (!isBom && byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) this.verdict = byte === 0x3c
    }
    return this.verdict !== false
  }
}
