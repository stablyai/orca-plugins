# Word Document Viewer

Open `.docx` files as read-only pages in Orca's editor. The preview shows page layout, tables,
headers, footers, footnotes, images and embedded fonts. Select and copy text as usual. Zoom with
the footer controls or Ctrl+wheel / trackpad pinch, and use **Fit** to fit the page to the pane.
The controls follow Orca's light or dark theme; document pages keep their original colours.
Requires Orca 1.4.248 or later.

- **Find:** Cmd+F (Ctrl+F on Windows and Linux) or **Find** in the footer searches the document,
  including text split across formatting. Enter and Shift+Enter (or Cmd/Ctrl+G, F3) step through
  matches; Escape closes the bar.
- **Tracked changes and comments:** insertions are underlined in blue, deletions struck through in
  red, and commented text is shaded with a marker you can hover or focus to read the comment.
  **Markup** in the footer, shown only for documents that have any, switches to the document as if
  every change were accepted.
- **Links:** web and email links open in your browser through Orca, which asks before opening a
  site the first time. Bookmark links scroll to their target. Where Orca cannot open links (a
  browser client), the address is shown to copy instead. Other link schemes are disabled.
- **Saved view:** the desktop app remembers each document's zoom and Markup setting. A document is
  recognised by the id Word stores in it, so the setting follows the file through edits and
  renames; a file without one is recognised only while its contents stay the same.

Orca supplies the document bytes through its document session for local, SSH and paired-host
files, and sends a new version when the file changes outside the editor. The viewer keeps the
current zoom and scroll position on reload. It never edits or writes back to the document.

## Limits

- `.docx` only; legacy `.doc`, password-encrypted documents and ZIP64 archives are unsupported.
- Files are limited to 50 MiB, 2,000 archive entries, 256 MiB of inflated content, and 32 MiB per
  XML part. Actual inflated sizes are checked before parsing, including XML disguised as media.
- Complex Word layout may differ from Microsoft Word. Tracked changes show one colour for every
  author, comment replies and resolved state are not shown, and embedded HTML (`altChunk`) is not
  rendered. Links to other files are disabled. There is no editing.
- Documents cannot run macros or scripts, load network resources, or style Orca. Rendering runs
  in Orca's sandboxed editor frame; document styles are isolated from the controls in a shadow root.

## Changelog

### 2.0.0

- Find in the document (Cmd/Ctrl+F), with match count and next/previous.
- Tracked changes and comments are shown, with a Markup switch.
- Web and email links open through Orca instead of only being copyable.
- Zoom and Markup are remembered per document.
- Uses Orca's document session; needs Orca 1.4.248.

### 1.0.0

Read-only preview with page layout, zoom and copyable links.

## Credits and licence

The archive guard, rendering options and default page layout are adapted from
[Kazuki Hanai's DOCX preview PR](https://github.com/stablyai/orca/pull/35061), addressing
[issue #35060](https://github.com/stablyai/orca/issues/35060). The original commit credits Kazuki
Hanai (`@kazuki-hanai`) and co-author Claude Opus 5.5. This plugin replaces the native viewer
integration with Orca's sandboxed custom-editor API.

MIT. Bundled libraries include [docx-preview](https://github.com/VolodymyrBaydalka/docxjs)
(Apache-2.0), JSZip (MIT), fflate (MIT), and their dependencies; see
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Build instructions and tests are in
[build/README.md](build/README.md).
