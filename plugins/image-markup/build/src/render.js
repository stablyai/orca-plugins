// Draws shapes onto a 2D context already transformed to image pixels. Paths and text metrics are
// cached per shape object; shapes are immutable, so a cached entry never goes stale.
import { encodePng } from './png.js'
import { MARKER_ALPHA, TEXT_LINE_HEIGHT, arrowHead, textHalo } from './scene.js'

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
export const fontFor = (size) => `600 ${size}px ${FONT_FAMILY}`

const paths = new WeakMap()
const metrics = new WeakMap()
const measureContext = new OffscreenCanvas(1, 1).getContext('2d')

/** { width, height, lines } of a text shape at its font size. */
export function measureText(shape) {
  let entry = metrics.get(shape)
  if (!entry) {
    measureContext.font = fontFor(shape.z)
    const lines = shape.text.split('\n')
    let width = 0
    for (const line of lines) width = Math.max(width, measureContext.measureText(line).width)
    entry = { width: Math.max(width, shape.z * 0.3), height: lines.length * shape.z * TEXT_LINE_HEIGHT, lines }
    metrics.set(shape, entry)
  }
  return entry
}

function penPath(p) {
  const path = new Path2D()
  path.moveTo(p[0], p[1])
  const count = p.length / 2
  if (count === 2) {
    path.lineTo(p[2], p[3])
    return path
  }
  // Quadratic segments through each point's midpoints: smooth, and still exact at both ends.
  for (let i = 1; i < count - 1; i++) {
    const x = p[i * 2]
    const y = p[i * 2 + 1]
    path.quadraticCurveTo(x, y, (x + p[i * 2 + 2]) / 2, (y + p[i * 2 + 3]) / 2)
  }
  path.lineTo(p[p.length - 2], p[p.length - 1])
  return path
}

function arrowPaths(shape) {
  const [x1, y1, x2, y2] = shape.p
  const length = Math.hypot(x2 - x1, y2 - y1) || 1
  const ux = (x2 - x1) / length
  const uy = (y2 - y1) / length
  const head = arrowHead(shape.s)
  // A short arrow gets a proportionally smaller head instead of one longer than the arrow.
  const headLength = Math.min(head.length, length * 0.6)
  const half = head.half * (headLength / head.length)
  const bx = x2 - ux * headLength
  const by = y2 - uy * headLength
  const shaft = new Path2D()
  shaft.moveTo(x1, y1)
  // Why stop inside the head: a thick round-capped shaft would poke past the tip.
  shaft.lineTo(x2 - ux * headLength * 0.7, y2 - uy * headLength * 0.7)
  const tip = new Path2D()
  tip.moveTo(x2, y2)
  tip.lineTo(bx - uy * half, by + ux * half)
  tip.lineTo(bx + uy * half, by - ux * half)
  tip.closePath()
  return { shaft, tip }
}

function pathFor(shape) {
  let path = paths.get(shape)
  if (!path) {
    if (shape.t === 'pen' || shape.t === 'marker') path = penPath(shape.p)
    else if (shape.t === 'arrow') path = arrowPaths(shape)
    else if (shape.t === 'ellipse') {
      const [x0, y0, x1, y1] = shape.p
      path = new Path2D()
      path.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2)
    } else {
      const [x0, y0, x1, y1] = shape.p
      path = new Path2D()
      path.roundRect(x0, y0, x1 - x0, y1 - y0, Math.min(shape.s, (x1 - x0) / 2, (y1 - y0) / 2))
    }
    paths.set(shape, path)
  }
  return path
}

/** Black or white, whichever outlines the colour more legibly. */
export function haloFor(color) {
  const n = parseInt(color.slice(1), 16)
  const luminance = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff)
  return luminance > 150 ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.92)'
}

const STEP_FONT = (size) => `700 ${size}px ${FONT_FAMILY}`

function drawStep(ctx, shape) {
  const r = shape.z / 2
  const halo = haloFor(shape.c)
  ctx.beginPath()
  ctx.arc(shape.x, shape.y, r, 0, Math.PI * 2)
  ctx.fillStyle = shape.c
  ctx.fill()
  ctx.lineWidth = Math.max(1, shape.z * 0.08)
  ctx.strokeStyle = halo
  ctx.stroke()
  const label = String(shape.n)
  ctx.font = STEP_FONT(shape.z * (label.length > 2 ? 0.42 : label.length > 1 ? 0.5 : 0.6))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // The number takes the halo's tone, fully opaque, so it reads on its own disc.
  ctx.fillStyle = halo.startsWith('rgba(0') ? '#000000' : '#ffffff'
  ctx.fillText(label, shape.x, shape.y + shape.z * 0.03)
}

const fills = new WeakMap()

/** A redaction's colour: the mean of the image under it, so the patch blends in but holds nothing. */
function fillFor(shape, source) {
  const cached = fills.get(shape)
  if (cached?.source === source) return cached
  const [x0, y0, x1, y1] = redactRect(shape, source)
  const entry = { source, x0, y0, width: x1 - x0, height: y1 - y0, color: '#808080', hatch: 'rgba(0,0,0,0.18)' }
  if (entry.width > 0 && entry.height > 0) {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, x0, y0, entry.width, entry.height, 0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    entry.color = `rgb(${r},${g},${b})`
    entry.hatch = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.22)'
  }
  fills.set(shape, entry)
  return entry
}

