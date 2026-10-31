// Orca's own theme schema and contrast check, loaded from an Orca checkout (ORCA_DIR), so the
// tool writes only what that Orca accepts and keeps everything its contrast check would drop.
import { existsSync } from 'node:fs'
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
  // Why this marker: the Orca that added CSS fallbacks (stablyai/orca#36578) also moved the
  // theme's base into the contrast check's second argument.
  const cssFallback = artifact.pluginAppThemeCssFallback
  return {
    appTokens: new Set(artifact.PLUGIN_APP_THEME_TOKENS),
    terminalKeys: terminal.TERMINAL_COLOR_KEYS,
    /** The tokens Orca registers: the theme's own plus its derivations. */
    complete: artifact.completePluginAppThemeTokens,
    /** Also the values Orca's stylesheet derives for omitted tokens, as its contrast check reads. */
    effective: (tokens, base) => {
      const out = { ...tokens }
      for (const token of artifact.PLUGIN_APP_THEME_TOKENS) {
        const rule = !out[token] && cssFallback ? cssFallback(token, base) : undefined
        const value = rule ? derive(rule, out) : undefined
        if (value) {
          out[token] = value
        }
      }
      return out
    },
    gate: (tokens, base) =>
      cssFallback
        ? safePluginThemeTokens(tokens, base, {}, parseCssColor)
        : safePluginThemeTokens(tokens, {}, parseCssColor)
  }
}
