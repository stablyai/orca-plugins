import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dragHandle,
  hitShape,
  moveShape,
  parseScene,
  serializeScene,
  shapeAt,
  shapeBounds,
  simplifyPoints,
  snapAngle,
  withId
} from '../src/scene.js'
import { fitView, toImage, toStage, zoomAt } from '../src/view.js'

const measure = (shape) => ({ width: shape.text.length * shape.z * 0.5, height: shape.z * 1.25 })

test('hit tests strokes by distance, not by bounding box', () => {
  const box = { t: 'box', c: '#ff0000', s: 4, p: [10, 10, 110, 60] }
  assert.ok(hitShape(box, 10, 30, 2, measure))
  assert.ok(hitShape(box, 60, 61, 2, measure))
  assert.ok(!hitShape(box, 60, 35, 2, measure), 'the inside of a box is not the box')
  const pen = { t: 'pen', c: '#ff0000', s: 2, p: [0, 0, 50, 50, 100, 0] }
  assert.ok(hitShape(pen, 25, 25, 1, measure))
  assert.ok(!hitShape(pen, 50, 10, 1, measure))
  const dot = { t: 'pen', c: '#ff0000', s: 6, p: [5, 5] }
  assert.ok(hitShape(dot, 7, 5, 0, measure))
  const arrow = { t: 'arrow', c: '#ff0000', s: 2, p: [0, 0, 100, 0] }
  assert.ok(hitShape(arrow, 98, 5, 0, measure), 'the head is wider than the shaft')
  const ellipse = { t: 'ellipse', c: '#ff0000', s: 2, p: [0, 0, 100, 50] }
  assert.ok(hitShape(ellipse, 50, 1, 1, measure), 'top of the outline')
  assert.ok(hitShape(ellipse, 100, 25, 1, measure), 'right of the outline')
  assert.ok(!hitShape(ellipse, 50, 25, 1, measure), 'the inside of an ellipse is not the ellipse')
  assert.ok(!hitShape(ellipse, 3, 3, 1, measure), 'nor the corners of its box')
  assert.deepEqual(dragHandle(ellipse, 'se', 80, 90, true).p, [0, 0, 90, 90], 'Shift makes a circle')
  const text = { t: 'text', c: '#ff0000', z: 20, x: 0, y: 0, text: 'hello' }
  assert.ok(hitShape(text, 20, 10, 0, measure))
})

test('shapeAt returns the topmost shape', () => {
  const below = withId({ t: 'box', c: '#ff0000', s: 4, p: [0, 0, 50, 50] })
  const above = withId({ t: 'box', c: '#00ff00', s: 4, p: [0, 0, 50, 50] })
  assert.equal(shapeAt([below, above], 0, 25, 1, measure), above)
  assert.equal(shapeAt([below, above], 25, 25, 1, measure), null)
})

test('bounds cover the stroke and the arrowhead', () => {
  assert.deepEqual(shapeBounds({ t: 'box', s: 4, p: [10, 10, 20, 20] }, measure), [8, 8, 22, 22])
  const [, y0, , y1] = shapeBounds({ t: 'arrow', s: 2, p: [0, 0, 100, 0] }, measure)
  assert.ok(y0 <= -5 && y1 >= 5)
})

test('moves and reshapes immutably; shift snaps arrows to 45° and boxes to squares', () => {
  const box = { id: 1, t: 'box', c: '#ff0000', s: 4, p: [10, 10, 20, 20] }
  const moved = moveShape(box, 5, -5)
  assert.deepEqual(moved.p, [15, 5, 25, 15])
  assert.equal(moved.id, 1)
  assert.deepEqual(box.p, [10, 10, 20, 20])
  assert.deepEqual(dragHandle(box, 'se', 40, 30, true).p, [10, 10, 40, 40])
  assert.deepEqual(dragHandle(box, 'nw', 0, 5, false).p, [20, 20, 0, 5])
  const [x, y] = snapAngle(0, 0, 100, 90)
  assert.ok(Math.abs(x - y) < 1e-9)
  const arrow = { t: 'arrow', c: '#ff0000', s: 2, p: [0, 0, 10, 0] }
  assert.deepEqual(dragHandle(arrow, 'tail', -5, 3, false).p, [-5, 3, 10, 0])
})

test('simplifies dense pen strokes and keeps their ends', () => {
  const points = []
  for (let i = 0; i <= 1000; i++) points.push(i / 10, Math.sin(i / 100) * 0.01)
  const simple = simplifyPoints(points, 0.5)
  assert.ok(simple.length < 10)
  assert.deepEqual(simple.slice(0, 2), points.slice(0, 2))
  assert.deepEqual(simple.slice(-2), points.slice(-2))
  const corner = simplifyPoints([0, 0, 5, 0, 10, 0, 10, 5, 10, 10], 0.5)
  assert.deepEqual(corner, [0, 0, 10, 0, 10, 10])
})

test('serializes without ids and parses back; drops malformed shapes', () => {
  const shapes = [
    withId({ t: 'pen', c: '#ff0000', s: 3.04, p: [1.234, 2.345, 3, 4] }),
    withId({ t: 'text', c: '#0000ff', z: 24, x: 5, y: 6, text: 'Look here' })
  ]
  const json = serializeScene(shapes, 100, 50)
  assert.deepEqual(json.shapes[0], { t: 'pen', c: '#ff0000', s: 3, p: [1.2, 2.3, 3, 4] })
  assert.equal('id' in json.shapes[1], false)
  const parsed = parseScene(JSON.parse(JSON.stringify(json)), 100, 50)
  assert.equal(parsed.length, 2)
  assert.ok(parsed[0].id !== parsed[1].id)
  assert.equal(parseScene(json, 101, 50), null, 'a scene for another size is ignored')
  const hostile = {
    v: 1,
    w: 100,
    h: 50,
    shapes: [
      { t: 'box', c: 'red', s: 2, p: [0, 0, 1, 1] },
      { t: 'box', c: '#ff0000', s: 2, p: [0, 0, 1] },
      { t: 'box', c: '#ff0000', s: -1, p: [0, 0, 1, 1] },
      { t: 'pen', c: '#ff0000', s: 2, p: [0, 'x'] },
      { t: 'arrow', c: '#ff0000', s: 2, p: [0, 0, 1e9, 0] },
      { t: 'text', c: '#ff0000', z: 10, x: 0, y: 0, text: '' },
      { t: 'script', c: '#ff0000' },
      null,
      { t: 'box', c: '#ff0000', s: 2, p: [0, 0, 1, 1], extra: '<img onerror>' }
    ]
  }
  const kept = parseScene(hostile, 100, 50)
  assert.equal(kept.length, 1)
  assert.equal('extra' in kept[0], false)
})

test('fits, zooms around a point, and maps both ways', () => {
  const view = fitView(2000, 1000, 1048, 548)
  assert.equal(view.scale, 0.5)
  assert.deepEqual(toStage(view, 0, 0), [24, 24])
  assert.equal(fitView(100, 100, 1000, 1000).scale, 1, 'never scales small images up')
  const zoomed = zoomAt(view, 2, 300, 200)
  const before = toImage(view, 300, 200)
  const after = toImage(zoomed, 300, 200)
  assert.ok(Math.abs(before[0] - after[0]) < 1e-9 && Math.abs(before[1] - after[1]) < 1e-9)
})
