// The viewer's document session against Orca's real frame session, through `mockEditorHost` from
// orca/testing (vendored in ./orca-testing; see ../README.md).
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mockEditorHost } from './orca-testing/orca-testing.mjs'
import { MAX_DOCUMENT_BYTES, decodeDocument, openDocumentSession } from '../src/document-session.js'

let host
afterEach(() => host?.dispose())

test('decodes byte documents and refuses text and oversized ones', () => {
  const bytes = new ArrayBuffer(8)
  assert.deepEqual(decodeDocument({ kind: 'bytes', bytes }), { bytes: new Uint8Array(bytes) })
  assert.deepEqual(decodeDocument({ kind: 'text', text: 'hello' }), { error: 'unsupported' })
  assert.deepEqual(decodeDocument({ kind: 'bytes', bytes: [] }), { error: 'unsupported' })
  assert.deepEqual(decodeDocument(null), { error: 'unsupported' })
  assert.deepEqual(decodeDocument({ kind: 'bytes', bytes: new ArrayBuffer(MAX_DOCUMENT_BYTES + 1) }), { error: 'too-large' })
})

test('opening and outside changes reach the viewer, and it never sends an edit', async () => {
  host = mockEditorHost({ bytes: new Uint8Array([1, 2, 3]).buffer, readOnly: true })
  const session = await openDocumentSession()
  assert.deepEqual([...session.value.bytes], [1, 2, 3])
  const replaced = []
  session.onReplace((value) => replaced.push([...value.bytes]))
  host.replace(new Uint8Array([4, 5]).buffer)
  await host.flush()
  assert.deepEqual(replaced, [[4, 5]])
  assert.equal(host.edits.length, 0)
})
