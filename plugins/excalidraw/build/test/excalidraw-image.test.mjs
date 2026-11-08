// The scene that .excalidraw.svg and .excalidraw.png images embed (src/excalidraw-image.js), and
// those images' document sync (src/scene-sync.js, src/picture-sync.js). The fixtures are real
// Excalidraw 0.18.1 exports with "Embed scene" on (see README.md).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { crc32 } from 'node:zlib'
import { mockEditorHost } from './orca-testing/orca-testing.mjs'
import {
  BLANK_SVG,
  EXCALIDRAW_MIME,
  blankPng,
  embedPngScene,
  embedSvgScene,
  readPngChunks,
  readPngScene,
  readPngSize,
  readSvgLook,
  readSvgScene
} from '../src/excalidraw-image.js'
import { decodeImageScene, mergeScenes, openSceneSession } from '../src/scene-sync.js'
import { syncPicture } from '../src/picture-sync.js'

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url))
const svgFixture = fixture('light-2x.excalidraw.svg').toString('utf8')
const pngFixture = new Uint8Array(fixture('light-2x.excalidraw.png'))
const element = (id, version, versionNonce) => ({ id, type: 'rectangle', version, versionNonce })
const sceneJson = (elements, source = 'local') =>
  JSON.stringify({ type: 'excalidraw', version: 2, source, elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} })
// Stands in for Excalidraw's serializeAsJSON: the non-deleted elements and the saved settings.
const serialize = ({ elements, appState, files }) =>
  JSON.stringify({ type: 'excalidraw', version: 2, source: 'local', elements: elements.filter((e) => !e.isDeleted), appState, files })
const elementIds = (json) => JSON.parse(json).elements.map((e) => e.id)
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const drawnSvg = (mark) => `<svg xmlns="http://www.w3.org/2000/svg" data-drawn="${mark}"><metadata></metadata></svg>`
// As the editor does: the picture's save handler first, then the session.
async function openWithPicture(text, options, write = serialize) {
  host = mockEditorHost({ text })
  picture = syncPicture({ onError: assert.fail, ...options })
  const doc = await openSceneSession(write, { image: true, timing: picture.timing })
  picture.attach(doc)
  return doc
}

let host
let picture
afterEach(() => {
  picture?.dispose()
  host?.dispose()
  picture = host = undefined
})

test("reads the scene of Excalidraw's own SVG and PNG exports", () => {
  for (const name of ['light-2x.excalidraw.svg', 'dark-transparent.excalidraw.svg']) {
    assert.deepEqual(elementIds(readSvgScene(fixture(name).toString('utf8'))), ['box', 'dot'], name)
  }
  for (const name of ['light-2x.excalidraw.png', 'dark-1x.excalidraw.png', 'transparent-1x.excalidraw.png']) {
    assert.deepEqual(elementIds(readPngScene(new Uint8Array(fixture(name)))), ['box', 'dot'], name)
  }
})

test("reads an SVG export's scale, background and dark mode", () => {
  assert.deepEqual(readSvgLook(svgFixture), { scale: 2, background: true, dark: false })
  assert.deepEqual(readSvgLook(fixture('dark-transparent.excalidraw.svg').toString('utf8')), {
    scale: 1,
    background: false,
    dark: true
  })
  assert.deepEqual(readPngSize(pngFixture), { width: 2 * (340 + 20), height: 2 * (100 + 20) })
})

test('re-embedding replaces the scene and leaves the picture as it was', () => {
  const svg = embedSvgScene(svgFixture, sceneJson([element('new', 1, 1)]))
  assert.deepEqual(elementIds(readSvgScene(svg)), ['new'])
  assert.equal(svg.match(/payload-start/g).length, 1)
  const picture = (text) => text.replace(/<metadata>[^]*<\/metadata>/, '')
  assert.equal(picture(svg), picture(svgFixture))

  const png = embedPngScene(pngFixture, sceneJson([element('new', 1, 1)]))
  assert.deepEqual(elementIds(readPngScene(png)), ['new'])
  const chunks = readPngChunks(png)
  const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt')
  assert.equal(textChunks.length, 1)
  // Excalidraw reads only the first tEXt chunk.
  assert.equal(chunks[1].name, 'tEXt')
  assert.equal(Buffer.from(textChunks[0].data.subarray(0, EXCALIDRAW_MIME.length)).toString('latin1'), EXCALIDRAW_MIME)
  const pixels = (bytes) => readPngChunks(bytes).filter((chunk) => chunk.name !== 'tEXt').map((chunk) => [chunk.name, [...chunk.data]])
  assert.deepEqual(pixels(png), pixels(pngFixture))
})

