// Writes the spreadsheets the tests open, using the bundled SheetJS.
// Usage: node scripts/make-fixtures.mjs [dir]   (default /private/tmp/xlsx-fixtures, or $SPREADSHEET_FIXTURES)
import * as XLSX from 'xlsx'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { styledOds, styledWorkbook } from './styled-fixture.mjs'

export const DEFAULT_FIXTURE_DIR = process.env.SPREADSHEET_FIXTURES ?? '/private/tmp/xlsx-fixtures'
export const DATA_ROWS = 50_000
const CURRENCY = '"$"#,##0.00'
const PERCENT = '0.0%'
const DATE = 'yyyy\\-mm\\-dd'
const REGIONS = ['North', 'South', 'East', 'West']
const CATEGORIES = ['Hardware', 'Software', 'Services', 'Support', 'Training']

const num = (v, z) => (z ? { t: 'n', v, z } : { t: 'n', v })
const str = (v) => ({ t: 's', v })
const formula = (f, v, z) => (typeof v === 'number' ? { t: 'n', v, f, ...(z ? { z } : {}) } : { t: typeof v === 'boolean' ? 'b' : 's', v, f })

function sheetFromRows(rows, extra = {}) {
  const ws = {}
  let maxColumn = 0
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell == null) return
      ws[XLSX.utils.encode_cell({ r, c })] = typeof cell === 'object' ? cell : typeof cell === 'number' ? num(cell) : str(cell)
      maxColumn = Math.max(maxColumn, c)
    })
  })
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: maxColumn } })
  return Object.assign(ws, extra)
}

function dataRows(count) {
  const rows = [['ID', 'Name', 'Category', 'Qty', 'Unit price', 'Total', 'Ordered', 'Discount', 'Region', 'Active', 'Score', 'Notes']]
  let qtySum = 0
  for (let i = 0; i < count; i++) {
    const r = i + 2
    const qty = (i * 7) % 97
    const price = Math.round(((i * 37) % 10_000) + 99) / 100
    qtySum += qty
    rows.push([
      i + 1,
      `Item ${String(i + 1).padStart(5, '0')}`,
      CATEGORIES[i % CATEGORIES.length],
      qty,
      num(price, CURRENCY),
      formula(`D${r}*E${r}`, Math.round(qty * price * 100) / 100, CURRENCY),
      num(45292 + (i % 730), DATE),
      num((i % 20) / 100, PERCENT),
      REGIONS[i % REGIONS.length],
      { t: 'b', v: i % 3 !== 0 },
      Math.round(((i * 13) % 1000) / 10 * 10) / 10,
      i % 50 === 0 ? `Check order ${i + 1}, see "notes"\tand follow up` : null
    ])
  }
  return { rows, qtySum }
}

function summarySheet(dataCount, qtySum) {
  const revenue = [125_000.5, 98_250.25, 143_900, 76_480.75]
  const cost = [80_000, 61_500.5, 99_000, 52_300.25]
  const totalRevenue = revenue.reduce((a, b) => a + b, 0)
  const rows = [
    ['Quarterly Summary'],
    ['Region', 'Revenue', 'Cost', 'Margin', 'Share', 'Updated'],
    ...REGIONS.map((region, i) => {
      const r = i + 3
      return [
        region,
        num(revenue[i], CURRENCY),
        num(cost[i], CURRENCY),
        formula(`B${r}-C${r}`, revenue[i] - cost[i], CURRENCY),
        formula(`B${r}/SUM($B$3:$B$6)`, revenue[i] / totalRevenue, PERCENT),
        num(45_658 + i * 7, DATE)
      ]
    }),
    [
      'Total',
      formula('SUM(B3:B6)', totalRevenue, CURRENCY),
      formula('SUM(C3:C6)', cost.reduce((a, b) => a + b, 0), CURRENCY),
      formula('SUM(D3:D6)', totalRevenue - cost.reduce((a, b) => a + b, 0), CURRENCY),
      formula('SUM(E3:E6)', 1, PERCENT)
    ],
    ['Data rows', formula('COUNTA(Data!A:A)-1', dataCount)],
    ['Units ordered', formula(`SUM(Data!D2:D${dataCount + 1})`, qtySum)],
    ['Bad ratio', { t: 'e', v: 7, f: 'B3/0' }],
    ['Audited', { t: 'b', v: true }],
    [],
    ['Notes', 'Revenue is recognised when an order ships; figures are in US dollars and exclude tax.'],
    [],
    []
  ]
  return sheetFromRows(rows, {
    '!merges': [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
      { s: { r: 12, c: 0 }, e: { r: 14, c: 0 } }
    ],
    '!cols': [{ wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 9 }, { wch: 12 }]
  })
}

function workbook(dataCount) {
  const { rows, qtySum } = dataRows(dataCount)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, summarySheet(dataCount, qtySum), 'Summary')
  XLSX.utils.book_append_sheet(wb, sheetFromRows(rows, { '!cols': [{ wch: 8 }] }), 'Data')
  XLSX.utils.book_append_sheet(wb, {}, 'Empty')
  XLSX.utils.book_append_sheet(wb, sheetFromRows([['secret']]), 'Lookup')
  wb.Workbook = { Sheets: [{}, {}, {}, { Hidden: 1 }] }
  return wb
}

/** A CFB container shaped like an Office-encrypted package (Agile encryption, no real payload). */
function encryptedWorkbook() {
  const cfb = XLSX.CFB.utils.cfb_new()
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption">' +
    '<keyData saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="AAAAAAAAAAAAAAAAAAAAAA=="/>' +
    '</encryption>'
  const info = Buffer.concat([Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]), Buffer.from(xml, 'utf8')])
  XLSX.CFB.utils.cfb_add(cfb, '/EncryptionInfo', info)
  XLSX.CFB.utils.cfb_add(cfb, '/EncryptedPackage', Buffer.alloc(4096, 7))
  return Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' }))
}

export function makeFixtures(dir = DEFAULT_FIXTURE_DIR) {
  mkdirSync(dir, { recursive: true })
  const write = (name, bytes) => writeFileSync(path.join(dir, name), bytes)
  const large = XLSX.write(workbook(DATA_ROWS), { type: 'buffer', bookType: 'xlsx', compression: true })
  write('multi-sheet.xlsx', large)
  const small = workbook(200)
  write('small.ods', XLSX.write(small, { type: 'buffer', bookType: 'ods', compression: true }))
  write('small.xls', XLSX.write(small, { type: 'buffer', bookType: 'biff8' }))
  write('small.xlsb', XLSX.write(small, { type: 'buffer', bookType: 'xlsb', compression: true }))
  // A truncated real file, so it still starts like a zip but has no central directory.
  write('corrupt.xlsx', Buffer.concat([large.subarray(0, 2048), Buffer.from('not the rest of the file')]))
  write('garbage.xlsx', Buffer.from('this is plain text, not a workbook\n1,2,3\n'))
  write('encrypted.xlsx', encryptedWorkbook())
  write('styled.xlsx', styledWorkbook())
  write('styled.xlsm', styledWorkbook({ macro: true }))
  write('styled.ods', styledOds())
  return dir
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`fixtures written to ${makeFixtures(process.argv[2])}`)
}
