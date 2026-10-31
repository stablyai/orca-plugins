// Runs before Excalidraw loads, in a srcdoc frame: an opaque origin, where Web Storage throws, and
// a CSP that allows only inline code and data: fonts and images, so Excalidraw must never fetch.

function memoryStorage() {
  const items = new Map()
  return {
    get length() {
      return items.size
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
    setItem: (key, value) => void items.set(String(key), String(value)),
    removeItem: (key) => void items.delete(String(key)),
    clear: () => items.clear()
  }
}

for (const name of ['localStorage', 'sessionStorage']) {
  try {
    void window[name].length
  } catch {
    Object.defineProperty(window, name, { value: memoryStorage(), configurable: true })
  }
}

// Why: serializeAsJSON writes this as `source` when the file had none; the frame's own origin is "null".
window.EXCALIDRAW_EXPORT_SOURCE = 'https://excalidraw.com'

// Why: CSP `connect-src 'none'` refuses even data: fetches, and Excalidraw fetches its embedded fonts
// when it inlines them into an export. Decode those here; every other request still goes to fetch.
const nativeFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
  const match = typeof url === 'string' ? /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url) : null
  if (!match) {
    return nativeFetch(input, init)
  }
  const [, type, base64, payload] = match
  const bytes = base64
    ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload))
  return Promise.resolve(new Response(bytes, { headers: { 'Content-Type': type || 'text/plain' } }))
}

// Why: CSP `img-src data:` refuses blob: images, and Excalidraw decodes inserted images from blob
// URLs. Keep each blob behind its URL and hand <img> a data: URL of the same bytes instead.
const blobs = new Map()
const createObjectURL = URL.createObjectURL.bind(URL)
const revokeObjectURL = URL.revokeObjectURL.bind(URL)
URL.createObjectURL = (object) => {
  const url = createObjectURL(object)
  if (object instanceof Blob) blobs.set(url, object)
  return url
}
URL.revokeObjectURL = (url) => {
  blobs.delete(url)
  revokeObjectURL(url)
}
const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
Object.defineProperty(HTMLImageElement.prototype, 'src', {
  ...imageSrc,
  set(value) {
    const blob = typeof value === 'string' ? blobs.get(value) : undefined
    if (!blob) {
      imageSrc.set.call(this, value)
      return
    }
    const reader = new FileReader()
    reader.onload = () => imageSrc.set.call(this, reader.result)
    reader.onerror = () => imageSrc.set.call(this, value)
    reader.readAsDataURL(blob)
  }
})
