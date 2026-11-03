// Column filters, search and sort as SQL (src/result-query.js), and how values read (src/value-format.js).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { containsPattern, orderClause, parseFilter, quoteId, whereClause } from '../src/result-query.js'
import { cellText, formatReal, toClipboard } from '../src/value-format.js'

test('a column filter reads as contains, a comparison or a NULL test', () => {
  assert.equal(parseFilter('  '), null)
  assert.deepEqual(parseFilter('blue'), { op: 'contains', value: 'blue' })
  assert.deepEqual(parseFilter('>= 10'), { op: '>=', value: 10 })
  assert.deepEqual(parseFilter('<>x'), { op: '!=', value: 'x' })
  assert.deepEqual(parseFilter('=2024-01-01'), { op: '=', value: '2024-01-01' })
  assert.deepEqual(parseFilter('NULL'), { op: 'null' })
  assert.deepEqual(parseFilter('!null'), { op: 'notnull' })
  // A lone operator is text to look for.
  assert.deepEqual(parseFilter('>'), { op: 'contains', value: '>' })
})

test('filters and search become one WHERE clause with bound values', () => {
  const exprs = ['"a"', '"b"']
  assert.deepEqual(whereClause(exprs, {}, ''), { sql: '', params: [] })
  const { sql, params } = whereClause(exprs, { 1: '>3' }, '50%')
  assert.equal(sql, `WHERE "b" > ? AND ((typeof("a") <> 'blob' AND CAST("a" AS TEXT) LIKE ? ESCAPE '\\') OR (typeof("b") <> 'blob' AND CAST("b" AS TEXT) LIKE ? ESCAPE '\\'))`)
  assert.deepEqual(params, [3, '%50\\%%', '%50\\%%'])
  assert.equal(containsPattern('a_b\\'), '%a\\_b\\\\%')
})

test('sorting keeps file order among equal values', () => {
  assert.equal(orderClause(['"a"'], null, 'rowid'), '')
  assert.equal(orderClause(['"a"'], { column: 0, descending: true }, 'rowid'), 'ORDER BY "a" DESC, rowid')
  assert.equal(quoteId('say "hi"'), '"say ""hi"""')
})

test('values read as sqlite3 prints them', () => {
  assert.equal(formatReal(1), '1.0')
  assert.equal(formatReal(0.1), '0.1')
  assert.equal(formatReal(1e20), '1.0e+20')
  assert.equal(cellText({ t: 'integer', v: 9007199254740993n }), '9007199254740993')
  assert.equal(cellText({ t: 'blob', v: new Uint8Array([0, 171]) }), '00AB')
  assert.equal(cellText({ t: 'null', v: null }), '')
  assert.equal(toClipboard([[{ t: 'text', v: 'a\tb' }]]), 'a\tb', 'one cell copies as it is')
  assert.equal(toClipboard([[{ t: 'text', v: 'a\tb' }, { t: 'null', v: null }]], ['x', 'y']), 'x\ty\n"a\tb"\t')
})
