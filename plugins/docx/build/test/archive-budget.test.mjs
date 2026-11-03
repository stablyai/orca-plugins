import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { ArchiveRejectedError, inspectArchive } from '../src/archive-budget.js'

const limits = { maxEntries: 10, maxTotalBytes: 8192, maxMarkupPartBytes: 1024 }
const xml = (size) => strToU8(`<document>${'x'.repeat(size)}</document>`)
const media = (size) => { const bytes = new Uint8Array(size); bytes.set([0x89, 0x50, 0x4e, 0x47]); return bytes }
const inspect = (bytes) => inspectArchive(bytes, { limits })
const rejection = (reason) => (error) => error instanceof ArchiveRejectedError && error.reason === reason

function headers(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.byteLength - 22
  const offsets = []
  let cursor = view.getUint32(end + 16, true)
  while (view.getUint32(cursor, true) === 0x02014b50) {
    offsets.push(cursor)
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true)
  }
  return { view, end, offsets }
}

test('accepts ordinary DOCX parts, including media larger than the markup limit', async () => {
  await inspect(zipSync({ '[Content_Types].xml': xml(100), 'word/document.xml': xml(800), 'word/media/image.png': [media(4000), { level: 0 }] }))
})

test('caps XML by its content even when disguised as media', async () => {
  await assert.rejects(inspect(zipSync({ 'word/media/image.png': xml(4000) })), rejection('too-large'))
})

test('caps the aggregate inflated size', async () => {
  await assert.rejects(inspect(zipSync({ a: media(5000), b: media(5000) })), rejection('too-large'))
})

test('rejects false uncompressed lengths in stored and deflated entries', async () => {
  for (const level of [0, 6]) {
    const bytes = zipSync({ a: [media(5000), { level }] })
    const { view, offsets } = headers(bytes)
    view.setUint32(offsets[0] + 24, 100, true)
    await assert.rejects(inspect(bytes), rejection('unsupported'))
  }
})

test('counts all central headers even when the declared count understates them', async () => {
  const bytes = zipSync(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${i}`, media(8)])))
  const { view, end } = headers(bytes)
  view.setUint16(end + 8, 1, true)
  view.setUint16(end + 10, 1, true)
  await assert.rejects(inspect(bytes), rejection('too-large'))
})

test('rejects prepended bytes instead of checking offsets different from jszip', async () => {
  const bytes = zipSync({ 'word/document.xml': xml(100) })
  const shifted = new Uint8Array(bytes.byteLength + 16)
  shifted.set(bytes, 16)
  await assert.rejects(inspect(shifted), rejection('unsupported'))
})

test('rejects non-zip, truncated, encrypted and ZIP64 documents', async () => {
  await assert.rejects(inspect(strToU8('not a document')), rejection('unsupported'))
  const original = zipSync({ a: media(20) })
  await assert.rejects(inspect(original.subarray(0, original.length - 10)), rejection('unsupported'))
  for (const mutate of [
    ({ view, offsets }) => view.setUint16(offsets[0] + 8, 1, true),
    ({ view, end }) => view.setUint16(end + 10, 0xffff, true)
  ]) {
    const bytes = original.slice()
    mutate(headers(bytes))
    await assert.rejects(inspect(bytes), rejection('unsupported'))
  }
})

test('rejects a forged final directory signature in the zip comment', async () => {
  const bytes = zipSync({ a: media(20) })
  const commented = new Uint8Array(bytes.byteLength + 8)
  commented.set(bytes)
  new DataView(commented.buffer).setUint16(bytes.byteLength - 2, 8, true)
  new DataView(commented.buffer).setUint32(bytes.byteLength, 0x06054b50, true)
  await assert.rejects(inspect(commented), rejection('unsupported'))
})

test('can cancel obsolete documents during archive inspection', async () => {
  await assert.rejects(inspectArchive(zipSync({ a: media(10) }), { cancelled: () => true }), { name: 'AbortError' })
})

test('returns the inflated bytes of the entries it is asked to keep', async () => {
  const kept = await inspectArchive(zipSync({ 'word/settings.xml': xml(200), 'word/document.xml': xml(300) }), { limits, keep: ['word/settings.xml'] })
  assert.deepEqual([...kept.keys()], ['word/settings.xml'])
  assert.deepEqual(kept.get('word/settings.xml'), xml(200))
})
