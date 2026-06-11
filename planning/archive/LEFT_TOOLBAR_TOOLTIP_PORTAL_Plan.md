---
status: Done
created: 2026-06-11
---

# Left Toolbar Tooltip Portal Plan

## Goal

Restore mouse-over labels for the buttons in the left creation toolbar. The labels should render outside the scroll-clipped rail so hovering any visible left-toolbar button shows the tooltip beside the rail.

## Approach

- Reuse the existing toolbar button label source and hover/focus behavior, but render the tooltip through `createPortal` to `document.body` when it is visible.
- Position the floating tooltip from the button wrapper's `getBoundingClientRect()`, supporting the current `bottom` and `right` placements.
- Keep the tooltip non-interactive and update its position while visible on scroll or resize, matching the existing portaled popover behavior.
- Scope CSS changes to floating toolbar tooltips so regular button layout and popover menu behavior stay unchanged.

## Files affected

- `src/components/layout/Toolbar.tsx` — update toolbar action wrappers to portal and position tooltips outside scroll-clipped containers.
- `src/styles/layout.css` — add floating tooltip styling and keep existing non-floating tooltip behavior intact.

## Tests

- Run `npm run build` after implementation.
- Use the browser against the already-running app if available, or rely on static verification if no dev server is running, to confirm left-rail hover labels are no longer clipped.

## Open questions / risks

- No user decision needed. The main risk is tooltip flicker when moving across the rail; keeping hover/focus state on the button wrapper should avoid that.

## Out of scope

- No broader toolbar redesign.
- No changes to tablet-only `ToolRail` behavior.
- No changes to popover menu layout beyond preserving the existing portaled behavior.
