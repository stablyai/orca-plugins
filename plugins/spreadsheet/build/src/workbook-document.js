// The spreadsheet as Orca's document session sees it: the file's bytes plus the operations made since
// (workbook-edits.js). Encoding replays them onto the file's own XML, so a save changes only what was
// edited; merging replays this tab's operations onto a version of the file someone else wrote.
import { read } from 'xlsx'
import { odsPackage, odsShiftBlocker, odsFormulas, writeOds } from './ods-writer.js'
import { openWorkbook } from './open-workbook.js'
import { applyOp, portableOp } from './workbook-edits.js'
import { buildWorkbookModel } from './workbook-model.js'
import { writeXlsx, xlsxLockedRanges, xlsxPackage, xlsxShiftBlocker } from './xlsx-writer.js'

/**
 * @typedef {{ bytes: Uint8Array, fileType: string | null, opened?: object }} Source
 * @typedef {{ source: Source, ops: object[], model?: object }} WorkbookValue
 */

export function createSource(bytes, fileType = null) {
  return { bytes, fileType }
}

/**
 * The parsed file, read once: `{ status, workbook, format, pkg, readOnlyReason }`. `format` is
 * 'xlsx' or 'ods' when the editor can save it, else null, and `readOnlyReason` names the format
 * it cannot save ('xls' or 'xlsb').
 */
export function openSource(source) {
  if (source.opened) return source.opened
  const result = openWorkbook({ read }, source.bytes)
  if (result.status !== 'ok') return (source.opened = result)
  let format = null
  let pkg = null
  // What the file is, for the read-only notice: the bytes say it better than the file name.
  let readOnlyReason = result.entries ? 'xlsb' : 'xls'
  if (result.entries) {
    const names = new Set(result.entries.map((entry) => entry.name))
    if (names.has('content.xml') && isOds(result.entries)) {
      pkg = odsPackage(result.entries)
      format = pkg ? 'ods' : null
    } else if (!names.has('xl/workbook.bin')) {
      pkg = xlsxPackage(result.entries)
      format = pkg ? 'xlsx' : null
    }
    if (format) readOnlyReason = null
  }
  source.opened = { status: 'ok', workbook: result.workbook, format, pkg, readOnlyReason }
  return source.opened
}

function isOds(entries) {
  const mimetype = entries.find((entry) => entry.name === 'mimetype')
  return mimetype && new TextDecoder().decode(mimetype.data).trim() === 'application/vnd.oasis.opendocument.spreadsheet'
}

/** A fresh model of the file as it is on disk; each cell remembers where the file had it. */
export function buildModel(source) {
  const opened = openSource(source)
  if (opened.status !== 'ok') return null
  // The first model takes the parse openSource made; later ones parse afresh, because a model is
  // edited in place.
  let workbook = opened.workbook
  if (opened.claimed) workbook = openWorkbook({ read }, source.bytes).workbook
  opened.claimed = true
  const model = buildWorkbookModel(workbook)
  for (const sheet of model.all) {
    sheet.data.forEach((row, r) => {
      row?.forEach((cell, c) => {
        if (!cell) return
        cell.$src = source
        cell.$r = r
        cell.$c = c
      })
    })
  }
  if (opened.format === 'ods') odsFormulas(opened.pkg, model)
  return model
}

/** The value's model: the editor's live one, or the file with the operations replayed. */
export function modelOf(value) {
  if (!value.model) {
    const model = buildModel(value.source)
    if (model) for (const op of value.ops) applyOp(model, portableOp(op))
    value.model = model
  }
  return value.model
}

/**
 * Why rows or columns cannot be inserted or deleted on a sheet, or null when they can. `span` is
 * the shift about to happen, checked against merged cells in .ods files.
 */
export function shiftBlocker(source, sheet, axis, span) {
  const opened = openSource(source)
  if (opened.format === 'xlsx') return xlsxShiftBlocker(opened.pkg, sheet.name, axis)
  if (opened.format !== 'ods') return 'this file'
  const key = axis === 'row' ? 'r' : 'c'
  const end = span.at + Math.abs(span.count) - 1
  // OpenDocument spells a merge out cell by cell; changing rows through one would tear it.
  const crosses = sheet.merges.some((merge) =>
    span.count > 0 ? span.at > merge.s[key] && span.at <= merge.e[key] : span.at <= merge.e[key] && end >= merge.s[key]
  )
  if (crosses) return 'merged cells'
  return odsShiftBlocker(opened.pkg, sheet.name)
}

/** Whether any of `cells` ({ r, c }) is one an edit must not change: an Excel table's header or totals. */
export function touchesLockedCell(source, sheetName, cells) {
  const opened = openSource(source)
  if (opened.format !== 'xlsx') return false
  opened.locked ??= new Map()
  const key = sheetName.toUpperCase()
  if (!opened.locked.has(key)) opened.locked.set(key, xlsxLockedRanges(opened.pkg, sheetName))
  const ranges = opened.locked.get(key)
  return ranges.length > 0 && cells.some(({ r, c }) => ranges.some((range) => r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1))
}

