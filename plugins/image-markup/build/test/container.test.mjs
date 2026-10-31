import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { crc32, detectFormat, imageSize, readMarkup, sameBytes, writeMarkup } from '../src/container.js'

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length)
  return out
}

/** A valid width×height RGB PNG filled with one colour, plus an optional text chunk. */
function png(width, height, [r, g, b], { text } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      ...(text ? [chunk('tEXt', Buffer.from(`Comment\0${text}`))] : []),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
}

/** Enough JPEG structure for the container: SOI, APP0, DQT, SOS with fake scan data, EOI. */
function jpeg(scan = [1, 2, 3, 4, 5]) {
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const dqt = [0xff, 0xdb, 0, 4, 0, 0]
  const sos = [0xff, 0xda, 0, 3, 0]
  return Uint8Array.from([0xff, 0xd8, ...app0, ...dqt, ...sos, ...scan, 0xff, 0xd9])
}

const SCENE = { v: 1, w: 4, h: 3, shapes: [{ t: 'box', c: '#ff3b30', s: 2, p: [0, 0, 2, 2] }] }

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  const bytes = new TextEncoder().encode('hello world')
  assert.equal(crc32(bytes, 5, bytes.length, crc32(bytes, 0, 5)), crc32(bytes))
})

test('detects image formats by their signatures', () => {
  assert.equal(detectFormat(png(1, 1, [0, 0, 0])), 'png')
  assert.equal(detectFormat(jpeg()), 'jpeg')
  assert.equal(detectFormat(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'webp')
  assert.equal(detectFormat(new TextEncoder().encode('GIF89a')), 'gif')
  assert.equal(detectFormat(new TextEncoder().encode('BM....')), 'bmp')
  assert.equal(detectFormat(Uint8Array.from([0, 0, 0, 0x1c, ...new TextEncoder().encode('ftypavif')])), 'avif')
  assert.equal(detectFormat(new TextEncoder().encode('<svg/>')), null)
})

test('PNG: stores the scene and original bytes, and reads them back exactly', () => {
  const original = png(4, 3, [10, 20, 30], { text: 'original' })
  const flattened = png(4, 3, [200, 0, 0], { text: 'flat' })
  assert.equal(readMarkup(original), null)
  const saved = writeMarkup('png', flattened, original, SCENE)
  assert.equal(detectFormat(saved), 'png')
  const markup = readMarkup(saved)
  assert.deepEqual(markup.scene, SCENE)
  assert.ok(sameBytes(markup.original, original))
  // The block sits before IEND, and the flattened chunks are untouched around it.
  const text = new TextDecoder('latin1').decode(saved)
  assert.ok(text.indexOf('orCA') > text.indexOf('IDAT') && text.indexOf('orCA') < text.lastIndexOf('IEND'))
  assert.ok(text.includes('Commentflat') || text.includes('Comment\0flat'))
  // Saving again replaces the block instead of stacking a second one.
  const again = writeMarkup('png', saved, original, { ...SCENE, shapes: [] })
  assert.equal(new TextDecoder('latin1').decode(again).split('orCA').length, 2)
  assert.deepEqual(readMarkup(again).scene.shapes, [])
})

test('PNG: ignores markup once another tool changed the pixels but kept the block', () => {
  const original = png(4, 3, [10, 20, 30])
  const saved = writeMarkup('png', png(4, 3, [200, 0, 0]), original, SCENE)
  // Splice the block into a PNG with different pixels, as a careless editor might.
  const other = png(4, 3, [0, 0, 255])
  const at = new TextDecoder('latin1').decode(saved).indexOf('orCA') - 4
  const blockLength = new DataView(saved.buffer).getUint32(at) + 12
  const iend = other.length - 12
  const tampered = new Uint8Array([...other.subarray(0, iend), ...saved.subarray(at, at + blockLength), ...other.subarray(iend)])
  assert.equal(readMarkup(tampered), null)
})

test('PNG: rejects truncated and malformed blocks', () => {
  const saved = writeMarkup('png', png(4, 3, [200, 0, 0]), png(4, 3, [1, 2, 3]), SCENE)
  assert.equal(readMarkup(saved.subarray(0, saved.length - 20)), null)
  const at = new TextDecoder('latin1').decode(saved).indexOf('orCA') + 4
  const broken = saved.slice()
  broken[at] = 99 // unknown payload version
  assert.equal(readMarkup(broken), null)
})

test('JPEG: splits large payloads over APP9 segments after APP0, and reads them back', () => {
  // A JPEG original whose scan spans several 64 KiB segments.
  const original = jpeg(Array.from({ length: 200_000 }, (_, i) => (i * 31) & 0x7f))
  const flattened = jpeg()
  const saved = writeMarkup('jpeg', flattened, original, SCENE)
  assert.equal(detectFormat(saved), 'jpeg')
  assert.deepEqual([...saved.subarray(0, 20)], [...flattened.subarray(0, 20)])
  assert.equal(saved[20], 0xff)
  assert.equal(saved[21], 0xe9)
  const markup = readMarkup(saved)
  assert.deepEqual(markup.scene, SCENE)
  assert.ok(sameBytes(markup.original, original))
  // A different scan with the same segments is someone else's image.
  const scanAt = saved.length - 7
  const tampered = saved.slice()
  tampered[scanAt] ^= 0xff
  assert.equal(readMarkup(tampered), null)
  // Saving again replaces the segments.
  const again = writeMarkup('jpeg', saved, original, SCENE)
  assert.ok(sameBytes(readMarkup(again).original, original))
  assert.equal(again.length, saved.length)
})

test('JPEG: a short APP9 segment is malformed data, not a crash', () => {
  // An APP9 whose length (2) ends before the signature that follows it in the file.
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe9, 0, 2, ...new TextEncoder().encode('ORCA-MARKUP\0'), 0xff, 0xda, 0, 3, 0, 1, 0xff, 0xd9])
  assert.doesNotThrow(() => readMarkup(bytes))
  assert.equal(readMarkup(bytes), null)
})

