# Orca plugins

The official plugin catalog for [Orca](https://github.com/stablyai/orca), and the source of the
official plugins. Orca reads the catalog to show the plugins you can install from Settings →
Plugins.

| Path | What it is |
| --- | --- |
| `plugins/<name>/` | Official plugins, one directory each, with its own manifest and licence. |
| `orca-catalog.json` | Read by Orca builds that support catalog format 2. Each release is pinned to an exact commit and file hash. |
| `orca-marketplace.json` | Read by older Orca builds. Frozen: it keeps the original listings, which install from each plugin's old repository, including plugins later dropped from `orca-catalog.json` (such as Orca Navigation Shortcuts). |
| `legacy-v1-only.json` | The ids in `orca-marketplace.json` that the export does not produce. |
| `assets/` | Listing images referenced by releases. |
| `scripts/release-entry.mjs` | Prints and checks the catalog release of every plugin in `plugins/`. |
| `scripts/check-catalog.mjs` | Validates the catalog, every release, images and `orca-marketplace.json`. |

## Official plugins

| Plugin | Directory | What it adds |
| --- | --- | --- |
| Orca Midnight | `plugins/midnight-theme` | A dark app theme |
| Nord for Orca | `plugins/nord-theme` | A cool, low-contrast app theme |
| Orca OLED | `plugins/oled-theme` | A true-black app theme and terminal theme |
| Dusk & Ember Themes | `plugins/dusk-ember` | A dark and a light app theme, with matching terminal themes |
| GitHub Light for Orca | `plugins/github-light-theme` | A light app theme with matching syntax and terminal colors |
| Solarized Light for Orca | `plugins/solarized-light-theme` | A light app theme with matching syntax and terminal colors |
| Dracula for Orca | `plugins/dracula-theme` | A dark app theme with matching syntax and terminal colors |
| Gruvbox for Orca | `plugins/gruvbox-theme` | Dark and light app themes with matching syntax and terminal colors |
| Orca Minimal Icons | `plugins/minimal-icons` | A monochrome file icon theme |
| Solarized Terminal | `plugins/solarized-terminal` | Solarized Dark terminal colors |
| Gleam Language | `plugins/gleam` | Highlighting for `.gleam` files |
| Prisma Syntax | `plugins/prisma` | Prisma-aware highlighting for `.prisma` files |
| VHDL Syntax | `plugins/vhdl` | Highlighting for `.vhd`, `.vhdl`, `.vho` and `.vht` files |
| VCL Syntax | `plugins/vcl` | Highlighting for Varnish and Fastly `.vcl` files |
| QML Syntax | `plugins/qml` | Highlighting for Qt `.qml` and `qmldir` files |
| Taxi Timesheets Syntax | `plugins/taxi` | Highlighting for Taxi `.tks` timesheets |
| HTTP Request Files | `plugins/http` | Highlighting for `.http` and `.rest` request files |
| systemd Unit Files | `plugins/systemd` | Highlighting for systemd units and Podman Quadlet files |
| Excalidraw | `plugins/excalidraw` | An editor for `.excalidraw` diagrams |
| Word Document Viewer | `plugins/docx` | Read-only `.docx` pages with headers, footers, images and zoom |
| Image Markup | `plugins/image-markup` | Pen, arrow, box and text markup on images, saved editably into the file |
| Multipass VM Recipes | `plugins/multipass-recipes` | Disposable Multipass VM workspaces |

Community plugins live in their authors' own repositories. The catalog can list them, but their
code is not copied here.

- To add or update a plugin, see [CONTRIBUTING.md](CONTRIBUTING.md).
- To learn how plugins are reviewed and taken down, see [REVIEW_POLICY.md](REVIEW_POLICY.md).

Every pull request is checked by `.github/workflows/validate-catalog.yml`, which runs Orca's own
validator at a pinned Orca commit.

## Theme covers

The GitHub Light, Solarized Light, Dracula, and Gruvbox covers use the same editor-preview
layout. Their app, syntax, and terminal colors come directly from the plugin JSON files.
With `agent-browser` and Chromium installed, regenerate them with:

```sh
node scripts/render-theme-covers.mjs
```

These are illustrative theme previews, rather than captured Orca sessions.
