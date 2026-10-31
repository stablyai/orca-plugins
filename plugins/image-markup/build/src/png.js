// A PNG encoder for the flattened image. Chromium's canvas encoder favours speed: it always writes
// RGBA and compresses lightly, so a marked-up screenshot came out several times the size of the
// original. This one writes RGB when every pixel is opaque, picks a filter per row (the minimum
// sum of absolute differences heuristic libpng uses; just Up once Orca is waiting on a save), and deflates with the browser's native
// CompressionStream at zlib's default level. Workers are blocked in Orca's frame, so filtering
// runs on the main thread in short slices scheduled in idle time, never inside a busy frame.
// Drawing, panning and zooming stay smooth while a save encodes.
import { crc32 } from './container.js'

/** Work budget when the browser gives no idle deadline (timed-out callbacks, or no idle API). */
const SLICE_MS = 8
// Short, so a page with no idle time still encodes at a fair pace; long while the user is mid-
// gesture, so encoding waits for real idle time instead of costing frames.
const IDLE_TIMEOUT_MS = 24
const BUSY_IDLE_TIMEOUT_MS = 250

/**
 * Resolves with the time (performance.now()) this slice of work should stop by: the end of the
 * browser's idle period, so encoding fills idle time and never runs into a busy frame. When the
 * caller is in a hurry (Orca is waiting to save), there is no slicing at all.
 */
const nextSlice = (urgent, busy) =>
  new Promise((resolve) => {
    if (urgent()) {
      resolve(Infinity)
      return
    }
    if (typeof requestIdleCallback !== 'function') {
      setTimeout(() => resolve(performance.now() + SLICE_MS), 0)
      return
    }
    requestIdleCallback(
      (deadline) => resolve(performance.now() + (deadline.didTimeout ? SLICE_MS : Math.max(1, deadline.timeRemaining()))),
      { timeout: busy() ? BUSY_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS }
    )
  })

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

function isOpaque(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false
  return true
}

/** Packs row `y` of the RGBA pixels into `out` as RGB or RGBA bytes. */
function packRow(rgba, y, width, channels, out) {
  let from = y * width * 4
  if (channels === 4) {
    out.set(rgba.subarray(from, from + width * 4))
    return
  }
  for (let x = 0, to = 0; x < width; x++, from += 4, to += 3) {
    out[to] = rgba[from]
    out[to + 1] = rgba[from + 1]
    out[to + 2] = rgba[from + 2]
  }
}

const abs = (n) => (n < 128 ? n : 256 - n)

/** Writes `row` Up-filtered: one cheap pass, and good for screenshots. Used when Orca is waiting. */
function upFilterRow(row, previous, out) {
  out[0] = 2
  for (let i = 0; i < row.length; i++) out[i + 1] = (row[i] - previous[i]) & 0xff
}

/** Writes the best of None, Sub, Up and Paeth for `row` into `out` (filter byte first). */
function filterRow(row, previous, bpp, out, scratch) {
  const length = row.length
  // None
  let best = 0
  let bestSum = 0
  for (let i = 0; i < length; i++) bestSum += abs(row[i])
  const candidates = [1, 2, 4]
  for (const filter of candidates) {
    let sum = 0
    for (let i = 0; i < length && sum < bestSum; i++) {
      const left = i >= bpp ? row[i - bpp] : 0
      const up = previous[i]
      let predictor
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else {
        const upLeft = i >= bpp ? previous[i - bpp] : 0
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      const value = (row[i] - predictor) & 0xff
      scratch[i] = value
      sum += abs(value)
    }
    if (sum < bestSum) {
      bestSum = sum
      best = filter
      out.set(scratch.subarray(0, length), 1)
    }
  }
  out[0] = best
  if (best === 0) out.set(row, 1)
}

/**
 * Encodes ImageData-like { width, height, data } as PNG bytes. Between slices it polls
 * `urgent()`, after which the rest is encoded without yielding, and `busy()`, which makes it wait
 * longer for idle time.
 */
export async function encodePng({ width, height, data }, { urgent = () => false, busy = () => false } = {}) {
  const channels = isOpaque(data) ? 3 : 4
  const stride = width * channels
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8
  header[9] = channels === 3 ? 2 : 6

  const stream = new CompressionStream('deflate')
  const compressed = new Response(stream.readable).arrayBuffer()
  const writer = stream.writable.getWriter()
  let row = new Uint8Array(stride)
  let previous = new Uint8Array(stride)
  const scratch = new Uint8Array(stride)
  // Small batches keep each step well inside an idle period.
  const rowsPerBatch = Math.max(1, Math.floor((1 << 17) / (stride + 1)))
  let sliceEnd = await nextSlice(urgent, busy)
  for (let y = 0; y < height; y += rowsPerBatch) {
    const rows = Math.min(rowsPerBatch, height - y)
    const batch = new Uint8Array(rows * (stride + 1))
    for (let r = 0; r < rows; r++) {
      packRow(data, y + r, width, channels, row)
      const out = batch.subarray(r * (stride + 1), (r + 1) * (stride + 1))
      if (sliceEnd === Infinity) upFilterRow(row, previous, out)
      else filterRow(row, previous, channels, out, scratch)
      ;[row, previous] = [previous, row]
    }
    writer.write(batch)
    // Backpressure: wait for the compressor before queueing more, so batches don't pile up.
    await writer.ready
    if (performance.now() >= sliceEnd) sliceEnd = urgent() ? Infinity : await nextSlice(urgent, busy)
  }
  writer.close()
  const idat = new Uint8Array(await compressed)

  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0))
  ]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
