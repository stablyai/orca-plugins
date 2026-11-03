// Saving edits into the file's own XML: what changes, and that everything else keeps its bytes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { strFromU8, unzipSync } from 'fflate'
import { styledOds, styledWorkbook } from '../scripts/styled-fixture.mjs'
import { cellFromInput } from '../src/cell-input.js'
import { createSource, modelOf, shiftBlocker, writeWorkbook } from '../src/workbook-document.js'
import { applyOp } from '../src/workbook-edits.js'
import { findSheet } from '../src/workbook-model.js'

function editor(bytes, fileType) {
  const value = { source: createSource(bytes, fileType), ops: [] }
  const model = modelOf(value)
  const run = (op) => {
    const inverse = applyOp(model, op)
    value.ops.push(op)
    return inverse
  }
  return {
    value,
    model,
    run,
    type(sheet, address, text) {
      const { r, c } = XLSX.utils.decode_cell(address)
      return run({ type: 'cells', sheet, cells: [{ r, c, cell: cellFromInput(text, findSheet(model, sheet).data[r]?.[c]).cell }] })
    },
    save: () => writeWorkbook(value)
  }
}

const read = (bytes) => XLSX.read(bytes, { dense: true, cellFormula: true, cellNF: true })
const cell = (wb, sheet, address) => {
  const { r, c } = XLSX.utils.decode_cell(address)
  return wb.Sheets[sheet]['!data'][r]?.[c]
}
const part = (bytes, name) => strFromU8(unzipSync(bytes)[name])

test('xlsx: a value edit rewrites only that sheet and keeps the cell style', () => {
  const original = styledWorkbook()
  const e = editor(original, 'xlsx')
  e.type('Budget', 'B3', '500')
  e.type('Budget', 'A5', 'Internet')
  const saved = e.save()
  const before = unzipSync(original)
  const after = unzipSync(saved)
  for (const name of ['xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet3.xml', 'xl/drawings/drawing1.xml', '_rels/.rels']) {
    assert.deepEqual(after[name], before[name], `${name} keeps its bytes`)
  }
  assert.equal(after['xl/calcChain.xml'], undefined, 'the stale calculation chain is dropped')
  assert.doesNotMatch(part(saved, 'xl/_rels/workbook.xml.rels'), /calcChain/)
  assert.doesNotMatch(part(saved, '[Content_Types].xml'), /calcChain/)
  assert.match(part(saved, 'xl/workbook.xml'), /<calcPr calcId="191029" fullCalcOnLoad="1"\/>/)
  const sheet = part(saved, 'xl/worksheets/sheet1.xml')
  assert.match(sheet, /<c r="B3" s="2"><v>500<\/v><\/c>/)
  assert.match(sheet, /<c r="A5" t="inlineStr"><is><t xml:space="preserve">Internet<\/t><\/is><\/c>/)
  const wb = read(saved)
  assert.equal(cell(wb, 'Budget', 'B3').w, '$500.00')
  assert.equal(cell(wb, 'Budget', 'C3').v, 1000, 'shared formulas are written out and recalculated')
  assert.equal(cell(wb, 'Budget', 'C3').f, 'B3*2')
  assert.equal(cell(wb, 'Budget', 'B6').v, 1800)
  assert.equal(cell(wb, 'Notes and totals', 'B1').v, 1800, 'formulas on other sheets follow')
  assert.deepEqual(wb.Sheets.Budget['!merges'], [{ s: { r: 7, c: 0 }, e: { r: 7, c: 3 } }])
})

test('xlsx: inserting and deleting rows moves formulas, merges, formats, validation and names', () => {
  const e = editor(styledWorkbook(), 'xlsx')
  assert.equal(shiftBlocker(e.value.source, findSheet(e.model, 'Budget'), 'row', { at: 2, count: 1 }), null)
  e.run({ type: 'shift', sheet: 'Budget', axis: 'row', at: 2, count: 2 })
  e.run({ type: 'shift', sheet: 'Budget', axis: 'column', at: 0, count: -1 })
  const saved = e.save()
  const sheet = part(saved, 'xl/worksheets/sheet1.xml')
  assert.match(sheet, /<mergeCell ref="A10:C10"\/>/)
  assert.match(sheet, /<conditionalFormatting sqref="A2:A7"><cfRule[^>]*><formula>\$A\$8\/2<\/formula>/)
  assert.match(sheet, /<dataValidation [^>]*sqref="A2:A7">/)
  assert.match(sheet, /<col min="1" max="2" width="12" customWidth="1"\/>/)
  assert.match(sheet, /<selection activeCell="A5" sqref="A5"\/>/)
  assert.match(part(saved, 'xl/workbook.xml'), /<definedName name="Spend">Budget!\$A\$2:\$A\$7<\/definedName>/)
  const wb = read(saved)
  assert.equal(cell(wb, 'Budget', 'A8').f, 'SUM(A2:A7)')
  assert.equal(cell(wb, 'Budget', 'B5').f, 'A5*2')
  assert.equal(cell(wb, 'Budget', 'A1').v, 'Cost')
  assert.equal(cell(wb, 'Notes and totals', 'B1').f, 'Budget!A8')
  assert.equal(cell(wb, 'Notes and totals', 'B2').f, 'SUM(Budget!B2:B2)')
})

