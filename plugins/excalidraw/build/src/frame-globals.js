// Runs before Excalidraw loads, in Orca's isolated editor frame (orca-plugin-frame://).

// Why: serializeAsJSON writes this as `source` when the file had none, instead of the frame's origin.
window.EXCALIDRAW_EXPORT_SOURCE = 'https://excalidraw.com'
// Why: Excalidraw resolves its fonts against this (assets/fonts); the build removes its CDN fallback.
window.EXCALIDRAW_ASSET_PATH = new URL('./', import.meta.url).href
