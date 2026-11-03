// What an operation log means for the file's XML: per sheet, the row and column shifts (to move the
// file's own cells to where they are now) and the cells an edit touched, at their final positions.
import { shiftIndex } from './formula-shift.js'

/**
 * @returns {{ sheets: Map<string, { shifts: object[], touched: Set<string> }>, shifts: object[] }}
 *   Sheet keys are upper-case names; `shifts` lists every shift in order, with its sheet.
 */
export function planEdits(ops) {
  const sheets = new Map()
  const shifts = []
  const sheetPlan = (name) => {
    const key = name.toUpperCase()
    let plan = sheets.get(key)
    if (!plan) sheets.set(key, (plan = { shifts: [], touched: new Set() }))
    return plan
  }
  for (const op of ops) {
    const plan = sheetPlan(op.sheet)
    if (op.type === 'cells') {
      for (const { r, c } of op.cells) plan.touched.add(`${r},${c}`)
      continue
    }
    const shift = { sheet: op.sheet, axis: op.axis, at: op.at, count: op.count }
    plan.shifts.push(shift)
    shifts.push(shift)
    const moved = new Set()
    for (const key of plan.touched) {
      const [r, c] = key.split(',').map(Number)
      const next = op.axis === 'row' ? [shiftIndex(r, shift), c] : [r, shiftIndex(c, shift)]
      if (next[0] !== null && next[1] !== null) moved.add(`${next[0]},${next[1]}`)
    }
    plan.touched = moved
    for (const { r, c } of op.restore?.cells ?? []) plan.touched.add(`${r},${c}`)
  }
  return { sheets, shifts }
}

/** Where the file's own row or column `index` is now, or null when it was deleted. */
export function mapIndex(index, shifts, axis) {
  let at = index
  for (const shift of shifts) {
    if (shift.axis !== axis) continue
    at = shiftIndex(at, shift)
    if (at === null) return null
  }
  return at
}
