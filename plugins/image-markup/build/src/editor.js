// Image Markup: a vector annotation layer over an image, in Orca's sandboxed custom-editor frame.
//
// Rendering uses two stage-sized canvases. `base` shows the image and committed shapes, copied
// from a layer drawn once per zoom level, so panning is one copy and a new shape is drawn alone.
// `overlay` holds the shape being drawn or dragged and the selection, so pointer moves repaint
// one shape, not the scene. Both repaint at most once per animation frame. Zoomed far out, a
// large image draws from a downscaled copy.
//
// The file is only written through Orca: edits are debounced, encoded off the main thread, and
// sent as the whole new file (see container.js for the format); Orca saves them on ⌘S.
import { SAVABLE_FORMATS, detectFormat, imageSize, readMarkup, sameBytes, writeMarkup } from './container.js'
import {
  TEXT_LINE_HEIGHT,
  dragHandle,
  isBoxLike,
  moveShape,
  normalizeBox,
  parseScene,
  serializeScene,
  shapeAt,
  shapeBounds,
  shapeHandles,
  simplifyPoints,
  snapAngle,
  snapSquare,
  textHalo,
  withId
} from './scene.js'
import { drawShape, drawShapes, fontFor, haloFor, measureText, renderFlattened } from './render.js'
import { fitView, toImage, toStage, zoomAt } from './view.js'
import { ICONS } from './icons.js'

const EDIT_DEBOUNCE_MS = 700
const HISTORY_LIMIT = 200
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024
const HIT_SLOP = 6 // CSS pixels
const HANDLE_SIZE = 8
const MIPMAP_MIN_PIXELS = 4_000_000
const COMPOSITE_MAX_PIXELS = 16_000_000
const COMPOSITE_SETTLE_MS = 140
// Full-resolution renders need several buffers this size; 64 MP still covers 48 MP phone photos.
const MAX_IMAGE_PIXELS = 64_000_000
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const SAVE_KEY = IS_MAC ? '⌘S' : 'Ctrl+S'
const MOD = IS_MAC ? '⌘' : 'Ctrl+'

const TOOLS = [
  { id: 'select', label: 'Select', key: 'v' },
  { id: 'pen', label: 'Pen', key: 'p' },
  { id: 'arrow', label: 'Arrow', key: 'a' },
  { id: 'box', label: 'Box', key: 'r' },
  { id: 'ellipse', label: 'Ellipse', key: 'o' },
  { id: 'text', label: 'Text', key: 't' }
]
const COLORS = [
  ['#ff3b30', 'Red'],
  ['#ff9500', 'Orange'],
  ['#ffcc00', 'Yellow'],
  ['#34c759', 'Green'],
  ['#0a84ff', 'Blue'],
  ['#bf5af2', 'Purple'],
  ['#1c1c1e', 'Black'],
  ['#ffffff', 'White']
]
const WIDTHS = [
  ['s', 'Thin', 0.5, 5],
  ['m', 'Medium', 1, 7],
  ['l', 'Thick', 2, 11]
]
const FORMAT_NAMES = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF', bmp: 'BMP', avif: 'AVIF' }

const $ = (id) => document.getElementById(id)
const stage = $('stage')
const baseCanvas = $('base')
const overlayCanvas = $('overlay')
const textEditor = $('text-editor')
const baseContext = baseCanvas.getContext('2d', { alpha: false })
const overlayContext = overlayCanvas.getContext('2d')

const s = {
  // Document
  version: null,
  readOnly: true,
  format: null,
  savable: false,
  original: null, // the image's own bytes: the file, or the original kept inside saved markup
  hadMarkup: false,
  lastPosted: null, // bytes Orca holds for `posted`
  // Image
  bitmap: null,
  mips: [],
  width: 0,
  height: 0,
  // Scene
  shapes: [],
  loaded: [], // the scene as the document opened
  posted: [], // the scene Orca last accepted
  past: [],
  future: [],
  selectedId: null,
  // Tools
  tool: 'pen',
  color: COLORS[0][0],
  stroke: 'm',
  // View, in CSS pixels of the stage
  view: { scale: 1, x: 0, y: 0 },
  userZoomed: false,
  stageWidth: 0,
  stageHeight: 0,
  dpr: 1,
  stageColor: '#000',
  selectionColor: '#0a84ff',
  // Interaction
  op: null,
  editing: null,
  space: false,
  // Saving
  timer: undefined,
  committing: null,
  saveError: null,
  flatCache: null
}

// ---- helpers ----

const selected = () => (s.selectedId === null ? null : (s.shapes.find((shape) => shape.id === s.selectedId) ?? null))
/** The base stroke unit for this image: thicker strokes on bigger images, so markup reads at fit. */
const unit = () => Math.max(2, Math.min(s.width, s.height) / 250)
const strokeFor = (width) => Math.max(1.5, unit() * WIDTHS.find(([id]) => id === width)[2])
const fontSizeFor = (width) => Math.max(14, unit() * WIDTHS.find(([id]) => id === width)[3])
const tolerance = () => HIT_SLOP / s.view.scale
const exactBuffer = (bytes) =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer

const bounds = new WeakMap()
function boundsOf(shape) {
  let entry = bounds.get(shape)
  if (!entry) {
    entry = shapeBounds(shape, measureText)
    bounds.set(shape, entry)
  }
  return entry
}

