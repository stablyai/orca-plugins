# Image Markup

Mark up screenshots and other images without leaving Orca. Images open straight in **Markup**;
Orca's own viewer stays one click away in the editor's view toggle. Draw with:

| Tool | Key | |
| --- | --- | --- |
| Select | `V` | Move shapes, drag arrow ends and box or ellipse corners, double-click text to edit it |
| Pen | `P` | Freehand ink; a click leaves a dot |
| Highlighter | `H` | A wide translucent stroke; hold Shift for a straight one along a line of text |
| Arrow | `A` | Hold Shift to snap to 45° |
| Box | `R` | Hold Shift for a square |
| Ellipse | `O` | Hold Shift for a circle |
| Text | `T` | Click to type; Esc or a click outside finishes |
| Step number | `N` | Each click places the next numbered disc; deleting one renumbers the rest |
| Redact | `X` | Drag over anything secret to cover it; see below |

`1`–`8` pick a colour and the dots pick a stroke size; with a shape selected, both restyle it.
Delete removes the selection, arrow keys nudge it, `⌘Z` / `⇧⌘Z` undo and redo. Pinch or
Ctrl/⌘-scroll zooms, scrolling or dragging empty space pans, Space-drag pans with any tool,
`⌘0` fits and `⌘1` shows 100%.

## Saving, exporting and copying

**`⌘S`** saves the markup into the image file through Orca's normal save, and the tab shows
unsaved changes like any other file, from the first stroke on. The file then shows the markup everywhere: other viewers,
agents, uploads. It also keeps the original image and the shapes inside it, so reopening Markup
gives you the untouched original with every shape still editable, and clearing all markup and
saving restores the original file byte for byte. Close the tab without saving to throw the
markup away.

**Export** saves a copy of the image with its markup as a new PNG, wherever you choose, and
leaves the open file alone. It is in the desktop app only.

**Copy** (`⌘C`) is not available yet: Orca doesn't let plugins put images on the clipboard, and
a stand-in (such as HTML with an embedded image) pastes nowhere an agent can read, so `⌘C`
explains this instead. Once Orca allows it, Copy puts a real PNG on the clipboard with no
plugin update needed.

PNG files keep the extra data in a private `orCA` chunk and JPEG files in APP9 segments, so
every image reader ignores it. If another tool later changes the pixels but keeps that data,
Markup notices and opens the file as a plain image. A saved file grows by about the size of the
original. JPEG markup is saved as a new JPEG at quality 0.92; the original keeps its quality.

## Redaction

Redact covers an area with one flat colour (the area's average, hatched so it reads as
redacted). Nothing of what was under it can be read back. Saving removes it from the file for
good: the area is covered in the visible image **and** in the original kept inside. Everything
drawn before the last redaction (text, strokes, steps) is flattened into that original with
it, so no label or stroke under a redaction survives as text in the file; only markup drawn
after it stays editable. A JPEG's kept original is then re-encoded at quality 0.92. Until you
save you can still move, resize or undo a redaction; after saving, clearing all markup restores
the redacted image, not the secret.

Every other tool only draws over the image: a box or pen stroke over a password hides it from
viewers, but the original kept inside still has it. Use Redact for anything secret.

## When the file changes outside Markup

Orca owns the file: it marks the tab unsaved, saves it, and tells Markup when something else
writes it, such as an agent taking a new screenshot to the same path.

- With no unsaved markup, Markup shows the new image.
- Markup you drew but Orca hadn't received yet, or that was on its way when the file changed, is
  moved onto the new image and stays unsaved; a toast says so. Shapes keep their place in image
  pixels, and markup another editor saved into the file meanwhile is merged with yours.
- Once the tab is marked unsaved, Orca shows its banner instead: **Overwrite** keeps your
  markup over the old image, **Reload from Disk** takes the new image and drops it.

## Limits

- PNG and JPEG can hold markup. WebP, GIF (first frame only), BMP and AVIF open for markup, but
  are never written; use Export. Read-only tabs are never written either.
- Images over 64 megapixels, or over 32,767 px on a side, open in Orca's own viewer only, or
  open for markup without saving.
- One image keeps up to 5,000 shapes, 200,000 pen points and 20,000 characters of text.
- The saved image is limited to Orca's 64 MiB document cap, original included.
- Markup is encoded as you work, and Orca waits for the latest encode when you save. If a save
  straight after a stroke on a very large image is refused, press `⌘S` again.
- The flattened image is sRGB and keeps the original's pixel density; colour profiles and
  animation stay only in the original inside.
- Export suggests the name `markup.png`: plugins never learn the file's own name.

Requires Orca 1.4.248 or later; Orca 1.4.245 to 1.4.247 keep installing Image Markup 1.0.2.
Build instructions and tests are in [build/README.md](build/README.md).

## Changelog

### 2.0.0

- Saving runs on Orca's document session: Orca owns the unsaved state and the save, waits for
  the latest markup before saving, and a refused save keeps the markup unsaved.
- An outside write (say, an agent replacing the screenshot) no longer drops markup Orca hadn't
  received yet: it is moved onto the new image.
- New tools: Highlighter, Step number and Redact. Redact really removes the pixels from the
  saved file, original included.
- Export saves a copy with the markup as a new PNG through Orca's save dialog.
- Needs Orca 1.4.248.

### 1.0.2 and earlier

Pen, arrow, box, ellipse and text, saved into PNG and JPEG files with the original kept inside.

MIT licence. No third-party code is bundled.
