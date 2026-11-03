import { strToU8, zipSync } from 'fflate'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const P = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** A small Word document; `markup` adds tracked changes and a comment, `docId` Word's document id. */
export function fixture({ title = 'Quarterly report', hostile = false, markup = false, docId = null } = {}) {
  const xml = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${P}"><Relationship Id="document" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${P}"><Relationship Id="header" Type="${R}/header" Target="header1.xml"/><Relationship Id="footer" Type="${R}/footer" Target="footer1.xml"/><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="image" Type="${R}/image" Target="media/pixel.png"/><Relationship Id="web" Type="${R}/hyperlink" Target="https://example.com/report" TargetMode="External"/><Relationship Id="bad" Type="${R}/hyperlink" Target="javascript:globalThis.docxExecuted=true" TargetMode="External"/><Relationship Id="chunk" Type="${R}/aFChunk" Target="chunk.html"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:t>${title}</w:t></w:r></w:p><w:p><w:r><w:t>Revenue increased by 18% this quarter.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Product</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$128,000</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:hyperlink r:id="web"><w:r><w:t>View report online</w:t></w:r></w:hyperlink></w:p><w:p><w:hyperlink w:anchor="details"><w:r><w:t>Jump to details</w:t></w:r></w:hyperlink></w:p>${hostile ? '<w:p><w:hyperlink r:id="bad"><w:r><w:t>Unsafe link</w:t></w:r></w:hyperlink></w:p><w:altChunk r:id="chunk"/>' : ''}<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:bookmarkStart w:id="0" w:name="details"/><w:r><w:t>Second page details</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p><w:p><w:r><w:t>Text remains selectable and copyable.</w:t></w:r></w:p><w:p><w:r><w:t>Split</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Word</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>`,
    'word/header1.xml': `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Northwind · Finance</w:t></w:r></w:p></w:hdr>`,
    'word/footer1.xml': `<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>Internal report</w:t></w:r></w:p></w:ftr>`,
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/><w:rPr><w:color w:val="${hostile ? '000000;} #message,.footer { display:none !important; } .docx {' : '000000'}"/></w:rPr></w:style></w:styles>`,
    'word/chunk.html': '<html><script>parent.docxExecuted=true</script><img src="https://example.invalid/track"><style>body{display:none}</style>ALTCHUNK SHOULD NOT RENDER</html>'
  }
  if (markup) {
    xml['word/document.xml'] = xml['word/document.xml'].replace('<w:p><w:r><w:t>Revenue increased by 18% this quarter.</w:t></w:r></w:p>',
      '<w:p><w:r><w:t xml:space="preserve">Revenue increased by </w:t></w:r><w:del w:id="1" w:author="Ana" w:date="2026-10-01T10:00:00Z"><w:r><w:delText>12%</w:delText></w:r></w:del><w:ins w:id="2" w:author="Ana" w:date="2026-10-01T10:00:00Z"><w:r><w:t>18%</w:t></w:r></w:ins><w:commentRangeStart w:id="7"/><w:r><w:t xml:space="preserve"> this quarter.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>')
    xml['word/comments.xml'] = `<w:comments xmlns:w="${W}"><w:comment w:id="7" w:author="Ben Ito" w:date="2026-10-02T09:30:00Z"><w:p><w:r><w:t>Source for the 18%?</w:t></w:r></w:p></w:comment></w:comments>`
    xml['word/_rels/document.xml.rels'] = xml['word/_rels/document.xml.rels'].replace('</Relationships>', `<Relationship Id="comments" Type="${R}/comments" Target="comments.xml"/></Relationships>`)
  }
  if (docId) {
    xml['word/settings.xml'] = `<w:settings xmlns:w="${W}" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:docId w15:val="{${docId}}"/></w:settings>`
    xml['word/_rels/document.xml.rels'] = xml['word/_rels/document.xml.rels'].replace('</Relationships>', `<Relationship Id="settings" Type="${R}/settings" Target="settings.xml"/></Relationships>`)
  }
  const image = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="228600" cy="228600"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="image"/></pic:blipFill><pic:spPr><a:xfrm><a:ext cx="228600" cy="228600"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  xml['word/document.xml'] = xml['word/document.xml'].replace('<w:sectPr>', image + '<w:sectPr>')
  const parts = Object.fromEntries(Object.entries(xml).map(([name, value]) => [name, strToU8(value)]))
  parts['word/media/pixel.png'] = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'))
  return zipSync(parts)
}
