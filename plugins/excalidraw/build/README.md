# Building the Excalidraw editor

`../editor/` is generated, for both of Orca's editor frames:

- **Isolated frame** (desktop, with plugin frames isolated): `editor/index.html` is a page of its
  own at `orca-plugin-frame://<key>/editor/index.html`, in a session isolated per plugin. It may
  load the plugin's own files, compile WebAssembly and start workers, and its origin is stable, so
  `localStorage` persists. Every request outside the plugin's files is refused.
- **srcdoc frame** (isolation off, Orca served to a web browser, and Orca releases before isolated
  frames): `index.html` becomes one sandboxed document with an opaque origin, whose CSP allows only
  inline scripts and styles and `data:` fonts and images.

```sh
npm ci --ignore-scripts
node build.mjs   # also runs npm test
```

The build is deterministic: the same lockfile produces the same bytes. It also rewrites
`../THIRD_PARTY_NOTICES.txt` from the packages in either build, `subsetter-notices.txt` and
`font-notices.txt`.

Don't load `plugins/excalidraw` as an Orca development folder while `build/node_modules` exists:
Orca hashes every file of a plugin folder and refuses more than 2,000 (it has no ignore file).
Delete `build/node_modules` first, or load a copy without it. Catalog installs take only the files
in Git, so they are not affected.

## Layout

- `editor/index.html`: a small bootstrap script, and the single-file editor (about 5.5 MB) kept
  inert in `<script type="text/plain">`. In an isolated frame the bootstrap loads `assets/` and
  discards the inert copy. Anywhere else, or when `assets/` fails to load or start within 10 s, it
  runs the inert copy instead. If no editor has started 10 s after that, it shows a message.
- `editor/assets/`: the multi-file editor as ES module chunks (code-split), one per locale and
  lazily loaded feature (font subsetting with its worker and WebAssembly, image resizing, Mermaid),
  and its stylesheet.
- `editor/assets/fonts/`: Excalidraw's fonts. `src/frame-globals.js` points
  `EXCALIDRAW_ASSET_PATH` there. The single-file editor carries them as `data:` URLs.

No file may exceed 10 MiB, the most Orca reads of one plugin file.

Sources: `src/main.js` is the multi-file entry and `src/srcdoc/entry.js` the single-file one; both
run `src/editor.jsx`. `src/srcdoc/shims.js` adapts Excalidraw to the srcdoc frame, as version 1 did:
in-memory storage, `data:` fetches, and `data:` URLs instead of `blob:` images.

What the build changes in Excalidraw (`excalidraw-patches.mjs`), and why. Every patch fails the
build when its pattern is gone:

- `browser-fs-access` is replaced by `src/orca-file-access.js`: no frame can download or use the
  File System Access API, so files are saved through `orca.files.saveAs` and opened with a file
  input.
- The font subsetter's Emscripten glue builds three wrappers from source with `Function`, which
  the isolated frame's CSP refuses (it allows `'wasm-unsafe-eval'`, not `'unsafe-eval'`); each is
  rewritten as an equivalent closure. `test/subset-glue.test.mjs` runs the rewritten subsetter with
  string evaluation disabled and compares its output with the original's. The build fails if any
  output of either build still evaluates strings.
- Excalidraw's CDN fallback for fonts is removed: the CSP refuses it, logging a violation per font.
- pica and image-blob-reduce feature-test workers with a `data:` URL, which both CSPs refuse. The
  isolated build uses a `blob:` URL; the srcdoc build skips the test.
- Single-file only: other locales and font subsetting are stubbed out (the srcdoc CSP refuses
  WebAssembly), and pica resizes images in JavaScript.
- The CJK font Xiaolai (12 MB) and Liberation Sans (GPL) are left out; those fall back to system
  fonts.

## Talking to Orca

The editor uses the `window.orca` API Orca injects into the frame; Orca keeps the buffer, dirty
state and saving.

- `orca.document.onDidChange(doc)`: the file's text, on open and on every outside change. Changes
  not yet sent (or refused) are laid over an outside change and sent against it.
- `orca.document.applyEdit({ baseVersion, content: { kind: 'text', text } })`: the whole new
  text after a user change (debounced 250 ms, and at once when the frame is hidden or closed).
- `orca.on('editor.flush', …)`: about to save; the pending edit is sent and Orca waits for it. A
  refused edit fails the flush, so Orca does not save older text.
- `orca.files.saveAs({ suggestedName, mimeType, data })`: "Save to…" and image export (PNG, SVG).
  It needs the click's activation; when an export outlasts it, a "Save…" button asks for a new click.
- `orca.shell.openExternal(url)`: opens `http:`, `https:` and `mailto:` element links.

Orca offers `saveAs` and `openExternal` only to isolated frames (`orca.host.has`); elsewhere export
is hidden and links do nothing. The language follows `orca.locale` (Orca's UI locale), then
`navigator.language`; both, and the host methods, are read when Orca's `hello` sets the theme. The
canvas mounts then (at most 1 s), so a dark Orca never flashes a light canvas.

The library is kept in `localStorage`, shared by every drawing and kept in step across tabs; a
srcdoc frame has no lasting storage, so the library stays hidden there.

Orca's frames may refuse clipboard writes. Excalidraw then falls back to the copy event and
`execCommand`; if those fail too, `src/clipboard-fallback.js` keeps the copied shapes for pastes
inside the frame until it loses focus. "Copy as PNG/SVG" needs the clipboard and fails there.

## Compatibility

`engines.orca` stays at 1.4.245, the first release with custom editors: every Orca runs version 2,
in whichever frame it uses, and the isolated frame's features turn on when Orca isolates plugin
frames. `orca-catalog.json` keeps 1.1.0 listed beneath 2.0.0.
