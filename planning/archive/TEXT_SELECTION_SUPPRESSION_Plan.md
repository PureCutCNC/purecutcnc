---
status: Done
created: 2026-05-29
---

# Text Selection Suppression Plan

## Goal

Prevent accidental page text selection while using desktop or tablet interactions, especially tablet long-press context-menu gestures, while preserving normal selection and editing behavior inside entry fields.

## Approach

- Add a global React-root selection policy in CSS: default app UI is non-selectable, including custom overlays rendered outside the app shell.
- Restore selectable/editable behavior for native entry fields and editable regions: `input`, `textarea`, `select`, and `[contenteditable]`.
- Add touch callout suppression for non-editable app UI with `-webkit-touch-callout: none`, again restoring the default behavior for entry fields.
- Check existing canvas/context-menu handlers after the CSS change. If Chrome still opens native long-press popups outside entry fields, add a narrowly scoped `contextmenu` guard on the app shell/root that prevents the browser-native menu only for non-editable targets and leaves custom app context menus working.

## Files affected

- `src/index.css` — define the app-wide non-selection/callout policy at `#root` so it covers overlays and menus outside `.app-shell`.
- `src/styles/layout.css` — remove the narrower app-shell-only policy if superseded by root-level rules.
- `src/components/layout/AppShell.tsx` or `src/App.tsx` — only if CSS is insufficient for Chrome long-press popups; add a scoped non-editable `contextmenu` guard.
- `src/components/layout/INDEX.md` or `src/INDEX.md` — only if behavior changes enough to warrant index maintenance.

## Tests

- Run `npm run build`.
- Manual desktop check: dragging/long-pressing labels, tree rows, toolbar buttons, context menu items, and canvas overlays does not create text selection; text can still be selected/edited in inputs and textareas.
- Manual tablet check: long-press context menu flow no longer selects page text; editable fields still allow cursor placement and text selection.

## Open questions / risks

- Browser/OS long-press UI cannot be fully controlled in every Chrome/iPad case. CSS `user-select` and `-webkit-touch-callout` should remove the common accidental selection/callout paths, but Chrome may still show platform UI for some editable or link-like targets.
- Suppressing native `contextmenu` too broadly can break app custom context menus, so any JavaScript guard must be scoped to non-editable targets and tested against the feature/tree context menu.

## Out of scope

- Redesigning the app context menu or long-press gesture.
- Changing text-selection behavior inside data-entry controls.
- Blocking browser UI inside editable controls, where text selection and clipboard actions are expected.
