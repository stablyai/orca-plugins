// Converts read VS Code themes into the files of an Orca theme plugin.
import {
  TRANSLUCENT_APP_THEME_TOKENS,
  VSCODE_APP_THEME_COLORS,
  VSCODE_TERMINAL_COLORS
} from './color-map.mjs'
import { contrastRatio, flatten, parseHex, toHex } from './color-math.mjs'
import { isRecord } from './theme-reading.mjs'

// Why: VS Code's own defaults when a theme leaves the editor colors out.
const DEFAULT_EDITOR = {
  light: { background: [255, 255, 255, 1], foreground: [0, 0, 0, 1] },
  dark: { background: [30, 30, 30, 1], foreground: [212, 212, 212, 1] }
}
// Orca's limits: theme file bytes, rules, scopes per rule and characters per scope.
export const THEME_FILE_MAX_BYTES = 16 * 1024
const MAX_RULES = 512
const MAX_SCOPES_PER_RULE = 64
const MAX_SCOPE_LENGTH = 512
// Why 56: room for a `-2` suffix within Orca's 64-character id limit.
const MAX_ID_BASE_LENGTH = 56
const RESERVED_IDS = new Set(['prototype', 'constructor'])
const FONT_STYLES = new Set(['italic', 'bold', 'underline', 'strikethrough'])
const MIN_TEXT_CONTRAST = 4.5
const ENGINE = '>=1.4.245'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

function firstColor(colors, keys) {
  for (const key of keys) {
    const color = parseHex(colors[key])
    if (color) {
      return color
    }
  }
  return null
}

/** The scope-less rule VS Code themes use for the editor's default text and background. */
function defaultRuleSettings(theme) {
  const rule = theme.tokenColors.find(
    (entry) => isRecord(entry) && entry.scope === undefined && isRecord(entry.settings)
  )
  return rule?.settings ?? {}
}

function editorColors(theme) {
  const fallback = defaultRuleSettings(theme)
  const defaults = DEFAULT_EDITOR[theme.base]
  const background = flatten(
    firstColor(theme.colors, ['editor.background']) ??
      parseHex(fallback.background) ??
      defaults.background,
    defaults.background
  )
  const foreground =
    firstColor(theme.colors, ['editor.foreground', 'foreground']) ??
    parseHex(fallback.foreground) ??
    defaults.foreground
  return { background, foreground: flatten(foreground, background) }
}

/** The surfaces a text token is read on, for the pairs where Orca drops both colors. */
function surfacesOf(token) {
  if (token === '--foreground') {
    return ['--background', '--editor-surface']
  }
  if (token === '--muted-foreground') {
    return ['--background', '--editor-surface', '--muted']
  }
  // Hovered inactive tabs take the active text color.
  if (token === '--tab-active-foreground') {
    return ['--tab-active', '--tab-inactive']
  }
  return token.endsWith('-foreground') ? [token.slice(0, -'-foreground'.length)] : []
}

/** A token's color as painted: translucent ones over the opaque token beneath them. */
function painted(token, tokens) {
  const color = parseHex(tokens[token])
  const under = TRANSLUCENT_APP_THEME_TOKENS[token]
  if (!color || color[3] === 1 || !under) {
    return color
  }
  const base = painted(under, tokens) ?? parseHex(tokens['--background'])
  return base ? flatten(color, base) : null
}

function readableOn(text, token, tokens) {
  return surfacesOf(token).every((surface) => {
    const color = painted(surface, tokens)
    return !color || contrastRatio(text, color) >= MIN_TEXT_CONTRAST
  })
}

/** The dimmest mix of `--foreground` into `--background` that stays readable. */
function readableMutedText(tokens) {
  const foreground = parseHex(tokens['--foreground'])
  const background = parseHex(tokens['--background'])
  if (!foreground || !background) {
    return null
  }
  for (let share = 0.7; share <= 1; share += 0.05) {
    const mix = flatten([foreground[0], foreground[1], foreground[2], share], background)
    if (readableOn(mix, '--muted-foreground', tokens)) {
      return toHex(mix)
    }
  }
  return null
}

