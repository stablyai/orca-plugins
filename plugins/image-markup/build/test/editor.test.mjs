import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { crc32, detectFormat, readMarkup, sameBytes, withPendingMark, writeMarkup } from '../src/container.js'
import { drag, edits, imageSizeOf, isPending, launch, makeImage, openEditor, pagePoint, pixel, postBytes, postImage } from './harness.mjs'

const SIZE = [640, 400]
const RED = [255, 59, 48]
const near = (actual, expected, slack = 12) => expected.every((value, i) => Math.abs(actual[i] - value) <= slack)

let browser
before(async () => {
  browser = await launch()
})
after(async () => {
  await browser?.close()
})

async function open(options) {
  const editor = await openEditor(browser, options)
  const image = await makeImage(editor.page, { width: SIZE[0], height: SIZE[1], ...options?.image })
  await postImage(editor.page, editor.frame, image, options?.post)
  return { ...editor, image }
}

/** Polls `check` until it holds, for at most 3 s. */
async function until(check) {
  for (const start = Date.now(); !(await check()); ) {
    if (Date.now() - start > 3000) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const tool = (frame, name) => frame.getByRole('button', { name, exact: true }).click()
/** Asks the frame to flush as Orca does before a save; resolves with its error, or null. */
const flush = (page) => page.evaluate(() => window.__flush())
const info = (frame) => frame.locator('#info').textContent()
const status = (frame) => frame.locator('#status').textContent()

test('opens an image fitted, with the toolbar, size and format', async () => {
  for (const theme of ['light', 'dark']) {
    const { frame, errors, close } = await open({ theme })
    assert.equal(await info(frame), '640 × 400 · PNG')
    for (const name of ['Select', 'Pen', 'Arrow', 'Box', 'Ellipse', 'Text', 'Copy image with markup']) {
      assert.equal(await frame.getByRole('button', { name, exact: true }).count(), 1, name)
    }
    assert.equal(await frame.getByRole('button', { name: 'Pen', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await frame.locator('#base').evaluate((canvas) => canvas.width > 0), true)
    assert.deepEqual(errors, [])
    await close()
  }
})

test('draws with every tool, saves through Orca on flush, and keeps the original inside', async () => {
  const { page, frame, image, errors, close } = await open()
  await drag(page, frame, SIZE, [[100, 300], [150, 320], [200, 300]])
  await tool(frame, 'Arrow')
  await drag(page, frame, SIZE, [[300, 100], [400, 200]])
  await tool(frame, 'Box')
  await drag(page, frame, SIZE, [[450, 50], [600, 150]])
  await tool(frame, 'Ellipse')
  await drag(page, frame, SIZE, [[100, 330], [250, 390]])
  await tool(frame, 'Text')
  const [tx, ty] = await pagePoint(page, frame, SIZE, 100, 100)
  await page.mouse.click(tx, ty)
  await page.keyboard.type('Bug here')
  await page.keyboard.press('Escape')
  assert.equal(await info(frame), '640 × 400 · PNG · 5 marks')
  assert.match(await status(frame), /saves the markup into this image/)

  await flush(page)
  const sent = await edits(page)
  assert.equal(sent.length, 1)
  const saved = sent[0]
  assert.equal(detectFormat(saved), 'png')
  const markup = readMarkup(saved)
  assert.ok(sameBytes(markup.original, image), 'the original bytes ride along unchanged')
  assert.deepEqual(markup.scene.shapes.map((shape) => shape.t), ['pen', 'arrow', 'box', 'ellipse', 'text'])
  assert.equal(markup.scene.shapes[4].text, 'Bug here')
  assert.ok(near(await pixel(page, saved, 175, 330), RED), 'ellipse top')
  // The visible pixels carry the markup: the box edge is red, the untouched block stays green.
  assert.ok(near(await pixel(page, saved, 525, 50), RED), 'box edge')
  assert.deepEqual((await pixel(page, saved, 40, 40)).slice(0, 3), [0, 255, 0])
  assert.deepEqual(errors, [])
  await close()
})

test('debounces edits, and Orca handing the saved bytes back keeps the session and undo', async () => {
  const { page, frame, errors, close } = await open()
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  await drag(page, frame, SIZE, [[300, 100], [400, 200]])
  await until(async () => (await edits(page)).length === 1)
  const [saved] = await edits(page)
  // After a save Orca sends the file again under a new version.
  await postBytes(page, saved)
  await frame.waitForTimeout(50)
  assert.equal(await info(frame), '640 × 400 · PNG · 2 marks')
  await frame.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal(await info(frame), '640 × 400 · PNG · 1 mark')
  await flush(page)
  const latest = (await edits(page)).at(-1)
  assert.equal(readMarkup(latest).scene.shapes.length, 1, 'the edit names the new version, so Orca takes it')
  assert.deepEqual(errors, [])
  await close()
})

test('an edit echoed before its acknowledgement never reloads the scene or drops a newer stroke', async () => {
  const { page, frame, errors, close } = await open()
  await page.evaluate(() => (window.__echoEdits = true))
  // Hold a redundant decode open: drawing must keep working while the host echoes an edit.
  await frame.evaluate(() => {
    const decode = window.createImageBitmap
    window.__decodeCalls = 0
    window.__releaseDecode = null
    window.createImageBitmap = async (...args) => {
      window.__decodeCalls++
      await new Promise((resolve) => (window.__releaseDecode = resolve))
      return decode(...args)
    }
  })
  await drag(page, frame, SIZE, [[100, 100], [200, 150]])
  await flush(page)
  await drag(page, frame, SIZE, [[300, 100], [400, 150]])
  await frame.evaluate(() => window.__releaseDecode?.())
  // Give an unnecessary decode time to finish and expose a reset of the live scene.
  await frame.waitForTimeout(100)
  assert.equal(await info(frame), '640 × 400 · PNG · 2 marks')
  assert.equal(await frame.evaluate(() => window.__decodeCalls), 0, 'own edits do not decode again')
  assert.equal(await flush(page), null)
  assert.equal(readMarkup((await edits(page)).at(-1)).scene.shapes.length, 2)
  await tool(frame, 'Undo')
  assert.equal(await info(frame), '640 × 400 · PNG · 1 mark')
  assert.equal(await flush(page), null)
  assert.deepEqual(errors, [])
  await close()
})

test('reopening a saved file restores editable shapes; clearing them saves the original byte for byte', async () => {
  const first = await open()
  await drag(first.page, first.frame, SIZE, [[100, 100], [200, 150]])
  await flush(first.page)
  const [saved] = await edits(first.page)
  await first.close()

  const { page, frame, errors, close } = await openEditor(browser)
  await postImage(page, frame, saved)
  assert.equal(await info(frame), '640 × 400 · PNG · 1 mark')
  assert.match(await status(frame), /Opened with markup/)
  await frame.getByRole('button', { name: 'Clear all markup', exact: true }).click()
  await flush(page)
  const [restored] = await edits(page)
  assert.ok(sameBytes(restored, first.image), 'the original file, exactly')
  assert.deepEqual(errors, [])
  await close()
})

test('the highlighter draws a wide translucent stroke; Shift makes it straight', async () => {
  const { page, frame, errors, close } = await open()
  await page.keyboard.press('h')
  assert.equal(await frame.getByRole('button', { name: 'Highlighter', exact: true }).getAttribute('aria-pressed'), 'true')
  await frame.getByRole('button', { name: 'Yellow', exact: true }).click()
  const [x0, y0] = await pagePoint(page, frame, SIZE, 100, 200)
  const [x1, y1] = await pagePoint(page, frame, SIZE, 500, 230)
  await page.keyboard.down('Shift')
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x1, y1, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  assert.equal(await flush(page), null)
  const saved = (await edits(page)).at(-1)
  const [shape] = readMarkup(saved).scene.shapes
  assert.equal(shape.t, 'marker')
  assert.deepEqual(shape.p, [100, 200, 500, 230])
  assert.ok(shape.s >= 10, `wide: ${shape.s}`)
  // Translucent: the gradient still shows through the yellow.
  const [r, g, b] = await pixel(page, saved, 300, 215)
  assert.ok(r > 120 && g > 120 && b < 200 && b > 40, `blended yellow: ${[r, g, b]}`)
  assert.deepEqual(errors, [])
  await close()
})

test('step numbers count up as they are placed, and renumber when one is deleted', async () => {
  const { page, frame, errors, close } = await open()
  await page.keyboard.press('n')
  for (const x of [100, 250, 400]) {
    const [px, py] = await pagePoint(page, frame, SIZE, x, 200)
    await page.mouse.click(px, py)
  }
  assert.equal(await info(frame), '640 × 400 · PNG · 3 marks')
  await page.keyboard.press('v')
  const [sx, sy] = await pagePoint(page, frame, SIZE, 100, 200)
  await page.mouse.click(sx, sy)
  await page.keyboard.press('Backspace')
  assert.equal(await flush(page), null)
  const shapes = readMarkup((await edits(page)).at(-1)).scene.shapes
  assert.deepEqual(shapes.map((shape) => [shape.t, shape.n, shape.x]), [['step', 1, 250], ['step', 2, 400]])
  assert.deepEqual(errors, [])
  await close()
})

test('redaction covers the area, and the saved file keeps no unredacted copy of it', async () => {
  const { page, frame, image, errors, close } = await open()
  await page.keyboard.press('x')
  await drag(page, frame, SIZE, [[290, 290], [410, 370]])
  await tool(frame, 'Arrow')
  await drag(page, frame, SIZE, [[100, 100], [200, 150]])
  assert.match(await status(frame), /redacted areas are removed from the file for good/)
  assert.equal(await flush(page), null)
  const saved = (await edits(page)).at(-1)
  const markup = readMarkup(saved)
  assert.deepEqual(markup.scene.shapes.map((shape) => shape.t), ['arrow'], 'the redaction is burned in, not kept as a shape')
  assert.ok(!sameBytes(markup.original, image), 'the kept original is redacted too')
  // Fine stripes become coarse tiles in both the visible image and the kept original.
  for (const bytes of [saved, markup.original]) {
    const row = await Promise.all([300, 302, 304, 306].map((x) => pixel(page, bytes, x, 330)))
    const spread = Math.max(...row.map((p) => p[0])) - Math.min(...row.map((p) => p[0]))
    assert.ok(spread < 60, `no stripes left: ${row.map((p) => p[0])}`)
  }
  // Reopened, the arrow is still editable and the redaction stays in the pixels.
  const reopened = await openEditor(browser)
  await postImage(reopened.page, reopened.frame, saved)
  assert.equal(await info(reopened.frame), '640 × 400 · PNG · 1 mark')
  await reopened.frame.getByRole('button', { name: 'Clear all markup', exact: true }).click()
  assert.equal(await flush(reopened.page), null)
  assert.ok(sameBytes((await edits(reopened.page)).at(-1), markup.original), 'clearing keeps the redaction')
  assert.deepEqual([...errors, ...reopened.errors], [])
  await reopened.close()
  await close()
})

test('markup under a redaction is burned in with it, never kept as text in the file', async () => {
  const { page, frame, errors, close } = await open()
  await page.keyboard.press('t')
  const [tx, ty] = await pagePoint(page, frame, SIZE, 310, 320)
  await page.mouse.click(tx, ty)
  await page.keyboard.type('SECRET-alice@example.com')
  await page.keyboard.press('Escape')
  await page.keyboard.press('x')
  await drag(page, frame, SIZE, [[290, 290], [630, 370]])
  await tool(frame, 'Arrow')
  await drag(page, frame, SIZE, [[100, 100], [200, 150]])
  assert.equal(await flush(page), null)
  const saved = (await edits(page)).at(-1)
  assert.ok(!Buffer.from(saved).includes(Buffer.from('SECRET')), 'the text is nowhere in the file')
  assert.deepEqual(readMarkup(saved).scene.shapes.map((shape) => shape.t), ['arrow'], 'only what was drawn after stays editable')
  const reopened = await openEditor(browser)
  await postImage(reopened.page, reopened.frame, saved)
  assert.equal(await info(reopened.frame), '640 × 400 · PNG · 1 mark')
  assert.deepEqual([...errors, ...reopened.errors], [])
  await reopened.close()
  await close()
})

test('a redaction is a flat fill: what was under it leaves no trace', async () => {
  const redact = async (label) => {
    const editor = await openEditor(browser)
    const image = await makeImage(editor.page, { label })
    await postImage(editor.page, editor.frame, image)
    await editor.page.keyboard.press('x')
    await drag(editor.page, editor.frame, SIZE, [[100, 250], [500, 330]])
    assert.equal(await flush(editor.page), null)
    const saved = (await edits(editor.page)).at(-1)
    const region = await editor.page.evaluate(async (data) => {
      const bitmap = await createImageBitmap(new Blob([window.__fromBase64(data)]))
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      return [...ctx.getImageData(102, 252, 396, 76).data]
    }, Buffer.from(saved).toString('base64'))
    assert.deepEqual(editor.errors, [])
    await editor.close()
    return region
  }
  // Two different secrets under the same box: the saved pixels differ at most by the fill's shade.
  const a = await redact('hunter2-password')
  const b = await redact('sk_live_9QX0ZZ')
  const worst = a.reduce((max, value, i) => Math.max(max, Math.abs(value - b[i])), 0)
  assert.ok(worst <= 4, `largest difference ${worst}`)
})

test('an EXIF-rotated JPEG reopens with its markup and its original', async () => {
  const { page, frame, image, errors, close } = await open({ image: { type: 'image/jpeg', quality: 0.9, orientation: 6 }, post: { fileType: 'jpg' } })
  assert.equal(await info(frame), '400 × 640 · JPEG')
  await drag(page, frame, [400, 640], [[100, 100], [200, 300]])
  assert.equal(await flush(page), null)
  const saved = (await edits(page)).at(-1)
  assert.ok(sameBytes(readMarkup(saved).original, image))
  const reopened = await openEditor(browser)
  await postImage(reopened.page, reopened.frame, saved, { fileType: 'jpg' })
  assert.equal(await info(reopened.frame), '400 × 640 · JPEG · 1 mark')
  await reopened.frame.getByRole('button', { name: 'Clear all markup', exact: true }).click()
  assert.equal(await flush(reopened.page), null)
  assert.ok(sameBytes((await edits(reopened.page)).at(-1), image), 'the original, byte for byte')
  assert.deepEqual([...errors, ...reopened.errors], [])
  await reopened.close()
  await close()
})

test('a stroke marks the tab unsaved at once, before its encode, so closing asks first', async () => {
  const { page, frame, errors, close } = await open()
  // Hold every encode: what Orca holds right after the stroke is all a close would see.
  await frame.evaluate(() => {
    const arrayBuffer = Blob.prototype.arrayBuffer
    window.__release = null
    const held = new Promise((resolve) => (window.__release = resolve))
    Blob.prototype.arrayBuffer = async function () {
      await held
      return arrayBuffer.call(this)
    }
  })
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  await until(async () => (await edits(page, { pending: true })).length === 1)
  const [standIn] = await edits(page, { pending: true })
  assert.deepEqual(await imageSizeOf(page, standIn), SIZE, 'the stand-in is still the image')
  await frame.evaluate(() => window.__release())
  assert.equal(await flush(page), null)
  assert.equal(readMarkup((await edits(page)).at(-1)).scene.shapes.length, 1)
  assert.deepEqual(errors, [])
  await close()
})

const holdEncodes = (frame) =>
  frame.evaluate(() => {
    const arrayBuffer = Blob.prototype.arrayBuffer
    const held = new Promise((resolve) => (window.__release = resolve))
    Blob.prototype.arrayBuffer = async function () {
      await held
      return arrayBuffer.call(this)
    }
  })

for (const [format, imageOptions, post] of [
  ['PNG', {}, {}],
  ['JPEG', { type: 'image/jpeg', quality: 0.9 }, { fileType: 'jpg' }]
]) {
  test(`${format}: an undo back to the saved scene leaves Orca the real file, never the stand-in`, async () => {
    const { page, frame, errors, close } = await open({ image: imageOptions, post })
    await drag(page, frame, SIZE, [[100, 100], [200, 200]])
    assert.equal(await flush(page), null)
    const [real] = await edits(page)
    await drag(page, frame, SIZE, [[300, 100], [400, 200]])
    await until(async () => (await edits(page, { pending: true })).some(isPending))
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    assert.equal(await flush(page), null)
    const last = (await edits(page, { pending: true })).at(-1)
    assert.ok(!isPending(last) && sameBytes(last, real), 'what a save writes is the real file')
    assert.deepEqual(errors, [])
    await close()
  })

  test(`${format}: a stand-in saved before its encode (say, after a view switch) reopens with the markup`, async () => {
    const { page, frame, image, errors, close } = await open({ image: imageOptions, post })
    await holdEncodes(frame)
    await tool(frame, 'Box')
    await frame.getByRole('button', { name: 'Thick stroke', exact: true }).click()
    await drag(page, frame, SIZE, [[100, 100], [300, 300]])
    await until(async () => (await edits(page, { pending: true })).length === 1)
    // The frame goes away with the encode still running: Orca saves what it holds.
    const [standIn] = await edits(page, { pending: true })
    await close()
    const markup = readMarkup(standIn)
    assert.ok(markup, 'the markup is still readable')
    assert.ok(sameBytes(markup.original, image), 'and the original is still inside')
    assert.deepEqual(markup.scene.shapes.map((shape) => shape.t), ['box'])
    // Reopened, the shapes are there; just viewing it sends nothing, and the next edit redraws it.
    const reopened = await openEditor(browser)
    await postImage(reopened.page, reopened.frame, standIn, post)
    assert.equal(await info(reopened.frame), `640 × 400 · ${format} · 1 mark`)
    await reopened.page.waitForTimeout(600)
    assert.equal((await edits(reopened.page, { pending: true })).length, 0, 'opening it does not dirty the tab')
    await drag(reopened.page, reopened.frame, SIZE, [[500, 50], [600, 80]])
    assert.equal(await flush(reopened.page), null)
    const redrawn = (await edits(reopened.page)).at(-1)
    assert.ok(near(await pixel(reopened.page, redrawn, 100, 200), RED, 40), 'the box is in the pixels now')
    assert.ok(sameBytes(readMarkup(redrawn).original, image))
    assert.deepEqual([...errors, ...reopened.errors], [])
    await reopened.close()
  })
}

test('a redaction saved as a stand-in before its encode is applied again on reopen', async () => {
  const { page, frame, image, errors, close } = await open()
  await page.keyboard.press('t')
  const [tx, ty] = await pagePoint(page, frame, SIZE, 310, 320)
  await page.mouse.click(tx, ty)
  await page.keyboard.type('SECRET-alice')
  await page.keyboard.press('Escape')
  assert.equal(await flush(page), null)
  await holdEncodes(frame)
  await page.keyboard.press('x')
  await drag(page, frame, SIZE, [[290, 290], [630, 370]])
  const before = (await edits(page, { pending: true })).length
  await until(async () => (await edits(page, { pending: true })).length > before)
  const standIn = (await edits(page, { pending: true })).at(-1)
  assert.ok(isPending(standIn))
  await close()
  // It holds the redaction, and nothing the last file didn't: not the text under the redaction.
  assert.deepEqual(readMarkup(standIn).scene.shapes.map((shape) => shape.t), ['redact'])
  assert.ok(sameBytes(readMarkup(standIn).original, image))
  const reopened = await openEditor(browser)
  await postImage(reopened.page, reopened.frame, standIn)
  assert.match(await status(reopened.frame), /redacted areas are removed/)
  await until(async () => (await edits(reopened.page)).length === 1)
  const redrawn = (await edits(reopened.page))[0]
  const row = await Promise.all([300, 302, 304, 306].map((x) => pixel(reopened.page, redrawn, x, 330)))
  assert.ok(Math.max(...row.map((p) => p[0])) - Math.min(...row.map((p) => p[0])) < 60, 'the stripes are covered')
  assert.ok(!Buffer.from(redrawn).includes(Buffer.from('SECRET')))
  assert.deepEqual([...errors, ...reopened.errors], [])
  await reopened.close()
})

test('a redaction stand-in keeps saved markup outside the redaction', async () => {
  const { page, frame, errors, close } = await open()
  await tool(frame, 'Box')
  await drag(page, frame, SIZE, [[50, 50], [150, 150]])
  assert.equal(await flush(page), null)
  await holdEncodes(frame)
  const before = (await edits(page, { pending: true })).length
  await page.keyboard.press('x')
  await drag(page, frame, SIZE, [[290, 290], [630, 370]])
  await until(async () => (await edits(page, { pending: true })).length > before)
  const standIn = (await edits(page, { pending: true })).at(-1)
  await close()
  assert.deepEqual(readMarkup(standIn).scene.shapes.map((shape) => shape.t), ['box', 'redact'])
  const reopened = await openEditor(browser)
  await postImage(reopened.page, reopened.frame, standIn)
  assert.equal(await info(reopened.frame), '640 × 400 · PNG · 2 marks')
  assert.deepEqual(reopened.errors, [])
  assert.deepEqual(errors, [])
  await reopened.close()
})

test('a stand-in note that reached disk is not kept by later saves', async () => {
  const plain = await (async () => {
    const editor = await openEditor(browser)
    const bytes = await makeImage(editor.page)
    await editor.close()
    return bytes
  })()
  const { page, frame, errors, close } = await openEditor(browser)
  await postImage(page, frame, withPendingMark('png', plain))
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  assert.equal(await flush(page), null)
  assert.ok(sameBytes(readMarkup((await edits(page)).at(-1)).original, plain), 'the original inside has no note')
  await frame.getByRole('button', { name: 'Clear all markup', exact: true }).click()
  assert.equal(await flush(page), null)
  assert.ok(sameBytes((await edits(page)).at(-1), plain), 'Clear all saves the image without the note')
  assert.deepEqual(errors, [])
  await close()
})

test('markup merged onto a new image during an encode is still sent', async () => {
  const { page, frame, errors, close } = await open()
  const screenshot = await makeImage(page, { width: 320, height: 200 })
  await frame.evaluate(() => {
    const arrayBuffer = Blob.prototype.arrayBuffer
    window.__release = null
    const held = new Promise((resolve) => (window.__release = resolve))
    Blob.prototype.arrayBuffer = async function () {
      await held
      return arrayBuffer.call(this)
    }
  })
  await tool(frame, 'Box')
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  // The debounce has fired and the encode is running when an agent replaces the file.
  await page.waitForTimeout(500)
  await postBytes(page, screenshot)
  await frame.waitForFunction(() => document.getElementById('info').textContent === '320 × 200 · PNG · 1 mark')
  // Its own commit comes due while the old encode is still held.
  await page.waitForTimeout(500)
  await frame.evaluate(() => window.__release())
  // No further edit or save: the merge reaches Orca on its own.
  await until(async () => {
    const last = (await edits(page)).at(-1)
    return last !== undefined && readMarkup(last) !== null && sameBytes(readMarkup(last).original, screenshot)
  })
  assert.deepEqual(errors, [])
  await close()
})

test('a redaction alone saves just the redacted image, with no markup inside', async () => {
  const { page, frame, errors, close } = await open()
  await page.keyboard.press('x')
  await drag(page, frame, SIZE, [[290, 290], [410, 370]])
  assert.equal(await flush(page), null)
  const saved = (await edits(page)).at(-1)
  assert.equal(readMarkup(saved), null)
  assert.equal(detectFormat(saved), 'png')
  assert.deepEqual(errors, [])
  await close()
})

test('Export saves a PNG with the markup through Orca\'s save dialog', async () => {
  const { page, frame, errors, close } = await open({ files: true })
  assert.equal(await frame.getByRole('button', { name: 'Copy image with markup', exact: true }).count(), 0)
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  await frame.getByRole('button', { name: 'Export a copy as PNG', exact: true }).click()
  await page.waitForFunction(() => window.__saved.length === 1)
  const exported = new Uint8Array(Buffer.from(await page.evaluate(() => window.__toBase64(window.__saved[0])), 'base64'))
  assert.equal(detectFormat(exported), 'png')
  assert.ok(near(await pixel(page, exported, 150, 150), RED), 'the stroke is in the export')
  assert.equal((await edits(page)).length <= 1, true)
  assert.deepEqual(errors, [])
  await close()
})

test('selects, moves, recolours, deletes, and undoes with the keyboard', async () => {
  const { page, frame, errors, close } = await open()
  await tool(frame, 'Box')
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  await page.keyboard.press('v')
  assert.equal(await frame.getByRole('button', { name: 'Select', exact: true }).getAttribute('aria-pressed'), 'true')
  await drag(page, frame, SIZE, [[100, 150], [300, 150]])
  await frame.getByRole('button', { name: 'Blue', exact: true }).click()
  await flush(page)
  let [shape] = readMarkup((await edits(page)).at(-1)).scene.shapes
  assert.ok(Math.abs(shape.p[0] - 300) < 2, `moved to ${shape.p[0]}`)
  assert.equal(shape.c, '#0a84ff')
  await page.keyboard.press('ArrowRight')
  await flush(page)
  ;[shape] = readMarkup((await edits(page)).at(-1)).scene.shapes
  assert.ok(shape.p[0] > 300, 'arrow keys nudge')
  await page.keyboard.press('Backspace')
  assert.equal(await info(frame), '640 × 400 · PNG')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  assert.equal(await info(frame), '640 × 400 · PNG · 1 mark')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z')
  assert.equal(await info(frame), '640 × 400 · PNG')
  assert.deepEqual(errors, [])
  await close()
})

test('edits text in place by double-clicking it', async () => {
  const { page, frame, errors, close } = await open()
  await page.keyboard.press('t')
  const [x, y] = await pagePoint(page, frame, SIZE, 200, 200)
  await page.mouse.click(x, y)
  await page.keyboard.type('First')
  await page.keyboard.press('Escape')
  await page.keyboard.press('v')
  await page.mouse.dblclick(x + 4, y)
  assert.equal(await frame.locator('#text-editor').isVisible(), true)
  await page.keyboard.press('End')
  await page.keyboard.type(' draft')
  const [ox, oy] = await pagePoint(page, frame, SIZE, 500, 350)
  await page.mouse.click(ox, oy)
  await flush(page)
  const shapes = readMarkup((await edits(page)).at(-1)).scene.shapes
  assert.deepEqual(shapes.map((shape) => shape.text), ['First draft'])
  assert.deepEqual(errors, [])
  await close()
})

test('JPEG files save as JPEG with the original inside', async () => {
  const { page, frame, image, errors, close } = await open({ image: { type: 'image/jpeg', quality: 0.9 }, post: { fileType: 'jpg' } })
  assert.equal(await info(frame), '640 × 400 · JPEG')
  await page.keyboard.press('r')
  await frame.getByRole('button', { name: 'Thick stroke', exact: true }).click()
  await drag(page, frame, SIZE, [[100, 100], [300, 300]])
  await flush(page)
  const [saved] = await edits(page)
  assert.equal(detectFormat(saved), 'jpeg')
  assert.ok(sameBytes(readMarkup(saved).original, image))
  assert.ok(near(await pixel(page, saved, 100, 200), RED, 40))
  assert.deepEqual(errors, [])
  await close()
})

test('read-only documents and formats without markup storage never send edits', async () => {
  const readOnly = await open({ post: { readOnly: true } })
  await drag(readOnly.page, readOnly.frame, SIZE, [[100, 100], [200, 200]])
  await flush(readOnly.page)
  assert.equal((await edits(readOnly.page)).length, 0)
  assert.match(await status(readOnly.frame), /Read-only/)
  await readOnly.close()

  const webp = await open({ image: { type: 'image/webp' }, post: { fileType: 'webp' } })
  assert.equal(await info(webp.frame), '640 × 400 · WebP')
  await drag(webp.page, webp.frame, SIZE, [[100, 100], [200, 200]])
  await flush(webp.page)
  assert.equal((await edits(webp.page)).length, 0)
  assert.match(await status(webp.frame), /can't keep markup/)
  assert.deepEqual([...readOnly.errors, ...webp.errors], [])
  await webp.close()
})

test('an outside change with no unsaved markup replaces the image; a non-image file shows a message', async () => {
  const { page, frame, errors, close } = await open()
  await postImage(page, frame, await makeImage(page, { width: 320, height: 200 }))
  await frame.waitForFunction(() => document.getElementById('info').textContent === '320 × 200 · PNG')
  await postBytes(page, new TextEncoder().encode('not an image'))
  await frame.waitForSelector('#message:not([hidden])')
  assert.match(await frame.locator('#message').textContent(), /Can't display this file/)
  await flush(page)
  assert.equal((await edits(page)).length, 0)
  assert.deepEqual(errors, [])
  await close()
})

test('an agent rewriting the image keeps markup not yet sent, on top of the new image', async () => {
  const { page, frame, errors, close } = await open()
  const screenshot = await makeImage(page, { width: 320, height: 200 })
  await tool(frame, 'Box')
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  // At once, before the debounce hands the box over: the file is replaced by a new screenshot.
  await postBytes(page, screenshot)
  await frame.waitForFunction(() => document.getElementById('info').textContent === '320 × 200 · PNG · 1 mark')
  assert.match(await frame.locator('#toast').textContent(), /markup is kept on top of the new version/)
  assert.equal(await flush(page), null)
  const saved = (await edits(page)).at(-1)
  assert.deepEqual(readMarkup(saved).scene.shapes.map((shape) => shape.t), ['box'])
  assert.deepEqual(await imageSizeOf(page, readMarkup(saved).original), [320, 200])
  assert.deepEqual(errors, [])
  await close()
})

test('a disk change under unsaved markup merges: the new image, with the markup on it', async () => {
  const { page, frame, image, errors, close } = await open()
  await tool(frame, 'Arrow')
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  assert.equal(await flush(page), null)
  // Orca hands the session the disk change with the content its unsaved edits started from.
  const rewritten = await makeImage(page, { width: 640, height: 400, type: 'image/png', quality: undefined, seed: 1 })
  await postBytes(page, rewritten, { ancestor: image })
  await frame.locator('#toast:not([hidden])').waitFor()
  await until(async () => (await edits(page)).length === 2)
  assert.equal(await flush(page), null)
  const sent = await edits(page)
  const markup = readMarkup(sent.at(-1))
  assert.deepEqual(markup.scene.shapes.map((shape) => shape.t), ['arrow'])
  assert.ok(sameBytes(markup.original, rewritten), 'the new image is the original under the markup')
  assert.equal(await info(frame), '640 × 400 · PNG · 1 mark')
  assert.deepEqual(errors, [])
  await close()
})

/** A PNG whose header claims `width`×`height` but whose pixels are junk: never meant to be decoded. */
function claimedPng(width, height) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0))
  ]))
}

