import assert from 'node:assert/strict'
import { test } from 'node:test'
const strToU8 = (text) => new TextEncoder().encode(text)
import { documentKey, readView, saveView, wordDocumentId } from '../src/view-memory.js'

const memory = () => {
  const items = new Map()
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) }
}
const settings = (body) => strToU8(`<w:settings xmlns:w15="x" xmlns:w14="y">${body}</w:settings>`)

test('knows a document by Word\'s id, else by its bytes', async () => {
  assert.equal(wordDocumentId(settings('<w14:docId w14:val="0A1B2C3D-0000-0000-0000-000000000000"/><w15:docId w15:val="{9E8D7C6B-1111-2222-3333-444455556666}"/>')), 'id:9e8d7c6b-1111-2222-3333-444455556666')
  assert.equal(wordDocumentId(settings('<w14:docId w14:val="0A1B2C3D"/>')), null)
  assert.equal(wordDocumentId(null), null)
  const bytes = strToU8('document bytes')
  assert.match(await documentKey(bytes, null), /^sha256:[0-9a-f]{32}$/)
  assert.equal(await documentKey(bytes, null), await documentKey(strToU8('document bytes'), null))
  assert.notEqual(await documentKey(bytes, null), await documentKey(strToU8('other bytes'), null))
})

test('saves zoom and markup per document, keeping the 200 most recent', () => {
  const storage = memory()
  saveView('a', { zoom: { fit: false, scale: 1.23456 } }, storage)
  saveView('a', { markup: false }, storage)
  saveView('b', { zoom: { fit: true, scale: 0.7 } }, storage)
  assert.deepEqual(readView('a', storage), { zoom: { fit: false, scale: 1.235 }, markup: false })
  assert.deepEqual(readView('b', storage), { zoom: { fit: true } })
  for (let index = 0; index < 200; index++) saveView(`doc-${index}`, { markup: true }, storage)
  assert.deepEqual(readView('a', storage), {})
  assert.deepEqual(readView('doc-0', storage), { markup: true })
})

test('ignores unreadable or missing storage', () => {
  const storage = memory()
  storage.setItem('orca-docx-views', '{not json')
  assert.deepEqual(readView('a', storage), {})
  saveView('a', { markup: true }, storage)
  assert.deepEqual(readView('a', storage), { markup: true })
  assert.deepEqual(readView('a', null), {})
  assert.doesNotThrow(() => saveView('a', { markup: true }, { getItem: () => null, setItem: () => { throw new Error('full') } }))
})
