// How cell values read in the grid, the clipboard and CSV. Cells are `{ t, v }` with `t` SQLite's
// storage class: integers are BigInt, blobs Uint8Array (or only `size` in the grid).

/**
 * A real as current sqlite3 prints it: 15 significant digits when they round-trip, otherwise 17,
 * always with a decimal point, in exponent form below 1e-4 or from 1e17 up.
 */
export function formatReal(v) {
  if (v === Infinity) return 'Inf'
  if (v === -Infinity) return '-Inf'
  if (Number.isNaN(v)) return 'NaN'
  if (v === 0) return '0.0'
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  let text = abs.toExponential(14)
  if (Number(text) !== abs) text = abs.toExponential(16)
  const [mantissa, exponent] = text.split('e')
  const digits = mantissa.replace('.', '').replace(/(.)0+$/, '$1')
  const exp = Number(exponent)
  if (exp < -4 || exp >= 17) {
    return `${sign}${digits[0]}.${digits.slice(1) || '0'}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`
  const whole = digits.slice(0, exp + 1)
  return `${sign}${whole}${'0'.repeat(exp + 1 - whole.length)}.${digits.slice(exp + 1) || '0'}`
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KB`
  return `${(n / 1048576).toFixed(1).replace(/\.0$/, '')} MB`
}

export function hex(bytes) {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out.toUpperCase()
}

export function hexDump(bytes) {
  const lines = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    let hexPart = ''
    let ascii = ''
    for (let i = offset; i < offset + 16; i++) {
      if (i < bytes.length) {
        hexPart += `${bytes[i].toString(16).padStart(2, '0')} `
        ascii += bytes[i] >= 32 && bytes[i] < 127 ? String.fromCharCode(bytes[i]) : '.'
      } else {
        hexPart += '   '
      }
      if (i === offset + 7) hexPart += ' '
    }
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hexPart} ${ascii}`)
  }
  return lines.join('\n')
}

/** A whole cell as plain text: NULL is empty, a blob is hex. */
export function cellText(cell) {
  switch (cell.t) {
    case 'null':
      return ''
    case 'real':
      return formatReal(cell.v)
    case 'blob':
      return cell.v ? hex(cell.v) : ''
    default:
      return String(cell.v)
  }
}

/** One CSV field (RFC 4180): quoted when it holds a comma, quote or line break. */
export function csvField(text) {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** One tab-separated field, quoted the way spreadsheets paste it when it holds a tab, quote or line break. */
export function tsvField(text) {
  return /[\t"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Rows of cells as CSV lines, with the header first. Ends in CRLF, as RFC 4180 writes it. */
export function toCsv(names, rows) {
  const lines = [names.map(csvField).join(',')]
  for (const cells of rows) lines.push(cells.map((cell) => csvField(cellText(cell))).join(','))
  return `${lines.join('\r\n')}\r\n`
}

/** Rows of cells for the clipboard: one cell is its text alone; more are tab-separated lines. */
export function toClipboard(rows, names) {
  if (!names && rows.length === 1 && rows[0].length === 1) {
    return cellText(rows[0][0])
  }
  const lines = names ? [names.map(tsvField).join('\t')] : []
  for (const cells of rows) lines.push(cells.map((cell) => tsvField(cellText(cell))).join('\t'))
  return lines.join('\n')
}