test('a written PNG has valid chunk checksums', () => {
  const png = embedPngScene(blankPng(), sceneJson([element('a', 1, 1)]))
  const view = new DataView(png.buffer)
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at)
    assert.equal(view.getUint32(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)))
    at += 12 + length
  }
  assert.deepEqual(readPngSize(png), { width: 1, height: 1 })
})

test('a scene with non-Latin text survives the round trip', () => {
  const json = sceneJson([{ ...element('a', 1, 1), type: 'text', text: 'Grüße, 世界 🎨' }])
  assert.equal(readSvgScene(embedSvgScene(BLANK_SVG, json)), json)
  assert.equal(readPngScene(embedPngScene(blankPng(), json)), json)
})

test('an SVG without a <metadata> element gets one', () => {
  const svg = embedSvgScene('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', sceneJson([]))
  assert.match(svg, /^<\?xml version="1.0"\?>\n<svg xmlns="http:\/\/www.w3.org\/2000\/svg"><metadata><!-- payload-type/)
  assert.deepEqual(elementIds(readSvgScene(svg)), [])
  assert.deepEqual(elementIds(readSvgScene(embedSvgScene('<svg xmlns="http://www.w3.org/2000/svg" />', sceneJson([])))), [])
})

test('images without a scene, or that are no images, decode to readable errors', () => {
  assert.match(decodeImageScene({ kind: 'text', text: '<svg xmlns="http://www.w3.org/2000/svg"/>' }).error, /no embedded Excalidraw scene/)
  assert.match(decodeImageScene({ kind: 'text', text: '{"type":"excalidraw"}' }).error, /not an SVG image/)
  assert.match(decodeImageScene({ kind: 'bytes', bytes: new Uint8Array([1, 2, 3]).buffer }).error, /not a PNG image/)
  assert.match(decodeImageScene({ kind: 'bytes', bytes: blankPng().buffer }).error, /no embedded Excalidraw scene/)
  const damaged = svgFixture.replace(/payload-start -->[^<]{20}/, 'payload-start -->@@@@')
  assert.match(decodeImageScene({ kind: 'text', text: damaged }).error, /damaged/)
})

test('an empty image file opens as a blank drawing and saves as an image', async () => {
  host = mockEditorHost({ bytes: new Uint8Array(0) })
  const doc = await openSceneSession(serialize, { image: true })
  assert.deepEqual(doc.value.elements, [])
  doc.change({ ...doc.value, elements: [element('a', 1, 1)], stale: true })
  await host.flush()
  assert.deepEqual(elementIds(readPngScene(host.bytes)), ['a'])
})

test('editing an SVG saves the new scene in the file, keeping its source', async () => {
  host = mockEditorHost({ text: svgFixture })
  const doc = await openSceneSession(serialize, { image: true })
  assert.equal(doc.value.format, 'svg')
  assert.deepEqual(doc.value.elements.map((e) => e.id), ['box', 'dot'])
  await host.flush()
  assert.equal(host.edits.length, 0)
  doc.change({ ...doc.value, elements: [...doc.value.elements, element('mine', 1, 1)], stale: true })
  await host.flush()
  const saved = readSvgScene(host.text)
  assert.deepEqual(elementIds(saved), ['box', 'dot', 'mine'])
  assert.equal(JSON.parse(saved).source, JSON.parse(readSvgScene(svgFixture)).source)
})

test('editing a PNG saves bytes with the new scene', async () => {
  host = mockEditorHost({ bytes: pngFixture })
  const doc = await openSceneSession(serialize, { image: true })
  assert.equal(doc.value.format, 'png')
  doc.change({ ...doc.value, elements: [element('only', 1, 1)], stale: true })
  await host.flush()
  assert.deepEqual(elementIds(readPngScene(host.bytes)), ['only'])
  assert.deepEqual(readPngSize(host.bytes), readPngSize(pngFixture))
})

