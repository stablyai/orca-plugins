// A stand-in for Orca's custom editor host: the same shell (CSP, design tokens, html class, and the
// part of `window.orca` this viewer uses) in a sandboxed srcdoc frame, posting the file's bytes once
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

// The part of Orca's frame API this viewer uses; the real one is Orca's frame shell. `session()` resolves
// with the first document and reports newer ones through onReplace, as Orca's does for a viewer
// that never edits. `shell` exists only when the test offers it, as in the desktop app's isolated frame.
const orcaShim = ({ shell }) => `(function () {
  var listeners = []
  var post = function (message) { window.parent.postMessage(Object.assign({ orca: 1 }, message), '*') }
  window.__opened = []
  window.__changes = 0
  var api = {
    host: Object.freeze({ has: function (name) { return ${shell} && name === 'shell.openExternal' } }),
    document: Object.freeze({
      session: function (options) {
        return new Promise(function (resolve) {
          var version = -Infinity
          var replaced = []
          var session = {
            value: undefined, readOnly: true,
            change: function () { window.__changes++ },
            flush: function () { return Promise.resolve() },
            onReplace: function (fn) { replaced.push(fn); return { dispose: function () {} } },
            dispose: function () {}
          }
          listeners.push(function (doc) {
            if (!(doc.version > version)) return
            var first = version === -Infinity
            version = doc.version
            session.value = options.decode(doc.content)
            if (first) resolve(session)
            else replaced.forEach(function (fn) { fn(session.value) })
          })
        })
      }
    })
  }
  if (${shell}) api.shell = Object.freeze({
    openExternal: function (url) {
      window.__opened.push({ url: url, active: navigator.userActivation.isActive })
      return Promise.resolve(window.__openResult || { opened: true })
    }
  })
  window.orca = Object.freeze(api)
  window.addEventListener('message', function (event) {
    var m = event.data
    if (event.source !== window.parent || !m || m.orca !== 1 || m.kind !== 'evt') return
    if (m.event === 'editor.document') listeners.forEach(function (fn) { fn(m.payload) })
  })
  post({ kind: 'evt', event: 'ready', payload: { protocol: 1 } })
})()`

export function frameDocument(theme = 'light', { shell = false, csp = true } = {}, html = EDITOR_HTML) {
  const tokens = Object.entries(TOKENS[theme]).map(([name, value]) => `--orca-${name}:${value};`).join('')
  return (
    `<!doctype html>\n<html class="${theme}">\n<head>\n<meta charset="utf-8">\n` +
    (csp ? `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n` : '') +
    `<style id="orca-design-tokens">:root{${tokens}}</style>\n` +
    `<script>${orcaShim({ shell })}</script>\n</head>\n${html}`
  )
}

const HOST_PAGE = `<!doctype html><html><head><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe id="editor" sandbox="allow-scripts"></iframe><script>
window.__messages = []
window.__readyCount = 0
window.addEventListener('message', (event) => {
  if (event.source !== document.getElementById('editor').contentWindow) return
  window.__messages.push(event.data)
  if (event.data && event.data.event === 'ready') window.__readyCount++
})
window.__post = (payload) => document.getElementById('editor').contentWindow.postMessage(
  { orca: 1, kind: 'evt', event: 'editor.document', payload },
  '*'
)
window.__version = 0
window.__postBytes = (base64, fileType, version = ++window.__version) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const sentAt = Date.now()
  document.getElementById('editor').contentWindow.postMessage(
    { orca: 1, kind: 'evt', event: 'editor.document', payload: { version, readOnly: true, fileType, content: { kind: 'bytes', bytes: bytes.buffer } } },
    '*',
    [bytes.buffer]
  )
  return sentAt
}
</script></body></html>`

export async function launch() {
  return chromium.launch({ headless: true })
}

// The desktop app's isolated frame: its own origin with storage, served with this header.
const ISOLATED_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' data: blob:; " +
  "worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

/**
 * Opens a fresh host page with the editor frame and waits for `ready`. `isolated` serves the editor
 * from its own origin, as the desktop app does, with `orca.shell`; otherwise it is the opaque-origin
 * srcdoc frame of a browser client. Pass `context` to share storage between pages.
 * @returns {Promise<{ page: import('playwright-core').Page, frame: import('playwright-core').Frame }>}
 */
export async function openEditor(browser, { theme = 'light', width = 1280, height = 800, isolated = false, context } = {}) {
  const page = await (context ?? browser).newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(new Error(message.text()))
  })
  if (isolated) {
    await page.route('http://plugin.test/**', (route) => route.fulfill({
      contentType: 'text/html', headers: { 'content-security-policy': ISOLATED_CSP },
      body: frameDocument(theme, { shell: true, csp: false })
    }))
    await page.route('http://orca.test/**', (route) => route.fulfill({
      contentType: 'text/html', body: HOST_PAGE.replace('sandbox="allow-scripts"', 'src="http://plugin.test/editor.html"')
    }))
    await page.goto('http://orca.test/')
  } else {
    await page.setContent(HOST_PAGE)
    await page.evaluate((srcdoc) => (document.getElementById('editor').srcdoc = srcdoc), frameDocument(theme))
  }
  await page.waitForFunction(() => window.__readyCount > 0)
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
  return { page, frame, errors }
}

/** Posts the file and resolves with milliseconds from the post to the first painted grid cell. */
export async function postFile(page, frame, bytes, fileType, { waitFor = '#count:not(:empty)' } = {}) {
  const painted = frame.evaluate(async (selector) => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    while (!document.querySelector(selector)) await nextFrame()
    await nextFrame()
    return Date.now()
  }, waitFor)
  const sentAt = await page.evaluate(
    ([base64, type]) => window.__postBytes(base64, type),
    [Buffer.from(bytes).toString('base64'), fileType]
  )
  return (await painted) - sentAt
}
