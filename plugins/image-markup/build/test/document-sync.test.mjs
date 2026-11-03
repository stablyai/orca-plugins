// The image's document sync (src/document-sync.js) against Orca's real frame session, through
// `mockEditorHost` from orca/testing (vendored in ./orca-testing; see README.md).
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mockEditorHost } from './orca-testing/orca-testing.mjs'
import { crc32, readMarkup, sameBytes, writeMarkup } from '../src/container.js'
import { decodeImage, mergeImages, openImageSession } from '../src/document-sync.js'

/** A PNG with a real header and a distinct `tag` in its pixel data; nothing here decodes it. */
function png(width, height, tag = 0) {
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
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', Buffer.from([0x78, 0x9c, tag, 0x00])),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
}

const box = (x) => ({ t: 'box', c: '#ff3b30', s: 4, p: [x, 10, x + 40, 50] })
const scene = (shapes, w = 64, h = 32) => ({ v: 1, w, h, shapes })
/** A saved file: `original` with `shapes`, over a stand-in flattened image. */
const saved = (original, shapes) => writeMarkup('png', png(64, 32, 99), original, scene(shapes))
const kinds = (value) => value.shapes.map((shape) => `${shape.t}@${shape.p?.[0] ?? shape.x}`)
/** What the editor hands the session after encoding `shapes` over `value`'s original. */
const edited = (value, shapes) => ({ ...value, shapes, file: saved(value.original, shapes) })

let host
afterEach(() => host?.dispose())

test('decodes a saved file into its original and shapes, and a plain image into no shapes', () => {
  const original = png(64, 32, 1)
  const value = decodeImage({ kind: 'bytes', bytes: saved(original, [box(5)]).slice().buffer })
  assert.ok(sameBytes(value.original, original))
  assert.deepEqual(kinds(value), ['box@5'])
  assert.equal(value.hadMarkup, true)
  const plain = decodeImage({ kind: 'bytes', bytes: original.slice().buffer })
  assert.equal(plain.original, plain.file)
  assert.deepEqual(plain.shapes, [])
  const junk = decodeImage({ kind: 'bytes', bytes: new TextEncoder().encode('not an image').buffer })
  assert.equal(junk.format, null)
})

test('opening sends nothing; a change sends the encoded file, and a flush waits for it', async () => {
  const original = png(64, 32, 1)
  host = mockEditorHost({ bytes: original })
  const doc = await openImageSession()
  await host.flush()
  assert.equal(host.edits.length, 0)
  doc.change(edited(doc.value, [box(5)]))
  await host.flush()
  assert.equal(host.edits.length, 1)
  assert.deepEqual(readMarkup(host.bytes).scene.shapes.map((shape) => shape.p[0]), [5])
  assert.ok(sameBytes(readMarkup(host.bytes).original, original))
})

test('an agent rewriting the file with nothing unsent replaces the image', async () => {
  host = mockEditorHost({ bytes: png(64, 32, 1) })
  const doc = await openImageSession()
  const replaced = []
  doc.onReplace((value) => replaced.push(value))
  host.replace(png(128, 64, 2))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(replaced.length, 1)
  assert.ok(sameBytes(replaced[0].file, png(128, 64, 2)))
  assert.equal(replaced[0].stale, undefined)
})

test('an agent rewriting the file under unsent markup keeps the markup on the new image', async () => {
  host = mockEditorHost({ bytes: png(64, 32, 1) })
  const doc = await openImageSession()
  const replaced = []
  doc.onReplace((value) => replaced.push(value))
  const rewritten = png(64, 32, 2)
  host.conflictNext(rewritten)
  doc.change(edited(doc.value, [box(5)]))
  await host.flush()
  assert.equal(replaced.length, 1)
  const [merged] = replaced
  assert.equal(merged.stale, true, 'the editor still has to encode it')
  assert.deepEqual(kinds(merged), ['box@5'])
  assert.ok(sameBytes(merged.original, rewritten))
  // Meanwhile Orca holds the agent's file, not a stale render of the old image.
  assert.ok(sameBytes(host.bytes, rewritten))
  assert.deepEqual(host.edits.map((edit) => edit.refused ?? 'ok'), ['conflict', 'ok'])
  // The editor encodes the merge and sends it as its next change.
  doc.change(edited(merged, merged.shapes))
  await host.flush()
  assert.ok(sameBytes(readMarkup(host.bytes).original, rewritten))
})

test('merge: the outside image and shapes, plus what this editor added, minus what it removed', () => {
  const original = png(64, 32, 1)
  const base = decodeImage({ kind: 'bytes', bytes: saved(original, [box(1), box(2)]).slice().buffer })
  const outside = decodeImage({ kind: 'bytes', bytes: saved(png(64, 32, 3), [box(1), box(2), box(3)]).slice().buffer })
  // This editor deleted box 1 and drew box 9.
  const mine = edited(base, [base.shapes[1], { ...box(9), id: 77 }])
  const merged = mergeImages(base, outside, mine)
  assert.deepEqual(kinds(merged), ['box@2', 'box@3', 'box@9'])
  assert.ok(sameBytes(merged.original, outside.original))
  assert.equal(merged.stale, true)
})

test('merge: Orca resending this editor\'s own base keeps its edit as it is', () => {
  const base = decodeImage({ kind: 'bytes', bytes: png(64, 32, 1).slice().buffer })
  const echo = decodeImage({ kind: 'bytes', bytes: png(64, 32, 1).slice().buffer })
  const mine = edited(base, [box(5)])
  assert.equal(mergeImages(base, echo, mine), mine)
})

test('merge: nothing added or removed here leaves the outside file untouched', () => {
  const base = decodeImage({ kind: 'bytes', bytes: png(64, 32, 1).slice().buffer })
  const outside = decodeImage({ kind: 'bytes', bytes: saved(png(64, 32, 2), [box(4)]).slice().buffer })
  assert.equal(mergeImages(base, outside, base), outside)
})

test('merge: step numbers run 1, 2, 3 again after both sides added steps', () => {
  const step = (x, n) => ({ t: 'step', c: '#ff3b30', z: 20, x, y: 10, n })
  const base = decodeImage({ kind: 'bytes', bytes: saved(png(64, 32, 1), [step(5, 1)]).slice().buffer })
  const outside = decodeImage({ kind: 'bytes', bytes: saved(png(64, 32, 1), [step(5, 1), step(20, 2)]).slice().buffer })
  const mine = edited(base, [base.shapes[0], { ...step(40, 2), id: 9 }])
  assert.deepEqual(mergeImages(base, outside, mine).shapes.map((shape) => [shape.x, shape.n]), [[5, 1], [20, 2], [40, 3]])
})

test('decodes the markup of an EXIF-rotated photo against its shown, swapped size', () => {
  const original = png(64, 32, 1)
  const value = decodeImage({ kind: 'bytes', bytes: writeMarkup('png', png(32, 64, 99), original, scene([box(5)], 32, 64)).slice().buffer })
  assert.deepEqual(value.size, [32, 64])
  assert.deepEqual(kinds(value), ['box@5'])
})
