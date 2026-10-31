// Reads VS Code color themes: one theme file, or every JSON color theme an extension contributes.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { isLightColor, parseHex } from './color-math.mjs'

// Why bounded: an include chain is a handful of files; a cycle or a huge file is a broken input.
const MAX_INCLUDE_DEPTH = 8
const MAX_THEME_FILE_BYTES = 4 * 1024 * 1024
const MAX_TITLE_LENGTH = 128
// Orca's per-plugin limit on app themes.
const MAX_THEMES = 64

export class ThemeReadError extends Error {}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON with comments and trailing commas, as VS Code reads theme files. */
export function parseJsonc(source) {
  // Why: VS Code strips a byte-order mark; JSON.parse rejects it.
  const text = source.replace(/^\uFEFF/, '')
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === '\\') {
        out += text[++index] ?? ''
      } else if (char === '"') {
        inString = false
      }
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1
      }
      out += '\n'
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end === -1) {
        throw new SyntaxError('unterminated /* comment')
      }
      index = end + 1
      out += ' '
    } else {
      out += char
    }
  }
  return JSON.parse(withoutTrailingCommas(out))
}

function withoutTrailingCommas(text) {
  const closer = /\s*[}\]]/y
  const closes = (index) => {
    closer.lastIndex = index
    return closer.test(text)
  }
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === '\\') {
        out += text[++index] ?? ''
      } else if (char === '"') {
        inString = false
      }
    } else if (char === ',' && closes(index + 1)) {
      continue
    } else {
      inString = char === '"'
      out += char
    }
  }
  return out
}

function readJsonc(file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new ThemeReadError(`${file} does not exist`)
  }
  if (statSync(file).size > MAX_THEME_FILE_BYTES) {
    throw new ThemeReadError(`${file} is larger than 4 MiB`)
  }
  try {
    return parseJsonc(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ThemeReadError(`${file} is not valid JSON: ${error.message}`)
  }
}

/** A file the theme names, kept inside the imported folder after following symlinks. */
export function containedFile(root, from, name) {
  const target = path.resolve(path.dirname(from), name)
  const real = existsSync(target) ? realpathSync(target) : target
  const inside = path.relative(root, real)
  if (
    inside === '' ||
    inside === '..' ||
    inside.startsWith(`..${path.sep}`) ||
    path.isAbsolute(inside)
  ) {
    throw new ThemeReadError(`${name} points outside ${root}`)
  }
  return real
}

/** Plain text for a manifest title: no control or format (bidi, zero-width) characters. */
function cleanTitle(value) {
  if (typeof value !== 'string') {
    return null
  }
  return (
    value
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .trim()
      .slice(0, MAX_TITLE_LENGTH) || null
  )
}

function readThemeFile(root, file, warnings, chain = []) {
  if (chain.includes(file) || chain.length >= MAX_INCLUDE_DEPTH) {
    throw new ThemeReadError(`${path.basename(file)}: include chain is circular or too deep`)
  }
  const value = readJsonc(file)
  if (!isRecord(value)) {
    throw new ThemeReadError(`${path.basename(file)} is not a color theme`)
  }
  const included =
    typeof value.include === 'string'
      ? readThemeFile(root, containedFile(root, file, value.include), warnings, [...chain, file])
      : { colors: {}, tokenColors: [] }
  const colors = { ...included.colors }
  if (isRecord(value.colors)) {
    for (const [key, color] of Object.entries(value.colors)) {
      // Why "default": VS Code reads it as "unset what an included theme set".
      if (color === 'default') {
        delete colors[key]
      } else if (typeof color === 'string') {
        colors[key] = color
      }
    }
  }
  // Why `settings` too: older themes keep their TextMate rules under that key.
  const rules = Array.isArray(value.tokenColors)
    ? value.tokenColors
    : Array.isArray(value.settings)
      ? value.settings
      : []
  if (typeof value.tokenColors === 'string') {
    warnings.push(
      `${path.basename(file)}: skipped tokenColors from ${value.tokenColors}; .tmTheme files are not read`
    )
  }
  if (value.semanticTokenColors !== undefined) {
    warnings.push(`${path.basename(file)}: dropped semanticTokenColors; Orca reads only tokenColors`)
  }
  return {
    name: value.name ?? included.name,
    type: value.type ?? included.type,
    colors,
    // Why included first: the including theme's rules come later and win, as in VS Code.
    tokenColors: [...included.tokenColors, ...rules]
  }
}

