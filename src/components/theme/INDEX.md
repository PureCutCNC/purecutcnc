# INDEX — src/components/theme/

Theme management UI: the manager dialog reached from the Appearance menu and the guided custom-theme editor. All state flows through `useTheme()` (see `src/theme/`); nothing here touches project data.

- `ThemeManagerDialog.tsx` — built-in + custom theme list with swatch previews; activate, duplicate, rename, edit, delete, reset-to-base, import, and export actions; System light/dark pairing controls.
- `ThemeEditorDialog.tsx` — guided editor: semantic color groups, live root preview (never persisted until Apply), contrast gate that blocks Apply on unreadable critical pairs, and a hardcoded-palette recovery bar that stays readable under any preview.
- `ThemeColorRow.tsx` — one editor field: native color input (alpha-preserving), normalized text value, base-value comparison chip, per-field reset.
- `ThemePreviewSamples.tsx` — representative preview states (panel text, controls, selection/focus, status messages, sketch-canvas annotations and semantic role colors).
- `ThemeSwatch.tsx` — small color strip rendered from a theme's own resolved values, used in lists and menus.
