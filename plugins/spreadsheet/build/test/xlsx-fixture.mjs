// Small .xlsx files spelled out part by part, for tests that need parts SheetJS cannot write
// (pivot tables, tables, comments, extensions).
import { strToU8, zipSync } from 'fflate'

export const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
export const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** A workbook from sheet XML bodies: `{ name, data, rels?, ext? }`, plus any extra parts. */
export function workbook(sheets, extra = {}) {
  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>${sheets.map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PKG}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    ...extra
  }
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet xmlns="${MAIN}" xmlns:r="${REL}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><sheetData>${sheet.data}</sheetData>${sheet.after ?? ''}</worksheet>`
    if (sheet.rels) files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = `<Relationships xmlns="${PKG}">${sheet.rels}</Relationships>`
  })
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))
}

export const row = (r, cells) => `<row r="${r}">${cells}</row>`
export const str = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`
export const num = (ref, value) => `<c r="${ref}"><v>${value}</v></c>`
