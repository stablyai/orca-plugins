// Converts a VS Code color theme (a theme file or an extension folder) into an Orca theme plugin,
// then checks it with Orca's own validator. See README.md.
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { loadOrcaSchema } from './orca-schema.mjs'
import { renderThemePlugin } from './theme-conversion.mjs'
import { containedFile, readVscodeThemes, ThemeReadError } from './theme-reading.mjs'

const USAGE = `Usage: ORCA_DIR=/path/to/orca node tools/import-vscode-theme/import-vscode-theme.mjs \\
  <theme.json | extension folder> <new plugin folder> --publisher <owner> [--id <id>]
  [--name <name>] [--description <text>] [--version <x.y.z>] [--repository <url>]
  [--license <SPDX>] [--license-file <path>] [--source-url <url>] [--theme <label>]...`
const STRING_FLAGS = [
  'publisher',
  'id',
  'name',
  'description',
  'version',
  'repository',
  'license',
  'license-file',
  'source-url'
]

function fail(message, code = 2) {
  console.error(message)
  process.exit(code)
}

let parsed
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      ...Object.fromEntries(STRING_FLAGS.map((name) => [name, { type: 'string' }])),
      theme: { type: 'string', multiple: true }
    }
  })
} catch (error) {
  fail(`${error.message}\n${USAGE}`)
}
const { values: flags, positionals } = parsed
const [source, outDir] = positionals
if (!source || !outDir || !flags.publisher || positionals.length > 2) {
  fail(USAGE)
}
const orcaDir = process.env.ORCA_DIR
if (!orcaDir) {
  fail('set ORCA_DIR to an Orca checkout with dependencies installed')
}

const target = path.resolve(outDir)
if (existsSync(target)) {
  if (!statSync(target).isDirectory()) {
    fail(`${target} exists and is not a folder`)
  }
  if (readdirSync(target).some((entry) => entry !== '.git')) {
    fail(`${target} is not empty; choose a new or empty folder`)
  }
}
const id =
  flags.id ??
  path
    .basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
if (!id) {
  fail('cannot derive a plugin id from the folder name; pass --id')
}
if (flags['source-url'] && !/^https:\/\/[^\s<>()[\]]+$/.test(flags['source-url'])) {
  fail('--source-url must be an https URL')
}

let set
try {
  set = readVscodeThemes(source, { only: flags.theme ? new Set(flags.theme) : undefined })
} catch (error) {
  fail(error instanceof ThemeReadError ? error.message : String(error))
}
if (set.themes.length === 0) {
  fail(`no theme matched --theme ${flags.theme.join(', ')}`)
}

/** The upstream license: the given file, or a regular LICENSE file inside the imported folder. */
function licenseFile() {
  if (flags['license-file']) {
    const file = path.resolve(flags['license-file'])
    if (!existsSync(file) || !statSync(file).isFile()) {
      fail(`--license-file ${file} is not a file`)
    }
    return file
  }
  const name = readdirSync(set.root).find((entry) => /^licen[cs]e(\.(md|txt))?$/i.test(entry))
  if (!name) {
    return null
  }
  try {
    // Why contained and regular: an upstream LICENSE symlink must not copy a private file.
    const file = containedFile(set.root, path.join(set.root, 'package.json'), name)
    return lstatSync(file).isFile() ? file : null
  } catch {
    return null
  }
}
const license = licenseFile()

let orca
try {
  orca = await loadOrcaSchema(orcaDir)
} catch (error) {
  fail(`could not load Orca's theme schema from ${orcaDir}: ${error.message}`)
}

const name = flags.name ?? set.name ?? set.themes[0].label
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
if (!license) {
  warnings.push('no LICENSE copied; pass --license-file before publishing')
} else if (!flags.license) {
  warnings.push('a LICENSE was copied but the manifest has no license; pass --license <SPDX>')
}

// Why: titles come from untrusted theme files and land in Markdown.
const plain = (text) => text.replace(/[[\]()<>*_`\\]/g, '')
const upstream = flags['source-url'] ? `[${plain(name)}](${flags['source-url']})` : plain(name)
files['README.md'] = `# ${plain(name)}

${set.themes.map((theme) => `- ${plain(theme.label)} (${theme.base})`).join('\n')}

Choose a theme under Settings → Appearance; its terminal colors are offered alongside it.

## Attribution

Converted from the VS Code color theme ${upstream} with \`tools/import-vscode-theme\` in
[stablyai/orca-plugins](https://github.com/stablyai/orca-plugins).${license ? ' The upstream license notice is kept in [LICENSE](LICENSE).' : ''}
`

for (const [file, text] of Object.entries(files)) {
  const out = path.join(target, ...file.split('/'))
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, text, { flag: 'wx' })
}
if (license) {
  copyFileSync(license, path.join(target, 'LICENSE'))
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
    `${error.stdout ?? ''}${error.stderr ?? ''}${error.stdout || error.stderr ? '' : error.message}
The converted files stay in ${target}: fix them and re-run Orca's validator, or delete the folder and import again.`
  )
}
console.log(`Wrote ${set.themes.length} theme(s) to ${target}`)
