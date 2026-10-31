// Checks the eval-free rewrite of Excalidraw's font subsetter glue (excalidraw-patches.mjs): the
// rewritten subsetter must work with string evaluation disabled, as under the frame CSPs, and give
// the same bytes as the original. Run by build.mjs; also `npm test`.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EVAL_FREE_REWRITES, rewriteEvalFree } from '../excalidraw-patches.mjs'

const DIST = path.join(import.meta.dirname, '..', 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod')
const FONT = path.join(DIST, 'fonts', 'Virgil', 'Virgil-Regular.woff2')
const TEXT = 'Hello Orca, 0123!'
const NO_EVAL = '--disallow-code-generation-from-strings'

/** A copy of the dist's top-level modules, each passed through `transform`. */
function copyDist(transform) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'excalidraw-subset-'))
  for (const file of readdirSync(DIST).filter((name) => name.endsWith('.js'))) {
    writeFileSync(path.join(dir, file), transform(readFileSync(path.join(DIST, file), 'utf8')))
  }
  return dir
}

/** Subsets FONT to TEXT in a separate Node process; returns the subset's bytes. */
function subset(dir, flags = []) {
  // Why the globals: Emscripten's glue sees Node and expects CommonJS's `require` and `__dirname`.
  const script =
    `const { createRequire } = await import('node:module');` +
    `globalThis.require = createRequire(${JSON.stringify(path.join(dir, 'index.js'))});` +
    `globalThis.__dirname = ${JSON.stringify(dir)};` +
    `const { subsetToBinary } = await import(${JSON.stringify(path.join(dir, 'subset-shared.chunk.js'))});` +
    `const { readFileSync } = await import('node:fs');` +
    `const font = readFileSync(${JSON.stringify(FONT)});` +
    `const codePoints = [...${JSON.stringify(TEXT)}].map((char) => char.codePointAt(0));` +
    `const out = await subsetToBinary(font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength), codePoints);` +
    `process.stdout.write(Buffer.from(out).toString('base64'))`
  const output = execFileSync(process.execPath, [...flags, '--input-type=module', '-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return Buffer.from(output, 'base64')
}

const original = copyDist((code) => code)
const applied = new Set()
const rewritten = copyDist((code) => {
  const result = rewriteEvalFree(code)
  result.applied.forEach((index) => applied.add(index))
  return result.code
})
try {
  assert.equal(applied.size, EVAL_FREE_REWRITES.length, 'every eval-free rewrite applies to the dist')
  assert.throws(() => subset(original, [NO_EVAL]), 'the original glue evaluates strings (else this test proves nothing)')
  const expected = subset(original)
  const actual = subset(rewritten, [NO_EVAL])
  assert.ok(actual.length > 0 && actual.length < readFileSync(FONT).length / 2, 'the subset is a small font')
  assert.deepEqual(actual, expected, 'the rewritten glue subsets exactly like the original')
  console.log(`subset-glue: ok (${actual.length}-byte subset of a ${readFileSync(FONT).length}-byte font)`)
} finally {
  rmSync(original, { recursive: true, force: true })
  rmSync(rewritten, { recursive: true, force: true })
}
