// Render options and Letter fallback adapted from stablyai/orca#35061 by Kazuki Hanai (MIT).
import { parseAsync, renderDocument } from 'docx-preview'

const OPTIONS = {
  className: 'docx', inWrapper: true, breakPages: true,
  ignoreLastRenderedPageBreak: true,
  renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
  renderAltChunks: false, renderComments: false, renderChanges: false,
  experimental: false, useBase64URL: true
}
export const COMMENT_HIGHLIGHT = 'docx-comments'

const BASE_CSS = `
:host { display: block; color: #000; color-scheme: light; }
.docx-wrapper { background: transparent !important; padding: 16px !important; width: max-content; margin: 0 auto; box-sizing: border-box; }
.docx-wrapper > section.docx { width: 8.5in; min-height: 11in; padding: 1in; margin-bottom: 16px; box-shadow: 0 0 0 1px #0002, 0 2px 6px #0002; }
.docx-wrapper > section.docx:last-child { margin-bottom: 0; }
a[role="link"] { cursor: pointer; }
a[role="link"]:focus-visible, .docx-comment-ref:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
ins { color: #1d4ed8; text-decoration: underline; }
del { color: #b91c1c; text-decoration: line-through; }
.docx-comment-ref { cursor: default; font-size: 0.8em; padding: 0 1px; }
.docx-comment-popover { color: #000; background: #fff; border: 1px solid #0002; border-radius: 4px; font: 12px/1.4 system-ui, sans-serif; white-space: normal; }
.docx-comment-ref:focus ~ .docx-comment-popover { display: block; }
::highlight(${COMMENT_HIGHLIGHT}) { background-color: #fef3c7; }
::highlight(docx-find) { background-color: #fde68a; color: #000; }
::highlight(docx-find-current) { background-color: #f97316; color: #000; }
`

export function externalUrl(href) {
  try {
    const url = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/** Nothing in the document may introduce an active browsing context or event handler. */
export function sanitizeNodes(nodes) {
  for (const node of nodes) {
    if (!(node instanceof Element)) continue
    const all = [node, ...node.querySelectorAll('*')]
    for (const element of all) {
      if (/^(script|iframe|object|embed|form|input|button|textarea|select|link|meta|base)$/i.test(element.localName)) {
        element.remove()
        continue
      }
      for (const attribute of [...element.attributes]) {
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name)
      }
      if (element.localName === 'a') {
        const href = element.getAttribute('href') ?? ''
        const target = href.startsWith('#') ? href : externalUrl(href)
        element.removeAttribute('href')
        element.removeAttribute('target')
        if (target) {
          element.dataset.docxHref = target
          element.setAttribute('role', 'link')
          element.setAttribute('tabindex', '0')
          if (!target.startsWith('#')) element.setAttribute('title', target)
        }
      }
    }
  }
  return nodes.filter((node) => !(node instanceof Element) || !/^(script|iframe|object|embed|form|input|button|textarea|select|link|meta|base)$/i.test(node.localName))
}

const MARKUP_TYPES = new Set(['inserted', 'deleted', 'commentReference', 'commentRangeStart'])

/** Whether the body has tracked changes or comments. */
export function hasMarkup(parsed) {
  if (parsed.commentsPart?.comments?.length) return true
  const pending = [...(parsed.documentPart?.body?.children ?? [])]
  while (pending.length) {
    const element = pending.pop()
    if (MARKUP_TYPES.has(element?.type)) return true
    if (Array.isArray(element?.children)) pending.push(...element.children)
  }
  return false
}

/**
 * Renders the document's nodes; `markup` shows tracked changes and comments as Word's
 * "All Markup" view does, otherwise the document reads as if every change was accepted.
 */
export async function renderNodes(bytes, { markup = false } = {}) {
  const options = { ...OPTIONS, renderComments: markup, renderChanges: markup }
  const parsed = await parseAsync(bytes, options)
  // Why: the highlight registry is the frame's; a previous render's comment ranges would linger.
  globalThis.CSS?.highlights?.delete(COMMENT_HIGHLIGHT)
  const nodes = sanitizeNodes(await renderDocument(parsed, options))
  if (markup) labelComments(nodes)
  return { nodes, hasMarkup: hasMarkup(parsed) }
}

/** Comment markers become focusable, so a keyboard shows the comment as hover does. */
function labelComments(nodes) {
  for (const node of nodes) {
    if (!(node instanceof Element)) continue
    for (const marker of node.querySelectorAll('.docx-comment-ref')) {
      const popover = marker.nextElementSibling
      const date = popover?.querySelector('.docx-comment-date')
      if (date?.textContent === 'Invalid Date') date.remove()
      const author = popover?.querySelector('.docx-comment-author')?.textContent || 'Unknown author'
      marker.setAttribute('tabindex', '0')
      marker.setAttribute('role', 'note')
      marker.setAttribute('aria-label', `Comment by ${author}`)
    }
  }
}

/**
 * The host sandbox has an opaque origin, so an accessible script-free nested iframe is not
 * possible. Keep all document CSS in a shadow root, isolated from the viewer controls.
 * Chromium ignores shadow-root @font-face; promote only parsed font-face rules, never selectors.
 */
export function mountNodes(shadow, fontHost, nodes) {
  const fontRules = []
  for (const node of nodes) {
    if (node.nodeName !== 'STYLE') continue
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(node.textContent)
    for (const rule of sheet.cssRules) {
      if (rule.type === CSSRule.FONT_FACE_RULE) fontRules.push(rule.cssText)
    }
  }
  fontHost.textContent = fontRules.join('\n')
  const base = document.createElement('style')
  base.textContent = BASE_CSS
  shadow.replaceChildren(...nodes, base)
  return shadow.querySelector('.docx-wrapper')
}
