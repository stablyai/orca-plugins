# Building Word Document Viewer

`../editor/index.html` is generated from the source here. It is one self-contained file so the
same build runs in the desktop app's isolated frame and in a browser client's opaque-origin srcdoc
frame, which allows only inline scripts/styles and data-URL images/fonts; network, workers, and
eval are blocked in both. There are no runtime downloads.

```sh
npm ci --ignore-scripts
npm run build
npm test
```

Browser tests use the Chromium headless shell expected by `playwright-core`; install it with
`npx playwright-core install chromium-headless-shell` if needed. The harness reproduces both of
Orca's frames: the opaque-origin `sandbox="allow-scripts"` srcdoc frame, and the desktop app's
isolated frame on its own origin with storage and `orca.shell`, each with its CSP, theme tokens and
document session. Tests cover page rendering, header/footer/table content, zoom/fit, bookmarks,
link opening and its copy fallback, find, tracked changes and comments, saved views, outside
rewrites, invalid files, encrypted/ZIP64 archives, size lies and bombs.

`test/document-session.test.mjs` and `test/view-memory.test.mjs` need no dependencies and also run
under `orca plugin test`; the session test drives Orca's real frame session through
`mockEditorHost`, vendored in `test/orca-testing/` (copy `orca-testing.mjs` and `orca-runtime.mjs`
from Orca's `resources/plugins/declarative/`, or from `orca plugin types`, to update it).

The build is deterministic. It refuses eval, `new Function`, and unescaped closing script/style
tags. It generates third-party notices from bundled packages and compares their licence text
against reviewed copies in `licenses/` before succeeding. Only bundled-package licences are kept.

## Dependencies and CSP

`docx-preview` is pinned to 0.4.1; npm's lockfile pins JSZip and every transitive dependency.
`fflate` is pinned to 0.8.3 (the fixed version for GHSA-px8p-9vwx-vf98; the affected `unzipSync`
API is not used here). `npm audit` should remain clean after updates.

JSZip's prebundled browser distribution contains a legacy `new Function` string-callback
fallback. The build uses JSZip's original entry instead, replacing only that scheduler with a
small `MessageChannel` function-only shim. A second shim declares Node streams unavailable,
since this viewer accepts only ArrayBuffers. No package files are patched.

## Rendering boundary

The renderer settings and archive inspector originate in
[stablyai/orca#35061](https://github.com/stablyai/orca/pull/35061) at
`ba58f712a5ca51073df93397b7520f8c3fa12bca`; see `UPSTREAM_NOTICE.txt` for authorship and the MIT
notice included in the generated notices.

The plugin API already reads binary documents locally and remotely, so no native IPC, host
changes or broad capabilities are needed. The viewer opens `orca.document.session()` and only
reads from it (`value` and `onReplace`); it never calls `change`, so it sends no edits. Web and
email links go to `orca.shell.openExternal` from the click or key press that activated them; Orca
asks before opening a new site. Without `orca.shell` (browser clients) the address is shown to
copy. Saved views use the frame's `localStorage`, which only the desktop app's isolated frame has;
the opaque-origin frame silently skips them.

Unlike the native PR, the sandbox cannot create workers or access a script-free nested frame
with `allow-same-origin`. The archive guard instead yields between bounded inflate chunks and
cancels superseded versions. Rendering keeps all document CSS in a shadow root. Only parsed
`@font-face` rules are promoted into a separate outer stylesheet because Chromium ignores font
faces defined inside shadow roots. Active elements and event handlers are removed, HTTP(S) and
mailto links lose their `href` and are opened by the viewer, and bookmark links are handled within
the preview. The host CSP remains the network and script-policy boundary.

Find and comment shading use CSS custom highlights over ranges, so they never change the
document's DOM. Find matches within a paragraph, across runs. Markup re-renders the document with
tracked changes and comments on or off; the renderer's own options do the drawing.

| File | Purpose |
| --- | --- |
| `src/editor.js`, `src/editor.css` | Document session, reloads, scrolling, zoom, find bar, links, controls |
| `src/render-document.js` | Renderer options, markup, document/style isolation, fonts and link sanitization |
| `src/find.js` | Text matching across runs and the find highlights |
| `src/view-memory.js` | Per-document zoom and markup in `localStorage`, keyed by Word's document id |
| `src/archive-budget.js` | Entry/byte limits with actual bounded inflation before rendering |
| `src/document-session.js` | The session's byte decoding and the input size cap |
| `src/set-immediate.js`, `src/no-node-stream.js` | CSP-compatible browser shims for JSZip |
| `test/harness.mjs`, `test/fixture.mjs` | Orca-like sandbox and synthetic Word documents |