function stagePoint(event) {
  const rect = stage.getBoundingClientRect()
  return [event.clientX - rect.left, event.clientY - rect.top]
}

// ---- rendering ----

let frame = 0
let dirtyBase = false
let dirtyOverlay = false

function requestRender(base = true) {
  dirtyOverlay = true
  if (base) dirtyBase = true
  if (!frame) frame = requestAnimationFrame(paint)
}

function paint() {
  frame = 0
  if (dirtyBase) paintBase()
  if (dirtyOverlay) paintOverlay()
  dirtyBase = false
  dirtyOverlay = false
  if (s.editing) placeTextEditor()
}

const composite = { canvas: null, context: null, k: 0, bitmap: null, shapes: null, hidden: null, settle: undefined }

let checker = null
function checkerPattern() {
  if (!checker) {
    const tile = new OffscreenCanvas(16, 16)
    const ctx = tile.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 16, 16)
    ctx.fillStyle = '#e6e6e6'
    ctx.fillRect(0, 0, 8, 8)
    ctx.fillRect(8, 8, 8, 8)
    checker = baseContext.createPattern(tile, 'repeat')
  }
  return checker
}

function imageTransform(ctx) {
  const k = s.dpr * s.view.scale
  ctx.setTransform(k, 0, 0, k, s.dpr * s.view.x, s.dpr * s.view.y)
  return k
}

/** The bitmap to draw at `k` device pixels per image pixel: a downscaled copy when far out. */
function imageSource(k) {
  if (k >= 0.5 || s.width * s.height < MIPMAP_MIN_PIXELS) return s.bitmap
  for (let level = Math.min(4, Math.floor(Math.log2(1 / k))); level > 0; level--) {
    const mip = s.mips[level]
    if (mip instanceof ImageBitmap) return mip
    if (!mip) buildMip(level)
  }
  return s.bitmap
}

function buildMip(level) {
  const bitmap = s.bitmap
  s.mips[level] = 'pending'
  createImageBitmap(bitmap, {
    resizeWidth: Math.max(1, Math.round(bitmap.width / 2 ** level)),
    resizeHeight: Math.max(1, Math.round(bitmap.height / 2 ** level)),
    resizeQuality: 'high'
  }).then(
    (mip) => {
      if (bitmap !== s.bitmap) return mip.close()
      s.mips[level] = mip
      requestRender()
    },
    () => {}
  )
}

function paintBase() {
  const ctx = baseContext
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = s.stageColor
  ctx.fillRect(0, 0, baseCanvas.width, baseCanvas.height)
  if (!s.bitmap) return
  const k = s.dpr * s.view.scale
  const hidden = s.op?.hides ?? s.editing?.shape ?? null
  const width = Math.ceil(s.width * k)
  const height = Math.ceil(s.height * k)
  if (width * height <= COMPOSITE_MAX_PIXELS) {
    const layer = compositeLayer(k, hidden, width, height)
    // Whole device pixels, so a pan at a settled zoom copies the layer without resampling it.
    ctx.setTransform(1, 0, 0, 1, Math.round(s.dpr * s.view.x), Math.round(s.dpr * s.view.y))
    if (layer.k === k) ctx.drawImage(layer.canvas, 0, 0)
    else {
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(layer.canvas, 0, 0, s.width * k, s.height * k)
    }
    return
  }
  // Zoomed in too far for a whole-image layer: draw directly, which clips to the stage.
  composite.canvas = null
  imageTransform(ctx)
  paintImage(ctx, k)
  const [vx0, vy0] = toImage(s.view, 0, 0)
  const [vx1, vy1] = toImage(s.view, s.stageWidth, s.stageHeight)
  for (const shape of s.shapes) {
    if (shape === hidden) continue
    const [x0, y0, x1, y1] = boundsOf(shape)
    if (x1 < vx0 || y1 < vy0 || x0 > vx1 || y0 > vy1) continue
    drawShape(ctx, shape)
  }
}

function paintImage(ctx, k) {
  if (s.format !== 'jpeg' && s.format !== 'bmp') {
    const pattern = checkerPattern()
    pattern.setTransform(new DOMMatrix().scale(1 / k))
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, s.width, s.height)
  }
  // Why pixelated past 2×: screenshots are inspected at the pixel level, and smoothing blurs them.
  ctx.imageSmoothingEnabled = k < 2
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(imageSource(k), 0, 0, s.width, s.height)
}

/**
 * The image and its committed shapes drawn once at zoom `k`. A pan is then one copy; a new shape
 * is drawn onto it alone; a zoom stretches it until the gesture settles, then redraws it sharp.
 */
function compositeLayer(k, hidden, width, height) {
  const layer = composite
  const current = layer.canvas && layer.bitmap === s.bitmap && layer.shapes === s.shapes && layer.hidden === hidden
  if (current && layer.k !== k) {
    window.clearTimeout(layer.settle)
    layer.settle = window.setTimeout(() => {
      layer.shapes = null
      requestRender()
    }, COMPOSITE_SETTLE_MS)
    return layer
  }
  if (current) return layer
  const appended =
    layer.canvas && layer.bitmap === s.bitmap && layer.k === k && layer.hidden === hidden && isAppended(layer.shapes, s.shapes)
  if (!appended) {
    if (!layer.canvas || layer.canvas.width !== width || layer.canvas.height !== height) {
      layer.canvas = new OffscreenCanvas(width, height)
      layer.context = layer.canvas.getContext('2d')
    }
    layer.context.setTransform(k, 0, 0, k, 0, 0)
    layer.context.clearRect(0, 0, s.width, s.height)
    paintImage(layer.context, k)
  }
  layer.context.setTransform(k, 0, 0, k, 0, 0)
  for (let i = appended ? layer.shapes.length : 0; i < s.shapes.length; i++) {
    if (s.shapes[i] !== hidden) drawShape(layer.context, s.shapes[i])
  }
  Object.assign(layer, { k, bitmap: s.bitmap, shapes: s.shapes, hidden })
  return layer
}

