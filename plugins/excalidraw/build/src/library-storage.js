// The Excalidraw library, kept in localStorage: an isolated frame's origin is stable per plugin, so
// every drawing (and every open tab) shares it.

const KEY = 'orca-excalidraw-library'

/** Whether localStorage outlives this frame; a srcdoc frame only has an in-memory stand-in. */
export const libraryPersists = window.origin !== 'null'

/** The stored library, or null when there is none or it cannot be read. */
export function readLibrary() {
  const saved = localStorage.getItem(KEY)
  if (!saved) {
    return null
  }
  try {
    const data = JSON.parse(saved)
    if (Array.isArray(data?.libraryItems)) {
      return data
    }
  } catch {
    // Fall through: keep the unreadable copy aside so the next save does not destroy it.
  }
  console.error('The saved Excalidraw library is unreadable; it was moved aside')
  try {
    localStorage.setItem(`${KEY}-unreadable`, saved)
    localStorage.removeItem(KEY)
  } catch {}
  return null
}

export const libraryAdapter = {
  load: readLibrary,
  save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data))
    } catch (error) {
      // Why: Excalidraw shows this message; the default one says nothing about the cause.
      throw new Error(
        error?.name === 'QuotaExceededError'
          ? 'The library is too large to keep. Remove some items, especially images.'
          : `The library could not be kept: ${error?.message ?? error}`
      )
    }
  }
}

/** Calls `onChange` with the library another tab of this plugin saved. */
export function onLibraryStored(onChange) {
  const listener = (event) => {
    if (event.storageArea === localStorage && event.key === KEY) {
      onChange(readLibrary()?.libraryItems ?? [])
    }
  }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}
