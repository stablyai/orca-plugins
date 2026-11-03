# Building Spreadsheet

`../editor/index.html` is generated. Orca loads it as one document inside a sandboxed frame whose
CSP allows only inline scripts and styles and no workers, so the build inlines
everything into that one file. There is no framework: the grid is plain DOM. The bundle holds two
dependencies: SheetJS reads workbooks and formats numbers, and fflate inflates and deflates zip
parts synchronously (the document session's `encode` and `merge` cannot wait).

```sh
npm ci --ignore-scripts
node build.mjs
npm test            # unit tests, then the headless browser tests against the built file
```

The build is deterministic: the same lockfile produces the same bytes. It also rewrites
`../THIRD_PARTY_NOTICES.txt` from the packages in the bundle, and fails if a package's licence
differs from the reviewed copy in `licenses/`.

## SheetJS

SheetJS Community Edition is pinned to the official tarball,
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (the lockfile records its integrity hash).
The `xlsx` package on the npm registry stopped at 0.18.5, which has known vulnerabilities
(CVE-2023-30533, prototype pollution; CVE-2024-22363, ReDoS); do not switch to it. To update,
check <https://cdn.sheetjs.com/> for a newer release, change the URL in `package.json`, run
`npm install --ignore-scripts`, review the licence and update `licenses/xlsx.txt` if it changed.

Workbooks are read with `dense: true` (rows as arrays, which is what makes 50,000-row sheets cheap),
`cellFormula: true` and SheetJS's formatted text (`.w`). `cellStyles: true` is set only because
SheetJS reads column widths and row heights under it.

What the build leaves out, and why:

- SheetJS's code-page tables (`cpexcel`, ~470 KB): only BIFF5-and-earlier `.xls` files with
  non-Western code pages need them.
- SheetJS's writers, and every format other than the five Orca routes here. Saving does not go
  through SheetJS (see below).

## Safety checks before parsing

- Zip-based files (`.xlsx`, `.xlsm`, `.xlsb`, `.ods`): the zip central directory is walked without
  inflating anything, and the file is refused if it declares more than 256 MB uncompressed or more
  than 4,000 entries (`src/zip-budget.js`). This guard is adapted from the Office zip check in
  [stablyai/orca#29678](https://github.com/stablyai/orca/pull/29678) by @nebourocket.
- Bytes that are not a zip, a compound file, a BIFF stream or markup (SpreadsheetML/HTML saved as
  `.xls`) are refused as damaged, because SheetJS would otherwise read them as CSV text.
- Encrypted packages and password-protected `.xls` files are recognised from SheetJS's errors.

## Saving

The document is the file's bytes plus the operations made since (`src/workbook-edits.js`): set
cells, or insert or delete rows or columns. Each operation also changes the live model the grid
shows and returns its inverse, which undo applies. Encoding replays the log onto the file's own
XML, so a save changes only what was edited:

- `.xlsx` / `.xlsm` (`src/xlsx-writer.js`): only the worksheets with edits (or recalculated
  results) are rewritten, cell by cell. A cell keeps its style (`s`); new text is stored inline, so
  the shared string table is untouched; shared formulas on a rewritten sheet are written out per
  cell. `workbook.xml` gets `fullCalcOnLoad`, and the calculation chain is dropped, since a stale one
  makes Excel repair the file. Every other part, macros included, keeps its compressed bytes.
- Row and column changes move references in every formula, merged cells, column widths,
  conditional formats, validation, hyperlinks, selections, page breaks and defined names. A sheet
  with parts the writer does not move (drawings, comments, tables, pivot tables, `extLst`, any
  linked part but hyperlinks and printer settings), or that a chart, pivot cache, table formula or
  another sheet's extensions (sparklines, newer rules) read, refuses them (`xlsxShiftBlocker`).
  Header and totals cells of Excel tables refuse edits (`xlsxLockedRanges`).
- `.ods` (`src/ods-writer.js`): only `content.xml` is rewritten, and in it only the edited cells,
  splitting repeated rows and cells as needed. Formulas are kept in OpenDocument form and converted
  to Excel's spelling for display (`src/formula-odf.js`). Row and column changes adjust repeat
  counts, keep a sheet within its row limit, and move references in formulas and named ranges;
  they stop at merged cells, pictures, charts, conditional formats and validation.
- `.xls` and `.xlsb` are read-only: they are binary formats nothing here can write without losing
  data.

Formulas recalculate as cells change (`src/formula-eval.js`, `recalculate` in
`src/workbook-edits.js`): only formulas that read a changed cell, directly or through others,
except after a row or column change, which recalculates every formula (results such as `ROW`,
`MATCH` or `COUNTBLANK` depend on position). A
formula with a function the calculator lacks, or an array formula, keeps showing its saved result
(marked stale) and is saved without one, so the next desktop spreadsheet app to open it computes it.

`test/workbook-writers.test.mjs` checks what changes and that every other part keeps its bytes,
against hand-written workbooks (`scripts/styled-fixture.mjs`) with styles, shared strings and
formulas, merges, conditional formats, validation, a defined name, a calculation chain, a drawing
and a macro project.

## Source layout

| File | What it holds |
| --- | --- |
| `src/editor.js` | Entry: the document session, sheet tabs, formula and status bars, cell editor, menu, clipboard, undo |
| `src/workbook-document.js` | The session's `decode`, `encode` and `merge`; which formats can be saved |
| `src/workbook-edits.js` | Operations on the model, their inverses, and recalculation |
| `src/xlsx-writer.js`, `src/xlsx-parts.js` | Saving into Office Open XML |
| `src/ods-writer.js`, `src/formula-odf.js` | Saving into OpenDocument |
| `src/edit-plan.js`, `src/xml-text.js` | Where an operation log lands in the XML; exact XML edits |
| `src/formula-tokens.js`, `src/formula-shift.js`, `src/formula-eval.js` | Formula tokens, moving references, calculating |
| `src/cell-input.js`, `src/tsv-paste.js` | Typed text and pasted text as cells |
| `src/zip-archive.js` | Reading a zip with a real size cap, and rewriting it |
| `src/grid-view.js` | The virtualized grid: rendering, scrolling, keyboard and pointer input |
| `src/open-workbook.js` | Container sniffing, the zip check, SheetJS options, error classification |
| `src/zip-budget.js` | The zip-bomb guard on declared sizes |
| `src/workbook-model.js` | Sheets, used extent, column widths and row heights from a SheetJS workbook |
| `src/selection.js` | Selection and navigation, as a pure reducer |
| `src/merge-index.js` | Merged-cell lookup by cell and by window |
| `src/range-copy.js` | Selection to TSV and HTML, and the status bar's count/sum/average |
| `src/cell-display.js`, `src/address.js` | Cell text, kinds, formulas; A1 addresses |
| `scripts/make-fixtures.mjs` | Writes the test workbooks to `/private/tmp/xlsx-fixtures` (or `$SPREADSHEET_FIXTURES`) |
| `test/harness.mjs` | An Orca-like host: the same CSP, tokens and sandboxed `srcdoc` frame, in headless Chromium, with a stand-in document session that keeps every edit |
| `test/orca-testing/` | `mockEditorHost` from `orca/testing`, vendored (copy `orca-testing.mjs` and `orca-runtime.mjs` from Orca's `resources/plugins/declarative/` to update) |

The browser tests use the Chromium that `playwright-core` expects (`npx playwright-core install
chromium-headless-shell` if it is missing). Set `SPREADSHEET_SCREENSHOTS=<dir>` to save screenshots.

## Talking to Orca

`orca.document.session({ decode, encode, merge })` does the document sync
(`src/workbook-document.js`). It resolves once Orca's hello and the first document are in; Orca
keeps the buffer, dirty state and saving, flushes the editor before a save, and hands over outside
changes. `decode` only wraps the bytes; parsing waits for the grid. `encode` replays the log, and
remembers what it encoded, so decoding Orca's copy of an accepted edit gives that value back
instead of parsing the file again. `merge(base, outside, mine)` replays this tab's cell edits since
`base` onto `outside` only when that is clearly safe: no row or column change on this side, and on
the outside no sheet changed, no sheet changed its used size or merges, and no row or column this
tab edited changed. Otherwise it returns `outside` with the edits in `rejected`. The editor holds
them (across later outside writes too) and offers to reapply the cell edits at the same addresses,
each through the checks a typed edit gets, or discard them. Row and column changes are listed, never
reapplied. A typed formula whose inputs changed outside also refuses the merge.

The editor commits an open cell edit on `editor.flush` (registered before the session's handler),
on the save shortcut and on `pagehide`, so a save includes what is being typed.

`orca plugin test` runs only the tests that import no npm package (it refuses bare imports); run
`npm test` here for all of them.