test('refuses oversized images before decoding, including an original hidden inside saved markup', async () => {
  const { page, frame, image, errors, close } = await open()
  // A saved file whose embedded "original" claims 40,000 × 40,000: the plugin opens the visible image.
  const scene = { v: 1, w: 640, h: 400, shapes: [{ t: 'box', c: '#ff3b30', s: 4, p: [10, 10, 50, 50] }] }
  await postImage(page, frame, writeMarkup('png', image, claimedPng(40000, 40000), scene))
  assert.equal(await info(frame), '640 × 400 · PNG')
  await postBytes(page, claimedPng(40000, 40000))
  await frame.waitForSelector('#message:not([hidden])')
  assert.match(await frame.locator('#message').textContent(), /too large to mark up \(1600 megapixels/)
  assert.deepEqual(errors, [])
  await close()
})

test('a file that stops decoding unloads the image, so no shortcut can write the old one back', async () => {
  const { page, frame, errors, close } = await open()
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  await flush(page)
  const sent = (await edits(page)).length
  await postBytes(page, new TextEncoder().encode('not an image'))
  await frame.waitForSelector('#message:not([hidden])')
  for (const key of ['Backspace', 'p', process.platform === 'darwin' ? 'Meta+z' : 'Control+z', 'Delete']) await page.keyboard.press(key)
  await flush(page)
  assert.equal((await edits(page)).length, sent)
  // A valid file afterwards opens normally.
  await postImage(page, frame, await makeImage(page, { width: 320, height: 200 }))
  assert.equal(await info(frame), '320 × 200 · PNG')
  assert.deepEqual(errors, [])
  await close()
})

test('keyboard users press toolbar buttons with Space and Enter', async () => {
  const { frame, errors, close } = await open()
  await frame.getByRole('button', { name: 'Box', exact: true }).focus()
  await frame.page().keyboard.press('Space')
  assert.equal(await frame.getByRole('button', { name: 'Box', exact: true }).getAttribute('aria-pressed'), 'true')
  await frame.getByRole('button', { name: 'Arrow', exact: true }).focus()
  await frame.page().keyboard.press('Enter')
  assert.equal(await frame.getByRole('button', { name: 'Arrow', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.deepEqual(errors, [])
  await close()
})

test('Copy explains itself and leaves the clipboard alone while the frame lacks clipboard-write', async () => {
  const { page, frame, errors, close } = await open()
  await page.evaluate(() => navigator.clipboard.writeText('untouched'))
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  const copy = frame.getByRole('button', { name: 'Copy image with markup', exact: true })
  assert.equal(await copy.getAttribute('aria-disabled'), 'true')
  assert.match(await copy.getAttribute('title'), /doesn't let plugins copy images yet/)
  // Playwright won't click an aria-disabled button; a person can, and gets the explanation.
  await copy.dispatchEvent('click')
  await frame.locator('#toast:not([hidden])').waitFor()
  assert.match(await frame.locator('#toast').textContent(), /saves the markup into the image instead/)
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'untouched')
  assert.deepEqual(errors, [])
  await close()
})

test('Copy writes a real PNG once the frame may write to the clipboard', async () => {
  const { page, frame, errors, close } = await open({ allowClipboard: true })
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
  await frame.locator('#toast:not([hidden])').waitFor()
  assert.equal(await frame.locator('#toast').textContent(), 'Copied the image with its markup')
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read()
    return window.__toBase64(new Uint8Array(await (await item.getType('image/png')).arrayBuffer()))
  })
  const png = Uint8Array.from(Buffer.from(copied, 'base64'))
  assert.ok(near(await pixel(page, png, 150, 150), RED), 'the stroke is in the copy')
  assert.deepEqual(errors, [])
  await close()
})

test('the save hint shows while there is markup to keep, and only for files that can keep it', async () => {
  const { page, frame, errors, close } = await open()
  const hint = frame.locator('.save-hint')
  assert.equal(await hint.isVisible(), false)
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  assert.match(await hint.textContent(), /saves into image/)
  await page.keyboard.press('Backspace') // nothing selected: no change
  await frame.getByRole('button', { name: 'Clear all markup', exact: true }).click()
  assert.equal(await hint.isVisible(), false)
  await close()
  const webp = await open({ image: { type: 'image/webp' }, post: { fileType: 'webp' } })
  await drag(webp.page, webp.frame, SIZE, [[100, 100], [200, 200]])
  assert.equal(await webp.frame.locator('.save-hint').isVisible(), false)
  assert.deepEqual([...errors, ...webp.errors], [])
  await webp.close()
})

test('a decode still running for an older document cannot replace a newer one', async () => {
  const { page, frame, image, errors, close } = await open()
  // A slow 24 MP image, then at once the file this frame already shows (the change reverted).
  await postBytes(page, await makeImage(page, { width: 6000, height: 4000 }))
  await postBytes(page, image)
  await frame.waitForTimeout(1500)
  assert.equal(await info(frame), '640 × 400 · PNG')
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  assert.equal(await flush(page), null)
  const sent = await page.evaluate(() => window.__edits.map((edit) => edit.baseVersion))
  assert.ok(sent.length > 0 && sent.every((version) => version === 3), `the edits name the newest version, so Orca takes them: ${sent}`)
  assert.deepEqual(errors, [])
  await close()
})

test('an edit refused as stale stops the save, and goes through once Orca delivers the newer document', async () => {
  const { page, frame, image, errors, close } = await open()
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  // Orca moved on (say, the tab reloaded the same file) before telling the frame.
  await page.evaluate(() => window.__version++)
  const error = await flush(page)
  assert.ok(error, 'the save is stopped, not run without the markup')
  assert.equal((await edits(page)).length, 0)
  await postBytes(page, image)
  assert.equal(await flush(page), null)
  assert.equal(readMarkup((await edits(page))[0]).scene.shapes.length, 1)
  assert.equal(await info(frame), '640 × 400 · PNG · 1 mark')
  assert.deepEqual(errors, [])
  await close()
})

test('a flush fails, so Orca does not save, when Orca refuses the markup', async () => {
  const { page, frame, errors, close } = await open()
  await page.evaluate(() => (window.__refuse = { code: 'too_large', message: 'too large' }))
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  const error = await flush(page)
  assert.ok(error, 'the save is stopped')
  await frame.waitForFunction(() => /Orca didn't take the markup/.test(document.getElementById('status').textContent))
  assert.deepEqual(errors, [])
  await close()
})

test('a flush right after a stroke finishes within Orca\'s 1 s on a 12-megapixel image', async () => {
  const big = [4240, 2830]
  const { page, frame, errors, close } = await openEditor(browser)
  await postImage(page, frame, await makeImage(page, { width: big[0], height: big[1] }))
  await drag(page, frame, big, [[500, 500], [2000, 1500]])
  const start = Date.now()
  assert.equal(await flush(page), null)
  const elapsed = Date.now() - start
  console.log(`  12 MP flush straight after a stroke: ${elapsed} ms`)
  assert.ok(elapsed < 1000, `${elapsed} ms`)
  assert.equal((await edits(page)).length, 1)
  assert.deepEqual(errors, [])
  await close()
})

test('a second pointer cannot end or steer the stroke the first one started', async () => {
  const { page, frame, errors, close } = await open()
  await frame.evaluate(() => {
    const overlay = document.getElementById('overlay')
    const rect = overlay.getBoundingClientRect()
    const send = (type, id, x, y) =>
      overlay.dispatchEvent(new PointerEvent(type, { pointerId: id, bubbles: true, clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons: 1 }))
    send('pointerdown', 1, 100, 100)
    send('pointermove', 1, 150, 160)
    send('pointerup', 7, 400, 400)
    send('pointermove', 7, 600, 600)
    send('pointermove', 1, 200, 100)
    send('pointerup', 1, 200, 100)
  })
  await flush(page)
  const [stroke] = readMarkup((await edits(page))[0]).scene.shapes
  assert.ok(stroke.p.length >= 6, 'one stroke with all three of its own points')
  assert.ok(Math.max(...stroke.p) < 400)
  assert.deepEqual(errors, [])
  await close()
})

test('quick drags keep the release position even without a pointermove', async () => {
  const { page, frame, errors, close } = await open()
  for (const name of ['Pen', 'Arrow', 'Box', 'Ellipse']) {
    await tool(frame, name)
    await frame.evaluate(() => {
      const overlay = document.getElementById('overlay')
      const rect = overlay.getBoundingClientRect()
      const send = (type, x, y) => overlay.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, bubbles: true, clientX: rect.left + x, clientY: rect.top + y,
        button: 0, buttons: type === 'pointerup' ? 0 : 1
      }))
      send('pointerdown', 400, 300)
      send('pointerup', 500, 350)
    })
  }
  assert.equal(await flush(page), null)
  const shapes = readMarkup((await edits(page)).at(-1)).scene.shapes
  assert.deepEqual(shapes.map((shape) => shape.t), ['pen', 'arrow', 'box', 'ellipse'])
  for (const shape of shapes) {
    assert.equal(shape.p[2] - shape.p[0], 100)
    assert.equal(shape.p[3] - shape.p[1], 50)
  }
  assert.deepEqual(errors, [])
  await close()
})

