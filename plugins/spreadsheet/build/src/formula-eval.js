// Calculates the formulas people type most: arithmetic, comparisons, text joins, references and
// ranges, and the common functions below. Anything else throws Unsupported, and the cell keeps the
// result saved in the file; desktop spreadsheet apps recalculate every formula when they open it.
import { tokenize } from './formula-tokens.js'

export class Unsupported extends Error {}

/** An Excel error value such as #DIV/0!, thrown through the calculation and caught at its end. */
export class CellError {
  constructor(code) {
    this.code = code
  }
}

const fail = (code) => {
  throw new CellError(code)
}

// --- Parsing ---------------------------------------------------------------------------------

/** The formula as a tree, or throws SyntaxError. */
export function parseFormula(formula) {
  const tokens = tokenize(formula).filter((token) => token.type !== 'space')
  let at = 0
  const peek = () => tokens[at]
  const isOp = (...ops) => peek()?.type === 'op' && ops.includes(peek().text)
  const next = () => tokens[at++]

  function comparison() {
    let node = concat()
    while (isOp('=', '<>', '<', '>', '<=', '>=')) node = { k: 'bin', op: next().text, a: node, b: concat() }
    return node
  }
  function concat() {
    let node = additive()
    while (isOp('&')) node = { k: 'bin', op: next().text, a: node, b: additive() }
    return node
  }
  function additive() {
    let node = multiplicative()
    while (isOp('+', '-')) node = { k: 'bin', op: next().text, a: node, b: multiplicative() }
    return node
  }
  function multiplicative() {
    let node = power()
    while (isOp('*', '/')) node = { k: 'bin', op: next().text, a: node, b: power() }
    return node
  }
  function power() {
    let node = unary()
    while (isOp('^')) node = { k: 'bin', op: next().text, a: node, b: unary() }
    return node
  }
  function unary() {
    if (isOp('-', '+')) {
      const op = next().text
      return { k: 'unary', op, a: unary() }
    }
    return percent()
  }
  function percent() {
    let node = primary()
    while (isOp('%')) {
      next()
      node = { k: 'pct', a: node }
    }
    return node
  }
  function primary() {
    const token = next()
    if (!token) throw new SyntaxError('unexpected end')
    switch (token.type) {
      case 'number':
        return { k: 'num', v: token.value }
      case 'string':
        return { k: 'str', v: token.value }
      case 'bool':
        return { k: 'bool', v: token.value }
      case 'error':
        return { k: 'err', v: token.value }
      case 'ref':
        return { k: 'ref', ref: token }
      case 'name':
      case 'opaque':
        return { k: 'unsupported' }
      case 'func': {
        if (next()?.text !== '(') throw new SyntaxError('expected (')
        const args = []
        if (peek()?.text !== ')') {
          for (;;) {
            args.push(peek()?.type === 'comma' || peek()?.text === ')' ? { k: 'blank' } : comparison())
            if (peek()?.type === 'comma') {
              next()
              continue
            }
            break
          }
        }
        if (next()?.text !== ')') throw new SyntaxError('expected )')
        return { k: 'call', name: token.name, args }
      }
      case 'paren':
        if (token.text === '(') {
          const node = comparison()
          if (next()?.text !== ')') throw new SyntaxError('expected )')
          return node
        }
        break
    }
    throw new SyntaxError(`unexpected ${token.text}`)
  }

  const tree = comparison()
  if (at < tokens.length) throw new SyntaxError(`unexpected ${tokens[at].text}`)
  return tree
}

// --- Values ----------------------------------------------------------------------------------

/**
 * @typedef {{ value(sheet: string, r: number, c: number): unknown, extent(sheet: string): { rows: number,
 *   columns: number } | null }} Resolver  `value` returns a number, string, boolean, CellError or null.
 */

function toNumber(value) {
  if (value instanceof CellError) throw value
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(String(value).trim())
  if (String(value).trim() !== '' && Number.isFinite(parsed)) return parsed
  return fail('#VALUE!')
}

function toText(value) {
  if (value instanceof CellError) throw value
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return formatGeneral(value)
  return String(value)
}

function toBool(value) {
  if (value instanceof CellError) throw value
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (value === null || value === undefined) return false
  const upper = String(value).toUpperCase()
  if (upper === 'TRUE') return true
  if (upper === 'FALSE') return false
  return fail('#VALUE!')
}

/** Numbers as Excel's General format writes them in text: up to 15 significant digits. */
export function formatGeneral(value) {
  if (!Number.isFinite(value)) return String(value)
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  const fixed = Number(value.toPrecision(15))
  return String(fixed)
}

function check(number) {
  if (!Number.isFinite(number)) fail('#NUM!')
  return number
}

const rank = (value) => (typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : typeof value === 'boolean' ? 2 : 0)

