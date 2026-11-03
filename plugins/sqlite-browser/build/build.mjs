// Builds ../editor (see README.md):
//   index.html                  the page, with its stylesheet inline;
//   assets/editor-<hash>.js     the page's code;
//   assets/sqlite-worker-<hash>.js  the worker that owns the database;
//   assets/sql-wasm.wasm        SQLite compiled to WebAssembly.
// Also writes ../THIRD_PARTY_NOTICES.txt, then runs the tests in test/.
// Usage: npm ci --ignore-scripts && node build.mjs
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const HERE = import.meta.dirname
const PLUGIN = path.resolve(HERE, '..')
const EDITOR = path.join(PLUGIN, 'editor')
const NOTICES = path.join(PLUGIN, 'THIRD_PARTY_NOTICES.txt')
const SQLJS = path.join(HERE, 'node_modules', 'sql.js')
// Why: the catalog refuses any plugin file over 1 MiB.
const MAX_FILE_BYTES = 1024 * 1024

const COMMON = {
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  absWorkingDir: HERE,
  outdir: path.join(EDITOR, 'assets'),
  entryNames: '[name]-[hash]',
  // The browser build of the WebAssembly SQLite still names Node modules it never loads there.
  external: ['fs', 'path', 'crypto']
}

const worker = await build({ ...COMMON, entryPoints: { 'sqlite-worker': path.join(HERE, 'src', 'sqlite-worker.js') } })
const workerFile = path.basename(worker.outputFiles[0].path)
const page = await build({
  ...COMMON,
  entryPoints: { editor: path.join(HERE, 'src', 'main.js') },
  define: { WORKER_FILE: JSON.stringify(workerFile) }
})
const pageFile = path.basename(page.outputFiles[0].path)

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>SQLite Browser</title>
<style>
${readFileSync(path.join(HERE, 'src', 'page.css'), 'utf8').trim()}
</style>
<script type="module" src="./assets/${pageFile}"></script>
</head>
<body>
<div id="app" hidden>
  <aside id="side" aria-label="Tables and views"></aside>
  <main id="main">
    <div id="notices"></div>
    <div id="toolbar">
      <span id="title"></span>
      <span id="meta"></span>
      <button id="stop" class="btn" type="button" hidden>Cancel</button>
      <span class="grow"></span>
      <input id="search" class="text-input" type="search" placeholder="Search rows" aria-label="Search rows" spellcheck="false" autocomplete="off" hidden>
      <button id="export" class="btn" type="button" title="Save these rows as a CSV file" hidden>Export CSV</button>
      <span id="save-ready" class="save-ready" hidden></span>
    </div>
    <div id="query" hidden>
      <textarea id="sql" spellcheck="false" autocomplete="off" aria-label="SQL" placeholder="SELECT * FROM a_table WHERE …"></textarea>
      <div id="query-bar">
        <button id="run" class="btn primary" type="button">Run</button>
        <button id="cancel" class="btn" type="button" hidden>Cancel</button>
        <span id="query-message" role="status"></span>
      </div>
    </div>
    <div id="content">
      <div id="grid" class="grid" tabindex="0" role="grid" aria-label="Rows" hidden></div>
      <div id="grid-empty" class="grid-empty" hidden></div>
      <div id="sqlview" hidden></div>
    </div>
    <div id="detail" hidden>
      <div id="detail-head"></div>
      <pre id="detail-body" tabindex="-1"></pre>
    </div>
  </main>
  <footer id="status"></footer>
</div>
<div id="message" hidden><div class="box"><h1></h1><p class="what"></p><p class="todo"></p></div></div>
<div id="menu" role="menu" hidden></div>
<div id="toast" role="status" hidden></div>
</body>
</html>
`

const written = [
  { file: path.join(EDITOR, 'index.html'), bytes: Buffer.from(html) },
  ...[...worker.outputFiles, ...page.outputFiles].map((file) => ({ file: file.path, bytes: Buffer.from(file.contents) })),
  { file: path.join(EDITOR, 'assets', 'sql-wasm.wasm'), bytes: readFileSync(path.join(SQLJS, 'dist', 'sql-wasm-browser.wasm')) }
]
for (const { file } of written.filter(({ file }) => file.endsWith('.js'))) {
  const text = written.find((entry) => entry.file === file).bytes.toString()
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) {
    throw new Error(`${path.relative(EDITOR, file)} evaluates strings as code (eval or Function), which the frame CSP refuses`)
  }
}
rmSync(EDITOR, { recursive: true, force: true })
for (const { file, bytes } of written) {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`${path.relative(EDITOR, file)} is ${bytes.length} bytes; the catalog takes at most ${MAX_FILE_BYTES}`)
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, bytes)
}

// Notices: the WebAssembly SQLite package (the only one with code in the build), SQLite itself, and
// the Emscripten runtime and musl libc compiled into it (build/licenses).
const inputs = [...Object.keys(worker.metafile.inputs), ...Object.keys(page.metafile.inputs)]
const packages = [...new Set(inputs.filter((input) => input.includes('node_modules/')).map((input) => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input)[1]))]
if (packages.join() !== 'sql.js') {
  throw new Error(`the build bundles ${packages.join(', ')}; add their licences to THIRD_PARTY_NOTICES.txt in build.mjs`)
}
const sqljs = JSON.parse(readFileSync(path.join(SQLJS, 'package.json'), 'utf8'))
writeFileSync(
  NOTICES,
  `The SQLite Browser editor in editor/ bundles the following software.\n\n` +
    `${sqljs.name}@${sqljs.version} (${sqljs.license}): editor/assets/sqlite-worker-*.js and editor/assets/sql-wasm.wasm\n\n` +
    `${readFileSync(path.join(SQLJS, 'LICENSE'), 'utf8').trim()}\n\n${'='.repeat(78)}\n\n` +
    [path.join(HERE, 'sqlite-notice.txt'), path.join(HERE, 'licenses', 'emscripten.txt'), path.join(HERE, 'licenses', 'musl.txt')]
      .map((file) => readFileSync(file, 'utf8').trim())
      .join(`\n\n${'='.repeat(78)}\n\n`) +
    '\n'
)

const totalBytes = written.reduce((sum, { bytes }) => sum + bytes.length, 0)
console.log(`editor/: ${written.length} files, ${totalBytes} bytes`)
execFileSync(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: HERE, stdio: 'inherit' })
