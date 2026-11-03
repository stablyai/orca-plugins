# Building Image Markup

`../editor/index.html` is generated from the source here. Orca loads it in an opaque-origin
`sandbox="allow-scripts"` frame whose CSP allows inline scripts and styles and data-URL images
only; network, workers, `blob:` images, downloads and storage are all unavailable. The build
bundles everything into that one file and refuses to bundle any npm package.

```sh
npm ci --ignore-scripts
npm run build
npm test
```

Browser tests use the Chromium headless shell expected by `playwright-core`; install it with
`npx playwright-core install chromium-headless-shell` if needed. The harness reproduces Orca's
frame, CSP, theme tokens and envelope, and runs Orca's real `orca.document` (with `session()`),
copied into `test/orca-frame/document-script.mjs` from Orca's
`src/shared/plugins/frames/plugin-panel-shell-document.ts`. Its host answers edits the way Orca
does (a stale `baseVersion` is a conflict), sends disk changes with their `ancestor`, asks the
frame to flush, and answers `files.saveAs`. `test/document-sync.test.mjs` runs the sync module
against `mockEditorHost` from `orca/testing`, vendored in `test/orca-testing/` (copy
`orca-testing.mjs` and `orca-runtime.mjs` from Orca's `resources/plugins/declarative/` to
update it).

| File | Purpose |
| --- | --- |
| `src/editor.js`, `src/editor.css` | Frame wiring, tools, rendering, history, encoding, Copy and Export |
| `src/document-sync.js` | Orca's document session: how a file decodes, encodes and merges with an outside write |
| `src/scene.js` | Shape model: bounds, hit tests, moves, handles, simplifying, (de)serialising |
| `src/render.js` | Drawing shapes, text metrics, redaction fills, the full-resolution flattened render |
| `src/png.js` | PNG encoder: RGB when opaque, per-row adaptive filters, native deflate |
| `src/container.js` | Markup stored in PNG `orCA` chunks and JPEG APP9 segments, with a pixel CRC |
| `src/view.js` | Fit, zoom and coordinate mapping |
| `test/*.test.mjs` | Container, scene and document-sync tests; editor tests in the Orca-like frame |

## Performance

- Images decode with `createImageBitmap` (off the main thread; the CSP forbids `blob:` images).
- The `base` canvas copies from a layer holding the image and committed shapes, drawn once per
  zoom level: a pan is one copy, a new shape is drawn onto the layer alone, and a zoom stretches
  the layer until the gesture settles, then redraws it sharp. Zoomed in past 16 megapixels of
  layer, the image and only the on-screen shapes draw directly.
- The `overlay` canvas holds only the shape being drawn or dragged and the selection. Pen input
  reads coalesced pointer events; strokes are simplified (Ramer–Douglas–Peucker) when they end.
- Paths, text metrics and bounds are cached per immutable shape. Repaints are coalesced to one
  per animation frame.
- Far zoomed out, large images draw from downscaled copies made in the background.
- Edits to Orca are debounced. PNGs are encoded by `src/png.js` rather than the canvas encoder,
  which always writes RGBA with light compression (a 5712×3213 screenshot came out at 31 MB).
  Filtering runs in short slices scheduled in idle time, so it never lands inside a busy frame;
  `CompressionStream` does the deflating. JPEGs use `OffscreenCanvas.convertToBlob`.

The editor test suite drives a 24-megapixel image carrying 2,000 strokes and checks that
drawing, panning and zooming hold 60 fps in headless software rendering.

## Talking to Orca

- `orca.document.session({ decode, encode, merge })` (`src/document-sync.js`) does the document
  sync: Orca keeps the buffer, the unsaved state and the save. A value is the whole file plus its
  original and shapes. Encoding a scene is asynchronous (a full-resolution render and PNG
  encode), so the editor encodes first and calls `change` with the finished file; `encode` only
  hands it over. The editor also answers `editor.flush` itself: Orca waits for every handler, so a
  save straight after a stroke waits for that stroke's encode, then for the session's flush.
- `merge(base, outside, mine)` keeps the outside file's image and shapes, adds the shapes this
  editor drew since `base` and drops the ones it deleted (shapes match by their saved form). It
  can't encode, so a merge that changed anything is marked `stale` and carries the outside file;
  the editor loads it, encodes it and sends it as its next change. Strokes not yet handed to the
  session merge the same way when an outside change arrives.
- Redactions, and every shape drawn before the last one, are rendered into the original before
  it is stored and left out of the stored scene, so nothing they cover survives as pixels or as
  text. With nothing else to keep, the file is just the flattened image.
- Orca flushes editors before a save, but not before closing, reloading or switching a tab's
  view, and an encode can take seconds. So the first edit after each handover sends a stand-in at
  once and the tab is unsaved. The stand-in is the last file with the latest shapes written into
  its markup (scene marked `redraw`), so if it is saved anyway it reopens with every shape; the
  next edit encodes it again, or opening does at once when it holds a redaction. With a
  redaction it adds nothing the last file lacks: that file's own original, and no shape a later
  redaction covers. Only past the size cap is it the last file with a note (a private
  `orCp` PNG chunk, or an APP9 `ORCA-PENDING` segment the JPEG pixel CRC skips), which decoding
  strips. A real file always follows: the encode, or the last one again after an undo back to it.
- `orca.files.saveAs` (desktop only, needs the click's activation) is Export. The render is kept,
  so when a large image outlasts the click, the second click saves at once.

## Clipboard

Orca's frames refuse the async Clipboard API (desktop isolated frames deny the permission;
browser-client iframes have no `allow="clipboard-write"`), and the frame API has no clipboard
method. `execCommand('copy')` in a click works, but carries text only. Copy checks the policy up
front: when it is blocked, `⌘C` explains that `⌘S` and Export keep the markup instead, and the
toolbar shows Export in its place where Orca offers it. There is deliberately no HTML or data-URL
fallback; agents and terminals cannot paste it, and large images made multi-megabyte clipboard
entries. When the policy allows it, Copy writes `image/png`.
