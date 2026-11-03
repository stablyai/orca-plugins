// The worker that owns the database, so a long query never freezes the editor. It answers
// `{ id, op, args }` with `{ id, ok, value }` or `{ id, ok: false, error }`.
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js'
import { SqliteEngine } from './sqlite-engine.js'

// build.mjs copies the WebAssembly next to this file as sql-wasm.wasm.
const ready = initSqlJs({ locateFile: () => new URL('./sql-wasm.wasm', import.meta.url).href })
let engine = null

const ops = {
  async open(bytes) {
    engine?.close()
    engine = null
    engine = new SqliteEngine(await ready, bytes)
    return { info: engine.info, objects: engine.objects }
  },
  openObject: (name, view) => engine.openObject(name, view),
  reopen: (id, view) => engine.reopen(id, view),
  closeResult: (id) => engine.closeResult(id),
  rows: (id, start, count) => engine.rows(id, start, count),
  cell: (id, index, column) => engine.cell(id, index, column),
  copy: (...args) => engine.copy(...args),
  csv: (id, maxBytes) => engine.csv(id, maxBytes),
  run(sql) {
    const started = performance.now()
    const ran = engine.run(sql)
    return { ...ran, ms: performance.now() - started }
  }
}

self.addEventListener('message', async (event) => {
  const { id, op, args } = event.data
  try {
    const value = await ops[op](...args)
    self.postMessage({ id, ok: true, value }, value instanceof ArrayBuffer ? [value] : [])
  } catch (error) {
    self.postMessage({ id, ok: false, error: { message: error.message, kind: error.kind ?? 'error', statement: error.statement } })
  }
})
