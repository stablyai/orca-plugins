// A stand-in for Orca's custom editor host: the same shell (CSP, design tokens, html class, and the
// part of `window.orca` this editor uses) in a sandboxed srcdoc frame, posting the file's bytes once
// the editor is ready. Headless Chromium only.
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const HERE = import.meta.dirname
export const EDITOR_HTML = readFileSync(path.resolve(HERE, '..', '..', 'editor', 'index.html'), 'utf8')

// Same as PLUGIN_PANEL_CSP in Orca's src/shared/plugins/plugin-panel-shell.ts.
const CSP =
  "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

// Orca's light and dark tokens from src/renderer/src/assets/main.css.
const TOKENS = {
  light: {
    background: '#fff', foreground: '#0a0a0a', card: '#fff', 'card-foreground': '#0a0a0a', popover: '#fff',
    'popover-foreground': '#0a0a0a', primary: '#171717', 'primary-foreground': '#fafafa', secondary: '#f5f5f5',
    'secondary-foreground': '#171717', muted: '#f5f5f5', 'muted-foreground': '#737373', accent: '#f5f5f5',
    'accent-foreground': '#171717', destructive: '#e40014', 'destructive-foreground': '#fcf3f3', border: '#e5e5e5',
    input: '#e5e5e5', ring: '#a1a1a1', radius: '0.625rem'
  },
  dark: {
    background: '#0a0a0a', foreground: '#fafafa', card: '#171717', 'card-foreground': '#fafafa', popover: '#171717',
    'popover-foreground': '#fafafa', primary: '#e5e5e5', 'primary-foreground': '#171717', secondary: '#262626',
    'secondary-foreground': '#fafafa', muted: '#262626', 'muted-foreground': '#a1a1a1', accent: '#404040',
    'accent-foreground': '#fafafa', destructive: '#ff6568', 'destructive-foreground': '#df2225',
    border: 'rgb(255 255 255 / 0.07)', input: 'rgb(255 255 255 / 0.15)', ring: '#737373', radius: '0.625rem'
  }
}

// The document half of Orca's frame API, with a small stand-in for `session()`; the real ones are in
// Orca's plugin-panel-shell.ts. Edits are posted to the host page, which keeps them in __edits.
const ORCA_SHIM = `(function () {
  var listeners = []
  var latest = null
  var waiting = []
  var post = function (message) { window.parent.postMessage(Object.assign({ orca: 1 }, message), '*') }
  function emit(doc) {
    latest = doc
    waiting.splice(0).forEach(function (fn) { fn(doc) })
    listeners.forEach(function (fn) { fn(doc) })
  }
  function applyEdit(edit) {
    post({ kind: 'evt', event: 'test.edit', payload: edit })
    return Promise.resolve(null)
  }
  function session(o) {
    var first = latest ? Promise.resolve(latest) : new Promise(function (resolve) { waiting.push(resolve) })
    return first.then(function (doc) {
      var version = doc.version
      var readOnly = doc.readOnly
      var value = o.decode(doc.content)
      var base = value
      var timer = null
      var replaced = []
      function send() {
        clearTimeout(timer)
        timer = null
        var content = o.encode(value)
        return applyEdit({ baseVersion: version, content: content }).then(function () { o.decode(content) })
      }
      listeners.push(function (next) {
        if (next.version <= version) return
        version = next.version
        readOnly = next.readOnly
        value = o.decode(next.content)
        replaced.forEach(function (fn) { fn(value) })
      })
      window.addEventListener('message', function (event) {
        var m = event.data
        if (event.source !== window.parent || !m || m.orca !== 1) return
        if (m.event === 'test.flush' && timer !== null) send()
        // A disk write under unsaved edits, as Orca hands it to a session with merge.
        if (m.event === 'test.merge') {
          clearTimeout(timer)
          timer = null
          version = m.payload.version
          value = o.merge(base, o.decode(m.payload.content), value)
          base = o.decode(m.payload.content)
          replaced.forEach(function (fn) { fn(value) })
        }
      })
      return {
        get value() { return value },
        get readOnly() { return readOnly },
        change: function (next) {
          if (readOnly) return
          value = next
          clearTimeout(timer)
          timer = setTimeout(send, 50)
        },
        flush: function () { return timer === null ? Promise.resolve() : send() },
        onReplace: function (fn) { replaced.push(fn); return { dispose: function () {} } },
        dispose: function () {}
      }
    })
  }
  window.orca = Object.freeze({
    on: function () { return { dispose: function () {} } },
    document: Object.freeze({
      get: function () { return latest ? Promise.resolve(latest) : new Promise(function (resolve) { waiting.push(resolve) }) },
      onDidChange: function (fn) { listeners.push(fn); if (latest) fn(latest); return { dispose: function () {} } },
      applyEdit: applyEdit,
      session: session
    })
  })
  window.addEventListener('message', function (event) {
    var m = event.data
    if (event.source !== window.parent || !m || m.orca !== 1 || m.kind !== 'evt') return
    if (m.event === 'ping') post({ kind: 'evt', event: 'pong', payload: m.payload })
    if (m.event === 'editor.document' && m.payload && Number.isSafeInteger(m.payload.version) && m.payload.content) emit(m.payload)
  })
  post({ kind: 'evt', event: 'ready', payload: { protocol: 1 } })
})()`

