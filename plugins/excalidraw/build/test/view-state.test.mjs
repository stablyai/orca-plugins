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

test('the last view before an unload is already kept; an unmoved canvas posts nothing', () => {
  const documentApi = fakeDocument({ scrollX: 0, scrollY: 0, zoom: 1 })
  const keep = viewKeeper(documentApi)
  keep(appState(0, 0, 1))
  assert.deepEqual(documentApi.posted, [])
  keep(appState(10, 0, 1))
  keep(appState(80, 5, 2))
  // Edits that leave the view alone.
  keep(appState(80, 5, 2))
  assert.deepEqual(documentApi.posted, [
    { scrollX: 10, scrollY: 0, zoom: 1 },
    { scrollX: 80, scrollY: 5, zoom: 2 }
  ])
})
