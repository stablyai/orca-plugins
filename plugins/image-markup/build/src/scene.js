// The markup model: plain, immutable shape objects in image pixels. Every change makes a new
// shapes array, so history entries and the "already saved" baseline are cheap reference checks.
//
//   pen   { t: 'pen',   c, s, p: [x0, y0, x1, y1, ...] }
//   arrow { t: 'arrow', c, s, p: [x1, y1, x2, y2] }        tail to head
//   box   { t: 'box',   c, s, p: [x1, y1, x2, y2] }        min corner, max corner
//   ellipse { t: 'ellipse', c, s, p: [x1, y1, x2, y2] }    the box it fills
//   text  { t: 'text',  c, z, x, y, text }                  z is the font size, (x, y) its top left
//
// `c` is a #rrggbb colour and `s` a stroke width. In memory each shape also has a numeric `id`.

export const SCENE_VERSION = 1
const MAX_SHAPES = 5000
const MAX_POINTS = 200000
const MAX_TEXT = 4000
const TYPES = new Set(['pen', 'arrow', 'box', 'ellipse', 'text'])
/** Shapes defined by two corners, which share handles and normalizing. */
export const isBoxLike = (shape) => shape.t === 'box' || shape.t === 'ellipse'

let nextId = 1
export const withId = (shape) => ({ ...shape, id: nextId++ })

/** Font metrics shared by drawing, hit tests and the text editor. */
export const TEXT_LINE_HEIGHT = 1.25
export const textHalo = (shape) => Math.max(1, shape.z * 0.14)

/** Arrowhead length and half-width for a stroke width. */
export function arrowHead(s) {
  const length = Math.max(10, s * 4.2)
  return { length, half: length * 0.55 }
}

/**
 * Bounds as [x0, y0, x1, y1], covering the stroke. `measure(shape)` returns a text shape's
 * { width, height } at its font size.
 */
export function shapeBounds(shape, measure) {
  if (shape.t === 'text') {
    const { width, height } = measure(shape)
    const halo = textHalo(shape)
    return [shape.x - halo, shape.y - halo, shape.x + width + halo, shape.y + height + halo]
  }
  const p = shape.p
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i]
    if (p[i] > x1) x1 = p[i]
    if (p[i + 1] < y0) y0 = p[i + 1]
    if (p[i + 1] > y1) y1 = p[i + 1]
  }
  const pad = shape.t === 'arrow' ? Math.max(shape.s / 2, arrowHead(shape.s).half) : shape.s / 2
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad]
}

function segmentDistanceSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = ax + t * dx - px
  const ey = ay + t * dy - py
  return ex * ex + ey * ey
}

/** Whether image point (x, y) touches the shape, `tolerance` image pixels beyond its stroke. */
export function hitShape(shape, x, y, tolerance, measure) {
  const [x0, y0, x1, y1] = shapeBounds(shape, measure)
  if (x < x0 - tolerance || x > x1 + tolerance || y < y0 - tolerance || y > y1 + tolerance) return false
  if (shape.t === 'text') return true
  const reach = shape.s / 2 + tolerance
  const reachSq = reach * reach
  const p = shape.p
  if (shape.t === 'box') {
    const [ax, ay, bx, by] = p
    return (
      segmentDistanceSq(x, y, ax, ay, bx, ay) <= reachSq ||
      segmentDistanceSq(x, y, bx, ay, bx, by) <= reachSq ||
      segmentDistanceSq(x, y, bx, by, ax, by) <= reachSq ||
      segmentDistanceSq(x, y, ax, by, ax, ay) <= reachSq
    )
  }
  if (shape.t === 'ellipse') {
    const cx = (p[0] + p[2]) / 2
    const cy = (p[1] + p[3]) / 2
    const rx = Math.max(Math.abs(p[2] - p[0]) / 2, 1e-6)
    const ry = Math.max(Math.abs(p[3] - p[1]) / 2, 1e-6)
    const dx = x - cx
    const dy = y - cy
    const radius = Math.hypot(dx / rx, dy / ry)
    // Distance to the outline along the ray from the centre: exact for circles, close otherwise.
    const distance = radius === 0 ? Math.min(rx, ry) : (Math.abs(radius - 1) * Math.hypot(dx, dy)) / radius
    return distance <= reach
  }
  if (shape.t === 'arrow') {
    const headReach = Math.max(reach, arrowHead(shape.s).half + tolerance)
    const hx = x - p[2]
    const hy = y - p[3]
    if (hx * hx + hy * hy <= headReach * headReach) return true
  }
  if (p.length === 2) return (x - p[0]) ** 2 + (y - p[1]) ** 2 <= reachSq
  for (let i = 2; i < p.length; i += 2) {
    if (segmentDistanceSq(x, y, p[i - 2], p[i - 1], p[i], p[i + 1]) <= reachSq) return true
  }
  return false
}

/** The topmost shape under (x, y), or null. */
export function shapeAt(shapes, x, y, tolerance, measure) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitShape(shapes[i], x, y, tolerance, measure)) return shapes[i]
  }
  return null
}

export function moveShape(shape, dx, dy) {
  if (shape.t === 'text') return { ...shape, x: shape.x + dx, y: shape.y + dy }
  const p = new Array(shape.p.length)
  for (let i = 0; i < p.length; i += 2) {
    p[i] = shape.p[i] + dx
    p[i + 1] = shape.p[i + 1] + dy
  }
  return { ...shape, p }
}