function compare(a, b) {
  if (a === null || a === undefined) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0
  if (b === null || b === undefined) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (typeof a === 'string') {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  }
  return a < b ? -1 : a > b ? 1 : 0
}

// --- Evaluation ------------------------------------------------------------------------------

/**
 * The formula's result for a cell on `hostSheet`: a number, string, boolean or CellError. Throws
 * Unsupported for anything this calculator does not know, and SyntaxError for text that is no
 * formula.
 * @param {Resolver} resolver
 */
export function evaluateFormula(tree, hostSheet, resolver) {
  const context = { host: hostSheet, resolver }
  try {
    const result = scalar(evaluate(tree, context), context)
    return result === null || result === undefined ? 0 : result
  } catch (error) {
    if (error instanceof CellError) return error
    throw error
  }
}

function rangeOf(ref, context) {
  if (ref.error) return fail('#REF!')
  if (ref.sheetEnd) throw new Unsupported('3D reference')
  const sheet = ref.sheet ?? context.host
  const extent = context.resolver.extent(sheet)
  if (!extent) return fail('#REF!')
  const lastRow = Math.max(0, extent.rows - 1)
  const lastColumn = Math.max(0, extent.columns - 1)
  const a = ref.a
  const b = ref.b ?? ref.a
  const r0 = ref.kind === 'columns' ? 0 : Math.min(a.r, b.r)
  const r1 = ref.kind === 'columns' ? lastRow : Math.max(a.r, b.r)
  const c0 = ref.kind === 'rows' ? 0 : Math.min(a.c, b.c)
  const c1 = ref.kind === 'rows' ? lastColumn : Math.max(a.c, b.c)
  return { sheet, r0, c0, r1, c1 }
}

function evaluate(node, context) {
  switch (node.k) {
    case 'num':
    case 'str':
    case 'bool':
      return node.v
    case 'err':
      return fail(node.v)
    case 'blank':
      return null
    case 'ref': {
      const range = rangeOf(node.ref, context)
      return node.ref.kind === 'cell' ? cellValue(context, range.sheet, range.r0, range.c0) : { range }
    }
    case 'unary': {
      const value = toNumber(scalar(evaluate(node.a, context), context))
      return node.op === '-' ? -value : value
    }
    case 'pct':
      return toNumber(scalar(evaluate(node.a, context), context)) / 100
    case 'bin':
      return binary(node.op, scalar(evaluate(node.a, context), context), scalar(evaluate(node.b, context), context))
    case 'call': {
      const fn = FUNCTIONS[node.name]
      if (!fn) throw new Unsupported(node.name)
      return fn(node.args, context)
    }
    default:
      throw new Unsupported(node.k)
  }
}

function cellValue(context, sheet, r, c) {
  const value = context.resolver.value(sheet, r, c)
  return value === undefined ? null : value
}

/** A range used where one value is expected: its only cell, else #VALUE!. */
function scalar(value, context) {
  if (value && typeof value === 'object' && 'range' in value) {
    const { sheet, r0, c0, r1, c1 } = value.range
    if (r0 === r1 && c0 === c1) return cellValue(context, sheet, r0, c0)
    return fail('#VALUE!')
  }
  return value
}

function binary(op, a, b) {
  if (a instanceof CellError) throw a
  if (b instanceof CellError) throw b
  switch (op) {
    case '+':
      return check(toNumber(a) + toNumber(b))
    case '-':
      return check(toNumber(a) - toNumber(b))
    case '*':
      return check(toNumber(a) * toNumber(b))
    case '/': {
      const divisor = toNumber(b)
      const dividend = toNumber(a)
      return divisor === 0 ? fail('#DIV/0!') : check(dividend / divisor)
    }
    case '^':
      return check(toNumber(a) ** toNumber(b))
    case '&':
      return toText(a) + toText(b)
    case '=':
      return compare(a, b) === 0
    case '<>':
      return compare(a, b) !== 0
    case '<':
      return compare(a, b) < 0
    case '>':
      return compare(a, b) > 0
    case '<=':
      return compare(a, b) <= 0
    case '>=':
      return compare(a, b) >= 0
  }
  throw new Unsupported(op)
}

/** Every value an argument holds: a range's cells (`inRange` true) or the one value. */
function* values(arg, context) {
  const value = evaluate(arg, context)
  if (value && typeof value === 'object' && 'range' in value) {
    const { sheet, r0, c0, r1, c1 } = value.range
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) yield { value: cellValue(context, sheet, r, c), inRange: true }
    }
  } else {
    yield { value, inRange: false }
  }
}

