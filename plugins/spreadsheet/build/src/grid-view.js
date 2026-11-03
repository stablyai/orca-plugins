// The virtualized grid. One scroll container sizes the sheet with an invisible spacer; a sticky
// viewport inside it stays in view and holds only the rows and columns on screen (plus overscan),
// moved with transforms, so scrolling stays native and wheel and trackpad events need no handling.
import { cellAddress, columnName } from './address.js'
import { cellKind, cellText, isEmptyCell } from './cell-display.js'
import { createAxis } from './axis.js'
import { createMergeIndex } from './merge-index.js'
import { escapeHtml } from './range-copy.js'
import { cellSelection, rangeCellCount, reduceSelection, selectionRange } from './selection.js'
import { computeColumnWidths, computeRowHeights, getCell } from './workbook-model.js'

const HEADER_HEIGHT = 24
const OVERSCAN_ROWS = 10
const OVERSCAN_COLUMNS = 3
const MAX_OVERFLOW_COLUMNS = 12
const MAX_RENDERED_TEXT = 1000
const EDGE_SCROLL_MARGIN = 24

/**
 * @param {HTMLElement} host
 * @param {{ measureText: (text: string) => number, onSelectionChange: () => void,
 *   onSwitchSheet: (delta: number) => void, editable: () => boolean,
 *   onStartEdit: (text: string | null) => void, onClear: () => void,
 *   onContextMenu: (x: number, y: number) => void }} options
 *   `onStartEdit(null)` edits the cell's content; a string replaces it as typing does.
 */
