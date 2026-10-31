# Image Markup

Mark up screenshots and other images without leaving Orca. Images open straight in **Markup**;
Orca's own viewer stays one click away in the editor's view toggle. Draw with:

| Tool | Key | |
| --- | --- | --- |
| Select | `V` | Move shapes, drag arrow ends and box or ellipse corners, double-click text to edit it |
| Pen | `P` | Freehand ink; a click leaves a dot |
| Arrow | `A` | Hold Shift to snap to 45° |
| Box | `R` | Hold Shift for a square |
| Ellipse | `O` | Hold Shift for a circle |
| Text | `T` | Click to type; Esc or a click outside finishes |

`1`–`8` pick a colour and the dots pick a stroke size; with a shape selected, both restyle it.
Delete removes the selection, arrow keys nudge it, `⌘Z` / `⇧⌘Z` undo and redo. Pinch or
Ctrl/⌘-scroll zooms, scrolling or dragging empty space pans, Space-drag pans with any tool,
`⌘0` fits and `⌘1` shows 100%.

## Copying and saving

**`⌘S` is how you share markup today.** Orca doesn't yet let plugin frames put images on the
clipboard, and a stand-in (such as HTML with an embedded image) pastes nowhere an agent can read,
so **Copy** (`⌘C`) explains this instead of copying. Once Orca allows it, Copy puts a real PNG
of the image with its markup on the clipboard, with no plugin update needed.

**`⌘S`** saves the markup into the image file through Orca's normal save. The file then shows
the markup everywhere: other viewers, agents, uploads. It also keeps the original image and the
shapes inside it, so reopening Markup gives you the untouched original with every shape still
editable, and clearing all markup and saving restores the original file byte for byte. The tab
is marked unsaved while there is markup to save; close it without saving to throw the markup away.

PNG files keep the extra data in a private `orCA` chunk and JPEG files in APP9 segments, so
every image reader ignores it. If another tool later changes the pixels but keeps that data,
Markup notices and opens the file as a plain image. A saved file grows by about the size of the
original. JPEG markup is saved as a new JPEG at quality 0.92; the original keeps its quality.

## Limits

- PNG and JPEG can hold markup. WebP, GIF (first frame only), BMP and AVIF open for markup, but
  are never written. Read-only tabs are never written either.
- The saved image is limited to Orca's 64 MiB document cap, original included.
- The flattened image is sRGB; a Display P3 original keeps its colours inside the file.
- Orca plugins cannot create files, so there is no separate "export as" file yet.

Requires Orca 1.4.245 or later. Build instructions and tests are in [build/README.md](build/README.md).

MIT licence. No third-party code is bundled.
