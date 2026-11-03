// Small, exact edits to XML text. The writers change only the elements and attributes they mean to
// and keep every other byte of a part as the file had it, which a parse and re-serialize would not.

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Why: XML 1.0 cannot hold most control characters; Excel writes them as _xHHHH_.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (ch) => `_x${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`)
}

export function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity]
  })
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const patterns = new Map()
// Writers look up the same few names hundreds of thousands of times; compile each pattern once.
function pattern(key, build) {
  let found = patterns.get(key)
  if (!found) patterns.set(key, (found = build()))
  return found
}

/**
 * Every element named `name` (any namespace prefix), with its full text, start tag, inner text and
 * position. Elements of that name must not nest, which holds for each one the writers look for.
 */
export function findElements(xml, name, from = 0, to = xml.length) {
  const opener = pattern(`element:${name}`, () => new RegExp(`<([A-Za-z_][\\w.-]*:)?${escapeRegExp(name)}(?=[\\s/>])[^>]*?(/?)>`, 'g'))
  opener.lastIndex = from
  const found = []
  for (let match; (match = opener.exec(xml)) && match.index < to; ) {
    const prefix = match[1] ?? ''
    const start = match.index
    const startTag = match[0]
    if (match[2] === '/') {
      found.push({ start, end: start + startTag.length, startTag, inner: '', innerStart: start + startTag.length, prefix, empty: true })
      continue
    }
    const close = `</${prefix}${name}>`
    const closeAt = xml.indexOf(close, opener.lastIndex)
    if (closeAt < 0) break
    const end = closeAt + close.length
    found.push({ start, end, startTag, inner: xml.slice(opener.lastIndex, closeAt), innerStart: opener.lastIndex, prefix, empty: false })
    opener.lastIndex = end
  }
  return found
}

export function findElement(xml, name, from = 0, to = xml.length) {
  return findElements(xml, name, from, to)[0] ?? null
}

/** Rebuilds `xml` with each element `name` replaced by `replace(element)`; null removes it. */
export function replaceElements(xml, name, replace) {
  let out = ''
  let at = 0
  for (const element of findElements(xml, name)) {
    out += xml.slice(at, element.start)
    const next = replace(element)
    out += next ?? ''
    at = element.end
  }
  return out + xml.slice(at)
}

export function getAttr(tag, name) {
  const match = pattern(`get:${name}`, () => new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`)).exec(tag)
  return match ? unescapeXml(match[2] ?? match[3]) : null
}

/** The start tag with attribute `name` set (or removed, when `value` is null). */
export function setAttr(tag, name, value) {
  const attr = pattern(`set:${name}`, () => new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*("[^"]*"|'[^']*')`))
  if (value === null) return tag.replace(attr, '')
  const text = ` ${name}="${escapeXml(value)}"`
  if (attr.test(tag)) return tag.replace(attr, text)
  return tag.replace(/\s*(\/?)>$/, `${text}$1>`)
}

export const utf8 = {
  decode: (bytes) => new TextDecoder().decode(bytes),
  encode: (text) => new TextEncoder().encode(text)
}
