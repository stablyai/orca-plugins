// The database side (src/sqlite-engine.js) against the WebAssembly SQLite the editor bundles.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import initSqlJs from 'sql.js'
import { SqliteEngine } from '../src/sqlite-engine.js'

const SQL = await initSqlJs()

/** A database file built from `sql`. */
function fileOf(sql) {
  const db = new SQL.Database()
  db.run(sql)
  const bytes = db.export()
  db.close()
  return bytes
}

const MUSIC = `
  CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT);
  INSERT INTO artists (name, country) VALUES ('Ana', 'PT'), ('Bo', 'SE'), ('Cy', NULL), ('Dee', 'SE');
  CREATE TABLE tracks (artist INTEGER, title TEXT, seconds REAL, cover BLOB, total INTEGER GENERATED ALWAYS AS (artist * 10));
  INSERT INTO tracks (artist, title, seconds, cover) VALUES (1, 'Morning', 181.5, x'00ff10'), (2, 'Night', 240, NULL), (2, 'Noon', 99.25, NULL);
  CREATE TABLE pairs (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
  INSERT INTO pairs VALUES ('x', 'y');
  CREATE VIEW swedes AS SELECT name FROM artists WHERE country = 'SE';
  CREATE INDEX tracks_by_artist ON tracks (artist);
  CREATE TRIGGER no_delete BEFORE DELETE ON artists BEGIN SELECT 1; END;
`

const labels = (rows) => rows.map((row) => row.label)
const texts = (rows, column) => rows.map((row) => row.cells[column].v)

test('opening a database lists its objects with columns and row counts', () => {
  const engine = new SqliteEngine(SQL, fileOf(MUSIC))
  const byName = Object.fromEntries(engine.objects.map((object) => [object.name, object]))
  assert.deepEqual(
    engine.objects.map((object) => `${object.type}:${object.name}`).sort(),
    ['index:tracks_by_artist', 'table:artists', 'table:pairs', 'table:tracks', 'trigger:no_delete', 'view:swedes']
  )
  assert.equal(byName.artists.rowCount, 4)
  assert.equal(byName.artists.rowid, 'rowid')
  assert.equal(byName.pairs.rowid, null)
  assert.deepEqual(
    byName.tracks.columns.map((column) => `${column.name}:${column.type}${column.generated ? ':generated' : ''}`),
    ['artist:INTEGER', 'title:TEXT', 'seconds:REAL', 'cover:BLOB', 'total:INTEGER:generated']
  )
  assert.equal(engine.info.pageSize, 4096)
  assert.equal(engine.info.wal, false)
  engine.close()
})

test('a table reads in place, with rowids, cut text and blob sizes', () => {
  const engine = new SqliteEngine(SQL, fileOf(`CREATE TABLE notes (body TEXT, data BLOB); INSERT INTO notes VALUES ('${'a'.repeat(400)}', zeroblob(2048)), ('short', NULL);`))
  const result = engine.openObject('notes')
  assert.equal(result.count, 2)
  assert.equal(result.label, 'rowid')
  const rows = engine.rows(result.id, 0, 10)
  assert.deepEqual(labels(rows), ['1', '2'])
  assert.equal(rows[0].cells[0].v.length, 300)
  assert.equal(rows[0].cells[0].clipped, true)
  assert.deepEqual(rows[0].cells[1], { t: 'blob', v: null, size: 2048 })
  assert.equal(engine.cell(result.id, 0, 0).v.length, 400)
  assert.equal(engine.cell(result.id, 0, 1).v.length, 2048)
  engine.close()
})

test('generated columns, views and WITHOUT ROWID tables show their rows', () => {
  const engine = new SqliteEngine(SQL, fileOf(MUSIC))
  const tracks = engine.openObject('tracks')
  assert.deepEqual(texts(engine.rows(tracks.id, 0, 5), 4), [10n, 20n, 20n])
  const view = engine.openObject('swedes')
  assert.equal(view.label, 'position')
  assert.deepEqual(texts(engine.rows(view.id, 0, 5), 0), ['Bo', 'Dee'])
  const pairs = engine.openObject('pairs')
  assert.deepEqual(engine.rows(pairs.id, 0, 5).map((row) => [row.label, ...texts([row], 0)]), [['1', 'x']])
  engine.close()
})

