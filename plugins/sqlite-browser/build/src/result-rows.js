// The grid's rows of one result, fetched from the worker a page at a time and kept for a while.
export const PAGE_ROWS = 200
const KEPT_PAGES = 40

export class ResultRows {
  constructor(client, result, onArrive) {
    this.client = client
    this.id = result.id
    this.count = result.count
    this.onArrive = onArrive
    this.pages = new Map()
    this.closed = false
    this.error = null
  }

  /** Row `i`, or undefined while its page loads. */
  row(i) {
    const index = Math.floor(i / PAGE_ROWS)
    const page = this.pages.get(index)
    if (page === undefined) {
      this.load(index)
      return undefined
    }
    return page?.[i - index * PAGE_ROWS]
  }

  load(index) {
    this.pages.set(index, null)
    return this.client.call('rows', this.id, index * PAGE_ROWS, PAGE_ROWS).then(
      (rows) => {
        if (this.closed) return
        this.pages.set(index, rows)
        this.trim(index)
        this.onArrive()
      },
      (error) => {
        if (this.closed) return
        // An empty page, so the grid does not ask again; the status shows why.
        this.pages.set(index, [])
        this.error = error
        this.onArrive()
      }
    )
  }

  /** Loads the first page, for column widths. */
  async first() {
    if (this.count > 0) await this.load(0)
  }

  trim(near) {
    if (this.pages.size <= KEPT_PAGES) return
    const far = [...this.pages.keys()].sort((a, b) => Math.abs(b - near) - Math.abs(a - near))
    for (const index of far.slice(0, this.pages.size - KEPT_PAGES)) this.pages.delete(index)
  }

  /** Rows `r0` to `r1` if every one is already here, else null; never fetches. */
  loaded(r0, r1) {
    const rows = []
    for (let i = r0; i <= r1; i++) {
      const row = this.pages.get(Math.floor(i / PAGE_ROWS))?.[i % PAGE_ROWS]
      if (!row) return null
      rows.push(row)
    }
    return rows
  }
}
