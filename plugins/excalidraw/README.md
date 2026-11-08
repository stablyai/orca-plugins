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
  image. A PNG this editor saved notes them exactly. In a PNG from Excalidraw itself, dark mode shows
  only through the background, so a transparent dark PNG is read as light.
- To change them, open the main menu (☰): **Picture in this file** has **Scale**, **Background**
  and **Dark mode**. A change redraws this file's image, and new images start with the settings
  you picked last.
- The image is drawn again once you pause, about 0.3 seconds after the last change; the drawing in
  the file is always the current one. A save waits for the image only as long as Orca's one-second
  save time allows. A drawing that is slow to draw, or that holds megabytes of pictures, may save
  with its previous image, and the tab then shows as changed until it is saved again.
- "New Excalidraw SVG image" and "New Excalidraw PNG image" (in the tab bar's + menu and the
  command palette) make an image to draw in, as does any empty `.excalidraw.svg` or
  `.excalidraw.png` file. It starts at 1× with a background, or with the settings you picked last.
- To turn a drawing into an image, or one image format into the other, rename the file: for
  example `diagram.excalidraw` to `diagram.excalidraw.svg`, or `.excalidraw.svg` to
  `.excalidraw.png`. The editor opens the drawing, draws its image (the tab shows as changed), and
  saving writes the new format. An SVG renamed to PNG keeps its settings.
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
- `templates/`: the blank drawing behind "New Excalidraw drawing". New images start empty.

## Changelog

### 2.3.0

- Images get **Picture in this file** in the main menu, for their scale, background and dark mode;
  new images start with the last ones picked. A PNG notes them, so it reopens exactly as saved.
- Renaming an `.excalidraw` file to `.excalidraw.svg` or `.excalidraw.png`, or an SVG image to PNG,
  converts it on the next save.
- "New Excalidraw SVG image" and "New Excalidraw PNG image".

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