test('sorting and filtering by column keep rowids as labels', () => {
  const engine = new SqliteEngine(SQL, fileOf(MUSIC))
  const byName = engine.openObject('artists', { sort: { column: 1, descending: true } })
  assert.deepEqual(texts(engine.rows(byName.id, 0, 10), 1), ['Dee', 'Cy', 'Bo', 'Ana'])
  assert.deepEqual(labels(engine.rows(byName.id, 0, 10)), ['4', '3', '2', '1'])
  const swedes = engine.openObject('artists', { filters: { 2: 'se' } })
  assert.deepEqual(texts(engine.rows(swedes.id, 0, 10), 1), ['Bo', 'Dee'])
  const noCountry = engine.openObject('artists', { filters: { 2: 'null' } })
  assert.deepEqual(texts(engine.rows(noCountry.id, 0, 10), 1), ['Cy'])
  const long = engine.openObject('tracks', { filters: { 2: '>=181.5' }, sort: { column: 2 } })
  assert.deepEqual(texts(engine.rows(long.id, 0, 10), 1), ['Morning', 'Night'])
  const search = engine.openObject('artists', { search: 'D' })
  assert.deepEqual(texts(engine.rows(search.id, 0, 10), 1), ['Dee'])
  // A LIKE wildcard in the text matches only itself.
  assert.equal(engine.openObject('artists', { search: '%' }).count, 0)
  engine.close()
})

test('a query runs every statement and shows the last one with columns', () => {
  const engine = new SqliteEngine(SQL, fileOf(MUSIC))
  const { statements, result } = engine.run(`
    SELECT 1;
    -- the result
    SELECT a.name, t.title, a.id AS id, t.artist AS id FROM artists a JOIN tracks t ON t.artist = a.id ORDER BY t.seconds;
  `)
  assert.equal(statements, 2)
  assert.deepEqual(result.columns.map((column) => column.name), ['name', 'title', 'id', 'id'])
  assert.equal(result.count, 3)
  assert.deepEqual(texts(engine.rows(result.id, 0, 10), 1), ['Noon', 'Morning', 'Night'])
  const filtered = engine.reopen(result.id, { filters: { 1: 'n' }, sort: { column: 1 } })
  const rows = engine.rows(filtered.id, 0, 10)
  assert.deepEqual(texts(rows, 1), ['Morning', 'Night', 'Noon'])
  assert.deepEqual(labels(rows), ['2', '3', '1'], 'labels are the row numbers in the query result')
  engine.close()
})

test('queries cannot change the database, even after turning query_only off', () => {
  const engine = new SqliteEngine(SQL, fileOf(MUSIC))
  for (const sql of [
    'DELETE FROM artists',
    'DELETE FROM artists RETURNING *',
    'PRAGMA query_only = 0; DELETE FROM artists',
    'CREATE TABLE more (a)',
    "WITH x AS (SELECT 1) INSERT INTO artists (name) SELECT 'Eve' FROM x"
  ]) {
    assert.throws(() => engine.run(sql), /readonly/, sql)
  }
  assert.equal(engine.rows(engine.run('SELECT count(*) FROM artists').result.id, 0, 1)[0].cells[0].v, 4n)
  engine.close()
})

test('a statement no subquery can hold, such as PRAGMA, still gives rows', () => {
  const engine = new SqliteEngine(SQL, fileOf(MUSIC))
  const { result } = engine.run('PRAGMA table_info(artists)')
  assert.equal(result.count, 3)
  assert.deepEqual(texts(engine.rows(result.id, 0, 5), 1), ['id', 'name', 'country'])
  engine.close()
})

test('a SQL error names its statement', () => {
  const engine = new SqliteEngine(SQL, fileOf(MUSIC))
  assert.throws(
    () => engine.run('SELECT 1; SELECT nope FROM artists'),
    (error) => error.statement === 2 && /no such column: nope/.test(error.message)
  )
  engine.close()
})

test('integers keep full precision', () => {
  const engine = new SqliteEngine(SQL, fileOf('CREATE TABLE big (n INTEGER); INSERT INTO big VALUES (9007199254740993);'))
  const result = engine.openObject('big')
  assert.equal(engine.rows(result.id, 0, 1)[0].cells[0].v, 9007199254740993n)
  engine.close()
})

test('copy and CSV hold whole values', () => {
  const engine = new SqliteEngine(SQL, fileOf(`CREATE TABLE t (a TEXT, b REAL, c BLOB); INSERT INTO t VALUES ('x,"y"', 1.5, x'0aff'), (NULL, 2, NULL);`))
  const result = engine.openObject('t')
  assert.equal(engine.copy(result.id, 0, 1, [0], false, 1000), 'x,"y"')
  assert.equal(engine.copy(result.id, 0, 2, null, true, 1000), 'a\tb\tc\n"x,""y"""\t1.5\t0AFF\n\t2.0\t')
  assert.equal(new TextDecoder().decode(engine.csv(result.id, 1000)), 'a,b,c\r\n"x,""y""",1.5,0AFF\r\n,2.0,\r\n')
  assert.throws(() => engine.csv(result.id, 10), /over/)
  assert.throws(() => engine.copy(result.id, 0, 2, null, true, 3), /too much/)
  engine.close()
})

