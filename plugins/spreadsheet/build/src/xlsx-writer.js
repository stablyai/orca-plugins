// Saves edits into an .xlsx or .xlsm file by rewriting only what changed: the edited sheets' cell
// data, merges and the references that row and column changes move. Styles, charts, pictures,
// comments, macros and every other part keep their exact bytes. New text is stored inline, so the
// shared string table is untouched; Excel recalculates every formula when it opens the file.
import { cellAddress } from './address.js'
import { mapIndex, planEdits } from './edit-plan.js'
import { shiftFormula, shiftSpan, shiftSqref } from './formula-shift.js'
import { toFileFormula } from './formula-tokens.js'
import { readBook, readRels, relsPathOf } from './xlsx-parts.js'
import { escapeXml, findElement, findElements, getAttr, replaceElements, setAttr, unescapeXml, utf8 } from './xml-text.js'
import { writeZip } from './zip-archive.js'
import { findSheet } from './workbook-model.js'

// Worksheet children whose references the writer moves, or that hold none. Anything else (tables,
// drawings, comments, pivot tables, extensions…) stops row and column changes on that sheet.
const SHIFTABLE = new Set([
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection',
  'autoFilter', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks',
  'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'ignoredErrors', 'picture'
])

const BLOCKER_LABELS = {
  drawing: 'charts, pictures or shapes',
  legacyDrawing: 'comments or notes',
  legacyDrawingHF: 'header pictures',
  tableParts: 'tables',
  extLst: 'extended formatting',
  sortState: 'a saved sort',
  protectedRanges: 'protected ranges',
  scenarios: 'scenarios',
  customSheetViews: 'custom views',
  dataConsolidate: 'consolidation',
  oleObjects: 'embedded objects',
  controls: 'form controls',
  webPublishItems: 'web publishing settings',
  smartTags: 'smart tags',
  cellWatches: 'watched cells'
}

/** The parts of the file a writer needs, read once per file. */
export function xlsxPackage(entries) {
  const files = new Map(entries.map((entry) => [entry.name, entry]))
  const book = readBook(files)
  return book ? { entries, files, book } : null
}

/**
 * Why rows or columns cannot be inserted or deleted on this sheet without breaking something the
 * writer does not move, or null when they can.
 */