for (const ending of ['pointercancel', 'lostpointercapture']) {
  test(`${ending} keeps the drawn stroke and lets the next stroke start`, async () => {
    const { page, frame, errors, close } = await open()
    const [x, y] = await pagePoint(page, frame, SIZE, 100, 100)
    const [ex, ey] = await pagePoint(page, frame, SIZE, 200, 150)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(ex, ey, { steps: 4 })
    await frame.evaluate((type) => {
      const overlay = document.getElementById('overlay')
      // Cancellation/capture events need not contain the last pointer's coordinates.
      overlay.dispatchEvent(new PointerEvent(type, { pointerId: 1, bubbles: true }))
    }, ending)
    await page.mouse.up()
    assert.equal(await info(frame), '640 × 400 · PNG · 1 mark')
    await drag(page, frame, SIZE, [[300, 100], [400, 150]])
    assert.equal(await flush(page), null)
    const saved = (await edits(page)).at(-1)
    const shapes = readMarkup(saved).scene.shapes
    assert.equal(shapes.length, 2)
    assert.deepEqual(shapes[0].p, [100, 100, 200, 150])
    assert.ok(near(await pixel(page, saved, 150, 125), RED))
    await tool(frame, 'Undo')
    await tool(frame, 'Undo')
    assert.equal(await info(frame), '640 × 400 · PNG')
    assert.deepEqual(errors, [])
    await close()
  })
}

