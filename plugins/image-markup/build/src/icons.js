// Toolbar icons: 24×24 strokes in the current colour.
const icon = (body) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const ICONS = {
  select: icon('<path d="M5 3.5 18.5 11l-6 1.8L9.7 19z"/>'),
  pen: icon('<path d="M3 16.5c2.4-5 4.4-5.6 6.4-2.1s4 3.6 6-.9S19 7.4 21 7.4"/>'),
  arrow: icon('<path d="M5 19 19 5"/><path d="M9 5h10v10"/>'),
  box: icon('<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/>'),
  ellipse: icon('<ellipse cx="12" cy="12" rx="9" ry="7"/>'),
  text: icon('<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>'),
  undo: icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  redo: icon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
  delete: icon('<path d="M4 7h16"/><path d="M6 7l1 13h10l1-13"/><path d="M9.5 7V4h5v3"/>'),
  clear: icon('<path d="m7 21-4-4L14 6l7 7-8 8z"/><path d="m10 10 7 7"/><path d="M13 21h8"/>'),
  zoomOut: icon('<path d="M6 12h12"/>'),
  zoomIn: icon('<path d="M6 12h12"/><path d="M12 6v12"/>'),
  copy: icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>')
}
