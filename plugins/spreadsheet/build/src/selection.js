import { expandRangeToMerges } from './merge-index.js'

/**
 * Grid selection: the selected range runs from `anchor` to `corner` (Shift+arrows and Shift+click
 * move the corner); `active` is the cell shown in the detail bar, which Tab and Enter walk through
 * the range. Outside of that walk, active and anchor are the same cell.
 * @typedef {{ r: number, c: number }} Point
 * @typedef {{ active: Point, anchor: Point, corner: Point }} Selection
 * @typedef {{ rowCount: number, columnCount: number, pageRows: number, isEmpty: (r: number, c: number) => boolean,
 *   merges: ReturnType<import('./merge-index.js').createMergeIndex>, isRowHidden?: (r: number) => boolean,
 *   isColumnHidden?: (c: number) => boolean }} GridContext
 */

export function cellSelection(r, c) {
  return { active: { r, c }, anchor: { r, c }, corner: { r, c } }
}

function rangeSelection(anchor, corner) {
  return { active: anchor, anchor, corner }
}

export function selectionRange(selection, merges) {
  const { anchor, corner } = selection
  const range = {
    r0: Math.min(anchor.r, corner.r),
    c0: Math.min(anchor.c, corner.c),
    r1: Math.max(anchor.r, corner.r),
    c1: Math.max(anchor.c, corner.c)
  }
  return merges ? expandRangeToMerges(range, merges) : range
}

export function rangeCellCount({ r0, c0, r1, c1 }) {
  return (r1 - r0 + 1) * (c1 - c0 + 1)
}

/** Clamps a selection to the sheet, e.g. after the file changed on disk. Null when nothing is left. */
export function clampSelection(selection, rowCount, columnCount) {
  if (rowCount <= 0 || columnCount <= 0) return null
  const clamp = ({ r, c }) => ({ r: Math.min(r, rowCount - 1), c: Math.min(c, columnCount - 1) })
  return { active: clamp(selection.active), anchor: clamp(selection.anchor), corner: clamp(selection.corner) }
}

/** @param {Selection} selection @param {GridContext} grid */
export function reduceSelection(selection, action, grid) {
  const lastRow = Math.max(0, grid.rowCount - 1)
  const lastColumn = Math.max(0, grid.columnCount - 1)
  const extend = Boolean(action.extend)
  const from = extend ? selection.corner : selection.active
  const place = (r, c) => {
    const point = { r: clamp(r, 0, lastRow), c: clamp(c, 0, lastColumn) }
    if (extend) return { ...selection, corner: point }
    return cellSelection(...anchorOf(point, grid))
  }
  switch (action.type) {
    case 'move': {
      const { dr = 0, dc = 0 } = action
      const next = action.toEdge ? edgeFrom(from, dr, dc, grid) : stepFrom(from, dr, dc, grid)
      return place(next.r, next.c)
    }
    case 'page':
      return place(skipHiddenRow(from.r + action.dr * Math.max(1, grid.pageRows), action.dr, grid), from.c)
    case 'rowStart':
      return place(from.r, 0)
    case 'rowEnd': {
      let c = lastColumn
      while (c > 0 && grid.isEmpty(from.r, c)) c--
      return place(from.r, grid.isEmpty(from.r, c) ? lastColumn : c)
    }
    case 'sheetStart':
      return place(0, 0)
    case 'sheetEnd':
      // The last used cell, as Excel's Ctrl+End; an editable grid runs past it.
      return place(Math.max(0, (grid.usedRows ?? grid.rowCount) - 1), Math.max(0, (grid.usedColumns ?? grid.columnCount) - 1))
    case 'cell':
      return place(action.r, action.c)
    case 'row': {
      const r = clamp(action.r, 0, lastRow)
      return extend ? { ...selection, corner: { r, c: lastColumn } } : rangeSelection({ r, c: 0 }, { r, c: lastColumn })
    }
    case 'column': {
      const c = clamp(action.c, 0, lastColumn)
      return extend ? { ...selection, corner: { r: lastRow, c } } : rangeSelection({ r: 0, c }, { r: lastRow, c })
    }
    case 'all':
      return rangeSelection({ r: 0, c: 0 }, { r: lastRow, c: lastColumn })
    case 'cycle':
      return cycleWithin(selection, action, grid)
    default:
      return selection
  }
}

