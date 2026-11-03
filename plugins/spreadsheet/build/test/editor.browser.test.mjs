// Opens the built editor/index.html in headless Chromium inside an Orca-like sandboxed frame.
// Run `node build.mjs` first. Screenshots go to $SPREADSHEET_SCREENSHOTS when it is set.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import path from 'node:path'
import { DEFAULT_FIXTURE_DIR, makeFixtures } from '../scripts/make-fixtures.mjs'
import { launch, openEditor, postFile, savedFile } from './harness.mjs'
import { REL, num, row, str, workbook } from './xlsx-fixture.mjs'

const FIXTURES = DEFAULT_FIXTURE_DIR
const SCREENSHOTS = process.env.SPREADSHEET_SCREENSHOTS
const OPEN_BUDGET_MS = 2000
const fixture = (name) => readFileSync(path.join(FIXTURES, name))

let browser
before(async () => {
  if (!existsSync(path.join(FIXTURES, 'styled.ods'))) makeFixtures(FIXTURES)
  if (SCREENSHOTS) mkdirSync(SCREENSHOTS, { recursive: true })
  browser = await launch()
})
after(() => browser?.close())

async function screenshot(page, name) {
  if (SCREENSHOTS) await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) })
}

const text = (frame, selector) => frame.locator(selector).first().innerText()
const address = (frame) => text(frame, '#address')

