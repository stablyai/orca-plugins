# Material Icon Theme for Orca

Colorful file and folder icons from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) in Orca: about 470 file types and names, from TypeScript and Rust to Dockerfiles, lockfiles and CI configs, plus icons for common folders such as `src`, `docs`, `tests` and `.github`.

![Material Icons in Orca's file explorer with a dark theme](../../assets/orca-material-icons/dark.png)

![Material Icons (Light) with a light theme](../../assets/orca-material-icons/light.png)

## Use it

After installing it from **Settings → Plugins**, open **Settings → Appearance** and choose an **Icon theme**:

| Icon theme | Use with |
| --- | --- |
| Material Icons | Dark themes |
| Material Icons (Light) | Light themes. About 20 icons drawn in white for dark backgrounds, such as Next.js, Vercel, Bun, Deno, pnpm and TOML, switch to Material's dark versions so they show on white. |

## How files are matched

Orca looks up a file's exact name first (`package.json`, `Dockerfile`, `.gitignore`), then its longest known suffix (`.test.ts` before `.ts`). Names are matched without regard to case. Files with no match keep Orca's default file icon.

Folders are matched by their own name, with an open variant when expanded: `src`, `docs`, `test`, `tests`, `scripts`, `public`, `assets`, `components`, `lib`, `config`, `.github`, `node_modules`, `dist`, `build`, `.vscode`, `images`, `packages`, `api` and `utils`. Other folders use the plain folder icon. Folder icons need an Orca release newer than 1.4.245; older releases show the plain folder icon everywhere.

## Differences from Material Icon Theme

- **Common folders only.** Material has icons for thousands of folder names; this plugin maps the 19 most common ones above. Workspace root folders have no special icon.
- **A curated set.** Orca allows 512 mappings per icon theme, so this plugin covers the most common file names and extensions rather than all of Material's. A few of Material's icons are left out because they are drawn with SVG features Orca doesn't allow in icon files.

## Rebuilding

The icon themes are generated from a Material Icon Theme release by [`material-icons-build.py`](https://github.com/brennanb2025/orca-plugins/blob/main/tools/material-icons-build.py), which holds the curated lists of file names and extensions.

## License

An unofficial Orca port of [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme). MIT. Icons © Material Extensions; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