test('ignores an embedded original in another format than the file', () => {
  const saved = writeMarkup('png', png(4, 3, [200, 0, 0]), jpeg(), SCENE)
  assert.equal(readMarkup(saved), null)
})

test('reads image sizes from headers without decoding', () => {
  assert.deepEqual(imageSize(png(17, 9, [0, 0, 0])), [17, 9])
  const sof = [0xff, 0xc0, 0, 17, 8, 0x01, 0x2c, 0x02, 0x58, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  const withSof = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, ...sof, 0xff, 0xda, 0, 3, 0, 0xff, 0xd9])
  assert.deepEqual(imageSize(withSof), [600, 300])
  assert.equal(imageSize(jpeg()), null, 'no SOF before the scan')
  assert.deepEqual(imageSize(Uint8Array.from([...new TextEncoder().encode('GIF89a'), 0x20, 0x03, 0x58, 0x02])), [800, 600])
  const bmp = new Uint8Array(26)
  bmp.set([0x42, 0x4d])
  new DataView(bmp.buffer).setInt32(18, 640, true)
  new DataView(bmp.buffer).setInt32(22, -480, true)
  assert.deepEqual(imageSize(bmp), [640, 480])
  const webp = new Uint8Array(30)
  webp.set(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8X'))
  webp.set([0x1f, 0x03, 0x00, 0x57, 0x02, 0x00], 24)
  assert.deepEqual(imageSize(webp), [800, 600])
})

test('refuses to write formats that cannot hold markup', () => {
  assert.throws(() => writeMarkup('webp', new Uint8Array(8), new Uint8Array(8), SCENE), /cannot save markup/)
})

test('sameBytes compares aligned and unaligned views', () => {
  const a = Uint8Array.from({ length: 103 }, (_, i) => i)
  const b = a.slice()
  assert.ok(sameBytes(a, b))
  b[101] = 0
  assert.ok(!sameBytes(a, b))
  const shifted = new Uint8Array(104)
  shifted.set(a, 1)
  assert.ok(sameBytes(a, shifted.subarray(1)))
  assert.ok(!sameBytes(a, a.subarray(1)))
})
