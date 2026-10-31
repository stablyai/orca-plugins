// Orca's own theme schema and contrast check, loaded from an Orca checkout (ORCA_DIR), so the
// tool writes only what that Orca accepts and keeps everything its contrast check would drop.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseCssColor } from './color-math.mjs'

/** Writes out a rule Orca derives a token by: the first present source, or a foreground mix. */
function derive(rule, tokens) {
  if (Array.isArray(rule)) {
    return rule.map((source) => tokens[source]).find(Boolean)
  }
  const into = tokens[rule.into ?? '--background']
  return tokens['--foreground'] && into
    ? `color-mix(in srgb, ${tokens['--foreground']} ${rule.mixForeground}%, ${into})`
    : undefined
}

/** Orca paints one canvas pixel per color, so its check sees whole channels. */
function probe(value) {
  const color = parseCssColor(value)
  return color
    ? [Math.round(color[0]), Math.round(color[1]), Math.round(color[2]), Math.round(color[3] * 255) / 255]
    : null
}

/** Orca's built-in colors per base, from the `:root` and `.dark` blocks of its stylesheet. */
function builtInColors(orcaDir, tokens) {
  const css = readFileSync(
    path.join(orcaDir, 'src', 'renderer', 'src', 'assets', 'main.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')
  const block = (selector) => {
    const start = css.indexOf(`\n${selector} {\n`)
    const body = start === -1 ? '' : css.slice(start, css.indexOf('\n}', start))
    return Object.fromEntries(
      [...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)]
        .filter(([, token, value]) => tokens.has(token) && probe(value))
        .map(([, token, value]) => [token, value.trim()])
    )
  }
  const light = block(':root')
  return { light, dark: { ...light, ...block('.dark') } }
}

export async function loadOrcaSchema(orcaDir) {
  const loader = path.join(orcaDir, 'config', 'scripts', 'plugin-schema-module-loader.mjs')
  if (!existsSync(loader)) {
    throw new Error(`${orcaDir} is not an Orca checkout (missing ${loader})`)
  }
  const { loadPluginSchemaModule } = await import(pathToFileURL(loader).href)
  const artifact = loadPluginSchemaModule('artifacts/plugin-theme-artifact.ts')
  const terminal = loadPluginSchemaModule('../terminal-custom-themes.ts')
  const { safePluginThemeTokens } = loadPluginSchemaModule(
    '../../renderer/src/lib/plugin-theme-tokens.ts'
  )
  const appTokens = new Set(artifact.PLUGIN_APP_THEME_TOKENS)
  const builtIns = builtInColors(orcaDir, appTokens)
  // Why this marker: the Orca that added CSS fallbacks (stablyai/orca#36578) also moved the
  // theme's base into the contrast check's second argument.
  const cssFallback = artifact.pluginAppThemeCssFallback
  return {
    appTokens,
    terminalKeys: terminal.TERMINAL_COLOR_KEYS,
    /** The tokens Orca registers: the theme's own plus its derivations. */
    complete: artifact.completePluginAppThemeTokens,
    /** What Orca's check reads: CSS-derived values for omitted tokens, then its built-ins. */
    effective: (tokens, base) => {
      const out = { ...tokens }
      for (const token of artifact.PLUGIN_APP_THEME_TOKENS) {
        const rule = !out[token] && cssFallback ? cssFallback(token, base) : undefined
        const value = rule ? derive(rule, out) : undefined
        if (value) {
          out[token] = value
        }
      }
      return { ...builtIns[base], ...out }
    },
    gate: (tokens, base) =>
      cssFallback
        ? safePluginThemeTokens(tokens, base, builtIns[base], probe)
        : safePluginThemeTokens(tokens, builtIns[base], probe)
  }
}
