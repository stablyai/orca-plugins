// One test per finding from the 2.0.0 review: each failed before its fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { strFromU8, unzipSync } from 'fflate'
import { styledOds } from '../scripts/styled-fixture.mjs'
import { cellFromInput } from '../src/cell-input.js'
import { createSource, mergeWorkbooks, modelOf, shiftBlocker, touchesLockedCell, writeWorkbook } from '../src/workbook-document.js'
import { applyOp } from '../src/workbook-edits.js'
import { findSheet } from '../src/workbook-model.js'

import { row, str, num, workbook, REL, MAIN } from './xlsx-fixture.mjs'

const people = (rows) => workbook([{ name: 'Sheet1', data: rows.map(([name, amount], i) => row(i + 1, str(`A${i + 1}`, name) + (amount === undefined ? '' : num(`B${i + 1}`, amount)))).join('') }])

function value(bytes) {
  return { source: createSource(bytes), ops: [] }
}
function edit(target, op) {
  applyOp(modelOf(target), op)
  target.ops.push(op)
  return op
}
const typed = (target, sheet, address, text) => {
  const { r, c } = XLSX.utils.decode_cell(address)
  return edit(target, { type: 'cells', sheet, cells: [{ r, c, cell: cellFromInput(text, findSheet(modelOf(target), sheet).data[r]?.[c]).cell }] })
}
const sheetXml = (bytes, n = 1) => strFromU8(unzipSync(bytes)[`xl/worksheets/sheet${n}.xml`])
const rows = (bytes) => XLSX.read(bytes, { dense: true }).Sheets.Sheet1['!data'].map((r) => r?.map((cell) => cell?.v))

test('P1: an outside row insert never lets this tab’s edits land on moved rows', () => {
  const original = people([['name'], ['alice', 10], ['bob', 20], ['carol', 30]])
  const base = value(original)
  const mine = value(original)
  typed(mine, 'Sheet1', 'B3', '25')
  edit(mine, { type: 'shift', sheet: 'Sheet1', axis: 'row', at: 3, count: -1 })
  const outside = value(people([['name'], ['zed', 99], ['alice', 10], ['bob', 20], ['carol', 30]]))
  const merged = mergeWorkbooks(base, outside, mine)
  assert.equal(merged.rejected.length, 2, 'both edits are set aside')
  assert.deepEqual(merged.ops, [])
  // A cell edit alone is refused too when the outside write moved rows.
  const cellsOnly = value(original)
  typed(cellsOnly, 'Sheet1', 'B3', '25')
  assert.equal(mergeWorkbooks(base, outside, cellsOnly).rejected.length, 1)
})

test('P1: a merge keeps disjoint cell edits and sets aside ones whose row or column changed outside', () => {
  const original = people([['name', 1], ['alice', 10], ['bob', 20]])
  const base = value(original)
  const mine = value(original)
  typed(mine, 'Sheet1', 'B3', '25')
  const outside = value(people([['Name', 1], ['alice', 10], ['bob', 20]]))
  const merged = mergeWorkbooks(base, outside, mine)
  assert.equal(merged.rejected, undefined)
  assert.deepEqual(rows(writeWorkbook(merged)), [['Name', 1], ['alice', 10], ['bob', 25]])
  const sameColumn = value(people([['name', 1], ['alice', 11], ['bob', 20]]))
  assert.equal(mergeWorkbooks(base, sameColumn, mine).rejected.length, 1, 'same column: set aside')
  const sameRow = value(people([['name', 1], ['alice', 10], ['bobby', 20]]))
  assert.equal(mergeWorkbooks(base, sameRow, mine).rejected.length, 1, 'same row: set aside, never overwritten')
})

test('P1: a formula typed before a row insert is shifted once when the log is replayed', () => {
  const original = people([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]])
  const mine = value(original)
  typed(mine, 'Sheet1', 'C1', '=B5')
  edit(mine, { type: 'shift', sheet: 'Sheet1', axis: 'row', at: 1, count: 1 })
  assert.equal(findSheet(modelOf(mine), 'Sheet1').data[0][2].f, 'B6')
  const replayed = { source: mine.source, ops: mine.ops }
  assert.equal(findSheet(modelOf(replayed), 'Sheet1').data[0][2].f, 'B6')
  assert.match(sheetXml(writeWorkbook(replayed)), /<c r="C1"><f>B6<\/f><v>5<\/v><\/c>/)
})

