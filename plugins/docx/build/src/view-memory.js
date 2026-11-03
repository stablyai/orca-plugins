// Per-document view settings (zoom, markup) kept in the frame's localStorage. The frame never learns a
// path, so a document is known by the id Word keeps in settings.xml across saves, else its bytes.

export const SETTINGS_PART = 'word/settings.xml'
const KEY = 'orca-docx-views'
const MAX_DOCUMENTS = 200

/** Word's per-document GUID (w15:docId, else w14:docId), or null. */
export function wordDocumentId(settingsXml) {
  if (!settingsXml) return null
  const text = new TextDecoder().decode(settingsXml)
  for (const tag of ['w15:docId', 'w14:docId']) {
    const match = new RegExp(`<${tag}\\b[^>]*\\bw1[45]:val="\\{?([0-9A-Fa-f-]{32,36})\\}?"`).exec(text)
    if (match) return `id:${match[1].toLowerCase()}`
  }
  return null
}

/** A key for this document: Word's id when it has one, else a digest of its bytes. */
export async function documentKey(bytes, settingsXml) {
  const id = wordDocumentId(settingsXml)
  if (id) return id
  if (!globalThis.crypto?.subtle) return null
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `sha256:${Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

// Why try/catch: a browser client's opaque-origin frame has no storage and throws on access.
function frameStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readAll(storage) {
  try {
    const data = JSON.parse(storage.getItem(KEY) ?? '{}')
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

/** The saved view of `key`: `{ zoom?: { fit: true } | { fit: false, scale }, markup?: boolean }`. */
export function readView(key, storage = frameStorage()) {
  if (!key || !storage) return {}
  const saved = Object(readAll(storage)[key])
  const view = {}
  if (saved.zoom?.fit === true) view.zoom = { fit: true }
  else if (saved.zoom?.fit === false && Number.isFinite(saved.zoom.scale) && saved.zoom.scale > 0) view.zoom = { fit: false, scale: saved.zoom.scale }
  if (typeof saved.markup === 'boolean') view.markup = saved.markup
  return view
}

/** Saves `changes` to the view of `key`, keeping only the most recently viewed documents. */
export function saveView(key, changes, storage = frameStorage()) {
  if (!key || !storage) return
  const all = readAll(storage)
  const view = { ...(typeof all[key] === 'object' ? all[key] : {}), ...changes }
  if (view.zoom) view.zoom = view.zoom.fit ? { fit: true } : { fit: false, scale: Math.round(view.zoom.scale * 1000) / 1000 }
  delete all[key]
  all[key] = view
  const keys = Object.keys(all)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_DOCUMENTS))) delete all[old]
  try {
    storage.setItem(KEY, JSON.stringify(all))
  } catch {}
}
