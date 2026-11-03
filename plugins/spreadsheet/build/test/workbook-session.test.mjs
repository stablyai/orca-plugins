// The workbook codec (src/workbook-document.js) against Orca's real frame session, through
// `mockEditorHost` from orca/testing (vendored in ./orca-testing; see README.md).
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as XLSX from 'xlsx'
import { mockEditorHost } from './orca-testing/orca-testing.mjs'
import { styledWorkbook } from '../scripts/styled-fixture.mjs'
import { cellFromInput } from '../src/cell-input.js'
import { createWorkbookCodec, modelOf } from '../src/workbook-document.js'
import { applyOp } from '../src/workbook-edits.js'
import { findSheet } from '../src/workbook-model.js'

let host
afterEach(() => host?.dispose())

async function open(bytes) {
  host = mockEditorHost({ bytes }, { fileType: 'xlsx', readOnly: false })
  const doc = await globalThis.orca.document.session(createWorkbookCodec())
  return doc
}

/** What the editor does for one typed cell: apply to the live model, then hand Orca the new value. */
function type(doc, sheet, address, text) {
  const value = doc.value
  const model = modelOf(value)
  const { r, c } = XLSX.utils.decode_cell(address)
  const op = { type: 'cells', sheet, cells: [{ r, c, cell: cellFromInput(text, findSheet(model, sheet).data[r]?.[c]).cell }] }
  applyOp(model, op)
  doc.change({ source: value.source, ops: [...value.ops, op], model })
}

const saved = (bytes, sheet, address) => {
  const wb = XLSX.read(bytes, { dense: true, cellFormula: true })
  const { r, c } = XLSX.utils.decode_cell(address)
  return wb.Sheets[sheet]['!data'][r]?.[c]?.v
}

function workbookWith(rows) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1')
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }))
}

test('opening sends nothing; an edit is saved into the file', async () => {
  const doc = await open(styledWorkbook())
  await host.flush()
  assert.equal(host.edits.length, 0)
  type(doc, 'Budget', 'B2', '1500')
  await host.flush()
  assert.equal(host.edits.length, 1)
  assert.equal(saved(host.bytes, 'Budget', 'B2'), 1500)
  assert.equal(saved(host.bytes, 'Budget', 'B6'), 1900)
})

test('an outside write keeps this tab’s edits and the cells it did not touch', async () => {
  const doc = await open(workbookWith([['a', 1], ['b', 2]]))
  // An agent changes A2 while this tab changes B1; Orca refuses the tab's edit with a conflict.
  host.conflictNext(workbookWith([['a', 1], ['agent', 2]]))
  type(doc, 'Sheet1', 'B1', '100')
  await host.flush()
  assert.deepEqual(host.edits.map((edit) => edit.refused ?? 'ok'), ['conflict', 'ok'])
  assert.equal(saved(host.bytes, 'Sheet1', 'A2'), 'agent')
  assert.equal(saved(host.bytes, 'Sheet1', 'B1'), 100)
})

test('edits accepted before a conflict are not replayed twice', async () => {
  const doc = await open(workbookWith([[1], [2], [3]]))
  const model = modelOf(doc.value)
  const insert = { type: 'shift', sheet: 'Sheet1', axis: 'row', at: 0, count: 1 }
  applyOp(model, insert)
  doc.change({ source: doc.value.source, ops: [insert], model })
  await host.flush()
  assert.equal(saved(host.bytes, 'Sheet1', 'A2'), 1)
  host.conflictNext(host.bytes)
  type(doc, 'Sheet1', 'B1', 'x')
  await host.flush()
  assert.equal(saved(host.bytes, 'Sheet1', 'A1'), undefined)
  assert.equal(saved(host.bytes, 'Sheet1', 'A2'), 1, 'one inserted row, not two')
  assert.equal(saved(host.bytes, 'Sheet1', 'B1'), 'x')
})

test('an outside change with nothing unsent replaces the workbook', async () => {
  const doc = await open(workbookWith([['old']]))
  const replaced = []
  doc.onReplace((value) => replaced.push(findSheet(modelOf(value), 'Sheet1').data[0][0].v))
  host.replace(workbookWith([['new']]))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(replaced, ['new'])
})

test('the codec saves the original bytes when nothing is left to apply', () => {
  const bytes = styledWorkbook()
  const codec = createWorkbookCodec()
  const value = codec.decode({ kind: 'bytes', bytes: bytes.slice().buffer })
  assert.deepEqual(new Uint8Array(codec.encode(value).bytes), bytes)
})
