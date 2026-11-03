// Orca custom editor for spreadsheets. Orca's document session (`orca.document.session`) owns the
// buffer, dirty state and saving; this frame parses the bytes with SheetJS, shows every visible sheet
// in a virtualized grid, and turns edits into operations that workbook-document.js saves back into
// the file's own XML (see build/README.md).
import { rangeAddress } from './address.js'
import { cellFromInput, editText } from './cell-input.js'
import { cellFormula, cellRawValue, cellText, isEmptyCell } from './cell-display.js'
import { createGridView } from './grid-view.js'
import { MESSAGES, readOnlyMessage, shiftBlockedMessage } from './messages.js'
import { rangeToHtml, rangeToTsv, selectionStats } from './range-copy.js'
import { parseTsv } from './tsv-paste.js'
import { clampSelection, rangeCellCount } from './selection.js'
import { applyOp } from './workbook-edits.js'
import { createWorkbookCodec, modelOf, openSource, shiftBlocker, touchesLockedCell } from './workbook-document.js'
import { getCell } from './workbook-model.js'

const GRID_FONT = '12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
// Rich-text copies of huge ranges cost more than they are worth; plain text is always included.
const MAX_HTML_COPY_CELLS = 100_000
const MAX_PASTE_CELLS = 200_000
const STATUS_NOTE_MS = 3500
const ANNOUNCE_DELAY_MS = 300
// An editable sheet shows this much room past its last used row and column.
const EXTRA_ROWS = 100
const EXTRA_COLUMNS = 10
const MIN_ROWS = 100
const MIN_COLUMNS = 26
const isMac = navigator.userAgent.includes('Mac')

const $ = (id) => document.getElementById(id)
const ui = {
  message: $('message'),
  workbook: $('workbook'),
  notice: $('notice'),
  conflict: $('conflict'),
  conflictText: $('conflict-text'),
  address: $('address'),
  formula: $('formula'),
  result: $('result'),
  gridHost: $('grid-host'),
  sheetMessage: $('sheet-message'),
  tabs: $('tabs'),
  hiddenNote: $('hidden-note'),
  dims: $('status-dims'),
  stats: $('status-stats'),
  note: $('status-note'),
  live: $('live'),
  cellEditor: $('cell-editor'),
  menu: $('menu')
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 })
const countFormat = new Intl.NumberFormat(undefined)
const measureContext = document.createElement('canvas').getContext('2d')
measureContext.font = GRID_FONT
const measured = new Map()
function measureText(text) {
  let width = measured.get(text)
  if (width === undefined) {
    width = measureContext.measureText(text).width
    if (measured.size > 50_000) measured.clear()
    measured.set(text, width)
  }
  return width
}

const codec = createWorkbookCodec()
let session = null
let documentReadOnly = true
let value = null
let model = null
let opened = null
let activeIndex = -1
let loadToken = 0
const sheetStates = new Map()
let undoStack = []
let redoStack = []
/** The cell being edited: `{ r, c, mode: 'enter' | 'edit', start }`, or null. */
let editing = null
/** This tab's edits an outside write kept from merging, until reapplied or discarded. */
let rejected = null
let noteTimer = 0
let announceTimer = 0

const grid = createGridView(ui.gridHost, {
  measureText,
  onSelectionChange: updateSelectionDetails,
  onSwitchSheet: (delta) => {
    if (!model) return
    const next = activeIndex + delta
    if (next >= 0 && next < model.sheets.length) {
      showSheet(next)
      grid.focus()
    }
  },
  editable: () => isEditable(),
  onStartEdit: (text) => beginEdit(text),
  onClear: () => clearSelection(),
  onContextMenu: (x, y) => openMenu(x, y),
  onScroll: () => positionEditor()
})
grid.element.id = 'grid'

function isEditable() {
  return Boolean(session && opened?.format && !documentReadOnly && !session.readOnly)
}

function showMessage(text) {
  ui.workbook.hidden = true
  ui.message.hidden = false
  ui.message.textContent = text
}

function receive(next) {
  const token = ++loadToken
  if (!model) showMessage(MESSAGES.opening)
  // Why: let "Opening" paint before the parse, which holds the main thread for large files.
  setTimeout(() => {
    if (token === loadToken) load(next)
  }, 0)
}