// --- Session codec -----------------------------------------------------------------------------

/**
 * `decode`, `encode` and `merge` for `orca.document.session()`. Encoded bytes are remembered with
 * the value they came from, so decoding Orca's copy of an accepted edit gives that value back
 * instead of parsing the file again.
 */
export function createWorkbookCodec() {
  const recent = []
  const remember = (bytes, value) => {
    recent.unshift({ bytes, value })
    recent.length = Math.min(recent.length, 4)
  }
  return {
    decode(content) {
      if (content?.kind !== 'bytes' || !(content.bytes instanceof ArrayBuffer)) {
        return { source: createSource(new Uint8Array(0)), ops: [] }
      }
      const bytes = new Uint8Array(content.bytes)
      const known = recent.find((entry) => sameBytes(entry.bytes, bytes))
      if (known) return { source: known.value.source, ops: known.value.ops }
      return { source: createSource(bytes, content.fileType ?? null), ops: [] }
    },
    encode(value) {
      const bytes = value.ops.length === 0 ? value.source.bytes : writeWorkbook(value)
      remember(bytes, value)
      // A copy: Orca keeps the buffer, and the source's bytes must stay as they are.
      return { kind: 'bytes', bytes: bytes.slice().buffer }
    },
    merge: mergeWorkbooks
  }
}

export function writeWorkbook(value) {
  const opened = openSource(value.source)
  if (!opened.format) throw new Error('this file cannot be saved')
  const model = modelOf(value)
  return opened.format === 'ods'
    ? writeOds(opened.pkg, value.source, value.ops, model)
    : writeXlsx(opened.pkg, value.source, value.ops, model)
}

/**
 * Three-way merge, kept deliberately narrow: this tab's cell edits since `base` are replayed onto
 * `outside` only when the outside write changed no sheet's shape (sheets, used extent, merges) and
 * touched no row or column this tab edited. Anything else, or any row or column change on this
 * side, is refused: the result is the outside file with this tab's edits in `rejected`, which the
 * editor offers to reapply or discard. Edits never land on rows that moved underneath them.
 */
export function mergeWorkbooks(base, outside, mine) {
  let shared = 0
  if (base.source === mine.source || sameBytes(base.source.bytes, mine.source.bytes)) {
    while (shared < base.ops.length && shared < mine.ops.length && base.ops[shared] === mine.ops[shared]) shared++
  }
  const pending = mine.ops.slice(shared).map(portableOp)
  const kept = { source: outside.source, ops: [...outside.ops] }
  if (pending.length === 0) return kept
  return mergeRefusal(base, outside, pending) ? { ...kept, rejected: pending } : { source: outside.source, ops: [...outside.ops, ...pending] }
}

/** Why `pending` cannot be replayed onto `outside` safely, or null when it can. */
export function mergeRefusal(base, outside, pending) {
  if (pending.some((op) => op.type !== 'cells')) return 'rows or columns changed here'
  const before = modelOf({ source: base.source, ops: base.ops.map(portableOp) })
  const after = modelOf({ source: outside.source, ops: outside.ops.map(portableOp) })
  if (!before || !after) return 'unreadable'
  if (before.all.map((sheet) => sheet.name).join('\n') !== after.all.map((sheet) => sheet.name).join('\n')) return 'sheets changed'
  const touched = new Map()
  for (const op of pending) {
    const key = op.sheet.toUpperCase()
    if (!touched.has(key)) touched.set(key, { rows: new Set(), columns: new Set() })
    for (const { r, c } of op.cells) {
      touched.get(key).rows.add(r)
      touched.get(key).columns.add(c)
    }
  }
  for (let index = 0; index < before.all.length; index++) {
    const a = before.all[index]
    const b = after.all[index]
    if (a.rowCount !== b.rowCount || a.columnCount !== b.columnCount) return 'a sheet changed size'
    if (JSON.stringify(a.merges) !== JSON.stringify(b.merges)) return 'merged cells changed'
    const mark = touched.get(a.name.toUpperCase())
    if (!mark) continue
    for (let r = 0; r < a.rowCount; r++) {
      for (let c = 0; c < a.columnCount; c++) {
        if (cellSignature(a.data[r]?.[c]) === cellSignature(b.data[r]?.[c])) continue
        // A change in a row or column this tab edited may be a move this merge cannot see.
        if (mark.rows.has(r) || mark.columns.has(c)) return 'the same rows or columns changed'
      }
    }
  }
  return null
}

const cellSignature = (cell) => (cell ? `${cell.t}|${cell.v}|${cell.f ?? ''}` : '')

function sameBytes(a, b) {
  if (a === b) return true
  if (a.byteLength !== b.byteLength) return false
  for (let index = 0; index < a.byteLength; index++) if (a[index] !== b[index]) return false
  return true
}
