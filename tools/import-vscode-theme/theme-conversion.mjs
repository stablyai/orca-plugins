// Converts read VS Code themes into the files of an Orca theme plugin.
import {
  TRANSLUCENT_APP_THEME_TOKENS,
  VSCODE_APP_THEME_COLORS,
  VSCODE_TERMINAL_COLORS
} from './color-map.mjs'
import {
  blend,
  contrastRatio,
  flatten,
  isLightColor,
  parseCssColor,
  parseHex,
  readableColor,
  toHex
} from './color-math.mjs'
import { defaultRuleSettings, isRecord } from './theme-reading.mjs'

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
// Orca's contrast floors: text, git status names, focus rings, syntax colors.
const MIN_TEXT = 4.5
const MIN_STATUS = 3
const MIN_RING = 2
const MIN_SYNTAX = 3
// Orca ignores borders under this alpha, so a fully transparent one is no border choice at all.
const MIN_BORDER_ALPHA = 0.05
const BORDER_TOKENS = new Set([
  '--border',
  '--input',
  '--sidebar-border',
  '--worktree-sidebar-border',
  '--worktree-sidebar-active-border',
  '--split-divider',
  '--split-divider-hover'
])
const MAX_REPAIR_ROUNDS = 8
const ENGINE = '>=1.4.245'

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

function firstColor(colors, keys, token) {
  for (const key of keys) {
    const color = parseHex(colors[key])
    if (color && !(BORDER_TOKENS.has(token) && color[3] < MIN_BORDER_ALPHA)) {
      return color
    }
  }
  return null
}

function editorColors(theme) {
  const fallback = defaultRuleSettings(theme.tokenColors)
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

/** What a text-like token is read on, and the contrast Orca requires there. */
function readingOf(token) {
  if (token === '--foreground') {
    return { surfaces: ['--background', '--editor-surface'], min: MIN_TEXT }
  }
  if (token === '--muted-foreground') {
    return { surfaces: ['--background', '--editor-surface', '--muted'], min: MIN_TEXT }
  }
  // Hovered inactive tabs take the active text color.
  if (token === '--tab-active-foreground') {
    return { surfaces: ['--tab-active', '--tab-inactive'], min: MIN_TEXT }
  }
  if (token === '--text-link') {
    return { surfaces: ['--editor-surface'], min: MIN_TEXT }
  }
  if (token.startsWith('--git-decoration-')) {
    return { surfaces: ['--sidebar'], min: MIN_STATUS }
  }
  if (token === '--tab-active-indicator') {
    return { surfaces: ['--tab-active'], min: MIN_RING }
  }
  if (token.endsWith('-ring')) {
    const surface = token === '--ring' ? '--background' : token.slice(0, -'-ring'.length)
    return { surfaces: [surface], min: MIN_RING }
  }
  if (token.endsWith('-foreground')) {
    return { surfaces: [token.slice(0, -'-foreground'.length)], min: MIN_TEXT }
  }
  return null
}

/** A token's color as painted: translucent ones over the opaque token beneath them. */
function painted(token, tokens, depth = 0) {
  const color = parseCssColor(tokens[token] ?? '')
  if (!color || color[3] === 1 || depth > 4) {
    return color
  }
  const under = TRANSLUCENT_APP_THEME_TOKENS[token] ?? '--background'
  const base = painted(under, tokens, depth + 1) ?? parseCssColor(tokens['--background'] ?? '')
  return base ? flatten(color, base) : null
}

/** A readable color for `token` on every surface it is read on, closest to its current one. */
function readableFor(token, tokens) {
  const reading = readingOf(token)
  const current = painted(token, tokens)
  const surfaces = (reading?.surfaces ?? [])
    .map((surface) => painted(surface, tokens))
    .filter(Boolean)
  if (!reading || !current || surfaces.length === 0) {
    return null
  }
  const away = isLightColor(surfaces[0]) ? [0, 0, 0, 1] : [255, 255, 255, 1]
  for (const toward of [away, [0, 0, 0, 1], [255, 255, 255, 1]]) {
    for (let percent = 0; percent <= 100; percent += 5) {
      // Why the written hex: rounding can push a borderline color under the floor.
      const hex = toHex(blend(current, toward, percent))
      const written = parseHex(hex)
      if (surfaces.every((surface) => contrastRatio(written, surface) >= reading.min)) {
        return hex
      }
    }
  }
  return null
}

/** The text tokens read on `surface`, which can be made readable instead of losing it. */
function textOn(surface, accepted) {
  return [...accepted].filter((token) => readingOf(token)?.surfaces.includes(surface))
}

function droppedByOrca(tokens, base, orca) {
  const complete = orca.complete(tokens)
  const safe = orca.gate(complete, base)
  return {
    view: orca.effective ? orca.effective(complete, base) : complete,
    dropped: Object.keys(complete).filter((token) => !(token in safe))
  }
}

/**
 * Runs Orca's own contrast check and repairs what it would drop: a text color becomes the
 * nearest readable one, a surface keeps its color and its text is made readable, and a
 * translucent tint Orca drops is left to Orca. Returns the tokens and what still drops.
 */
function keptByOrcaContrast(tokens, base, orca) {
  let current = { ...tokens }
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
    const { view, dropped } = droppedByOrca(current, base, orca)
    if (dropped.length === 0) {
      break
    }
    const next = { ...current }
    for (const token of dropped) {
      // Why only present tokens: repairing a text the theme never set would freeze a derived
      // color (or replace Orca's status and link hues with grey).
      const texts = readingOf(token) ? [token] : textOn(token, orca.appTokens)
      for (const text of texts.filter((name) => name in view)) {
        const fixed = readableFor(text, { ...view, ...next })
        if (fixed) {
          next[text] = fixed
        }
      }
      if (!readingOf(token) && texts.length === 0 && token in next) {
        delete next[token]
      }
    }
    if (JSON.stringify(next) === JSON.stringify(current)) {
      break
    }
    current = next
  }
  return { tokens: current, dropped: droppedByOrca(current, base, orca).dropped }
}

