// Hand-written workbooks with what the writers must keep: styles, shared strings and formulas, merges,
// conditional formats, validation, a defined name, a calculation chain, a chart sheet's drawing, a
// macro project. SheetJS cannot write these, so the XML is spelled out.
import { zipSync, strToU8 } from 'fflate'

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

const contentTypes = (macro) => `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${macro ? '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' : ''}
<Override PartName="/xl/workbook.xml" ContentType="${macro ? 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'}"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>
</Types>`

const workbook = `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}">
<bookViews><workbookView/></bookViews>
<sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes and totals" sheetId="2" r:id="rId2"/><sheet name="Picture" sheetId="3" r:id="rId3"/></sheets>
<definedNames><definedName name="Spend">Budget!$B$2:$B$5</definedName></definedNames>
<calcPr calcId="191029"/>
</workbook>`

const workbookRels = (macro) => `${XML}<Relationships xmlns="${PKG_REL}">
<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="${REL}/styles" Target="styles.xml"/>
<Relationship Id="rId5" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId6" Type="${REL}/calcChain" Target="calcChain.xml"/>
${macro ? '<Relationship Id="rId7" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>' : ''}
</Relationships>`

// Style 1: bold header with a fill; style 2: currency; style 3: percent.
const styles = `${XML}<styleSheet xmlns="${MAIN}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

const strings = ['Item', 'Cost', 'Double', 'Rent', 'Power', 'Water', 'Total', 'Share']
const sharedStrings = `${XML}<sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`

const budget = `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">
<dimension ref="A1:D6"/>
<sheetViews><sheetView workbookViewId="0"><selection activeCell="B3" sqref="B3"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="3" width="12" customWidth="1"/></cols>
<sheetData>
<row r="1" spans="1:4"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" s="1" t="s"><v>2</v></c><c r="D1" s="1" t="s"><v>7</v></c></row>
<row r="2" spans="1:4"><c r="A2" t="s"><v>3</v></c><c r="B2" s="2"><v>1200</v></c><c r="C2" s="2"><f t="shared" ref="C2:C5" si="0">B2*2</f><v>2400</v></c><c r="D2" s="3"><f>B2/$B$6</f><v>0.75</v></c></row>
<row r="3" spans="1:4"><c r="A3" t="s"><v>4</v></c><c r="B3" s="2"><v>300</v></c><c r="C3" s="2"><f t="shared" si="0"/><v>600</v></c><c r="D3" s="3"><f>B3/$B$6</f><v>0.1875</v></c></row>
<row r="4" spans="1:4"><c r="A4" t="s"><v>5</v></c><c r="B4" s="2"><v>100</v></c><c r="C4" s="2"><f t="shared" si="0"/><v>200</v></c><c r="D4" s="3"><f>B4/$B$6</f><v>0.0625</v></c></row>
<row r="5" spans="1:4"><c r="B5" s="2"/><c r="C5" s="2"><f t="shared" si="0"/><v>0</v></c></row>
<row r="6" spans="1:4"><c r="A6" s="1" t="s"><v>6</v></c><c r="B6" s="2"><f>SUM(B2:B5)</f><v>1600</v></c><c r="C6" s="2"><f>SUM(C2:C5)</f><v>3200</v></c></row>
<row r="8" ht="30" customHeight="1"><c r="A8" s="1"/></row>
</sheetData>
<mergeCells count="1"><mergeCell ref="A8:D8"/></mergeCells>
<conditionalFormatting sqref="B2:B5"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>$B$6/2</formula></cfRule></conditionalFormatting>
<dataValidations count="1"><dataValidation type="decimal" operator="greaterThanOrEqual" allowBlank="1" sqref="B2:B5"><formula1>0</formula1></dataValidation></dataValidations>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`

const notes = `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">
<dimension ref="A1:B2"/>
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Budget total</t></is></c><c r="B1" s="2"><f>Budget!B6</f><v>1600</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Rent doubled</t></is></c><c r="B2" s="2"><f>SUM(Budget!C2:C2)</f><v>2400</v></c></row>
</sheetData>
</worksheet>`

const picture = `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">
<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>See the picture</t></is></c></row></sheetData>
<drawing r:id="rId1"/>
</worksheet>`

const pictureRels = `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`
const drawing = `${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>`

const calcChain = `${XML}<calcChain xmlns="${MAIN}"><c r="C2" i="1"/><c r="D2"/><c r="C3"/><c r="B6"/><c r="B1" i="2"/></calcChain>`

const rootRels = `${XML}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`

/** The styled workbook as .xlsx, or as .xlsm with a (dummy) macro project when `macro` is set. */
export function styledWorkbook({ macro = false } = {}) {
  const files = {
    '[Content_Types].xml': strToU8(contentTypes(macro)),
    '_rels/.rels': strToU8(rootRels),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels(macro)),
    'xl/styles.xml': strToU8(styles),
    'xl/sharedStrings.xml': strToU8(sharedStrings),
    'xl/worksheets/sheet1.xml': strToU8(budget),
    'xl/worksheets/sheet2.xml': strToU8(notes),
    'xl/worksheets/sheet3.xml': strToU8(picture),
    'xl/worksheets/_rels/sheet3.xml.rels': strToU8(pictureRels),
    'xl/drawings/drawing1.xml': strToU8(drawing),
    'xl/calcChain.xml': strToU8(calcChain)
  }
  if (macro) files['xl/vbaProject.bin'] = new Uint8Array(Array.from({ length: 512 }, (_, i) => (i * 31) % 256))
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') })
}

const ODS_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"'

const float = (value, text, style = '') => `<table:table-cell${style} office:value-type="float" office:value="${value}" calcext:value-type="float"><text:p>${text}</text:p></table:table-cell>`
const string = (text, style = '') => `<table:table-cell${style} office:value-type="string" calcext:value-type="string"><text:p>${text}</text:p></table:table-cell>`
const formulaCell = (formula, value, text, style = '') => `<table:table-cell${style} table:formula="${formula}" office:value-type="float" office:value="${value}" calcext:value-type="float"><text:p>${text}</text:p></table:table-cell>`
const bold = ' table:style-name="ce1"'

const odsContent = `${XML}<office:document-content ${ODS_NS} office:version="1.3">
<office:automatic-styles>
<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="1.2in"/></style:style>
<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="0.178in"/></style:style>
<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ddebf7"/><style:text-properties fo:font-weight="bold"/></style:style>
</office:automatic-styles>
<office:body><office:spreadsheet>
<table:calculation-settings table:automatic-find-labels="false"/>
<table:table table:name="Budget" table:style-name="ta1">
<table:table-column table:style-name="co1" table:number-columns-repeated="3" table:default-cell-style-name="Default"/>
<table:table-column table:style-name="co1" table:number-columns-repeated="1021" table:default-cell-style-name="Default"/>
<table:table-row table:style-name="ro1">${string('Item', bold)}${string('Cost', bold)}${string('Double', bold)}<table:table-cell table:number-columns-repeated="1021"/></table:table-row>
<table:table-row table:style-name="ro1">${string('Rent')}${float(1200, '1200')}${formulaCell('of:=[.B2]*2', 2400, '2400')}<table:table-cell table:number-columns-repeated="1021"/></table:table-row>
<table:table-row table:style-name="ro1">${string('Power')}${float(300, '300')}${formulaCell('of:=[.B3]*2', 600, '600')}<table:table-cell table:number-columns-repeated="1021"/></table:table-row>
<table:table-row table:style-name="ro1">${string('Total', bold)}${formulaCell('of:=SUM([.B2:.B3])', 1500, '1500')}${formulaCell('of:=SUM([.C2:.C3])', 3000, '3000')}<table:table-cell table:number-columns-repeated="1021"/></table:table-row>
<table:table-row table:style-name="ro1" table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
<table:table-row table:style-name="ro1"><table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="1" office:value-type="string" calcext:value-type="string"><text:p>Merged note</text:p><office:annotation><dc:creator>Sam</dc:creator><text:p>Keep me</text:p></office:annotation></table:table-cell><table:covered-table-cell/><table:table-cell table:number-columns-repeated="1022"/></table:table-row>
<table:table-row table:style-name="ro1" table:number-rows-repeated="1048569"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
</table:table>
<table:table table:name="Summary" table:style-name="ta1">
<table:table-column table:style-name="co1" table:number-columns-repeated="1024" table:default-cell-style-name="Default"/>
<table:table-row table:style-name="ro1">${string('Budget total')}${formulaCell('of:=[$Budget.B4]', 1500, '1500')}<table:table-cell table:number-columns-repeated="1022"/></table:table-row>
<table:table-row table:style-name="ro1" table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
</table:table>
<table:named-expressions><table:named-range table:name="Spend" table:base-cell-address="$Budget.$B$2" table:cell-range-address="$Budget.$B$2:.$B$3"/></table:named-expressions>
</office:spreadsheet></office:body></office:document-content>`

const odsStyles = `${XML}<office:document-styles ${ODS_NS} office:version="1.3"><office:styles><style:style style:name="Default" style:family="table-cell"/></office:styles></office:document-styles>`
const odsManifest = `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`

/** The same budget as desktop apps write .ods: repeated rows and columns, a merge with a note. */
export function styledOds() {
  return zipSync(
    {
      mimetype: [strToU8('application/vnd.oasis.opendocument.spreadsheet'), { level: 0 }],
      'content.xml': strToU8(odsContent),
      'styles.xml': strToU8(odsStyles),
      'META-INF/manifest.xml': strToU8(odsManifest)
    },
    { level: 6, mtime: new Date('2026-01-01T00:00:00Z') }
  )
}