/** Whether `next` is `previous` with shapes added at the end. */
function isAppended(previous, next) {
  if (!previous || next.length <= previous.length) return false
  for (let i = 0; i < previous.length; i++) if (previous[i] !== next[i]) return false
  return true
}

function paintOverlay() {
  const ctx = overlayContext
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
  if (!s.bitmap) return
  const preview = s.op?.preview ?? null
  if (preview) {
    imageTransform(ctx)
    drawShape(ctx, preview)
  }
  const shape = !s.op || s.op.kind === 'pan' ? selected() : s.op.kind === 'draw' ? null : preview
  if (shape) paintSelection(ctx, shape)
}

function paintSelection(ctx, shape) {
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0)
  const [x0, y0, x1, y1] = boundsOf(shape)
  const [sx0, sy0] = toStage(s.view, x0, y0)
  const [sx1, sy1] = toStage(s.view, x1, y1)
  ctx.lineWidth = 1
  ctx.strokeStyle = s.selectionColor
  ctx.setLineDash([4, 3])
  ctx.strokeRect(Math.round(sx0 - 3) + 0.5, Math.round(sy0 - 3) + 0.5, Math.round(sx1 - sx0 + 6), Math.round(sy1 - sy0 + 6))
  ctx.setLineDash([])
  ctx.fillStyle = '#ffffff'
  for (const handle of shapeHandles(shape)) {
    const [hx, hy] = toStage(s.view, handle.x, handle.y)
    const half = HANDLE_SIZE / 2
    ctx.fillRect(Math.round(hx - half) + 0.5, Math.round(hy - half) + 0.5, HANDLE_SIZE, HANDLE_SIZE)
    ctx.strokeRect(Math.round(hx - half) + 0.5, Math.round(hy - half) + 0.5, HANDLE_SIZE, HANDLE_SIZE)
  }
}

function resizeCanvases() {
  const rect = stage.getBoundingClientRect()
  s.dpr = window.devicePixelRatio || 1
  s.stageWidth = rect.width
  s.stageHeight = rect.height
  const width = Math.max(1, Math.round(rect.width * s.dpr))
  const height = Math.max(1, Math.round(rect.height * s.dpr))
  for (const canvas of [baseCanvas, overlayCanvas]) {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
  }
  if (s.bitmap && !s.userZoomed) s.view = fitView(s.width, s.height, s.stageWidth, s.stageHeight)
  // Why synchronous: resizing clears the canvases, and waiting a frame would flash them empty.
  dirtyBase = dirtyOverlay = true
  paint()
  updateZoomLabel()
}

function readStageColor() {
  const style = getComputedStyle(stage)
  s.stageColor = style.backgroundColor || '#000'
  s.selectionColor = style.getPropertyValue('--selection').trim() || '#0a84ff'
  requestRender()
}

// ---- scene changes and history ----

function setShapes(next) {
  s.past.push(s.shapes)
  if (s.past.length > HISTORY_LIMIT) s.past.shift()
  s.future = []
  applyShapes(next)
}

function applyShapes(next) {
  s.shapes = next
  if (s.selectedId !== null && !next.some((shape) => shape.id === s.selectedId)) s.selectedId = null
  requestRender()
  scheduleCommit()
  updateControls()
}

function replaceShape(shape, next) {
  setShapes(s.shapes.map((candidate) => (candidate === shape ? next : candidate)))
}

function undo() {
  if (s.op || !s.past.length) return
  s.future.push(s.shapes)
  applyShapes(s.past.pop())
}

function redo() {
  if (s.op || !s.future.length) return
  s.past.push(s.shapes)
  applyShapes(s.future.pop())
}

function deleteSelection() {
  const shape = selected()
  if (shape) setShapes(s.shapes.filter((candidate) => candidate !== shape))
}

function clearAll() {
  if (s.shapes.length) setShapes([])
}

function select(shape) {
  s.selectedId = shape ? shape.id : null
  requestRender(false)
  updateControls()
}

// ---- saving through Orca ----

const canSave = () => s.bitmap !== null && s.savable && !s.readOnly && s.version !== null

function scheduleCommit() {
  if (!canSave()) return
  window.clearTimeout(s.timer)
  s.timer = window.setTimeout(commit, EDIT_DEBOUNCE_MS)
  updateStatus()
}

/** Sends the latest scene to Orca; resolves once Orca holds it. Orca awaits this before saving. */
function commit() {
  window.clearTimeout(s.timer)
  s.timer = undefined
  if (!s.committing) {
    s.committing = commitLoop().finally(() => {
      s.committing = null
      updateStatus()
    })
  }
  return s.committing
}

