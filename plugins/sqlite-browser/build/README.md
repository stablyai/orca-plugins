# Building the SQLite Browser editor

`../editor/` is generated: the editor for Orca's isolated editor frame, a page of its own at
`orca-plugin-frame://<key>/editor/index.html`. It may load the plugin's own files, compile
WebAssembly and start workers; every request outside the plugin's files is refused. The manifest's
`"frame": "isolated"` keeps it there: browser clients, and desktop with isolated frames switched
off, open the file in Source instead.

```sh
npm ci --ignore-scripts
node build.mjs   # also runs npm test
```

The build is deterministic: the same lockfile produces the same bytes. It also rewrites
`../THIRD_PARTY_NOTICES.txt` from the bundled package's licence and `sqlite-notice.txt`, and fails
if any file is over 1 MiB (the catalog's limit) or evaluates strings as code (the frame's CSP
refuses `eval` and `Function`).

## Layout

- `editor/index.html`: the page, with `src/page.css` inline.
- `editor/assets/editor-<hash>.js`: the page (`src/main.js` and what it imports).
- `editor/assets/sqlite-worker-<hash>.js`: the worker that owns the database
  (`src/sqlite-worker.js`).
- `editor/assets/sql-wasm.wasm`: SQLite compiled to WebAssembly, from the package in `package.json`.

Sources:

- `src/sqlite-engine.js`: everything that touches the database. It opens an in-memory copy of the
  file with `PRAGMA query_only` on, lists its objects, and serves each grid as a "result": a table
  read in place (`LIMIT`/`OFFSET`), or rows copied into a temp table (a query's, a view's, or any
  sorted or filtered grid), which pages by rowid. Text over 300 characters reaches the grid cut and
  a blob only as its size; `cell()`, `copy()` and `csv()` read whole values. No DOM, so its tests
  run in Node.
- `src/result-query.js`: column filters, search and sort as SQL, with bound values.
- `src/sqlite-worker.js` and `src/sqlite-client.js`: the worker and the page's promise API to it.
  Cancel terminates the worker and opens the file again in a new one.
- `src/document-session.js`: the document sync.
- `src/app.js`, `src/grid.js`, `src/result-rows.js`: the page, the virtual grid and its page cache
  (200 rows a page, 40 pages kept).
- `src/value-format.js`: how values read in the grid, the clipboard and CSV.

## Read-only, and why queries cannot write

Queries run statement by statement with `query_only` on. The engine turns it off only to fill its
own temp tables, and then runs a query only as a subquery (`INSERT INTO temp… SELECT * FROM
(query)`), which SQL cannot make write; a statement no subquery can hold (`PRAGMA`, `EXPLAIN`) is
stepped with `query_only` on and its rows copied after. `PRAGMA query_only = 0` in a script does
not help: it is switched back on before each statement.

Cell editing is left out on purpose. Orca saves a bytes editor by replacing the whole file, and it
refuses a save when the file changed since it was read. That does not cover SQLite: an app with the
database open keeps writing to the file it opened (the replaced one), and a `-wal` or hot
`-journal` file next to it would be applied to the new file and corrupt it. The editor gets only
the document's bytes, so it cannot see those files or the app's locks.

## Talking to Orca

- `orca.document.session({ decode, encode })` (`src/document-session.js`) with `contentKind:
  "bytes"`. It resolves once Orca's hello brought the theme, so the page starts then. The editor
  never calls `change`, so the tab never turns dirty; `onReplace` brings each outside write, and
  the page opens it again, keeping the selected table with its sort and filters.
- `orca.files.saveAs({ suggestedName, mimeType, data })`: Export CSV. It needs the click's
  activation; when the export outlasts it, a "Save…" button asks for a new click.
- Orca's frames refuse `navigator.clipboard`, so copying goes through the copy event: ⌘C copies
  rows already loaded at once; anything larger is read from the worker first and copied with
  `document.execCommand('copy')` while the key press's activation lasts.

## Tests

`npm test` runs `test/*.test.mjs` with Node's test runner (`orca plugin test` runs them too).
`test/sqlite-engine.test.mjs` runs the engine on the bundled WebAssembly SQLite;
`test/document-session.test.mjs` drives the document sync against Orca's real frame session
through `mockEditorHost` from `orca/testing`, vendored in `test/orca-testing/` (copy
`orca-testing.mjs` and `orca-runtime.mjs` from Orca's `resources/plugins/declarative/`, or from
`orca plugin types`, to update it).

## Compatibility

`engines.orca` is 1.4.248, the first release with the document session and `"frame": "isolated"`.
`orca-catalog.json` keeps 1.0.0 listed beneath 2.0.0, so older Orca still installs the version
that runs in either frame.
