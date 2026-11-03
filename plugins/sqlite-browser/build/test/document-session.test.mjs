// The database's document sync (src/document-session.js) against Orca's real frame session, through
// `mockEditorHost` from orca/testing (vendored in ./orca-testing; see README.md).
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mockEditorHost } from './orca-testing/orca-testing.mjs'
import { decodeDatabase, openDatabaseSession } from '../src/document-session.js'

const file = (...bytes) => new Uint8Array(bytes)
const bytesOf = (value) => [...new Uint8Array(value.bytes)]

let host
afterEach(() => host?.dispose())

test('the session hands over the file as bytes and never edits it', async () => {
  host = mockEditorHost({ bytes: file(1, 2, 3) })
  const doc = await openDatabaseSession()
  assert.deepEqual(bytesOf(doc.value), [1, 2, 3])
  await host.flush()
  assert.equal(host.edits.length, 0)
  assert.deepEqual([...host.bytes], [1, 2, 3])
})

test('an outside write (an app changing the database) reaches the editor', async () => {
  host = mockEditorHost({ bytes: file(1, 2, 3) })
  const doc = await openDatabaseSession()
  const replaced = []
  doc.onReplace((value) => replaced.push(bytesOf(value)))
  host.replace(file(4, 5))
  await host.flush()
  assert.deepEqual(replaced, [[4, 5]])
  assert.deepEqual(bytesOf(doc.value), [4, 5])
  assert.equal(host.edits.length, 0)
})

test('a read-only tab opens the same way', async () => {
  host = mockEditorHost({ bytes: file(9) }, { readOnly: true, fileType: 'db' })
  const doc = await openDatabaseSession()
  assert.equal(doc.readOnly, true)
  assert.deepEqual(bytesOf(doc.value), [9])
})

test('a text document is refused with a reason', () => {
  assert.match(decodeDatabase({ kind: 'text', text: 'SQLite format 3' }).error, /raw bytes/)
})
