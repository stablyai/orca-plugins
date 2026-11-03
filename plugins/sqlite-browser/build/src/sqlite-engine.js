// The database side of the browser: runs in the worker (sqlite-worker.js), and in the tests on Node.
// It works on an in-memory copy of the file with `query_only` on, so nothing is ever written back.
// Each grid is a "result": a table read in place, or rows copied into a temp table (a query's,
// a view's, or any sorted or filtered grid), which pages by rowid.
import { orderClause, quoteId, whereClause } from './result-query.js'
import { cellText, csvField, toClipboard, toCsv } from './value-format.js'

/** Text cells longer than this reach the grid cut; `cell()` reads the whole value. */
export const GRID_TEXT_CHARS = 300

const HEADER = 'SQLite format 3\u0000'
const ENCODINGS = { 1: 'UTF-8', 2: 'UTF-16le', 3: 'UTF-16be' }
const ROWID_NAMES = ['rowid', '_rowid_', 'oid']
const GET = { useBigInt: true }

export class EngineError extends Error {
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}

/** Page size, page count, text encoding and writer version from the 100-byte file header. */
export function readHeader(bytes) {
  if (bytes.length === 0) {
    return { empty: true, wal: false }
  }
  const header = String.fromCharCode(...bytes.subarray(0, 16))
  if (bytes.length < 100 || header !== HEADER) {
    throw new EngineError(
      'not-sqlite',
      'This file doesn’t start with the SQLite file header, so it is another kind of file or an encrypted database.'
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const rawPageSize = view.getUint16(16)
  const version = view.getUint32(96)
  return {
    empty: false,
    wal: bytes[18] === 2 || bytes[19] === 2,
    pageSize: rawPageSize === 1 ? 65536 : rawPageSize,
    pageCount: view.getUint32(28),
    encoding: ENCODINGS[view.getUint32(56)] ?? 'UTF-8',
    sqliteVersion: version > 0 ? `${Math.floor(version / 1e6)}.${Math.floor(version / 1e3) % 1000}.${version % 1000}` : null
  }
}

const toNumber = (value) => (typeof value === 'bigint' ? Number(value) : value)

/** One cell as the page shows it: `{ t, v }`, with `t` SQLite's storage class. */
function cellOf(type, value) {
  if (type === 'integer') return { t: 'integer', v: typeof value === 'bigint' ? value : BigInt(value) }
  return { t: type, v: value }
}

export class SqliteEngine {
  /** `SQL` is the initialized WebAssembly SQLite module; `bytes` the file (an ArrayBuffer or view). */
  constructor(SQL, bytes) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    this.info = readHeader(source)
    const copy = new Uint8Array(source)
    // Why: the -wal file is not here, so the copy is opened as a rollback-journal database.
    if (this.info.wal) {
      copy[18] = 1
      copy[19] = 1
    }
    this.db = new SQL.Database(copy)
    this.results = new Map()
    this.nextId = 1
    try {
      this.db.run('PRAGMA temp_store = MEMORY')
      this.readOnly()
      this.objects = this.readObjects()
    } catch (error) {
      this.db.close()
      throw new EngineError('damaged', `SQLite can’t read this database: ${error.message}.`)
    }
  }

  close() {
    this.db.close()
  }

  readOnly() {
    this.db.run('PRAGMA query_only = 1')
  }

  /** Runs `write` with query_only off, for the temp tables behind results. */
  writable(write) {
    this.db.run('PRAGMA query_only = 0')
    try {
      return write()
    } finally {
      this.readOnly()
    }
  }

  all(sql, params = []) {
    const statement = this.db.prepare(sql)
    try {
      statement.bind(params)
      const rows = []
      while (statement.step()) rows.push(statement.get(null, GET))
      return rows
    } finally {
      statement.free()
    }
  }

  readObjects() {
    const rows = this.all("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'view', 'index', 'trigger')")
    return rows.map(([type, name, tableName, sql]) => {
      const object = { type, name, tableName, sql }
      if (type === 'table' || type === 'view') {
        Object.assign(object, this.describe(type, name, sql))
      }
      return object
    })
  }

  describe(type, name, sql) {
    const described = { virtual: type === 'table' && /^\s*create\s+virtual\s/i.test(sql ?? '') }
    try {
      // hidden: 1 is a virtual table's hidden column; 2 and 3 are generated columns, which show.
      described.columns = this.all('SELECT name, type, pk, hidden FROM pragma_table_xinfo(?)', [name])
        .filter((column) => toNumber(column[3]) !== 1)
        .map(([columnName, columnType, pk, hidden]) => ({
          name: columnName,
          type: columnType ?? '',
          pk: toNumber(pk) > 0,
          generated: toNumber(hidden) >= 2
        }))
      if (type === 'table') {
        described.rowid = this.rowidName(name, described.columns)
        described.rowCount = toNumber(this.all(`SELECT count(*) FROM main.${quoteId(name)}`)[0][0])
      }
    } catch (error) {
      described.error = `SQLite can’t read ${name}: ${error.message}.`
    }
    return described
  }

  /** The name that reads the table's rowid, or null for WITHOUT ROWID or when columns shadow all three. */
  rowidName(table, columns) {
    const taken = new Set(columns.map((column) => column.name.toLowerCase()))
    const name = ROWID_NAMES.find((candidate) => !taken.has(candidate))
    if (!name) return null
    try {
      this.db.prepare(`SELECT ${name} FROM main.${quoteId(table)} LIMIT 0`).free()
      return name
    } catch {
      return null
    }
  }

  objectNamed(name) {
    const object = this.objects.find((candidate) => candidate.name === name)
    if (!object || (object.type !== 'table' && object.type !== 'view')) {
      throw new EngineError('missing', `There is no table or view named ${name}.`)
    }
    if (object.error) throw new EngineError('damaged', object.error)
    return object
  }

  /**
   * A table or view's rows as a result: `{ id, columns, count, label }`. A table with no sort or
   * filter is read in place; anything else is copied into a temp table first.
   */
  openObject(name, view = {}) {
    const object = this.objectNamed(name)
    const rowid = object.type === 'table' ? object.rowid : null
    const relation = {
      from: `main.${quoteId(object.name)}`,
      exprs: object.columns.map((column) => quoteId(column.name)),
      columns: object.columns,
      label: rowid,
      tiebreak: rowid,
      labelKind: rowid ? 'rowid' : 'position'
    }
    if (object.type === 'table' && !hasView(view)) {
      return this.register({ kind: 'direct', ...relation, count: object.rowCount })
    }
    return this.materialize(relation, view)
  }

  /**
   * A query result (from `run`) sorted or filtered anew, as a new result whose labels are the
   * original row numbers. With no sort or filter it is the original result itself.
   */
  reopen(id, view = {}) {
    const base = this.result(id)
    if (!hasView(view) || base.kind !== 'temp') {
      return this.describeResult(base)
    }
    return this.materialize(
      {
        from: `temp.${quoteId(base.table)}`,
        exprs: base.exprs,
        columns: base.columns,
        label: 'coalesce(label, rowid)',
        tiebreak: 'rowid',
        labelKind: base.labelKind
      },
      view
    )
  }

  /** Copies `relation`'s rows, filtered and sorted by `view`, into a temp table. */
  materialize(relation, view) {
    const table = `orca_result_${this.nextId}`
    const columns = relation.exprs.map((_, index) => `c${index}`)
    const where = whereClause(relation.exprs, view.filters, view.search)
    const order = orderClause(relation.exprs, view.sort, relation.tiebreak)
    this.writable(() => {
      this.db.run(`CREATE TEMP TABLE ${quoteId(table)} (label, ${columns.join(', ')})`)
      this.db.run(
        `INSERT INTO temp.${quoteId(table)} SELECT ${relation.label ?? 'NULL'}, ${relation.exprs.join(', ')} FROM ${relation.from} ${where.sql} ${order}`,
        where.params
      )
    })
    const count = toNumber(this.all(`SELECT count(*) FROM temp.${quoteId(table)}`)[0][0])
    return this.register({ kind: 'temp', table, exprs: columns, columns: relation.columns, count, labelKind: relation.labelKind })
  }

  register(result) {
    const id = this.nextId++
    this.results.set(id, { ...result, id })
    return this.describeResult({ ...result, id })
  }

  describeResult(result) {
    return { id: result.id, columns: result.columns, count: result.count, label: result.labelKind }
  }

  result(id) {
    const result = this.results.get(id)
    if (!result) throw new EngineError('missing', 'This result was closed; run it again.')
    return result
  }

  closeResult(id) {
    const result = this.results.get(id)
    if (!result) return
    this.results.delete(id)
    if (result.kind === 'temp') {
      this.writable(() => this.db.run(`DROP TABLE IF EXISTS temp.${quoteId(result.table)}`))
    }
  }

  /**
   * Rows `start` to `start + count` as `{ label, cells }`; with `full` false, text over
   * GRID_TEXT_CHARS is cut (`clipped`) and a blob is only its size.
   */
  rows(id, start, count, full = false) {
    const rows = []
    this.eachRow(id, start, count, full, (row) => rows.push(row))
    return rows
  }

  /** Calls `visit` with each row of `rows()`, from one statement. */
  eachRow(id, start, count, full, visit) {
    const result = this.result(id)
    const project = result.exprs
      .map((expr) =>
        full
          ? `typeof(${expr}), ${expr}`
          : `typeof(${expr}), CASE typeof(${expr}) WHEN 'text' THEN substr(${expr}, 1, ${GRID_TEXT_CHARS + 1}) WHEN 'blob' THEN length(${expr}) ELSE ${expr} END`
      )
      .join(', ')
    const [sql, params] = this.window(result, project, start, count)
    const statement = this.db.prepare(sql)
    try {
      statement.bind(params)
      for (let index = start; statement.step(); index++) {
        const row = statement.get(null, GET)
        const cells = []
        for (let j = 1; j < row.length; j += 2) {
          const cell = cellOf(row[j], row[j + 1])
          if (!full && cell.t === 'blob') {
            cells.push({ t: 'blob', v: null, size: toNumber(cell.v) })
          } else if (!full && cell.t === 'text' && cell.v.length > GRID_TEXT_CHARS) {
            cells.push({ t: 'text', v: cell.v.slice(0, GRID_TEXT_CHARS), clipped: true })
          } else {
            cells.push(cell)
          }
        }
        visit({ label: row[0] == null ? String(index + 1) : String(row[0]), cells })
      }
    } finally {
      statement.free()
    }
  }

  /** Whole rows `start` to `start + count` for the clipboard, at most `maxChars` of text. */
  copy(id, start, count, columns, withNames, maxChars) {
    const result = this.result(id)
    const picked = columns ?? result.columns.map((_, index) => index)
    const rows = []
    let chars = 0
    this.eachRow(id, start, count, true, ({ cells }) => {
      const row = picked.map((index) => cells[index])
      chars += row.reduce((sum, cell) => sum + (cell.t === 'blob' ? (cell.v?.length ?? 0) * 2 : cell.t === 'text' ? cell.v.length : 8), 0)
      if (chars > maxChars) {
        throw new EngineError('too-large', 'That is too much to copy at once. Export the rows as CSV instead.')
      }
      rows.push(row)
    })
    return toClipboard(rows, withNames ? picked.map((index) => result.columns[index].name) : null)
  }

  /** The whole result as UTF-8 CSV bytes, or throws past `maxBytes`. */
  csv(id, maxBytes) {
    const result = this.result(id)
    const encoder = new TextEncoder()
    const chunks = [encoder.encode(toCsv(result.columns.map((column) => column.name), []))]
    let size = chunks[0].length
    let lines = []
    const drain = () => {
      const chunk = encoder.encode(lines.join(''))
      lines = []
      size += chunk.length
      if (size > maxBytes) {
        throw new EngineError('too-large', `The CSV would be over ${Math.floor(maxBytes / 1048576)} MB, more than Orca can save from an editor. Filter the rows first.`)
      }
      chunks.push(chunk)
    }
    this.eachRow(id, 0, result.count, true, ({ cells }) => {
      lines.push(`${cells.map((cell) => csvField(cellText(cell))).join(',')}\r\n`)
      if (lines.length === 1000) drain()
    })
    drain()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes.buffer
  }

  /** `SELECT label, <project>` over rows `start` to `start + count` of a result, with its params. */
  window(result, project, start, count) {
    return result.kind === 'direct'
      ? [`SELECT ${result.label ?? 'NULL'}, ${project} FROM ${result.from} LIMIT ? OFFSET ?`, [count, start]]
      : [`SELECT label, ${project} FROM temp.${quoteId(result.table)} WHERE rowid > ? AND rowid <= ? ORDER BY rowid`, [start, start + count]]
  }

  /**
   * One cell for the detail pane: at most `maxChars` of text or `maxBytes` of a blob, with the whole
   * `length` and `truncated` set when cut, so a huge value never crosses to the page whole.
   */
  cell(id, index, column, maxChars = Infinity, maxBytes = Infinity) {
    const result = this.result(id)
    const expr = result.exprs[column]
    const limit = (max) => (Number.isFinite(max) ? Math.floor(max) : -1)
    const [chars, bytes] = [limit(maxChars), limit(maxBytes)]
    const cut = (max) => (max >= 0 ? `substr(${expr}, 1, ${max})` : expr)
    // Why SQL decides the cut: length() counts characters, while a JS string counts UTF-16 units.
    const project =
      `typeof(${expr}), CASE typeof(${expr}) WHEN 'text' THEN ${cut(chars)} WHEN 'blob' THEN ${cut(bytes)} ELSE ${expr} END, length(${expr}), ` +
      `CASE typeof(${expr}) WHEN 'text' THEN ${chars} >= 0 AND length(${expr}) > ${chars} WHEN 'blob' THEN ${bytes} >= 0 AND length(${expr}) > ${bytes} ELSE 0 END`
    const [sql, params] = this.window(result, project, index, 1)
    const row = this.all(sql, params)[0]
    if (!row) return { t: 'null', v: null }
    const cell = cellOf(row[1], row[2])
    if (cell.t === 'text' || cell.t === 'blob') {
      cell.length = toNumber(row[3])
      cell.truncated = toNumber(row[4]) === 1
    }
    return cell
  }

  /**
   * Runs the SQL a person typed, one statement at a time with query_only on. The last statement
   * that returns columns becomes the result. `{ statements, result }`, or throws with
   * `statement` (1-based) set.
   */
  run(sql) {
    let statements = 0
    let last = null
    const iterator = this.db.iterateStatements(sql)
    try {
      for (const statement of iterator) {
        statements += 1
        try {
          const names = statement.getColumnNames()
          if (names.length > 0) {
            const text = statement.getSQL()
            statement.free()
            if (last) this.closeResult(last.id)
            last = this.captureStatement(text, names)
          } else {
            this.readOnly()
            while (statement.step());
            statement.free()
          }
        } catch (error) {
          statement.free()
          throw Object.assign(new EngineError('sql', error.message), { statement: statements })
        }
      }
    } catch (error) {
      if (error instanceof EngineError) throw error
      throw Object.assign(new EngineError('sql', error.message), { statement: statements + 1 })
    }
    return { statements, result: last }
  }

  /** A statement's rows in a temp table, in the order it returned them. */
  captureStatement(text, names) {
    const body = text.trim().replace(/;$/, '')
    const columns = names.map((name) => ({ name, type: '', pk: false, generated: false }))
    // Why wrapped: a subquery can only read, so running it with query_only off cannot write.
    let exprs = null
    try {
      const probe = this.db.prepare(`SELECT * FROM (\n${body}\n) LIMIT 0`)
      // A subquery renames repeated names (a, a:1), so the copy reads the names it gives.
      exprs = probe.getColumnNames().map(quoteId)
      probe.free()
    } catch {
      return this.captureByStepping(body, columns)
    }
    return this.materialize({ from: `(\n${body}\n)`, exprs, columns, label: null, tiebreak: null, labelKind: 'position' }, {})
  }

  /** For statements no subquery can hold (PRAGMA, EXPLAIN): steps them, then copies the rows. */
  captureByStepping(body, columns) {
    this.readOnly()
    const rows = this.all(body)
    const table = `orca_result_${this.nextId}`
    const names = columns.map((_, index) => `c${index}`)
    this.writable(() => {
      this.db.run(`CREATE TEMP TABLE ${quoteId(table)} (label, ${names.join(', ')})`)
      const insert = this.db.prepare(`INSERT INTO temp.${quoteId(table)} VALUES (NULL, ${names.map(() => '?').join(', ')})`)
      try {
        // Why: a BigInt binds as text, which would make PRAGMA and EXPLAIN integers sort as text.
        for (const row of rows) insert.run(row.map((value) => (typeof value === 'bigint' && Number.isSafeInteger(Number(value)) ? Number(value) : value)))
      } finally {
        insert.free()
      }
    })
    return this.register({ kind: 'temp', table, exprs: names, columns, count: rows.length, labelKind: 'position' })
  }
}

const hasView = (view) =>
  Boolean(view.sort) || Boolean(String(view.search ?? '').trim()) || Object.values(view.filters ?? {}).some((text) => String(text ?? '').trim() !== '')