test('images past the canvas size limit open, but are never written blank', async () => {
  const { page, frame, errors, close } = await openEditor(browser)
  await postImage(page, frame, await makeImage(page, { width: 40000, height: 4 }))
  assert.match(await status(frame), /over 32,767 px on a side can't keep markup/)
  await frame.locator('#stage').click()
  await flush(page)
  assert.equal((await edits(page)).length, 0)
  assert.deepEqual(errors, [])
  await close()
})

test('text is capped at what a saved file keeps', async () => {
  const { frame, errors, close } = await open()
  assert.equal(await frame.locator('#text-editor').evaluate((node) => node.maxLength), 4000)
  assert.deepEqual(errors, [])
  await close()
})

test('stays fast: drawing and panning over 2,000 shapes on a 24-megapixel image', async () => {
  const big = [6000, 4000]
  const { page, frame, errors, close } = await openEditor(browser)
  const image = await makeImage(page, { width: big[0], height: big[1] })
  // A saved file with 2,000 strokes: 40 rows of 50, each a 60-point squiggle.
  const shapes = []
  for (let i = 0; i < 2000; i++) {
    const x = 60 + (i % 50) * 118
    const y = 60 + Math.floor(i / 50) * 98
    const p = []
    for (let j = 0; j < 60; j++) p.push(x + j * 1.5, y + Math.sin(j / 5) * 30)
    shapes.push({ t: 'pen', c: '#ff3b30', s: 6, p })
  }
  const saved = writeMarkup('png', image, image, { v: 1, w: big[0], h: big[1], shapes })
  const loadStart = Date.now()
  await postImage(page, frame, saved)
  const loadMs = Date.now() - loadStart
  assert.equal(await info(frame), '6000 × 4000 · PNG · 2000 marks')
  const timing = await frame.evaluate(async () => {
    const overlay = document.getElementById('overlay')
    const rect = overlay.getBoundingClientRect()
    const send = (type, x, y) =>
      overlay.dispatchEvent(
        new PointerEvent(type, { pointerId: 1, bubbles: true, clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons: 1 })
      )
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const median = (list) => list.sort((a, b) => a - b)[Math.floor(list.length / 2)]
    // Sustained frame interval with one input event per frame: each event's paint, and the
    // rasterizing after it, land in the frame before the next tick, so slow work stretches it.
    const measure = (count, step) =>
      new Promise((resolve) => {
        const stamps = []
        let i = 0
        const tick = (time) => {
          stamps.push(time)
          if (i === count) {
            resolve(median(stamps.slice(1).map((stamp, j) => stamp - stamps[j])))
            return
          }
          step(i++)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    // Let the first full paint and the downscaled copy settle.
    for (let i = 0; i < 10; i++) await nextFrame()
    send('pointerdown', 50, 50)
    const draw = await measure(120, (i) => send('pointermove', 50 + i * 4, 50 + Math.sin(i / 8) * 60))
    send('pointerup', 530, 50)
    // One very long stroke: each frame should cost its new points, not the whole stroke so far.
    send('pointerdown', 40, 40)
    for (let i = 0; i < 6000; i++) send('pointermove', 40 + (i % 400), 40 + Math.floor(i / 400) * 4)
    const longStroke = await measure(60, (i) => send('pointermove', 40 + i * 3, 300))
    send('pointerup', 220, 300)
    const wheel = (deltaX, deltaY, extra = {}) =>
      overlay.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true, clientX: rect.left + 300, clientY: rect.top + 300, ...extra }))
    const pan = await measure(60, () => wheel(3, 2))
    const zoom = await measure(60, (i) => wheel(0, i < 30 ? -4 : 4, { ctrlKey: true }))
    return { draw, longStroke, pan, zoom }
  })
  const flushStart = Date.now()
  assert.equal(await flush(page), null)
  const saveMs = Date.now() - flushStart
  console.log(
    `  24 MP, 2,000 strokes: load ${loadMs} ms; median frame interval drawing ${timing.draw.toFixed(1)} ms, ` +
      `a 6,000-point stroke ${timing.longStroke.toFixed(1)} ms, panning ${timing.pan.toFixed(1)} ms, zooming ${timing.zoom.toFixed(1)} ms; flush ${saveMs} ms`
  )
  // Headless Chromium renders in software; a 60 Hz frame is 16.7 ms. Allow a little slack.
  assert.ok(timing.draw < 20, `drawing frame ${timing.draw} ms`)
  assert.ok(timing.longStroke < 20, `long stroke frame ${timing.longStroke} ms`)
  assert.ok(timing.pan < 20, `panning frame ${timing.pan} ms`)
  assert.ok(timing.zoom < 34, `zooming frame ${timing.zoom} ms`)
  assert.equal(readMarkup((await edits(page)).at(-1)).scene.shapes.length, 2002)
  assert.deepEqual(errors, [])
  await close()
})
