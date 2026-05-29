---
status: Done
created: 2026-05-29
---

# Context Menu Visibility Plan

## Goal

Keep the feature/tree context menu fully visible and selectable when it opens near the bottom or right edge of the viewport. The current positioning uses fixed size guesses, so the taller feature menu can extend below the window and hide actions.

## Approach

- Replace the hardcoded `window.innerHeight - 300` / width guess positioning with measured menu placement.
- Store the resolved menu position in component state and update it after the menu renders, using the actual `getBoundingClientRect()` size plus a small viewport padding.
- Recompute the position when the menu changes and on window resize while the menu is open.
- Add a CSS max-height / overflow fallback so the menu remains usable even on very short viewports.

## Files affected

- `src/App.tsx` — measure the context menu and clamp its fixed position inside the viewport.
- `src/styles/layout.css` — add viewport-height overflow protection for the context menu.

## Tests

- Run `npm run build` after implementation.
- Manual check: open the feature context menu near the bottom and right edges of the sketch canvas and confirm all items remain visible or scrollable.

## Open questions / risks

None.

## Out of scope

- Redesigning context menu contents, grouping, or visual style.
- Changing feature tree, tab, or clamp context menu actions.
