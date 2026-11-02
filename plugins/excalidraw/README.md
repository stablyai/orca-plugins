# Excalidraw

Draw and edit `.excalidraw` diagrams in Orca's editor, with Excalidraw 0.18. Orca keeps the file:
its buffer, dirty state, saving, and outside changes such as an agent writing the file. The editor
follows Orca's light or dark theme and language, keeps its shape library across drawings, and
saves image exports (PNG, SVG) through Orca's save dialog. Requires Orca 1.4.248 or later in the
desktop app; elsewhere Orca opens the file in Source.

## What is in this folder

- `orca-plugin.json`: what Orca loads. The editor runs only in Orca's isolated editor frame
  (`"frame": "isolated"`).
- `editor/`: the built editor that Orca loads, `index.html` plus ES module chunks, a stylesheet and
  fonts in `assets/`. Generated and committed: never edit it by hand.
- `build/`: the source of `editor/`, the build recipe and the tests. `build/src/scene-sync.js` is
  the document sync: Orca's `orca.document.session()` with a three-way merge by element id, so an
  outside change and this canvas's unsent change both survive. Build steps, the patches it makes to
  Excalidraw and how the editor talks to Orca are in [build/README.md](build/README.md).
- `templates/`: the blank drawing behind "New Excalidraw drawing".

## Changelog

### 2.1.0

- Document sync uses Orca's document session (about 200 lines of hand-written sync gone): Orca
  flushes the editor before a save, and a refused edit keeps the drawing dirty instead of looking
  saved.
- An outside change merges with this canvas's by element id: a background or grid change is no
  longer dropped, and two different edits that reach the same element version are no longer taken
  as the same.
- One build: the editor runs only in Orca's isolated frame. The 5.5 MB single-file fallback for
  other frames, its loader and its start-up watchdog are gone. Needs Orca 1.4.248.

### 2.0.1 and earlier

Excalidraw in Orca's isolated and srcdoc frames, with Orca's save dialog for exports.

## Credits and licence

The first Excalidraw editor for Orca came from stablyai/orca#27413 by Roughriver74. MIT; the
bundled software and fonts are listed in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