/** Numbers as SUM reads them: range cells only when numeric, typed values coerced. */
function numbers(args, context) {
  const out = []
  for (const arg of args) {
    for (const { value, inRange } of values(arg, context)) {
      if (value instanceof CellError) throw value
      if (inRange) {
        if (typeof value === 'number') out.push(value)
      } else if (value !== null) {
        out.push(toNumber(value))
      }
    }
  }
  return out
}

const arg = (args, index, context) => (args[index] ? scalar(evaluate(args[index], context), context) : null)
const needs = (args, min, max = min) => {
  if (args.length < min || args.length > max) fail('#VALUE!')
}

function round(value, digits, mode) {
  const factor = 10 ** digits
  const scaled = Math.abs(value) * factor
  // Why the epsilon: 1.005 is 1.00499999… in binary, and Excel still rounds it to 1.01.
  const nudged = Number((scaled).toPrecision(15))
  const rounded = mode === 'up' ? Math.ceil(nudged) : mode === 'down' ? Math.floor(nudged) : Math.round(nudged)
  return (Math.sign(value) * rounded) / factor
}

/** COUNTIF-style criteria: ">5", "<>x", "=a", "abc*", or a plain value. */
function matcher(criterion) {
  if (typeof criterion === 'number' || typeof criterion === 'boolean') return (value) => compare(value, criterion) === 0 && value !== null
  const text = toText(criterion)
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(text)
  const op = m[1] ?? '='
  const operand = m[2]
  const numeric = operand.trim() !== '' && Number.isFinite(Number(operand)) ? Number(operand) : null
  if (numeric !== null) {
    return (value) => {
      if (typeof value !== 'number') return op === '<>'
      return binary(op, value, numeric)
    }
  }
  if ((op === '=' || op === '<>') && /[*?]/.test(operand)) {
    const pattern = new RegExp(`^${operand.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\u0001').replace(/~\?/g, '\u0002').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\u0001/g, '\\*').replace(/\u0002/g, '\\?')}$`, 'is')
    return (value) => pattern.test(toText(value)) === (op === '=')
  }
  if (op === '=' && operand === '') return (value) => value === null || value === ''
  return (value) => (typeof value === 'string' || value === null ? binary(op, value ?? '', operand) : op === '<>')
}

function rangeCells(argNode, context) {
  const value = evaluate(argNode, context)
  if (!(value && typeof value === 'object' && 'range' in value)) return fail('#VALUE!')
  return value.range
}

function conditional(args, context, reduce) {
  const range = rangeCells(args[0], context)
  const test = matcher(arg(args, 1, context))
  const target = args[2] ? rangeCells(args[2], context) : range
  const picked = []
  for (let r = 0; r <= range.r1 - range.r0; r++) {
    for (let c = 0; c <= range.c1 - range.c0; c++) {
      const value = cellValue(context, range.sheet, range.r0 + r, range.c0 + c)
      if (value instanceof CellError) continue
      if (test(value)) picked.push(cellValue(context, target.sheet, target.r0 + r, target.c0 + c))
    }
  }
  return reduce(picked)
}

const sum = (list) => list.reduce((total, value) => total + value, 0)

