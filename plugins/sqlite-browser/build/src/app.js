// The editor page: the sidebar, the query console, the grid and the detail pane. The database lives
// in the worker (sqlite-client.js); this file only asks it for rows.
import { Grid } from './grid.js'
import { quoteId } from './result-query.js'
import { ResultRows } from './result-rows.js'
import { cellText, formatReal, formatSize, hexDump, tsvField } from './value-format.js'

const SCHEMA = '\u0000schema'
const QUERY = '\u0000query'
const DETAIL_TEXT_CHARS = 200000
const HEX_PREVIEW_BYTES = 4096
// Orca's save dialog takes at most 64 MiB.
const MAX_EXPORT_BYTES = 64 * 1024 * 1024
const MAX_COPY_CHARS = 32 * 1024 * 1024
// A sort or query running longer than this shows "Working…" with Cancel.
const BUSY_DELAY_MS = 250

const isMac = navigator.userAgent.includes('Mac')
const nf = new Intl.NumberFormat()
const plural = (n, one, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`
const $ = (id) => document.getElementById(id)

const element = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export class App {
  constructor(client) {
    this.client = client
    this.el = {
      app: $('app'),
      side: $('side'),
      notices: $('notices'),
      title: $('title'),
      meta: $('meta'),
      search: $('search'),
      exportButton: $('export'),
      saveReady: $('save-ready'),
      query: $('query'),
      sql: $('sql'),
      run: $('run'),
      cancel: $('cancel'),
      stop: $('stop'),
      queryMessage: $('query-message'),
      grid: $('grid'),
      gridEmpty: $('grid-empty'),
      sqlview: $('sqlview'),
      detail: $('detail'),
      detailHead: $('detail-head'),
      detailBody: $('detail-body'),
      status: $('status'),
      message: $('message'),
      menu: $('menu'),
      toast: $('toast')
    }
    this.db = null
    this.bytes = null
    this.selected = null
    // The shown result: { rows: ResultRows, columns, label, total } plus what made it.
    this.shown = null
    this.view = emptyView()
    // The last query's own result, which sorts and filters start from.
    this.queryBase = null
    this.querySql = ''
    this.detailCell = null
    this.loads = 0
    this.views = 0
    this.busyTimer = 0
    this.pendingCopy = null
    this.grid = new Grid(this.el.grid, {
      onSelect: () => this.onSelect(),
      onSort: (column) => this.toggleSort(column),
      onFilter: (column, text) => this.setFilter(column, text),
      onContextMenu: (event) => this.openMenu(event),
      onActivate: () => this.el.detailBody.focus?.()
    })
    this.wire()
  }

  // ---- Document ------------------------------------------------------------------------------

  showMessage(title, what, todo) {
    this.el.app.hidden = true
    this.el.message.hidden = false
    this.el.message.querySelector('h1').textContent = title
    this.el.message.querySelector('.what').textContent = what
    this.el.message.querySelector('.todo').textContent = todo ?? ''
  }

  /** Opens a document's bytes; a later call wins over one still opening. */
  async load(value, { afterCancel = false } = {}) {
    const load = ++this.loads
    if (value.error) {
      this.showMessage('Can’t show this file', value.error, 'Update Orca, then reopen the file.')
      return
    }
    let opened
    try {
      opened = await this.client.call('open', value.bytes)
    } catch (error) {
      if (load !== this.loads || error.kind === 'cancelled') return
      this.db = null
      if (error.kind === 'not-sqlite') {
        this.showMessage('Not a SQLite database', error.message, 'Open it with the program that created it.')
      } else {
        this.showMessage('Can’t read this database', error.message, 'If an app is still writing the file, wait and reopen it. Otherwise open a backup copy.')
      }
      return
    }
    if (load !== this.loads) return
    const reopened = this.db !== null
    this.db = opened
    this.bytes = value.bytes
    // The worker's results went with its old database.
    this.shown = null
    this.queryBase = null
    this.el.message.hidden = true
    this.el.app.hidden = false
    this.renderNotices()
    this.renderSide()
    const previous = reopened ? this.selected : null
    const keep =
      previous === SCHEMA || previous === QUERY || this.db.objects.some((object) => object.name === previous && (object.type === 'table' || object.type === 'view' || object.type === 'trigger'))
    const firstTable = this.sorted('table').find((object) => !object.virtual && !object.error)
    if (keep && previous === QUERY && reopened) {
      this.select(QUERY, { keepView: false })
      if (!afterCancel && this.querySql) this.setQueryMessage('The file changed. Run the query again to see its current rows.', false)
      return
    }
    // After Cancel the same sort would only be slow again.
    this.select(keep ? previous : firstTable ? firstTable.name : SCHEMA, { keepView: keep && !afterCancel })
  }

  /** After Cancel, which replaced the worker: opens the same bytes again. */
  async reopenAfterCancel() {
    if (this.bytes) await this.load({ bytes: this.bytes }, { afterCancel: true })
  }

  renderNotices() {
    this.el.notices.textContent = ''
    if (this.db.info.wal) {
      this.el.notices.append(
        element(
          'div',
          'notice',
          'This database uses write-ahead logging. Changes still in its -wal file aren’t shown until the app writing it checkpoints or closes the database.'
        )
      )
    }
  }

  // ---- Sidebar -------------------------------------------------------------------------------

  sorted(type) {
    return this.db.objects
      .filter((object) => object.type === type)
      .sort((a, b) => {
        const internalA = /^sqlite_/i.test(a.name)
        const internalB = /^sqlite_/i.test(b.name)
        if (internalA !== internalB) return internalA ? 1 : -1
        return a.name.localeCompare(b.name)
      })
  }

  sideItem(key, label, count, { bad = false, title = null } = {}) {
    const button = element('button', 'side-item')
    button.dataset.key = key
    button.append(element('span', 'name', label))
    if (count != null) button.append(element('span', `count${bad ? ' bad' : ''}`, count))
    if (title) button.title = title
    return button
  }

  renderSide() {
    const side = this.el.side
    side.textContent = ''
    side.append(this.sideItem(QUERY, 'SQL query', null, { title: 'Run SQL against this database' }))
    side.append(this.sideItem(SCHEMA, 'Schema', null))
    side.append(element('div', 'side-head', 'Tables'))
    const tables = this.sorted('table')
    if (tables.length === 0) side.append(element('div', 'side-empty', 'No tables yet'))
    for (const table of tables) {
      const count = table.error ? '!' : nf.format(table.rowCount)
      side.append(this.sideItem(table.name, table.name, count, { bad: Boolean(table.error), title: table.error }))
    }
    const views = this.sorted('view')
    if (views.length > 0) {
      side.append(element('div', 'side-head', 'Views'))
      for (const view of views) side.append(this.sideItem(view.name, view.name, view.error ? '!' : 'view', { bad: Boolean(view.error), title: view.error }))
    }
    const triggers = this.sorted('trigger')
    if (triggers.length > 0) {
      side.append(element('div', 'side-head', 'Triggers'))
      for (const trigger of triggers) side.append(this.sideItem(trigger.name, trigger.name, 'trigger'))
    }
  }

  markActive() {
    for (const item of this.el.side.querySelectorAll('.side-item')) {
      item.classList.toggle('active', item.dataset.key === this.selected)
    }
  }

  // ---- Main area -----------------------------------------------------------------------------

  /** Shows the query console, the schema or an object. `keepView` keeps sort, filters and scroll. */
  select(key, { keepView = false } = {}) {
    const same = keepView && key === this.selected
    this.selected = key
    this.views += 1
    this.hideMenu()
    this.cancelSave()
    if (!same) this.view = emptyView()
    this.el.search.value = this.view.search
    this.markActive()
    for (const node of [this.el.grid, this.el.sqlview, this.el.query, this.el.search, this.el.exportButton, this.el.gridEmpty]) node.hidden = true
    this.el.meta.textContent = ''
    if (!same) this.dropShown()
    if (key === SCHEMA) {
      this.el.title.textContent = 'Schema'
      this.showSchema()
    } else if (key === QUERY) {
      this.el.title.textContent = 'SQL query'
      this.el.query.hidden = false
      if (!this.el.sql.value) this.el.sql.value = this.starterQuery()
      if (this.queryBase) this.showQueryView({ keepScroll: true })
      else this.grid.clear()
      if (!same) this.el.sql.focus({ preventScroll: true })
    } else {
      const object = this.db.objects.find((candidate) => candidate.name === key)
      this.el.title.textContent = object.name
      if (object.type === 'trigger') {
        this.showSql(object, `A trigger runs this SQL when rows in ${object.tableName || 'its table'} change. It stores no rows of its own.`)
      } else if (object.error) {
        this.showSql(object, `${object.error} The other tables can still be browsed.`)
      } else {
        this.lastObject = object.name
        this.openObject(object, { keepScroll: same })
      }
    }
    this.renderDetail()
    this.renderStatus()
  }

  /** A first query to edit: the rows of the table or view shown last, or of the first table. */
  starterQuery() {
    const last = this.db.objects.find((object) => object.name === this.lastObject && !object.error)
    const target = last ?? this.sorted('table').find((object) => !object.error) ?? this.sorted('view')[0]
    return target ? `SELECT * FROM ${quoteId(target.name)};` : 'SELECT sqlite_version();'
  }

  sqlBlock(object) {
    const item = element('div', 'sql-item')
    const label = element('div', 'label')
    label.append(element('span', 'kind', object.type), element('span', 'name', object.name))
    if (object.type !== 'table' && object.tableName && object.tableName !== object.name) {
      label.append(element('span', 'kind', ` on ${object.tableName}`))
    }
    item.append(label, element('pre', 'sql', object.sql || '(created automatically by SQLite for a UNIQUE or PRIMARY KEY constraint)'))
    return item
  }

  showSchema() {
    const order = { table: 0, view: 1, index: 2, trigger: 3 }
    const objects = [...this.db.objects].sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name))
    this.el.sqlview.textContent = ''
    if (objects.length === 0) {
      this.el.sqlview.append(
        element(
          'p',
          'info-text',
          this.db.info.empty
            ? 'This database file is empty. SQLite fills it in when the first table is created.'
            : 'This database has no tables, views, indexes or triggers yet.'
        )
      )
    }
    for (const object of objects) this.el.sqlview.append(this.sqlBlock(object))
    this.el.meta.textContent = plural(objects.length, 'object')
    this.el.sqlview.hidden = false
  }

  showSql(object, note) {
    this.el.sqlview.textContent = ''
    this.el.sqlview.append(element('p', 'info-text', note), this.sqlBlock(object))
    this.el.sqlview.hidden = false
  }

  // ---- Results -------------------------------------------------------------------------------

  /** Closes the shown result in the worker, unless it is the query's own. */
  dropShown() {
    const shown = this.shown
    this.shown = null
    if (!shown) return
    shown.rows.closed = true
    if (shown.rows.id !== this.queryBase?.id) this.client.call('closeResult', shown.rows.id).catch(() => {})
  }

  async openObject(object, { keepScroll = false } = {}) {
    const views = this.views
    const total = object.type === 'table' ? object.rowCount : null
    await this.showResult(views, () => this.client.call('openObject', object.name, this.view), { total, keepScroll, kind: object.type })
  }

  async showQueryView({ keepScroll = false } = {}) {
    const views = this.views
    const base = this.queryBase
    await this.showResult(views, () => this.client.call('reopen', base.id, this.view), { total: base.count, keepScroll, kind: 'query' })
  }

  /** Asks the worker for a result, then shows its first rows in the grid. */
  async showResult(views, request, { total, keepScroll, kind }) {
    const busy = this.startBusy(this.view.sort || hasFilter(this.view) ? 'Sorting and filtering…' : 'Loading…')
    let result
    try {
      result = await request()
    } catch (error) {
      this.stopBusy(busy)
      if (views !== this.views || error.kind === 'cancelled') return
      this.toast(error.message, true)
      return
    }
    if (views !== this.views) {
      if (result.id !== this.queryBase?.id) this.client.call('closeResult', result.id).catch(() => {})
      this.stopBusy(busy)
      return
    }
    this.dropShown()
    const rows = new ResultRows(this.client, result, () => this.onRowsArrive(rows))
    this.shown = { rows, columns: result.columns, label: result.label, total: total ?? result.count, kind }
    await rows.first()
    this.stopBusy(busy)
    if (views !== this.views) return
    this.el.grid.hidden = false
    this.el.search.hidden = false
    this.el.exportButton.hidden = !canSaveFiles()
    this.grid.show(
      { columns: result.columns, count: result.count, label: result.label, sort: this.view.sort, filters: this.view.filters, row: (i) => rows.row(i) },
      { keepScroll, keepSelection: keepScroll }
    )
    this.el.gridEmpty.hidden = result.count > 0
    this.el.gridEmpty.textContent = hasFilter(this.view) ? 'No rows match.' : result.columns.length === 0 ? 'No columns.' : 'No rows.'
    this.renderMeta()
    this.renderDetail()
    this.renderStatus()
  }

  onRowsArrive(rows) {
    if (this.shown?.rows !== rows) return
    this.grid.refresh()
    if (rows.error) this.toast(rows.error.message, true)
  }

  renderMeta() {
    const shown = this.shown
    if (!shown) return
    const count = shown.rows.count
    let text = hasFilter(this.view) ? `${nf.format(count)} of ${plural(shown.total, 'row')}` : plural(count, 'row')
    text += ` · ${plural(shown.columns.length, 'column')}`
    const object = this.db.objects.find((candidate) => candidate.name === this.selected)
    if (object?.type === 'table' && !object.rowid) text += ' · without rowid'
    this.el.meta.textContent = text
  }

  toggleSort(column) {
    const sort = this.view.sort
    let next
    if (sort?.column !== column) next = { column, descending: false }
    else if (!sort.descending) next = { column, descending: true }
    else next = null
    this.view = { ...this.view, sort: next }
    this.refreshView()
  }

  setFilter(column, text) {
    if ((this.view.filters[column] ?? '') === text) return
    const filters = { ...this.view.filters }
    if (text.trim() === '') delete filters[column]
    else filters[column] = text
    this.view = { ...this.view, filters }
    this.refreshView()
  }

  setSearch(text) {
    if (this.view.search === text) return
    this.view = { ...this.view, search: text }
    this.refreshView()
  }

  /** Shows the current object or query again with the new sort and filters. */
  refreshView() {
    if (!this.shown && this.selected !== QUERY) return
    this.views += 1
    const focusedFilter = document.activeElement?.closest?.('.filter-input')?.dataset.col
    const done = this.selected === QUERY ? (this.queryBase ? this.showQueryView() : Promise.resolve()) : this.openObject(this.db.objects.find((object) => object.name === this.selected))
    done.then(() => {
      // Rebuilding the header replaced the input the person was typing in.
      if (focusedFilter !== undefined) {
        const input = this.el.grid.querySelector(`.filter-input[data-col="${focusedFilter}"]`)
        if (input) {
          input.focus({ preventScroll: true })
          input.setSelectionRange(input.value.length, input.value.length)
        }
      }
    })
  }

  // ---- Query console -------------------------------------------------------------------------

  setQueryMessage(text, error) {
    this.el.queryMessage.textContent = text
    this.el.queryMessage.classList.toggle('error', Boolean(error))
    this.el.queryMessage.title = error ? text : ''
  }

  async runQuery() {
    const textarea = this.el.sql
    const selection = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
    const sql = selection.trim() ? selection : textarea.value
    if (!sql.trim()) {
      this.setQueryMessage('Type a query first, such as SELECT * FROM a table.', false)
      return
    }
    this.selected = QUERY
    this.views += 1
    const views = this.views
    this.querySql = sql
    this.dropShown()
    if (this.queryBase) {
      this.client.call('closeResult', this.queryBase.id).catch(() => {})
      this.queryBase = null
    }
    this.view = emptyView()
    this.el.search.value = ''
    this.setQueryMessage('Running…', false)
    this.el.run.hidden = true
    this.el.cancel.hidden = false
    let ran
    try {
      ran = await this.client.call('run', sql)
    } catch (error) {
      if (views !== this.views) return
      this.queryFinished()
      if (error.kind === 'cancelled') {
        this.setQueryMessage('Cancelled.', false)
        this.grid.clear()
        this.el.grid.hidden = true
        return
      }
      const where = error.statement > 1 ? `Statement ${error.statement}: ` : ''
      const message = /readonly/i.test(error.message) ? 'SQLite Browser only reads, so a query can’t change the database.' : error.message
      this.setQueryMessage(`${where}${message}`, true)
      this.grid.clear()
      this.el.grid.hidden = true
      this.el.search.hidden = true
      this.el.exportButton.hidden = true
      this.el.meta.textContent = ''
      this.renderDetail()
      this.renderStatus()
      return
    }
    if (views !== this.views) return
    this.queryFinished()
    const ms = `${ran.ms < 10 ? ran.ms.toFixed(1) : Math.round(ran.ms)} ms`
    if (!ran.result) {
      this.setQueryMessage(`Ran ${plural(ran.statements, 'statement')}; none returned rows · ${ms}`, false)
      this.grid.clear()
      this.el.grid.hidden = true
      this.el.search.hidden = true
      this.el.exportButton.hidden = true
      this.el.meta.textContent = ''
      this.renderStatus()
      return
    }
    this.queryBase = ran.result
    const statements = ran.statements > 1 ? ` · last of ${ran.statements} statements` : ''
    this.setQueryMessage(`${plural(ran.result.count, 'row')}${statements} · ${ms}`, false)
    await this.showQueryView()
  }

  queryFinished() {
    this.el.run.hidden = false
    this.el.cancel.hidden = true
  }

  cancel() {
    this.client.cancel()
    this.queryFinished()
    this.stopBusy(this.busy)
    this.reopenAfterCancel()
  }

  startBusy(label) {
    const busy = { label }
    this.busy = busy
    clearTimeout(this.busyTimer)
    this.busyTimer = setTimeout(() => {
      if (this.busy !== busy) return
      this.el.meta.textContent = label
      this.el.stop.hidden = false
    }, BUSY_DELAY_MS)
    return busy
  }

  stopBusy(busy) {
    if (this.busy !== busy) return
    this.busy = null
    clearTimeout(this.busyTimer)
    this.el.stop.hidden = true
  }

  // ---- Selection, detail and copy ------------------------------------------------------------

  onSelect() {
    this.renderDetail()
    this.renderStatus()
  }

  focusCell() {
    const sel = this.grid.sel
    return sel && this.shown ? sel.focus : null
  }

  async renderDetail() {
    const focus = this.focusCell()
    const { detail, detailHead, detailBody } = this.el
    detail.hidden = !focus
    if (!focus) {
      this.detailCell = null
      return
    }
    const shown = this.shown
    const key = `${shown.rows.id}:${focus.r}:${focus.c}`
    if (this.detailCell?.key === key) return
    this.detailCell = { key, cell: null }
    let cell
    try {
      cell = await this.client.call('cell', shown.rows.id, focus.r, focus.c)
    } catch {
      return
    }
    if (this.detailCell?.key !== key) return
    this.detailCell.cell = cell
    const column = shown.columns[focus.c]
    detailHead.textContent = ''
    detailBody.className = ''
    detailBody.textContent = ''
    detailHead.append(element('span', 'name', column.name))
    let label = cell.t
    if (cell.t === 'text') label += ` · ${plural(cell.v.length, 'character')}`
    if (cell.t === 'blob') label += ` · ${formatSize(cell.v.length)}`
    detailHead.append(document.createTextNode(label))
    const note = (text) => detailBody.append(element('span', 'note', text))
    if (cell.t === 'null') {
      note('NULL')
    } else if (cell.t === 'blob') {
      detailBody.className = 'hex'
      detailBody.textContent = hexDump(cell.v.subarray(0, HEX_PREVIEW_BYTES))
      if (cell.v.length > HEX_PREVIEW_BYTES) note(`\nShowing the first ${formatSize(HEX_PREVIEW_BYTES)}. Copy gets the whole value as hex.`)
    } else if (cell.t === 'text' && cell.v.length > DETAIL_TEXT_CHARS) {
      detailBody.textContent = cell.v.slice(0, DETAIL_TEXT_CHARS)
      note(`\n\nShowing the first ${nf.format(DETAIL_TEXT_CHARS)} characters. Copy gets the whole value.`)
    } else {
      detailBody.textContent = cell.t === 'real' ? formatReal(cell.v) : String(cell.v)
    }
  }

  /** The selection as clipboard text from rows already here, or null when the worker must read it. */
  copyTextNow(withNames, wholeRows) {
    const range = this.grid.range()
    const shown = this.shown
    if (!range || !shown) return null
    const columns = wholeRows ? shown.columns.map((_, index) => index) : columnRange(range)
    if (!withNames && !wholeRows && range.r0 === range.r1 && range.c0 === range.c1) {
      const cell = this.detailCell
      return cell?.key === `${shown.rows.id}:${range.r0}:${range.c0}` && cell.cell ? cellText(cell.cell) : null
    }
    const rows = range.r1 - range.r0 < 5000 ? shown.rows.loaded(range.r0, range.r1) : null
    if (!rows) return null
    const cells = rows.map((row) => columns.map((index) => row.cells[index]))
    if (cells.some((row) => row.some((cell) => cell.clipped || cell.t === 'blob'))) return null
    const lines = withNames ? [columns.map((index) => tsvField(shown.columns[index].name)).join('\t')] : []
    for (const row of cells) lines.push(row.map((cell) => tsvField(cellText(cell))).join('\t'))
    return lines.join('\n')
  }

  /** Copies the selection: from rows already here, else from the worker and then the clipboard. */
  async copySelection({ withNames = false, wholeRows = false } = {}) {
    const now = this.copyTextNow(withNames, wholeRows)
    if (now !== null) {
      this.writeClipboard(now)
      return
    }
    const range = this.grid.range()
    const shown = this.shown
    if (!range || !shown) return
    const columns = wholeRows ? null : columnRange(range)
    try {
      const text = await this.client.call('copy', shown.rows.id, range.r0, range.r1 - range.r0 + 1, columns, withNames, MAX_COPY_CHARS)
      this.writeClipboard(text)
    } catch (error) {
      if (error.kind !== 'cancelled') this.toast(error.message, true)
    }
  }

  /** Clipboard writes through the copy event: Orca's frames refuse navigator.clipboard. */
  writeClipboard(text) {
    this.pendingCopy = text
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    this.pendingCopy = null
    if (!copied) this.toast('Couldn’t copy. Try again right after a click or key press.', true)
  }

  // ---- Export --------------------------------------------------------------------------------

  async exportCsv() {
    const shown = this.shown
    if (!shown) return
    this.cancelSave()
    const name = `${safeFileName(this.selected === QUERY ? 'query' : this.selected)}.csv`
    let data
    const busy = this.startBusy('Preparing CSV…')
    try {
      data = await this.client.call('csv', shown.rows.id, MAX_EXPORT_BYTES)
    } catch (error) {
      this.stopBusy(busy)
      if (error.kind !== 'cancelled') this.toast(error.message, true)
      return
    }
    this.stopBusy(busy)
    this.renderMeta()
    const request = { suggestedName: name, mimeType: 'text/csv', data }
    // Why: Orca opens its save dialog only within a click's activation, which a slow export outlives.
    if (navigator.userActivation?.isActive === false) {
      this.offerSave(request)
      return
    }
    await this.saveAs(request)
  }

  async saveAs(request) {
    try {
      const result = await window.orca.files.saveAs(request)
      if (result?.status === 'saved') this.toast(`Saved ${request.suggestedName}`, false)
    } catch (error) {
      if (error?.code !== 'cancelled') this.toast(error?.message ?? 'Couldn’t save the CSV.', true)
    }
  }

  offerSave(request) {
    const bar = this.el.saveReady
    bar.textContent = ''
    const save = element('button', 'btn primary', 'Save…')
    save.type = 'button'
    const dismiss = element('button', 'btn', 'Cancel')
    dismiss.type = 'button'
    save.addEventListener('click', () => {
      this.cancelSave()
      this.saveAs(request)
    })
    dismiss.addEventListener('click', () => this.cancelSave())
    bar.append(element('span', null, `${request.suggestedName} is ready.`), save, dismiss)
    bar.hidden = false
    this.el.exportButton.hidden = true
    save.focus()
  }

  cancelSave() {
    this.el.saveReady.hidden = true
    this.el.saveReady.textContent = ''
    if (this.shown && canSaveFiles()) this.el.exportButton.hidden = false
  }

  // ---- Menu and toast ------------------------------------------------------------------------

  openMenu(event) {
    const menu = this.el.menu
    menu.textContent = ''
    const mod = isMac ? '⌘' : 'Ctrl+'
    const range = this.grid.range()
    const many = range && (range.r0 !== range.r1 || range.c0 !== range.c1)
    const items = [
      [many ? 'Copy' : 'Copy value', `${mod}C`, () => this.copySelection()],
      ['Copy with column names', '', () => this.copySelection({ withNames: true })],
      [range && range.r0 !== range.r1 ? 'Copy rows' : 'Copy row', '', () => this.copySelection({ wholeRows: true, withNames: true })]
    ]
    for (const [label, keys, action] of items) {
      const item = element('button', 'menu-item')
      item.type = 'button'
      item.append(element('span', null, label))
      if (keys) item.append(element('kbd', null, keys))
      item.addEventListener('click', () => {
        this.hideMenu()
        action()
      })
      menu.append(item)
    }
    menu.hidden = false
    const { innerWidth, innerHeight } = window
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 4)}px`
    menu.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 4)}px`
    menu.querySelector('.menu-item')?.focus({ preventScroll: true })
  }

  hideMenu() {
    if (this.el.menu.hidden) return
    this.el.menu.hidden = true
    this.el.grid.focus({ preventScroll: true })
  }

  toast(text, error) {
    const toast = this.el.toast
    toast.textContent = text
    toast.classList.toggle('error', Boolean(error))
    toast.hidden = false
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => {
      toast.hidden = true
    }, error ? 6000 : 2500)
  }

  // ---- Status --------------------------------------------------------------------------------

  renderStatus() {
    const db = this.db
    if (!db) return
    const { info } = db
    const parts = info.empty
      ? ['Empty file']
      : [plural(info.pageCount, 'page'), `${formatSize(info.pageSize)} page size`, info.encoding, info.sqliteVersion ? `SQLite ${info.sqliteVersion}` : null]
    parts.push('Read-only')
    const status = this.el.status
    status.textContent = ''
    for (const part of parts.filter(Boolean)) status.append(element('span', null, part))
    status.append(element('span', 'grow'))
    const range = this.grid.range()
    if (this.shown && range && (range.r0 !== range.r1 || range.c0 !== range.c1)) {
      status.append(element('span', null, `${plural(range.r1 - range.r0 + 1, 'row')} × ${plural(range.c1 - range.c0 + 1, 'column')} selected`))
    }
  }

  // ---- Wiring --------------------------------------------------------------------------------

  wire() {
    this.el.side.addEventListener('click', (event) => {
      const item = event.target.closest('.side-item')
      if (item) this.select(item.dataset.key)
    })

    let searchTimer = 0
    this.el.search.addEventListener('input', () => {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => this.setSearch(this.el.search.value), 300)
    })
    this.el.search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.el.search.value) {
        this.el.search.value = ''
        clearTimeout(searchTimer)
        this.setSearch('')
      } else if (event.key === 'Enter') {
        clearTimeout(searchTimer)
        this.setSearch(this.el.search.value)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        this.el.grid.focus()
      }
    })

    this.el.run.textContent = ''
    this.el.run.append(element('span', null, 'Run'), element('kbd', null, isMac ? '⌘↵' : 'Ctrl+Enter'))
    this.el.run.addEventListener('click', () => this.runQuery())
    this.el.cancel.addEventListener('click', () => this.cancel())
    this.el.stop.addEventListener('click', () => this.cancel())
    this.el.sql.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)) {
        event.preventDefault()
        if (this.el.cancel.hidden) this.runQuery()
      }
    })
    this.el.exportButton.addEventListener('click', () => this.exportCsv())

    document.addEventListener('copy', (event) => {
      if (this.pendingCopy !== null) {
        event.clipboardData.setData('text/plain', this.pendingCopy)
        event.preventDefault()
        return
      }
      // Text fields and selected text in the detail pane or schema copy as usual.
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed && !this.el.grid.contains(selection.anchorNode)) return
      if (!this.grid.range()) return
      const now = this.copyTextNow(false, false)
      event.preventDefault()
      if (now !== null) {
        event.clipboardData.setData('text/plain', now)
      } else {
        this.copySelection()
      }
    })

    document.addEventListener('mousedown', (event) => {
      if (!this.el.menu.hidden && !this.el.menu.contains(event.target)) this.hideMenu()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.el.menu.hidden) {
        event.preventDefault()
        this.hideMenu()
      }
    })
    window.addEventListener('blur', () => this.hideMenu())
  }
}

const emptyView = () => ({ sort: null, filters: {}, search: '' })
const hasFilter = (view) => Boolean(view.search.trim()) || Object.keys(view.filters).length > 0
const columnRange = (range) => Array.from({ length: range.c1 - range.c0 + 1 }, (_, index) => range.c0 + index)
const safeFileName = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'export'

/** Whether Orca offers its save dialog here: desktop isolated frames do. */
export const canSaveFiles = () => typeof window.orca?.files?.saveAs === 'function' && window.orca.host?.has?.('files.saveAs') !== false
