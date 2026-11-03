// Saves edits into an .ods file by rewriting only content.xml, and in it only the edited tables' rows
// and cells and the references that row and column changes move. Styles, pictures, charts and the
// rest of the package keep their exact bytes.
import { mapIndex, planEdits } from './edit-plan.js'
import { excelToOdf, odfToExcel, shiftOdfFormula, shiftOdfRangeList } from './formula-odf.js'
import { findSheet } from './workbook-model.js'
import { escapeXml, findElements, getAttr, setAttr, unescapeXml, utf8 } from './xml-text.js'
import { writeZip } from './zip-archive.js'

const MAX_ROWS = 1_048_576

export function odsPackage(entries) {
  const content = entries.find((entry) => entry.name === 'content.xml')
  if (!content) return null
  const xml = utf8.decode(content.data)
  if (findElements(xml, 'spreadsheet').length !== 1) return null
  // calcext:value-type is an extension namespace; write it only where the file declares it.
  return { entries, content: xml, calcext: /xmlns:calcext=/.test(xml) }
}

/** Every table in content.xml: `{ name, start, end, startTag, inner, innerStart, prefix }`. */
function tables(xml) {
  return findElements(xml, 'table')
    .filter((element) => element.prefix === 'table:' || /table:name=/.test(element.startTag))
    .map((element) => ({ ...element, name: getAttr(element.startTag, 'table:name') ?? '' }))
}

// --- Rows and cells, repeat-aware --------------------------------------------------------------

const ROW = /<([\w.-]+:)?table-row(?=[\s/>])[^>]*?(\/?)>/g
const CELL = /<([\w.-]+:)?(table-cell|covered-table-cell)(?=[\s/>])[^>]*?(\/?)>/g

function elementsOf(xml, pattern, nameIndex) {
  const list = []
  pattern.lastIndex = 0
  for (let match; (match = pattern.exec(xml)); ) {
    const prefix = match[1] ?? ''
    const name = nameIndex ? match[nameIndex] : 'table-row'
    const selfClosing = match[nameIndex ? 3 : 2] === '/'
    let end = pattern.lastIndex
    let inner = ''
    if (!selfClosing) {
      const close = `</${prefix}${name}>`
      const at = xml.indexOf(close, end)
      if (at < 0) break
      inner = xml.slice(end, at)
      end = at + close.length
      pattern.lastIndex = end
    }
    list.push({ start: match.index, end, startTag: match[0], inner, prefix, name, selfClosing })
  }
  return list
}

const repeatOf = (tag, attr) => Math.max(1, Number(getAttr(tag, attr) ?? 1) || 1)
const rowsOf = (xml) => elementsOf(xml, ROW, 0).map((row) => ({ ...row, repeat: repeatOf(row.startTag, 'table:number-rows-repeated') }))
const cellsOf = (xml) => elementsOf(xml, CELL, 2).map((cell) => ({ ...cell, repeat: repeatOf(cell.startTag, 'table:number-columns-repeated') }))

const withRepeat = (element, attr, count) => {
  const tag = setAttr(element.startTag, attr, count > 1 ? String(count) : null)
  return element.selfClosing ? tag : `${tag}${element.inner}</${element.prefix}${element.name}>`
}
const rowText = (row, count) => withRepeat(row, 'table:number-rows-repeated', count)
const cellText = (cell, count) => withRepeat(cell, 'table:number-columns-repeated', count)

function isEmptyCell(cell) {
  return cell.name === 'table-cell' && !/office:value-type=|table:formula=|table:number-(columns|rows)-spanned=/.test(cell.startTag) && !/<[\w.-]+:/.test(cell.inner)
}

const isEmptyRow = (row) => cellsOf(row.inner).every(isEmptyCell)

/**
 * Rewrites `xml` (a table's inner text, or a row's) splitting repeated elements so that each
 * element `wanted(index)` asks for stands alone, then hands those to `edit(element, index)`.
 */
