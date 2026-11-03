// Moves references when rows or columns are inserted or deleted, the way Excel does: references at or
// after the change move, ranges grow or shrink, and a reference whose cells were all deleted becomes
// #REF!.
import { tokenize, untokenize } from './formula-tokens.js'

/**
 * @typedef {{ sheet: string, axis: 'row' | 'column', at: number, count: number }} Shift
 *   `count` above 0 inserts that many before index `at`; below 0 deletes that many from `at`.
 */

/** One index after the shift, or null when it was deleted. */
export function shiftIndex(index, { at, count }) {
  if (count > 0) return index >= at ? index + count : index
  const removed = -count
  if (index < at) return index
  if (index >= at + removed) return index - removed
  return null
}

/** An inclusive span after the shift, or null when every index in it was deleted. */
export function shiftSpan(first, last, shift) {
  const lo = Math.min(first, last)
  const hi = Math.max(first, last)
  if (shift.count > 0) return [shiftIndex(lo, shift), shiftIndex(hi, shift)]
  const removed = -shift.count
  const end = shift.at + removed
  if (lo >= shift.at && hi < end) return null
  const nextLo = lo < shift.at ? lo : lo >= end ? lo - removed : shift.at
  const nextHi = hi < shift.at ? hi : hi >= end ? hi - removed : shift.at - 1
  return [nextLo, nextHi]
}

const KEY = { row: 'r', column: 'c' }

/** Moves one parsed reference in place; true when it changed. Sets `error` when it was deleted. */
export function shiftReference(token, shift) {
  const key = KEY[shift.axis]
  // Whole columns do not move when rows change, nor whole rows when columns do.
  if ((token.kind === 'columns' && key === 'r') || (token.kind === 'rows' && key === 'c')) return false
  if (token.b) {
    const span = shiftSpan(token.a[key], token.b[key], shift)
    if (!span) {
      token.error = true
      return true
    }
    const forward = token.a[key] <= token.b[key]
    const [lo, hi] = span
    const changed = token.a[key] !== (forward ? lo : hi) || token.b[key] !== (forward ? hi : lo)
    token.a[key] = forward ? lo : hi
    token.b[key] = forward ? hi : lo
    return changed
  }
  const next = shiftIndex(token.a[key], shift)
  if (next === null) {
    token.error = true
    return true
  }
  const changed = next !== token.a[key]
  token.a[key] = next
  return changed
}

/**
 * The formula with its references to `shift.sheet` moved. `hostSheet` is the sheet the formula is
 * on, which its references without a sheet name point to. Returns the same string when nothing
 * moved, and the formula unchanged when it cannot be read.
 */
export function shiftFormula(formula, hostSheet, shift) {
  let tokens
  try {
    tokens = tokenize(formula)
  } catch {
    return formula
  }
  let changed = false
  const target = shift.sheet.toUpperCase()
  for (const token of tokens) {
    if (token.type !== 'ref' || token.error || token.sheetEnd) continue
    if ((token.sheet ?? hostSheet).toUpperCase() !== target) continue
    if (shiftReference(token, shift)) changed = true
  }
  return changed ? untokenize(tokens) : formula
}

/** A space-separated list of ranges (`sqref`) after the shift; '' when every range was deleted. */
export function shiftSqref(sqref, shift) {
  return sqref
    .split(/\s+/)
    .filter(Boolean)
    .map((range) => {
      const shifted = shiftFormula(range, '\u0000', { ...shift, sheet: '\u0000' })
      return shifted.includes('#REF!') ? null : shifted
    })
    .filter(Boolean)
    .join(' ')
}
