export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

/** The session's decode: a byte document as `{ bytes }`, or `{ error }` for anything else. */
export function decodeDocument(content) {
  if (content?.kind !== 'bytes' || !(content.bytes instanceof ArrayBuffer)) return { error: 'unsupported' }
  if (content.bytes.byteLength > MAX_DOCUMENT_BYTES) return { error: 'too-large' }
  return { bytes: new Uint8Array(content.bytes) }
}

/** The viewer never edits, so encode only returns the bytes it was given. */
export function encodeDocument(value) {
  const bytes = value.bytes ?? new Uint8Array()
  return { kind: 'bytes', bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
}

/** Orca's document session for this viewer: it receives documents and never sends one. */
export function openDocumentSession() {
  return globalThis.orca.document.session({ decode: decodeDocument, encode: encodeDocument })
}
