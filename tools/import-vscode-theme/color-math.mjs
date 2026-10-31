// Colors are [r, g, b, a]: sRGB channels 0-255 and alpha 0-1.

/** VS Code theme colors are hex: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. */
export function parseHex(value) {
  if (typeof value !== 'string') {
    return null
  }
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim())?.[1]
  if (!hex) {
    return null
  }
  const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex
  const channel = (index) => Number.parseInt(full.slice(index, index + 2), 16)
  return [channel(0), channel(2), channel(4), full.length === 8 ? channel(6) / 255 : 1]
}

function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') {
      depth += 1
    } else if (text[index] === ')') {
      depth -= 1
    } else if (text[index] === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts
}

/** The colors Orca's theme tokens hold: hex, or `color-mix(in srgb, a p%, b)` of them. */
export function parseCssColor(value) {
  const text = String(value).trim()
  const mix = /^color-mix\((.*)\)$/s.exec(text)?.[1]
  if (!mix) {
    return parseHex(text)
  }
  const [space, first, second] = splitTopLevel(mix)
  const weighted = /^(.*?)\s+([\d.]+)%$/s.exec(first ?? '')
  if (space !== 'in srgb' || !weighted || !second) {
    return null
  }
  const a = parseCssColor(weighted[1])
  const b = parseCssColor(second)
  const p = Number(weighted[2]) / 100
  return a && b ? [0, 1, 2, 3].map((index) => a[index] * p + b[index] * (1 - p)) : null
}

export function toHex([r, g, b, a]) {
  const byte = (value) => Math.round(value).toString(16).padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ''}`
}

/** Paints a translucent color onto an opaque one, as VS Code shows it. */
export function flatten([r, g, b, a], under) {
  return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a), 1]
}

/** `color` moved `percent`% of the way to `toward`. */
export function blend(color, toward, percent) {
  return flatten([toward[0], toward[1], toward[2], percent / 100], color)
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio of two opaque colors. */
export function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

export function isLightColor(color) {
  return luminance(color) > 0.4
}

/**
 * The closest color to `color` with at least `min` contrast on `surface`, moving toward `toward`
 * (default: black or white, whichever is farther from the surface). Null when none reaches it.
 */
export function readableColor(color, surface, min, toward) {
  const target = toward ?? (isLightColor(surface) ? [0, 0, 0, 1] : [255, 255, 255, 1])
  for (let percent = 0; percent <= 100; percent += 1) {
    // Why the written hex: rounding can push a borderline color under the floor.
    const candidate = parseHex(toHex(blend(color, target, percent)))
    if (contrastRatio(candidate, surface) >= min) {
      return candidate
    }
  }
  return null
}