function load(next) {
  const result = openSource(next.source)
  const previousName = currentSheet()?.name ?? null
  const previousIndex = activeIndex
  if (previousName !== null && !ui.gridHost.hidden) sheetStates.set(previousName, grid.state())
  cancelEdit()
  closeMenu()
  model = null
  activeIndex = -1
  undoStack = []
  redoStack = []
  rejected = next.rejected?.length ? next.rejected : null
  if (result.status !== 'ok') {
    opened = null
    showMessage(MESSAGES[result.status])
    return
  }
  opened = result
  value = next
  const nextModel = modelOf(next)
  if (nextModel.sheets.length === 0) {
    showMessage(nextModel.hiddenCount > 0 ? MESSAGES.allHidden : MESSAGES.noSheets)
    return
  }
  model = nextModel
  ui.message.hidden = true
  ui.workbook.hidden = false
  renderNotice()
  renderConflict()
  renderTabs()
  const keep = model.sheets.findIndex((sheet) => sheet.name === previousName)
  showSheet(keep >= 0 ? keep : Math.min(Math.max(previousIndex, 0), model.sheets.length - 1), keep >= 0)
}

function renderNotice() {
  const text = isEditable() || !opened ? '' : readOnlyMessage(opened.format ? 'document' : opened.readOnlyReason)
  ui.notice.hidden = text === ''
  ui.notice.textContent = text
  ui.formula.readOnly = !isEditable()
}

function renderConflict() {
  ui.conflict.hidden = !rejected
  if (!rejected) return
  const cells = rejected.reduce((sum, op) => sum + (op.cells?.length ?? 0), 0)
  ui.conflictText.textContent = MESSAGES.mergeRefused(cells)
  announce(ui.conflictText.textContent)
}

/** Puts the edits an outside write kept from merging back on top of the new file, as asked. */
function reapplyRejected() {
  if (!rejected || !isEditable()) return
  const ops = rejected
  rejected = null
  renderConflict()
  let last = null
  for (const op of ops) {
    const inverse = applyOp(model, op)
    undoStack.push({ op, inverse, sheet: op.sheet, selection: grid.state().selection })
    last = op
  }
  redoStack = []
  if (last) publish([...value.ops, ...ops], last)
}

function discardRejected() {
  rejected = null
  renderConflict()
  grid.focus()
}

function renderTabs() {
  ui.tabs.replaceChildren(
    ...model.sheets.map((sheet, index) => {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'tab'
      tab.id = `tab-${index}`
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-controls', 'grid')
      tab.textContent = sheet.name
      tab.title = sheet.name
      tab.addEventListener('click', () => showSheet(index))
      return tab
    })
  )
  ui.hiddenNote.hidden = model.hiddenCount === 0
  ui.hiddenNote.textContent =
    model.hiddenCount === 1 ? '1 hidden sheet not shown' : `${countFormat.format(model.hiddenCount)} hidden sheets not shown`
}

function gridExtent(sheet) {
  if (!isEditable()) return { rows: sheet.rowCount, columns: sheet.columnCount }
  return {
    rows: Math.min(1_048_576, Math.max(MIN_ROWS, sheet.rowCount + EXTRA_ROWS)),
    columns: Math.min(16_384, Math.max(MIN_COLUMNS, sheet.columnCount + EXTRA_COLUMNS))
  }
}