function splitAndEdit(xml, elements, attr, wanted, edit) {
  let out = ''
  let at = 0
  let index = 0
  for (const element of elements) {
    out += xml.slice(at, element.start)
    at = element.end
    const first = index
    index += element.repeat
    const hits = wanted(first, index)
    if (hits.length === 0) {
      out += xml.slice(element.start, element.end)
      continue
    }
    let cursor = first
    for (const hit of hits) {
      if (hit > cursor) out += withRepeat(element, attr, hit - cursor)
      out += edit({ ...element, startTag: setAttr(element.startTag, attr, null), repeat: 1 }, hit)
      cursor = hit + 1
    }
    if (index > cursor) out += withRepeat(element, attr, index - cursor)
  }
  return { text: out + xml.slice(at), count: index }
}

const hitsIn = (sorted) => (from, to) => sorted.filter((index) => index >= from && index < to)

// --- Structural changes ------------------------------------------------------------------------

function shiftRows(inner, shift, p) {
  const rows = rowsOf(inner)
  if (shift.count > 0) {
    const blank = `<${p}table-row${shift.count > 1 ? ` ${p}number-rows-repeated="${shift.count}"` : ''}><${p}table-cell/></${p}table-row>`
    let total = 0
    for (const row of rows) total += row.repeat
    let text
    if (shift.at >= total) {
      const last = rows[rows.length - 1]
      const at = last ? last.end : inner.length
      text = inner.slice(0, at) + blank + inner.slice(at)
    } else {
      text = splitAndEdit(inner, rows, 'table:number-rows-repeated', (from, to) => (shift.at >= from && shift.at < to ? [shift.at] : []), (row) => {
        const style = getAttr(row.startTag, 'table:style-name')
        const added = style ? blank.replace(`<${p}table-row`, `<${p}table-row ${p}style-name="${escapeXml(style)}"`) : blank
        return added + rowText(row, 1)
      }).text
    }
    return trimTrailingRows(text, shift.count)
  }
  const end = shift.at - shift.count
  let out = ''
  let at = 0
  let index = 0
  for (const row of rows) {
    out += inner.slice(at, row.start)
    at = row.end
    const first = index
    index += row.repeat
    const kept = row.repeat - Math.max(0, Math.min(index, end) - Math.max(first, shift.at))
    if (kept > 0) out += kept === row.repeat ? inner.slice(row.start, row.end) : rowText(row, kept)
  }
  return out + inner.slice(at)
}

/** Keeps a sheet within its row limit: the trailing run of empty rows gives up `count`. */
function trimTrailingRows(inner, count) {
  const rows = rowsOf(inner)
  let total = 0
  for (const row of rows) total += row.repeat
  const last = rows[rows.length - 1]
  if (!last || total <= MAX_ROWS || !isEmptyRow(last) || last.repeat <= count) return inner
  return inner.slice(0, last.start) + rowText(last, last.repeat - Math.min(count, total - MAX_ROWS)) + inner.slice(last.end)
}

function shiftCellsInRow(rowInner, shift, p) {
  const cells = cellsOf(rowInner)
  if (shift.count > 0) {
    let total = 0
    for (const cell of cells) total += cell.repeat
    if (shift.at >= total) return rowInner
    const blank = `<${p}table-cell${shift.count > 1 ? ` ${p}number-columns-repeated="${shift.count}"` : ''}/>`
    const text = splitAndEdit(rowInner, cells, 'table:number-columns-repeated', (from, to) => (shift.at >= from && shift.at < to ? [shift.at] : []), (cell) => blank + cellText(cell, 1)).text
    // The trailing run of empty cells gives the new ones back, so rows keep their width.
    const after = cellsOf(text)
    const last = after[after.length - 1]
    if (last && isEmptyCell(last) && last.repeat > shift.count) return text.slice(0, last.start) + cellText(last, last.repeat - shift.count) + text.slice(last.end)
    return text
  }
  const end = shift.at - shift.count
  let out = ''
  let at = 0
  let index = 0
  for (const cell of cells) {
    out += rowInner.slice(at, cell.start)
    at = cell.end
    const first = index
    index += cell.repeat
    const kept = cell.repeat - Math.max(0, Math.min(index, end) - Math.max(first, shift.at))
    if (kept > 0) out += kept === cell.repeat ? rowInner.slice(cell.start, cell.end) : cellText(cell, kept)
  }
  return out + rowInner.slice(at)
}

