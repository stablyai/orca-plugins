// Builds ../editor/index.html: one self-contained file, because the editor frame's CSP allows only
// inline scripts and styles, with no network and no workers. Also writes ../THIRD_PARTY_NOTICES.txt
// from the packages that end up in the bundle.
// Usage: npm ci && node build.mjs
import { build, transform } from 'esbuild'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const HERE = import.meta.dirname
const PLUGIN = path.resolve(HERE, '..')
const OUT = path.join(PLUGIN, 'editor', 'index.html')
const NOTICES = path.join(PLUGIN, 'THIRD_PARTY_NOTICES.txt')

const result = await build({
  entryPoints: [path.join(HERE, 'src', 'editor.js')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
  absWorkingDir: HERE
})
const css = (
  await transform(readFileSync(path.join(HERE, 'src', 'editor.css'), 'utf8'), { loader: 'css', minify: true })
).code.trim()

// Why: `<!--` then `<script` inside an inline script puts the HTML parser in a state where `</script>`
// no longer ends it. Every occurrence is inside a string or regex literal, where `\x3C` reads the same.
const js = result.outputFiles[0].text.replace(/<(!--|script)/gi, '\\x3C$1').trim()
new vm.Script(js)
if (/<\/script/i.test(js) || /<\/style/i.test(css)) {
  throw new Error('the bundle contains a closing script or style tag; it cannot be inlined')
}
if (/\beval\(|new Function\(/.test(js)) {
  throw new Error('the bundle contains eval or new Function; the frame CSP refuses both')
}

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Spreadsheet</title>
<style>${css}</style>
</head>
<body>
<div class="app">
<div class="message" id="message" role="status"></div>
<div class="workbook" id="workbook" hidden>
<div class="notice" id="notice" role="note" hidden></div>
<div class="notice conflict" id="conflict" role="alert" hidden><span id="conflict-text"></span><button type="button" class="notice-button" id="conflict-apply">Reapply at the same cells</button><button type="button" class="notice-button" id="conflict-discard">Discard them</button></div>
<div class="detail-bar">
<div class="address" id="address" title="Active cell"></div>
<input class="formula" id="formula" type="text" spellcheck="false" autocomplete="off" aria-label="Cell contents">
<span class="result" id="result"></span>
</div>
<div class="sheet-area"><div class="grid-host" id="grid-host"></div><textarea class="cell-editor" id="cell-editor" spellcheck="false" aria-label="Edit cell" hidden></textarea><div class="sheet-message" id="sheet-message" hidden></div></div>
<div class="footer">
<div class="tabs" id="tabs" role="tablist" aria-label="Sheets"></div>
<span class="hidden-note" id="hidden-note" hidden></span>
<div class="status"><span class="status-note" id="status-note"></span><span id="status-stats"></span><span class="status-dims" id="status-dims"></span></div>
</div>
</div>
<div class="menu" id="menu" role="menu" aria-label="Cell actions" hidden></div>
<div class="sr-only" id="live" aria-live="polite"></div>
</div>
<script>${js}</script>
</body>
</html>
`
mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT, html)

// Notices: every npm package with code in the bundle, with its licence as shipped in the package.
const packages = new Map()
for (const input of Object.keys(result.metafile.inputs)) {
  const at = input.lastIndexOf('node_modules/')
  if (at === -1) continue
  const name = /^(?:@[^/]+\/)?[^/]+/.exec(input.slice(at + 'node_modules/'.length))[0]
  const dir = path.join(HERE, input.slice(0, at), 'node_modules', name)
  packages.set(dir, { ...JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')), dir })
}
const licenceText = (pkg) => {
  const file = readdirSync(pkg.dir).find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry))
  if (!file) throw new Error(`${pkg.name} ships no licence file`)
  const text = readFileSync(path.join(pkg.dir, file), 'utf8').trim()
  // Why: build/licenses keeps the reviewed text in git; a dependency bump that changes it fails here.
  const reviewed = readFileSync(path.join(HERE, 'licenses', `${pkg.name.replace('/', '__')}.txt`), 'utf8').trim()
  if (text !== reviewed) throw new Error(`${pkg.name}'s licence differs from build/licenses; review and update it`)
  return text
}
const sections = [...packages.values()]
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((pkg) => `${pkg.name}@${pkg.version} (${pkg.license})\n${pkg.homepage ?? ''}\n\n${licenceText(pkg)}`)
writeFileSync(
  NOTICES,
  `Spreadsheet's editor/index.html bundles the following software.\n\n` +
    `${sections.join(`\n\n${'='.repeat(78)}\n\n`)}\n`
)

console.log(`editor/index.html: ${Buffer.byteLength(html)} bytes, ${packages.size} packages`)