function showSheet(index, keepState = true) {
  commitEdit()
  const previous = currentSheet()
  if (previous && index !== activeIndex && !ui.gridHost.hidden) sheetStates.set(previous.name, grid.state())
  activeIndex = index
  const sheet = model.sheets[index]
  ui.tabs.querySelectorAll('[role="tab"]').forEach((tab, i) => {
    tab.setAttribute('aria-selected', String(i === index))
    tab.tabIndex = i === index ? 0 : -1
  })
  ui.tabs.children[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const extent = gridExtent(sheet)
  const empty = sheet.kind !== 'worksheet' || extent.rows === 0 || extent.columns === 0
  ui.gridHost.hidden = empty
  ui.sheetMessage.hidden = !empty
  ui.sheetMessage.textContent =
    sheet.kind === 'chart' ? MESSAGES.chartSheet : sheet.kind === 'other' ? MESSAGES.otherSheet : MESSAGES.emptySheet
  renderDims(sheet)
  if (empty) {
    clearDetails()
    announce(`${sheet.name}. ${ui.sheetMessage.textContent}`)
    return
  }
  const saved = keepState ? sheetStates.get(sheet.name) : undefined
  const selection = saved && clampSelection(saved.selection, extent.rows, extent.columns)
  grid.setSheet(sheet, selection ? { ...saved, selection } : {}, extent)
  updateSelectionDetails()
  announce(`Sheet ${sheet.name}`)
}

function renderDims(sheet) {
  ui.dims.textContent =
    sheet.rowCount === 0 || sheet.columnCount === 0
      ? ''
      : `${countFormat.format(sheet.rowCount)} ${sheet.rowCount === 1 ? 'row' : 'rows'} × ` +
        `${countFormat.format(sheet.columnCount)} ${sheet.columnCount === 1 ? 'column' : 'columns'}`
}

function clearDetails() {
  ui.address.textContent = ''
  ui.formula.value = ''
  ui.result.textContent = ''
  ui.stats.textContent = ''
}

function currentSheet() {
  return model && activeIndex >= 0 ? model.sheets[activeIndex] : null
}

function updateSelectionDetails() {
  const sheet = currentSheet()
  if (!sheet) return
  const { active } = grid.selection
  const cell = getCell(sheet, active.r, active.c)
  const formula = cellFormula(cell)
  const text = cellText(cell)
  const raw = cellRawValue(cell)
  ui.address.textContent = grid.activeAddress()
  if (!editing && document.activeElement !== ui.formula) ui.formula.value = isEditable() ? editText(cell) : (formula ?? text)
  const parts = []
  if (formula) parts.push(text === '' ? '' : `= ${text}`)
  if (raw !== null && !isEditable()) parts.push(`Stored value ${raw}`)
  ui.result.textContent = parts.filter(Boolean).join('  ·  ')
  ui.result.title = cell?.$stale ? MESSAGES.staleFormula : ''

  const range = grid.range()
  const cells = rangeCellCount(range)
  if (cells > 1) {
    const stats = selectionStats(range, sheet.data)
    const statsParts = [`${rangeAddress(range)}`, `Count ${countFormat.format(stats.count)}`]
    if (stats.numericCount > 0) {
      statsParts.push(`Sum ${numberFormat.format(stats.sum)}`, `Average ${numberFormat.format(stats.average)}`)
    }
    ui.stats.textContent = statsParts.join('  ·  ')
  } else {
    ui.stats.textContent = ''
  }
  clearTimeout(announceTimer)
  announceTimer = setTimeout(() => {
    announce(cells > 1 ? `Selected ${rangeAddress(range)}` : formula ? `${ui.address.textContent}, formula ${formula}` : ui.address.textContent)
  }, ANNOUNCE_DELAY_MS)
}

function announce(text) {
  // Why: re-setting the same text is not re-announced; clearing first makes it a new message.
  ui.live.textContent = ''
  requestAnimationFrame(() => (ui.live.textContent = text))
}

function showNote(text) {
  ui.note.textContent = text
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => (ui.note.textContent = ''), STATUS_NOTE_MS)
}

// --- Edits -------------------------------------------------------------------------------------

/** Applies an operation, records it for undo and hands the new value to Orca. */
function commit(op) {
  if (op.type === 'cells' && touchesLockedCell(value.source, op.sheet, op.cells)) {
    showNote(MESSAGES.tableHeader)
    announce(MESSAGES.tableHeader)
    return false
  }
  const inverse = applyOp(model, op)
  undoStack.push({ op, inverse, sheet: op.sheet, selection: grid.state().selection })
  if (undoStack.length > 500) undoStack.shift()
  redoStack = []
  publish([...value.ops, op], op)
  return true
}

function publish(ops, op) {
  value = { source: value.source, ops, model }
  session.change(value)
  afterEdit(op)
}