function shiftColumns(inner, shift, p) {
  // Column definitions first: their repeat counts grow or shrink like a row's cells.
  const columns = elementsOf(inner, /<([\w.-]+:)?(table-column)(?=[\s/>])[^>]*?(\/?)>/g, 2).map((column) => ({
    ...column,
    repeat: repeatOf(column.startTag, 'table:number-columns-repeated')
  }))
  let out = ''
  let at = 0
  let index = 0
  const end = shift.at - shift.count
  for (const column of columns) {
    out += inner.slice(at, column.start)
    at = column.end
    const first = index
    index += column.repeat
    let count = column.repeat
    if (shift.count > 0 && shift.at >= first && shift.at < index) count += shift.count
    if (shift.count < 0) count -= Math.max(0, Math.min(index, end) - Math.max(first, shift.at))
    if (count > 0) out += count === column.repeat ? inner.slice(column.start, column.end) : withRepeat(column, 'table:number-columns-repeated', count)
  }
  out += inner.slice(at)
  const rows = rowsOf(out)
  let result = ''
  at = 0
  for (const row of rows) {
    result += out.slice(at, row.start)
    at = row.end
    if (row.selfClosing) {
      result += out.slice(row.start, row.end)
      continue
    }
    result += `${row.startTag}${shiftCellsInRow(row.inner, shift, p)}</${row.prefix}table-row>`
  }
  return result + out.slice(at)
}

// --- Cells ---------------------------------------------------------------------------------------

const VALUE_ATTRS = ['office:value-type', 'calcext:value-type', 'office:value', 'office:date-value', 'office:time-value', 'office:boolean-value', 'office:string-value', 'office:currency']

/** Text as ODF paragraphs: lines become `text:p`, runs of spaces `text:s`, tabs `text:tab`. */
function paragraphs(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      const body = escapeXml(line)
        .replace(/\t/g, '<text:tab/>')
        .replace(/ {2,}/g, (run) => ` <text:s${run.length > 2 ? ` text:c="${run.length - 1}"` : ''}/>`)
        .replace(/^ /, '<text:s/>')
      return `<text:p>${body}</text:p>`
    })
    .join('')
}

/** The cell with the model's content: its style, spans, notes and validation stay. */
function writeCell(element, model, keepFormula, calcext) {
  let tag = element.startTag.replace(/\s*\/>$/, '>')
  for (const attr of VALUE_ATTRS) tag = setAttr(tag, attr, null)
  if (!keepFormula) tag = setAttr(tag, 'table:formula', model?.f ? excelToOdf(model.f) : null)
  // Paragraphs are the cell's text; notes, pictures and the like stay.
  const kept = topLevel(element.inner)
    .filter((child) => !/^text:(p|h|list)$/.test(child.name))
    .map((child) => child.text)
    .join('')
  if (element.name === 'covered-table-cell' && !model) return `${tag}${kept}</${element.prefix}${element.name}>`
  let body = kept
  if (model && model.v !== undefined && model.v !== null) {
    switch (model.t) {
      case 'n':
        tag = setAttr(setAttr(setAttr(tag, 'office:value-type', 'float'), 'office:value', String(model.v)), 'calcext:value-type', 'float')
        break
      case 'b':
        tag = setAttr(setAttr(setAttr(tag, 'office:value-type', 'boolean'), 'office:boolean-value', model.v ? 'true' : 'false'), 'calcext:value-type', 'boolean')
        break
      case 'e':
        tag = setAttr(setAttr(setAttr(tag, 'office:value-type', 'string'), 'office:string-value', ''), 'calcext:value-type', 'error')
        break
      default:
        tag = setAttr(setAttr(tag, 'office:value-type', 'string'), 'calcext:value-type', 'string')
    }
    body = paragraphs(model.w ?? String(model.v)) + kept
  }
  if (!calcext) tag = setAttr(tag, 'calcext:value-type', null)
  return `${tag}${body}</${element.prefix}${element.name}>`
}

