import { ArchiveRejectedError, inspectArchive } from './archive-budget.js'
import { openDocumentSession } from './document-session.js'
import { findRanges, paintMatches } from './find.js'
import { mountNodes, renderNodes } from './render-document.js'
import { SETTINGS_PART, documentKey, readView, saveView } from './view-memory.js'

const $ = (id) => document.getElementById(id)
const ui = Object.fromEntries([
  'message', 'viewport', 'pages', 'fonts', 'out', 'fit', 'in', 'percent', 'count', 'markup', 'open-find',
  'link-bar', 'link-label', 'link', 'close-link', 'find-bar', 'find', 'find-count', 'find-prev', 'find-next', 'close-find'
].map((id) => [id, $(id)]))
const shadow = ui.pages.attachShadow({ mode: 'open' })
const isMac = navigator.userAgent.includes('Mac')
let generation = 0
let wrapper = null
let scale = 1
let fit = true
let savedScroll = { top: 0, left: 0 }
// The document on screen: its bytes, its key for saved views, and whether it has markup at all.
let shown = null
let markup = true
let matches = []
let current = -1
const clamp = (value) => Math.min(5, Math.max(0.1, value))

function controls() {
  ui.out.disabled = !wrapper || scale <= 0.1
  ui.in.disabled = !wrapper || scale >= 5
  ui.fit.disabled = !wrapper
  ui['open-find'].disabled = !wrapper
  ui.percent.textContent = `${Math.round(scale * 100)}%`
  ui.fit.setAttribute('aria-pressed', String(fit))
  ui.markup.hidden = !shown?.hasMarkup
  ui.markup.disabled = !wrapper
  ui.markup.setAttribute('aria-pressed', String(markup))
}

function layout() {
  if (!wrapper) return
  if (fit) scale = clamp(ui.viewport.clientWidth / (wrapper.getBoundingClientRect().width / scale))
  wrapper.style.zoom = String(scale)
  controls()
}

let saveTimer = 0
function rememberZoom() {
  clearTimeout(saveTimer)
  const key = shown?.key
  const zoom = { fit, scale }
  saveTimer = setTimeout(() => saveView(key, { zoom }), 250)
}

function zoom(next, anchor = { x: 0, y: 0 }) {
  if (!wrapper) return
  const previous = scale
  const x = ui.viewport.scrollLeft + anchor.x
  const y = ui.viewport.scrollTop + anchor.y
  fit = next === 'fit'
  if (!fit) scale = clamp(next)
  wrapper.style.zoom = String(scale)
  layout()
  ui.viewport.scrollLeft = x * scale / previous - anchor.x
  ui.viewport.scrollTop = y * scale / previous - anchor.y
  rememberZoom()
}

function showMessage(text, error = false) {
  ui.message.hidden = false
  ui.message.setAttribute('role', error ? 'alert' : 'status')
  ui.message.textContent = text
}

/** Renders `bytes`; `inspect` runs the archive guard first, which a markup toggle has already passed. */
async function render(value, { inspect }) {
  const token = ++generation
  if (wrapper) savedScroll = { top: ui.viewport.scrollTop, left: ui.viewport.scrollLeft }
  const scroll = savedScroll
  wrapper = null
  shadow.replaceChildren()
  ui.fonts.textContent = ''
  ui.count.textContent = ''
  ui['link-bar'].hidden = true
  paintMatches([])
  controls()
  if (value.error) {
    shown = null
    showMessage(value.error === 'too-large'
      ? 'This document exceeds the 50 MiB preview limit.'
      : 'Unable to preview this Word document. It may be damaged or use an unsupported format.', true)
    return
  }
  showMessage('Opening Word document…')
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (token !== generation) return
    if (inspect) {
      const kept = await inspectArchive(value.bytes, { keep: [SETTINGS_PART], cancelled: () => token !== generation })
      const key = await documentKey(value.bytes, kept.get(SETTINGS_PART))
      if (token !== generation) return
      // The first document sets the view; a later version of it keeps what the person has now.
      if (!shown) {
        const saved = readView(key)
        if (saved.zoom) ({ fit, scale } = { scale, ...saved.zoom })
        if (saved.markup !== undefined) markup = saved.markup
      }
      shown = { bytes: value.bytes, key, hasMarkup: false }
    }
    const rendered = await renderNodes(value.bytes, { markup })
    if (token !== generation) return
    shown.hasMarkup = rendered.hasMarkup
    wrapper = mountNodes(shadow, ui.fonts, rendered.nodes)
    if (!wrapper) throw new Error('This document has no previewable pages.')
    wrapper.style.zoom = String(scale)
    ui.message.hidden = true
    layout()
    ui.viewport.scrollTop = scroll.top
    ui.viewport.scrollLeft = scroll.left
    const count = shadow.querySelectorAll('section.docx').length
    ui.count.textContent = `${count} ${count === 1 ? 'page' : 'pages'}`
    if (!ui['find-bar'].hidden) runFind({ reveal: false })
  } catch (error) {
    if (token !== generation) return
    wrapper = null
    showMessage(error instanceof ArchiveRejectedError ? error.message : 'Unable to preview this Word document. It may be damaged or use an unsupported format.', true)
    controls()
  }
}

// --- Find -----------------------------------------------------------------------------------------

function reveal(range) {
  const box = range.getBoundingClientRect()
  const view = ui.viewport.getBoundingClientRect()
  if (box.top < view.top + 24 || box.bottom > view.bottom - 24) {
    ui.viewport.scrollTop += box.top - view.top - view.height / 3
  }
  if (box.left < view.left || box.right > view.right) {
    ui.viewport.scrollLeft += box.left - view.left - view.width / 3
  }
}