function declaredBase(type) {
  if (['light', 'hcLight', 'vs', 'hc-light'].includes(type)) {
    return 'light'
  }
  if (['dark', 'hc', 'vs-dark', 'hc-black'].includes(type)) {
    return 'dark'
  }
  return null
}

/** The scope-less rules VS Code themes use for the editor's default colors; later ones win. */
export function defaultRuleSettings(tokenColors) {
  return Object.assign(
    {},
    ...tokenColors
      .filter((rule) => isRecord(rule) && rule.scope === undefined && isRecord(rule.settings))
      .map((rule) => rule.settings)
  )
}

/** For an untyped theme: light when its editor background is; VS Code's own fallback is dark. */
function guessedBase(theme) {
  const background =
    parseHex(theme.colors['editor.background']) ??
    parseHex(defaultRuleSettings(theme.tokenColors).background)
  return background && isLightColor(background) ? 'light' : 'dark'
}

function themeFrom(root, file, warnings, contributed = {}) {
  const theme = readThemeFile(root, file, warnings)
  return {
    label:
      cleanTitle(contributed.label) ??
      cleanTitle(theme.name) ??
      path.basename(file, path.extname(file)),
    base: declaredBase(contributed.uiTheme) ?? declaredBase(theme.type) ?? guessedBase(theme),
    colors: theme.colors,
    tokenColors: theme.tokenColors
  }
}

/** Resolves `%key%` placeholders from the extension's package.nls.json. */
function nlsResolver(dir, warnings) {
  const file = path.join(dir, 'package.nls.json')
  let strings = {}
  try {
    strings = existsSync(file) ? readJsonc(file) : {}
  } catch (error) {
    warnings.push(`${error.message}; labels keep their placeholders`)
  }
  return (value) => {
    const key = typeof value === 'string' ? /^%(.+)%$/.exec(value)?.[1] : undefined
    if (key === undefined) {
      return value
    }
    return typeof strings?.[key] === 'string' ? strings[key] : null
  }
}

/**
 * Reads a VS Code theme file, or every JSON color theme an extension folder contributes (only
 * the labels in `only`, when given). Returns `{ name?, root, themes: [{ label, base, colors, tokenColors }], warnings }`.
 */
export function readVscodeThemes(source, { only } = {}) {
  const resolved = path.resolve(source)
  if (!existsSync(resolved)) {
    throw new ThemeReadError(`${source} does not exist`)
  }
  const real = realpathSync(resolved)
  const warnings = []
  if (!statSync(real).isDirectory()) {
    const root = path.dirname(real)
    return { root, themes: [themeFrom(root, real, warnings)], warnings }
  }
  const manifestFile = path.join(real, 'package.json')
  const pkg = readJsonc(manifestFile)
  const entries = (Array.isArray(pkg?.contributes?.themes) ? pkg.contributes.themes : []).filter(
    (entry) => isRecord(entry) && typeof entry.path === 'string'
  )
  const localized = nlsResolver(real, warnings)
  const themes = []
  for (const entry of entries) {
    const label = localized(entry.label)
    if (only && !only.has(label)) {
      continue
    }
    if (themes.length === MAX_THEMES) {
      warnings.push(`kept the first ${MAX_THEMES} themes; a plugin holds at most that many`)
      break
    }
    if (path.extname(entry.path).toLowerCase() !== '.json') {
      warnings.push(`${entry.path}: skipped; only JSON color themes are read, not .tmTheme`)
      continue
    }
    try {
      const file = containedFile(real, manifestFile, entry.path)
      themes.push(themeFrom(real, file, warnings, { ...entry, label }))
    } catch (error) {
      if (!(error instanceof ThemeReadError)) {
        throw error
      }
      warnings.push(`${entry.path}: skipped; ${error.message}`)
    }
  }
  if (themes.length === 0) {
    throw new ThemeReadError(`${manifestFile} contributes no readable JSON color themes`)
  }
  const name = isRecord(pkg) ? cleanTitle(localized(pkg.displayName)) : null
  return { ...(name ? { name } : {}), root: real, themes, warnings }
}
