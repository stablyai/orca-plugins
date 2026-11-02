// The drawing's document sync (src/scene-sync.js) against Orca's real frame session, through
// `mockEditorHost` from orca/testing (vendored in ./orca-testing; see README.md).
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mockEditorHost } from './orca-testing/orca-testing.mjs'
import { decodeScene, mergeScenes, openSceneSession } from '../src/scene-sync.js'

const element = (id, version, versionNonce, extra = {}) => ({ id, type: 'rectangle', version, versionNonce, ...extra })
const scene = (elements, appState = {}, source = 'https://excalidraw.com') =>
  JSON.stringify({ type: 'excalidraw', version: 2, source, elements, appState, files: {} })
// Stands in for Excalidraw's serializeAsJSON: the non-deleted elements and the saved settings.
const serialize = ({ elements, appState, files }) =>
  JSON.stringify({ type: 'excalidraw', version: 2, source: 'local', elements: elements.filter((e) => !e.isDeleted), appState, files })
const saved = (host) => JSON.parse(host.text)
const ids = (text) => JSON.parse(text).elements.map((e) => `${e.id}@${e.version}:${e.versionNonce}`)

let host
afterEach(() => host?.dispose())

test('opening a drawing sends nothing, and an edit keeps the file\'s own source', async () => {
  host = mockEditorHost({ text: scene([element('a', 1, 10)], {}, 'https://example.com/app') })
  const doc = await openSceneSession(serialize)
  assert.deepEqual(doc.value.elements.map((e) => e.id), ['a'])
  await host.flush()
  assert.equal(host.edits.length, 0)
  doc.change({ ...doc.value, elements: [...doc.value.elements, element('b', 1, 20)] })
  await host.flush()
  assert.equal(host.edits.length, 1)
  assert.equal(saved(host).source, 'https://example.com/app')
  assert.deepEqual(ids(host.text), ['a@1:10', 'b@1:20'])
})

test('a background change survives an outside edit that came first (bug 5)', async () => {
  host = mockEditorHost({ text: scene([element('a', 1, 10)], { viewBackgroundColor: '#ffffff', gridSize: 20 }) })
  const doc = await openSceneSession(serialize)
  // An agent adds an element and changes the grid while this canvas changes only the background.
  host.conflictNext(scene([element('a', 1, 10), element('agent', 1, 30)], { viewBackgroundColor: '#ffffff', gridSize: 40 }))
  doc.change({ ...doc.value, appState: { ...doc.value.appState, viewBackgroundColor: '#ffc9c9' } })
  await host.flush()
  assert.deepEqual(saved(host).appState, { viewBackgroundColor: '#ffc9c9', gridSize: 40 })
  assert.deepEqual(ids(host.text), ['a@1:10', 'agent@1:30'])
  assert.deepEqual(host.edits.map((edit) => edit.refused ?? 'ok'), ['conflict', 'ok'])
})

test('two different edits at the same version are not taken as the same (bug 5)', async () => {
  host = mockEditorHost({ text: scene([element('a', 1, 10), element('b', 1, 11)]) })
  const doc = await openSceneSession(serialize)
  // Both sides moved `a` to version 2 with different edits; the outside also edited `b`.
  host.conflictNext(scene([element('a', 2, 99, { x: 500 }), element('b', 2, 12)]))
  doc.change({ ...doc.value, elements: [element('a', 2, 77, { x: 5 }), element('b', 1, 11)] })
  await host.flush()
  const merged = saved(host).elements
  assert.deepEqual(merged.map((e) => [e.id, e.versionNonce]), [['a', 77], ['b', 12]])
})

test('an outside change with nothing unsent replaces the canvas; a conflict resends the merge', async () => {
  host = mockEditorHost({ text: scene([element('a', 1, 10)]) })
  const doc = await openSceneSession(serialize)
  const replaced = []
  doc.onReplace((value) => replaced.push(value.elements.map((e) => e.id)))
  host.replace(scene([element('a', 1, 10), element('c', 1, 40)]))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(replaced, [['a', 'c']])
  // A conflict merges and resends against the newer document, so the save carries both sides.
  host.conflictNext(scene([element('a', 1, 10), element('c', 1, 40), element('d', 1, 50)]))
  doc.change({ ...doc.value, elements: [...doc.value.elements, element('mine', 1, 60)] })
  await host.flush()
  assert.deepEqual(ids(host.text), ['a@1:10', 'c@1:40', 'd@1:50', 'mine@1:60'])
  assert.deepEqual(host.edits.map((edit) => edit.refused ?? 'ok'), ['conflict', 'ok'])
})

test('merging: deletions on either side, canvas settings field by field', () => {
  const base = decodeScene(scene([element('a', 1, 1), element('b', 1, 2), element('c', 1, 3)], { gridModeEnabled: false }))
  const outside = decodeScene(scene([element('a', 1, 1), element('c', 2, 9)], { gridModeEnabled: true }))
  const mine = { ...base, elements: [element('a', 2, 5, { isDeleted: true }), element('b', 1, 2), element('c', 1, 3)] }
  const merged = mergeScenes(base, outside, mine)
  // Mine deleted `a`; the outside deleted `b` (unchanged here) and edited `c` (unchanged here).
  assert.deepEqual(merged.elements.map((e) => `${e.id}:${e.versionNonce}`), ['c:9'])
  assert.deepEqual(merged.appState, { gridModeEnabled: true })
})

test('a file that is no drawing decodes to an error, and merging keeps the outside file', () => {
  const broken = decodeScene('{"type":"other"}')
  assert.match(broken.error, /not an Excalidraw scene/)
  const fine = decodeScene(scene([]))
  assert.equal(mergeScenes(fine, broken, fine), broken)
})