async function commitLoop() {
  while (canSave() && s.shapes !== s.posted) {
    const { shapes, version, bitmap } = s
    let bytes
    try {
      bytes = await encodeDocument(shapes)
    } catch (error) {
      s.saveError = `Couldn't encode the markup: ${error?.message ?? error}`
      return
    }
    if (version !== s.version || bitmap !== s.bitmap) return
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      s.saveError = "The image with markup is over Orca's 64 MiB limit, too large to save."
      return
    }
    try {
      await window.orca.document.applyEdit({ baseVersion: version, content: { kind: 'bytes', bytes: exactBuffer(bytes) } })
    } catch (error) {
      // A conflict means the file changed outside Orca's tab; Orca sends the newer document next.
      s.saveError = error?.code === 'conflict' ? null : `Orca didn't take the markup: ${error?.message ?? error}`
      return
    }
    // A newer document arrived while Orca took this edit; it owns the session now.
    if (version !== s.version || bitmap !== s.bitmap) return
    s.posted = shapes
    s.lastPosted = bytes
    s.saveError = null
  }
}

/** The whole file for `shapes`: the original when there is no markup, else flattened plus markup. */
async function encodeDocument(shapes) {
  if (shapes.length === 0) return s.original
  const type = s.format === 'jpeg' ? 'image/jpeg' : 'image/png'
  const flattened = new Uint8Array(await (await flattenedBlob(shapes, type)).arrayBuffer())
  return writeMarkup(s.format, flattened, s.original, serializeScene(shapes, s.width, s.height))
}

/** A full-resolution render of `shapes`; the latest is kept, so Copy after a save reuses it. */
function flattenedBlob(shapes, type = 'image/png') {
  const cache = s.flatCache
  if (cache && cache.shapes === shapes && cache.bitmap === s.bitmap && cache.type === type) return cache.blob
  const blob = renderFlattened(s.bitmap, shapes, type)
  s.flatCache = { shapes, bitmap: s.bitmap, type, blob }
  blob.catch(() => {
    if (s.flatCache?.blob === blob) s.flatCache = null
  })
  return blob
}

// ---- copy ----

/**
 * Whether this frame may put an image on the clipboard. Orca's editor frames don't allow
 * clipboard-write yet; asking anyway only logs a permissions-policy violation. Copy offers no
 * stand-in (an HTML data URL pastes nowhere an agent can read), so until then it points to ⌘S.
 */
const canCopyImage = (() => {
  const policy = document.permissionsPolicy ?? document.featurePolicy
  const allowed = !policy || policy.allowsFeature('clipboard-write')
  return allowed && typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem === 'function'
})()
const COPY_UNAVAILABLE = `This version of Orca doesn't let plugins copy images yet. ${SAVE_KEY} saves the markup into the image instead.`

async function copyImage() {
  if (!s.bitmap) return
  if (!canCopyImage) {
    toast(COPY_UNAVAILABLE, 5000)
    return
  }
  if (s.editing) commitTextEdit()
  try {
    // Why hand write() the pending blob: the clipboard needs the user's click still active.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': flattenedBlob(s.shapes) })])
    toast('Copied the image with its markup')
  } catch (error) {
    toast(`Couldn't copy the image: ${error?.message ?? error}`, 5000)
  }
}

// ---- documents from Orca ----

let loadToken = 0

/** Decodes image bytes, refusing ones whose header claims more than MAX_IMAGE_PIXELS. */
async function decode(bytes) {
  const size = imageSize(bytes)
  if (size && size[0] * size[1] > MAX_IMAGE_PIXELS) {
    const error = new Error('too large')
    error.megapixels = Math.round((size[0] * size[1]) / 1e6)
    throw error
  }
  return createImageBitmap(new Blob([bytes]))
}

/** Drops the image so nothing can be edited or sent while a document can't be shown. */
function unloadImage(message, version) {
  s.bitmap?.close()
  for (const mip of s.mips) if (mip instanceof ImageBitmap) mip.close()
  if (s.editing) cancelTextEdit()
  Object.assign(s, {
    version,
    bitmap: null,
    mips: [],
    shapes: [],
    loaded: [],
    posted: [],
    past: [],
    future: [],
    selectedId: null,
    op: null,
    lastPosted: null,
    flatCache: null
  })
  composite.canvas = null
  showMessage(message)
  requestRender()
  updateControls()
}