/** Tab and Enter: inside a multi-cell selection they walk its cells; otherwise they move. */
function cycleWithin(selection, { across, back }, grid) {
  const range = selectionRange(selection, grid.merges)
  const d = back ? -1 : 1
  if (rangeCellCount(range) === 1) {
    return reduceSelection(selection, { type: 'move', dr: across ? 0 : d, dc: across ? d : 0 }, grid)
  }
  let { r, c } = selection.active
  const merge = grid.merges.at(r, c)
  if (across) {
    c = d > 0 ? (merge ? merge.e.c : c) + 1 : (merge ? merge.s.c : c) - 1
    if (c > range.c1) (c = range.c0), (r = r + 1 > range.r1 ? range.r0 : r + 1)
    else if (c < range.c0) (c = range.c1), (r = r - 1 < range.r0 ? range.r1 : r - 1)
  } else {
    r = d > 0 ? (merge ? merge.e.r : r) + 1 : (merge ? merge.s.r : r) - 1
    if (r > range.r1) (r = range.r0), (c = c + 1 > range.c1 ? range.c0 : c + 1)
    else if (r < range.r0) (r = range.r1), (c = c - 1 < range.c0 ? range.c1 : c - 1)
  }
  const [ar, ac] = anchorOf({ r, c }, grid)
  return { ...selection, active: { r: ar, c: ac } }
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value
}

function anchorOf(point, grid) {
  const merge = grid.merges.at(point.r, point.c)
  return merge ? [merge.s.r, merge.s.c] : [point.r, point.c]
}

// One cell over, leaving a merged area from its far edge and skipping hidden rows and columns.
function stepFrom(from, dr, dc, grid) {
  const merge = grid.merges.at(from.r, from.c)
  let r = from.r
  let c = from.c
  if (merge) {
    if (dr > 0) r = merge.e.r
    if (dr < 0) r = merge.s.r
    if (dc > 0) c = merge.e.c
    if (dc < 0) c = merge.s.c
  }
  const next = { r: skipHiddenRow(r + dr, dr, grid), c: skipHiddenColumn(c + dc, dc, grid) }
  const outside = next.r < 0 || next.r >= grid.rowCount || next.c < 0 || next.c >= grid.columnCount
  return outside ? from : next
}

function skipHiddenRow(r, dr, grid) {
  if (!grid.isRowHidden || dr === 0) return r
  while (r >= 0 && r < grid.rowCount && grid.isRowHidden(r)) r += Math.sign(dr)
  return r
}

function skipHiddenColumn(c, dc, grid) {
  if (!grid.isColumnHidden || dc === 0) return c
  while (c >= 0 && c < grid.columnCount && grid.isColumnHidden(c)) c += Math.sign(dc)
  return c
}

// Ctrl/Cmd+arrow, as in Excel: to the end of a run of filled cells, or on to the next filled cell.
function edgeFrom(from, dr, dc, grid) {
  const inside = (r, c) => r >= 0 && r < grid.rowCount && c >= 0 && c < grid.columnCount
  let r = from.r
  let c = from.c
  if (!inside(r + dr, c + dc)) return { r, c }
  if (!grid.isEmpty(r, c) && !grid.isEmpty(r + dr, c + dc)) {
    while (inside(r + dr, c + dc) && !grid.isEmpty(r + dr, c + dc)) (r += dr), (c += dc)
    return { r, c }
  }
  do {
    r += dr
    c += dc
  } while (inside(r + dr, c + dc) && grid.isEmpty(r, c))
  return { r, c }
}