export function xlsxShiftBlocker(pkg, sheetName, axis) {
  const sheet = pkg.book.sheets.find((entry) => entry.name.toUpperCase() === sheetName.toUpperCase())
  const entry = sheet && pkg.files.get(sheet.path)
  if (!entry || sheet.kind !== 'worksheet') return 'this kind of sheet'
  const xml = utf8.decode(entry.data)
  const root = findElement(xml, 'worksheet')
  if (!root) return 'this kind of sheet'
  for (const name of topLevelNames(root.inner)) {
    if (!SHIFTABLE.has(name)) return BLOCKER_LABELS[name] ?? `“${name}”`
  }
  if (/<(?:[\w.-]+:)?f\b[^>]*\bt="dataTable"/.test(xml)) return 'a data table'
  if (axis === 'column' && /<(?:[\w.-]+:)?filterColumn\b/.test(xml)) return 'a column filter'
  // Charts and pivot tables elsewhere in the workbook can point at this sheet's cells.
  const quoted = new RegExp(`(^|[^\\w.])(${escape(sheetName)}|'${escape(sheetName.replace(/'/g, "''"))}')!`, 'i')
  for (const part of pkg.entries) {
    if (!/^xl\/(charts\/chart|pivotCache\/pivotCacheDefinition|pivotTables\/)/.test(part.name)) continue
    const text = unescapeXml(utf8.decode(part.data))
    if (part.name.includes('pivotCache') ? new RegExp(`sheet="${escape(sheetName)}"`, 'i').test(text) || quoted.test(text) : quoted.test(text)) {
      return part.name.includes('chart') ? 'a chart that reads this sheet' : 'a pivot table that reads this sheet'
    }
  }
  return null
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function topLevelNames(inner) {
  const names = []
  let depth = 0
  const pattern = /<(\/?)(?:[\w.-]+:)?([\w.-]+)[^>]*?(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g
  for (let match; (match = pattern.exec(inner)); ) {
    if (!match[2]) continue
    if (match[1]) {
      depth--
      continue
    }
    if (depth === 0) names.push(match[2])
    if (!match[3]) depth++
  }
  return names
}

/** The file with the operation log applied. `model` is the workbook after those operations. */
export function writeXlsx(pkg, source, ops, model) {
  const plan = planEdits(ops)
  const structural = plan.shifts.length > 0
  const replaced = new Map()
  for (const sheet of pkg.book.sheets) {
    if (sheet.kind !== 'worksheet') continue
    const entry = pkg.files.get(sheet.path)
    const modelSheet = findSheet(model, sheet.name)
    if (!entry || !modelSheet) continue
    const sheetPlan = plan.sheets.get(sheet.name.toUpperCase()) ?? { shifts: [], touched: new Set() }
    if (!structural && sheetPlan.touched.size === 0 && !modelSheet.$recalculated) continue
    const xml = utf8.decode(entry.data)
    replaced.set(sheet.path, utf8.encode(rewriteSheet(xml, { name: sheet.name, sheetPlan, shifts: plan.shifts, structural, modelSheet, source })))
  }

  const workbookXml = utf8.decode(pkg.files.get(pkg.book.workbookPath).data)
  replaced.set(pkg.book.workbookPath, utf8.encode(rewriteWorkbook(workbookXml, pkg, plan.shifts)))

  // A stale calculation chain makes Excel repair the file; without one it rebuilds it.
  const calcChain = pkg.book.rels.find((rel) => rel.type === 'calcChain')
  const removed = new Set()
  if (calcChain && pkg.files.has(calcChain.target)) {
    removed.add(calcChain.target)
    const relsPath = relsPathOf(pkg.book.workbookPath)
    const rels = utf8.decode(pkg.files.get(relsPath).data)
    replaced.set(relsPath, utf8.encode(replaceElements(rels, 'Relationship', (element) => (getAttr(element.startTag, 'Id') === calcChain.id ? '' : wholeElement(element, 'Relationship')))))
    const types = pkg.files.get('[Content_Types].xml')
    if (types) {
      const xml = utf8.decode(types.data)
      replaced.set('[Content_Types].xml', utf8.encode(replaceElements(xml, 'Override', (element) => (getAttr(element.startTag, 'PartName') === `/${calcChain.target}` ? '' : wholeElement(element, 'Override')))))
    }
  }

  const entries = pkg.entries
    .filter((entry) => !removed.has(entry.name))
    .map((entry) => (replaced.has(entry.name) ? { ...entry, data: replaced.get(entry.name), raw: null, method: 8 } : entry))
  return writeZip(entries)
}

const wholeElement = (element, name) => (element.empty ? element.startTag : `${element.startTag}${element.inner}</${element.prefix}${name}>`)

function rewriteWorkbook(xml, pkg, shifts) {
  let out = xml
  if (shifts.length > 0) {
    const sheetNames = pkg.book.sheets.map((sheet) => sheet.name)
    out = replaceElements(out, 'definedName', (element) => {
      if (element.empty) return element.startTag
      const local = getAttr(element.startTag, 'localSheetId')
      const host = local !== null ? sheetNames[Number(local)] ?? '' : '\u0000'
      let formula = unescapeXml(element.inner)
      for (const shift of shifts) formula = shiftFormula(formula, host, shift)
      return `${element.startTag}${escapeXml(formula)}</${element.prefix}definedName>`
    })
  }
  // Why: cached results of formulas this editor could not calculate may be out of date.
  const calcPr = findElement(out, 'calcPr')
  if (calcPr) {
    return out.slice(0, calcPr.start) + setAttr(calcPr.startTag, 'fullCalcOnLoad', '1') + out.slice(calcPr.start + calcPr.startTag.length)
  }
  const prefix = findElement(out, 'workbook')?.prefix ?? ''
  const tag = `<${prefix}calcPr fullCalcOnLoad="1"/>`
  // calcPr follows definedNames, or else sheets, in the schema's order.
  for (const name of ['definedNames', 'externalReferences', 'functionGroups', 'sheets']) {
    const after = findElement(out, name)
    if (after) return out.slice(0, after.end) + tag + out.slice(after.end)
  }
  return out
}

// --- Sheets ------------------------------------------------------------------------------------

function parseRows(inner) {
  const rows = []
  let lastRow = -1
  for (const row of findElements(inner, 'row')) {
    const declared = getAttr(row.startTag, 'r')
    const r = declared ? Number(declared) - 1 : lastRow + 1
    lastRow = r
    const cells = []
    let lastColumn = -1
    for (const cell of row.empty ? [] : findElements(row.inner, 'c')) {
      const ref = getAttr(cell.startTag, 'r')
      const c = ref ? columnOf(ref) : lastColumn + 1
      lastColumn = c
      cells.push({ c, startTag: cell.startTag, inner: cell.inner, empty: cell.empty })
    }
    rows.push({ r, startTag: row.startTag, cells })
  }
  return rows
}

function columnOf(ref) {
  let column = 0
  for (const ch of /^[A-Za-z]+/.exec(ref)[0].toUpperCase()) column = column * 26 + ch.charCodeAt(0) - 64
  return column - 1
}

function rewriteSheet(xml, context) {
  const sheetData = findElement(xml, 'sheetData')
  if (!sheetData) return xml
  const p = sheetData.prefix
  const { sheetPlan, modelSheet, source, structural } = context
  const shifts = sheetPlan.shifts
  const rows = parseRows(sheetData.inner)
  const originals = new Map()
  for (const row of rows) for (const cell of row.cells) originals.set(`${row.r},${cell.c}`, cell)

  const out = new Map()
  const outRow = (r, startTag) => {
    let row = out.get(r)
    if (!row) out.set(r, (row = { startTag: startTag ?? `<${p}row>`, cells: new Map() }))
    return row
  }
  const styleAt = new Map()
  for (const row of rows) {
    const r = mapIndex(row.r, shifts, 'row')
    if (r === null) continue
    const target = outRow(r, row.startTag)
    for (const cell of row.cells) {
      const c = mapIndex(cell.c, shifts, 'column')
      if (c === null) continue
      const key = `${r},${c}`
      if (sheetPlan.touched.has(key)) {
        styleAt.set(key, cell.startTag)
        continue
      }
      target.cells.set(c, keptCell(cell, r, c, context, p))
    }
  }
  for (const key of sheetPlan.touched) {
    const [r, c] = key.split(',').map(Number)
    const cell = modelSheet.data[r]?.[c]
    let text
    if (cell && cell.$src === source && originals.has(`${cell.$r},${cell.$c}`)) {
      text = keptCell(originals.get(`${cell.$r},${cell.$c}`), r, c, context, p)
    } else if (cell) {
      text = newCell(cell, r, c, styleAt.get(key), p)
    } else {
      const style = styleAt.get(key) && getAttr(styleAt.get(key), 's')
      text = style ? `<${p}c r="${cellAddress(r, c)}" s="${escapeXml(style)}"/>` : ''
    }
    if (text) outRow(r).cells.set(c, text)
  }

  let body = ''
  let minRow = Infinity
  let maxRow = -1
  let minColumn = Infinity
  let maxColumn = -1
  for (const r of [...out.keys()].sort((a, b) => a - b)) {
    const row = out.get(r)
    const columns = [...row.cells.keys()].sort((a, b) => a - b)
    let startTag = setAttr(setAttr(row.startTag, 'r', String(r + 1)), 'spans', null)
    if (columns.length === 0 && !/\s(s|ht|hidden|customFormat|customHeight|outlineLevel|collapsed)\s*=/.test(startTag)) continue
    startTag = startTag.replace(/\s*\/>$/, '>')
    body += `${startTag}${columns.map((c) => row.cells.get(c)).join('')}</${p}row>`
    if (columns.length) {
      minRow = Math.min(minRow, r)
      maxRow = Math.max(maxRow, r)
      minColumn = Math.min(minColumn, columns[0])
      maxColumn = Math.max(maxColumn, columns[columns.length - 1])
    }
  }
  const dataTag = sheetData.startTag.replace(/\s*\/>$/, '>')
  let result = `${xml.slice(0, sheetData.start)}${dataTag}${body}</${p}sheetData>${xml.slice(sheetData.end)}`

  const dimension = maxRow < 0 ? 'A1' : `${cellAddress(minRow, minColumn)}${maxRow === minRow && maxColumn === minColumn ? '' : `:${cellAddress(maxRow, maxColumn)}`}`
  result = replaceElements(result, 'dimension', (element) => setAttr(element.startTag, 'ref', dimension))
  result = writeMerges(result, modelSheet.merges, p)
  if (structural) result = shiftSheetParts(result, context)
  return result
}

/** A cell the file had, at its new position; its formula rewritten when references moved. */
function keptCell(cell, r, c, context, p) {
  const address = cellAddress(r, c)
  const startTag = setAttr(cell.startTag, 'r', address)
  const formula = cell.empty ? null : findElement(cell.inner, 'f')
  if (!formula) return cell.empty ? startTag : `${startTag}${cell.inner}</${p}c>`
  const model = context.modelSheet.data[r]?.[c]
  const shared = getAttr(formula.startTag, 't') === 'shared'
  if (!model?.f || (!context.structural && !shared && !model.$changed)) {
    return `${startTag}${cell.inner}</${p}c>`
  }
  let fTag = setAttr(setAttr(formula.startTag, 'si', null), 't', shared ? null : getAttr(formula.startTag, 't'))
  if (shared) fTag = setAttr(fTag, 'ref', null)
  else if (getAttr(fTag, 'ref') && model.F) fTag = setAttr(fTag, 'ref', model.F)
  fTag = fTag.replace(/\s*\/>$/, '>')
  // Kept text when nothing moved and it was written out: the file's own spelling of the formula.
  const text = !context.structural && !shared && !formula.empty ? formula.inner : escapeXml(fileFormula(model.f))
  return valueCell(model, setAttr(setAttr(setAttr(startTag, 'cm', null), 'vm', null), 't', null), `${fTag}${text}</${p}f>`, p)
}

function fileFormula(f) {
  try {
    return toFileFormula(f)
  } catch {
    return f
  }
}

/** A cell an edit wrote, keeping the style of the cell it replaced. */
function newCell(cell, r, c, previousTag, p) {
  let startTag = `<${p}c r="${cellAddress(r, c)}">`
  const style = previousTag && getAttr(previousTag, 's')
  if (style) startTag = setAttr(startTag, 's', style)
  const formula = cell.f ? `<${p}f>${escapeXml(fileFormula(cell.f))}</${p}f>` : ''
  if (!cell.f && cell.t === 's') {
    return `${setAttr(startTag, 't', 'inlineStr')}<${p}is><${p}t xml:space="preserve">${escapeXml(cell.v)}</${p}t></${p}is></${p}c>`
  }
  return valueCell(cell, startTag, formula, p)
}

function valueCell(cell, startTag, formula, p) {
  const tag = (type) => (type ? setAttr(startTag, 't', type) : startTag)
  if (cell.v === undefined || cell.v === null) return `${tag(null)}${formula}</${p}c>`
  switch (cell.t) {
    case 'b':
      return `${tag('b')}${formula}<${p}v>${cell.v ? 1 : 0}</${p}v></${p}c>`
    case 'e':
      return `${tag('e')}${formula}<${p}v>${escapeXml(cell.w ?? '#VALUE!')}</${p}v></${p}c>`
    case 's':
      return `${tag('str')}${formula}<${p}v>${escapeXml(cell.v)}</${p}v></${p}c>`
    default:
      return Number.isFinite(cell.v) ? `${tag(null)}${formula}<${p}v>${cell.v}</${p}v></${p}c>` : `${tag(null)}${formula}</${p}c>`
  }
}

function writeMerges(xml, merges, p) {
  const list = merges.map((merge) => `<${p}mergeCell ref="${cellAddress(merge.s.r, merge.s.c)}:${cellAddress(merge.e.r, merge.e.c)}"/>`).join('')
  const block = list ? `<${p}mergeCells count="${merges.length}">${list}</${p}mergeCells>` : ''
  if (findElement(xml, 'mergeCells')) return replaceElements(xml, 'mergeCells', () => block)
  if (!block) return xml
  // mergeCells follows sheetData and the elements the schema puts between them.
  let at = findElement(xml, 'sheetData').end
  for (const name of ['sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews']) {
    const element = findElement(xml, name)
    if (element && element.start >= at) at = element.end
  }
  return xml.slice(0, at) + block + xml.slice(at)
}

/** Moves the references in the rest of the sheet: widths, formats, validation, links, views. */
function shiftSheetParts(xml, context) {
  const own = context.sheetPlan.shifts
  const sqref = (value) => own.reduce((text, shift) => (text ? shiftSqref(text, shift) : text), value)
  const formulas = (text) => context.shifts.reduce((formula, shift) => shiftFormula(formula, context.name, shift), text)
  let out = xml
  out = replaceElements(out, 'col', (element) => {
    let min = Number(getAttr(element.startTag, 'min')) - 1
    let max = Number(getAttr(element.startTag, 'max')) - 1
    for (const shift of own) {
      if (shift.axis !== 'column') continue
      const span = shiftSpan(min, max, shift)
      if (!span) return ''
      ;[min, max] = span
    }
    return setAttr(setAttr(element.startTag, 'min', String(min + 1)), 'max', String(max + 1)) + (element.empty ? '' : `${element.inner}</${element.prefix}col>`)
  })
  out = out.replace(/(<(?:[\w.-]+:)?cols\b[^>]*>)(\s*)(<\/(?:[\w.-]+:)?cols>)/, '')
  for (const name of ['conditionalFormatting', 'dataValidation', 'hyperlink', 'selection', 'ignoredError', 'protectedRange']) {
    out = replaceElements(out, name, (element) => {
      const attr = name === 'hyperlink' ? 'ref' : 'sqref'
      const value = getAttr(element.startTag, attr)
      let startTag = element.startTag
      if (value !== null) {
        const next = sqref(value)
        if (!next) return name === 'selection' ? setAttr(setAttr(startTag, 'sqref', 'A1'), 'activeCell', 'A1') : ''
        startTag = setAttr(startTag, attr, next)
      }
      if (name === 'selection') {
        const active = getAttr(startTag, 'activeCell')
        if (active) startTag = setAttr(startTag, 'activeCell', sqref(active) || 'A1')
      }
      if (element.empty) return startTag
      const inner = name === 'conditionalFormatting' || name === 'dataValidation'
        ? element.inner.replace(/(<(?:[\w.-]+:)?(formula|formula1|formula2)>)([\s\S]*?)(<\/(?:[\w.-]+:)?\2>)/g, (_, open, __, text, close) => open + escapeXml(formulas(unescapeXml(text))) + close)
        : element.inner
      return `${startTag}${inner}</${element.prefix}${name}>`
    })
  }
  out = replaceElements(out, 'pane', (element) => {
    const topLeft = getAttr(element.startTag, 'topLeftCell')
    return topLeft ? setAttr(element.startTag, 'topLeftCell', sqref(topLeft) || 'A1') : element.startTag
  })
  out = replaceElements(out, 'autoFilter', (element) => {
    const ref = sqref(getAttr(element.startTag, 'ref') ?? '')
    if (!ref) return ''
    return setAttr(element.startTag, 'ref', ref) + (element.empty ? '' : `${element.inner}</${element.prefix}autoFilter>`)
  })
  for (const [list, axis] of [['rowBreaks', 'row'], ['colBreaks', 'column']]) {
    out = replaceElements(out, list, (element) => {
      if (element.empty) return element.startTag
      const breaks = findElements(element.inner, 'brk')
        .map((brk) => {
          // A break's id is the index of the row or column it comes before.
          const id = mapIndex(Number(getAttr(brk.startTag, 'id')), own, axis)
          return id === null ? '' : setAttr(brk.startTag, 'id', String(id))
        })
        .filter(Boolean)
      if (breaks.length === 0) return ''
      let startTag = setAttr(element.startTag, 'count', String(breaks.length))
      if (getAttr(startTag, 'manualBreakCount')) startTag = setAttr(startTag, 'manualBreakCount', String(breaks.length))
      return `${startTag}${breaks.join('')}</${element.prefix}${list}>`
    })
  }
  out = out.replace(/<(?:[\w.-]+:)?(conditionalFormatting|dataValidations|hyperlinks|ignoredErrors)\b[^>]*>\s*<\/(?:[\w.-]+:)?\1>/g, '')
  out = replaceElements(out, 'dataValidations', (element) => (element.empty ? element.startTag : `${setAttr(element.startTag, 'count', String(findElements(element.inner, 'dataValidation').length))}${element.inner}</${element.prefix}dataValidations>`))
  return out
}

export { readRels }
