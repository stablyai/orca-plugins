// Where an Office Open XML workbook keeps its parts: the workbook, each sheet and their relationships.
import { findElements, getAttr, utf8 } from './xml-text.js'

const posix = {
  join(base, target) {
    if (target.startsWith('/')) return target.slice(1)
    const parts = base.split('/').filter(Boolean)
    for (const piece of target.split('/')) {
      if (piece === '..') parts.pop()
      else if (piece !== '.' && piece !== '') parts.push(piece)
    }
    return parts.join('/')
  },
  dir: (path) => path.slice(0, path.lastIndexOf('/') + 1)
}

export function relsPathOf(part) {
  const dir = posix.dir(part)
  return `${dir}_rels/${part.slice(dir.length)}.rels`
}

/** A part's relationships: `{ id, type, target (resolved path or URL), external }`. */
export function readRels(files, part) {
  const entry = files.get(relsPathOf(part))
  if (!entry) return []
  return findElements(utf8.decode(entry.data), 'Relationship').map(({ startTag }) => {
    const external = getAttr(startTag, 'TargetMode') === 'External'
    const target = getAttr(startTag, 'Target') ?? ''
    return {
      id: getAttr(startTag, 'Id'),
      type: (getAttr(startTag, 'Type') ?? '').replace(/^.*\//, ''),
      target: external ? target : posix.join(posix.dir(part), target),
      external
    }
  })
}

/**
 * The workbook part and its sheets, in order: `{ name, path, kind }`, where `kind` is the
 * relationship type (`worksheet`, `chartsheet`, …). Null when this is no SpreadsheetML package.
 */
export function readBook(files) {
  const root = readRels(files, '').find((rel) => rel.type === 'officeDocument')
  const workbookPath = root?.target ?? 'xl/workbook.xml'
  const workbook = files.get(workbookPath)
  if (!workbook) return null
  const xml = utf8.decode(workbook.data)
  const rels = new Map(readRels(files, workbookPath).map((rel) => [rel.id, rel]))
  const sheets = []
  for (const { startTag } of findElements(xml, 'sheet')) {
    const id = getAttr(startTag, 'r:id') ?? attrEndingWith(startTag, ':id')
    const rel = rels.get(id)
    if (!rel) continue
    sheets.push({ name: getAttr(startTag, 'name') ?? '', path: rel.target, kind: rel.type })
  }
  return { workbookPath, sheets, rels: [...rels.values()] }
}

function attrEndingWith(tag, suffix) {
  const match = new RegExp(`\\s[\\w.-]+${suffix.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`).exec(tag)
  return match ? match[1] : null
}
