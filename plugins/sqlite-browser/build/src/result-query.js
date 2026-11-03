// SQL for the grid's column filters, search box and sort. No SQLite import, so the tests and the
// page share it.

/** `name` as a quoted SQL identifier. */
export const quoteId = (name) => `"${String(name).replaceAll('"', '""')}"`

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n
const COMPARISON = /^(>=|<=|!=|<>|=|>|<)\s*(.*)$/s

/**
 * A column filter as the person typed it: `text` keeps cells that contain it; `=x`, `!=x`, `>x`,
 * `>=x`, `<x` and `<=x` compare (numbers as numbers); `null` and `!null` test for NULL.
 * Returns null for an empty filter.
 */
export function parseFilter(input) {
  const text = String(input ?? '').trim()
  if (text === '') {
    return null
  }
  const lower = text.toLowerCase()
  if (lower === 'null' || lower === 'is null') {
    return { op: 'null' }
  }
  if (lower === '!null' || lower === 'not null' || lower === 'is not null') {
    return { op: 'notnull' }
  }
  const comparison = COMPARISON.exec(text)
  if (comparison && comparison[2] !== '') {
    const op = comparison[1] === '<>' ? '!=' : comparison[1]
    const raw = comparison[2]
    if (!NUMBER.test(raw)) return { op, value: raw }
    // Why text: Number() rounds integers past 2^53, such as 64-bit ids, so they would never match.
    // Past int64, CAST would clamp to its limit, so those compare as the (exact enough) real.
    const bigInteger =
      /^[-+]?\d+$/.test(raw) && !Number.isSafeInteger(Number(raw)) && BigInt(raw) >= INT64_MIN && BigInt(raw) <= INT64_MAX
    return { op, value: bigInteger ? raw : Number(raw), text: raw, integer: bigInteger }
  }
  return { op: 'contains', value: text }
}

/** A LIKE pattern that matches `text` anywhere, with `\` as the escape character. */
export const containsPattern = (text) => `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** `{ sql, params }` testing column expression `expr` against a parsed filter. */
export function filterCondition(expr, filter) {
  switch (filter.op) {
    case 'null':
      return { sql: `${expr} IS NULL`, params: [] }
    case 'notnull':
      return { sql: `${expr} IS NOT NULL`, params: [] }
    case 'contains':
      return textMatch(expr, filter.value)
    default: {
      const operand = filter.integer ? 'CAST(? AS INTEGER)' : '?'
      // Why both forms for = and !=: query results have no column affinity, so '90210' as text
      // would not equal the number 90210 there, as it does in its table.
      if (filter.text !== undefined && (filter.op === '=' || filter.op === '!=')) {
        const join = filter.op === '=' ? 'OR' : 'AND'
        return { sql: `(${expr} ${filter.op} ${operand} ${join} ${expr} ${filter.op} ?)`, params: [filter.value, filter.text] }
      }
      return { sql: `${expr} ${filter.op} ${operand}`, params: [filter.value] }
    }
  }
}

// Why not blobs: their bytes cast to text would match at random.
const textMatch = (expr, text) => ({
  sql: `(typeof(${expr}) <> 'blob' AND CAST(${expr} AS TEXT) LIKE ? ESCAPE '\\')`,
  params: [containsPattern(text)]
})

/**
 * The WHERE clause (or '') for per-column filters (`{ [columnIndex]: text }`) and a search that
 * keeps rows where any column contains the text; `exprs` are the column expressions.
 */
export function whereClause(exprs, filters = {}, search = '') {
  const parts = []
  const params = []
  for (const [index, text] of Object.entries(filters)) {
    const filter = parseFilter(text)
    const expr = exprs[Number(index)]
    if (filter && expr) {
      const condition = filterCondition(expr, filter)
      parts.push(condition.sql)
      params.push(...condition.params)
    }
  }
  const needle = String(search ?? '').trim()
  if (needle !== '' && exprs.length > 0) {
    const any = exprs.map((expr) => textMatch(expr, needle))
    parts.push(`(${any.map((condition) => condition.sql).join(' OR ')})`)
    any.forEach((condition) => params.push(...condition.params))
  }
  return { sql: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', params }
}

/** ORDER BY for `{ column, descending }` (or none), ending on `tiebreak` so ties keep file order. */
export function orderClause(exprs, sort, tiebreak) {
  const keys = []
  if (sort && exprs[sort.column]) {
    keys.push(`${exprs[sort.column]} ${sort.descending ? 'DESC' : 'ASC'}`)
  }
  if (keys.length > 0 && tiebreak) {
    keys.push(tiebreak)
  }
  return keys.length > 0 ? `ORDER BY ${keys.join(', ')}` : ''
}