function showMatch(index, { scroll = true } = {}) {
  current = matches.length ? (index + matches.length) % matches.length : -1
  paintMatches(matches, current)
  ui['find-count'].textContent = !ui.find.value.trim() ? '' : matches.length ? `${current + 1} of ${matches.length}` : 'No results'
  ui['find-prev'].disabled = ui['find-next'].disabled = matches.length === 0
  if (scroll && current >= 0) reveal(matches[current])
}

function runFind({ reveal: move = true } = {}) {
  const previous = current
  matches = wrapper ? findRanges(shadow, ui.find.value) : []
  if (move) {
    // The first match at or after the top of the viewport, as a browser's find does.
    const top = ui.viewport.getBoundingClientRect().top
    const next = matches.findIndex((range) => range.getBoundingClientRect().bottom >= top)
    showMatch(next === -1 ? 0 : next)
  } else {
    showMatch(Math.min(Math.max(previous, 0), matches.length - 1), { scroll: false })
  }
}

function openFind() {
  if (!wrapper) return
  ui['find-bar'].hidden = false
  const selected = getSelectionText()
  if (selected) ui.find.value = selected
  ui.find.focus()
  ui.find.select()
  if (ui.find.value) runFind()
}

function getSelectionText() {
  const text = (shadow.getSelection?.() ?? document.getSelection())?.toString() ?? ''
  return text.length <= 200 && !text.includes('\n') ? text.trim() : ''
}

function closeFind() {
  ui['find-bar'].hidden = true
  matches = []
  paintMatches([])
  ui.viewport.focus()
}

let findTimer = 0
ui.find.addEventListener('input', () => {
  clearTimeout(findTimer)
  findTimer = setTimeout(runFind, 120)
})
ui.find.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    clearTimeout(findTimer)
    if (matches.length && !event.isComposing) showMatch(current + (event.shiftKey ? -1 : 1))
    else runFind()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closeFind()
  }
})
ui['find-next'].addEventListener('click', () => showMatch(current + 1))
ui['find-prev'].addEventListener('click', () => showMatch(current - 1))
ui['close-find'].addEventListener('click', closeFind)
ui['open-find'].addEventListener('click', openFind)
document.addEventListener('keydown', (event) => {
  const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  const key = event.key.toLowerCase()
  if (primary && !event.altKey && key === 'f') {
    event.preventDefault()
    openFind()
  } else if ((primary && key === 'g') || event.key === 'F3') {
    if (ui['find-bar'].hidden) return
    event.preventDefault()
    showMatch(current + (event.shiftKey ? -1 : 1))
  } else if (event.key === 'Escape' && !ui['find-bar'].hidden) {
    closeFind()
  }
})

// --- Links ----------------------------------------------------------------------------------------

const canOpenLinks = () =>
  typeof window.orca?.shell?.openExternal === 'function' && window.orca.host?.has?.('shell.openExternal') !== false

/** Shows the address to copy, where Orca cannot open it (a browser client, or no prompt possible). */
function showLink(href, label = 'Copy link address') {
  ui['link-bar'].hidden = false
  ui['link-label'].textContent = label
  ui.link.value = href
  ui.link.focus()
  ui.link.select()
}

function activateLink(event) {
  const anchor = event.target instanceof Element ? event.target.closest('a[data-docx-href]') : null
  if (!anchor) return
  event.preventDefault()
  const href = anchor.dataset.docxHref
  if (href.startsWith('#')) {
    shadow.getElementById(href.slice(1))?.scrollIntoView({ block: 'start' })
  } else if (event.type !== 'auxclick' || event.button === 1) {
    if (!canOpenLinks()) {
      showLink(href)
      return
    }
    // Why the fallback: a link Orca could not ask about would otherwise do nothing. A cancel is the
    // person's choice, so it shows nothing.
    const couldNotOpen = () => showLink(href, "Orca couldn't open this link. Copy its address")
    window.orca.shell.openExternal(href).then((result) => {
      if (result?.opened === false && result.reason !== 'cancelled') couldNotOpen()
    }, couldNotOpen)
  }
}

shadow.addEventListener('click', activateLink, true)
shadow.addEventListener('auxclick', activateLink, true)
shadow.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('a[data-docx-href]')) activateLink(event)
})

// --- Controls -------------------------------------------------------------------------------------

ui.out.addEventListener('click', () => zoom(scale / 1.2))
ui.in.addEventListener('click', () => zoom(scale * 1.2))
ui.fit.addEventListener('click', () => zoom('fit'))
ui.markup.addEventListener('click', () => {
  if (!shown) return
  markup = !markup
  saveView(shown.key, { markup })
  void render({ bytes: shown.bytes }, { inspect: false })
})
ui['close-link'].addEventListener('click', () => { ui['link-bar'].hidden = true; ui.viewport.focus() })
ui.viewport.addEventListener('wheel', (event) => {
  if (!wrapper || !event.ctrlKey) return
  event.preventDefault()
  const rect = ui.viewport.getBoundingClientRect()
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? ui.viewport.clientHeight : 1)
  zoom(scale * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top })
}, { passive: false })
new ResizeObserver(layout).observe(ui.viewport)
controls()
showMessage('Opening Word document…')

openDocumentSession().then((session) => {
  session.onReplace((value) => void render(value, { inspect: true }))
  void render(session.value, { inspect: true })
})