export function createGridView(host, options) {
  host.innerHTML = `
    <div class="scroller" tabindex="-1">
      <div class="spacer" aria-hidden="true"></div>
      <div class="viewport" role="grid" tabindex="0" aria-multiselectable="true" aria-readonly="true">
        <div class="col-header" role="rowgroup"><div class="row" role="row" aria-rowindex="1">
          <div class="corner" role="columnheader" aria-colindex="1" aria-label="Row numbers"></div>
          <div class="strip"></div>
        </div></div>
        <div class="body" role="rowgroup">
          <div class="rows"><div class="row-list"></div><div class="selection" aria-hidden="true"><div class="range"></div><div class="active"></div></div></div>
        </div>
      </div>
    </div>`
  const scroller = host.querySelector('.scroller')
  const spacer = host.querySelector('.spacer')
  const viewport = host.querySelector('.viewport')
  const headerStrip = host.querySelector('.col-header .strip')
  const corner = host.querySelector('.corner')
  const body = host.querySelector('.body')
  const rowsLayer = host.querySelector('.rows')
  const rowList = host.querySelector('.row-list')
  const rangeBox = host.querySelector('.selection .range')
  const activeBox = host.querySelector('.selection .active')
  const idPrefix = `g${Math.random().toString(36).slice(2, 8)}`

  let sheet = null
  let widths = new Float64Array(0)
  let rows = createAxis([])
  let columns = createAxis([])
  let merges = createMergeIndex([])
  let gutter = 40
  let selection = cellSelection(0, 0)
  let rendered = null
  let width = 0
  let height = 0
  let scrollX = 0
  let scrollY = 0
  let drag = null
  let frame = 0

  const context = () => ({
    rowCount: rows.count,
    columnCount: columns.count,
    usedRows: sheet.rowCount,
    usedColumns: sheet.columnCount,
    pageRows: Math.max(1, rows.indexAt(scrollY + height - HEADER_HEIGHT) - rows.indexAt(scrollY)),
    isEmpty: (r, c) => isEmptyCell(getCell(sheet, r, c)),
    merges,
    isRowHidden: rows.isHidden,
    isColumnHidden: columns.isHidden
  })

  /**
   * Shows a sheet. `extent` sizes the grid past the used cells, so an editable sheet has room to
   * type into; `keepWidths` keeps the columns as wide as they were (after an edit to a cell).
   */
  function setSheet(next, state = {}, extent = {}) {
    const previousWidths = state.keepWidths && sheet === next ? widths : null
    sheet = next
    const rowCount = extent.rows ?? sheet.rowCount
    const columnCount = extent.columns ?? sheet.columnCount
    rows = createAxis(computeRowHeights(sheet, rowCount))
    widths = computeColumnWidths(sheet, options.measureText, columnCount)
    if (previousWidths) widths.set(previousWidths.subarray(0, Math.min(previousWidths.length, widths.length)))
    columns = createAxis(widths)
    merges = createMergeIndex(sheet.merges)
    gutter = Math.ceil(options.measureText(String(Math.max(1, rowCount))) + 20)
    selection = state.selection ?? cellSelection(0, 0)
    viewport.setAttribute('aria-label', next.name)
    viewport.setAttribute('aria-readonly', String(!options.editable()))
    viewport.setAttribute('aria-rowcount', String(rows.count + 1))
    viewport.setAttribute('aria-colcount', String(columns.count + 1))
    viewport.style.setProperty('--gutter', `${gutter}px`)
    spacer.style.width = `${gutter + columns.total}px`
    spacer.style.height = `${HEADER_HEIGHT + rows.total}px`
    rendered = null
    measure()
    scroller.scrollTop = state.scrollTop ?? 0
    scroller.scrollLeft = state.scrollLeft ?? 0
    onScroll()
    render()
  }

  function measure() {
    width = scroller.clientWidth
    height = scroller.clientHeight
    viewport.style.width = `${width}px`
    viewport.style.height = `${height}px`
  }

  function visibleWindow() {
    const top = scrollY
    const bottom = scrollY + Math.max(0, height - HEADER_HEIGHT)
    const left = scrollX
    const right = scrollX + Math.max(0, width - gutter)
    return { r0: rows.indexAt(top), r1: rows.indexAt(bottom), c0: columns.indexAt(left), c1: columns.indexAt(right) }
  }

  function onScroll() {
    scrollX = scroller.scrollLeft
    scrollY = scroller.scrollTop
    viewport.style.setProperty('--sx', `${-scrollX}px`)
    rowsLayer.style.transform = `translate3d(0, ${-scrollY}px, 0)`
    const visible = visibleWindow()
    if (
      !rendered ||
      visible.r0 < rendered.r0 || visible.r1 > rendered.r1 ||
      visible.c0 < rendered.c0 || visible.c1 > rendered.c1
    ) {
      render()
    }
  }

  function render() {
    if (!sheet || rows.count === 0 || columns.count === 0) return
    const visible = visibleWindow()
    const area = {
      r0: Math.max(0, visible.r0 - OVERSCAN_ROWS),
      r1: Math.min(rows.count - 1, visible.r1 + OVERSCAN_ROWS),
      c0: Math.max(0, visible.c0 - OVERSCAN_COLUMNS),
      c1: Math.min(columns.count - 1, visible.c1 + OVERSCAN_COLUMNS)
    }
    rendered = area
    const range = selectionRange(selection, merges)
    const { active } = selection

    let header = ''
    for (let c = area.c0; c <= area.c1; c++) {
      if (columns.isHidden(c)) continue
      const lit = c >= range.c0 && c <= range.c1 ? ' lit' : ''
      header += `<div class="col-head${lit}" role="columnheader" aria-colindex="${c + 2}" style="left:${columns.start(c)}px;width:${columns.size(c)}px">${columnName(c)}</div>`
    }
    headerStrip.innerHTML = header

    // Rows to draw: the window, rows holding merges that reach into it, and the active cell's row
    // so aria-activedescendant always names a rendered cell.
    const extraCells = new Map()
    const addExtra = (r, c) => {
      let set = extraCells.get(r)
      if (!set) extraCells.set(r, (set = new Set()))
      set.add(c)
    }
    for (const merge of merges.inWindow(area.r0, area.r1, area.c0, area.c1)) {
      if (merge.s.r < area.r0 || merge.s.c < area.c0) addExtra(merge.s.r, merge.s.c)
    }
    if (active.r < area.r0 || active.r > area.r1 || active.c < area.c0 || active.c > area.c1) {
      addExtra(active.r, active.c)
    }

    let html = ''
    const drawRow = (r, columnList) => {
      if (rows.isHidden(r)) return
      const lit = r >= range.r0 && r <= range.r1 ? ' lit' : ''
      let cells = ''
      for (const c of columnList) cells += cellHtml(r, c, range, area)
      html +=
        `<div class="row" role="row" aria-rowindex="${r + 2}" style="top:${rows.start(r)}px;height:${rows.size(r)}px">` +
        `<div class="row-head${lit}" role="rowheader" aria-colindex="1">${r + 1}</div>` +
        `<div class="strip">${cells}</div></div>`
    }
    const areaColumns = []
    for (let c = area.c0; c <= area.c1; c++) areaColumns.push(c)
    for (const r of [...extraCells.keys()].filter((r) => r < area.r0).sort((a, b) => a - b)) {
      drawRow(r, [...extraCells.get(r)])
    }
    for (let r = area.r0; r <= area.r1; r++) {
      const extra = extraCells.get(r)
      drawRow(r, extra ? [...new Set([...extra, ...areaColumns])].sort((a, b) => a - b) : areaColumns)
    }
    for (const r of [...extraCells.keys()].filter((r) => r > area.r1).sort((a, b) => a - b)) {
      drawRow(r, [...extraCells.get(r)])
    }
    rowList.innerHTML = html
    corner.classList.toggle('lit', range.r0 === 0 && range.c0 === 0 && range.r1 === rows.count - 1 && range.c1 === columns.count - 1)
    positionSelection(range)
    viewport.setAttribute('aria-activedescendant', cellId(active.r, active.c))
  }

  function cellHtml(r, c, range, area) {
    if (columns.isHidden(c)) return ''
    const merge = merges.at(r, c)
    if (merge && (merge.s.r !== r || merge.s.c !== c)) return ''
    const cell = getCell(sheet, r, c)
    const kind = cellKind(cell)
    let w = columns.size(c)
    let h = rows.size(r)
    let span = ''
    if (merge) {
      w = columns.end(merge.e.c) - columns.start(c)
      h = rows.end(merge.e.r) - rows.start(r)
      span = ' merged'
    } else if (kind === 'text') {
      // Like Excel, text runs on over empty cells to its right.
      let next = c + 1
      const limit = Math.min(columns.count - 1, area.c1 + 1, c + MAX_OVERFLOW_COLUMNS)
      while (next <= limit && isEmptyCell(getCell(sheet, r, next)) && !merges.at(r, next)) next++
      if (next > c + 1) {
        w = columns.end(next - 1) - columns.start(c)
        span = ' spill'
      }
    }
    const selected = r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1
    let text = cellText(cell)
    if (text.length > MAX_RENDERED_TEXT) text = text.slice(0, MAX_RENDERED_TEXT)
    return (
      `<div class="cell ${kind}${span}" role="gridcell" id="${cellId(r, c)}" aria-colindex="${c + 2}"` +
      `${selected ? ' aria-selected="true"' : ''} style="left:${columns.start(c)}px;width:${w}px;height:${h}px">` +
      `${escapeHtml(text)}</div>`
    )
  }

  function cellId(r, c) {
    return `${idPrefix}-${r}-${c}`
  }

  function cellRect(r, c) {
    const merge = merges.at(r, c)
    const r1 = merge ? merge.e.r : r
    const c1 = merge ? merge.e.c : c
    return { x: columns.start(merge ? merge.s.c : c), y: rows.start(merge ? merge.s.r : r), x1: columns.end(c1), y1: rows.end(r1) }
  }

  function positionSelection(range) {
    const box = (element, x, y, x1, y1) => {
      element.style.left = `${x}px`
      element.style.top = `${y}px`
      element.style.width = `${Math.max(0, x1 - x)}px`
      element.style.height = `${Math.max(0, y1 - y)}px`
    }
    box(rangeBox, columns.start(range.c0), rows.start(range.r0), columns.end(range.c1), rows.end(range.r1))
    rangeBox.hidden = range.r0 === range.r1 && range.c0 === range.c1
    const active = cellRect(selection.active.r, selection.active.c)
    box(activeBox, active.x, active.y, active.x1, active.y1)
  }

  function scrollIntoView(r, c) {
    const rect = cellRect(r, c)
    const bodyWidth = width - gutter
    const bodyHeight = height - HEADER_HEIGHT
    let top = scroller.scrollTop
    let left = scroller.scrollLeft
    if (rect.y < top) top = rect.y
    else if (rect.y1 > top + bodyHeight) top = Math.min(rect.y, rect.y1 - bodyHeight)
    if (rect.x < left) left = rect.x
    else if (rect.x1 > left + bodyWidth) left = Math.min(rect.x, rect.x1 - bodyWidth)
    if (top !== scroller.scrollTop) scroller.scrollTop = top
    if (left !== scroller.scrollLeft) scroller.scrollLeft = left
    onScroll()
  }

  /** @param {'active' | 'corner' | false} reveal which cell to scroll into view */
  function select(next, reveal) {
    selection = next
    if (reveal) scrollIntoView(next[reveal].r, next[reveal].c)
    render()
    options.onSelectionChange()
  }

  function dispatch(action, reveal = action.extend ? 'corner' : 'active') {
    if (!sheet || rows.count === 0) return
    select(reduceSelection(selection, action, context()), reveal)
  }

  function onKeyDown(event) {
    if (!sheet || rows.count === 0) return
    const primary = event.ctrlKey || event.metaKey
    const extend = event.shiftKey
    if ((event.key === 'F10' && extend && !primary) || event.key === 'ContextMenu') {
      event.preventDefault()
      const box = cellBox(selection.active.r, selection.active.c)
      const bounds = viewport.getBoundingClientRect()
      options.onContextMenu(bounds.left + box.left + Math.min(box.width, 40), bounds.top + box.top + box.height)
      return
    }
    if (options.editable() && !primary && !event.altKey) {
      if (event.key === 'F2') {
        event.preventDefault()
        options.onStartEdit(null)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        options.onClear()
        return
      }
      // Why no preventDefault: the editor takes focus now, so the key (or an IME's first
      // composition) lands in it as typing would.
      if ((event.key.length === 1 && event.key !== ' ') || event.key === 'Process' || (event.key === ' ' && !extend)) {
        options.onStartEdit('')
        return
      }
    }
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    let action = null
    if (event.key in arrows) {
      const [dr, dc] = arrows[event.key]
      if (event.altKey && !primary) {
        if (dc) {
          event.preventDefault()
          options.onSwitchSheet(dc)
        }
        return
      }
      action = { type: 'move', dr, dc, extend, toEdge: primary }
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      const d = event.key === 'PageDown' ? 1 : -1
      if (primary) {
        event.preventDefault()
        options.onSwitchSheet(d)
        return
      }
      action = { type: 'page', dr: d, extend }
    } else if (event.key === 'Home' || event.key === 'End') {
      const start = event.key === 'Home'
      action = { type: primary ? (start ? 'sheetStart' : 'sheetEnd') : start ? 'rowStart' : 'rowEnd', extend }
    } else if (event.key === 'Tab' && !primary && !event.altKey) {
      const { r, c } = selection.active
      const single = rangeCellCount(selectionRange(selection, merges)) === 1
      // Tab leaves the grid from its first or last column so keyboard users reach the sheet tabs.
      if (single && ((extend && c === 0) || (!extend && r === rows.count - 1 && c === columns.count - 1))) return
      action = { type: 'cycle', across: true, back: extend }
    } else if (event.key === 'Enter' && !primary && !event.altKey) {
      action = { type: 'cycle', across: false, back: extend }
    } else if (event.key === 'Escape' && !primary) {
      action = { type: 'cell', r: selection.active.r, c: selection.active.c }
    } else if ((event.key === 'a' || event.key === 'A') && primary && !event.altKey && !extend) {
      action = { type: 'all' }
    } else if (event.key === ' ' && extend && !primary) {
      action = { type: 'row', r: selection.active.r }
    } else if (event.key === ' ' && event.ctrlKey && !extend) {
      action = { type: 'column', c: selection.active.c }
    }
    if (!action) return
    event.preventDefault()
    dispatch(action, action.type === 'all' || action.type === 'row' || action.type === 'column' ? false : undefined)
  }

  function hitTest(clientX, clientY) {
    const bounds = viewport.getBoundingClientRect()
    const x = clientX - bounds.left
    const y = clientY - bounds.top
    const r = rows.indexAt(y - HEADER_HEIGHT + scrollY)
    const c = columns.indexAt(x - gutter + scrollX)
    if (x < gutter && y < HEADER_HEIGHT) return { zone: 'corner', r, c }
    if (x < gutter) return { zone: 'row', r, c }
    if (y < HEADER_HEIGHT) return { zone: 'column', r, c }
    return { zone: 'cell', r, c }
  }

  function onPointerDown(event) {
    if (event.button === 2 && sheet && rows.count > 0) {
      // A right click inside the selection keeps it, so the menu acts on all of it.
      const hit = hitTest(event.clientX, event.clientY)
      const range = selectionRange(selection, merges)
      const inside = hit.r >= range.r0 && hit.r <= range.r1 && hit.c >= range.c0 && hit.c <= range.c1
      const zoneInside = (hit.zone === 'row' && inside) || (hit.zone === 'column' && inside) || (hit.zone === 'cell' && inside) || hit.zone === 'corner'
      viewport.focus({ preventScroll: true })
      if (!zoneInside) {
        if (hit.zone === 'row') dispatch({ type: 'row', r: hit.r }, false)
        else if (hit.zone === 'column') dispatch({ type: 'column', c: hit.c }, false)
        else dispatch({ type: 'cell', r: hit.r, c: hit.c })
      }
      return
    }
    if (event.button !== 0 || !sheet || rows.count === 0 || columns.count === 0) return
    const hit = hitTest(event.clientX, event.clientY)
    event.preventDefault()
    viewport.focus({ preventScroll: true })
    if (event.detail === 2 && hit.zone === 'cell' && options.editable()) {
      dispatch({ type: 'cell', r: hit.r, c: hit.c })
      options.onStartEdit(null)
      return
    }
    if (hit.zone === 'corner') return dispatch({ type: 'all' }, false)
    drag = { zone: hit.zone, x: event.clientX, y: event.clientY }
    viewport.setPointerCapture(event.pointerId)
    if (hit.zone === 'row') dispatch({ type: 'row', r: hit.r, extend: event.shiftKey }, false)
    else if (hit.zone === 'column') dispatch({ type: 'column', c: hit.c, extend: event.shiftKey }, false)
    else dispatch({ type: 'cell', r: hit.r, c: hit.c, extend: event.shiftKey })
    tickDrag()
  }

  function onPointerMove(event) {
    if (!drag) return
    drag.x = event.clientX
    drag.y = event.clientY
    extendDrag()
  }

  function extendDrag() {
    const hit = hitTest(drag.x, drag.y)
    const next =
      drag.zone === 'row'
        ? reduceSelection(selection, { type: 'row', r: hit.r, extend: true }, context())
        : drag.zone === 'column'
          ? reduceSelection(selection, { type: 'column', c: hit.c, extend: true }, context())
          : reduceSelection(selection, { type: 'cell', r: hit.r, c: hit.c, extend: true }, context())
    if (next.corner.r !== selection.corner.r || next.corner.c !== selection.corner.c) select(next, false)
  }

  // While dragging past an edge, keep scrolling that way.
  function tickDrag() {
    cancelAnimationFrame(frame)
    if (!drag) return
    const bounds = viewport.getBoundingClientRect()
    let dx = 0
    let dy = 0
    if (drag.zone !== 'row') {
      if (drag.x < bounds.left + gutter) dx = -1
      else if (drag.x > bounds.right - EDGE_SCROLL_MARGIN) dx = 1
    }
    if (drag.zone !== 'column') {
      if (drag.y < bounds.top + HEADER_HEIGHT) dy = -1
      else if (drag.y > bounds.bottom - EDGE_SCROLL_MARGIN) dy = 1
    }
    if (dx || dy) {
      scroller.scrollLeft += dx * 16
      scroller.scrollTop += dy * 16
      onScroll()
      extendDrag()
    }
    frame = requestAnimationFrame(tickDrag)
  }

  function endDrag(event) {
    if (!drag) return
    drag = null
    cancelAnimationFrame(frame)
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
  }

  /** Where a cell (or the merge it starts) is drawn, in the viewport's pixels. */
  function cellBox(r, c) {
    const rect = cellRect(r, c)
    return { left: gutter + rect.x - scrollX, top: HEADER_HEIGHT + rect.y - scrollY, width: rect.x1 - rect.x, height: rect.y1 - rect.y }
  }

  function onContextMenu(event) {
    event.preventDefault()
    if (sheet && rows.count > 0) options.onContextMenu(event.clientX, event.clientY)
  }

  const resizeObserver = new ResizeObserver(() => {
    measure()
    rendered = null
    onScroll()
  })
  resizeObserver.observe(scroller)
  scroller.addEventListener('scroll', onScroll, { passive: true })
  viewport.addEventListener('keydown', onKeyDown)
  viewport.addEventListener('pointerdown', onPointerDown)
  viewport.addEventListener('pointermove', onPointerMove)
  viewport.addEventListener('pointerup', endDrag)
  viewport.addEventListener('pointercancel', endDrag)
  viewport.addEventListener('contextmenu', onContextMenu)
  scroller.addEventListener('scroll', () => options.onScroll?.(), { passive: true })

  return {
    element: viewport,
    setSheet,
    dispatch,
    cellBox,
    refresh: () => {
      rendered = null
      render()
    },
    scrollIntoView,
    get rowCount() {
      return rows.count
    },
    get columnCount() {
      return columns.count
    },
    focus: () => viewport.focus({ preventScroll: true }),
    get selection() {
      return selection
    },
    range: () => selectionRange(selection, merges),
    merges: () => merges,
    state: () => ({ selection, scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft }),
    activeAddress: () => cellAddress(selection.active.r, selection.active.c),
    destroy() {
      resizeObserver.disconnect()
      cancelAnimationFrame(frame)
      host.innerHTML = ''
    }
  }
}