/** Drag handles in image pixels: arrow ends, and box and ellipse corners. */
export function shapeHandles(shape) {
  const p = shape.p
  if (shape.t === 'arrow') return [{ name: 'tail', x: p[0], y: p[1] }, { name: 'head', x: p[2], y: p[3] }]
  if (isBoxLike(shape)) {
    return [
      { name: 'nw', x: p[0], y: p[1] },
      { name: 'ne', x: p[2], y: p[1] },
      { name: 'sw', x: p[0], y: p[3] },
      { name: 'se', x: p[2], y: p[3] }
    ]
  }
  return []
}

/** Snaps (x, y) to the nearest 45° ray from (ox, oy). */
export function snapAngle(ox, oy, x, y) {
  const dx = x - ox
  const dy = y - oy
  const length = Math.hypot(dx, dy)
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  return [ox + Math.cos(angle) * length, oy + Math.sin(angle) * length]
}

/** Makes (x, y) the corner of a square on (ox, oy). */
export function snapSquare(ox, oy, x, y) {
  const size = Math.max(Math.abs(x - ox), Math.abs(y - oy))
  return [ox + Math.sign(x - ox || 1) * size, oy + Math.sign(y - oy || 1) * size]
}

export function normalizeBox(p) {
  return [Math.min(p[0], p[2]), Math.min(p[1], p[3]), Math.max(p[0], p[2]), Math.max(p[1], p[3])]
}

/** Moves one handle to (x, y); `constrain` snaps arrows to 45°, boxes to squares, ellipses to circles. */
export function dragHandle(shape, handle, x, y, constrain) {
  const p = shape.p
  if (shape.t === 'arrow') {
    const [ox, oy] = handle === 'head' ? [p[0], p[1]] : [p[2], p[3]]
    const [nx, ny] = constrain ? snapAngle(ox, oy, x, y) : [x, y]
    return { ...shape, p: handle === 'head' ? [p[0], p[1], nx, ny] : [nx, ny, p[2], p[3]] }
  }
  if (isBoxLike(shape)) {
    const ox = handle === 'nw' || handle === 'sw' ? p[2] : p[0]
    const oy = handle === 'nw' || handle === 'ne' ? p[3] : p[1]
    const [nx, ny] = constrain ? snapSquare(ox, oy, x, y) : [x, y]
    return { ...shape, p: [ox, oy, nx, ny] }
  }
  return shape
}

/** Ramer–Douglas–Peucker on a flat [x, y, ...] list; keeps the ends. Iterative, so long strokes can't overflow. */
export function simplifyPoints(p, tolerance) {
  const count = p.length / 2
  if (count <= 2) return p.slice()
  const keep = new Uint8Array(count)
  keep[0] = 1
  keep[count - 1] = 1
  const toleranceSq = tolerance * tolerance
  const stack = [0, count - 1]
  while (stack.length) {
    const last = stack.pop()
    const first = stack.pop()
    let worst = -1
    let worstSq = toleranceSq
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistanceSq(p[i * 2], p[i * 2 + 1], p[first * 2], p[first * 2 + 1], p[last * 2], p[last * 2 + 1])
      if (d > worstSq) {
        worstSq = d
        worst = i
      }
    }
    if (worst !== -1) {
      keep[worst] = 1
      stack.push(first, worst, worst, last)
    }
  }
  const out = []
  for (let i = 0; i < count; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1])
  return out
}

const round1 = (n) => Math.round(n * 10) / 10

/** The JSON stored in the file. Ids are dropped; coordinates keep a tenth of a pixel. */
export function serializeScene(shapes, width, height) {
  return {
    v: SCENE_VERSION,
    w: width,
    h: height,
    shapes: shapes.map(({ id, ...shape }) =>
      shape.t === 'text'
        ? { ...shape, x: round1(shape.x), y: round1(shape.y), z: round1(shape.z) }
        : { ...shape, s: round1(shape.s), p: shape.p.map(round1) }
    )
  }
}

const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)
const isSize = (n, max) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max
const isCoordinate = (n, limit) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit

/**
 * Shapes from stored JSON, with ids; drops anything malformed. Returns null when the scene is not
 * for an image of this size (the file was resized elsewhere), so the caller can ignore it.
 */
export function parseScene(raw, width, height) {
  if (!raw || raw.v !== SCENE_VERSION || raw.w !== width || raw.h !== height || !Array.isArray(raw.shapes)) {
    return null
  }
  const limit = Math.max(width, height) * 4
  const maxStroke = Math.max(width, height)
  let points = 0
  const shapes = []
  for (const shape of raw.shapes.slice(0, MAX_SHAPES)) {
    if (!shape || !TYPES.has(shape.t) || !isColor(shape.c)) continue
    if (shape.t === 'text') {
      if (typeof shape.text !== 'string' || !shape.text || !isSize(shape.z, maxStroke)) continue
      if (!isCoordinate(shape.x, limit) || !isCoordinate(shape.y, limit)) continue
      shapes.push(withId({ t: 'text', c: shape.c, z: shape.z, x: shape.x, y: shape.y, text: shape.text.slice(0, MAX_TEXT) }))
      continue
    }
    const p = shape.p
    if (!isSize(shape.s, maxStroke) || !Array.isArray(p) || p.length < 2 || p.length % 2 !== 0) continue
    if (shape.t !== 'pen' && p.length !== 4) continue
    if (!p.every((n) => isCoordinate(n, limit))) continue
    points += p.length / 2
    if (points > MAX_POINTS) break
    shapes.push(withId({ t: shape.t, c: shape.c, s: shape.s, p: p.slice() }))
  }
  return shapes
}