// Monaco's own vs / vs-dark syntax colors, which Orca keeps only on an editor they read on.
const BUILT_IN_SYNTAX = {
  light: ['#008000', '#a31515', '#0000ff', '#008080', '#098658'],
  dark: ['#608b4e', '#ce9178', '#569cd6', '#3dc9b0', '#b5cea8']
}

/** Orca tokens for one theme, limited to what the target Orca accepts and keeps. */
export function appTokens(theme, orca, warnings = []) {
  const { background, foreground } = editorColors(theme)
  if (isLightColor(background) !== (theme.base === 'light')) {
    warnings.push(`${theme.label}: declared ${theme.base} but its editor background is not`)
  }
  const colors = {
    ...theme.colors,
    'editor.background': toHex(background),
    'editor.foreground': toHex(foreground)
  }
  const tokens = {}
  const entries = Object.entries(VSCODE_APP_THEME_COLORS).filter(([token]) =>
    orca.appTokens.has(token)
  )
  // Why surfaces first: a translucent text color is painted over its own surface.
  const isText = ([token]) => readingOf(token) !== null
  for (const [token, keys] of [...entries.filter((e) => !isText(e)), ...entries.filter(isText)]) {
    const color = firstColor(colors, keys, token)
    if (!color) {
      continue
    }
    const under =
      readingOf(token)?.surfaces.map((surface) => painted(surface, tokens)).find(Boolean) ??
      background
    // Why flatten: Orca needs opaque text and surfaces to check their contrast.
    tokens[token] = toHex(token in TRANSLUCENT_APP_THEME_TOKENS ? color : flatten(color, under))
  }
  const kept = keptByOrcaContrast(tokens, theme.base, orca)
  if (kept.dropped.length > 0) {
    warnings.push(`${theme.label}: Orca's contrast check still drops ${kept.dropped.join(', ')}`)
  }
  const editor = parseHex(kept.tokens['--editor-surface'] ?? kept.tokens['--background'])
  if (
    editor &&
    BUILT_IN_SYNTAX[theme.base].some((color) => contrastRatio(parseHex(color), editor) < MIN_SYNTAX)
  ) {
    warnings.push(`${theme.label}: Orca keeps its plain editor colors; the editor background is too mid-toned for its built-in code colors`)
  }
  return kept.tokens
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
 * dropped because Orca does not read them. With `editor` set, colors under Orca's 3:1 syntax
 * floor move toward the editor text until they pass, instead of falling back to built-ins.
 */
export function compactTokenColors(tokenColors, warnings, label, editor) {
  const byScope = new Map()
  let descendant = 0
  let lifted = 0
  for (const rule of tokenColors) {
    if (!isRecord(rule) || !isRecord(rule.settings)) {
      continue
    }
    let foreground = parseHex(rule.settings.foreground)
    if (foreground && editor) {
      foreground = flatten(foreground, editor.background)
      if (contrastRatio(foreground, editor.background) < MIN_SYNTAX) {
        foreground = readableColor(foreground, editor.background, MIN_SYNTAX, editor.foreground)
        lifted += 1
      }
    }
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
  if (lifted > 0) {
    warnings.push(`${label}: raised ${lifted} code colors to 3:1 contrast with the editor`)
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

function appThemeFile(theme, orca, warnings) {
  const tokens = appTokens(theme, orca, warnings)
  const editor = {
    background: parseHex(tokens['--editor-surface'] ?? tokens['--background']),
    foreground: parseHex(tokens['--foreground'])
  }
  const rules = compactTokenColors(theme.tokenColors, warnings, theme.label, editor)
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
    warnings.push(
      `${theme.label}: kept ${low} of ${rules.length} code color rules to fit Orca's limits`
    )
  }
  return render(low)
}

const ANSI = new Set(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'])
const isAnsi = (key) => ANSI.has(key.replace(/^bright(.)/, (_, first) => first.toLowerCase()))

function terminalPalette(theme, terminalKeys) {
  const editor = editorColors(theme)
  const background = flatten(
    firstColor(theme.colors, VSCODE_TERMINAL_COLORS.background) ?? editor.background,
    editor.background
  )
  const fallbacks = { background, foreground: editor.foreground }
  const palette = {}
  for (const key of terminalKeys) {
    const keys = VSCODE_TERMINAL_COLORS[key] ?? []
    const color = key === 'background' ? background : (firstColor(theme.colors, keys) ?? fallbacks[key])
    if (color) {
      // Why flatten: terminal palettes are opaque hex; VS Code paints alpha over the panel.
      palette[key] = toHex(flatten(color, background))
    }
  }
  return Object.keys(palette).some(isAnsi) ? palette : null
}

function slug(label, taken) {
  const cut = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
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
 * for each one with `terminal.ansi*` colors. `orca` is the target Orca's schema (see
 * orca-schema.mjs); `identity` is `{ publisher, id, name, license?, description?, repository?,
 * version? }`.
 */
export function renderThemePlugin(set, identity, orca) {
  const warnings = [...set.warnings]
  const files = {}
  const themes = []
  const terminalThemes = []
  const taken = new Set()
  for (const theme of set.themes) {
    const id = slug(theme.label, taken)
    files[`themes/${id}.json`] = appThemeFile(theme, orca, warnings)
    themes.push({ id, title: theme.label, path: `themes/${id}.json` })
    const palette = terminalPalette(theme, orca.terminalKeys)
    if (palette) {
      files[`terminal/${id}.json`] = json({ schemaVersion: 1, mode: theme.base, terminal: palette })
      terminalThemes.push({ id, title: theme.label, path: `terminal/${id}.json` })
    } else {
      warnings.push(`${theme.label}: no terminal theme; it sets no terminal.ansi* colors`)
    }
  }
  files['orca-plugin.json'] = json({
    manifestVersion: 2,
    id: identity.id,
    publisher: identity.publisher,
    name: identity.name,
    version: identity.version ?? '1.0.0',
    execution: 'data',
    description: identity.description ?? `${identity.name}, converted from a VS Code color theme.`,
    ...(identity.license ? { license: identity.license } : {}),
    ...(identity.repository ? { repository: identity.repository } : {}),
    engines: { orca: ENGINE },
    contributes: { themes, ...(terminalThemes.length ? { terminalThemes } : {}) },
    capabilities: []
  })
  return { files, warnings: [...new Set(warnings)] }
}
