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
const rest = () => new Promise((resolve) => setTimeout(resolve, 20))

test('reopens at the kept view, and at the content when none was kept', () => {
  assert.deepEqual(keptView(fakeDocument({ scrollX: -40, scrollY: 12.5, zoom: 1.5 })), appState(-40, 12.5, 1.5))
  assert.equal(keptView(fakeDocument()), null)
  assert.equal(keptView(fakeDocument({ scrollX: 1, scrollY: 2, zoom: 0 })), null)
  assert.equal(keptView(fakeDocument({ scrollX: '1', scrollY: 2, zoom: 1 })), null)
  // An Orca without view state.
  assert.equal(keptView({}), null)
})

test('keeps the view once the canvas rests, and only when it moved', async () => {
  const documentApi = fakeDocument({ scrollX: 0, scrollY: 0, zoom: 1 })
  const keep = viewKeeper(documentApi, 5)
  keep(appState(0, 0, 1))
  await rest()
  assert.deepEqual(documentApi.posted, [])
  keep(appState(10, 0, 1))
  keep(appState(30, 5, 2))
  await rest()
  assert.deepEqual(documentApi.posted, [{ scrollX: 30, scrollY: 5, zoom: 2 }])
})
