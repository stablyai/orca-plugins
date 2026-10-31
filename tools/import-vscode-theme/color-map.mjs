// The one mapping table from VS Code workbench colors to Orca theme tokens. For each token the
// first key the theme sets wins; tokens left out are derived by Orca. Add a row when Orca adds a
// public token. Rows for tokens the target Orca does not know yet are skipped at import time.

export const VSCODE_APP_THEME_COLORS = {
  '--background': ['editor.background'],
  '--editor-surface': ['editor.background'],
  '--foreground': ['editor.foreground', 'foreground'],
  '--card': ['editorGroupHeader.tabsBackground', 'panel.background'],
  '--popover': ['editorWidget.background', 'menu.background', 'quickInput.background'],
  '--popover-foreground': ['editorWidget.foreground', 'menu.foreground', 'quickInput.foreground'],
  '--primary': ['button.background'],
  '--primary-foreground': ['button.foreground'],
  '--secondary': ['button.secondaryBackground'],
  '--secondary-foreground': ['button.secondaryForeground'],
  '--muted': ['input.background'],
  '--muted-foreground': ['descriptionForeground', 'editorLineNumber.foreground'],
  '--accent': ['list.hoverBackground', 'list.inactiveSelectionBackground'],
  '--accent-foreground': ['list.hoverForeground'],
  '--border': ['panel.border', 'editorGroup.border', 'widget.border', 'contrastBorder'],
  '--input': ['input.border'],
  '--ring': ['focusBorder'],
  '--chart-1': ['charts.blue'],
  '--chart-2': ['charts.green'],
  '--chart-3': ['charts.yellow'],
  '--chart-4': ['charts.purple'],
  '--chart-5': ['charts.orange'],
  '--sidebar': ['sideBar.background'],
  '--sidebar-foreground': ['sideBar.foreground'],
  '--sidebar-border': ['sideBar.border'],
  // The tokens below need Orca with stablyai/orca#36578.
  '--worktree-sidebar-active': ['list.inactiveSelectionBackground'],
  '--worktree-sidebar-active-border': ['list.inactiveFocusOutline'],
  '--host-badge': ['badge.background'],
  '--host-badge-foreground': ['badge.foreground'],
  '--tab-bar': ['editorGroupHeader.tabsBackground'],
  '--tab-active': ['tab.activeBackground'],
  '--tab-active-foreground': ['tab.activeForeground'],
  '--tab-active-indicator': ['tab.activeBorderTop', 'tab.activeBorder'],
  '--tab-inactive': ['tab.inactiveBackground'],
  '--tab-inactive-foreground': ['tab.inactiveForeground'],
  '--split-divider': ['editorGroup.border'],
  '--split-divider-hover': ['sash.hoverBorder'],
  '--chat-user-message': ['chat.requestBackground'],
  '--text-link': ['textLink.foreground'],
  '--diff-added': ['gitDecoration.addedResourceForeground', 'editorGutter.addedBackground'],
  '--diff-added-background': [
    'diffEditor.insertedLineBackground',
    'diffEditor.insertedTextBackground'
  ],
  '--diff-added-emphasis': ['diffEditor.insertedTextBackground'],
  '--diff-added-gutter': ['diffEditorGutter.insertedLineBackground'],
  '--diff-removed': ['gitDecoration.deletedResourceForeground', 'editorGutter.deletedBackground'],
  '--diff-removed-background': [
    'diffEditor.removedLineBackground',
    'diffEditor.removedTextBackground'
  ],
  '--diff-removed-emphasis': ['diffEditor.removedTextBackground'],
  '--diff-removed-gutter': ['diffEditorGutter.removedLineBackground'],
  '--git-decoration-added': ['gitDecoration.addedResourceForeground'],
  '--git-decoration-modified': ['gitDecoration.modifiedResourceForeground'],
  '--git-decoration-deleted': ['gitDecoration.deletedResourceForeground'],
  '--git-decoration-renamed': ['gitDecoration.renamedResourceForeground'],
  '--git-decoration-untracked': ['gitDecoration.untrackedResourceForeground'],
  '--git-decoration-copied': ['gitDecoration.addedResourceForeground'],
  '--git-decoration-ignored': ['gitDecoration.ignoredResourceForeground']
}

/** Tokens Orca accepts translucent, with the opaque token each is painted over. Every other
 *  token must be opaque, so its translucent VS Code color is flattened onto the editor. */
export const TRANSLUCENT_APP_THEME_TOKENS = {
  '--border': '--background',
  '--input': '--background',
  '--sidebar-border': '--sidebar',
  '--worktree-sidebar-active': '--worktree-sidebar',
  '--worktree-sidebar-active-border': '--worktree-sidebar',
  '--host-badge': '--worktree-sidebar',
  '--split-divider': '--background',
  '--split-divider-hover': '--background',
  '--chat-user-message': '--background',
  '--diff-added-background': '--editor-surface',
  '--diff-added-emphasis': '--editor-surface',
  '--diff-added-gutter': '--editor-surface',
  '--diff-removed-background': '--editor-surface',
  '--diff-removed-emphasis': '--editor-surface',
  '--diff-removed-gutter': '--editor-surface'
}

/** VS Code keys for each terminal palette slot, first set wins; the editor colors fill in. */
export const VSCODE_TERMINAL_COLORS = {
  background: ['terminal.background', 'panel.background', 'editor.background'],
  foreground: ['terminal.foreground', 'editor.foreground', 'foreground'],
  cursor: ['terminalCursor.foreground', 'editorCursor.foreground'],
  cursorAccent: ['terminalCursor.background'],
  selectionBackground: ['terminal.selectionBackground', 'editor.selectionBackground'],
  selectionForeground: ['terminal.selectionForeground'],
  black: ['terminal.ansiBlack'],
  red: ['terminal.ansiRed'],
  green: ['terminal.ansiGreen'],
  yellow: ['terminal.ansiYellow'],
  blue: ['terminal.ansiBlue'],
  magenta: ['terminal.ansiMagenta'],
  cyan: ['terminal.ansiCyan'],
  white: ['terminal.ansiWhite'],
  brightBlack: ['terminal.ansiBrightBlack'],
  brightRed: ['terminal.ansiBrightRed'],
  brightGreen: ['terminal.ansiBrightGreen'],
  brightYellow: ['terminal.ansiBrightYellow'],
  brightBlue: ['terminal.ansiBrightBlue'],
  brightMagenta: ['terminal.ansiBrightMagenta'],
  brightCyan: ['terminal.ansiBrightCyan'],
  brightWhite: ['terminal.ansiBrightWhite']
}