async function onDocument(doc) {
  if (!doc || !Number.isSafeInteger(doc.version) || doc.content?.kind !== 'bytes') return
  if (!(doc.content.bytes instanceof ArrayBuffer)) return
  if (s.version !== null && doc.version <= s.version) return
  const bytes = new Uint8Array(doc.content.bytes)
  const readOnly = doc.readOnly === true
  // Orca hands back what this frame sent (after a save, or when the tab remounts the editor);
  // keep the live session, with its undo history and selection.
  if (s.bitmap && s.lastPosted && sameBytes(bytes, s.lastPosted)) {
    s.version = doc.version
    s.readOnly = readOnly
    s.lastPosted = bytes
    // Orca resends the bytes it just saved, so what it holds is now what the file holds.
    if (s.shapes === s.posted) {
      s.loaded = s.posted
      s.hadMarkup = s.posted.length > 0
    }
    updateStatus()
    return
  }
  const token = ++loadToken
  // Unsent strokes were made on the old file; the new one wins, as for any outside change.
  window.clearTimeout(s.timer)
  s.timer = undefined
  const format = detectFormat(bytes)
  let markup = null
  try {
    markup = SAVABLE_FORMATS.has(format) ? readMarkup(bytes, format) : null
  } catch {
    // Malformed markup data: open the file as a plain image.
  }
  let bitmap = null
  let original = bytes
  let shapes = []
  try {
    if (markup) {
      bitmap = await decode(markup.original).catch(() => null)
      shapes = bitmap ? parseScene(markup.scene, bitmap.width, bitmap.height) : null
      if (shapes) original = markup.original.slice()
      else {
        bitmap?.close()
        bitmap = null
        shapes = []
      }
    }
    bitmap ??= await decode(bytes)
  } catch (error) {
    if (token !== loadToken) return
    unloadImage(
      error?.megapixels
        ? `This image is too large to mark up (${error.megapixels} megapixels; the limit is ${MAX_IMAGE_PIXELS / 1e6}). Switch to Orca's viewer in the view toggle.`
        : `Can't display this file as an image${format ? '' : ': the format is not recognized'}.`,
      doc.version
    )
    return
  }
  if (token !== loadToken) return bitmap.close()

  const sameSize = s.bitmap && s.width === bitmap.width && s.height === bitmap.height
  s.bitmap?.close()
  for (const mip of s.mips) if (mip instanceof ImageBitmap) mip.close()
  Object.assign(s, {
    version: doc.version,
    readOnly,
    format,
    savable: SAVABLE_FORMATS.has(format),
    original,
    hadMarkup: shapes.length > 0,
    lastPosted: bytes,
    bitmap,
    mips: [],
    width: bitmap.width,
    height: bitmap.height,
    shapes,
    loaded: shapes,
    posted: shapes,
    past: [],
    future: [],
    selectedId: null,
    op: null,
    saveError: null,
    flatCache: null
  })
  if (s.editing) cancelTextEdit()
  if (!sameSize) {
    s.userZoomed = false
    s.view = fitView(s.width, s.height, s.stageWidth, s.stageHeight)
  }
  showMessage(null)
  requestRender()
  updateControls()
  updateZoomLabel()
}

// ---- pointer interaction ----

function startPan(event, point) {
  s.op = { kind: 'pan', start: point, view: s.view }
  overlayCanvas.style.cursor = 'grabbing'
  overlayCanvas.setPointerCapture(event.pointerId)
}

function onPointerDown(event) {
  if (!s.bitmap || s.op) return
  stage.focus({ preventScroll: true })
  const point = stagePoint(event)
  if (s.editing) {
    commitTextEdit()
    return
  }
  if (event.button === 1 || (event.button === 0 && s.space)) {
    event.preventDefault()
    startPan(event, point)
    return
  }
  if (event.button !== 0) return
  const [x, y] = toImage(s.view, ...point)
  if (s.tool === 'select') {
    const current = selected()
    const handle = current && handleAt(current, point)
    if (handle) {
      s.op = { kind: 'handle', shape: current, handle, hides: current, preview: current }
    } else {
      const hit = shapeAt(s.shapes, x, y, tolerance(), measureText)
      if (!hit) {
        select(null)
        startPan(event, point)
        return
      }
      select(hit)
      s.op = { kind: 'move', shape: hit, start: [x, y], hides: hit, preview: hit, moved: false }
    }
  } else if (s.tool === 'text') {
    const hit = shapeAt(s.shapes, x, y, tolerance(), measureText)
    startTextEdit(hit?.t === 'text' ? hit : null, x, y)
    event.preventDefault()
    return
  } else {
    select(null)
    const base = { t: s.tool, c: s.color, s: strokeFor(s.stroke) }
    s.op = { kind: 'draw', base, start: [x, y], points: [x, y], preview: { ...base, p: s.tool === 'pen' ? [x, y] : [x, y, x, y] } }
  }
  overlayCanvas.setPointerCapture(event.pointerId)
  requestRender(s.op.hides !== undefined)
}

function handleAt(shape, point) {
  for (const handle of shapeHandles(shape)) {
    const [hx, hy] = toStage(s.view, handle.x, handle.y)
    if (Math.abs(hx - point[0]) <= HANDLE_SIZE && Math.abs(hy - point[1]) <= HANDLE_SIZE) return handle.name
  }
  return null
}

function onPointerMove(event) {
  const op = s.op
  if (!op) {
    hoverCursor(event)
    return
  }
  const point = stagePoint(event)
  if (op.kind === 'pan') {
    s.view = { ...op.view, x: op.view.x + point[0] - op.start[0], y: op.view.y + point[1] - op.start[1] }
    s.userZoomed = true
    requestRender()
    return
  }
  const [x, y] = toImage(s.view, ...point)
  if (op.kind === 'move') {
    const dx = x - op.start[0]
    const dy = y - op.start[1]
    op.moved = op.moved || Math.hypot(dx, dy) * s.view.scale > 1
    if (op.moved) op.preview = moveShape(op.shape, dx, dy)
  } else if (op.kind === 'handle') {
    op.preview = dragHandle(op.shape, op.handle, x, y, event.shiftKey)
  } else if (op.base.t === 'pen') {
    // Coalesced events carry every sample the pointer made since the last frame: smoother ink.
    const samples = event.getCoalescedEvents?.() ?? []
    const minStep = 0.35 / s.view.scale
    const points = op.points
    const rect = stage.getBoundingClientRect()
    for (const sample of samples.length ? samples : [event]) {
      const [px, py] = toImage(s.view, sample.clientX - rect.left, sample.clientY - rect.top)
      const lx = points[points.length - 2]
      const ly = points[points.length - 1]
      if (Math.abs(px - lx) + Math.abs(py - ly) >= minStep) points.push(px, py)
    }
    op.preview = { ...op.base, p: points }
  } else {
    const [ox, oy] = op.start
    const end = event.shiftKey ? (op.base.t === 'arrow' ? snapAngle(ox, oy, x, y) : snapSquare(ox, oy, x, y)) : [x, y]
    op.preview = { ...op.base, p: [ox, oy, ...end] }
  }
  requestRender(false)
}