const FUNCTIONS = {
  SUM: (args, context) => check(sum(numbers(args, context))),
  PRODUCT: (args, context) => check(numbers(args, context).reduce((total, value) => total * value, 1)),
  AVERAGE: (args, context) => {
    const list = numbers(args, context)
    return list.length ? sum(list) / list.length : fail('#DIV/0!')
  },
  MIN: (args, context) => {
    const list = numbers(args, context)
    return list.length ? Math.min(...list) : 0
  },
  MAX: (args, context) => {
    const list = numbers(args, context)
    return list.length ? Math.max(...list) : 0
  },
  COUNT: (args, context) => {
    let count = 0
    for (const node of args) {
      for (const { value, inRange } of values(node, context)) {
        if (typeof value === 'number' || (!inRange && value !== null && !(value instanceof CellError) && typeof value !== 'string')) count++
        else if (!inRange && typeof value === 'string' && Number.isFinite(Number(value)) && value.trim() !== '') count++
      }
    }
    return count
  },
  COUNTA: (args, context) => {
    let count = 0
    for (const node of args) for (const { value } of values(node, context)) if (value !== null && value !== '') count++
    return count
  },
  COUNTBLANK: (args, context) => {
    let count = 0
    for (const { value } of values(args[0], context)) if (value === null || value === '') count++
    return count
  },
  COUNTIF: (args, context) => (needs(args, 2), conditional(args, context, (list) => list.length)),
  SUMIF: (args, context) => {
    needs(args, 2, 3)
    return conditional(args, context, (list) => sum(list.filter((value) => typeof value === 'number')))
  },
  AVERAGEIF: (args, context) => {
    needs(args, 2, 3)
    return conditional(args, context, (list) => {
      const found = list.filter((value) => typeof value === 'number')
      return found.length ? sum(found) / found.length : fail('#DIV/0!')
    })
  },
  IF: (args, context) => {
    needs(args, 1, 3)
    const condition = toBool(arg(args, 0, context))
    const branch = condition ? args[1] : args[2]
    if (!branch) return condition ? true : false
    return scalar(evaluate(branch, context), context) ?? 0
  },
  IFERROR: (args, context) => {
    needs(args, 2)
    try {
      const value = arg(args, 0, context)
      if (value instanceof CellError) throw value
      return value
    } catch (error) {
      if (error instanceof CellError) return arg(args, 1, context)
      throw error
    }
  },
  AND: (args, context) => {
    const list = []
    for (const node of args) for (const { value } of values(node, context)) if (value !== null && typeof value !== 'string') list.push(toBool(value))
    return list.length ? list.every(Boolean) : fail('#VALUE!')
  },
  OR: (args, context) => {
    const list = []
    for (const node of args) for (const { value } of values(node, context)) if (value !== null && typeof value !== 'string') list.push(toBool(value))
    return list.length ? list.some(Boolean) : fail('#VALUE!')
  },
  NOT: (args, context) => (needs(args, 1), !toBool(arg(args, 0, context))),
  ABS: (args, context) => (needs(args, 1), Math.abs(toNumber(arg(args, 0, context)))),
  INT: (args, context) => (needs(args, 1), Math.floor(toNumber(arg(args, 0, context)))),
  SQRT: (args, context) => {
    needs(args, 1)
    const value = toNumber(arg(args, 0, context))
    return value < 0 ? fail('#NUM!') : Math.sqrt(value)
  },
  POWER: (args, context) => (needs(args, 2), check(toNumber(arg(args, 0, context)) ** toNumber(arg(args, 1, context)))),
  MOD: (args, context) => {
    needs(args, 2)
    const n = toNumber(arg(args, 0, context))
    const d = toNumber(arg(args, 1, context))
    return d === 0 ? fail('#DIV/0!') : n - d * Math.floor(n / d)
  },
  ROUND: (args, context) => (needs(args, 2), round(toNumber(arg(args, 0, context)), Math.trunc(toNumber(arg(args, 1, context))), 'half')),
  ROUNDUP: (args, context) => (needs(args, 2), round(toNumber(arg(args, 0, context)), Math.trunc(toNumber(arg(args, 1, context))), 'up')),
  ROUNDDOWN: (args, context) => (needs(args, 2), round(toNumber(arg(args, 0, context)), Math.trunc(toNumber(arg(args, 1, context))), 'down')),
  PI: (args) => (needs(args, 0), Math.PI),
  CONCATENATE: (args, context) => args.map((_, index) => toText(arg(args, index, context))).join(''),
  CONCAT: (args, context) => {
    let text = ''
    for (const node of args) for (const { value } of values(node, context)) text += toText(value)
    return text
  },
  LEN: (args, context) => (needs(args, 1), toText(arg(args, 0, context)).length),
  UPPER: (args, context) => (needs(args, 1), toText(arg(args, 0, context)).toUpperCase()),
  LOWER: (args, context) => (needs(args, 1), toText(arg(args, 0, context)).toLowerCase()),
  TRIM: (args, context) => (needs(args, 1), toText(arg(args, 0, context)).trim().replace(/ {2,}/g, ' ')),
  LEFT: (args, context) => {
    needs(args, 1, 2)
    const count = args[1] ? toNumber(arg(args, 1, context)) : 1
    return count < 0 ? fail('#VALUE!') : toText(arg(args, 0, context)).slice(0, count)
  },
  RIGHT: (args, context) => {
    needs(args, 1, 2)
    const count = args[1] ? toNumber(arg(args, 1, context)) : 1
    if (count < 0) return fail('#VALUE!')
    const text = toText(arg(args, 0, context))
    return count === 0 ? '' : text.slice(-count)
  },
  MID: (args, context) => {
    needs(args, 3)
    const start = toNumber(arg(args, 1, context))
    const count = toNumber(arg(args, 2, context))
    if (start < 1 || count < 0) return fail('#VALUE!')
    return toText(arg(args, 0, context)).slice(start - 1, start - 1 + count)
  },
  ISBLANK: (args, context) => (needs(args, 1), arg(args, 0, context) === null),
  ISNUMBER: (args, context) => (needs(args, 1), typeof safe(() => arg(args, 0, context)) === 'number'),
  ISTEXT: (args, context) => (needs(args, 1), typeof safe(() => arg(args, 0, context)) === 'string'),
  ISERROR: (args, context) => (needs(args, 1), safe(() => arg(args, 0, context)) instanceof CellError)
}

function safe(read) {
  try {
    return read()
  } catch (error) {
    if (error instanceof CellError) return error
    throw error
  }
}
