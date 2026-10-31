// Orca's own theme schema and contrast check, loaded from an Orca checkout (ORCA_DIR), so the
// tool writes only what that Orca accepts and keeps everything its contrast check would drop.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseCssColor } from './color-math.mjs'

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
  return {
    appTokens: new Set(artifact.PLUGIN_APP_THEME_TOKENS),
    terminalKeys: terminal.TERMINAL_COLOR_KEYS,
    complete: artifact.completePluginAppThemeTokens,
    // Why both arities: Orca with stablyai/orca#36578 takes the theme's base second.
    gate: (tokens, base) =>
      safePluginThemeTokens.length >= 4
        ? safePluginThemeTokens(tokens, base, {}, parseCssColor)
        : safePluginThemeTokens(tokens, {}, parseCssColor)
  }
}