test('xlsx: undo restores the file exactly, and an undone delete keeps the cells it brought back', () => {
  const original = styledWorkbook()
  const e = editor(original, 'xlsx')
  const inverse = e.run({ type: 'shift', sheet: 'Budget', axis: 'row', at: 1, count: -1 })
  assert.equal(findSheet(e.model, 'Budget').data[1][0].v, 'Power')
  e.run(inverse)
  const wb = read(e.save())
  assert.equal(cell(wb, 'Budget', 'A2').v, 'Rent')
  assert.equal(cell(wb, 'Budget', 'B2').w, '$1,200.00', 'restored cells keep their style')
  assert.equal(cell(wb, 'Budget', 'B6').f, 'SUM(B2:B5)')
  assert.equal(cell(wb, 'Budget', 'D3').f, 'B3/$B$6')
})

test('xlsx: sheets with drawings refuse row changes; macros survive an edit', () => {
  const e = editor(styledWorkbook({ macro: true }), 'xlsm')
  assert.equal(shiftBlocker(e.value.source, findSheet(e.model, 'Picture'), 'row', { at: 0, count: 1 }), 'charts, pictures or shapes')
  e.type('Picture', 'A2', 'still here')
  const saved = e.save()
  assert.deepEqual(unzipSync(saved)['xl/vbaProject.bin'], unzipSync(styledWorkbook({ macro: true }))['xl/vbaProject.bin'])
  assert.match(part(saved, 'xl/worksheets/sheet3.xml'), /<drawing r:id="rId1"\/>/)
  assert.equal(cell(read(saved), 'Picture', 'A2').v, 'still here')
})

test('ods: edits keep styles, notes and the rest of the package', () => {
  const original = styledOds()
  const e = editor(original, 'ods')
  assert.equal(findSheet(e.model, 'Budget').data[3][1].f, 'SUM(B2:B3)')
  e.type('Budget', 'B3', '500')
  e.type('Budget', 'A5', 'Internet')
  e.type('Budget', 'B5', '=B4/10')
  const saved = e.save()
  const before = unzipSync(original)
  const after = unzipSync(saved)
  for (const name of ['mimetype', 'styles.xml', 'META-INF/manifest.xml']) assert.deepEqual(after[name], before[name])
  assert.equal(Object.keys(after)[0], 'mimetype', 'mimetype stays first')
  const content = part(saved, 'content.xml')
  assert.match(content, /<table:table-cell office:value-type="float" office:value="500" calcext:value-type="float"><text:p>500<\/text:p><\/table:table-cell>/)
  assert.match(content, /table:formula="of:=\[\.B4\]\/10" office:value-type="float" office:value="170"/)
  assert.match(content, /table:formula="of:=SUM\(\[\.B2:\.B3\]\)" office:value-type="float" office:value="1700"/)
  assert.match(content, /<text:p>Merged note<\/text:p><office:annotation>/)
  const wb = read(saved)
  assert.equal(cell(wb, 'Budget', 'A5').v, 'Internet')
  assert.equal(cell(wb, 'Summary', 'B1').v, 1700)
})

test('ods: rows and columns move references and keep the sheet within its limits', () => {
  const e = editor(styledOds(), 'ods')
  const budget = findSheet(e.model, 'Budget')
  assert.equal(shiftBlocker(e.value.source, budget, 'column', { at: 1, count: 1 }), 'merged cells')
  assert.equal(shiftBlocker(e.value.source, budget, 'row', { at: 2, count: 1 }), null)
  e.run({ type: 'shift', sheet: 'Budget', axis: 'row', at: 2, count: 1 })
  e.run({ type: 'shift', sheet: 'Budget', axis: 'column', at: 3, count: 2 })
  const content = part(e.save(), 'content.xml')
  assert.match(content, /table:formula="of:=SUM\(\[\.B2:\.B4\]\)"/)
  assert.match(content, /table:formula="of:=\[\$Budget\.B5\]"/)
  assert.match(content, /table:cell-range-address="\$Budget\.\$B\$2:\.\$B\$4"/)
  const budgetTable = content.slice(content.indexOf('table:name="Budget"'), content.indexOf('table:name="Summary"'))
  const rows = [...budgetTable.matchAll(/number-rows-repeated="(\d+)"/g)].map((m) => Number(m[1]))
  const plainRows = (budgetTable.match(/<table:table-row\b/g) ?? []).length - rows.length
  assert.equal(rows.reduce((a, b) => a + b, 0) + plainRows, 1_048_576, 'still exactly the row limit')
  assert.match(budgetTable, /<table:table-column table:style-name="co1" table:number-columns-repeated="1023"/)
})
