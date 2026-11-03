// Entry of editor/index.html. Starts the worker, then the document session: it resolves once Orca's
// hello brought the theme, so a dark Orca never shows a light page.
import { App } from './app.js'
import { openDatabaseSession } from './document-session.js'
import { SqliteClient } from './sqlite-client.js'

// WORKER_FILE is the built worker's name next to this file (build.mjs defines it).
const client = new SqliteClient(new URL(`./${WORKER_FILE}`, import.meta.url))
const app = new App(client)

if (typeof window.orca?.document?.session === 'function') {
  openDatabaseSession().then((doc) => {
    app.load(doc.value)
    doc.onReplace((value) => app.load(value))
  })
} else {
  app.showMessage('Can’t show this file', 'SQLite Browser needs Orca 1.4.248 or later.', 'Update Orca, then reopen the file.')
}
