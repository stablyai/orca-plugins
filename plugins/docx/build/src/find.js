// Find in the rendered document: matches become CSS highlights, so the document DOM is untouched.

export const FIND_HIGHLIGHT = 'docx-find'
export const CURRENT_HIGHLIGHT = 'docx-find-current'
// Text a reader does not see in place: styles, and comment popovers until hovered.
const SKIPPED = 'style, .docx-comment-popover'
const MAX_MATCHES = 10000

// Case-insensitive, one character for one, so offsets in the folded text are offsets in the node.
function fold(text) {
  let out = ''
  for (const char of text) {
    const lower = char.toLowerCase()
    out += lower.length === char.length ? lower : char
  }
  return out
}

/** Ranges of every match of `query` in `root`, in reading order; a match may span runs of a paragraph. */
export function findRanges(root, query) {
  const needle = fold(query)
  if (!needle.trim()) return []
  const ownerDocument = root.ownerDocument ?? root
  const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  const ranges = []
  let nodes = []
  let block = null
  const search = () => {
    const starts = []
    let text = ''
    for (const node of nodes) {
      starts.push(text.length)
      text += fold(node.data)
    }
    // Maps an offset in the paragraph to its text node; an end offset stays in the earlier node.
    const locate = (offset, end) => {
      let index = nodes.length - 1
      while (index > 0 && (end ? starts[index] >= offset : starts[index] > offset)) index--
      return [nodes[index], offset - starts[index]]
    }
    for (let at = text.indexOf(needle); at !== -1 && ranges.length < MAX_MATCHES; at = text.indexOf(needle, at + needle.length)) {
      const range = ownerDocument.createRange()
      range.setStart(...locate(at, false))
      range.setEnd(...locate(at + needle.length, true))
      ranges.push(range)
    }
  }
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    const owner = parent.closest('p') ?? parent
    if (owner !== block) {
      if (nodes.length) search()
      nodes = []
      block = owner
    }
    nodes.push(node)
  }
  if (nodes.length) search()
  return ranges
}

/** Paints `ranges` with `current` emphasised; no ranges clears both highlights. */
export function paintMatches(ranges, current) {
  const highlights = globalThis.CSS?.highlights
  if (!highlights) return
  if (!ranges.length) {
    highlights.delete(FIND_HIGHLIGHT)
    highlights.delete(CURRENT_HIGHLIGHT)
    return
  }
  const all = new Highlight(...ranges)
  all.priority = 1
  const emphasised = new Highlight(...(ranges[current] ? [ranges[current]] : []))
  emphasised.priority = 2
  highlights.set(FIND_HIGHLIGHT, all)
  highlights.set(CURRENT_HIGHLIGHT, emphasised)
}
