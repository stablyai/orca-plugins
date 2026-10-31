# Import a VS Code color theme

Converts a VS Code color theme into an Orca theme plugin and checks it with Orca's own validator.
The input can be one theme file or an extension folder; for a folder, it reads every JSON color
theme listed in `package.json`. The output has an app theme for each VS Code theme, and a
terminal theme for each one that sets `terminal.ansi*` colors.

```sh
ORCA_DIR=/path/to/orca node tools/import-vscode-theme/import-vscode-theme.mjs \
  ./tokyo-night-vscode-theme ./plugins/tokyo-night-theme \
  --publisher stablyai --id orca-tokyo-night-theme --name "Tokyo Night for Orca" \
  --license MIT --source-url https://github.com/enkia/tokyo-night-vscode-theme
```

`ORCA_DIR` is an Orca checkout with dependencies installed (`pnpm install`, then
`pnpm run build:packages`), as for the catalog scripts. The tool reads Orca's public theme
tokens, terminal slots, token derivations and contrast check from it, writes only what that Orca
accepts, and repairs anything that Orca's contrast check would drop.

| Flag | Meaning |
| --- | --- |
| `--publisher` | Required. The manifest publisher. |
| `--id`, `--name`, `--description`, `--version`, `--repository` | Manifest fields. `--id` defaults to the output folder's name. |
| `--license` | SPDX id for the manifest's `license`. |
| `--license-file` | The upstream license to copy to `LICENSE`. Defaults to a `LICENSE` file next to the theme. |
| `--source-url` | Upstream `https` link for the README's attribution. |
| `--theme` | For an extension folder, convert only the themes with this label. Repeatable. |
| `--title` | `<VS Code label>=<title>`: retitle a theme. Theme ids derive from titles, so use it to keep an updated plugin's ids. Repeatable. |

The tool writes into a new or empty folder and never overwrites. If Orca's validator rejects
the result, it exits 2 and leaves the files in place.

## How colors map

- `color-map.mjs` is the only mapping table. For each Orca token it lists VS Code workbench keys,
  and the first key the theme sets wins (for example, `editor.background` fills `--background`
  and `--editor-surface`). Tokens with no row, or whose keys the theme leaves unset, are derived
  by Orca. When Orca adds a public token, add its row here.
- The diff, git decoration, tab, split divider, active workspace row, host badge, chat message
  and link tokens (`--diff-*`, `--git-decoration-*`, `--tab-*`, `--split-divider*`,
  `--worktree-sidebar-active*`, `--host-badge*`, `--chat-user-message`, `--text-link`) need Orca
  with [stablyai/orca#36578](https://github.com/stablyai/orca/pull/36578). With an older
  `ORCA_DIR` the tool leaves them out, so the result still validates there.
- Orca requires opaque text and surfaces, so translucent VS Code colors are painted onto the
  editor background. The borders, diff tints, active row, host badge and chat message tokens that
  Orca accepts translucent keep their alpha.
- The result is run through Orca's own contrast check, with Orca's own derivations for omitted
  tokens. Orca drops both colors of an unreadable text/surface pair, so the tool repairs what it
  would drop instead: a text color moves to the nearest readable one, and a surface keeps its
  color while its text is made readable. VS Code themes often use dim secondary text, so this
  is what keeps their backgrounds. Anything still dropped is reported as a warning.
- Fully transparent borders are skipped, so the next VS Code key (or Orca's default) applies.
- `tokenColors` carry over: each scope is kept once with its last style per property, as VS Code
  resolves it. A code color under 3:1 contrast with the editor, which Orca would replace with its
  built-in color, moves toward the editor text until it passes. Scopes with the same style share one rule, and the file is minified, then trimmed
  from the end, to fit Orca's 16 KiB theme-file limit.
- `include` files are flattened (the including theme wins), and a `"default"` color unsets an
  inherited one. Paths must stay inside the imported folder, including through symlinks.
- Dropped, with a warning: `semanticTokenColors`, descendant scope selectors (`a b`), `.tmTheme`
  files and string `tokenColors`.

Check the upstream license before publishing a converted theme, and keep its notice in the plugin.

## Tests

```sh
ORCA_DIR=/path/to/orca node --test "tools/**/*.test.mjs"
```

Without `ORCA_DIR`, the test against Orca's own contrast check is skipped.