function onPointerUp(event) {
  const op = s.op
  if (!op) return
  s.op = null
  if (overlayCanvas.hasPointerCapture(event.pointerId)) overlayCanvas.releasePointerCapture(event.pointerId)
  if (event.type === 'pointercancel') {
    requestRender()
    hoverCursor(event)
    return
  }
  if (op.kind === 'move' || op.kind === 'handle') {
    if (op.preview !== op.shape && (op.kind === 'handle' || op.moved)) {
      replaceShape(op.shape, op.kind === 'handle' && isBoxLike(op.shape) ? { ...op.preview, p: normalizeBox(op.preview.p) } : op.preview)
    } else requestRender()
  } else if (op.kind === 'draw') {
    const shape = finishDrawing(op)
    if (shape) setShapes([...s.shapes, withId(shape)])
    else requestRender(false)
  } else requestRender()
  hoverCursor(event)
}

function finishDrawing(op) {
  const p = op.preview.p
  const minimum = 3 / s.view.scale
  if (op.base.t === 'pen') {
    return { ...op.base, p: simplifyPoints(p, 0.4 / s.view.scale) }
  }
  if (op.base.t === 'arrow') {
    return Math.hypot(p[2] - p[0], p[3] - p[1]) >= minimum ? op.preview : null
  }
  const box = normalizeBox(p)
  return box[2] - box[0] >= minimum || box[3] - box[1] >= minimum ? { ...op.base, p: box } : null
}

let hoverFrame = 0
let hoverEvent = null
function hoverCursor(event) {
  hoverEvent = event
  if (hoverFrame) return
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0
    overlayCanvas.style.cursor = cursorAt(hoverEvent)
  })
}

function cursorAt(event) {
  if (!s.bitmap) return 'default'
  if (s.op?.kind === 'pan') return 'grabbing'
  if (s.space) return 'grab'
  if (s.tool === 'text') return 'text'
  if (s.tool !== 'select') return 'crosshair'
  const point = stagePoint(event)
  const current = selected()
  const handle = current && handleAt(current, point)
  if (handle) return handle === 'nw' || handle === 'se' ? 'nwse-resize' : handle === 'ne' || handle === 'sw' ? 'nesw-resize' : 'move'
  const [x, y] = toImage(s.view, ...point)
  return shapeAt(s.shapes, x, y, tolerance(), measureText) ? 'move' : 'grab'
}

function onWheel(event) {
  if (!s.bitmap) return
  event.preventDefault()
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? s.stageHeight : 1
  if (event.ctrlKey || event.metaKey) {
    // Trackpad pinches arrive as ctrl+wheel with small deltas; mouse wheels as larger steps.
    const factor = Math.exp(Math.max(-1, Math.min(1, -event.deltaY * scale * 0.01)))
    s.view = zoomAt(s.view, factor, ...stagePoint(event))
    updateZoomLabel()
  } else {
    const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX
    const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY
    s.view = { ...s.view, x: s.view.x - dx * scale, y: s.view.y - dy * scale }
  }
  s.userZoomed = true
  requestRender()
}

function zoomBy(factor) {
  if (!s.bitmap) return
  s.view = zoomAt(s.view, factor, s.stageWidth / 2, s.stageHeight / 2)
  s.userZoomed = true
  requestRender()
  updateZoomLabel()
}

function fit() {
  if (!s.bitmap) return
  s.userZoomed = false
  s.view = fitView(s.width, s.height, s.stageWidth, s.stageHeight)
  requestRender()
  updateZoomLabel()
}

function actualSize() {
  if (!s.bitmap) return
  // 100% means one image pixel per device pixel, the way Orca shows a screenshot at full size.
  s.view = zoomAt(s.view, 1 / s.dpr / s.view.scale, s.stageWidth / 2, s.stageHeight / 2)
  s.userZoomed = true
  requestRender()
  updateZoomLabel()
}

// ---- text ----

function startTextEdit(shape, x, y) {
  select(null)
  const z = shape?.z ?? fontSizeFor(s.stroke)
  s.editing = {
    shape,
    x: shape?.x ?? x,
    y: shape ? shape.y : y - (z * TEXT_LINE_HEIGHT) / 2,
    z,
    c: shape?.c ?? s.color
  }
  textEditor.value = shape?.text ?? ''
  textEditor.hidden = false
  placeTextEditor()
  textEditor.focus({ preventScroll: true })
  textEditor.setSelectionRange(textEditor.value.length, textEditor.value.length)
  requestRender()
}

function placeTextEditor() {
  const { x, y, z, c } = s.editing
  const [left, top] = toStage(s.view, x, y)
  const size = z * s.view.scale
  const style = textEditor.style
  style.transform = `translate(${left}px, ${top}px)`
  style.font = fontFor(size)
  style.lineHeight = String(TEXT_LINE_HEIGHT)
  style.color = c
  style.caretColor = c
  style.webkitTextStroke = `${textHalo({ z }) * 2 * s.view.scale}px ${haloFor(c)}`
}

