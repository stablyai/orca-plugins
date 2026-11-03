import { cellText, isEmptyCell } from './cell-display.js'
import { createMergeIndex } from './merge-index.js'

export const MIN_AUTO_COLUMN_WIDTH = 56
export const MAX_AUTO_COLUMN_WIDTH = 360
export const DEFAULT_ROW_HEIGHT = 22
const CELL_PADDING_X = 16
const SAMPLE_HEAD_ROWS = 200
const SAMPLE_SPREAD_ROWS = 100

/** @typedef {{ s: { r: number, c: number }, e: { r: number, c: number } }} Merge */

/**
 * The workbook's sheets: `all` in workbook order, and `sheets`, the ones a person sees. Hidden and
 * very hidden sheets are left out of `sheets`; `hiddenCount` says how many. Edits change these
 * models in place (workbook-edits.js).
 */
export function buildWorkbookModel(workbook) {
  const meta = workbook.Workbook?.Sheets ?? []
  const all = []
  const sheets = []
  let hiddenCount = 0
  workbook.SheetNames.forEach((name, index) => {
    const worksheet = workbook.Sheets[name]
    if (!worksheet) return
    const sheet = buildSheetModel(name, worksheet)
    all.push(sheet)
    if (meta[index]?.Hidden) {
      sheet.hidden = true
      hiddenCount++
      return
    }
    sheets.push(sheet)
  })
  return { all, sheets, hiddenCount }
}

export function findSheet(model, name) {
  const key = name.toUpperCase()
  return model.all.find((sheet) => sheet.name.toUpperCase() === key) ?? null
}

export function buildSheetModel(name, worksheet) {
  const kind = worksheet['!type'] === 'chart' ? 'chart' : worksheet['!type'] === 'macro' || worksheet['!type'] === 'dialog' ? 'other' : 'worksheet'
  const data = denseRows(worksheet)
  const merges = (worksheet['!merges'] ?? []).filter(isValidMerge)
  let rowCount = 0
  let columnCount = 0
  const sheet = {
    name,
    kind,
    data,
    rowCount: 0,
    columnCount: 0,
    merges,
    columnInfo: worksheet['!cols'] ?? [],
    rowInfo: worksheet['!rows'] ?? []
  }
  measureExtent(sheet)
  return sheet
}

/** Sets `rowCount` and `columnCount` to the used extent: the last non-empty cell or merge. */
export function measureExtent(sheet) {
  const { data } = sheet
  let rowCount = 0
  let columnCount = 0
  for (let r = data.length - 1; r >= 0; r--) {
    const row = data[r]
    if (!row) continue
    for (let c = row.length - 1; c >= 0; c--) {
      if (isEmptyCell(row[c])) continue
      if (rowCount === 0) rowCount = r + 1
      if (c + 1 > columnCount) columnCount = c + 1
      break
    }
  }
  for (const merge of sheet.merges) {
    rowCount = Math.max(rowCount, merge.e.r + 1)
    columnCount = Math.max(columnCount, merge.e.c + 1)
  }
  sheet.rowCount = rowCount
  sheet.columnCount = columnCount
}

export function getCell(sheet, row, column) {
  return sheet.data[row]?.[column]
}

function isValidMerge(merge) {
  return (
    merge && merge.s && merge.e &&
    Number.isInteger(merge.s.r) && Number.isInteger(merge.s.c) &&
    Number.isInteger(merge.e.r) && Number.isInteger(merge.e.c) &&
    merge.s.r >= 0 && merge.s.c >= 0 && merge.e.r >= merge.s.r && merge.e.c >= merge.s.c &&
    (merge.e.r > merge.s.r || merge.e.c > merge.s.c)
  )
}

// Why: `dense: true` stores rows in `!data`; a sparse sheet (some parsers ignore `dense`) is
// converted once so every later lookup is two array reads.
function denseRows(worksheet) {
  if (Array.isArray(worksheet['!data'])) return worksheet['!data']
  const rows = []
  for (const key of Object.keys(worksheet)) {
    if (key[0] === '!') continue
    const match = /^([A-Z]+)(\d+)$/.exec(key)
    if (!match) continue
    let column = 0
    for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64
    const row = Number(match[2]) - 1
    ;(rows[row] ??= [])[column - 1] = worksheet[key]
  }
  return rows
}

/** Excel's column width in pixels from `!cols`, or null when the file leaves it to the default. */
export function declaredColumnWidth(info) {
  if (!info) return null
  if (info.hidden) return 0
  if (Number.isFinite(info.wpx)) return Math.round(info.wpx)
  if (Number.isFinite(info.wch)) return Math.round(info.wch * 7 + 5)
  if (Number.isFinite(info.width)) return Math.round(info.width * 7)
  return null
}

/** Row height in pixels from `!rows`, or null for the default. */
export function declaredRowHeight(info) {
  if (!info) return null
  if (info.hidden) return 0
  if (Number.isFinite(info.hpx)) return Math.round(info.hpx)
  if (Number.isFinite(info.hpt)) return Math.round((info.hpt * 4) / 3)
  return null
}

/** Rows read to size columns: the first few hundred, then an even spread over the rest. */
export function sampleRowIndexes(rowCount) {
  const rows = []
  const head = Math.min(rowCount, SAMPLE_HEAD_ROWS)
  for (let r = 0; r < head; r++) rows.push(r)
  if (rowCount > head) {
    const step = (rowCount - head) / SAMPLE_SPREAD_ROWS
    for (let index = 0; index < SAMPLE_SPREAD_ROWS; index++) {
      const r = head + Math.floor(index * step)
      if (r !== rows[rows.length - 1]) rows.push(r)
    }
  }
  return rows
}

/**
 * Column widths in pixels: the file's widths where it sets them, else fitted to sampled content.
 * `measure(text)` returns the text's rendered width.
 */
export function computeColumnWidths(sheet, measure, count = sheet.columnCount) {
  const widths = new Float64Array(count)
  const fitted = []
  for (let c = 0; c < count; c++) {
    const declared = declaredColumnWidth(sheet.columnInfo[c])
    if (declared === null) {
      widths[c] = MIN_AUTO_COLUMN_WIDTH
      fitted.push(c)
    } else {
      widths[c] = declared
    }
  }
  if (fitted.length === 0) return widths
  const merges = createMergeIndex(sheet.merges.filter((merge) => merge.e.c > merge.s.c))
  for (const r of sampleRowIndexes(sheet.rowCount)) {
    const row = sheet.data[r]
    if (!row) continue
    for (const c of fitted) {
      const cell = row[c]
      // Merged text spans many columns, so it must not widen its first one.
      if (isEmptyCell(cell) || merges.at(r, c)) continue
      const text = cellText(cell)
      // Why: only the first line shows in a fixed-height row.
      const line = text.length > 200 ? text.slice(0, 200) : text
      const width = measure(line.split('\n', 1)[0]) + CELL_PADDING_X
      if (width > widths[c]) widths[c] = width
    }
  }
  for (const c of fitted) {
    widths[c] = Math.min(MAX_AUTO_COLUMN_WIDTH, Math.ceil(Math.max(widths[c], MIN_AUTO_COLUMN_WIDTH)))
  }
  return widths
}

export function computeRowHeights(sheet, count = sheet.rowCount) {
  const heights = new Float64Array(count).fill(DEFAULT_ROW_HEIGHT)
  sheet.rowInfo.forEach((info, r) => {
    if (r >= count) return
    const declared = declaredRowHeight(info)
    if (declared !== null) heights[r] = declared
  })
  return heights
}
