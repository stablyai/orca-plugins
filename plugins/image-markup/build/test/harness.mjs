// A stand-in for Orca's custom editor host: the same shell (CSP, design tokens, html class, and the
// part of `window.orca` this editor uses) in an opaque-origin `sandbox="allow-scripts"` srcdoc
// frame, served from a secure origin like Orca's renderer. The host records every edit, answers it
// the way Orca does (a stale baseVersion is a conflict), and can ask the frame to flush.
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fitView, toStage } from '../src/view.js'

const HERE = import.meta.dirname
export const EDITOR_HTML = readFileSync(path.resolve(HERE, '..', '..', 'editor', 'index.html'), 'utf8')

// Same as PLUGIN_PANEL_CSP in Orca's src/shared/plugins/frames/plugin-panel-shell.ts.
const CSP =
  "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

const TOKENS = {
  light: {
    background: '#fff', foreground: '#0a0a0a', muted: '#f5f5f5', 'muted-foreground': '#737373', accent: '#f5f5f5',
    primary: '#171717', 'primary-foreground': '#fafafa', destructive: '#e40014', border: '#e5e5e5', ring: '#a1a1a1'
  },
  dark: {
    background: '#0a0a0a', foreground: '#fafafa', muted: '#262626', 'muted-foreground': '#a1a1a1', accent: '#404040',
    primary: '#e5e5e5', 'primary-foreground': '#171717', destructive: '#ff6568', border: 'rgb(255 255 255 / 0.07)', ring: '#737373'
  }
}

// The editor half of Orca's frame API; the real one is in Orca's plugin-panel-shell.ts.
const ORCA_SHIM = `(function () {
  var post = function (message) { window.parent.postMessage(Object.assign({ orca: 1 }, message), '*') }
  var listeners = new Map()
  var pending = new Map()
  var nextId = 0
  var latest = null
  function on(name, fn) {
    var set = listeners.get(name) || new Set()
    listeners.set(name, set)
    set.add(fn)
    return { dispose: function () { set.delete(fn) } }
  }
  function emit(name, payload) {
    return Array.from(listeners.get(name) || []).map(function (fn) { return Promise.resolve(fn(payload)) })
  }
  window.orca = Object.freeze({
    on: on,
    document: Object.freeze({
      onDidChange: function (fn) {
        var subscription = on('editor.document', fn)
        if (latest) Promise.resolve().then(function () { fn(latest) })
        return subscription
      },
      applyEdit: function (edit) {
        var id = nextId++
        return new Promise(function (resolve, reject) {
          pending.set(id, function (m) {
            if (m.error) { var e = new Error(m.error.message); e.code = m.error.code; reject(e) } else resolve(null)
          })
          post({ kind: 'req', id: id, method: 'editor.applyEdit', params: edit })
        })
      }
    })
  })
  window.addEventListener('message', function (event) {
    var m = event.data
    if (event.source !== window.parent || !m || m.orca !== 1) return
    if (m.kind === 'res') { var settle = pending.get(m.id); if (settle) { pending.delete(m.id); settle(m) } }
    else if (m.kind === 'evt' && m.event === 'editor.document') { latest = m.payload; emit('editor.document', m.payload) }
    else if (m.kind === 'evt') emit(m.event, m.payload)
    else if (m.kind === 'req') Promise.all(emit(m.method, m.params)).then(function () { post({ kind: 'res', id: m.id, result: null }) })
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
const frame = () => document.getElementById('editor').contentWindow
window.__readyCount = 0
window.__edits = []
window.__version = 0
window.__refuse = null
let nextFlush = 1000
const flushes = new Map()
window.addEventListener('message', (event) => {
  if (event.source !== frame()) return
  const m = event.data
  if (m && m.event === 'ready') window.__readyCount++
  if (m && m.kind === 'req' && m.method === 'editor.applyEdit') {
    const { baseVersion, content } = m.params
    let error = window.__refuse
    if (!error && baseVersion !== window.__version) error = { code: 'conflict', message: 'the document changed' }
    if (!error) window.__edits.push({ baseVersion, bytes: new Uint8Array(content.bytes) })
    frame().postMessage(error ? { orca: 1, kind: 'res', id: m.id, error } : { orca: 1, kind: 'res', id: m.id, result: null }, '*')
  }
  if (m && m.kind === 'res' && flushes.has(m.id)) { flushes.get(m.id)(); flushes.delete(m.id) }
})
window.__fromBase64 = (base64) => Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
window.__toBase64 = (bytes) => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
window.__postBytes = (bytes, { fileType = 'png', readOnly = false, version = ++window.__version } = {}) => {
  const copy = bytes.slice().buffer
  frame().postMessage(
    { orca: 1, kind: 'evt', event: 'editor.document', payload: { version, readOnly, fileType, content: { kind: 'bytes', bytes: copy } } },
    '*',
    [copy]
  )
}
window.__flush = () => new Promise((resolve) => {
  const id = nextFlush++
  flushes.set(id, resolve)
  frame().postMessage({ orca: 1, kind: 'req', id, method: 'editor.flush', params: {} }, '*')
})
window.__theme = (colorScheme) => {
  frame().postMessage({ orca: 1, kind: 'evt', event: 'theme', payload: { colorScheme } }, '*')
}
</script></body></html>`

