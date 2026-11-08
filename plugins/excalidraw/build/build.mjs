// Builds ../editor (see README.md):
//   assets/ (with assets/fonts/)  the editor as ES modules, for Orca's isolated editor frame;
//   index.html                    the page that loads it, for .excalidraw files;
//   image.html                    the same for .excalidraw.svg and .excalidraw.png images.
// Also writes ../THIRD_PARTY_NOTICES.txt, then runs the tests in test/.
// Usage: npm ci --ignore-scripts && node build.mjs
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SKIPPED_FONT_FAMILIES, adaptExcalidraw, evaluatesStrings } from './excalidraw-patches.mjs'

const HERE = import.meta.dirname
const PLUGIN = path.resolve(HERE, '..')
const EDITOR = path.join(PLUGIN, 'editor')
const NOTICES = path.join(PLUGIN, 'THIRD_PARTY_NOTICES.txt')
const EXCALIDRAW_DIST = path.join(HERE, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod')
// Why: Orca reads each plugin file whole and refuses files over 10 MiB.
const MAX_FILE_BYTES = 10 * 1024 * 1024

const COMMON = {
  bundle: true,
  write: false,
  platform: 'browser',
  conditions: ['production'],
  target: 'chrome120',
  minify: true,
  jsx: 'automatic',
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  absWorkingDir: HERE,
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' }
}

/** Excalidraw reads and writes files through browser-fs-access; src/orca-file-access.js replaces it. */
const orcaFileAccess = {
  name: 'orca-file-access',
  setup(context) {
    context.onResolve({ filter: /^browser-fs-access$/ }, () => ({
      path: path.join(HERE, 'src', 'orca-file-access.js')
    }))
  }
}

const patches = adaptExcalidraw()
const guest = await build({
  ...COMMON,
  entryPoints: { editor: path.join(HERE, 'src', 'main.js') },
  splitting: true,
  outdir: EDITOR,
  entryNames: 'assets/[name]-[hash]',
  chunkNames: 'assets/[name]-[hash]',
  format: 'esm',
  plugins: [orcaFileAccess, patches.plugin]
})
patches.check()

const relativeToEditor = (file) => path.relative(EDITOR, file).split(path.sep).join('/')
const guestFile = (output) => `./${relativeToEditor(path.join(HERE, output))}`
const [entryJs, entryOutput] = Object.entries(guest.metafile.outputs).find(
  ([, output]) => output.entryPoint === 'src/main.js'
)
const assets = {
  entry: guestFile(entryJs),
  css: guestFile(entryOutput.cssBundle),
  preload: entryOutput.imports.filter((chunk) => chunk.kind === 'import-statement').map((chunk) => guestFile(chunk.path))
}

const page = (attributes) => `<!doctype html>
<html${attributes}>
<head>
<meta charset="utf-8">
<title>Excalidraw</title>
<style>
${readFileSync(path.join(HERE, 'src', 'page.css'), 'utf8').trim()}
</style>
<link rel="stylesheet" href="${assets.css}">
${assets.preload.map((href) => `<link rel="modulepreload" href="${href}">`).join('\n')}
<script type="module" src="${assets.entry}"></script>
</head>
<body>
<div id="root"></div>
</body>
</html>
`

const written = [
  { file: path.join(EDITOR, 'index.html'), bytes: Buffer.from(page('')) },
  { file: path.join(EDITOR, 'image.html'), bytes: Buffer.from(page(' data-document="image"')) }
]
for (const file of guest.outputFiles) {
  written.push({ file: file.path, bytes: Buffer.from(file.contents) })
}
for (const file of guest.outputFiles.filter((output) => output.path.endsWith('.js'))) {
  if (evaluatesStrings(file.text)) {
    throw new Error(`${relativeToEditor(file.path)} evaluates strings as code (eval or Function), which the frame CSP refuses`)
  }
}
rmSync(EDITOR, { recursive: true, force: true })
for (const { file, bytes } of written) {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`${relativeToEditor(file)} is ${bytes.length} bytes; Orca reads at most ${MAX_FILE_BYTES}`)
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, bytes)
}
for (const family of readdirSync(path.join(EXCALIDRAW_DIST, 'fonts')).sort()) {
  if (!SKIPPED_FONT_FAMILIES.has(family)) {
    cpSync(path.join(EXCALIDRAW_DIST, 'fonts', family), path.join(EDITOR, 'assets', 'fonts', family), { recursive: true })
  }
}

// Notices: every npm package with code in the build, then the font subsetter and the fonts.
const packages = new Map()
for (const input of Object.keys(guest.metafile.inputs)) {
  const at = input.lastIndexOf('node_modules/')
  if (at === -1) continue
  const name = /^(?:@[^/]+\/)?[^/]+/.exec(input.slice(at + 'node_modules/'.length))[0]
  const dir = path.join(HERE, input.slice(0, at), 'node_modules', name)
  packages.set(dir, { ...JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')), dir })
}
const missingLicences = []
const licenceText = (dir, name) => {
  const file = readdirSync(dir).find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry))
  if (file) return readFileSync(path.join(dir, file), 'utf8').trim()
  // Why: some packages publish no licence file; their repository's licence is kept in build/licenses.
  for (const fallback of [name.replace('/', '__'), name.split('/')[0]]) {
    const file = path.join(HERE, 'licenses', `${fallback}.txt`)
    if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  }
  missingLicences.push(`build/licenses/${name.replace('/', '__')}.txt`)
  return ''
}
const sections = [...packages.values()]
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  .filter((pkg, index, all) => index === 0 || `${pkg.name}@${pkg.version}` !== `${all[index - 1].name}@${all[index - 1].version}`)
  .map((pkg) => `${pkg.name}@${pkg.version} (${pkg.license ?? 'see below'})\n\n${licenceText(pkg.dir, pkg.name)}`)
if (missingLicences.length > 0) {
  throw new Error(`packages without a licence file; add:\n${missingLicences.join('\n')}`)
}
const extraNotices = ['subsetter-notices.txt', 'font-notices.txt'].map((file) =>
  readFileSync(path.join(HERE, file), 'utf8').trim()
)
writeFileSync(
  NOTICES,
  `The Excalidraw editor in editor/ bundles the following software and fonts.\n\n` +
    `${[...sections, ...extraNotices].join(`\n\n${'='.repeat(78)}\n\n`)}\n`
)

const totalBytes = written.reduce((sum, { bytes }) => sum + bytes.length, 0)
console.log(
  `editor/: ${written.length} files, ${totalBytes} bytes of HTML/JS/CSS (index.html ${written[0].bytes.length}), ` +
    `${packages.size} packages`
)
execFileSync(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: HERE, stdio: 'inherit' })