function afterEdit(op) {
  const sheet = currentSheet()
  if (!sheet) return
  if (op.sheet.toUpperCase() !== sheet.name.toUpperCase()) {
    grid.refresh()
  } else {
    const extent = gridExtent(sheet)
    const structural = op.type === 'shift'
    const state = grid.state()
    if (structural || extent.rows !== grid.rowCount || extent.columns !== grid.columnCount) {
      const selection = clampSelection(state.selection, extent.rows, extent.columns)
      grid.setSheet(sheet, { ...state, selection, keepWidths: !structural }, extent)
    } else {
      grid.refresh()
    }
  }
  renderDims(sheet)
  updateSelectionDetails()
}

function undo() {
  const entry = undoStack.pop()
  if (!entry) return
  const redoInverse = applyOp(model, entry.inverse)
  redoStack.push({ op: entry.op, inverse: redoInverse, sheet: entry.sheet, selection: entry.selection })
  // Undoing the latest operation drops it from the log, so the file is saved as if it never was.
  const ops = value.ops[value.ops.length - 1] === entry.op ? value.ops.slice(0, -1) : [...value.ops, entry.inverse]
  revealSheet(entry)
  publish(ops, entry.inverse)
  announce('Undone')
}

function redo() {
  const entry = redoStack.pop()
  if (!entry) return
  const inverse = applyOp(model, entry.op)
  undoStack.push({ op: entry.op, inverse, sheet: entry.sheet, selection: entry.selection })
  revealSheet(entry)
  publish([...value.ops, entry.op], entry.op)
  announce('Redone')
}

function revealSheet(entry) {
  const index = model.sheets.findIndex((sheet) => sheet.name.toUpperCase() === entry.sheet.toUpperCase())
  if (index >= 0 && index !== activeIndex) showSheet(index)
  if (entry.selection) grid.dispatch({ type: 'cell', r: entry.selection.active.r, c: entry.selection.active.c })
}

/** Writes typed text into a cell. False when the text is no valid formula. */
function setCell(r, c, text) {
  const sheet = currentSheet()
  const previous = getCell(sheet, r, c)
  if (text === editText(previous)) return true
  const parsed = cellFromInput(text, previous)
  if ('error' in parsed) {
    showNote(MESSAGES.invalidFormula)
    announce(MESSAGES.invalidFormula)
    return false
  }
  commit({ type: 'cells', sheet: sheet.name, cells: [{ r, c, cell: parsed.cell }] })
  return true
}

function clearSelection() {
  const sheet = currentSheet()
  if (!sheet || !isEditable()) return
  const range = grid.range()
  const cells = []
  for (let r = range.r0; r <= Math.min(range.r1, sheet.data.length - 1); r++) {
    const row = sheet.data[r]
    if (!row) continue
    for (let c = range.c0; c <= Math.min(range.c1, row.length - 1); c++) {
      if (!isEmptyCell(row[c])) cells.push({ r, c, cell: null })
    }
  }
  return cells.length ? commit({ type: 'cells', sheet: sheet.name, cells }) : false
}

/** Inserts or deletes the selected rows or columns. */
function shiftSelection(axis, where) {
  const sheet = currentSheet()
  if (!sheet || !isEditable()) return
  const range = grid.range()
  const count = axis === 'row' ? range.r1 - range.r0 + 1 : range.c1 - range.c0 + 1
  const first = axis === 'row' ? range.r0 : range.c0
  const span = where === 'delete' ? { at: first, count: -count } : { at: where === 'before' ? first : first + count, count }
  const limit = axis === 'row' ? 1_048_576 : 16_384
  const used = axis === 'row' ? sheet.rowCount : sheet.columnCount
  // As in Excel: nothing may be pushed past the last row or column.
  const blocker = span.count > 0 && used + span.count > limit ? 'cells that would be pushed off the end of the sheet' : shiftBlocker(value.source, sheet, axis, span)
  if (blocker) {
    showNote(shiftBlockedMessage(axis, where === 'delete', blocker))
    announce(ui.note.textContent)
    return
  }
  commit({ type: 'shift', sheet: sheet.name, axis, ...span })
  if (where === 'after') {
    grid.dispatch(axis === 'row' ? { type: 'row', r: span.at } : { type: 'column', c: span.at }, false)
    if (count > 1) grid.dispatch(axis === 'row' ? { type: 'row', r: span.at + count - 1, extend: true } : { type: 'column', c: span.at + count - 1, extend: true }, false)
  }
  showNote(shiftDoneMessage(axis, where, count))
}

