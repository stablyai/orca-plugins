// Builds ../editor/index.html: one self-contained file, because the editor frame's CSP allows only
// inline scripts and styles, with no network and no workers. There are no runtime dependencies.
// Usage: npm ci && node build.mjs
import { build, transform } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const HERE = import.meta.dirname
const OUT = path.resolve(HERE, '..', 'editor', 'index.html')

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
const bundled = Object.keys(result.metafile.inputs).filter((input) => input.includes('node_modules'))
if (bundled.length) throw new Error(`the editor must not bundle packages: ${bundled.join(', ')}`)
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
<title>Image Markup</title>
<style>${css}</style>
</head>
<body>
<div class="app">
<div class="toolbar" role="toolbar" aria-label="Markup tools">
<div class="group" id="tools"></div>
<div class="sep"></div>
<div class="group" id="colors" aria-label="Colour"></div>
<div class="sep"></div>
<div class="group" id="widths" aria-label="Stroke"></div>
<div class="sep"></div>
<div class="group" id="history"></div>
<div class="spacer"></div>
<div class="group" id="zoom"></div>
<div class="group" id="actions"></div>
</div>
<div class="stage" id="stage" tabindex="0" aria-label="Image with markup">
<canvas id="base"></canvas>
<canvas id="overlay"></canvas>
<textarea id="text-editor" hidden spellcheck="false" aria-label="Text"></textarea>
<div class="message" id="message" role="alert">Loading image…</div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
</div>
<div class="footer"><span id="info"></span><span id="status" role="status" aria-live="polite"></span></div>
</div>
<script>${js}</script>
</body>
</html>
`
mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
console.log(`editor/index.html: ${Buffer.byteLength(html)} bytes`)