function commitTextEdit() {
  const editing = s.editing
  if (!editing) return
  const text = textEditor.value.replace(/\s+$/, '')
  closeTextEditor()
  const { shape } = editing
  if (shape) {
    if (!text) setShapes(s.shapes.filter((candidate) => candidate !== shape))
    else if (text !== shape.text) replaceShape(shape, { ...shape, text })
    else requestRender()
  } else if (text) {
    setShapes([...s.shapes, withId({ t: 'text', c: editing.c, z: editing.z, x: editing.x, y: editing.y, text })])
  } else requestRender()
}

function cancelTextEdit() {
  closeTextEditor()
  requestRender()
}

function closeTextEditor() {
  s.editing = null
  textEditor.hidden = true
  textEditor.value = ''
  stage.focus({ preventScroll: true })
}

// ---- tools and styles ----

function setTool(tool) {
  if (s.editing) commitTextEdit()
  s.tool = tool
  if (tool !== 'select') select(null)
  overlayCanvas.style.cursor = tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair'
  updateControls()
}

function setColor(color) {
  s.color = color
  if (s.editing) {
    s.editing.c = color
    placeTextEditor()
  }
  const shape = selected()
  if (shape && shape.c !== color) replaceShape(shape, { ...shape, c: color })
  updateControls()
}

function setWidth(width) {
  s.stroke = width
  if (s.editing) {
    s.editing.z = fontSizeFor(width)
    placeTextEditor()
  }
  const shape = selected()
  if (shape) {
    const next = shape.t === 'text' ? { ...shape, z: fontSizeFor(width) } : { ...shape, s: strokeFor(width) }
    if (next.z !== shape.z || next.s !== shape.s) replaceShape(shape, next)
  }
  updateControls()
}

function nudge(dx, dy) {
  const shape = selected()
  if (shape) replaceShape(shape, moveShape(shape, dx / s.view.scale, dy / s.view.scale))
}

// ---- keyboard ----

function onKeyDown(event) {
  if (s.editing) {
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault()
      commitTextEdit()
    }
    return
  }
  const key = event.key.toLowerCase()
  // Keyboard users press a focused toolbar button with Space or Enter.
  if (event.target instanceof HTMLButtonElement && (key === ' ' || key === 'enter')) return
  if (event.metaKey || event.ctrlKey) {
    if (key === 'z') event.shiftKey ? redo() : undo()
    else if (key === 'y' && !IS_MAC) redo()
    else if (key === 'c' && !event.shiftKey && !event.altKey) copyImage()
    else if (key === '=' || key === '+') zoomBy(1.25)
    else if (key === '-') zoomBy(0.8)
    else if (key === '0') fit()
    else if (key === '1') actualSize()
    else return
    event.preventDefault()
    return
  }
  if (event.altKey) return
  if (key === ' ') {
    if (!s.space) {
      s.space = true
      hoverCursor(event)
    }
  } else if (key === 'delete' || key === 'backspace') deleteSelection()
  else if (key === 'escape') {
    if (s.op) {
      s.op = null
      requestRender()
    } else select(null)
  } else if (key.startsWith('arrow') && selected()) {
    const step = event.shiftKey ? 10 : 1
    nudge(key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0, key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0)
  } else {
    const tool = TOOLS.find((candidate) => candidate.key === key)
    const color = /^[1-8]$/.test(key) ? COLORS[Number(key) - 1] : null
    if (tool) setTool(tool.id)
    else if (color) setColor(color[0])
    else return
  }
  event.preventDefault()
}

// ---- controls ----

function button(className, label, html, onClick, title = label) {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.title = title
  element.setAttribute('aria-label', label)
  element.innerHTML = html
  element.addEventListener('click', onClick)
  // Why: buttons would otherwise keep focus, and Space or Delete would press them, not the canvas.
  element.addEventListener('pointerup', () => stage.focus({ preventScroll: true }))
  return element
}

const controls = {}

function buildToolbar() {
  const tools = $('tools')
  for (const tool of TOOLS) {
    tools.append((controls[tool.id] = button('icon', tool.label, ICONS[tool.id], () => setTool(tool.id), `${tool.label} (${tool.key.toUpperCase()})`)))
  }
  const colors = $('colors')
  COLORS.forEach(([color, name], index) => {
    const swatch = button('swatch', name, '', () => setColor(color), `${name} (${index + 1})`)
    swatch.style.setProperty('--swatch', color)
    swatch.dataset.color = color
    colors.append(swatch)
  })
  const widths = $('widths')
  for (const [id, name] of WIDTHS) {
    const element = button('icon width', `${name} stroke`, `<span class="dot dot-${id}"></span>`, () => setWidth(id))
    element.dataset.width = id
    widths.append(element)
  }
  const history = $('history')
  history.append(
    (controls.undo = button('icon', 'Undo', ICONS.undo, undo, `Undo (${MOD}Z)`)),
    (controls.redo = button('icon', 'Redo', ICONS.redo, redo, `Redo (${IS_MAC ? '⇧⌘Z' : 'Ctrl+Y'})`)),
    (controls.delete = button('icon', 'Delete selected', ICONS.delete, deleteSelection, 'Delete selected (⌫)')),
    (controls.clear = button('icon', 'Clear all markup', ICONS.clear, clearAll))
  )
  const zoom = $('zoom')
  zoom.append(
    button('icon', 'Zoom out', ICONS.zoomOut, () => zoomBy(0.8), `Zoom out (${MOD}−)`),
    (controls.zoom = button('zoom-label', 'Fit to window', '100%', fit, `Fit to window (${MOD}0)`)),
    button('icon', 'Zoom in', ICONS.zoomIn, () => zoomBy(1.25), `Zoom in (${MOD}+)`)
  )
  controls.saveHint = document.createElement('span')
  controls.saveHint.className = 'save-hint'
  controls.saveHint.hidden = true
  controls.saveHint.textContent = `Unsaved · ${SAVE_KEY}`
  controls.saveHint.title = `${SAVE_KEY} saves the markup into this image, so agents and other apps see it`
  $('actions').append(
    controls.saveHint,
    (controls.copy = button(
      'primary',
      'Copy image with markup',
      `${ICONS.copy}<span>Copy</span>`,
      copyImage,
      canCopyImage ? `Copy image with markup (${MOD}C)` : COPY_UNAVAILABLE
    ))
  )
}

