// Excel formula text (without the leading `=`) as tokens, and back. References are parsed so rows and
// columns can be shifted and evaluated; everything else round-trips as the text it was.

const MAX_ROW = 1_048_575
const MAX_COLUMN = 16_383
const ERRORS = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!']

// One cell part: `$A$1`, a column `$A`, or a row `$1`.
const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/
const COLUMN = /^(\$?)([A-Za-z]{1,3})/
const ROW = /^(\$?)(\d{1,7})/
const WORD_CHAR = /[A-Za-z0-9_.\\?À-￿]/
const SHEET_UNQUOTED = /^([A-Za-z_\\À-￿][A-Za-z0-9_.À-￿]*)(?::([A-Za-z_\\À-￿][A-Za-z0-9_.À-￿]*))?!/
const SHEET_QUOTED = /^'((?:[^']|'')+)'!/
const NUMBER = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/

export function columnIndex(letters) {
  let column = 0
  for (const letter of letters.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64
  return column - 1
}

/** A sheet name as a formula writes it: quoted when it is not a plain word. */
export function quoteSheet(name) {
  return /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(TRUE|FALSE)$/i.test(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`
}

function readPart(text, kind) {
  if (kind === 'cell') {
    const m = CELL.exec(text)
    if (!m) return null
    const c = columnIndex(m[2])
    const r = Number(m[4]) - 1
    if (c > MAX_COLUMN || r < 0 || r > MAX_ROW) return null
    return { length: m[0].length, part: { c, r, ac: m[1] === '$', ar: m[3] === '$' } }
  }
  if (kind === 'column') {
    const m = COLUMN.exec(text)
    if (!m) return null
    const c = columnIndex(m[2])
    if (c > MAX_COLUMN) return null
    return { length: m[0].length, part: { c, ac: m[1] === '$' } }
  }
  const m = ROW.exec(text)
  if (!m) return null
  const r = Number(m[2]) - 1
  if (r < 0 || r > MAX_ROW) return null
  return { length: m[0].length, part: { r, ar: m[1] === '$' } }
}

/** A reference at the start of `text` (after any sheet prefix): A1, A1:B2, A:B or 1:2. */
function readReference(text) {
  const boundary = (at) => at >= text.length || !WORD_CHAR.test(text[at]) && text[at] !== '(' && text[at] !== '!'
  for (const kind of ['cell', 'column', 'row']) {
    const first = readPart(text, kind)
    if (!first) continue
    if (text[first.length] === ':') {
      const second = readPart(text.slice(first.length + 1), kind)
      const end = first.length + 1 + (second?.length ?? 0)
      if (second && boundary(end)) {
        return { length: end, ref: { kind: kind === 'cell' ? 'area' : kind === 'column' ? 'columns' : 'rows', a: first.part, b: second.part } }
      }
    }
    if (kind === 'cell' && boundary(first.length)) return { length: first.length, ref: { kind: 'cell', a: first.part } }
  }
  return null
}

/**
 * @typedef {{ type: 'ref', sheet: string | null, sheetEnd?: string, kind: 'cell' | 'area' | 'columns' | 'rows',
 *   a: object, b?: object, prefix: string }} RefToken
 * @typedef {RefToken | { type: 'number' | 'string' | 'bool' | 'error' | 'func' | 'name' | 'op' | 'paren' |
 *   'comma' | 'space' | 'opaque', text: string, value?: unknown }} Token
 * @returns {Token[]} or throws on text no formula can contain.
 */
export function tokenize(formula) {
  const tokens = []
  let at = 0
  while (at < formula.length) {
    const rest = formula.slice(at)
    const ch = rest[0]
    if (/\s/.test(ch)) {
      const m = /^\s+/.exec(rest)
      tokens.push({ type: 'space', text: m[0] })
      at += m[0].length
      continue
    }
    if (ch === '"') {
      let end = 1
      for (;;) {
        const quote = rest.indexOf('"', end)
        if (quote < 0) throw new SyntaxError('unterminated string')
        if (rest[quote + 1] === '"') end = quote + 2
        else {
          end = quote + 1
          break
        }
      }
      const text = rest.slice(0, end)
      tokens.push({ type: 'string', text, value: text.slice(1, -1).replace(/""/g, '"') })
      at += end
      continue
    }
    if (ch === '#') {
      const error = ERRORS.find((name) => rest.toUpperCase().startsWith(name))
      if (!error) throw new SyntaxError('unknown error value')
      tokens.push({ type: 'error', text: error, value: error })
      at += error.length
      continue
    }
    if (ch === '[' || ch === '{') {
      // External references and structured references keep their text; so do array constants.
      const close = ch === '[' ? ']' : '}'
      let depth = 0
      let end = 0
      for (; end < rest.length; end++) {
        if (rest[end] === ch) depth++
        else if (rest[end] === close && --depth === 0) break
      }
      if (depth !== 0) throw new SyntaxError('unbalanced brackets')
      // A workbook prefix like [1]Sheet1!A1 belongs to the reference that follows.
      let length = end + 1
      const tail = /^[^\s()+\-*/^&=<>,;%]*/.exec(rest.slice(length))[0]
      length += tail.length
      tokens.push({ type: 'opaque', text: rest.slice(0, length) })
      at += length
      continue
    }
    const sheetMatch = SHEET_QUOTED.exec(rest) ?? SHEET_UNQUOTED.exec(rest)
    if (sheetMatch) {
      const reference = readReference(rest.slice(sheetMatch[0].length))
      if (reference) {
        const quoted = rest[0] === "'"
        const name = quoted ? sheetMatch[1].replace(/''/g, "'") : sheetMatch[1]
        tokens.push({ type: 'ref', sheet: name, sheetEnd: quoted ? undefined : sheetMatch[2], prefix: sheetMatch[0], ...reference.ref })
        at += sheetMatch[0].length + reference.length
        continue
      }
    }
    const reference = readReference(rest)
    if (reference && !(reference.ref.kind === 'rows' && tokens.length > 0 && isValueEnd(tokens))) {
      tokens.push({ type: 'ref', sheet: null, prefix: '', ...reference.ref })
      at += reference.length
      continue
    }
    const number = NUMBER.exec(rest)
    if (number) {
      tokens.push({ type: 'number', text: number[0], value: Number(number[0]) })
      at += number[0].length
      continue
    }
    const word = /^[A-Za-z_\\À-￿][A-Za-z0-9_.\\?À-￿]*/.exec(rest)
    if (word) {
      const text = word[0]
      if (formula[at + text.length] === '(') tokens.push({ type: 'func', text, name: text.toUpperCase().replace(/^_XLFN\.(_XLWS\.)?/, '') })
      else if (/^(TRUE|FALSE)$/i.test(text)) tokens.push({ type: 'bool', text, value: text.toUpperCase() === 'TRUE' })
      else tokens.push({ type: 'name', text })
      at += text.length
      continue
    }
    const op = /^(<>|<=|>=|[-+*/^&=<>%:])/.exec(rest)
    if (op) {
      tokens.push({ type: 'op', text: op[0] })
      at += op[0].length
      continue
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', text: ch })
      at += 1
      continue
    }
    if (ch === ',' || ch === ';') {
      tokens.push({ type: 'comma', text: ch })
      at += 1
      continue
    }
    throw new SyntaxError(`unexpected ${ch}`)
  }
  return tokens
}

// Why: `1:2` after a value would be a number then a range operator; Excel never writes that, but
// `A1:B2` style ranges reached here only when the first part was a row.
function isValueEnd(tokens) {
  const last = [...tokens].reverse().find((token) => token.type !== 'space')
  return last && (last.type === 'number' || last.type === 'ref' || (last.type === 'paren' && last.text === ')'))
}

function columnLetters(column) {
  let name = ''
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

function partText(part, kind) {
  const column = part.c === undefined ? '' : `${part.ac ? '$' : ''}${columnLetters(part.c)}`
  const row = part.r === undefined ? '' : `${part.ar ? '$' : ''}${part.r + 1}`
  return kind === 'columns' ? column : kind === 'rows' ? row : column + row
}

export function referenceText(token) {
  if (token.error) return `${token.prefix}#REF!`
  const kind = token.kind === 'area' || token.kind === 'cell' ? 'cell' : token.kind
  const body = token.b ? `${partText(token.a, kind)}:${partText(token.b, kind)}` : partText(token.a, kind)
  return token.prefix + body
}

export function untokenize(tokens) {
  return tokens.map((token) => (token.type === 'ref' ? referenceText(token) : token.text)).join('')
}

/** The function names a formula calls, upper case, without `_xlfn.`. */
export function functionNames(tokens) {
  return tokens.filter((token) => token.type === 'func').map((token) => token.name)
}

// Functions newer than Excel 2007 are saved with the `_xlfn.` prefix; Excel shows them without it.
const FUTURE_FUNCTIONS = new Set([
  'AGGREGATE', 'ARABIC', 'BASE', 'BITAND', 'BITOR', 'BITXOR', 'CEILING.MATH', 'CONCAT', 'DAYS', 'DECIMAL',
  'FILTER', 'FLOOR.MATH', 'FORMULATEXT', 'IFNA', 'IFS', 'ISFORMULA', 'ISOWEEKNUM', 'LET', 'MAXIFS', 'MINIFS',
  'NUMBERVALUE', 'RANDARRAY', 'SEQUENCE', 'SHEET', 'SHEETS', 'SORT', 'SORTBY', 'STDEV.P', 'STDEV.S',
  'SWITCH', 'TEXTJOIN', 'UNICHAR', 'UNICODE', 'UNIQUE', 'XLOOKUP', 'XMATCH', 'XOR'
])

/** Formula text with `;` argument separators, as some locales type them, written as commas. */
export function normalizeSeparators(formula) {
  const tokens = tokenize(formula)
  for (const token of tokens) if (token.type === 'comma') token.text = ','
  return untokenize(tokens)
}

/** Formula text as the file stores it: `,` between arguments, `_xlfn.` where Excel expects it. */
export function toFileFormula(formula) {
  const tokens = tokenize(formula)
  for (const token of tokens) {
    if (token.type === 'comma') token.text = ','
    if (token.type === 'func' && FUTURE_FUNCTIONS.has(token.name) && !/^_xlfn\./i.test(token.text)) {
      token.text = `_xlfn.${token.text}`
    }
  }
  return untokenize(tokens)
}