describe('multi-sheet workbook', () => {
  let page
  let frame
  let errors
  let openMs

  before(async () => {
    ;({ page, frame, errors } = await openEditor(browser))
    // Read-only, as Orca opens an agent's transcript: the grid is the used range and nothing is sent.
    openMs = await postFile(page, frame, fixture('multi-sheet.xlsx'), 'xlsx', { readOnly: true })
    console.log(`# multi-sheet.xlsx (50,000-row sheet) open to first paint: ${openMs} ms`)
  })
  after(() => page?.close())

  test(`opens within ${OPEN_BUDGET_MS} ms`, () => {
    assert.ok(openMs < OPEN_BUDGET_MS, `took ${openMs} ms`)
  })

  test('shows a tab per visible sheet and notes the hidden one', async () => {
    const tabs = await frame.locator('[role="tab"]').allInnerTexts()
    assert.deepEqual(tabs, ['Summary', 'Data', 'Empty'])
    assert.equal(await frame.locator('[role="tab"][aria-selected="true"]').innerText(), 'Summary')
    assert.equal(await text(frame, '#hidden-note'), '1 hidden sheet not shown')
  })

  test('grid semantics count every row and column, headers included', async () => {
    const grid = frame.locator('[role="grid"]')
    assert.equal(await grid.getAttribute('aria-rowcount'), '16')
    assert.equal(await grid.getAttribute('aria-colcount'), '7')
    assert.equal(await grid.getAttribute('aria-label'), 'Summary')
    assert.ok((await frame.locator('[role="columnheader"]').count()) >= 7)
    assert.ok((await frame.locator('[role="rowheader"]').count()) >= 15)
  })

  test('renders formatted values, formulas in the detail bar, errors and merges', async () => {
    await screenshot(page, 'summary-light')
    const cells = await frame.locator('[role="row"][aria-rowindex="4"] [role="gridcell"]').allInnerTexts()
    assert.deepEqual(cells.slice(0, 6), ['North', '$125,000.50', '$80,000.00', '$45,000.50', '28.2%', '2025-01-01'])
    const merged = frame.locator('[role="row"][aria-rowindex="2"] [role="gridcell"]').first()
    assert.equal(await merged.innerText(), 'Quarterly Summary')
    const mergedWidth = (await merged.boundingBox()).width
    const columnWidth = (await frame.locator('[role="columnheader"][aria-colindex="2"]').boundingBox()).width
    assert.ok(mergedWidth > columnWidth * 4, 'A1:F1 spans six columns')
    assert.equal(await frame.locator('[role="row"][aria-rowindex="2"] [role="gridcell"]').count(), 1)

    const notes = frame.locator('[role="row"][aria-rowindex="14"] [role="gridcell"][aria-colindex="2"]')
    assert.equal(await notes.innerText(), 'Notes')
    const rowHeight = (await frame.locator('[role="row"][aria-rowindex="14"] [role="rowheader"]').boundingBox()).height
    assert.ok((await notes.boundingBox()).height > rowHeight * 2.5, 'A13:A15 spans three rows')

    const error = frame.locator('[role="row"][aria-rowindex="11"] [role="gridcell"][aria-colindex="3"]')
    assert.equal(await error.innerText(), '#DIV/0!')
    assert.match(await error.getAttribute('class'), /\berror\b/)

    await frame.locator('[role="row"][aria-rowindex="8"] [role="gridcell"][aria-colindex="3"]').click()
    assert.equal(await address(frame), 'B7')
    assert.equal(await frame.locator('#formula').inputValue(), '=SUM(B3:B6)')
    assert.equal(await text(frame, '#result'), '= $443,631.50 · Stored value 443631.5')
    await screenshot(page, 'summary-formula')

    await frame.locator('[role="row"][aria-rowindex="9"] [role="gridcell"][aria-colindex="3"]').click()
    assert.equal(await frame.locator('#formula').inputValue(), '=COUNTA(Data!A:A)-1')
  })

  test('keyboard moves, extends and selects', async () => {
    await frame.locator('[role="row"][aria-rowindex="4"] [role="gridcell"][aria-colindex="2"]').click()
    assert.equal(await address(frame), 'A3')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    assert.equal(await address(frame), 'B4')
    await page.keyboard.press('Tab')
    assert.equal(await address(frame), 'C4')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Enter')
    assert.equal(await address(frame), 'B5')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowRight')
    assert.match(await text(frame, '#status-stats'), /^B5:C6 · Count 4 · Sum 371,681 · Average 92,920\.25$/)
    assert.equal(await frame.locator('[role="gridcell"][aria-selected="true"]').count(), 4)
    const active = await frame.locator('[role="grid"]').getAttribute('aria-activedescendant')
    assert.equal(await frame.locator(`#${active}`).innerText(), '$143,900.00')
    await page.keyboard.press('ControlOrMeta+Shift+ArrowDown')
    assert.equal(await address(frame), 'B5', 'the active cell stays put while the range grows')
    assert.match(await text(frame, '#status-stats'), /^B5:C7 · Count 6 · /)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ControlOrMeta+ArrowUp')
    assert.equal(await address(frame), 'B2')
    await page.keyboard.press('ControlOrMeta+End')
    assert.equal(await address(frame), 'F15')
    await page.keyboard.press('ControlOrMeta+Home')
    assert.equal(await address(frame), 'A1')
    await page.keyboard.press('ArrowDown')
    assert.equal(await address(frame), 'A2', 'leaving a merge moves below it')
    await page.keyboard.press('ControlOrMeta+a')
    assert.match(await text(frame, '#status-stats'), /^A1:F15 · /)
  })

  test('copy puts the selection on the clipboard as TSV and HTML', async () => {
    await frame.locator('[role="row"][aria-rowindex="3"] [role="gridcell"][aria-colindex="2"]').click()
    await frame.locator('[role="row"][aria-rowindex="5"] [role="gridcell"][aria-colindex="4"]').click({ modifiers: ['Shift'] })
    const copied = await frame.evaluate(() => {
      const data = new DataTransfer()
      document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
      return { text: data.getData('text/plain'), html: data.getData('text/html') }
    })
    assert.equal(copied.text, 'Region\tRevenue\tCost\nNorth\t$125,000.50\t$80,000.00\nSouth\t$98,250.25\t$61,500.50')
    assert.match(copied.html, /^<table><tr><td>Region<\/td>/)
    assert.equal(await text(frame, '#status-note'), 'Copied 9 cells')
  })

  test('drag selects a range', async () => {
    const from = await frame.locator('[role="row"][aria-rowindex="4"] [role="gridcell"][aria-colindex="3"]').boundingBox()
    const to = await frame.locator('[role="row"][aria-rowindex="7"] [role="gridcell"][aria-colindex="4"]').boundingBox()
    await page.mouse.move(from.x + 5, from.y + 5)
    await page.mouse.down()
    await page.mouse.move(to.x + 5, to.y + 5, { steps: 5 })
    await page.mouse.up()
    assert.match(await text(frame, '#status-stats'), /^B3:C6 · Count 8 · /)
  })

  test('the 50,000-row sheet switches in, scrolls to its last row and keeps state', async () => {
    const started = Date.now()
    await frame.locator('[role="tab"]', { hasText: 'Data' }).click()
    await frame.locator('[role="grid"][aria-label="Data"]').waitFor()
    console.log(`# switch to Data sheet: ${Date.now() - started} ms`)
    assert.equal(await text(frame, '#status-dims'), '50,001 rows × 12 columns')
    assert.equal(await frame.locator('[role="grid"]').getAttribute('aria-rowcount'), '50002')
    assert.ok((await frame.locator('[role="gridcell"]').count()) < 1500, 'only the visible window is rendered')
    await screenshot(page, 'data-top')

    await frame.locator('[role="row"][aria-rowindex="3"] [role="gridcell"][aria-colindex="2"]').click()
    await page.keyboard.press('ControlOrMeta+ArrowDown')
    assert.equal(await address(frame), 'A50001')
    const last = frame.locator('[role="row"][aria-rowindex="50002"]')
    assert.equal(await last.locator('[role="rowheader"]').innerText(), '50001')
    assert.equal(await last.locator('[role="gridcell"][aria-colindex="2"]').innerText(), '50000')
    assert.ok(await last.locator('[role="gridcell"][aria-colindex="2"]').isVisible())
    await screenshot(page, 'data-bottom')

    const scrollMs = await frame.evaluate(async () => {
      const scroller = document.querySelector('.scroller')
      const frames = []
      scroller.scrollTop = 0
      for (let i = 0; i < 120; i++) {
        const start = performance.now()
        scroller.scrollTop += 2000
        await new Promise((resolve) => requestAnimationFrame(resolve))
        frames.push(performance.now() - start)
      }
      frames.sort((a, b) => a - b)
      return { median: frames[60], p95: frames[114] }
    })
    console.log(`# scroll frame time: median ${scrollMs.median.toFixed(1)} ms, p95 ${scrollMs.p95.toFixed(1)} ms`)

    await page.keyboard.press('ControlOrMeta+PageUp')
    assert.equal(await frame.locator('[role="tab"][aria-selected="true"]').innerText(), 'Summary')
    await page.keyboard.press('Alt+ArrowRight')
    assert.equal(await frame.locator('[role="tab"][aria-selected="true"]').innerText(), 'Data')
    assert.equal(await address(frame), 'A50001', 'the sheet keeps its selection')
  })

  test('an empty sheet says so', async () => {
    await frame.locator('[role="tab"]', { hasText: 'Empty' }).click()
    assert.equal(await text(frame, '#sheet-message'), 'This sheet is empty')
    assert.equal(await frame.locator('#grid-host').isVisible(), false)
    await page.keyboard.press('ArrowLeft')
    assert.equal(await frame.locator('[role="tab"][aria-selected="true"]').innerText(), 'Data', 'arrow keys move between tabs')
  })

  test('a changed file re-renders in place, keeping the sheet and selection', async () => {
    await frame.locator('[role="tab"]', { hasText: 'Data' }).click()
    await frame.locator('[role="grid"]').focus()
    await page.keyboard.press('ControlOrMeta+Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    assert.equal(await address(frame), 'B2')
    await postFile(page, frame, fixture('small.xlsb'), 'xlsb', { readOnly: true })
    await frame.waitForFunction(() => document.getElementById('status-dims').textContent.startsWith('201 rows'))
    assert.equal(await frame.locator('[role="tab"][aria-selected="true"]').innerText(), 'Data')
    assert.equal(await address(frame), 'B2')
  })

  test('ignores messages that are not documents', async () => {
    await page.evaluate(() => {
      window.__post({ readOnly: true, content: { kind: 'bytes', bytes: new ArrayBuffer(4) } })
      window.__post({ type: 'something-else' })
      window.__post(null)
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(await frame.locator('[role="tab"][aria-selected="true"]').innerText(), 'Data')
    assert.equal(await frame.locator('#workbook').isVisible(), true)
  })

  test('ignores a document whose version is not newer', async () => {
    const stale = Buffer.from('not a workbook').toString('base64')
    await page.evaluate(([base64, version]) => window.__postBytes(base64, 'xlsx', version), [stale, 1])
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(await frame.locator('#workbook').isVisible(), true)
    assert.equal(await text(frame, '#status-dims'), '201 rows × 12 columns')
  })

  test('never posts edits and logs no errors', async () => {
    const posted = await page.evaluate(() => window.__messages.map((message) => message?.kind + ':' + message?.event))
    assert.deepEqual([...new Set(posted)], ['evt:ready'])
    assert.deepEqual(errors.map(String), [])
  })
})

describe('other formats and failures', () => {
  for (const [name, type] of [['small.ods', 'ods'], ['small.xls', 'xls'], ['small.xlsb', 'xlsb']]) {
    test(`opens ${name}`, async () => {
      const { page, frame, errors } = await openEditor(browser)
      await postFile(page, frame, fixture(name), type)
      const tabs = await frame.locator('[role="tab"]').allInnerTexts()
      assert.deepEqual(tabs.slice(0, 3), ['Summary', 'Data', 'Empty'])
      assert.equal(await frame.locator('[role="row"][aria-rowindex="2"] [role="gridcell"]').first().innerText(), 'Quarterly Summary')
      assert.deepEqual(errors.map(String), [])
      await page.close()
    })
  }

  const failures = [
    ['corrupt.xlsx', "This file couldn't be read as a spreadsheet. It may be damaged or in a format Spreadsheet doesn't support."],
    ['garbage.xlsx', "This file couldn't be read as a spreadsheet. It may be damaged or in a format Spreadsheet doesn't support."],
    ['encrypted.xlsx', "This workbook is password-protected. Spreadsheet can't open encrypted files."]
  ]
  for (const [name, message] of failures) {
    test(`explains ${name}`, async () => {
      const { page, frame, errors } = await openEditor(browser)
      await postFile(page, frame, fixture(name), 'xlsx', { waitFor: '#message:not([hidden])' })
      await frame.waitForFunction((expected) => document.getElementById('message').textContent === expected, message)
      await screenshot(page, `message-${path.basename(name, '.xlsx')}`)
      assert.deepEqual(errors.map(String), [])
      await page.close()
    })
  }
})

describe('dark theme', () => {
  test('follows the Orca dark tokens', async () => {
    const { page, frame, errors } = await openEditor(browser, { theme: 'dark' })
    await postFile(page, frame, fixture('multi-sheet.xlsx'), 'xlsx')
    const colors = await frame.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.querySelector('[role="gridcell"]')).color,
      error: getComputedStyle(document.querySelector('.cell.error')).color
    }))
    assert.equal(colors.body, 'rgb(10, 10, 10)')
    assert.equal(colors.text, 'rgb(250, 250, 250)')
    assert.equal(colors.error, 'rgb(255, 101, 104)')
    await frame.locator('[role="row"][aria-rowindex="5"] [role="gridcell"][aria-colindex="4"]').click()
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await screenshot(page, 'summary-dark')
    await frame.locator('[role="tab"]', { hasText: 'Data' }).click()
    await screenshot(page, 'data-dark')
    assert.deepEqual(errors.map(String), [])
    await page.close()
  })
})

