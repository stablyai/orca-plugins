import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keptView, viewKeeper } from '../src/view-state.js'

function fakeDocument(initial = null) {
  let state = initial
  const posted = []
  return {
    posted,
    getViewState: () => state,
    setViewState: (next) => {
      state = next
      posted.push(next)
    }
  }
}

const appState = (scrollX, scrollY, zoom) => ({ scrollX, scrollY, zoom: { value: zoom } })

test('reopens at the kept view, and at the content when none was kept', () => {
  assert.deepEqual(keptView(fakeDocument({ scrollX: -40, scrollY: 12.5, zoom: 1.5 })), appState(-40, 12.5, 1.5))
  assert.equal(keptView(fakeDocument()), null)
  assert.equal(keptView(fakeDocument({ scrollX: 1, scrollY: 2, zoom: 0 })), null)
  assert.equal(keptView(fakeDocument({ scrollX: '1', scrollY: 2, zoom: 1 })), null)
  // An Orca without view state.
  assert.equal(keptView({}), null)
})

test('keeps a move at once, then where a continued move stopped; an unmoved canvas posts nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const documentApi = fakeDocument({ scrollX: 0, scrollY: 0, zoom: 1 })
  const keep = viewKeeper(documentApi, 100)
  keep(appState(0, 0, 1))
  assert.deepEqual(documentApi.posted, [])
  // A single zoom is kept before anything could unload the frame.
  keep(appState(0, 0, 2))
  assert.deepEqual(documentApi.posted, [{ scrollX: 0, scrollY: 0, zoom: 2 }])
  keep(appState(10, 0, 2))
  keep(appState(30, 5, 2))
  assert.equal(documentApi.posted.length, 1)
  t.mock.timers.tick(100)
  assert.deepEqual(documentApi.posted.at(-1), { scrollX: 30, scrollY: 5, zoom: 2 })
  // Edits that leave the view alone, after it rested.
  t.mock.timers.tick(100)
  keep(appState(30, 5, 2))
  t.mock.timers.tick(100)
  assert.equal(documentApi.posted.length, 2)
})
