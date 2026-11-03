# Spreadsheet

Opens and edits Excel and OpenDocument spreadsheets in Orca's editor: `.xlsx`, `.xlsm`, `.xlsb`,
`.xls` and `.ods`. Every visible sheet gets a tab along the bottom, and the grid shows each cell as
the file formats it — currency, percentages, dates, errors such as `#DIV/0!` — with merged cells
drawn as one. The bar above the grid shows the selected cell's address and its formula or value;
the status bar shows the sheet's size and, for a selection, its count, sum and average. Requires
Orca 1.4.248 or later.

CSV and TSV files are not handled here: Orca opens those in its own editable table view.

## Editing

`.xlsx`, `.xlsm` and `.ods` files are editable. Type over a cell, or press F2 or double-click to
edit what is in it; the formula bar above the grid edits the active cell too. A value takes the
cell's number format, so `12` typed into a currency cell reads `$12.00`. Text starting with `=` is
a formula; start with `'` to keep it as text.

Right-click (or Shift+F10) for the cell menu: insert rows above or below, delete rows, insert
columns left or right, delete columns, clear contents. Formulas, merged cells, conditional formats,
validation rules, hyperlinks and named ranges follow the rows and columns they point at, as in
Excel; a reference to a deleted cell becomes `#REF!`.

Orca keeps the file: edits mark the tab unsaved and Orca's save writes them. When an agent or
another app changes the file while you have unsaved edits, they are merged only when that is
clearly safe: the outside change left every sheet's size and merged cells alone and touched no row
or column you edited, and you only changed cell contents. Otherwise the tab shows the new file and
sets your edits aside, with a choice to reapply them at the same cells or discard them, so nothing
lands on rows that moved underneath it.

Saving changes only what you edited. Styles, column widths, charts, pictures, comments, macros and
every other part of the file keep their exact bytes, so the file opens in Excel exactly as before
plus your edits. `.xlsm` macros are kept as they were.

Formulas recalculate as you type, for arithmetic, comparisons, text joins, references, ranges and
common functions (`SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `COUNTIF`, `SUMIF`, `IF`,
`IFERROR`, `AND`, `OR`, `ROUND`, `CONCAT`, `LEFT`, `MID`, `LEN` and more). A formula that uses
anything else keeps the result saved in the file (hover the result for a note), and the saved file
asks Excel to recalculate every formula when it opens. A formula it can't calculate (array
formulas included) is saved without a result, so the next desktop spreadsheet app to open it computes it rather
than show an outdated one. Formulas typed with `;` between arguments are saved with commas.

## Read-only files

- `.xls` (Excel 97-2003) and `.xlsb` (Excel binary) open read-only, with a notice: they cannot be
  written without losing data. Save a copy as `.xlsx` or `.ods` in a desktop spreadsheet app to edit
  it here.
- Files Orca opens read-only (an agent's transcript, say) say so and accept no edits.

## Keyboard

| Keys | Does |
| --- | --- |
| Arrow keys | Move the active cell |
| Ctrl/Cmd + arrow | Jump to the edge of the data |
| Shift + any move, or Shift + click | Extend the selection |
| Tab / Shift+Tab, Enter / Shift+Enter | Move right / left, down / up; inside a selection, walk its cells |
| Page Up / Page Down | Move a screen up or down |
| Home / End | First column / last filled cell of the row |
| Ctrl/Cmd + Home / End | First cell / last used cell of the sheet |
| Ctrl/Cmd + A | Select the whole sheet |
| Shift+Space / Ctrl+Space | Select the row / column |
| Ctrl/Cmd + Page Up / Page Down, or Alt + Left / Right | Previous / next sheet |
| Typing, F2, double-click | Replace the cell, or edit what is in it |
| Enter / Tab while editing | Keep the edit and move down / right; Escape drops it |
| Alt + Enter while editing | New line in the cell |
| Delete / Backspace | Clear the selected cells |
| Ctrl/Cmd + Z, Ctrl/Cmd + Shift + Z (Ctrl + Y) | Undo, redo |
| Ctrl/Cmd + C / X / V | Copy, cut, paste |
| Shift+F10 or right-click | Cell menu |

Copying puts the selection on the clipboard as tab-separated text, as Excel does, so it pastes into
spreadsheets, documents and terminals; rich-text targets also get an HTML table. Pasting
tab-separated text fills cells from the active one; a single value fills the whole selection.

## Limits

- **Cell contents only.** Fonts, colours, borders and number formats are kept but cannot be changed
  here; new cells use the default style.
- **Row and column changes stop** on a sheet whose charts, pictures, comments, tables, pivot tables
  or similar would end up in the wrong place, or that a chart, pivot table, sparkline or rule on
  another sheet reads; the status bar says why.
- **Excel tables:** header and totals cells can't be edited here, because the table keeps those
  names itself. `.ods` files also refuse a
  row or column change through merged cells. Edit those sheets' cells freely, or make the change
  in a desktop spreadsheet app.
- **Sheets** cannot be added, renamed or deleted yet. Hidden sheets are left out (the tab bar counts
  them) and kept in the file.
- **Macros never run.**
- **Size.** Orca opens files of up to 64 MiB. Zip-based workbooks are also refused if their contents
  expand past 256 MB or 4,000 parts, so a damaged or hostile file cannot exhaust memory.
- **Encrypted workbooks** (password to open) are not supported; a password that only protects sheets
  does not matter here.
- Old `.xls` files that use a non-Western code page (BIFF5 and earlier) may show garbled text.

## What is in this folder

- `orca-plugin.json`: what Orca loads.
- `editor/index.html`: the built editor, one self-contained file. Generated and committed: never
  edit it by hand.
- `build/`: the source of `editor/`, the build recipe and the tests; see
  [build/README.md](build/README.md).

## Changelog

### 2.0.0

- Editing: cell values and formulas, inserting and deleting rows and columns, clearing, paste, and
  undo and redo. Saves `.xlsx`, `.xlsm` and `.ods` in place, changing only what was edited.
- Formulas recalculate as you type, for the common functions.
- Uses Orca's document session: Orca saves, tracks unsaved changes, and merges outside writes with
  your unsaved edits. Needs Orca 1.4.248; older Orca keeps 1.1.0.
- `.xls` and `.xlsb` open read-only with a notice.

### 1.1.0 and earlier

Spreadsheet Viewer: view-only.

## Licence

MIT. The editor bundles third-party software listed in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
