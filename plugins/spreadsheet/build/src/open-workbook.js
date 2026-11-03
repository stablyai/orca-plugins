import { checkOfficeZipBudget } from './zip-budget.js'
import { readZip, storedZip } from './zip-archive.js'

// cellText keeps SheetJS's `.w`, so number and date formats read as Excel shows them; cellNF keeps
// each cell's format (`.z`) for values typed into it. cellStyles is on only because SheetJS reads
// column widths and row heights under it; fills and fonts go unused.
export const READ_OPTIONS = Object.freeze({
  type: 'array',
  dense: true,
  cellFormula: true,
  cellText: true,
  cellNF: true,
  cellHTML: false,
  cellStyles: true,
  cellDates: false,
  sheetStubs: false,
  bookVBA: false,
  bookDeps: false,
  bookFiles: false
})

/**
 * What the bytes look like before parsing. SheetJS reads almost anything as delimited text, so a
 * damaged file must be refused here, or it would open as one column of garbage.
 * @returns {'zip' | 'cfb' | 'biff' | 'markup' | 'unknown'}
 */
export function sniffContainer(bytes) {
  const at = (index) => (index < bytes.byteLength ? bytes[index] : -1)
  if (at(0) === 0x50 && at(1) === 0x4b && at(2) === 0x03 && at(3) === 0x04) return 'zip'
  if (at(0) === 0xd0 && at(1) === 0xcf && at(2) === 0x11 && at(3) === 0xe0) return 'cfb'
  // BIFF2-BIFF5 workbooks saved without a CFB container start with a BOF record.
  if (at(0) === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(at(1))) return 'biff'
  // Excel opens SpreadsheetML 2003 and HTML tables saved as .xls; so does SheetJS.
  let index = 0
  if (at(0) === 0xef && at(1) === 0xbb && at(2) === 0xbf) index = 3
  else if ((at(0) === 0xff && at(1) === 0xfe) || (at(0) === 0xfe && at(1) === 0xff)) index = 2
  while (index < bytes.byteLength && index < 4096 && (bytes[index] <= 0x20 || bytes[index] === 0)) index++
  if (at(index) === 0x3c) return 'markup'
  return 'unknown'
}

/** @returns {'encrypted' | 'corrupt'} */
export function classifyReadError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /password|encrypt/i.test(message) ? 'encrypted' : 'corrupt'
}

/**
 * Reads a workbook synchronously. `entries` is the inflated zip, for the writers; null for files
 * that are no zip.
 * @returns {{ status: 'ok', workbook: object, entries: import('./zip-archive.js').ZipEntry[] | null } |
 *   { status: 'encrypted' | 'corrupt' | 'too-large' }}
 */
export function openWorkbook(XLSX, bytes) {
  const container = sniffContainer(bytes)
  if (container === 'unknown') return { status: 'corrupt' }
  let entries = null
  if (container === 'zip') {
    const budget = checkOfficeZipBudget(bytes)
    if (budget !== 'ok') return { status: budget }
    // Why: declared sizes can lie, and SheetJS trusts them; only counted output bytes cap a bomb.
    const zip = readZip(bytes)
    if (zip.status !== 'ok') return { status: zip.status }
    entries = zip.entries
    bytes = storedZip(entries)
  }
  let workbook
  try {
    // A fresh copy each time: SheetJS writes its defaults into the options object.
    workbook = XLSX.read(bytes, { ...READ_OPTIONS })
  } catch (error) {
    return { status: classifyReadError(error) }
  }
  if (!workbook || !Array.isArray(workbook.SheetNames) || typeof workbook.Sheets !== 'object') {
    return { status: 'corrupt' }
  }
  return { status: 'ok', workbook, entries }
}
