// Computes the newest release entry of every plugin under plugins/ with Orca's validator, and checks
// (default) or rewrites (--write) it in orca-catalog.json. A release is pinned to the last commit
// that changed the plugin's directory, so changing a plugin without re-running this fails CI.
// Usage: ORCA_DIR=/path/to/orca node scripts/release-entry.mjs [--write]
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { orcaScript } from './orca-script.mjs'

const CATALOG_ROOT = path.resolve(import.meta.dirname, '..')
const CATALOG = path.join(CATALOG_ROOT, 'orca-catalog.json')
const PLUGINS = 'plugins'
const REPOSITORY_URL = 'https://github.com/stablyai/orca-plugins.git'

const orcaDir = process.env.ORCA_DIR
if (!orcaDir) {
  console.error('set ORCA_DIR to an Orca checkout with dependencies installed')
  process.exit(2)
}
const validator = orcaScript(orcaDir, 'content-validation', 'validate-plugin-files.mjs')
const write = process.argv.includes('--write')
const errors = []
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
const git = (...args) =>
  execFileSync('git', args, { cwd: CATALOG_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** The release entry Orca's validator prints for the plugin directory at HEAD. */
function printedRelease(sourcePath) {
  let out
  try {
    out = execFileSync(process.execPath, [validator, path.join(CATALOG_ROOT, sourcePath)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    errors.push(`${sourcePath}: does not validate:\n${`${error.stdout ?? ''}${error.stderr ?? ''}`.trim()}`)
    return null
  }
  const printedPath = /Catalog source path[^\n]*: (".*")/.exec(out)
  const marker = out.indexOf('Catalog release entry for HEAD')
  if (marker === -1 || !printedPath || JSON.parse(printedPath[1]) !== sourcePath) {
    errors.push(`${sourcePath}: the validator printed no release entry for this directory:\n${out.trim()}`)
    return null
  }
  if (out.includes('uncommitted changes')) {
    errors.push(`${sourcePath}: has uncommitted changes; commit them first`)
    return null
  }
  return JSON.parse(out.slice(out.indexOf('{', marker), out.lastIndexOf('}') + 1))
}

const dirs = existsSync(path.join(CATALOG_ROOT, PLUGINS))
  ? readdirSync(path.join(CATALOG_ROOT, PLUGINS), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${PLUGINS}/${entry.name}`)
  : []
const isHere = (entry) => entry.source?.url === REPOSITORY_URL && entry.source?.path
for (const entry of catalog.plugins.filter(isHere)) {
  if (!dirs.includes(entry.source.path)) {
    errors.push(`${entry.id}: source.path ${entry.source.path} is not a directory under ${PLUGINS}/`)
  }
}

for (const sourcePath of dirs) {
  const entry = catalog.plugins.find((listed) => isHere(listed) && listed.source.path === sourcePath)
  if (!entry) {
    errors.push(
      `${sourcePath}: not in orca-catalog.json; add an entry with id, source (url ${REPOSITORY_URL}, ref "main", path "${sourcePath}"), description, categories and "releases": []`
    )
    continue
  }
  const printed = printedRelease(sourcePath)
  if (!printed) {
    continue
  }
  // Why not HEAD: the catalog commit cannot name itself, and the plugin's bytes are the same at
  // the last commit that touched its directory.
  printed.commit = git('log', '-1', '--format=%H', 'HEAD', '--', sourcePath)
  // Why copied: the validator prints no license, and the directory pages show the release's.
  const { license } = JSON.parse(readFileSync(path.join(CATALOG_ROOT, sourcePath, 'orca-plugin.json'), 'utf8'))
  if (typeof license === 'string' && license) {
    printed.license = license
  }
  const releases = entry.releases ?? []
  const newest = releases[0]
  if (newest?.version === printed.version) {
    const stale = Object.keys(printed).filter((key) => !isDeepStrictEqual(newest[key], printed[key]))
    if (stale.length === 0) {
      console.log(`${entry.id}: release ${printed.version} is current (${printed.commit})`)
      continue
    }
    if (write) {
      // Keep display-only fields (license, changelog, images, ...) the author added.
      releases[0] = { ...newest, ...printed }
      console.log(`${entry.id}: updated release ${printed.version} (${stale.join(', ')})`)
    } else {
      errors.push(
        `${entry.id}: release ${printed.version} is stale (${stale.join(', ')}); run: ORCA_DIR=... node scripts/release-entry.mjs --write`
      )
    }
  } else if (write) {
    // Why carried: a validator that prints no images must not drop the covers the last release listed.
    releases.unshift(newest?.images && !printed.images ? { ...printed, images: newest.images } : printed)
    console.log(`${entry.id}: added release ${printed.version}`)
  } else {
    errors.push(
      `${entry.id}: ${sourcePath} is version ${printed.version} but the newest release is ${newest?.version ?? 'missing'}; run: ORCA_DIR=... node scripts/release-entry.mjs --write`
    )
  }
  entry.releases = releases
}

if (write && errors.length === 0) {
  writeFileSync(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`)
}
for (const error of errors) {
  console.error(`error: ${error}`)
}
console.log(errors.length === 0 ? 'release entries: ok' : `release entries: ${errors.length} error(s)`)
process.exit(errors.length === 0 ? 0 : 1)
