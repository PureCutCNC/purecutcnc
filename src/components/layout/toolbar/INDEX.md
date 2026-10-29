# INDEX — src/components/layout/toolbar/

Toolbar internals split out from `src/components/layout/Toolbar.tsx`. The parent `Toolbar.tsx` file remains the public import barrel for existing callers.

## Files

- `shared.ts` — shared toolbar prop types, popover option types, creation shape constants, and hover delay constants.
- `primitives.tsx` — low-level tooltip/action button primitives used by toolbar groups.
- `useToolbarState.ts` — state and command wiring consumed by the toolbar assemblies.
- `ToolbarPopoverMenu.tsx` — portaled hover/click popover menu used by grouped commands.
- `ToolbarDialog.tsx` — portaled new/import/text dialogs launched by toolbar commands.
- `ProjectNameControl.tsx` — project name and dirty-state control.
- `GlobalActions.tsx` — file/history/zoom action group.
- `CreationActions.tsx` — feature/region creation target and shape picker group. The creation drawer holds one rotary group with Thread/Flutes and Turn/Polygon (issue #1112 F/G). On a square blank's Around sheet every entry stays listed (issue #1112 decision 17): the creation targets and shape rows that would cut that round-only sheet (a feature, a line, text, every canned outline) are disabled with `sketch.creation.squareBarUnavailable` instead of vanishing, while the two that never cut it — a region (a filter on a rotary operation, #1096) and a construction line — stay live, and Turn/Polygon are untouched because they work on either bar shape. `aroundSheetTargetRefused`/`aroundSheetAuthoringRefused` (`store/helpers/activeFace.ts`) are the whole rule. The group itself follows the bar workflow rather than the Around face (issue #1112 rt2-b item 20): on Top and Bottom of a bar project Turn and Polygon are offered, and Thread/Flutes hide themselves off Around. The separate desktop rotary toolbar group is gone.
- `RotaryPatternActions.tsx` — the Thread and Flutes entries inside the creation drawer's rotary group (and the tablet rail variant), shown only on an active Around face. With a **round** bar they are live; on a square blank the unrolled sheet's raw coordinates describe a round bar, so they are listed and disabled with the same `sketch.creation.squareBarUnavailable` reason rather than hidden (issue #1016 C2-U2, issue #1112 decision 17). Each entry arms the canvas creation panel through `startAddRotaryPatternPlacement`; the panel lives in the canvas, so closing the drawer cannot unmount it and no modal is involved (issue #1112 rt2-b).
- `RotarySolidActions.tsx` — the Turn and Polygon entries in the creation drawer's rotary group, plus the tablet rail variant (issue #1112 G). Turn has its own icon since R2 item 15 (`assets/icons/turn.svg`: a turned part's side view on a dash-dot centreline, wide left / curved neck / narrow right) instead of borrowing the rounded rectangle; `turnIcon.test.ts` pins the artwork, its sprite symbol and the command's icon id. Both work on a round bar or a square blank, and both are offered while the bar workflow is *available* (`aroundUnavailableReason`) on **any** face — a Turn/Polygon belongs to the bar, so Top and Bottom offer them too (issue #1112 rt2-b item 20), while a block offers neither. Each entry arms the canvas creation panel (`startAddRotarySolidPlacement`), so the drawer closing cannot unmount an open form.
- `FeatureEditActions.tsx` — selected-feature transform/edit action group, including the one-shot Feature Distribution command.
- `AlignmentActions.tsx` — align and distribute popover groups.
- `ShapeToolActions.tsx` — join/cut shape command group.
- `BackdropEditActions.tsx` — selected-backdrop transform/delete action group.
- Sketch-edit tool modes no longer live in the rail; they moved into the Edit Sketch session panel (`src/components/canvas/EditSketchPanel.tsx`, issue #556).
- `SnapActions.tsx` — snapping mode action group.
- `MeasureActions.tsx` — tape measure and dimension action group.
- `GlobalToolbar.tsx`, `CreationToolbar.tsx`, `Toolbar.tsx`, `SnapToolbar.tsx` — assembly components exported by the public barrel.
- `../AppearanceControl.tsx` — shared Dark/Light/System selector rendered by desktop and tablet command bars.
