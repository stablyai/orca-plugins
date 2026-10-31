import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { crc32, detectFormat, readMarkup, sameBytes, writeMarkup } from '../src/container.js'
import { drag, edits, launch, makeImage, openEditor, pagePoint, pixel, postBytes, postImage } from './harness.mjs'

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

const tool = (frame, name) => frame.getByRole('button', { name, exact: true }).click()
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
  await page.waitForFunction(() => window.__edits.length === 1, null, { timeout: 3000 })
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

test('reopening a saved file restores editable shapes; clearing them saves the original byte for byte', async () => {
  const first = await open()
  await drag(first.page, first.frame, SIZE, [[100, 100], [200, 150]])
  await flush(first.page)
  const [saved] = await edits(first.page)
  await first.close()

  const { page, frame, errors, close } = await openEditor(browser)
  await postImage(page, frame, saved)
  assert.equal(await info(frame), '640 × 400 · PNG · 1 mark')
  assert.match(await status(frame), /Saved markup/)
  await frame.getByRole('button', { name: 'Clear all markup', exact: true }).click()
  await flush(page)
  const [restored] = await edits(page)
  assert.ok(sameBytes(restored, first.image), 'the original file, exactly')
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

test('an outside change replaces the scene; stale and non-image documents are ignored', async () => {
  const { page, frame, errors, close } = await open()
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  const other = await makeImage(page, { width: 320, height: 200 })
  await postImage(page, frame, other)
  await frame.waitForFunction(() => document.getElementById('info').textContent === '320 × 200 · PNG')
  await postBytes(page, await makeImage(page), { version: 1 })
  await postBytes(page, new TextEncoder().encode('not an image'))
  await frame.waitForSelector('#message:not([hidden])')
  assert.match(await frame.locator('#message').textContent(), /Can't display this file/)
  await flush(page)
  assert.equal((await edits(page)).length, 0, 'strokes on the replaced file are dropped, not sent')
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

test('the unsaved hint shows until Orca saves the markup', async () => {
  const { page, frame, errors, close } = await open()
  const hint = frame.locator('.save-hint')
  assert.equal(await hint.isVisible(), false)
  await drag(page, frame, SIZE, [[100, 100], [200, 200]])
  assert.equal(await hint.isVisible(), true)
  await flush(page)
  // A save makes Orca send the file it wrote, which is what the frame posted.
  await postBytes(page, (await edits(page)).at(-1))
  await frame.waitForFunction(() => document.querySelector('.save-hint').hidden)
  assert.match(await status(frame), /Saved markup/)
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
    const wheel = (deltaX, deltaY, extra = {}) =>
      overlay.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true, clientX: rect.left + 300, clientY: rect.top + 300, ...extra }))
    const pan = await measure(60, () => wheel(3, 2))
    const zoom = await measure(60, (i) => wheel(0, i < 30 ? -4 : 4, { ctrlKey: true }))
    return { draw, pan, zoom }
  })
  const flushStart = Date.now()
  await flush(page)
  const saveMs = Date.now() - flushStart
  console.log(
    `  24 MP, 2,000 strokes: load ${loadMs} ms; median frame interval drawing ${timing.draw.toFixed(1)} ms, ` +
      `panning ${timing.pan.toFixed(1)} ms, zooming ${timing.zoom.toFixed(1)} ms; encode + save ${saveMs} ms`
  )
  // Headless Chromium renders in software; a 60 Hz frame is 16.7 ms. Allow a little slack.
  assert.ok(timing.draw < 20, `drawing frame ${timing.draw} ms`)
  assert.ok(timing.pan < 20, `panning frame ${timing.pan} ms`)
  assert.ok(timing.zoom < 34, `zooming frame ${timing.zoom} ms`)
  assert.equal((await edits(page)).length, 1)
  assert.deepEqual(errors, [])
  await close()
})
