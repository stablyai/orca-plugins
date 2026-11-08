# Excalidraw

Draw and edit `.excalidraw` diagrams in Orca's editor, with Excalidraw 0.18, and
`.excalidraw.svg` and `.excalidraw.png` images that carry their drawing. Orca keeps the file: its
buffer, dirty state, saving, and outside changes such as an agent writing the file. The editor
follows Orca's light or dark theme and language, keeps its shape library across drawings, and
saves image exports (PNG, SVG) through Orca's save dialog. Requires Orca 1.4.248 or later in the
desktop app; elsewhere Orca opens the file in Source.

## Saving, and drawing with an agent

Edits go to Orca's buffer for the file, as typing in any other file does: the tab shows them as
unsaved, and the file on disk stays the same until the drawing is saved. An agent reading the file,
or `orca plugin shot --editor`, sees the saved file only.

- Save with Cmd+S (Ctrl+S on Windows and Linux).
- Or turn on Settings → Editor → **Auto Save Files**. Orca then saves the drawing after the
  **Auto Save Delay** (1 second by default), as it does for other files. This is the setting to use
  when you and an agent take turns on a drawing.

An agent's change to the file on disk shows up on the canvas. If the canvas also has unsaved edits,
the two are merged by element: an element you changed keeps your change, and the rest takes the
agent's. When Orca can't merge them, for example when the file is open in a second tab, it shows
its file-changed banner and you pick which version to keep.

The view (scroll and zoom) is not saved. A drawing opens scrolled to its content.

## Images: `.excalidraw.svg` and `.excalidraw.png`

An SVG or PNG exported from Excalidraw with **Embed scene** on carries its drawing. Name it
`<name>.excalidraw.svg` or `<name>.excalidraw.png` and Orca opens it in this editor. It saves in the
same format: the drawing goes into the file, and the image is drawn again from it, so the file
shows what you drew and Excalidraw can open it again. A Markdown file or a web page can show the
same file that you edit.

- The image keeps the file's export settings: its scale (1×, 2× or 3×), whether it has a
  background, and dark mode. Excalidraw doesn't save them in the drawing, so they are read from the
  image. A PNG shows dark mode only through its background; a transparent dark PNG is drawn light.
- The image is drawn again once you pause, about 0.3 seconds after the last change; the drawing in
  the file is always the current one. A save waits up to 0.7 seconds for the image. A larger
  drawing may save with its previous image, and the tab then shows as changed until it is saved
  again.
- An empty `.excalidraw.svg` or `.excalidraw.png` file opens as a blank drawing and saves at 1×
  with a background. "New Excalidraw drawing" makes an `.excalidraw` file.
- An image without an embedded drawing does not open; export it from Excalidraw with **Embed
  scene** on.
- Orca opens a PNG as a binary file. Auto Save does not save it: save with Cmd+S (Ctrl+S on Windows
  and Linux). An outside change to a PNG shows Orca's file-changed banner instead of merging, and
  Source shows the picture rather than its text.

## What is in this folder

- `orca-plugin.json`: what Orca loads. The editor runs only in Orca's isolated editor frame
  (`"frame": "isolated"`).
- `editor/`: the built editor that Orca loads, `index.html` (and `image.html`, the same editor for
  images) plus ES module chunks, a stylesheet and fonts in `assets/`. Generated and committed: never
  edit it by hand.
- `build/`: the source of `editor/`, the build recipe and the tests. `build/src/scene-sync.js` is
  the document sync: Orca's `orca.document.session()` with a three-way merge by element id, so an
  outside change and this canvas's unsent change both survive. Build steps, the patches it makes to
  Excalidraw and how the editor talks to Orca are in [build/README.md](build/README.md).
- `templates/`: the blank drawing behind "New Excalidraw drawing".

## Changelog

### 2.2.0

- Opens and saves `.excalidraw.svg` and `.excalidraw.png` images with an embedded drawing. A save
  keeps the format, draws the image again and embeds the drawing in Excalidraw's own format, keeping
  the image's scale, background and dark mode.

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
