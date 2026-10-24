# Review policy

## Who merges

At launch, only Orca maintainers merge into this repository. Every new plugin and every new
release needs a maintainer's review and a green CI run. No release is merged on CI alone.

## Checklist

CI proves that a release is the exact commit its author published and that the listing matches
the manifest. A reviewer checks what CI cannot:

- [ ] **Lowest execution profile that fits.** `data` for themes, syntaxes and translations;
      `instructional` for commands, shortcuts and recipes; `sandboxed-ui` only for panels;
      `trusted-worker` only when the plugin needs code running in Orca. Ask for a lower profile
      when the contributions allow it.
- [ ] **Capabilities are justified.** Each requested capability is explained and used.
- [ ] **No impersonation.** The name, publisher, description and images don't pose as Orca, as
      an "official" or "verified" plugin, or as another project or company the author doesn't
      represent. Only Orca maintainers publish under `stablyai` or use the `official` category.
- [ ] **Licence present.** The plugin repository has a licence file, and the manifest's
      `license` matches it.
- [ ] **Honest images.** Icons, covers and screenshots show the real plugin, with accurate alt
      text. No fake trust badges, ratings, download counts or Orca interface chrome that suggests
      endorsement.
- [ ] **No bundled binaries.** The release has no compiled executables, native modules, or
      obfuscated or minified code that can't be reviewed. Generated JavaScript is acceptable only
      when its source is in the same repository.
- [ ] **Extra scrutiny for `trusted-worker`.** These plugins run code with full access to the
      machine. Read the worker source, check what it sends over the network and what it runs,
      and confirm that the publisher is who they say they are. Re-review on every release, not
      just the first.
- [ ] **Updates.** A new release that raises its profile or asks for new capabilities is
      reviewed like a new plugin. Orca asks users to approve it again, but the catalog should not
      offer it unreviewed.

## Takedown

When a listed plugin turns out to be malicious, deceptive or broken:

1. Open a PR that removes its entry, or the bad releases, from `orca-catalog.json`, and
   regenerate `orca-marketplace.json`. This stops new installs.
2. Orca maintainers add the plugin's `<publisher>.<id>` to Orca's plugin kill list, served from
   `https://onorca.dev/plugins/kill-list.json`, with a short reason and optionally an advisory
   URL. Orca reads that list and disables copies that are already installed, which removing the
   catalog entry alone does not do.

Report a suspected malicious plugin privately to the Orca maintainers rather than in a public
issue.
