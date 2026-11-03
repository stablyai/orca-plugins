export const MESSAGES = {
  opening: 'Opening spreadsheet…',
  corrupt: "This file couldn't be read as a spreadsheet. It may be damaged or in a format Spreadsheet doesn't support.",
  encrypted: "This workbook is password-protected. Spreadsheet can't open encrypted files.",
  'too-large':
    'This file is too large to open. Its contents expand to more than 256 MB or 4,000 parts, which Spreadsheet refuses to unpack.',
  noSheets: 'This workbook has no sheets.',
  allHidden: 'Every sheet in this workbook is hidden.',
  emptySheet: 'This sheet is empty',
  chartSheet: 'This is a chart sheet. Spreadsheet shows cell data only.',
  otherSheet: 'This is a macro or dialog sheet. Spreadsheet shows worksheets only.',
  invalidFormula: "That formula isn't valid. Check its parentheses and quotes, or start with ' to enter it as text.",
  pasteTooLarge: 'That is too much to paste at once. Paste at most 200,000 cells.',
  tableHeader: "Can't change a table's header or totals row here: the table keeps those names itself. Rename the column in a desktop spreadsheet app.",
  staleFormula: "Spreadsheet can't calculate this formula, so it shows the result saved in the file. Desktop spreadsheet apps recalculate it when they open the file."
}

const plural = (count, one, many) => (count === 1 ? one : many.replace('#', count.toLocaleString()))

/** An outside write changed what this tab's unsaved edits depended on, so they were set aside. */
MESSAGES.mergeRefused = ({ cells, shifts }) => {
  const parts = ['This file changed outside Orca while you had unsaved edits, so they were set aside rather than merged. It shows the new file.']
  if (cells) parts.push(`${plural(cells, 'Your edit to 1 cell', 'Your edits to # cells')} can go back at the same addresses.`)
  if (shifts.length) parts.push(`Not reapplied, redo by hand if still wanted: ${shifts.join('; ')}.`)
  parts.push('Held edits are not saved: closing this tab discards them.')
  return parts.join(' ')
}

/** What reapplying held edits did not put back. */
MESSAGES.reapplied = (count, skipped, shifts) => {
  const parts = [`Reapplied ${plural(count, '1 cell', '# cells')}.`]
  if (skipped.length) parts.push(`Not reapplied: ${skipped.join(', ')}.`)
  if (shifts.length) parts.push(`Row and column changes to redo by hand: ${shifts.join('; ')}.`)
  return parts.join(' ')
}

const BINARY_FORMATS = { xls: 'Excel 97-2003 (.xls)', xlsb: 'Excel binary (.xlsb)' }

/** Why this file opens read-only: Orca opened it so ('document'), or its format ('xls', 'xlsb'). */
export function readOnlyMessage(reason) {
  if (reason === 'document') return 'Read-only. Orca opened this file read-only, so edits are off.'
  const format = BINARY_FORMATS[reason] ?? 'Files in this format'
  return `Read-only. ${format}${BINARY_FORMATS[reason] ? ' files' : ''} can't be saved without losing data. To edit, save a copy as .xlsx or .ods in a desktop spreadsheet app.`
}

/** Why rows or columns cannot be inserted or deleted here. */
export function shiftBlockedMessage(axis, deleting, blocker) {
  const what = `${deleting ? 'delete' : 'insert'} ${axis === 'row' ? 'rows' : 'columns'}`
  return `Can't ${what} on this sheet: it has ${blocker}, which would end up in the wrong place. Make this change in a desktop spreadsheet app.`
}
