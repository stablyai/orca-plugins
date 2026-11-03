// The database file through Orca's `orca.document.session()`. The editor only reads: it never calls
// `change`, so Orca never saves this tab, and `onReplace` brings each outside write (an app or an
// agent changing the database).

/** A document's content as `{ bytes }` (an ArrayBuffer), or `{ error }` when Orca sent text. */
export function decodeDatabase(content) {
  if (content?.kind === 'bytes' && content.bytes instanceof ArrayBuffer) {
    return { bytes: content.bytes }
  }
  return { error: 'Orca sent this file as text, but SQLite Browser reads database files as raw bytes.' }
}

export function openDatabaseSession() {
  return globalThis.orca.document.session({
    decode: decodeDatabase,
    // Never called while the editor makes no edits; here so the session takes a bytes document.
    encode: (value) => ({ kind: 'bytes', bytes: value.bytes })
  })
}