/** The top-level children of an element's inner text, as `{ name, text }`. */
function topLevel(inner) {
  const children = []
  let depth = 0
  let start = 0
  let name = ''
  const pattern = /<(\/?)([\w.-]+:[\w.-]+|[\w.-]+)[^>]*?(\/?)>/g
  for (let match; (match = pattern.exec(inner)); ) {
    if (match[1]) {
      depth--
      if (depth === 0) children.push({ name, text: inner.slice(start, pattern.lastIndex) })
      continue
    }
    if (depth === 0) {
      start = match.index
      name = match[2]
    }
    if (match[3]) {
      if (depth === 0) children.push({ name, text: match[0] })
    } else {
      depth++
    }
  }
  return children
}

function editCells(inner, sheetCells, calcext) {
  const rowIndexes = [...sheetCells.keys()].sort((a, b) => a - b)
  if (rowIndexes.length === 0) return inner
  let total = 0
  const rows = rowsOf(inner)
  for (const row of rows) total += row.repeat
  // Rows past the table's last row are added before writing into them.
  const lastWanted = rowIndexes[rowIndexes.length - 1]
  if (lastWanted >= total) {
    const p = rows[0]?.prefix ?? 'table:'
    const at = rows.length ? rows[rows.length - 1].end : inner.length
    const missing = lastWanted + 1 - total
    inner = `${inner.slice(0, at)}<${p}table-row${missing > 1 ? ` ${p}number-rows-repeated="${missing}"` : ''}><${p}table-cell/></${p}table-row>${inner.slice(at)}`
  }
  return splitAndEdit(inner, rowsOf(inner), 'table:number-rows-repeated', hitsIn(rowIndexes), (row, r) => {
    const wanted = sheetCells.get(r)
    const columns = [...wanted.keys()].sort((a, b) => a - b)
    let rowInner = row.selfClosing ? '' : row.inner
    let width = 0
    for (const cell of cellsOf(rowInner)) width += cell.repeat
    const lastColumn = columns[columns.length - 1]
    if (lastColumn >= width) {
      const p = row.prefix
      const missing = lastColumn + 1 - width
      rowInner += `<${p}table-cell${missing > 1 ? ` ${p}number-columns-repeated="${missing}"` : ''}/>`
    }
    const edited = splitAndEdit(rowInner, cellsOf(rowInner), 'table:number-columns-repeated', hitsIn(columns), (cell, c) => {
      const { model, keepFormula } = wanted.get(c)
      return writeCell(cell, model, keepFormula, calcext)
    }).text
    return `${row.startTag.replace(/\s*\/>$/, '>')}${edited}</${row.prefix}table-row>`
  }).text
}

// --- Whole file ----------------------------------------------------------------------------------

