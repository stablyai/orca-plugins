// OpenDocument formulas (`of:=SUM([.A1:.B2])`) to and from the Excel spelling the editor shows, and
// moving their references when rows or columns change.
import { columnIndex, quoteSheet, tokenize } from './formula-tokens.js'
import { shiftReference } from './formula-shift.js'
import { columnName } from './address.js'

// One end of a reference: optional sheet (`$Sheet1`, `'My sheet'`), a dot, then `$A$1`.
const END = /^(\$?)('(?:[^']|'')+'|[^.'[\]:\s]+)?\.(\$?)([A-Za-z]{1,3})(\$?)(\d+)/

function readEnd(text) {
  const m = END.exec(text)
  if (!m) return null
  const sheet = m[2] === undefined ? null : m[2].startsWith("'") ? m[2].slice(1, -1).replace(/''/g, "'") : m[2]
  return {
    length: m[0].length,
    sheet,
    sheetAbs: m[1] === '$',
    part: { c: columnIndex(m[4]), r: Number(m[6]) - 1, ac: m[3] === '$', ar: m[5] === '$' }
  }
}

/** `Sheet1.A1:.B2` (no brackets) as a reference, or null. */
export function parseOdfRange(text) {
  const a = readEnd(text)
  if (!a) return null
  let rest = text.slice(a.length)
  let b = null
  if (rest.startsWith(':')) {
    b = readEnd(rest.slice(1))
    if (!b) return null
    rest = rest.slice(1 + b.length)
  }
  if (rest !== '') return null
  return { a, b }
}

const sheetText = (name, abs) => (name === null ? '' : `${abs ? '$' : ''}${/^[A-Za-z_][\w]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`}`)
const partText = (part) => `${part.ac ? '$' : ''}${columnName(part.c)}${part.ar ? '$' : ''}${part.r + 1}`

function rangeText(range) {
  const a = `${sheetText(range.a.sheet, range.a.sheetAbs)}.${partText(range.a.part)}`
  if (!range.b) return a
  return `${a}:${sheetText(range.b.sheet, range.b.sheetAbs)}.${partText(range.b.part)}`
}

/** Moves the references in one ODF range text; null when its cells were all deleted. */
function shiftRange(text, hostSheet, shift) {
  const range = parseOdfRange(text)
  if (!range) return text
  const sheet = range.a.sheet ?? hostSheet
  if (sheet.toUpperCase() !== shift.sheet.toUpperCase()) return text
  if (range.b?.sheet && range.b.sheet.toUpperCase() !== sheet.toUpperCase()) return text
  const token = { kind: range.b ? 'area' : 'cell', a: range.a.part, b: range.b?.part }
  if (!shiftReference(token, shift)) return text
  if (token.error) return null
  return rangeText(range)
}

/** An ODF formula with its references to `shift.sheet` moved; deleted ones become #REF!. */
export function shiftOdfFormula(formula, hostSheet, shift) {
  return mapOutsideStrings(formula, (part) =>
    part.replace(/\[([^\[\]]+)\]/g, (whole, inner) => {
      const next = shiftRange(inner, hostSheet, shift)
      return next === null ? '[.#REF!]' : next === inner ? whole : `[${next}]`
    })
  )
}

/** A space-separated list of ODF ranges (`table:cell-range-address`) after the shift. */
export function shiftOdfRangeList(text, hostSheet, shift) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((range) => shiftRange(range, hostSheet, shift))
    .filter((range) => range !== null)
    .join(' ')
}

function mapOutsideStrings(formula, map) {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, index) => (index % 2 === 1 ? part : map(part)))
    .join('')
}

/** The Excel spelling of an ODF formula, as the formula bar shows it. */
export function odfToExcel(formula) {
  let text = formula.replace(/^(of|oooc|msoxl):/i, '').replace(/^=+/, '')
  text = mapOutsideStrings(text, (part) =>
    part
      .replace(/\[([^\[\]]+)\]/g, (whole, inner) => {
        const range = parseOdfRange(inner)
        if (!range) return inner === '.#REF!' ? '#REF!' : whole
        const prefix = range.a.sheet === null ? '' : `${quoteSheet(range.a.sheet)}!`
        const a = partText(range.a.part)
        return range.b ? `${prefix}${a}:${partText(range.b.part)}` : `${prefix}${a}`
      })
      .replace(/;/g, ',')
      .replace(/~/g, ',')
  )
  return text
}

/** The ODF spelling (`of:=…`) of a formula typed in Excel's. */
export function excelToOdf(formula) {
  const tokens = tokenize(formula)
  let text = ''
  for (const token of tokens) {
    if (token.type === 'ref') {
      if (token.error) {
        text += '[.#REF!]'
        continue
      }
      const sheet = token.sheet === null ? '' : sheetText(token.sheet, false)
      let a = token.a
      let b = token.b
      if (token.kind === 'columns') {
        a = { ...a, r: 0, ar: false }
        b = { ...b, r: 1_048_575, ar: false }
      } else if (token.kind === 'rows') {
        a = { ...a, c: 0, ac: false }
        b = { ...b, c: 16_383, ac: false }
      }
      text += b ? `[${sheet}.${partText(a)}:.${partText(b)}]` : `[${sheet}.${partText(a)}]`
    } else if (token.type === 'comma') {
      text += ';'
    } else if (token.type === 'func') {
      text += token.text.replace(/^_xlfn\.(_xlws\.)?/i, '')
    } else {
      text += token.text
    }
  }
  return `of:=${text}`
}