describe('editing', () => {
  let page
  let frame
  let errors
  const gridCell = (address) => {
    const { r, c } = XLSX.utils.decode_cell(address)
    return frame.locator(`[role="row"][aria-rowindex="${r + 2}"] [role="gridcell"][aria-colindex="${c + 2}"]`)
  }
  const savedCell = async (sheet, address) => {
    const wb = XLSX.read(await savedFile(page), { dense: true, cellFormula: true, cellNF: true })
    const { r, c } = XLSX.utils.decode_cell(address)
    return wb.Sheets[sheet]['!data'][r]?.[c]
  }

  before(async () => {
    ;({ page, frame, errors } = await openEditor(browser))
    await postFile(page, frame, fixture('styled.xlsx'), 'xlsx')
  })
  after(() => page?.close())

  test('typing replaces a cell, keeps its format and recalculates', async () => {
    assert.equal(await frame.locator('#notice').isVisible(), false)
    assert.equal(await frame.locator('[role="grid"]').getAttribute('aria-readonly'), 'false')
    await gridCell('B3').click()
    await page.keyboard.type('500')
    assert.equal(await frame.locator('#cell-editor').isVisible(), true)
    assert.equal(await frame.locator('#formula').inputValue(), '500')
    await page.keyboard.press('Enter')
    assert.equal(await address(frame), 'B4')
    assert.equal(await gridCell('B3').innerText(), '$500.00')
    assert.equal(await gridCell('C3').innerText(), '$1,000.00')
    assert.equal(await gridCell('B6').innerText(), '$1,800.00')
    const saved = await savedCell('Budget', 'B3')
    assert.equal(saved.v, 500)
    assert.equal(saved.w, '$500.00')
  })

  test('formulas from the cell or the formula bar, and a refused one', async () => {
    await gridCell('B5').click()
    await page.keyboard.type('=B2/10')
    await page.keyboard.press('Tab')
    assert.equal(await address(frame), 'C5')
    assert.equal(await gridCell('B5').innerText(), '$120.00')
    await gridCell('A5').click()
    await frame.locator('#formula').fill('Internet')
    await frame.locator('#formula').press('Enter')
    assert.equal(await gridCell('A5').innerText(), 'Internet')
    await gridCell('A7').click()
    await page.keyboard.type('=SUM(B2:B5')
    await page.keyboard.press('Enter')
    assert.match(await text(frame, '#status-note'), /formula isn't valid/)
    assert.equal(await frame.locator('#cell-editor').isVisible(), true, 'the edit stays open to fix')
    await page.keyboard.press('Escape')
    assert.equal(await gridCell('A7').innerText(), '')
    await screenshot(page, 'editing-light')
    assert.equal((await savedCell('Budget', 'B5')).f, 'B2/10')
  })

  test('undo and redo walk the edits back and forth', async () => {
    await gridCell('D2').click()
    await page.keyboard.press('ControlOrMeta+z')
    assert.equal(await gridCell('A5').innerText(), '')
    await page.keyboard.press('ControlOrMeta+z')
    assert.equal(await gridCell('B5').innerText(), '')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    assert.equal(await gridCell('B5').innerText(), '$120.00')
    assert.equal((await savedCell('Budget', 'A5')), undefined)
  })

  test('the menu inserts and deletes rows, and Delete clears', async () => {
    await gridCell('A3').click()
    await page.keyboard.press('Shift+F10')
    assert.equal(await frame.locator('#menu').isVisible(), true)
    await screenshot(page, 'editing-menu')
    await frame.locator('[role="menuitem"]', { hasText: 'Insert row above' }).click()
    assert.equal(await gridCell('A3').innerText(), '')
    assert.equal(await gridCell('A4').innerText(), 'Power')
    assert.equal(await gridCell('B7').innerText(), '$1,920.00')
    assert.equal((await savedCell('Budget', 'B7')).f, 'SUM(B2:B6)')
    await gridCell('A4').click()
    await page.keyboard.press('Delete')
    assert.equal(await gridCell('A4').innerText(), '')
    await page.keyboard.press('ControlOrMeta+z')
    await page.keyboard.press('ControlOrMeta+z')
    assert.equal(await gridCell('A3').innerText(), 'Power')
  })

  test('pastes tab-separated text from the clipboard', async () => {
    await gridCell('F2').click()
    await frame.evaluate(() => {
      const data = new DataTransfer()
      data.setData('text/plain', 'Q1\tQ2\n10\t=F3*2\n')
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    assert.equal(await gridCell('G3').innerText(), '20')
    assert.match(await text(frame, '#status-stats'), /^F2:G3 · Count 4/)
  })

  test('a sheet with a picture refuses row changes and says why', async () => {
    await frame.locator('[role="tab"]', { hasText: 'Picture' }).click()
    await gridCell('A1').click()
    await page.keyboard.press('Shift+F10')
    await frame.locator('[role="menuitem"]', { hasText: 'Delete row' }).click()
    assert.match(await text(frame, '#status-note'), /^Can't delete rows on this sheet: it has charts, pictures or shapes/)
    assert.equal(await gridCell('A1').innerText(), 'See the picture')
    assert.deepEqual(errors.map(String), [])
  })
})

describe('read-only files', () => {
  test('a binary .xls opens read-only with a notice', async () => {
    const { page, frame, errors } = await openEditor(browser)
    await postFile(page, frame, fixture('small.xls'), 'xls')
    assert.match(await text(frame, '#notice'), /^Read-only\. Excel 97-2003 \(\.xls\) files can't be saved/)
    assert.equal(await frame.locator('[role="grid"]').getAttribute('aria-readonly'), 'true')
    await frame.locator('[role="row"][aria-rowindex="4"] [role="gridcell"][aria-colindex="2"]').click()
    await page.keyboard.type('x')
    assert.equal(await frame.locator('#cell-editor').isVisible(), false)
    assert.equal(await savedFile(page), null)
    assert.deepEqual(errors.map(String), [])
    await page.close()
  })

  test('an .ods file edits in the dark theme', async () => {
    const { page, frame, errors } = await openEditor(browser, { theme: 'dark' })
    await postFile(page, frame, fixture('styled.ods'), 'ods')
    await frame.locator('[role="row"][aria-rowindex="4"] [role="gridcell"][aria-colindex="3"]').click()
    await page.keyboard.type('450')
    await page.keyboard.press('Enter')
    assert.equal(await frame.locator('[role="row"][aria-rowindex="5"] [role="gridcell"][aria-colindex="3"]').innerText(), '1650')
    await screenshot(page, 'editing-dark')
    const wb = XLSX.read(await savedFile(page), { dense: true })
    assert.equal(wb.Sheets.Budget['!data'][2][1].v, 450)
    assert.deepEqual(errors.map(String), [])
    await page.close()
  })
})

describe('outside writes', () => {
  test('edits an outside write would misplace are set aside, then reapplied on request', async () => {
    const book = (rows) => {
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1')
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    }
    const { page, frame, errors } = await openEditor(browser)
    await postFile(page, frame, book([['a', 1], ['b', 2]]), 'xlsx')
    await frame.locator('[role="row"][aria-rowindex="3"] [role="gridcell"][aria-colindex="3"]').click()
    await page.keyboard.type('20')
    await page.keyboard.press('Enter')
    await page.evaluate((base64) => window.__merge(base64), Buffer.from(book([['new', 0], ['a', 1], ['b', 2]])).toString('base64'))
    await frame.locator('#conflict').waitFor()
    assert.match(await text(frame, '#conflict-text'), /set aside rather than merged\. .*Your edit to 1 cell can go back at the same addresses\. Held edits are not saved/)
    assert.equal(await frame.locator('[role="row"][aria-rowindex="2"] [role="gridcell"][aria-colindex="2"]').innerText(), 'new')
    assert.equal(await frame.locator('[role="row"][aria-rowindex="3"] [role="gridcell"][aria-colindex="3"]').innerText(), '1')
    await screenshot(page, 'merge-set-aside')
    await frame.locator('#conflict-apply').click()
    assert.equal(await frame.locator('#conflict').isVisible(), false)
    assert.equal(await frame.locator('[role="row"][aria-rowindex="3"] [role="gridcell"][aria-colindex="3"]').innerText(), '20')
    const saved = XLSX.read(await savedFile(page), { dense: true }).Sheets.Sheet1['!data']
    assert.deepEqual(saved.map((r) => r.map((c) => c?.v)), [['new', 0], ['a', 20], ['b', 2]])
    assert.deepEqual(errors.map(String), [])
    await page.close()
  })
})

describe('reapplying held edits', () => {
  test('only cell edits go back, each checked; row changes and refused cells are listed', async () => {
    const data = (names) => names.map((name, i) => row(i + 1, str(`A${i + 1}`, name) + num(`B${i + 1}`, i))).join('')
    const plain = workbook([{ name: 'Sheet1', data: data(['Name', 'a', 'b', 'c', 'd']) }])
    // The outside version adds a row and makes A1:B5 an Excel table, so A1 is now a table header.
    const tableRel = `<Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/>`
    const withTable = workbook([{ name: 'Sheet1', data: data(['Name', 'new', 'a', 'b', 'c', 'd']), rels: tableRel }], {
      'xl/tables/table1.xml': `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" ref="A1:B6"><tableColumns count="2"><tableColumn id="1" name="Name"/><tableColumn id="2" name="B"/></tableColumns></table>`
    })
    const { page, frame, errors } = await openEditor(browser)
    await postFile(page, frame, Buffer.from(plain), 'xlsx')
    const cell = (address) => {
      const { r, c } = XLSX.utils.decode_cell(address)
      return frame.locator(`[role="row"][aria-rowindex="${r + 2}"] [role="gridcell"][aria-colindex="${c + 2}"]`)
    }
    await cell('A1').click()
    await page.keyboard.type('Who')
    await page.keyboard.press('Enter')
    await cell('B3').click()
    await page.keyboard.type('42')
    await page.keyboard.press('Enter')
    await cell('A5').click()
    await page.keyboard.press('Shift+F10')
    await frame.locator('[role="menuitem"]', { hasText: 'Delete row' }).click()
    await page.evaluate((base64) => window.__merge(base64), Buffer.from(withTable).toString('base64'))
    await frame.locator('#conflict').waitFor()
    const held = await text(frame, '#conflict-text')
    assert.match(held, /Your edits to 2 cells can go back/)
    assert.match(held, /Not reapplied, redo by hand if still wanted: delete 1 row from row 5 on Sheet1\./)
    // A later outside write keeps them held.
    await page.evaluate((base64) => window.__merge(base64), Buffer.from(withTable).toString('base64'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await text(frame, '#conflict-text'), held)
    await screenshot(page, 'held-edits')
    await frame.locator('#conflict-apply').click()
    assert.match(await text(frame, '#conflict-text'), /^Reapplied 1 cell\. Not reapplied: Sheet1!A1 \(a table header or totals cell\)\. Row and column changes to redo by hand: delete 1 row from row 5 on Sheet1\.$/)
    assert.equal(await cell('A1').innerText(), 'Name')
    assert.equal(await cell('B3').innerText(), '42')
    assert.equal(await cell('A5').innerText(), 'c', 'the row deletion was not replayed')
    const saved = XLSX.read(await savedFile(page), { dense: true }).Sheets.Sheet1['!data']
    assert.deepEqual(saved.map((r) => r.map((c) => c?.v)), [['Name', 0], ['new', 1], ['a', 42], ['b', 3], ['c', 4], ['d', 5]])
    await frame.locator('#conflict-discard').click()
    assert.equal(await frame.locator('#conflict').isVisible(), false)
    assert.deepEqual(errors.map(String), [])
    await page.close()
  })
})