function shiftDoneMessage(axis, where, count) {
  const noun = axis === 'row' ? (count === 1 ? 'row' : 'rows') : count === 1 ? 'column' : 'columns'
  return `${where === 'delete' ? 'Deleted' : 'Inserted'} ${countFormat.format(count)} ${noun}`
}

// --- In-cell editor ----------------------------------------------------------------------------

function editTarget() {
  const { r, c } = grid.selection.active
  // A merge is edited through its first cell.
  const merge = grid.merges().at(r, c)
  return merge ? { r: merge.s.r, c: merge.s.c } : { r, c }
}

/** Opens the editor on the active cell; `text` null keeps the cell's content, a string replaces it. */
function beginEdit(text) {
  if (!isEditable() || editing) return
  const sheet = currentSheet()
  if (!sheet) return
  const { r, c } = editTarget()
  const start = editText(getCell(sheet, r, c))
  editing = { r, c, mode: text === null ? 'edit' : 'enter', start }
  ui.cellEditor.value = text === null ? start : text
  ui.cellEditor.hidden = false
  positionEditor()
  ui.cellEditor.focus({ preventScroll: true })
  const end = ui.cellEditor.value.length
  ui.cellEditor.setSelectionRange(end, end)
  syncFormulaBar()
}

function positionEditor() {
  if (!editing) return
  const box = grid.cellBox(editing.r, editing.c)
  const host = grid.element.getBoundingClientRect()
  const area = ui.gridHost.getBoundingClientRect()
  const left = host.left - area.left + box.left
  const top = host.top - area.top + box.top
  const lines = ui.cellEditor.value.split('\n')
  const longest = Math.max(...lines.map((line) => measureText(line)))
  const width = Math.min(Math.max(box.width, longest + 24), Math.max(box.width, area.width - left - 8))
  Object.assign(ui.cellEditor.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${Math.max(box.height, lines.length * 16 + 6)}px`
  })
}

function syncFormulaBar() {
  if (editing) ui.formula.value = ui.cellEditor.value
}

/** Saves the open editor's text; `move` then steps the selection like Enter or Tab. */
function commitEdit(move) {
  if (!editing) return true
  const target = editing
  const text = ui.cellEditor.value
  editing = null
  if (!setCell(target.r, target.c, text)) {
    editing = target
    ui.cellEditor.focus({ preventScroll: true })
    return false
  }
  ui.cellEditor.hidden = true
  if (move) grid.dispatch(move)
  grid.focus()
  updateSelectionDetails()
  return true
}

function cancelEdit() {
  if (!editing) return
  editing = null
  ui.cellEditor.hidden = true
  ui.cellEditor.value = ''
  grid.focus()
  updateSelectionDetails()
}

const MOVES = {
  Enter: (back) => ({ type: 'move', dr: back ? -1 : 1, dc: 0 }),
  Tab: (back) => ({ type: 'move', dr: 0, dc: back ? -1 : 1 })
}
const ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }

function onEditorKeyDown(event) {
  if (!editing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
  } else if (event.key === 'Enter' && event.altKey) {
    event.preventDefault()
    ui.cellEditor.setRangeText('\n', ui.cellEditor.selectionStart, ui.cellEditor.selectionEnd, 'end')
    positionEditor()
    syncFormulaBar()
  } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    commitEdit(MOVES[event.key](event.shiftKey))
  } else if (event.key in ARROWS && editing.mode === 'enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
    // Typing over a cell, as in Excel: arrows finish the edit and move; F2 editing moves the caret.
    event.preventDefault()
    const [dr, dc] = ARROWS[event.key]
    commitEdit({ type: 'move', dr, dc })
  }
}

ui.cellEditor.addEventListener('keydown', onEditorKeyDown)
ui.cellEditor.addEventListener('input', () => {
  positionEditor()
  syncFormulaBar()
})
ui.cellEditor.addEventListener('blur', () => {
  // Clicking elsewhere keeps what was typed, as a spreadsheet does.
  if (editing && !ui.menu.contains(document.activeElement)) commitEdit()
})

// The formula bar edits the active cell too.
ui.formula.addEventListener('keydown', (event) => {
  if (!isEditable()) return
  if (event.key === 'Enter' && !event.altKey) {
    event.preventDefault()
    const { r, c } = editTarget()
    if (setCell(r, c, ui.formula.value)) {
      grid.dispatch(MOVES.Enter(event.shiftKey))
      grid.focus()
    }
  } else if (event.key === 'Escape') {
    event.preventDefault()
    updateSelectionDetailsFromCell()
    grid.focus()
  }
})
ui.formula.addEventListener('focus', () => {
  if (editing) commitEdit()
})

function updateSelectionDetailsFromCell() {
  const sheet = currentSheet()
  if (!sheet) return
  const { r, c } = editTarget()
  ui.formula.value = editText(getCell(sheet, r, c))
}

// --- Context menu ------------------------------------------------------------------------------

function menuItems() {
  const range = grid.range()
  const rows = range.r1 - range.r0 + 1
  const columns = range.c1 - range.c0 + 1
  const plural = (count, noun) => (count === 1 ? noun : `${countFormat.format(count)} ${noun}s`)
  const rowItems = [
    [`Insert ${plural(rows, 'row')} above`, () => shiftSelection('row', 'before')],
    [`Insert ${plural(rows, 'row')} below`, () => shiftSelection('row', 'after')],
    [`Delete ${plural(rows, 'row')}`, () => shiftSelection('row', 'delete')]
  ]
  const columnItems = [
    [`Insert ${plural(columns, 'column')} left`, () => shiftSelection('column', 'before')],
    [`Insert ${plural(columns, 'column')} right`, () => shiftSelection('column', 'after')],
    [`Delete ${plural(columns, 'column')}`, () => shiftSelection('column', 'delete')]
  ]
  const wholeColumns = range.r0 === 0 && range.r1 === grid.rowCount - 1 && range.c1 < grid.columnCount - 1
  return [...(wholeColumns ? [...columnItems, null, ...rowItems] : [...rowItems, null, ...columnItems]), null, ['Clear contents', clearSelection]]
}

function openMenu(x, y) {
  if (!isEditable()) return
  commitEdit()
  ui.menu.replaceChildren(
    ...menuItems().map((item) => {
      if (!item) {
        const separator = document.createElement('div')
        separator.className = 'menu-separator'
        separator.setAttribute('role', 'separator')
        return separator
      }
      const [label, action] = item
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'menu-item'
      button.setAttribute('role', 'menuitem')
      button.tabIndex = -1
      button.textContent = label
      button.addEventListener('click', () => {
        closeMenu()
        action()
      })
      return button
    })
  )
  ui.menu.hidden = false
  const bounds = ui.menu.getBoundingClientRect()
  ui.menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - bounds.width - 4))}px`
  ui.menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - bounds.height - 4))}px`
  ui.menu.querySelector('[role="menuitem"]')?.focus()
}

function closeMenu(refocus = true) {
  if (ui.menu.hidden) return
  ui.menu.hidden = true
  ui.menu.replaceChildren()
  if (refocus) grid.focus()
}

ui.menu.addEventListener('keydown', (event) => {
  const items = [...ui.menu.querySelectorAll('[role="menuitem"]')]
  const at = items.indexOf(document.activeElement)
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault()
    closeMenu()
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    items[(at + step + items.length) % items.length]?.focus()
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
  }
})
document.addEventListener('pointerdown', (event) => {
  if (!ui.menu.hidden && !ui.menu.contains(event.target)) closeMenu(false)
}, true)

// --- Clipboard ---------------------------------------------------------------------------------

function textEditing(target) {
  return target === ui.cellEditor || target === ui.formula
}

function onCopy(event) {
  const sheet = currentSheet()
  if (!sheet || ui.gridHost.hidden || !event.clipboardData || textEditing(document.activeElement)) return
  // A text selection outside the grid (say, in the formula bar) copies as usual.
  const textSelection = document.getSelection()
  if (textSelection && !textSelection.isCollapsed && !grid.element.contains(textSelection.anchorNode)) return
  const range = grid.range()
  const getter = (r, c) => getCell(sheet, r, c)
  event.preventDefault()
  event.clipboardData.setData('text/plain', rangeToTsv(range, getter, grid.merges()))
  const cells = rangeCellCount(range)
  if (cells <= MAX_HTML_COPY_CELLS) event.clipboardData.setData('text/html', rangeToHtml(range, getter, grid.merges()))
  if (event.type === 'cut' && isEditable()) {
    if (!clearSelection()) return
    showNote(`Cut ${countFormat.format(cells)} ${cells === 1 ? 'cell' : 'cells'}`)
  } else {
    showNote(`Copied ${countFormat.format(cells)} ${cells === 1 ? 'cell' : 'cells'}`)
  }
  announce(ui.note.textContent)
}

function onPaste(event) {
  const sheet = currentSheet()
  if (!sheet || ui.gridHost.hidden || !isEditable() || textEditing(document.activeElement) || !event.clipboardData) return
  const text = event.clipboardData.getData('text/plain')
  if (!text) return
  event.preventDefault()
  const rows = parseTsv(text)
  const range = grid.range()
  const single = rows.length === 1 && rows[0].length === 1
  const height = single ? range.r1 - range.r0 + 1 : rows.length
  const width = single ? range.c1 - range.c0 + 1 : Math.max(...rows.map((row) => row.length))
  if (height * width > MAX_PASTE_CELLS) {
    showNote(MESSAGES.pasteTooLarge)
    return
  }
  const cells = []
  for (let dr = 0; dr < height; dr++) {
    for (let dc = 0; dc < width; dc++) {
      const typed = single ? rows[0][0] : rows[dr][dc] ?? ''
      const r = range.r0 + dr
      const c = range.c0 + dc
      const parsed = cellFromInput(typed, getCell(sheet, r, c))
      cells.push({ r, c, cell: 'error' in parsed ? { t: 's', v: typed, w: typed } : parsed.cell })
    }
  }
  if (!commit({ type: 'cells', sheet: sheet.name, cells })) return
  grid.dispatch({ type: 'cell', r: range.r0, c: range.c0 })
  grid.dispatch({ type: 'cell', r: range.r0 + height - 1, c: range.c0 + width - 1, extend: true }, 'corner')
  showNote(`Pasted ${countFormat.format(cells.length)} ${cells.length === 1 ? 'cell' : 'cells'}`)
}

// --- Keys --------------------------------------------------------------------------------------

function onTabsKeyDown(event) {
  if (!model) return
  const last = model.sheets.length - 1
  const next =
    event.key === 'ArrowRight' ? Math.min(last, activeIndex + 1)
      : event.key === 'ArrowLeft' ? Math.max(0, activeIndex - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : null
  if (next === null) return
  event.preventDefault()
  showSheet(next)
  ui.tabs.children[next].focus()
}

function onDocumentKeyDown(event) {
  const primary = isMac ? event.metaKey : event.ctrlKey
  if (!primary || event.altKey) return
  const key = event.key.toLowerCase()
  // Orca saves on this shortcut once the session flushes; the open cell edit must be in that.
  if (key === 's') {
    commitEdit()
    return
  }
  if (!isEditable() || textEditing(event.target)) return
  if (key === 'z' || (key === 'y' && !isMac)) {
    event.preventDefault()
    if (key === 'y' || event.shiftKey) redo()
    else undo()
  }
}

$('conflict-apply').addEventListener('click', reapplyRejected)
$('conflict-discard').addEventListener('click', discardRejected)
ui.tabs.addEventListener('keydown', onTabsKeyDown)
document.addEventListener('keydown', onDocumentKeyDown, true)
document.addEventListener('copy', onCopy)
document.addEventListener('cut', onCopy)
document.addEventListener('paste', onPaste)
showMessage(MESSAGES.opening)

// Before the session's own handler, so a save or close includes the cell being typed in.
window.orca.on('editor.flush', () => {
  commitEdit()
})
window.addEventListener('pagehide', () => commitEdit())

window.orca.document
  .session({ decode: codec.decode, encode: codec.encode, merge: codec.merge })
  .then((started) => {
    session = started
    documentReadOnly = started.readOnly
    started.onReplace((next) => receive(next))
    window.orca.document.onDidChange((doc) => {
      if (Boolean(doc?.readOnly) === documentReadOnly) return
      documentReadOnly = Boolean(doc?.readOnly)
      if (!isEditable()) cancelEdit()
      if (model) {
        renderNotice()
        const index = activeIndex
        activeIndex = -1
        showSheet(index)
      }
    })
    receive(started.value)
  })