export function writeOds(pkg, source, ops, model) {
  const plan = planEdits(ops)
  let xml = pkg.content
  // Back to front, so earlier offsets stay valid.
  const list = tables(xml).reverse()
  for (const table of list) {
    const sheetPlan = plan.sheets.get(table.name.toUpperCase())
    const modelSheet = findSheet(model, table.name)
    let inner = table.inner
    const p = table.prefix
    for (const shift of sheetPlan?.shifts ?? []) {
      inner = shift.axis === 'row' ? shiftRows(inner, shift, p) : shiftColumns(inner, shift, p)
    }
    for (const shift of plan.shifts) {
      inner = inner.replace(/(table:formula=")([^"]*)(")/g, (_, open, text, close) => open + escapeXml(shiftOdfFormula(unescapeXml(text), table.name, shift)) + close)
    }
    const cells = new Map()
    const want = (r, c, entry) => {
      let row = cells.get(r)
      if (!row) cells.set(r, (row = new Map()))
      row.set(c, entry)
    }
    for (const key of sheetPlan?.touched ?? []) {
      const [r, c] = key.split(',').map(Number)
      want(r, c, { model: modelSheet?.data[r]?.[c] ?? null, keepFormula: false })
    }
    // Recalculated results go in beside the formulas the file already has.
    if (modelSheet?.$recalculated) {
      modelSheet.data.forEach((row, r) =>
        row?.forEach((cell, c) => {
          if (cell?.f && cell.$changed && !cells.get(r)?.has(c)) want(r, c, { model: cell, keepFormula: true })
        })
      )
    }
    inner = editCells(inner, cells, pkg.calcext)
    if (inner !== table.inner) xml = xml.slice(0, table.innerStart) + inner + xml.slice(table.innerStart + table.inner.length)
  }
  if (plan.shifts.length > 0) xml = shiftNamedRanges(xml, plan.shifts)
  const entries = pkg.entries.map((entry) => (entry.name === 'content.xml' ? { ...entry, data: utf8.encode(xml), raw: null, method: 8 } : entry))
  return writeZip(entries)
}

function shiftNamedRanges(xml, shifts) {
  const attribute = (name, shiftOne) =>
    (text) =>
      text.replace(new RegExp(`(${name}=")([^"]*)(")`, 'g'), (_, open, value, close) => {
        let next = unescapeXml(value)
        for (const shift of shifts) next = shiftOne(next, shift)
        return open + escapeXml(next) + close
      })
  const ranges = attribute('table:cell-range-address', (value, shift) => shiftOdfRangeList(value, '\u0000', shift) || value)
  const bases = attribute('table:base-cell-address', (value, shift) => shiftOdfRangeList(value, '\u0000', shift) || value)
  const expressions = attribute('table:expression', (value, shift) => shiftOdfFormula(value, '\u0000', shift))
  return xml.replace(/<table:named-expressions\b[\s\S]*?<\/table:named-expressions>/g, (block) => expressions(bases(ranges(block))))
}

// --- Reading and guards --------------------------------------------------------------------------

/** Formulas as the file spells them, in Excel's spelling, onto the model's cells. */
export function odsFormulas(pkg, model) {
  for (const table of tables(pkg.content)) {
    const sheet = findSheet(model, table.name)
    if (!sheet || !/table:formula=/.test(table.inner)) continue
    let r = 0
    for (const row of rowsOf(table.inner)) {
      if (/table:formula=/.test(row.inner)) {
        let c = 0
        for (const cell of cellsOf(row.inner)) {
          const formula = getAttr(cell.startTag, 'table:formula')
          if (formula) {
            for (let dr = 0; dr < row.repeat; dr++) {
              for (let dc = 0; dc < cell.repeat; dc++) {
                const target = sheet.data[r + dr]?.[c + dc]
                if (target) target.f = odfToExcel(formula)
              }
            }
          }
          c += cell.repeat
        }
      }
      r += row.repeat
    }
  }
}

/** Why rows or columns cannot change on this sheet, or null when they can. */
export function odsShiftBlocker(pkg, sheetName) {
  const table = tables(pkg.content).find((entry) => entry.name.toUpperCase() === sheetName.toUpperCase())
  if (!table) return 'this kind of sheet'
  const inner = table.inner
  if (/<draw:(frame|custom-shape|rect|line|ellipse|polygon|path|g|object)\b/.test(inner) || /<table:shapes\b/.test(inner)) return 'charts, pictures or shapes'
  if (/<calcext:conditional-formats\b/.test(inner)) return 'conditional formatting'
  if (/table:content-validation-name=/.test(inner)) return 'validation rules'
  if (/<table:(data-pilot|database|dde)-/.test(inner)) return 'a pivot table or database range'
  if (/<table:table-source\b|<table:scenario\b/.test(inner)) return 'linked data'
  const escaped = escapeXml(sheetName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const elsewhere = pkg.content.slice(0, table.start) + pkg.content.slice(table.end)
  if (new RegExp(`<(table:database-range|table:data-pilot-table)\\b[^>]*${escaped}`).test(elsewhere)) return 'a pivot table or database range'
  if (new RegExp(`draw:notify-on-update-of-ranges="[^"]*${escaped}`).test(pkg.content)) return 'a chart that reads this sheet'
  return null
}
