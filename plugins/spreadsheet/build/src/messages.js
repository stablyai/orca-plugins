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

/** An outside write changed what this tab's unsaved edits depended on, so they were set aside. */
MESSAGES.mergeRefused = (cells) =>
  `This file changed outside Orca while you had unsaved edits, in a way they can't merge into safely. ` +
  `It now shows the new file; your ${cells === 1 ? 'edit to 1 cell is' : cells > 0 ? `edits to ${cells} cells are` : 'row and column changes are'} set aside.`

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