export function frameDocument(theme = 'light', html = EDITOR_HTML) {
  const tokens = Object.entries(TOKENS[theme]).map(([name, value]) => `--orca-${name}:${value};`).join('')
  return (
    `<!doctype html>\n<html class="${theme}">\n<head>\n<meta charset="utf-8">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n` +
    `<style id="orca-design-tokens">:root{${tokens}}</style>\n` +
    `<script>${ORCA_SHIM}</script>\n</head>\n${html}`
  )
}

const HOST_PAGE = `<!doctype html><html><head><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe id="editor" sandbox="allow-scripts"></iframe><script>
window.__messages = []
window.__edits = []
window.__readyCount = 0
window.addEventListener('message', (event) => {
  if (event.source !== document.getElementById('editor').contentWindow) return
  if (event.data && event.data.event === 'test.edit') {
    const bytes = new Uint8Array(event.data.payload.content.bytes)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    window.__edits.push(btoa(binary))
    return
  }
  window.__messages.push(event.data)
  if (event.data && event.data.event === 'ready') window.__readyCount++
})
window.__post = (payload) => document.getElementById('editor').contentWindow.postMessage(
  { orca: 1, kind: 'evt', event: 'editor.document', payload },
  '*'
)
window.__version = 0
window.__merge = (base64, version = ++window.__version) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  document.getElementById('editor').contentWindow.postMessage({ orca: 1, kind: 'evt', event: 'test.merge', payload: { version, content: { kind: 'bytes', bytes: bytes.buffer } } }, '*', [bytes.buffer])
}
window.__flush = () => document.getElementById('editor').contentWindow.postMessage({ orca: 1, kind: 'evt', event: 'test.flush' }, '*')
window.__postBytes = (base64, fileType, version = ++window.__version, readOnly = false) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const sentAt = Date.now()
  document.getElementById('editor').contentWindow.postMessage(
    { orca: 1, kind: 'evt', event: 'editor.document', payload: { version, readOnly, fileType, content: { kind: 'bytes', bytes: bytes.buffer } } },
    '*',
    [bytes.buffer]
  )
  return sentAt
}
</script></body></html>`

export async function launch() {
  return chromium.launch({ headless: true })
}

/**
 * Opens a fresh host page with the editor frame and waits for `ready`.
 * @returns {Promise<{ page: import('playwright-core').Page, frame: import('playwright-core').Frame }>}
 */
export async function openEditor(browser, { theme = 'light', width = 1280, height = 800 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(new Error(message.text()))
  })
  await page.setContent(HOST_PAGE)
  await page.evaluate((srcdoc) => (document.getElementById('editor').srcdoc = srcdoc), frameDocument(theme))
  await page.waitForFunction(() => window.__readyCount > 0)
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
  return { page, frame, errors }
}

/** Posts the file and resolves with milliseconds from the post to the first painted grid cell. */
export async function postFile(page, frame, bytes, fileType, { waitFor = '[role="gridcell"]', readOnly = false } = {}) {
  const painted = frame.evaluate(async (selector) => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    while (!document.querySelector(selector)) await nextFrame()
    await nextFrame()
    return Date.now()
  }, waitFor)
  const sentAt = await page.evaluate(
    ([base64, type, readOnly]) => window.__postBytes(base64, type, undefined, readOnly),
    [Buffer.from(bytes).toString('base64'), fileType, readOnly]
  )
  return (await painted) - sentAt
}

/** The last file the editor sent Orca, after its pending edit is sent. */
export async function savedFile(page) {
  await page.evaluate(() => window.__flush())
  await page.waitForTimeout(150)
  const edits = await page.evaluate(() => window.__edits)
  return edits.length ? Buffer.from(edits[edits.length - 1], 'base64') : null
}
