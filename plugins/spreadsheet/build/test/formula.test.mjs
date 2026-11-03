import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CellError, evaluateFormula, parseFormula } from '../src/formula-eval.js'
import { excelToOdf, odfToExcel, shiftOdfFormula } from '../src/formula-odf.js'
import { shiftFormula, shiftSqref } from '../src/formula-shift.js'
import { toFileFormula, tokenize, untokenize } from '../src/formula-tokens.js'
import { cellFromInput, editText } from '../src/cell-input.js'

const insertRows = (at, count, sheet = 'Sheet1') => ({ sheet, axis: 'row', at, count })
const deleteRows = (at, count, sheet = 'Sheet1') => ({ sheet, axis: 'row', at, count: -count })
const insertColumns = (at, count, sheet = 'Sheet1') => ({ sheet, axis: 'column', at, count })

test('tokens round-trip formulas exactly', () => {
  for (const formula of [
    'SUM(A1:B2)+$C$3*2',
    "'My Sheet'!A1&\"x\"\"y\"",
    'IF(A1>=10,"big",LOG10(B1))',
    'Table1[[#This Row],[Cost]]*2',
    'SUM(A:A)+SUM(3:5)',
    '[1]Other!B2+Data!$A$1',
    '{1,2;3,4}',
    '_xlfn.CONCAT(A1, " ", B1)'
  ]) {
    assert.equal(untokenize(tokenize(formula)), formula)
  }
  assert.deepEqual(tokenize('LOG10(R2D2)').map((token) => token.type), ['func', 'paren', 'name', 'paren'])
})

test('row and column changes move references as Excel does', () => {
  assert.equal(shiftFormula('A1+A5+$A$9', 'Sheet1', insertRows(4, 2)), 'A1+A7+$A$11')
  assert.equal(shiftFormula('SUM(B2:B5)', 'Sheet1', insertRows(3, 1)), 'SUM(B2:B6)', 'an insert inside a range grows it')
  assert.equal(shiftFormula('SUM(B2:B5)', 'Sheet1', insertRows(5, 1)), 'SUM(B2:B5)', 'an insert just below leaves it')
  assert.equal(shiftFormula('SUM(B2:B5)', 'Sheet1', deleteRows(2, 2)), 'SUM(B2:B3)')
  assert.equal(shiftFormula('B3*2', 'Sheet1', deleteRows(2, 1)), '#REF!*2')
  assert.equal(shiftFormula('SUM(B3:B4)', 'Sheet1', deleteRows(1, 5)), 'SUM(#REF!)')
  assert.equal(shiftFormula('SUM(A:A)', 'Sheet1', insertRows(0, 3)), 'SUM(A:A)')
  assert.equal(shiftFormula('C1+Other!C1', 'Sheet1', insertColumns(1, 1)), 'D1+Other!C1')
  assert.equal(shiftFormula("'Sheet1'!C1+C1", 'Other', insertColumns(1, 1)), "'Sheet1'!D1+C1")
  assert.equal(shiftFormula('"A5"&A5', 'Sheet1', insertRows(0, 1)), '"A5"&A6', 'text is never a reference')
  assert.equal(shiftSqref('B2:B5 D7', insertRows(0, 1)), 'B3:B6 D8')
  assert.equal(shiftSqref('B2 D7', deleteRows(1, 1)), 'D6')
})

const resolver = (cells) => ({
  extent: () => ({ rows: 10, columns: 10 }),
  value: (sheet, r, c) => cells[`${sheet}!${r},${c}`] ?? null
})
const calc = (formula, cells = {}) => evaluateFormula(parseFormula(formula), 'S', resolver(cells))

test('calculates arithmetic, text, logic and common functions', () => {
  const cells = { 'S!0,0': 2, 'S!1,0': 3, 'S!2,0': 'x', 'S!3,0': true, 'T!0,0': 10 }
  assert.equal(calc('1+2*3^2-4/2'), 17)
  assert.equal(calc('-2^2'), 4)
  assert.equal(calc('50%*A1', cells), 1)
  assert.equal(calc('SUM(A1:A4)', cells), 5, 'text and booleans in ranges are skipped')
  assert.equal(calc('AVERAGE(A1:A2)+T!A1', cells), 12.5)
  assert.equal(calc('COUNT(A1:A4)&"/"&COUNTA(A1:A4)', cells), '2/4')
  assert.equal(calc('IF(A1>A2,"yes","no")', cells), 'no')
  assert.equal(calc('ROUND(2.675,2)'), 2.68)
  assert.equal(calc('CONCATENATE(UPPER("a"),LEN("abc"),TRUE)'), 'A3TRUE')
  assert.equal(calc('SUMIF(A1:A2,">2")', cells), 3)
  assert.equal(calc('COUNTIF(A1:A4,"x")', cells), 1)
  assert.equal(calc('IFERROR(1/0,"none")'), 'none')
  assert.ok(calc('1/0') instanceof CellError)
  assert.equal(calc('A1/0', cells).code, '#DIV/0!')
  assert.equal(calc('"a"="A"'), true)
  assert.throws(() => calc('VLOOKUP(1,A1:B2,2,FALSE)'), { name: 'Error' })
})

test('ODF formulas read in Excel spelling and back', () => {
  assert.equal(odfToExcel('of:=SUM([.B2:.B3])+[$Budget.$C$4]'), 'SUM(B2:B3)+Budget!$C$4')
  assert.equal(odfToExcel("of:=['My sheet'.A1];\"a;b\""), "'My sheet'!A1,\"a;b\"")
  assert.equal(excelToOdf("SUM(B2:B3,'My sheet'!A1)"), "of:=SUM([.B2:.B3];['My sheet'.A1])")
  assert.equal(shiftOdfFormula('of:=SUM([.B2:.B5])+[Other.B9]', 'Budget', { sheet: 'Budget', axis: 'row', at: 3, count: 1 }), 'of:=SUM([.B2:.B6])+[Other.B9]')
  assert.equal(shiftOdfFormula('of:=[$Budget.B4]', 'Summary', { sheet: 'Budget', axis: 'row', at: 3, count: -1 }), 'of:=[.#REF!]')
})

test('typed text becomes numbers, booleans, formulas or text', () => {
  assert.deepEqual(cellFromInput('1,234.5').cell.v, 1234.5)
  assert.deepEqual(cellFromInput('12%').cell.v, 0.12)
  assert.equal(cellFromInput('TRUE').cell.t, 'b')
  assert.equal(cellFromInput('=A1+1').cell.f, 'A1+1')
  assert.deepEqual(cellFromInput('=SUM(A1'), { error: 'invalid-formula' })
  assert.equal(cellFromInput("'=not a formula").cell.v, '=not a formula')
  assert.equal(cellFromInput('007x').cell.t, 's')
  assert.equal(cellFromInput('').cell, null)
  assert.equal(cellFromInput('12', { z: '"$"#,##0.00' }).cell.w, '$12.00', 'the cell keeps its number format')
  assert.equal(editText({ t: 's', v: '123' }), "'123", 'text that reads as a number keeps its apostrophe')
  assert.equal(editText({ t: 'n', v: 0.125, z: '0.0%' }), '12.5%')
  assert.equal(toFileFormula('CONCAT(A1,IFS(B1,1))+SUM(1)'), '_xlfn.CONCAT(A1,_xlfn.IFS(B1,1))+SUM(1)')
})