test('P1: sheets with pivot tables, linked comments, or a pivot source refuse row changes', () => {
  const pivotRel = `<Relationship Id="rId1" Type="${REL}/pivotTable" Target="../pivotTables/pivotTable1.xml"/>`
  const commentRel = `<Relationship Id="rId1" Type="${REL}/comments" Target="../comments1.xml"/>`
  const bytes = workbook(
    [{ name: 'Data', data: row(1, num('A1', 1)) }, { name: 'Pivot', data: row(1, num('A1', 1)), rels: pivotRel }, { name: 'Notes', data: row(1, num('A1', 1)), rels: commentRel }],
    {
      'xl/pivotTables/pivotTable1.xml': `<pivotTableDefinition xmlns="${MAIN}"><location ref="A3:B7"/></pivotTableDefinition>`,
      'xl/pivotCache/pivotCacheDefinition1.xml': `<pivotCacheDefinition xmlns="${MAIN}"><cacheSource type="worksheet"><worksheetSource ref="A1:B9" sheet="Data"/></cacheSource></pivotCacheDefinition>`
    }
  )
  const target = value(bytes)
  const blocker = (name) => shiftBlocker(target.source, findSheet(modelOf(target), name), 'row', { at: 0, count: 1 })
  assert.equal(blocker('Pivot'), 'a pivot table')
  assert.equal(blocker('Notes'), 'comments or notes')
  assert.equal(blocker('Data'), 'a pivot table that reads this sheet')
})

test('P2: array formulas and functions it cannot calculate are saved without a guessed result', () => {
  const data =
    row(1, num('A1', 1) + num('B1', 2) + `<c r="C1" cm="1"><f t="array" ref="C1">SUM(A1:A2*B1:B2)</f><v>11</v></c>`) +
    row(2, num('A2', 3) + num('B2', 3) + `<c r="C2"><f>VLOOKUP(A1,A1:B2,2,FALSE)</f><v>2</v></c>`)
  const target = value(workbook([{ name: 'Sheet1', data }]))
  typed(target, 'Sheet1', 'A1', '5')
  const xml = sheetXml(writeWorkbook(target))
  assert.match(xml, /<c r="C1" cm="1"><f t="array" ref="C1">SUM\(A1:A2\*B1:B2\)<\/f><\/c>/, 'no #VALUE!, and cm kept')
  assert.match(xml, /<c r="C2"><f>VLOOKUP\(A1,A1:B2,2,FALSE\)<\/f><\/c>/)
  const sheet = findSheet(modelOf(target), 'Sheet1')
  assert.equal(sheet.data[0][2].v, 11, 'the editor keeps showing the saved result, marked stale')
  assert.equal(sheet.data[0][2].$stale, true)
})

test('P2: dynamic-array metadata survives a row insert elsewhere', () => {
  const data = row(1, `<c r="A1" cm="1"><f t="array" ref="A1:A4">_xlfn.SEQUENCE(4)</f><v>1</v></c>`) + row(9, num('B9', 1))
  const target = value(workbook([{ name: 'Sheet1', data }]))
  edit(target, { type: 'shift', sheet: 'Sheet1', axis: 'row', at: 8, count: 1 })
  assert.match(sheetXml(writeWorkbook(target)), /<c r="A1" cm="1"><f t="array" ref="A1:A4">/)
})

test('P2: .ods formulas it cannot calculate lose their stale result, so they are computed on open', () => {
  const target = value(styledOds())
  typed(target, 'Budget', 'C6', '=VLOOKUP(B3,A2:B3,2,FALSE)')
  typed(target, 'Budget', 'B3', '450')
  const content = strFromU8(unzipSync(writeWorkbook(target))['content.xml'])
  const cell = /<table:table-cell[^>]*table:formula="of:=VLOOKUP[^"]*"[^>]*>/.exec(content)[0]
  assert.doesNotMatch(cell, /office:value=/)
})

test('P2: semicolons between arguments are saved as commas', () => {
  const target = value(people([['a', 1], ['b', 2]]))
  typed(target, 'Sheet1', 'C1', '=SUM(B1;B2)')
  assert.equal(findSheet(modelOf(target), 'Sheet1').data[0][2].f, 'SUM(B1,B2)')
  assert.match(sheetXml(writeWorkbook(target)), /<f>SUM\(B1,B2\)<\/f><v>3<\/v>/)
})

test('P2: a table’s header and totals rows cannot be edited', () => {
  const tableRel = `<Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/>`
  const bytes = workbook([{ name: 'Sheet1', data: row(1, str('A1', 'Name')) + row(2, str('A2', 'x')), rels: tableRel }], {
    'xl/tables/table1.xml': `<table xmlns="${MAIN}" id="1" name="T" ref="A1:B4" totalsRowCount="1"><tableColumns count="2"><tableColumn id="1" name="Name"/><tableColumn id="2" name="B"/></tableColumns></table>`
  })
  const { source } = value(bytes)
  assert.equal(touchesLockedCell(source, 'Sheet1', [{ r: 0, c: 1 }]), true, 'header')
  assert.equal(touchesLockedCell(source, 'Sheet1', [{ r: 3, c: 0 }]), true, 'totals')
  assert.equal(touchesLockedCell(source, 'Sheet1', [{ r: 1, c: 0 }, { r: 2, c: 1 }]), false, 'body')
})

test('P2: sparklines on another sheet that read this one stop its row changes', () => {
  const sparklines = `<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}"><x14:sparklineGroups><x14:sparklineGroup><x14:sparklines><x14:sparkline><xm:f>Data!A2:A13</xm:f><xm:sqref>B1</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext></extLst>`
  const target = value(workbook([{ name: 'Data', data: row(1, num('A1', 1)) }, { name: 'Summary', data: row(1, num('A1', 1)), after: sparklines }]))
  const model = modelOf(target)
  assert.equal(shiftBlocker(target.source, findSheet(model, 'Data'), 'row', { at: 0, count: 1 }), 'sparklines or rules on another sheet that read this one')
})

