import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { deflateRawSync } from 'node:zlib'
import { checkOfficeZipBudget, OFFICE_ZIP_MAX_ENTRIES, OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES } from '../src/zip-budget.js'
import { readZip, storedZip, writeZip } from '../src/zip-archive.js'

/** A zip holding only a central directory, with the given declared sizes. */
function zipWithEntries(sizes, { comment = 0 } = {}) {
  const entries = sizes.map((size, index) => {
    const name = Buffer.from(`f${index}`)
    const entry = Buffer.alloc(46 + name.length)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt32LE(size, 24)
    entry.writeUInt16LE(name.length, 28)
    name.copy(entry, 46)
    return entry
  })
  const directory = Buffer.concat(entries)
  const end = Buffer.alloc(22 + comment)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(sizes.length, 10)
  end.writeUInt32LE(4, 16)
  end.writeUInt16LE(comment, 20)
  return new Uint8Array(Buffer.concat([Buffer.from('PK\x03\x04'), directory, end]))
}

test('accepts a real workbook', () => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[1, 2]]), 'Sheet1')
  assert.equal(checkOfficeZipBudget(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true })), 'ok')
})

test('sums declared sizes against the budget', () => {
  assert.equal(checkOfficeZipBudget(zipWithEntries([1000, 2000])), 'ok')
  assert.equal(checkOfficeZipBudget(zipWithEntries([OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES])), 'ok')
  assert.equal(checkOfficeZipBudget(zipWithEntries([OFFICE_ZIP_MAX_UNCOMPRESSED_BYTES, 1])), 'too-large')
  assert.equal(checkOfficeZipBudget(zipWithEntries([0xffffffff])), 'too-large')
})

test('refuses too many entries', () => {
  assert.equal(checkOfficeZipBudget(zipWithEntries(new Array(OFFICE_ZIP_MAX_ENTRIES).fill(1))), 'ok')
  assert.equal(checkOfficeZipBudget(zipWithEntries(new Array(OFFICE_ZIP_MAX_ENTRIES + 1).fill(1))), 'too-large')
})

test('finds the end record behind a comment', () => {
  assert.equal(checkOfficeZipBudget(zipWithEntries([10], { comment: 300 })), 'ok')
})

test('calls truncated or malformed directories corrupt', () => {
  assert.equal(checkOfficeZipBudget(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])), 'corrupt')
  const zip = zipWithEntries([10, 10])
  zip[4] = 0
  assert.equal(checkOfficeZipBudget(zip), 'corrupt')
  const short = zipWithEntries([10])
  new DataView(short.buffer).setUint32(short.byteLength - 6, 1_000_000, true)
  assert.equal(checkOfficeZipBudget(short), 'corrupt')
})

/** One deflated entry whose central and local headers both declare a size of 0, as data descriptors do. */
function zeroSizedBomb(inflatedBytes) {
  const name = Buffer.from('xl/worksheets/sheet1.xml')
  const data = deflateRawSync(Buffer.alloc(inflatedBytes, 0x41), { level: 9 })
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt16LE(name.length, 28)
  const directoryOffset = local.length + name.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(directoryOffset, 16)
  return new Uint8Array(Buffer.concat([local, name, data, central, name, end]))
}

test('a declared size that lies is refused before anything grows past it', () => {
  const bomb = zeroSizedBomb(4 * 1024 * 1024)
  assert.equal(checkOfficeZipBudget(bomb), 'ok')
  assert.deepEqual(readZip(bomb), { status: 'corrupt' })
})

test('a real workbook round-trips through the stored copy SheetJS reads', () => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 1]]), 'One')
  const zipped = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }))
  const read = readZip(zipped)
  assert.equal(read.status, 'ok')
  assert.deepEqual(XLSX.read(storedZip(read.entries), { type: 'array' }).SheetNames, ['One'])
  assert.deepEqual(readZip(zipped, 100), { status: 'too-large' })
})

test('rewriting copies untouched entries byte for byte and deflates replaced ones', () => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 1]]), 'One')
  const { entries } = readZip(new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true })))
  const changed = entries.map((entry) => (entry.name === 'docProps/app.xml' ? { ...entry, data: new TextEncoder().encode('<x/>'), raw: null } : entry))
  const reread = readZip(writeZip(changed))
  assert.equal(reread.status, 'ok')
  assert.deepEqual(reread.entries.map((entry) => entry.name), entries.map((entry) => entry.name))
  for (const entry of reread.entries) {
    const before = entries.find((other) => other.name === entry.name)
    if (entry.name === 'docProps/app.xml') assert.equal(new TextDecoder().decode(entry.data), '<x/>')
    else assert.deepEqual(entry.raw, before.raw)
  }
})
