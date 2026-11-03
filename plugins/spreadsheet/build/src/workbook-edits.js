// Edits to the workbook model, as operations: set cells, or insert or delete rows or columns. Each
// returns its inverse, which is what undo applies. The operation log, not the model, is the
// document: saving replays it onto the file's own XML (xlsx-writer.js, ods-writer.js).
import { cellValue, storeResult } from './cell-input.js'
import { Unsupported, evaluateFormula, parseFormula } from './formula-eval.js'
import { shiftFormula, shiftSpan } from './formula-shift.js'
import { tokenize } from './formula-tokens.js'
import { findSheet, measureExtent } from './workbook-model.js'

/**
 * @typedef {{ type: 'cells', sheet: string, cells: { r: number, c: number, cell: object | null }[] }} CellsOp
 * @typedef {{ type: 'shift', sheet: string, axis: 'row' | 'column', at: number, count: number,
 *   restore?: Restore }} ShiftOp  `count` > 0 inserts before `at`; < 0 deletes from `at`.
 * @typedef {{ cells: { r: number, c: number, cell: object }[], merges: object[], info: object[],
 *   formulas: { sheet: string, r: number, c: number, f: string, F?: string }[] }} Restore
 */

/** Applies `op` to the model; returns the operation that undoes it. */
export function applyOp(model, op) {
  return op.type === 'cells' ? applyCells(model, op) : applyShift(model, op)
}

/** A copy of an operation for another model: cells lose their tie to this file's XML. */
export function portableOp(op) {
  const copyCell = (cell) => (cell ? Object.fromEntries(Object.entries(cell).filter(([key]) => !key.startsWith('$'))) : null)
  if (op.type === 'cells') return { ...op, cells: op.cells.map((entry) => ({ ...entry, cell: copyCell(entry.cell) })) }
  return op.restore ? { ...op, restore: { ...op.restore, cells: op.restore.cells.map((entry) => ({ ...entry, cell: copyCell(entry.cell) })) } } : op
}

function applyCells(model, op) {
  const sheet = findSheet(model, op.sheet)
  if (!sheet) return { type: 'cells', sheet: op.sheet, cells: [] }
  const inverse = []
  const changed = []
  const seeds = []
  let shrank = false
  for (const { r, c, cell } of op.cells) {
    const row = sheet.data[r]
    const previous = row?.[c] ?? null
    inverse.push({ r, c, cell: previous })
    if (cell) {
      ;(sheet.data[r] ??= [])[c] = cell
      sheet.rowCount = Math.max(sheet.rowCount, r + 1)
      sheet.columnCount = Math.max(sheet.columnCount, c + 1)
      if (cell.f) seeds.push(cell)
    } else if (row) {
      delete row[c]
      if (r + 1 >= sheet.rowCount || c + 1 >= sheet.columnCount) shrank = true
    }
    changed.push({ sheet: sheet.name, r, c })
  }
  if (shrank) measureExtent(sheet)
  sheet.$edited = true
  recalculate(model, changed, seeds)
  return { type: 'cells', sheet: op.sheet, cells: inverse.reverse() }
}

