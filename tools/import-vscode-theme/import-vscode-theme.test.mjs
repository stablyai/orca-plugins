// Run with: node --test tools/
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { VSCODE_APP_THEME_COLORS } from './color-map.mjs'
import { compactTokenColors, renderThemePlugin } from './theme-conversion.mjs'
import { parseJsonc, readVscodeThemes, ThemeReadError } from './theme-reading.mjs'

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function folder(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-vscode-theme-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text)
  }
  return dir
}

const identity = { publisher: 'acme', id: 'night', name: 'Night' }
const orca = {
  appTokens: new Set(Object.keys(VSCODE_APP_THEME_COLORS)),
  terminalKeys: ['background', 'foreground', 'selectionBackground', 'red']
}

describe('VS Code theme import', () => {
  it('flattens includes, maps workbench colors and emits a terminal theme', () => {
    const dir = folder({
      'package.json': JSON.stringify({
        displayName: 'Night',
        contributes: { themes: [{ label: 'Night', uiTheme: 'vs-dark', path: './night.json' }] }
      }),
      'base.json': `{
        // shared colors
        "colors": { "editor.background": "#101010", "button.background": "#ff000080", },
        "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#888888" } }],
      }`,
      'night.json': JSON.stringify({
        include: './base.json',
        colors: {
          'editor.foreground': '#eeeeee',
          'panel.border': '#ffffff20',
          'diffEditor.insertedLineBackground': '#00ff0033',
          'terminal.ansiRed': '#ff5555',
          'terminal.selectionBackground': '#ffffff40'
        },
        tokenColors: [{ scope: 'comment', settings: { fontStyle: 'italic' } }],
        semanticTokenColors: { variable: '#ffffff' }
      })
    })
    const set = readVscodeThemes(dir)
    assert.equal(set.name, 'Night')
    assert.match(set.warnings.join('\n'), /semanticTokenColors/)
    const plugin = renderThemePlugin(set, identity, orca)
    const app = JSON.parse(plugin.files['themes/night.json'])
    assert.equal(app.base, 'dark')
    // Translucent fills are painted onto the editor; borders and diff tints keep their alpha.
    assert.deepEqual(
      [app.tokens['--background'], app.tokens['--primary'], app.tokens['--border']],
      ['#101010', '#880808', '#ffffff20']
    )
    assert.equal(app.tokens['--diff-added-background'], '#00ff0033')
    assert.deepEqual(app.tokenColors, [
      { scope: 'comment', settings: { foreground: '#888888', fontStyle: 'italic' } }
    ])
    assert.deepEqual(JSON.parse(plugin.files['terminal/night.json']).terminal, {
      background: '#101010',
      foreground: '#eeeeee',
      selectionBackground: '#4c4c4c',
      red: '#ff5555'
    })
  })

  it('writes only tokens the target Orca accepts', () => {
    const dir = folder({
      'theme.json': JSON.stringify({ type: 'dark', colors: { 'textLink.foreground': '#88ccff' } })
    })
    const set = readVscodeThemes(path.join(dir, 'theme.json'))
    const older = { ...orca, appTokens: new Set(['--background', '--foreground']) }
    const tokens = (schema) =>
      JSON.parse(renderThemePlugin(set, identity, schema).files['themes/theme.json']).tokens
    assert.equal(tokens(orca)['--text-link'], '#88ccff')
    assert.deepEqual(Object.keys(tokens(older)).sort(), ['--background', '--foreground'])
  })

  it('reads localized labels, legacy settings rules and an untyped light theme', () => {
    const label = 'An Extremely Long Theme Label That Keeps Going And Going Past Every Limit'
    const dir = folder({
      'package.json': JSON.stringify({
        contributes: {
          themes: [
            { label: '%light.label%', path: './light.json' },
            { label, path: './long.json' },
            { label: 'Legacy', path: './legacy.tmTheme' }
          ]
        }
      }),
      'package.nls.json': JSON.stringify({ 'light.label': 'Paper' }),
      'light.json': JSON.stringify({
        colors: { 'editor.background': '#fff', 'terminal.ansiRed': '#c00000' },
        settings: [{ scope: 'comment', settings: { foreground: '#008000' } }]
      }),
      'long.json': JSON.stringify({ type: 'dark', colors: { 'terminal.ansiRed': '#ff5555' } })
    })
    const set = readVscodeThemes(dir)
    assert.deepEqual(
      set.themes.map((theme) => [theme.label, theme.base]),
      [
        ['Paper', 'light'],
        [label, 'dark']
      ]
    )
    assert.match(set.warnings.join('\n'), /legacy\.tmTheme: skipped/)
    const plugin = renderThemePlugin(set, identity, orca)
    assert.deepEqual(JSON.parse(plugin.files['themes/paper.json']).tokenColors, [
      { scope: 'comment', settings: { foreground: '#008000' } }
    ])
    const { contributes } = JSON.parse(plugin.files['orca-plugin.json'])
    assert.equal(contributes.terminalThemes.length, 2)
    for (const entry of [...contributes.themes, ...contributes.terminalThemes]) {
      assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      assert.ok(entry.id.length <= 64)
    }
  })

  it('leaves dim text to Orca so its contrast check keeps the surface', () => {
    const dir = folder({
      'theme.json': JSON.stringify({
        type: 'light',
        colors: {
          'editor.background': '#e6e7ed',
          'editor.foreground': '#343b58',
          descriptionForeground: '#9699a3'
        }
      })
    })
    const plugin = renderThemePlugin(readVscodeThemes(path.join(dir, 'theme.json')), identity, orca)
    const { tokens } = JSON.parse(plugin.files['themes/theme.json'])
    assert.equal(tokens['--background'], '#e6e7ed')
    assert.notEqual(tokens['--muted-foreground'], '#9699a3')
  })

  it('refuses an include outside the imported folder', () => {
    const dir = folder({ 'theme.json': JSON.stringify({ include: '../elsewhere.json' }) })
    assert.throws(() => readVscodeThemes(path.join(dir, 'theme.json')), ThemeReadError)
  })

  it('keeps the last style of each scope and drops descendant selectors', () => {
    const warnings = []
    const rules = compactTokenColors(
      [
        { name: 'defaults', settings: { foreground: '#ffffff', background: '#000000' } },
        { scope: 'string, keyword', settings: { foreground: '#00ff00' } },
        { scope: ['keyword', 'meta.tag string'], settings: { foreground: '#ff0000' } }
      ],
      warnings,
      'Night'
    )
    assert.deepEqual(rules, [
      { scope: 'string', settings: { foreground: '#00ff00' } },
      { scope: 'keyword', settings: { foreground: '#ff0000' } }
    ])
    assert.deepEqual(warnings, ['Night: dropped 1 descendant scope selectors Orca does not read'])
  })

  it('parses JSONC without touching strings', () => {
    assert.deepEqual(parseJsonc('{ "a": "x // y, }", /* c */ "b": [1, 2,], }'), {
      a: 'x // y, }',
      b: [1, 2]
    })
  })
})
