// The virtual grid: draws only the rows on screen, so millions of rows scroll smoothly. Rows come
// from `model.row(i)`, which may answer undefined until its page arrives; call `refresh()` then.
import { formatReal, formatSize } from './value-format.js'

export const ROW_H = 22
// Browsers cap element heights near 16-33M px; past this the scrollbar maps onto rows by ratio.
const MAX_SCROLL_PX = 8000000
const FILTER_DELAY_MS = 300
const FILTER_HELP = 'Keep rows whose value contains this text. Also: =x, !=x, >x, >=x, <x, <=x, null, !null'

/** How a grid cell reads: `{ text, cls }`. */
export function cellView(cell) {
  if (!cell) return { text: '', cls: '' }
  switch (cell.t) {
    case 'null':
      return { text: 'NULL', cls: 'c-null' }
    case 'integer':
      return { text: String(cell.v), cls: 'c-num' }
    case 'real':
      return { text: formatReal(cell.v), cls: 'c-num' }
    case 'blob':
      return { text: `<blob ${formatSize(cell.size ?? cell.v?.length ?? 0)}>`, cls: 'c-blob' }
    default:
      return { text: cell.clipped ? `${cell.v}…` : String(cell.v), cls: '' }
  }
}

const element = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export class Grid {
  /**
   * `handlers`: onSelect(), onSort(column), onFilter(column, text), onContextMenu(event) and
   * onActivate() (Enter on a cell).
   */
  constructor(root, handlers) {
    this.root = root
    this.handlers = handlers
    this.head = element('div', 'g-head')
    this.names = element('div', 'g-names')
    this.filterRow = element('div', 'g-filters')
    this.head.append(this.names, this.filterRow)
    this.spacer = element('div', 'g-spacer')
    this.body = element('div', 'g-body')
    this.rowsEl = element('div', 'g-rows')
    this.body.append(this.rowsEl)
    root.append(this.head, this.spacer, this.body)
    this.model = null
    this.pool = []
    this.widths = []
    this.gutterW = 56
    this.sel = null
    this.filterTimer = 0
    this.resizedAt = -Infinity
    this.wire()
  }

  get headH() {
    return ROW_H * 2 + 2
  }

  /** Shows a result. `model`: { columns, count, label, sort, filters, row(i) }. */
  show(model, { keepScroll = false, keepSelection = false } = {}) {
    const sameColumns =
      this.model && this.model.columns.length === model.columns.length && this.model.columns.every((column, index) => column.name === model.columns[index].name)
    this.model = model
    if (!keepSelection) this.sel = null
    if (!sameColumns || !keepScroll) this.computeWidths()
    this.buildHead()
    this.pool = []
    this.buildPool()
    this.applyWidths()
    this.layoutHeight()
    if (!keepScroll) {
      this.root.scrollTop = 0
      this.root.scrollLeft = 0
    }
    this.clampSelection()
    this.renderRows()
  }

  clear() {
    this.model = null
    this.sel = null
    this.head.style.width = ''
    this.names.textContent = ''
    this.filterRow.textContent = ''
    this.rowsEl.textContent = ''
    this.pool = []
  }

  refresh() {
    if (this.model) this.renderRows()
  }

  measure(text) {
    if (!this.measureCtx) {
      this.measureCtx = document.createElement('canvas').getContext('2d')
      this.measureCtx.font = getComputedStyle(this.root).font
    }
    return this.measureCtx.measureText(text).width
  }

  computeWidths() {
    const { columns, count } = this.model
    const widths = columns.map((column) => this.measure(column.name + (column.type ? `  ${column.type}` : '')) + 40)
    const labels = ['Filter', this.model.label === 'rowid' ? 'rowid' : '#', String(count)]
    for (let i = 0; i < Math.min(count, 200); i++) {
      const row = this.model.row(i)
      if (!row) break
      labels.push(row.label)
      columns.forEach((_, j) => {
        const view = cellView(row.cells[j])
        // Why zeros: numbers draw with tabular digits, which the canvas does not measure.
        const text = view.cls === 'c-num' ? view.text.replace(/\d/g, '0') : view.text.slice(0, 60)
        widths[j] = Math.max(widths[j], this.measure(text) + 18)
      })
    }
    this.widths = widths.map((width) => Math.round(Math.min(Math.max(width, 60), 360)))
    this.gutterW = Math.round(Math.max(...labels.map((label) => this.measure(label.replace(/\d/g, '0')))) + 20)
  }

  makeCell(cls, width) {
    const cell = element('div', `g-cell${cls ? ` ${cls}` : ''}`)
    cell.style.width = `${width}px`
    return cell
  }

  buildHead() {
    const { columns, sort, filters } = this.model
    this.names.textContent = ''
    this.filterRow.textContent = ''
    const gutter = this.makeCell('g-gutter', this.gutterW)
    gutter.textContent = this.model.label === 'rowid' ? 'rowid' : '#'
    this.names.append(gutter)
    const filterGutter = this.makeCell('g-gutter g-filter-gutter', this.gutterW)
    filterGutter.textContent = 'Filter'
    this.filterRow.append(filterGutter)
    columns.forEach((column, j) => {
      const cell = this.makeCell('g-name', this.widths[j])
      cell.dataset.col = j
      cell.title = `${column.name}${column.type ? ` ${column.type}` : ''}${column.pk ? ' · primary key' : ''}${column.generated ? ' · generated' : ''}\nClick to sort`
      cell.append(element('span', 'label', column.name))
      if (column.type) cell.append(element('span', 'type', column.type))
      if (sort?.column === j) {
        cell.append(element('span', 'sort', sort.descending ? '↓' : '↑'))
        cell.setAttribute('aria-sort', sort.descending ? 'descending' : 'ascending')
      }
      const resize = element('div', 'rz')
      resize.dataset.col = j
      cell.append(resize)
      this.names.append(cell)
      const filterCell = this.makeCell('g-filter', this.widths[j])
      const input = element('input', 'filter-input')
      input.type = 'text'
      input.spellcheck = false
      input.autocomplete = 'off'
      input.placeholder = 'Filter'
      input.title = FILTER_HELP
      input.setAttribute('aria-label', `Filter ${column.name}`)
      input.dataset.col = j
      input.value = filters?.[j] ?? ''
      filterCell.append(input)
      this.filterRow.append(filterCell)
    })
  }

  buildPool() {
    const need = Math.ceil(Math.max(this.root.clientHeight, 200) / ROW_H) + 2
    if (this.pool.length === need && this.pool.cols === this.model.columns.length) return
    this.rowsEl.textContent = ''
    this.pool = []
    this.pool.cols = this.model.columns.length
    for (let k = 0; k < need; k++) {
      const row = element('div', 'g-row')
      row.append(this.makeCell('g-gutter', this.gutterW))
      for (let j = 0; j < this.model.columns.length; j++) {
        const cell = this.makeCell('', this.widths[j])
        cell.dataset.col = j
        row.append(cell)
      }
      this.rowsEl.append(row)
      this.pool.push(row)
    }
  }

  totalWidth() {
    return this.widths.reduce((sum, width) => sum + width, this.gutterW)
  }

  applyWidths() {
    const total = `${this.totalWidth()}px`
    for (const node of [this.head, this.spacer, this.body]) node.style.width = total
    for (const row of [this.names, this.filterRow, ...this.pool]) {
      const cells = row.children
      cells[0].style.width = `${this.gutterW}px`
      for (let j = 0; j < this.widths.length; j++) cells[j + 1].style.width = `${this.widths[j]}px`
    }
  }

  layoutHeight() {
    this.virtualH = Math.min(this.model.count * ROW_H, MAX_SCROLL_PX)
    this.spacer.style.height = `${this.virtualH}px`
  }

  viewportRowsH() {
    return Math.max(this.root.clientHeight - this.headH, 0)
  }

  // Map between the scrollbar and the true row offset; they differ only past MAX_SCROLL_PX.
  scrollToPos(scrollTop) {
    const real = this.model.count * ROW_H
    if (real <= MAX_SCROLL_PX) return scrollTop
    const span = this.virtualH - this.viewportRowsH()
    return span > 0 ? (scrollTop / span) * (real - this.viewportRowsH()) : 0
  }

  posToScroll(pos) {
    const real = this.model.count * ROW_H
    if (real <= MAX_SCROLL_PX) return pos
    const span = real - this.viewportRowsH()
    return span > 0 ? (pos / span) * (this.virtualH - this.viewportRowsH()) : 0
  }

  /** The selected rectangle as `{ r0, r1, c0, c1 }` (inclusive), or null. */
  range() {
    if (!this.sel) return null
    const { anchor, focus } = this.sel
    return {
      r0: Math.min(anchor.r, focus.r),
      r1: Math.max(anchor.r, focus.r),
      c0: Math.min(anchor.c, focus.c),
      c1: Math.max(anchor.c, focus.c)
    }
  }

  inRange(range, r, c) {
    return range !== null && r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1
  }

  renderRows() {
    const { model } = this
    if (!model || this.root.hidden) return
    const top = this.root.scrollTop
    const pos = this.scrollToPos(top)
    const first = Math.floor(pos / ROW_H)
    const shift = pos - first * ROW_H
    this.body.style.top = `${top + this.headH}px`
    this.body.style.height = `${this.viewportRowsH()}px`
    this.rowsEl.style.transform = `translateY(${-shift}px)`
    const range = this.range()
    const focus = this.sel?.focus
    for (let k = 0; k < this.pool.length; k++) {
      const rowEl = this.pool[k]
      const v = first + k
      if (v >= model.count) {
        rowEl.hidden = true
        continue
      }
      rowEl.hidden = false
      rowEl.dataset.v = v
      const row = model.row(v)
      const cells = rowEl.children
      cells[0].textContent = row ? row.label : ''
      rowEl.classList.toggle('row-sel', range !== null && v >= range.r0 && v <= range.r1)
      for (let j = 0; j < model.columns.length; j++) {
        const view = row ? cellView(row.cells[j]) : { text: '', cls: 'c-pending' }
        const cell = cells[j + 1]
        cell.textContent = view.text
        let cls = 'g-cell'
        if (view.cls) cls += ` ${view.cls}`
        if (this.inRange(range, v, j)) cls += ' in-sel'
        if (focus && focus.r === v && focus.c === j) cls += ' sel'
        cell.className = cls
      }
    }
  }

  setSelection(anchor, focus, reveal) {
    const { count, columns } = this.model
    if (!count || !columns.length) return
    const clamp = (point) => ({
      r: Math.max(0, Math.min(count - 1, point.r)),
      c: Math.max(0, Math.min(columns.length - 1, point.c))
    })
    this.sel = { anchor: clamp(anchor), focus: clamp(focus) }
    if (reveal) this.reveal()
    this.renderRows()
    this.handlers.onSelect()
  }

  clampSelection() {
    if (!this.sel) return
    if (!this.model.count || !this.model.columns.length) {
      this.sel = null
      return
    }
    const { count, columns } = this.model
    for (const point of [this.sel.anchor, this.sel.focus]) {
      point.r = Math.min(point.r, count - 1)
      point.c = Math.min(point.c, columns.length - 1)
    }
  }

  clearSelection() {
    this.sel = null
    this.renderRows()
    this.handlers.onSelect()
  }

  reveal() {
    const { focus } = this.sel
    const pos = this.scrollToPos(this.root.scrollTop)
    const rowTop = focus.r * ROW_H
    const height = this.viewportRowsH()
    if (rowTop < pos) this.root.scrollTop = this.posToScroll(rowTop)
    else if (rowTop + ROW_H > pos + height) this.root.scrollTop = this.posToScroll(rowTop + ROW_H - height)
    let left = this.gutterW
    for (let j = 0; j < focus.c; j++) left += this.widths[j]
    const right = left + this.widths[focus.c]
    const scrollLeft = this.root.scrollLeft
    const width = this.root.clientWidth
    if (left - this.gutterW < scrollLeft) this.root.scrollLeft = left - this.gutterW
    else if (right > scrollLeft + width) this.root.scrollLeft = right - width
  }

  pointAt(target) {
    const rowEl = target.closest('.g-row')
    const cell = target.closest('.g-cell')
    if (!rowEl || !cell) return null
    const r = Number(rowEl.dataset.v)
    if (cell.classList.contains('g-gutter')) return { r, gutter: true }
    return { r, c: Number(cell.dataset.col) }
  }

  wire() {
    this.root.addEventListener('scroll', () => this.renderRows(), { passive: true })
    new ResizeObserver(() => {
      if (!this.model || this.root.hidden) return
      this.buildPool()
      this.applyWidths()
      this.renderRows()
    }).observe(this.root)

    let dragging = null
    this.body.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || !this.model) return
      const point = this.pointAt(event.target)
      if (!point) return
      event.preventDefault()
      this.root.focus({ preventScroll: true })
      const last = this.model.columns.length - 1
      if (point.gutter) {
        const anchorRow = event.shiftKey && this.sel ? this.sel.anchor.r : point.r
        this.setSelection({ r: anchorRow, c: 0 }, { r: point.r, c: last }, false)
        dragging = 'rows'
      } else {
        const anchor = event.shiftKey && this.sel ? this.sel.anchor : point
        this.setSelection(anchor, point, false)
        dragging = 'cells'
      }
    })
    this.body.addEventListener('mousemove', (event) => {
      if (!dragging || !(event.buttons & 1) || !this.sel) {
        dragging = null
        return
      }
      const point = this.pointAt(event.target)
      if (!point) return
      const focus = dragging === 'rows' || point.gutter ? { r: point.r, c: this.sel.focus.c } : point
      if (focus.r !== this.sel.focus.r || focus.c !== this.sel.focus.c) this.setSelection(this.sel.anchor, focus, false)
    })
    window.addEventListener('mouseup', () => {
      dragging = null
    })
    this.body.addEventListener('contextmenu', (event) => {
      const point = this.pointAt(event.target)
      if (!point || !this.model) return
      event.preventDefault()
      const range = this.range()
      const column = point.gutter ? 0 : point.c
      if (!this.inRange(range, point.r, column)) {
        const last = this.model.columns.length - 1
        if (point.gutter) this.setSelection({ r: point.r, c: 0 }, { r: point.r, c: last }, false)
        else this.setSelection(point, point, false)
      }
      this.handlers.onContextMenu(event)
    })
    this.body.addEventListener('dblclick', (event) => {
      if (this.pointAt(event.target)) this.handlers.onActivate()
    })

    this.root.addEventListener('keydown', (event) => this.onKeyDown(event))

    this.names.addEventListener('click', (event) => {
      // Why the time: releasing a resize over the header also clicks it.
      if (event.target.closest('.rz') || performance.now() - this.resizedAt < 300) return
      const cell = event.target.closest('.g-name')
      if (cell) this.handlers.onSort(Number(cell.dataset.col))
    })
    this.names.addEventListener('pointerdown', (event) => this.startResize(event))

    this.filterRow.addEventListener('input', (event) => {
      const input = event.target.closest('.filter-input')
      if (!input) return
      clearTimeout(this.filterTimer)
      this.filterTimer = setTimeout(() => this.handlers.onFilter(Number(input.dataset.col), input.value), FILTER_DELAY_MS)
    })
    this.filterRow.addEventListener('keydown', (event) => {
      const input = event.target.closest('.filter-input')
      if (!input) return
      event.stopPropagation()
      if (event.key === 'Enter') {
        clearTimeout(this.filterTimer)
        this.handlers.onFilter(Number(input.dataset.col), input.value)
      } else if (event.key === 'Escape' && input.value) {
        input.value = ''
        clearTimeout(this.filterTimer)
        this.handlers.onFilter(Number(input.dataset.col), '')
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        this.root.focus({ preventScroll: true })
        if (!this.sel) this.setSelection({ r: 0, c: Number(input.dataset.col) }, { r: 0, c: Number(input.dataset.col) }, true)
      }
    })
  }

  onKeyDown(event) {
    if (!this.model || event.target.closest('.filter-input')) return
    const sel = this.sel ?? { anchor: { r: 0, c: 0 }, focus: { r: 0, c: 0 } }
    const { focus } = sel
    const page = Math.max(1, Math.floor(this.viewportRowsH() / ROW_H) - 1)
    const mod = event.metaKey || event.ctrlKey
    const lastRow = this.model.count - 1
    const lastCol = this.model.columns.length - 1
    let next = null
    switch (event.key) {
      case 'ArrowDown':
        next = { r: mod ? lastRow : focus.r + 1, c: focus.c }
        break
      case 'ArrowUp':
        next = { r: mod ? 0 : focus.r - 1, c: focus.c }
        break
      case 'ArrowRight':
        next = { r: focus.r, c: mod ? lastCol : focus.c + 1 }
        break
      case 'ArrowLeft':
        next = { r: focus.r, c: mod ? 0 : focus.c - 1 }
        break
      case 'PageDown':
        next = { r: focus.r + page, c: focus.c }
        break
      case 'PageUp':
        next = { r: focus.r - page, c: focus.c }
        break
      case 'Home':
        next = mod ? { r: 0, c: 0 } : { r: focus.r, c: 0 }
        break
      case 'End':
        next = mod ? { r: lastRow, c: lastCol } : { r: focus.r, c: lastCol }
        break
      case 'Enter':
        if (this.sel) {
          event.preventDefault()
          this.handlers.onActivate()
        }
        return
      case 'a':
        if (mod && lastRow >= 0) {
          event.preventDefault()
          this.setSelection({ r: 0, c: 0 }, { r: lastRow, c: lastCol }, false)
        }
        return
      case 'Escape':
        if (this.sel) {
          event.preventDefault()
          this.clearSelection()
        }
        return
      default:
        return
    }
    event.preventDefault()
    this.setSelection(event.shiftKey ? sel.anchor : next, next, true)
  }

  startResize(event) {
    const handle = event.target.closest('.rz')
    if (!handle) return
    event.preventDefault()
    const column = Number(handle.dataset.col)
    const startX = event.clientX
    const startWidth = this.widths[column]
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent) => {
      this.widths[column] = Math.max(40, Math.round(startWidth + moveEvent.clientX - startX))
      this.applyWidths()
    }
    const up = () => {
      this.resizedAt = performance.now()
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
}