test('a write-ahead-log database opens, and other files are refused', () => {
  const bytes = fileOf(MUSIC)
  bytes[18] = 2
  bytes[19] = 2
  const engine = new SqliteEngine(SQL, bytes)
  assert.equal(engine.info.wal, true)
  assert.equal(engine.objects.find((object) => object.name === 'artists').rowCount, 4)
  engine.close()
  assert.throws(() => new SqliteEngine(SQL, new TextEncoder().encode('not a database at all, just text that is long enough to be a header of some kind........')), (error) => error.kind === 'not-sqlite')
  const empty = new SqliteEngine(SQL, new Uint8Array(0))
  assert.equal(empty.info.empty, true)
  assert.deepEqual(empty.objects, [])
  empty.close()
})

test('closing a result drops its temp table', () => {
  const engine = new SqliteEngine(SQL, fileOf(MUSIC))
  const sorted = engine.openObject('artists', { sort: { column: 1 } })
  engine.closeResult(sorted.id)
  assert.equal(engine.all("SELECT count(*) FROM temp.sqlite_schema WHERE type = 'table'")[0][0], 0n)
  assert.throws(() => engine.rows(sorted.id, 0, 1), /closed/)
  engine.close()
})

test('filters match 64-bit integers exactly, and numbers match text in query results', () => {
  const engine = new SqliteEngine(SQL, fileOf("CREATE TABLE m (id INTEGER, zip TEXT); INSERT INTO m VALUES (1234567890123456789, '90210'), (1234567890123456768, '10001');"))
  assert.equal(engine.openObject('m', { filters: { 0: '=1234567890123456789' } }).count, 1)
  assert.equal(engine.openObject('m', { filters: { 0: '!=1234567890123456789' } }).count, 1)
  assert.equal(engine.openObject('m', { filters: { 0: '>1234567890123456768' } }).count, 1)
  const { result } = engine.run('SELECT zip FROM m')
  assert.equal(engine.reopen(result.id, { filters: { 0: '=90210' } }).count, 1)
  assert.equal(engine.reopen(result.id, { filters: { 0: '!=90210' } }).count, 1)
  engine.close()
})

test('PRAGMA results keep integers as integers', () => {
  const engine = new SqliteEngine(SQL, fileOf(MUSIC))
  const { result } = engine.run('PRAGMA table_info(artists)')
  assert.deepEqual(engine.rows(result.id, 0, 1)[0].cells[0], { t: 'integer', v: 0n })
  const sorted = engine.reopen(result.id, { filters: { 0: '>1' } })
  assert.equal(sorted.count, 1)
  engine.close()
})

test('the detail pane gets a capped preview of a huge cell, with its whole length', () => {
  const engine = new SqliteEngine(SQL, fileOf(`CREATE TABLE big (t TEXT, b BLOB); INSERT INTO big VALUES ('${'x'.repeat(5000)}', zeroblob(100000));`))
  const result = engine.openObject('big')
  const text = engine.cell(result.id, 0, 0, 1000, 4096)
  assert.deepEqual([text.v.length, text.length, text.truncated], [1000, 5000, true])
  const blob = engine.cell(result.id, 0, 1, 1000, 4096)
  assert.deepEqual([blob.v.length, blob.length, blob.truncated], [4096, 100000, true])
  assert.throws(() => engine.copy(result.id, 0, 1, [1], false, 100000), /too much/)
  engine.close()
})

test('a cut preview of emoji text is marked cut, though JS counts each emoji twice', () => {
  const engine = new SqliteEngine(SQL, fileOf(`CREATE TABLE e (t TEXT); INSERT INTO e VALUES ('${'😀'.repeat(250)}'), ('${'😀'.repeat(150)}');`))
  const result = engine.openObject('e')
  const cut = engine.cell(result.id, 0, 0, 200, 4096)
  assert.deepEqual([cut.length, cut.truncated], [250, true])
  assert.equal([...cut.v].length, 200)
  const whole = engine.cell(result.id, 1, 0, 200, 4096)
  assert.deepEqual([whole.length, whole.truncated], [150, false])
  engine.close()
})

test('integer filters past the int64 range compare as numbers instead of clamping', () => {
  const engine = new SqliteEngine(SQL, fileOf('CREATE TABLE m (id INTEGER); INSERT INTO m VALUES (9223372036854775807);'))
  assert.equal(engine.openObject('m', { filters: { 0: '=99999999999999999999' } }).count, 0)
  assert.equal(engine.openObject('m', { filters: { 0: '<99999999999999999999' } }).count, 1)
  engine.close()
})