const ORIGIN = 'https://orca.test'
export const toBase64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
export const fromBase64 = (base64) => new Uint8Array(Buffer.from(base64, 'base64'))
/** Posts a document to the editor without waiting for it to show. */
export const postBytes = (page, bytes, options = {}) =>
  page.evaluate(([data, opts]) => window.__postBytes(window.__fromBase64(data), opts), [toBase64(bytes), options])

export async function launch() {
  return chromium.launch({ headless: true })
}

/**
 * Opens a fresh host page with the editor frame and waits for `ready`.
 * @returns {Promise<{ page: import('playwright-core').Page, frame: import('playwright-core').Frame, errors: Error[] }>}
 */
export async function openEditor(browser, { theme = 'light', width = 1200, height = 800, deviceScaleFactor = 2, allowClipboard = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
    permissions: ['clipboard-read', 'clipboard-write']
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(new Error(message.text()))
  })
  await page.route(`${ORIGIN}/`, (route) => route.fulfill({ contentType: 'text/html', body: HOST_PAGE }))
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(
    ([srcdoc, allow]) => {
      const frame = document.getElementById('editor')
      // Orca's editor iframe has no allow attribute today; this checks Copy once it grants one.
      if (allow) frame.allow = 'clipboard-write'
      frame.srcdoc = srcdoc
    },
    [frameDocument(theme), allowClipboard]
  )
  await page.waitForFunction(() => window.__readyCount > 0)
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
  const close = () => context.close()
  return { page, frame, errors, close }
}

/** Posts a file and waits until the editor shows it. */
export async function postImage(page, frame, bytes, options = {}) {
  await page.evaluate(([data, opts]) => window.__postBytes(window.__fromBase64(data), opts), [toBase64(bytes), options])
  await frame.waitForFunction(() => document.getElementById('info').textContent !== '' && document.getElementById('message').hidden)
}

/** Makes a test image in the browser: a gradient with a few solid blocks, so pixels are checkable. */
export async function makeImage(page, { width = 640, height = 400, type = 'image/png', quality } = {}) {
  const data = await page.evaluate(
    async ([w, h, t, q]) => {
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d')
      const gradient = ctx.createLinearGradient(0, 0, w, h)
      gradient.addColorStop(0, '#203040')
      gradient.addColorStop(1, '#4080c0')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#00ff00'
      ctx.fillRect(20, 20, 40, 40)
      const blob = await canvas.convertToBlob(q === undefined ? { type: t } : { type: t, quality: q })
      return window.__toBase64(new Uint8Array(await blob.arrayBuffer()))
    },
    [width, height, type, quality]
  )
  return fromBase64(data)
}

/** The edits Orca has received, as Uint8Arrays. */
export async function edits(page) {
  return (await page.evaluate(() => window.__edits.map((edit) => window.__toBase64(edit.bytes)))).map(fromBase64)
}

/** RGBA of image pixel (x, y) after decoding `bytes` in the browser. */
export async function pixel(page, bytes, x, y) {
  return page.evaluate(
    async ([data, px, py]) => {
      const bitmap = await createImageBitmap(new Blob([window.__fromBase64(data)]))
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      return [...ctx.getImageData(px, py, 1, 1).data]
    },
    [toBase64(bytes), x, y]
  )
}

/** Page point over image pixel (x, y) while the image is fitted (the view until the user zooms). */
export async function pagePoint(page, frame, imageSize, x, y) {
  // Playwright reports frame element boxes in page coordinates.
  const stage = await frame.locator('#stage').boundingBox()
  const view = fitView(imageSize[0], imageSize[1], stage.width, stage.height)
  const [sx, sy] = toStage(view, x, y)
  return [stage.x + sx, stage.y + sy]
}

/** Drags the mouse through image-pixel points with the current tool. */
export async function drag(page, frame, imageSize, points, { steps = 4 } = {}) {
  const [x0, y0] = await pagePoint(page, frame, imageSize, ...points[0])
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  for (const point of points.slice(1)) {
    const [x, y] = await pagePoint(page, frame, imageSize, ...point)
    await page.mouse.move(x, y, { steps })
  }
  await page.mouse.up()
}
