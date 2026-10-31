// Converts a VS Code color theme (a theme file or an extension folder) into an Orca theme plugin,
// then checks it with Orca's own validator.
// Usage: ORCA_DIR=/path/to/orca node tools/import-vscode-theme/import-vscode-theme.mjs \
//   <theme.json | extension folder> <new plugin folder> --publisher <owner> [--id <id>]
//   [--name <name>] [--description <text>] [--license <SPDX>] [--license-file <path>]
//   [--source-url <url>] [--repository <url>] [--version <x.y.z>]
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { renderThemePlugin } from './theme-conversion.mjs'
import { readVscodeThemes, ThemeReadError } from './theme-reading.mjs'

const USAGE =
  'Usage: ORCA_DIR=/path/to/orca node tools/import-vscode-theme/import-vscode-theme.mjs <theme.json|extension dir> <new dir> --publisher <owner> [--id <id>] [--name <name>] [--description <text>] [--license <SPDX>] [--license-file <path>] [--source-url <url>] [--repository <url>] [--version <x.y.z>]'

function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    [
      'publisher',
      'id',
      'name',
      'description',
      'license',
      'license-file',
      'source-url',
      'repository',
      'version'
    ].map((name) => [name, { type: 'string' }])
  )
})
const [source, outDir] = positionals
const orcaDir = process.env.ORCA_DIR
if (!source || !outDir || !flags.publisher) {
  fail(USAGE, 2)
}
if (!orcaDir) {
  fail('set ORCA_DIR to an Orca checkout with dependencies installed', 2)
}

// Why Orca's own schema: the tool writes only tokens and terminal slots that Orca accepts, so
// rows for newer tokens in color-map.mjs apply once ORCA_DIR has them.
const { loadPluginSchemaModule } = await import(
  pathToFileURL(path.join(orcaDir, 'config', 'scripts', 'plugin-schema-module-loader.mjs')).href
)
const orca = {
  appTokens: new Set(
    loadPluginSchemaModule('artifacts/plugin-theme-artifact.ts').PLUGIN_APP_THEME_TOKENS
  ),
  terminalKeys: loadPluginSchemaModule('../terminal-custom-themes.ts').TERMINAL_COLOR_KEYS
}

const target = path.resolve(outDir)
if (existsSync(target) && readdirSync(target).some((entry) => entry !== '.git')) {
  fail(`${target} is not empty; choose a new or empty folder`, 2)
}

let set
try {
  set = readVscodeThemes(source)
} catch (error) {
  fail(error instanceof ThemeReadError ? error.message : String(error), 2)
}

const name = flags.name ?? set.name ?? set.themes[0].label
const id =
  flags.id ??
  path
    .basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
const { files, warnings } = renderThemePlugin(
  set,
  {
    publisher: flags.publisher,
    id,
    name,
    description: flags.description,
    license: flags.license,
    repository: flags.repository,
    version: flags.version
  },
  orca
)

const licenseFile =
  flags['license-file'] ??
  readdirSync(set.root)
    .filter((entry) => /^licen[cs]e(\.(md|txt))?$/i.test(entry))
    .map((entry) => path.join(set.root, entry))
    .find((entry) => statSync(entry).isFile())
if (!licenseFile) {
  warnings.push('no LICENSE found next to the theme; pass --license-file before publishing')
}

const sourceLine = flags['source-url'] ? `[${name}](${flags['source-url']})` : name
files['README.md'] = `# ${name}

${set.themes.map((theme) => `- **${theme.label}** (${theme.base})`).join('\n')}

Select a theme under Settings → Appearance; its terminal colors are offered alongside it.

## Attribution

Converted from the VS Code color theme ${sourceLine} with
\`tools/import-vscode-theme\` in [stablyai/orca-plugins](https://github.com/stablyai/orca-plugins).
${licenseFile ? 'The upstream license notice is kept in [LICENSE](LICENSE).' : ''}
`
// Why -text: Git must not rewrite line endings, or the content hash differs per checkout.
files['.gitattributes'] = '* -text\n'

for (const [file, text] of Object.entries(files)) {
  const out = path.join(target, ...file.split('/'))
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, text, { flag: 'wx' })
}
if (licenseFile) {
  copyFileSync(licenseFile, path.join(target, 'LICENSE'))
}
for (const warning of warnings) {
  console.warn(`warning: ${warning}`)
}

const validator = path.join(orcaDir, 'config', 'scripts', 'validate-plugin-files.mjs')
try {
  process.stdout.write(
    execFileSync(process.execPath, [validator, target], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  )
} catch (error) {
  fail(
    `${error.stdout ?? ''}${error.stderr ?? ''}\nThe converted files stay in ${target}: fix them and re-run Orca's validator, or delete the folder and import again.`,
    2
  )
}
console.log(`Wrote ${set.themes.length} theme(s) to ${target}`)
