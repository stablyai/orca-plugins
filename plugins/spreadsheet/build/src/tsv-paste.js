/**
 * Clipboard text as rows of fields: tab-separated, one line per row, with Excel's quoting (a field
 * in double quotes may hold tabs, newlines and doubled quotes).
 */
export function parseTsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let at = 0
  const body = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  while (at < body.length) {
    const ch = body[at]
    if (quoted) {
      if (ch === '"' && body[at + 1] === '"') {
        field += '"'
        at += 2
        continue
      }
      if (ch === '"') {
        quoted = false
        at++
        continue
      }
      field += ch
      at++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === '\t') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
    at++
  }
  row.push(field)
  rows.push(row)
  return rows
}
