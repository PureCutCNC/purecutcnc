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
- `CreationActions.tsx` — feature/region creation target and shape picker group. The creation drawer holds one rotary group with Thread/Flutes and Turn/Polygon (issue #1112 F/G). **Nothing in the drawer is hidden any more** (issue #1112 rt3-d item 31): an entry that cannot do the work stays in place, disabled with its reason. On a square blank's Around sheet the creation targets and shape rows that would cut that round-only sheet (a feature, a line, text, every canned outline) are disabled with `sketch.creation.squareBarUnavailable`, while the two that never cut it — a region (a filter on a rotary operation, #1096) and a construction line — stay live, and Turn/Polygon are untouched because they work on either bar shape (`aroundSheetTargetRefused`/`aroundSheetAuthoringRefused` in `store/helpers/activeFace.ts` are the whole rule, decision 17). Text and Gear are features, so off the feature target they are listed and disabled with `sketch.creation.featureTargetOnly` instead of being filtered out of the row set. The group itself follows the bar workflow rather than the Around face (issue #1112 rt2-b item 20): on Top and Bottom of a bar project Turn and Polygon are offered, and the tablet rail renders the group only on Around. The separate desktop rotary toolbar group is gone.
- `RotaryPatternActions.tsx` — the Thread and Flutes entries inside the creation drawer's rotary group (and the tablet rail variant). They work only on an active Around face, and the reason the drawer shows says which requirement is missing, most fundamental first (issue #1112 rt3-d item 31): no bar at all (a block project) → `sketch.creation.rotaryBarUnavailable`; a bar but another face → `sketch.creation.aroundFaceOnly`; an Around face on a square blank, whose unrolled sheet's raw coordinates describe a round bar → `sketch.creation.squareBarUnavailable` (issue #1016 C2-U2, decision 17). None of them hides the entry. The tablet rail renders the group only on Around, so there the square-blank refusal is the only one it can show. Each entry arms the canvas creation panel through `startAddRotaryPatternPlacement`; the panel lives in the canvas, so closing the drawer cannot unmount it and no modal is involved (issue #1112 rt2-b).
- `RotarySolidActions.tsx` — the Turn and Polygon entries in the creation drawer's rotary group, plus the tablet rail variant (issue #1112 G). Turn has its own icon since R2 item 15 (`assets/icons/turn.svg`: a turned part's side view on a dash-dot centreline, wide left / curved neck / narrow right) and Polygon has its own since rt3-d item 32 (`assets/icons/hex.svg`: a hexagonal bar section with its flat edges visible on the same centreline) instead of both borrowing outline shapes; `turnIcon.test.ts` and `hexIcon.test.ts` pin the artwork, the sprite symbols and the command icon ids. Both work on a round bar or a square blank, and both are offered while the bar workflow is *available* (`aroundUnavailableReason`) on **any** face — a Turn/Polygon belongs to the bar, so Top and Bottom offer them too (issue #1112 rt2-b item 20). A block offers neither, and since rt3-d item 31 the drawer shows them disabled with `sketch.creation.rotaryBarUnavailable` rather than hiding them. Each entry arms the canvas creation panel (`startAddRotarySolidPlacement`), so the drawer closing cannot unmount an open form.
- `FeatureEditActions.tsx` — selected-feature transform/edit action group, including the one-shot Feature Distribution command.
- `AlignmentActions.tsx` — align and distribute popover groups.
- `ShapeToolActions.tsx` — join/cut shape command group.
- `BackdropEditActions.tsx` — selected-backdrop transform/delete action group.
- Sketch-edit tool modes no longer live in the rail; they moved into the Edit Sketch session panel (`src/components/canvas/EditSketchPanel.tsx`, issue #556).
- `SnapActions.tsx` — snapping mode action group.
- `MeasureActions.tsx` — tape measure and dimension action group.
- `GlobalToolbar.tsx`, `CreationToolbar.tsx`, `Toolbar.tsx`, `SnapToolbar.tsx` — assembly components exported by the public barrel.
- `../AppearanceControl.tsx` — shared Dark/Light/System selector rendered by desktop and tablet command bars.