test('a merge keeps the outside picture and marks it for drawing again', async () => {
  host = mockEditorHost({ text: svgFixture })
  const doc = await openSceneSession(serialize, { image: true })
  const outside = embedSvgScene(svgFixture, sceneJson([element('box', 1, 1), element('dot', 1, 1), element('agent', 1, 1)]))
  host.conflictNext(outside)
  const replaced = []
  doc.onReplace((value) => replaced.push(value))
  doc.change({ ...doc.value, elements: [...doc.value.elements, element('mine', 1, 1)], stale: true })
  await host.flush()
  assert.deepEqual(elementIds(readSvgScene(host.text)), ['box', 'dot', 'agent', 'mine'])
  assert.equal(replaced.at(-1).stale, true)
  assert.equal(replaced.at(-1).image, outside)

  const base = decodeImageScene({ kind: 'text', text: svgFixture })
  assert.equal(mergeScenes(base, base, base).stale, true)
})

test('the picture is drawn again once the canvas is idle, then sent', async () => {
  const drawn = []
  const doc = await openWithPicture(svgFixture, {
    render: async (scene) => {
      drawn.push(scene.elements.map((e) => e.id))
      return drawnSvg(drawn.length)
    },
    idleMs: 5
  })
  doc.change({ ...doc.value, elements: [element('a', 1, 1)], stale: true })
  picture.schedule()
  doc.change({ ...doc.value, elements: [element('a', 2, 2)], stale: true })
  picture.schedule()
  await tick(30)
  await host.flush()
  assert.deepEqual(drawn, [['a']])
  assert.match(host.text, /data-drawn="1"/)
  assert.deepEqual(elementIds(readSvgScene(host.text)), ['a'])
  assert.equal(doc.value.stale, false)
})

test('a save draws the picture at once, and does not wait past its deadline', async () => {
  let delayMs = 0
  const doc = await openWithPicture(svgFixture, {
    render: async () => {
      await tick(delayMs)
      return drawnSvg(delayMs)
    },
    idleMs: 60_000,
    budgetMs: 250
  })
  doc.change({ ...doc.value, elements: [element('a', 1, 1)], stale: true })
  picture.schedule()
  await host.flush()
  assert.match(host.text, /data-drawn="0"/)
  assert.deepEqual(elementIds(readSvgScene(host.text)), ['a'])

  // A slow picture: the save goes ahead with the new scene in the old picture.
  delayMs = 400
  doc.change({ ...doc.value, elements: [element('b', 1, 1)], stale: true })
  picture.schedule()
  const started = Date.now()
  await host.flush()
  assert.ok(Date.now() - started < 300)
  assert.match(host.text, /data-drawn="0"/)
  assert.deepEqual(elementIds(readSvgScene(host.text)), ['b'])
  // It still lands afterwards, as a new edit.
  await tick(450)
  await host.flush()
  assert.match(host.text, /data-drawn="400"/)
  assert.deepEqual(elementIds(readSvgScene(host.text)), ['b'])
})

test('a save leaves the picture out when writing the scene again would not fit', async () => {
  // Each write takes 150 ms: the save's own and the picture's would not both fit in 350.
  const slowSerialize = (scene) => {
    const until = performance.now() + 150
    while (performance.now() < until);
    return serialize(scene)
  }
  const doc = await openWithPicture(svgFixture, { render: async () => drawnSvg('late'), idleMs: 100, budgetMs: 350 }, slowSerialize)
  doc.change({ ...doc.value, elements: [element('a', 1, 1)], stale: true })
  picture.schedule()
  await host.flush()
  assert.equal(host.edits.length, 1)
  assert.doesNotMatch(host.text, /data-drawn/)
  assert.deepEqual(elementIds(readSvgScene(host.text)), ['a'])
  // The picture is drawn once the canvas is idle, and sent after the save.
  await tick(400)
  await host.flush()
  assert.match(host.text, /data-drawn="late"/)
  assert.deepEqual(elementIds(readSvgScene(host.text)), ['a'])
})

test('a picture that fails to draw is reported once, and the scene still saves', async () => {
  const errors = []
  const doc = await openWithPicture(svgFixture, {
    render: async () => {
      throw new Error('no canvas')
    },
    onError: (error) => errors.push(error.message),
    idleMs: 5
  })
  doc.change({ ...doc.value, elements: [element('a', 1, 1)], stale: true })
  picture.schedule()
  await tick(30)
  await host.flush()
  await host.flush()
  assert.deepEqual(errors, ['no canvas'])
  assert.deepEqual(elementIds(readSvgScene(host.text)), ['a'])
})
