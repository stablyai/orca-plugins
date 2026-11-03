// The page's side of sqlite-worker.js: each call is a promise. `cancel()` stops a long query by
// replacing the worker, which loses its database and results, so the caller opens the file again.
export class SqliteClient {
  constructor(workerUrl) {
    this.workerUrl = workerUrl
    this.pending = new Map()
    this.nextId = 1
    this.start()
  }

  start() {
    this.worker = new Worker(this.workerUrl, { type: 'module' })
    this.worker.addEventListener('message', (event) => {
      const { id, ok, value, error } = event.data
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if (ok) pending.resolve(value)
      else pending.reject(Object.assign(new Error(error.message), error))
    })
    this.worker.addEventListener('error', (event) => {
      event.preventDefault()
      this.failAll(event.message || 'The database worker stopped.')
    })
  }

  failAll(message) {
    for (const { reject } of this.pending.values()) reject(Object.assign(new Error(message), { kind: 'worker' }))
    this.pending.clear()
  }

  call(op, ...args) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, op, args })
    })
  }

  /** Stops whatever the worker is doing; every pending call rejects with kind `cancelled`. */
  cancel() {
    this.worker.terminate()
    for (const { reject } of this.pending.values()) reject(Object.assign(new Error('Cancelled'), { kind: 'cancelled' }))
    this.pending.clear()
    this.start()
  }
}