/** A redaction's area in whole image pixels, clipped to the image. */
function redactRect(shape, source) {
  return [
    Math.max(0, Math.floor(Math.min(shape.p[0], shape.p[2]))),
    Math.max(0, Math.floor(Math.min(shape.p[1], shape.p[3]))),
    Math.min(source.width, Math.ceil(Math.max(shape.p[0], shape.p[2]))),
    Math.min(source.height, Math.ceil(Math.max(shape.p[1], shape.p[3])))
  ]
}

// Why a flat fill and not a mosaic or blur: those keep a signal that can be matched back to text.
function drawRedaction(ctx, shape, source) {
  if (!source) return
  const { x0, y0, width, height, color, hatch } = fillFor(shape, source)
  if (width <= 0 || height <= 0) return
  ctx.save()
  ctx.fillStyle = color
  ctx.fillRect(x0, y0, width, height)
  // Diagonal hatching marks the patch as redacted rather than empty.
  ctx.beginPath()
  ctx.rect(x0, y0, width, height)
  ctx.clip()
  const step = Math.max(8, Math.min(source.width, source.height) / 60)
  ctx.strokeStyle = hatch
  ctx.lineWidth = step / 4
  ctx.beginPath()
  for (let d = -height; d < width; d += step) {
    ctx.moveTo(x0 + d, y0 + height)
    ctx.lineTo(x0 + d + height, y0)
  }
  ctx.stroke()
  ctx.restore()
}

/** Draws one shape; `source` is the image bitmap, whose mean colour a redaction takes. */
export function drawShape(ctx, shape, source) {
  if (shape.t === 'redact') return drawRedaction(ctx, shape, source)
  if (shape.t === 'step') return drawStep(ctx, shape)
  ctx.fillStyle = shape.c
  ctx.strokeStyle = shape.c
  if (shape.t === 'text') {
    const { lines } = measureText(shape)
    ctx.font = fontFor(shape.z)
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.lineJoin = 'round'
    ctx.lineWidth = textHalo(shape) * 2
    ctx.strokeStyle = haloFor(shape.c)
    const step = shape.z * TEXT_LINE_HEIGHT
    for (let i = 0; i < lines.length; i++) {
      const y = shape.y + step * (i + 0.5)
      ctx.strokeText(lines[i], shape.x, y)
      ctx.fillText(lines[i], shape.x, y)
    }
    return
  }
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = shape.s
  if (shape.t === 'pen' && shape.p.length === 2) {
    ctx.beginPath()
    ctx.arc(shape.p[0], shape.p[1], shape.s / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  const path = pathFor(shape)
  if (shape.t === 'marker') {
    ctx.globalAlpha = MARKER_ALPHA
    ctx.stroke(path)
    ctx.globalAlpha = 1
    return
  }
  if (shape.t === 'arrow') {
    ctx.stroke(path.shaft)
    ctx.lineWidth = Math.max(1, shape.s * 0.5)
    ctx.fill(path.tip)
    ctx.stroke(path.tip)
    return
  }
  ctx.stroke(path)
}

/**
 * Draws a pen stroke still being drawn from segment `from` on, and returns where to continue.
 * Segment i is the curve penPath draws through point i, so a stroke drawn piece by piece looks
 * the same as one drawn whole, and each pointer move costs its new points, not the whole stroke.
 * The last half-segment waits for the next point (penPath's straight tail is drawn on commit).
 */
export function penSegments(ctx, style, p, from) {
  const count = p.length / 2
  ctx.strokeStyle = style.c
  ctx.fillStyle = style.c
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = style.s
  if (from === 0) {
    ctx.beginPath()
    ctx.arc(p[0], p[1], style.s / 2, 0, Math.PI * 2)
    ctx.fill()
    from = 1
  }
  if (count < 3 || from > count - 2) return from
  ctx.beginPath()
  const startX = from === 1 ? p[0] : (p[from * 2 - 2] + p[from * 2]) / 2
  const startY = from === 1 ? p[1] : (p[from * 2 - 1] + p[from * 2 + 1]) / 2
  ctx.moveTo(startX, startY)
  for (let i = from; i < count - 1; i++) {
    const x = p[i * 2]
    const y = p[i * 2 + 1]
    ctx.quadraticCurveTo(x, y, (x + p[i * 2 + 2]) / 2, (y + p[i * 2 + 3]) / 2)
  }
  ctx.stroke()
  return count - 1
}

export function drawShapes(ctx, shapes, source) {
  for (const shape of shapes) drawShape(ctx, shape, source)
}

/**
 * The image with its markup at full resolution, as a Blob of `type` ('image/png' or 'image/jpeg').
 * PNG goes through encodePng, which compresses far better than the canvas encoder; JPEG uses the
 * canvas encoder, which runs off the main thread.
 */
export async function renderFlattened(bitmap, shapes, type, options) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const png = type === 'image/png'
  const ctx = canvas.getContext('2d', { alpha: png, willReadFrequently: png })
  if (!png) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, bitmap.width, bitmap.height)
  }
  ctx.drawImage(bitmap, 0, 0)
  drawShapes(ctx, shapes, bitmap)
  if (!png) return canvas.convertToBlob({ type, quality: 0.92 })
  return new Blob([await encodePng(ctx.getImageData(0, 0, bitmap.width, bitmap.height), options)], { type })
}
