import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'
import { crc32 } from '../src/container.js'
import { encodePng } from '../src/png.js'

/** Chunks of a PNG as { type, data }, checking every CRC. */
function chunks(png) {
  const buffer = Buffer.from(png)
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const out = []
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.toString('latin1', at + 4, at + 8)
    assert.equal(buffer.readUInt32BE(at + 8 + length), crc32(png, at + 4, at + 8 + length), `${type} CRC`)
    out.push({ type, data: buffer.subarray(at + 8, at + 8 + length) })
    at += 12 + length
  }
  return out
}

/** Decodes an 8-bit RGB or RGBA PNG back to RGBA, undoing every filter type. */
function decode(png) {
  const parts = chunks(png)
  const header = parts.find((part) => part.type === 'IHDR').data
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const channels = header[9] === 2 ? 3 : 4
  const raw = inflateSync(Buffer.concat(parts.filter((part) => part.type === 'IDAT').map((part) => part.data)))
  const stride = width * channels
  const rgba = new Uint8Array(width * height * 4)
  let previous = new Uint8Array(stride)
  const filters = new Set()
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    filters.add(filter)
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0
      const up = previous[i]
      const upLeft = i >= channels ? previous[i - channels] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      row[i] = (line[i] + predictor) & 0xff
    }
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) rgba[(y * width + x) * 4 + c] = c < channels ? row[x * channels + c] : 255
    }
    previous = row
  }
  return { width, height, channels, rgba, filters, idatLength: raw.length }
}

function image(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4)
  }
  return { width, height, data }
}

test('opaque images encode as RGB and decode to the same pixels', async () => {
  // Flat regions, a gradient and noise, so every filter has rows it wins.
  const source = image(97, 61, (x, y) =>
    y < 20 ? [30, 40, 50, 255] : y < 40 ? [x * 2, y * 3, (x + y) & 0xff, 255] : [(x * 7919 + y * 104729) & 0xff, (x * y) & 0xff, 128, 255]
  )
  const decoded = decode(await encodePng(source))
  assert.equal(decoded.channels, 3)
  assert.equal(decoded.width, 97)
  assert.equal(decoded.height, 61)
  assert.deepEqual(decoded.rgba, new Uint8Array(source.data.buffer))
  assert.ok(decoded.filters.size > 1, `adaptive filtering picked ${[...decoded.filters]}`)
})

test('images with any transparency keep their alpha channel', async () => {
  const source = image(16, 9, (x, y) => [x * 16, y * 28, 200, x === 3 && y === 4 ? 0 : 255])
  const decoded = decode(await encodePng(source))
  assert.equal(decoded.channels, 4)
  assert.deepEqual(decoded.rgba, new Uint8Array(source.data.buffer))
})

test('large images stream through in batches', async () => {
  const source = image(1500, 900, (x, y) => [x & 0xff, y & 0xff, ((x >> 4) + (y >> 4)) & 0xff, 255])
  const png = await encodePng(source)
  const decoded = decode(png)
  assert.deepEqual(decoded.rgba, new Uint8Array(source.data.buffer))
  assert.ok(png.length < source.data.length / 20, `${png.length} bytes`)
})