function updateControls() {
  for (const tool of TOOLS) controls[tool.id].setAttribute('aria-pressed', String(s.tool === tool.id))
  const shape = selected()
  const color = shape?.c ?? s.editing?.c ?? s.color
  for (const swatch of $('colors').children) swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color))
  for (const element of $('widths').children) element.setAttribute('aria-pressed', String(element.dataset.width === s.stroke))
  controls.undo.disabled = !s.past.length
  controls.redo.disabled = !s.future.length
  controls.delete.disabled = !shape
  controls.clear.disabled = !s.shapes.length
  controls.copy.disabled = !s.bitmap
  // Why not disabled: a disabled button shows no tooltip and ignores clicks, so the reason stays hidden.
  if (!canCopyImage) controls.copy.setAttribute('aria-disabled', 'true')
  updateStatus()
}

function updateZoomLabel() {
  // Percent of device pixels, matching "100%" = 1 image pixel per screen pixel.
  controls.zoom.textContent = `${Math.round(s.view.scale * s.dpr * 100)}%`
}

function updateStatus() {
  if (!s.bitmap) return
  const marks = s.shapes.length
  $('info').textContent =
    `${s.width} × ${s.height} · ${FORMAT_NAMES[s.format] ?? 'Image'}${s.format === 'gif' ? ' · first frame' : ''}` +
    (marks ? ` · ${marks} mark${marks === 1 ? '' : 's'}` : '')
  let status = ''
  let tone = ''
  if (s.saveError) {
    status = s.saveError
    tone = 'error'
  } else if (s.readOnly) status = canCopyImage ? 'Read-only file · Copy to share your markup' : 'Read-only file · markup is not saved'
  else if (!s.savable) status = `${FORMAT_NAMES[s.format] ?? 'This'} files can't keep markup${canCopyImage ? ' · use Copy' : ''}`
  else if (s.shapes !== s.loaded) {
    status = marks
      ? `${SAVE_KEY} saves the markup into this image · the original stays inside, still editable`
      : `${SAVE_KEY} restores the original image`
  } else if (s.hadMarkup) status = 'Saved markup · clear it and save to restore the original'
  controls.saveHint.hidden = !s.savable || s.readOnly || s.shapes === s.loaded
  const element = $('status')
  if (element.textContent !== status) element.textContent = status
  element.dataset.tone = tone
}

let toastTimer
function toast(message, duration = 2500) {
  const element = $('toast')
  element.textContent = message
  element.hidden = false
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (element.hidden = true), duration)
}

function showMessage(message) {
  const element = $('message')
  element.hidden = message === null
  element.textContent = message ?? ''
}

// ---- start ----

buildToolbar()
updateControls()
overlayCanvas.addEventListener('pointerdown', onPointerDown)
overlayCanvas.addEventListener('pointermove', onPointerMove)
overlayCanvas.addEventListener('pointerup', onPointerUp)
overlayCanvas.addEventListener('pointercancel', onPointerUp)
overlayCanvas.addEventListener('dblclick', (event) => {
  if (s.tool !== 'select' || !s.bitmap) return
  const [x, y] = toImage(s.view, ...stagePoint(event))
  const hit = shapeAt(s.shapes, x, y, tolerance(), measureText)
  if (hit?.t === 'text') startTextEdit(hit)
})
stage.addEventListener('wheel', onWheel, { passive: false })
stage.addEventListener('contextmenu', (event) => event.preventDefault())
textEditor.addEventListener('blur', () => commitTextEdit())
window.addEventListener('keydown', onKeyDown)
window.addEventListener('keyup', (event) => {
  if (event.key === ' ') {
    s.space = false
    hoverCursor(event)
  }
})
window.addEventListener('blur', () => (s.space = false))
new ResizeObserver(resizeCanvases).observe(stage)
new MutationObserver(readStageColor).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
readStageColor()
resizeCanvases()
setTool('pen')
stage.focus({ preventScroll: true })

window.orca.document.onDidChange((doc) => {
  onDocument(doc)
})
// Orca waits for the returned promise before it saves.
window.orca.on('editor.flush', () => {
  if (s.editing) commitTextEdit()
  return commit()
})
window.orca.on('theme', readStageColor)