function applyShift(model, op) {
  const sheet = findSheet(model, op.sheet)
  if (!sheet) return { ...op, count: -op.count, restore: undefined }
  const shift = { sheet: sheet.name, axis: op.axis, at: op.at, count: op.count }
  const rows = op.axis === 'row'
  const removed = op.count < 0 ? -op.count : 0

  // Formulas first, at their old positions, so the restore list can find them after an undo.
  const formulas = []
  const seeds = []
  for (const other of model.all) {
    other.data.forEach((row, r) => {
      row?.forEach((cell, c) => {
        if (!cell?.f) return
        const f = shiftFormula(cell.f, other.name, shift)
        const F = cell.F ? shiftFormula(cell.F, other.name, other === sheet ? shift : { ...shift, sheet: '\u0000' }) : undefined
        if (f !== cell.f || F !== cell.F) {
          formulas.push({ sheet: other.name, r, c, f: cell.f, ...(cell.F ? { F: cell.F } : {}) })
          cell.f = f
          if (F !== undefined) cell.F = F
          seeds.push(cell)
        } else if (dependsOnWholeAxis(cell, other.name, shift)) {
          seeds.push(cell)
        }
      })
    })
  }

  const cells = []
  const merges = sheet.merges.slice()
  const info = rows ? sheet.rowInfo : sheet.columnInfo
  const infoBefore = info.slice()
  if (rows) {
    if (op.at < sheet.data.length) {
      if (removed) {
        sheet.data.splice(op.at, removed).forEach((row, index) => {
          row?.forEach((cell, c) => cell && cells.push({ r: op.at + index, c, cell }))
        })
      } else {
        sheet.data.splice(op.at, 0, ...new Array(op.count))
      }
    }
  } else {
    sheet.data.forEach((row, r) => {
      if (!row || op.at >= row.length) return
      if (removed) {
        row.splice(op.at, removed).forEach((cell, index) => cell && cells.push({ r, c: op.at + index, cell }))
      } else {
        row.splice(op.at, 0, ...new Array(op.count))
      }
    })
  }
  if (op.at < info.length) {
    if (removed) info.splice(op.at, removed)
    else info.splice(op.at, 0, ...new Array(op.count))
  }
  const key = rows ? 'r' : 'c'
  sheet.merges = merges
    .map((merge) => {
      const span = shiftSpan(merge.s[key], merge.e[key], shift)
      if (!span) return null
      const next = { s: { ...merge.s, [key]: span[0] }, e: { ...merge.e, [key]: span[1] } }
      return next.s.r === next.e.r && next.s.c === next.e.c ? null : next
    })
    .filter(Boolean)

  if (op.restore) {
    for (const { r, c, cell } of op.restore.cells) (sheet.data[r] ??= [])[c] = cell
    sheet.merges = op.restore.merges.slice()
    info.splice(0, info.length, ...op.restore.info)
    for (const entry of op.restore.formulas) {
      const cell = findSheet(model, entry.sheet)?.data[entry.r]?.[entry.c]
      if (!cell?.f) continue
      cell.f = entry.f
      if (entry.F !== undefined) cell.F = entry.F
      seeds.push(cell)
    }
    for (const { cell } of op.restore.cells) if (cell.f) seeds.push(cell)
  }
  measureExtent(sheet)
  sheet.$edited = true
  model.$shifted = true
  recalculate(model, [], seeds)
  return {
    type: 'shift',
    sheet: op.sheet,
    axis: op.axis,
    at: op.at,
    count: -op.count,
    restore: { cells, merges, info: infoBefore, formulas }
  }
}

function dependsOnWholeAxis(cell, hostSheet, shift) {
  const deps = dependencies(cell, hostSheet)
  return deps.some((range) => range.sheet === shift.sheet.toUpperCase() && (shift.axis === 'row' ? range.r1 === Infinity : range.c1 === Infinity))
}

// --- Recalculation -----------------------------------------------------------------------------

/** The ranges a formula reads, as `{ sheet (upper case), r0, c0, r1, c1 }`; cached on the cell. */
function dependencies(cell, hostSheet) {
  if (cell.$depsOf === cell.f && cell.$depsHost === hostSheet) return cell.$deps
  let deps = []
  try {
    deps = tokenize(cell.f)
      .filter((token) => token.type === 'ref' && !token.error && !token.sheetEnd)
      .map((token) => {
        const b = token.b ?? token.a
        return {
          sheet: (token.sheet ?? hostSheet).toUpperCase(),
          r0: token.kind === 'columns' ? 0 : Math.min(token.a.r, b.r),
          r1: token.kind === 'columns' ? Infinity : Math.max(token.a.r, b.r),
          c0: token.kind === 'rows' ? 0 : Math.min(token.a.c, b.c),
          c1: token.kind === 'rows' ? Infinity : Math.max(token.a.c, b.c)
        }
      })
  } catch {
    deps = []
  }
  cell.$deps = deps
  cell.$depsOf = cell.f
  cell.$depsHost = hostSheet
  return deps
}