test('P3: an internal hyperlink follows the row it points at', () => {
  const links = `<hyperlinks><hyperlink ref="A1" location="Sheet1!A4" display="go"/></hyperlinks>`
  const target = value(workbook([{ name: 'Sheet1', data: row(1, str('A1', 'go')) + row(4, num('A4', 1)), after: links }]))
  edit(target, { type: 'shift', sheet: 'Sheet1', axis: 'row', at: 1, count: 1 })
  assert.match(sheetXml(writeWorkbook(target)), /<hyperlink ref="A1" location="Sheet1!A5" display="go"\/>/)
})

test('re-review #17: no saved result survives a row change; position-dependent ones are right or dropped', () => {
  const formulas =
    `<c r="A8"><f>COUNTBLANK(A1:A5)</f><v>0</v></c><c r="B8"><f>MATCH("c",A1:A5,0)</f><v>4</v></c>` +
    `<c r="C8"><f>ROW(A5)</f><v>5</v></c><c r="D8"><f>ROWS(A1:A5)</f><v>5</v></c><c r="E8"><f>SUM(F1:F2)</f><v>3</v></c>`
  const data = ['x', 'a', 'b', 'c', 'd'].map((v, i) => row(i + 1, str(`A${i + 1}`, v))).join('') + row(8, formulas)
  const target = value(workbook([{ name: 'Sheet1', data }]))
  edit(target, { type: 'shift', sheet: 'Sheet1', axis: 'row', at: 2, count: 1 })
  const xml = sheetXml(writeWorkbook(target))
  assert.match(xml, /<c r="A9"><f>COUNTBLANK\(A1:A6\)<\/f><v>1<\/v><\/c>/, 'calculated: the inserted blank counts')
  assert.match(xml, /<c r="B9"><f>MATCH\(&quot;c&quot;,A1:A6,0\)<\/f><\/c>/, 'not calculated: no stale result')
  assert.match(xml, /<c r="C9"><f>ROW\(A6\)<\/f><\/c>/)
  assert.match(xml, /<c r="D9"><f>ROWS\(A1:A6\)<\/f><\/c>/)
  assert.match(xml, /<c r="E9"><f>SUM\(F1:F2\)<\/f><v>0<\/v><\/c>/, 'even untouched references are recalculated')
  assert.match(strFromU8(unzipSync(writeWorkbook(target))['xl/workbook.xml']), /fullCalcOnLoad="1"/)
})

test('re-review #17: .ods formulas it cannot calculate lose their result after a row change', () => {
  const target = value(styledOds())
  typed(target, 'Budget', 'D2', '=ROW(B3)')
  const before = strFromU8(unzipSync(writeWorkbook(target))['content.xml'])
  assert.doesNotMatch(/<table:table-cell[^>]*of:=ROW[^>]*>/.exec(before)[0], /office:value=/)
  edit(target, { type: 'shift', sheet: 'Budget', axis: 'row', at: 1, count: 1 })
  const content = strFromU8(unzipSync(writeWorkbook(target))['content.xml'])
  assert.doesNotMatch(/<table:table-cell[^>]*of:=ROW\(\[\.B4\]\)[^>]*>/.exec(content)[0], /office:value=/)
  assert.match(content, /table:formula="of:=SUM\(\[\.B3:\.B4\]\)" office:value-type="float" office:value="1500"/)
})

test('re-review P3: an outside write that makes an edited cell a table header refuses the merge', () => {
  const original = workbook([{ name: 'Sheet1', data: row(1, str('A1', 'Name')) + row(2, str('A2', 'x')) }])
  const tableRel = `<Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/>`
  const outside = value(workbook([{ name: 'Sheet1', data: row(1, str('A1', 'Name')) + row(2, str('A2', 'x')), rels: tableRel }], {
    'xl/tables/table1.xml': `<table xmlns="${MAIN}" id="1" name="T" ref="A1:A2"><tableColumns count="1"><tableColumn id="1" name="Name"/></tableColumns></table>`
  }))
  const mine = value(original)
  typed(mine, 'Sheet1', 'A1', 'Who')
  assert.equal(mergeWorkbooks(value(original), outside, mine).rejected.length, 1)
})

test('re-review P3: a merge is refused when a formula this tab typed reads cells that moved', () => {
  const rowsOf = (values) => workbook([{ name: 'Sheet1', data: values.map((v, i) => row(i + 1, num(`A${i + 1}`, v))).join('') }])
  const original = rowsOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const base = value(original)
  const mine = value(original)
  typed(mine, 'Sheet1', 'B1', '=A10')
  // Outside: a row inserted at 5 and the last dropped, so the size is the same and row 1 untouched.
  const outside = value(rowsOf([1, 2, 3, 4, 0, 5, 6, 7, 8, 9]))
  assert.equal(mergeWorkbooks(base, outside, mine).rejected.length, 1)
})
