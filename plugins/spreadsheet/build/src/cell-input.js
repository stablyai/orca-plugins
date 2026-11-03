// What a person types into a cell, as a cell: a formula, a number, TRUE/FALSE or text. Number
// formats come from the cell being replaced, so a typed 12 in a currency cell reads $12.00.
import { SSF } from 'xlsx'
import { CellError, formatGeneral, parseFormula } from './formula-eval.js'
import { normalizeSeparators } from './formula-tokens.js'

const ERROR_CODES = { '#NULL!': 0, '#DIV/0!': 7, '#VALUE!': 15, '#REF!': 23, '#NAME?': 29, '#NUM!': 36, '#N/A': 42, '#GETTING_DATA': 43 }
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/
const GROUPED = /^[-+]?\d{1,3}(,\d{3})+(\.\d*)?$/

/**
 * @returns {{ cell: object | null } | { error: string }} `cell` null clears the cell.
 */
export function cellFromInput(text, previous) {
  const z = previous?.z
  if (text === '') return { cell: null }
  if (text.startsWith('=') && text.length > 1) {
    let f
    try {
      f = normalizeSeparators(text.slice(1))
      parseFormula(f)
    } catch {
      return { error: 'invalid-formula' }
    }
    return { cell: withFormat({ t: 'n', f, v: undefined }, z) }
  }
  if (text.startsWith("'")) return { cell: { t: 's', v: text.slice(1), w: text.slice(1), z } }
  const upper = text.trim().toUpperCase()
  if (upper === 'TRUE' || upper === 'FALSE') return { cell: { t: 'b', v: upper === 'TRUE', w: upper, z } }
  if (upper in ERROR_CODES) return { cell: { t: 'e', v: ERROR_CODES[upper], w: upper, z } }
  const number = parseNumber(text.trim())
  if (number !== null) return { cell: withFormat({ t: 'n', v: number }, z) }
  return { cell: { t: 's', v: text, w: text, z } }
}

function parseNumber(text) {
  let body = text
  let scale = 1
  if (body.endsWith('%')) {
    body = body.slice(0, -1).trim()
    scale = 0.01
  }
  if (GROUPED.test(body)) body = body.replace(/,/g, '')
  if (!NUMBER.test(body)) return null
  const value = Number(body) * scale
  return Number.isFinite(value) ? Number(value.toPrecision(15)) : null
}

/** Sets `.w`, the text Excel shows, from the value and the cell's number format. */
export function withFormat(cell, z) {
  if (z !== undefined) cell.z = z
  cell.w = displayText(cell)
  return cell
}

export function displayText(cell) {
  if (cell.v === undefined || cell.v === null) return ''
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE'
  if (cell.t === 'e') return Object.keys(ERROR_CODES).find((key) => ERROR_CODES[key] === cell.v) ?? '#VALUE!'
  if (cell.t === 'n') {
    if (cell.z && cell.z !== 'General') {
      try {
        return SSF.format(cell.z, cell.v)
      } catch {
        return formatGeneral(cell.v)
      }
    }
    return formatGeneral(cell.v)
  }
  return String(cell.v)
}

/** A calculated value as a cell's `t` and `v`. */
export function storeResult(cell, value) {
  if (value instanceof CellError) {
    cell.t = 'e'
    cell.v = ERROR_CODES[value.code] ?? 15
  } else if (typeof value === 'number') {
    cell.t = 'n'
    cell.v = value
  } else if (typeof value === 'boolean') {
    cell.t = 'b'
    cell.v = value
  } else {
    cell.t = 's'
    cell.v = String(value ?? '')
  }
  cell.w = displayText(cell)
}

/** A cell's value as the calculator reads it. */
export function cellValue(cell) {
  if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) return cell?.f && cell.t === 's' ? '' : null
  switch (cell.t) {
    case 'n':
    case 'd':
      return typeof cell.v === 'number' ? cell.v : Number(cell.v)
    case 'b':
      return Boolean(cell.v)
    case 'e':
      return new CellError(Object.keys(ERROR_CODES).find((key) => ERROR_CODES[key] === cell.v) ?? '#VALUE!')
    default:
      return String(cell.v)
  }
}

/** The text an edit box starts with: the formula, or the value as it would be typed. */
export function editText(cell) {
  if (!cell) return ''
  if (typeof cell.f === 'string' && cell.f !== '') return `=${cell.f}`
  if (cell.v === undefined || cell.v === null) return ''
  if (cell.t === 'n') {
    if (cell.z && /%/.test(cell.z)) return `${formatGeneral(Number((cell.v * 100).toPrecision(15)))}%`
    return formatGeneral(cell.v)
  }
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE'
  if (cell.t === 'e') return displayText(cell)
  const text = String(cell.v)
  // Text that would read back as something else keeps Excel's leading apostrophe.
  const reread = cellFromInput(text)
  return reread.cell && (reread.cell.t !== 's' || reread.cell.v !== text) ? `'${text}` : text
}