function formulaTree(cell) {
  if (cell.$treeOf === cell.f) return cell.$tree
  let tree = null
  try {
    tree = parseFormula(cell.f)
  } catch {
    tree = null
  }
  cell.$tree = tree
  cell.$treeOf = cell.f
  return tree
}

/**
 * Recalculates the formulas that read a changed cell, directly or through other formulas, plus
 * `seeds`. A formula this calculator cannot evaluate keeps its saved result.
 */
export function recalculate(model, changed, seeds = []) {
  const entries = []
  const seedSet = new Set(seeds)
  for (const sheet of model.all) {
    sheet.data.forEach((row, r) => {
      row?.forEach((cell, c) => {
        if (!cell?.f) return
        const entry = { sheet, r, c, cell, deps: dependencies(cell, sheet.name), dirty: seedSet.has(cell) }
        entries.push(entry)
      })
    })
  }
  if (entries.length === 0) return
  const dirty = new Set()
  let frontier = changed.map((position) => ({ sheet: position.sheet.toUpperCase(), r: position.r, c: position.c }))
  for (const entry of entries) {
    if (entry.dirty) {
      dirty.add(entry.cell)
      frontier.push({ sheet: entry.sheet.name.toUpperCase(), r: entry.r, c: entry.c })
    }
  }
  while (frontier.length > 0) {
    const bySheet = new Map()
    for (const position of frontier) {
      let list = bySheet.get(position.sheet)
      if (!list) bySheet.set(position.sheet, (list = []))
      list.push(position)
    }
    const next = []
    for (const entry of entries) {
      if (entry.dirty) continue
      const hit = entry.deps.some((range) =>
        bySheet.get(range.sheet)?.some((p) => p.r >= range.r0 && p.r <= range.r1 && p.c >= range.c0 && p.c <= range.c1)
      )
      if (!hit) continue
      entry.dirty = true
      dirty.add(entry.cell)
      next.push({ sheet: entry.sheet.name.toUpperCase(), r: entry.r, c: entry.c })
    }
    frontier = next
  }
  if (dirty.size === 0) return

  const results = new Map()
  const busy = new Set()
  const sheets = new Map(model.all.map((sheet) => [sheet.name.toUpperCase(), sheet]))
  const hostOf = new Map(entries.map((entry) => [entry.cell, entry.sheet]))
  const resolver = {
    extent(name) {
      const sheet = sheets.get(name.toUpperCase())
      return sheet ? { rows: sheet.rowCount, columns: sheet.columnCount } : null
    },
    value(name, r, c) {
      const cell = sheets.get(name.toUpperCase())?.data[r]?.[c]
      if (cell?.f && dirty.has(cell)) return compute(cell)
      return cellValue(cell)
    }
  }
  function compute(cell) {
    if (results.has(cell)) return results.get(cell)
    if (busy.has(cell)) throw new Unsupported('circular reference')
    busy.add(cell)
    let value
    try {
      const tree = formulaTree(cell)
      if (!tree) throw new Unsupported('unreadable')
      value = evaluateFormula(tree, hostOf.get(cell).name, resolver)
      cell.$stale = false
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error
      // Undefined for a new formula: it has no saved result to fall back on.
      value = cell.v === undefined ? undefined : cellValue(cell)
      cell.$stale = true
    } finally {
      busy.delete(cell)
    }
    results.set(cell, value)
    return value
  }
  for (const cell of dirty) {
    let value
    try {
      value = compute(cell)
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error
      continue
    }
    if (value === undefined) continue
    const before = `${cell.t}:${cell.v}`
    storeResult(cell, value)
    if (`${cell.t}:${cell.v}` !== before) {
      cell.$changed = true
      hostOf.get(cell).$recalculated = true
    }
  }
}
