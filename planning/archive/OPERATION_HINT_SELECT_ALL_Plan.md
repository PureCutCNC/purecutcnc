---
status: Done
created: 2026-06-10
---

# Operation Hint "Select all" Plan

> **Process note:** this plan was written retroactively — implementation happened
> before the plan, violating the Plan → Approve → Implement loop. It is recorded
> here so scope and intent are still traceable. The user verified the result in
> the app on 2026-06-10, including tablet (no hover there — tapping the
> operation row arms the hint and "Select all").

## Goal

In the "Add operation" menu, when an operation row shows its validity hint
("This operation only accepts subtract features plus optional closed regions"),
let the user fix the selection in one click: a right-aligned **Select all**
button inside the hint line selects every feature the operation can act on.
The button appears only on the hovered row (or tap-armed row on touch),
matching the existing A1.3 hover-highlight behaviour.

## Approach

- New helper `selectAllCompatibleFeatureIds(project, kind)` in
  `operationValidity.ts`. It reuses `compatibleFeatureIdsForOperation` (the
  same list driving the A1.3 canvas highlight) but returns `[]` when selecting
  all of them together would itself be invalid — e.g. 3D Surface finish accepts
  exactly one model, so with two compatible models there is no unambiguous
  "all" and the button is not offered.
- `CAMPanel` computes `selectAllFeatureIds` per operation button (only while a
  hint is showing) and passes the store's existing `selectFeatures` action down
  as `onSelectFeatures`.
- `OperationAddMenu` tracks `hoveredOperationKind` (set alongside the existing
  highlight calls on mouse enter/leave and tap-expand) and renders the button
  in the hint row for that kind only, styled with the existing
  `cam-subtab--compact` button language.
- Clicking the button replaces the selection; the hint recomputes to `null`,
  the hint row disappears, and the row's Add/pass buttons enable.

## Files affected

- `src/components/cam/operationValidity.ts` — new exported helper
  `selectAllCompatibleFeatureIds`.
- `src/components/cam/operationValidity.test.ts` — unit tests for the helper.
- `src/components/cam/CAMPanel.tsx` — `operationButtons` entries gain
  `selectAllFeatureIds` (the 11 copy-pasted objects were collapsed into a local
  builder to add the field once); passes `selectFeatures` to the menu.
- `src/components/cam/OperationAddMenu.tsx` — hovered-row state; "Select all"
  button in the hint line.
- `src/styles/layout.css` — `.cam-operation-hint` becomes a flex row;
  `.cam-operation-hint__text` / `.cam-operation-hint__select-all` styles.

## Tests

- Unit tests for `selectAllCompatibleFeatureIds`: returns compatible ids when
  the combined selection is valid; returns `[]` when nothing is compatible;
  returns `[]` when individually-compatible features are jointly invalid
  (two models for `finish_surface`).

## Open questions / risks

- None blocking. UX detail: on touch the button appears after tap-expanding a
  row, mirroring the A1.5 tap-arm behaviour for the canvas highlight.

## Out of scope

- Partial selection (e.g. "select first model" for exactly-one-model kinds).
- Any change to quick-operation context menus or the canvas highlight itself.
