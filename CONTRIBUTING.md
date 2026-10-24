# Adding or updating a plugin

This repository is Orca's official plugin catalog. It does not hold plugin code. Each plugin
lives in its author's own Git repository, and `orca-catalog.json` pins every release to an exact
commit and a hash of its files. Orca refuses to install bytes that differ from what is listed.

The field reference is in Orca's
[catalog reference](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-catalog.md)
and the
[plugin author guide](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md).

## 1. Build and commit the plugin in your own repository

Use manifest format 2 (`"manifestVersion": 2`) and choose the lowest `execution` profile that
fits: `data` for themes, syntaxes and translations; `instructional` for commands, shortcuts and
recipes; `sandboxed-ui` for panels; `trusted-worker` only when you need code running in Orca.
Include a licence. Commit and push. The catalog lists a commit, not a working copy.

## 2. Run the validator on your plugin

From a checkout of [Orca](https://github.com/stablyai/orca) with dependencies installed
(`pnpm install`, then `pnpm run build:packages`):

```sh
pnpm validate:plugin /path/to/your-plugin
```

It checks the manifest and prints a catalog release entry for your committed `HEAD`: version,
full commit SHA, `contentHash`, execution profile, minimum Orca version, contribution types and
summary, capabilities and file types. Fix any error before going further.

## 3. Paste the printed release entry into `orca-catalog.json`

Paste the entry as printed. Don't write or edit these fields by hand: CI fetches your commit and
compares every field.

- **New plugin:** add an entry with `id` (`<publisher>.<id>` from your manifest), `source`
  (`kind: "git"`, an HTTPS or SSH `url`, and the `ref` you publish from), a `description`,
  `categories`, and `releases: [<printed entry>]`.
- **Update:** put the new release **first** in `releases` (newest first).
- **Raising `engines.orca`:** keep the previous release listed beneath the new one. Older Orca
  installs the first release it supports, so removing the old one leaves those users with
  nothing to install.

You may add display-only fields to a release: `changelog`, `updatedAt`, `license`, `homepage`,
`themePreview`, `images`.

## 4. Add a cover image (recommended)

Put images under `assets/<plugin id>/` and reference them from the release's `images`, with
`path`, `alt` text, `sha256`, `width` and `height`. Limits:

| Image | Formats | Size |
| --- | --- | --- |
| icon | PNG, WEBP, square | at least 128×128, at most 256 KB |
| cover | PNG, JPEG, WEBP | at least 800×500 (1600×1000 recommended), at most 1024 KB |
| screenshots (up to 6) | PNG, JPEG, WEBP | at least 1280×800, at most 1536 KB |

Images must be static, show the real plugin, and not imitate Orca's trust badges. CI fails on any
file under `assets/` that no release references.

## 5. Regenerate `orca-marketplace.json` and check locally

Orca builds released before catalog format 2 read only `orca-marketplace.json`. Don't edit it by
hand. Generate it, and run the same checks CI runs:

```sh
ORCA_DIR=/path/to/orca node scripts/check-catalog.mjs --write-legacy
ORCA_DIR=/path/to/orca node scripts/check-catalog.mjs
```

## 6. Open a pull request

CI validates the catalog with Orca's own validator and fetches every listed commit to recompute
its `contentHash`. It also checks images and that `orca-marketplace.json` is up to date. An
Orca maintainer then reviews the plugin against [REVIEW_POLICY.md](REVIEW_POLICY.md). Say in
the PR what the plugin does and, for anything above `data`, why it needs that profile.
