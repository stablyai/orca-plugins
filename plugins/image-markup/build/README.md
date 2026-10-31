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
frame, CSP, theme tokens and document API, including `applyEdit` version checks and
`editor.flush`, served from a secure origin as in Orca.

| File | Purpose |
| --- | --- |
| `src/editor.js`, `src/editor.css` | Frame wiring, tools, rendering, history, saving, Copy |
| `src/scene.js` | Shape model: bounds, hit tests, moves, handles, simplifying, (de)serialising |
| `src/render.js` | Drawing shapes, text metrics, the full-resolution flattened render |
| `src/png.js` | PNG encoder: RGB when opaque, per-row adaptive filters, native deflate |
| `src/container.js` | Markup stored in PNG `orCA` chunks and JPEG APP9 segments, with a pixel CRC |
| `src/view.js` | Fit, zoom and coordinate mapping |
| `test/*.test.mjs` | Container and scene unit tests; editor tests in the Orca-like frame |

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

## Clipboard

Orca's editor iframe has no `allow="clipboard-write"`, so the async Clipboard API is blocked by
permissions policy, and the plugin host API has no clipboard method (Orca's own browser markup
copies through `window.api.ui.writeClipboardImage`, which frames cannot reach). Copy checks the
policy up front: when it is blocked, the button explains that ⌘S saves the markup instead. There
is deliberately no HTML or data-URL fallback; agents and terminals cannot paste it, and large
images made multi-megabyte clipboard entries. When the policy allows it, Copy writes `image/png`.