/**
 * Orca drops both colors of a text/surface pair under 4.5:1, which would lose the surface too.
 * VS Code themes often use dim description text, so an unreadable text token is left to Orca's
 * derivation, and muted text (whose derived 70% mix can also fail) gets the dimmest readable mix.
 */
function withoutUnreadableText(tokens, accepted) {
  const readable = { ...tokens }
  for (const token of Object.keys(tokens)) {
    const text = parseHex(tokens[token])
    if (token !== '--foreground' && text && !readableOn(text, token, tokens)) {
      delete readable[token]
    }
  }
  if (!readable['--muted-foreground'] && accepted.has('--muted-foreground')) {
    const muted = readableMutedText(readable)
    if (muted) {
      readable['--muted-foreground'] = muted
    }
  }
  return readable
}

/** Orca tokens for one theme, limited to the tokens the target Orca accepts. */
export function appTokens(theme, accepted) {
  const { background, foreground } = editorColors(theme)
  const colors = {
    ...theme.colors,
    'editor.background': toHex(background),
    'editor.foreground': toHex(foreground)
  }
  const tokens = {}
  for (const [token, keys] of Object.entries(VSCODE_APP_THEME_COLORS)) {
    const color = accepted.has(token) ? firstColor(colors, keys) : null
    if (color) {
      // Why flatten: Orca needs opaque text and surfaces to check their contrast.
      tokens[token] = toHex(token in TRANSLUCENT_APP_THEME_TOKENS ? color : flatten(color, background))
    }
  }
  return withoutUnreadableText(tokens, accepted)
}

