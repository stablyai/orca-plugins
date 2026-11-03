// The spreadsheet as Orca's document session sees it: the file's bytes plus the operations made since
// (workbook-edits.js). Encoding replays them onto the file's own XML, so a save changes only what was
// edited; merging replays this tab's operations onto a version of the file someone else wrote.
import { read } from 'xlsx'
import { odsPackage, odsShiftBlocker, odsFormulas, writeOds } from './ods-writer.js'
import { openWorkbook } from './open-workbook.js'
import { applyOp, portableOp } from './workbook-edits.js'
import { buildWorkbookModel } from './workbook-model.js'
import { writeXlsx, xlsxPackage, xlsxShiftBlocker } from './xlsx-writer.js'

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
 * Three-way merge: the operations this tab made since `base` are replayed onto `outside`, so an
 * outside write keeps every cell this tab did not touch, and this tab's edits win where both did.
 */
export function mergeWorkbooks(base, outside, mine) {
  let shared = 0
  if (base.source === mine.source || sameBytes(base.source.bytes, mine.source.bytes)) {
    while (shared < base.ops.length && shared < mine.ops.length && base.ops[shared] === mine.ops[shared]) shared++
  }
  const pending = mine.ops.slice(shared).map(portableOp)
  return { source: outside.source, ops: [...outside.ops, ...pending] }
}

function sameBytes(a, b) {
  if (a === b) return true
  if (a.byteLength !== b.byteLength) return false
  for (let index = 0; index < a.byteLength; index++) if (a[index] !== b[index]) return false
  return true
}
