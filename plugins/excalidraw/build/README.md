# Building the Excalidraw editor

`../editor/` is generated: the editor for Orca's isolated editor frame, a page of its own at
`orca-plugin-frame://<key>/editor/index.html` in a session isolated per plugin. It may load the
plugin's own files, compile WebAssembly and start workers, and its origin is stable, so
`localStorage` persists. Every request outside the plugin's files is refused. The manifest's
`"frame": "isolated"` keeps it there: browser clients, and desktop with isolated frames switched
off, open the file in Source instead.

```sh
npm ci --ignore-scripts
node build.mjs   # also runs npm test
```

The build is deterministic: the same lockfile produces the same bytes. It also rewrites
`../THIRD_PARTY_NOTICES.txt` from the packages in the build, `subsetter-notices.txt` and
`font-notices.txt`.

Don't load `plugins/excalidraw` as an Orca development folder while `build/node_modules` exists:
Orca hashes every file of a plugin folder and refuses more than 2,000. Delete `build/node_modules`
first, or load a copy without it. Catalog installs take only the files in Git, so they are not
affected.

## Layout

- `editor/index.html`: the page. It loads the stylesheet and the entry module from `assets/`.
- `editor/assets/`: the editor as ES module chunks (code-split), one per locale and lazily loaded
  feature (font subsetting with its worker and WebAssembly, image resizing, Mermaid), and its
  stylesheet.
- `editor/assets/fonts/`: Excalidraw's fonts. `src/frame-globals.js` points
  `EXCALIDRAW_ASSET_PATH` there.

No file may exceed 10 MiB, the most Orca reads of one plugin file.

Sources: `src/main.js` is the entry and runs `src/editor.jsx`, the React app. `src/scene-sync.js`
is the document sync (below); it has no Excalidraw import, so its tests run in Node.

What the build changes in Excalidraw (`excalidraw-patches.mjs`), and why. Every patch fails the
build when its pattern is gone:

- `browser-fs-access` is replaced by `src/orca-file-access.js`: the frame cannot download or use
  the File System Access API, so files are saved through `orca.files.saveAs` and opened with a file
  input.
- The font subsetter's Emscripten glue builds three wrappers from source with `Function`, which
  the frame's CSP refuses (it allows `'wasm-unsafe-eval'`, not `'unsafe-eval'`); each is rewritten
  as an equivalent closure. `test/subset-glue.test.mjs` runs the rewritten subsetter with string
  evaluation disabled and compares its output with the original's. The build fails if any output
  still evaluates strings.
- Excalidraw's CDN fallback for fonts is removed: the CSP refuses it, logging a violation per font.
- pica and image-blob-reduce feature-test workers with a `data:` URL, which the CSP refuses; the
  build uses a `blob:` URL.
- The CJK font Xiaolai (12 MB) and Liberation Sans (GPL) are left out; those fall back to system
  fonts.

## Talking to Orca

The editor uses the `window.orca` API Orca injects into the frame; Orca keeps the buffer, dirty
state and saving.

- `orca.document.session({ decode, encode, merge })` (`src/scene-sync.js`) does the document sync.
  It resolves once Orca's hello brought the theme, locale and host methods and the first document
  is in, so the canvas mounts then and a dark Orca never shows a light canvas. The editor calls
  `change(scene)` when the saved part of the scene changes (elements, background and grid; not
  selection, scroll or zoom), and loads `onReplace` scenes: outside changes, and merges after a
  conflict. The session debounces edits (250 ms), keeps one in flight, answers Orca's flush before
  a save, and keeps a refused edit dirty.
- `merge(base, outside, mine)` is three-way by element id: an element this canvas changed since
  `base` (by `version` and `versionNonce`) keeps its change, everything else comes from `outside`,
  and the canvas settings merge field by field.
- The file's own `source` is kept, so saving from Orca does not rewrite it. Excalidraw normalizes a
  scene as it loads; the first change it reports after a load only sets the baseline, so opening a
  file never dirties it.
- `orca.files.saveAs({ suggestedName, mimeType, data })`: "Save to…" and image export (PNG, SVG).
  It needs the click's activation; when an export outlasts it, a "Save…" button asks for a new
  click. It resolves `{ status: 'saved' | 'cancelled' }`.
- `orca.shell.openExternal(url)`: opens `http:`, `https:` and `mailto:` element links.

The language follows `orca.locale` (Orca's UI locale), then `navigator.language`. The library is
kept in `localStorage`, shared by every drawing and kept in step across tabs.

Orca's frames may refuse clipboard writes. Excalidraw then falls back to the copy event and
`execCommand`; if those fail too, `src/clipboard-fallback.js` keeps the copied shapes for pastes
inside the frame until it loses focus. "Copy as PNG/SVG" needs the clipboard and fails there.

## Tests

`npm test` runs `test/*.test.mjs` with Node's test runner. `test/scene-sync.test.mjs` drives the
document sync against Orca's real frame session through `mockEditorHost` from `orca/testing`,
vendored in `test/orca-testing/` (copy `orca-testing.mjs` and `orca-runtime.mjs` from Orca's
`resources/plugins/declarative/`, or from `orca plugin types`, to update it).

## Compatibility

`engines.orca` is 1.4.248, the first release with the document session and `"frame": "isolated"`.
`orca-catalog.json` keeps 2.0.1 listed beneath 2.1.0, so older Orca still installs the version
that runs in either frame.