function scopesOf(scope) {
  return (Array.isArray(scope) ? scope : [scope])
    .filter((entry) => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * VS Code rules in the shape Orca validates: one rule per distinct style, each scope once with
 * its last style per property (later rules win, as in VS Code). Descendant selectors (`a b`) are
 * dropped because Orca does not read them.
 */
export function compactTokenColors(tokenColors, warnings, label) {
  const byScope = new Map()
  let descendant = 0
  for (const rule of tokenColors) {
    if (!isRecord(rule) || !isRecord(rule.settings)) {
      continue
    }
    const foreground = parseHex(rule.settings.foreground)
    const fontStyle =
      typeof rule.settings.fontStyle === 'string'
        ? rule.settings.fontStyle
            .split(/\s+/)
            .filter((style) => FONT_STYLES.has(style))
            .join(' ')
        : undefined
    if (!foreground && fontStyle === undefined) {
      continue
    }
    for (const scope of scopesOf(rule.scope)) {
      if (/\s/.test(scope)) {
        descendant += 1
      } else if (scope.length <= MAX_SCOPE_LENGTH) {
        byScope.set(scope, {
          ...byScope.get(scope),
          ...(foreground ? { foreground: toHex(foreground) } : {}),
          ...(fontStyle !== undefined ? { fontStyle } : {})
        })
      }
    }
  }
  if (descendant > 0) {
    warnings.push(`${label}: dropped ${descendant} descendant scope selectors Orca does not read`)
  }
  const byStyle = new Map()
  for (const [scope, settings] of byScope) {
    const key = JSON.stringify([settings.foreground, settings.fontStyle])
    const group = byStyle.get(key) ?? { settings, scopes: [] }
    group.scopes.push(scope)
    byStyle.set(key, group)
  }
  return [...byStyle.values()].flatMap(({ settings, scopes }) => {
    const rules = []
    for (let index = 0; index < scopes.length; index += MAX_SCOPES_PER_RULE) {
      const chunk = scopes.slice(index, index + MAX_SCOPES_PER_RULE)
      rules.push({ scope: chunk.length === 1 ? chunk[0] : chunk, settings })
    }
    return rules
  })
}

function appThemeFile(theme, accepted, warnings) {
  const tokens = appTokens(theme, accepted)
  const rules = compactTokenColors(theme.tokenColors, warnings, theme.label)
  const fits = (text) => Buffer.byteLength(text) <= THEME_FILE_MAX_BYTES
  // Why minify before trimming: Orca caps a theme file at 16 KiB and code colors are most of it.
  const render = (kept) => {
    const content = {
      schemaVersion: 1,
      base: theme.base,
      tokens,
      ...(kept ? { tokenColors: rules.slice(0, kept) } : {})
    }
    const pretty = json(content)
    return fits(pretty) ? pretty : `${JSON.stringify(content)}\n`
  }
  // Rules keep the order their style first appears in the theme, so the last are dropped first.
  let low = 0
  let high = Math.min(rules.length, MAX_RULES)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(render(middle))) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  if (low < rules.length) {
    warnings.push(`${theme.label}: kept ${low} of ${rules.length} code color rules to fit Orca's limits`)
  }
  return render(low)
}

const TERMINAL_ANSI = new Set(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'])

function terminalPalette(theme, terminalKeys) {
  const editor = editorColors(theme)
  const background = flatten(
    firstColor(theme.colors, VSCODE_TERMINAL_COLORS.background) ?? editor.background,
    editor.background
  )
  const fallbacks = { background, foreground: editor.foreground }
  const palette = {}
  for (const key of terminalKeys) {
    const color = (VSCODE_TERMINAL_COLORS[key] && firstColor(theme.colors, VSCODE_TERMINAL_COLORS[key])) ?? fallbacks[key]
    if (color) {
      // Why flatten: terminal palettes are opaque hex; VS Code paints alpha over the panel.
      palette[key] = toHex(flatten(color, key === 'background' ? editor.background : background))
    }
  }
  const usable = Object.keys(palette).some((key) =>
    TERMINAL_ANSI.has(key.replace(/^bright(.)/, (_, first) => first.toLowerCase()))
  )
  return usable ? palette : null
}

function slug(label, taken) {
  const cut = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_ID_BASE_LENGTH)
    .replace(/^-+|-+$/g, '')
  const base = !cut ? 'theme' : RESERVED_IDS.has(cut) ? `${cut}-theme` : cut
  let id = base
  for (let suffix = 2; taken.has(id); suffix += 1) {
    id = `${base}-${suffix}`
  }
  taken.add(id)
  return id
}

/**
 * The files of an Orca plugin with an app theme for every VS Code theme, plus a terminal theme
 * from its `terminal.ansi*` colors. `orca` names the tokens and terminal slots the target Orca
 * accepts; `identity` is `{ publisher, id, name, license?, description?, repository? }`.
 */
export function renderThemePlugin(set, identity, orca) {
  const warnings = [...set.warnings]
  const files = {}
  const themes = []
  const terminalThemes = []
  const taken = new Set()
  for (const theme of set.themes) {
    const id = slug(theme.label, taken)
    files[`themes/${id}.json`] = appThemeFile(theme, orca.appTokens, warnings)
    themes.push({ id, title: theme.label, path: `themes/${id}.json` })
    const palette = terminalPalette(theme, orca.terminalKeys)
    if (palette) {
      files[`terminal/${id}.json`] = json({ schemaVersion: 1, mode: theme.base, terminal: palette })
      terminalThemes.push({ id, title: theme.label, path: `terminal/${id}.json` })
    } else {
      warnings.push(`${theme.label}: no terminal theme; it sets no terminal.ansi* colors`)
    }
  }
  const description =
    identity.description ?? `${identity.name}, converted from a VS Code color theme.`
  files['orca-plugin.json'] = json({
    manifestVersion: 2,
    id: identity.id,
    publisher: identity.publisher,
    name: identity.name,
    version: identity.version ?? '1.0.0',
    execution: 'data',
    description,
    ...(identity.license ? { license: identity.license } : {}),
    ...(identity.repository ? { repository: identity.repository } : {}),
    engines: { orca: ENGINE },
    contributes: { themes, ...(terminalThemes.length ? { terminalThemes } : {}) },
    capabilities: []
  })
  return { files, warnings: [...new Set(warnings)] }
}
