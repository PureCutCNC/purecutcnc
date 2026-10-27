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
- `CreationActions.tsx` — feature/region creation target and shape picker group. The creation drawer holds one rotary group with Thread/Flutes and Turn/Polygon (issue #1112 F/G). On a square blank's Around sheet the 2D drawing controls are hidden (the sheet is round-only, #1016 C2-U1/U2), but the drawer stays with the rotary group, because Turn and Polygon work on either bar shape. The separate desktop rotary toolbar group is gone.
- `RotaryPatternActions.tsx` — the Thread and Flutes entries inside the creation drawer's rotary group (and the tablet rail variant), shown only on an active Around face with a **round** bar: the unrolled sheet's raw coordinates describe a round bar, so a square blank does not offer them (#1016 C2-U2). Each entry only opens the dialog; the dialog host lives with Properties so closing the drawer cannot unmount it.
- `RotaryPatternDialog.tsx` — the Thread and Flutes dialog, one component for create and edit (issue #1112 F): creation calls `addRotaryPattern` once (one canned feature, no operation, no Tool field); the Properties "Edit thread…/Edit flutes…" path reopens it with the stored parameters and writes one `updateFeature` patch. Start/length are measured from the chuck end, and the module store plus `RotaryPatternDialogHost` (mounted once by AppShell) keep one open dialog across the creation drawer and Properties.
- `rotaryPatternDialogState.ts` — the module store behind that dialog: create/edit requests, the close action, and the registration of both canned-shape editors. Kept out of the component file so React Fast Refresh sees only components there.
- `RotarySolidActions.tsx` — the Turn and Polygon entries in the creation drawer's rotary group, plus the tablet rail variant (issue #1112 G). Both work on a round bar or a square blank, and both are offered only while the Around workflow is *available* (`aroundUnavailableReason`). Each entry only opens the dialog; the host lives with Properties so the drawer closing cannot unmount an open form.
- `RotarySolidDialog.tsx` — the Turn and Polygon dialog, one component for create and edit (issue #1112 G): creation calls `addRotarySolid` once (one canned model, no folder, no operation, no Tool field), and the Properties "Edit turn…/Edit polygon…" path reopens it with the stored parameters and writes one `updateFeature` patch that rebuilds the mesh. Start/length are measured from the chuck end; a Turn is the old Square to round target on a square blank. The module store plus `RotarySolidDialogHost` (mounted once by AppShell) keep one open dialog across the drawer and Properties, and drop a create form when its face, bar, units or document changes.
- `rotarySolidDialogState.ts` — the module store behind that dialog: create/edit requests, the close action, and the registration of both canned-shape editors. Kept out of the component file so React Fast Refresh sees only components there.
- `RotaryDirectionField.tsx` — the shared Right/Left physical-hand `Select` both dialogs render; carries a stable `rotary-dialog__direction` hook and an accessible group label (extracted to keep the dialog inside its line budget).
- `FeatureEditActions.tsx` — selected-feature transform/edit action group, including the one-shot Feature Distribution command.
- `AlignmentActions.tsx` — align and distribute popover groups.
- `ShapeToolActions.tsx` — join/cut shape command group.
- `BackdropEditActions.tsx` — selected-backdrop transform/delete action group.
- Sketch-edit tool modes no longer live in the rail; they moved into the Edit Sketch session panel (`src/components/canvas/EditSketchPanel.tsx`, issue #556).
- `SnapActions.tsx` — snapping mode action group.
- `MeasureActions.tsx` — tape measure and dimension action group.
- `GlobalToolbar.tsx`, `CreationToolbar.tsx`, `Toolbar.tsx`, `SnapToolbar.tsx` — assembly components exported by the public barrel.
- `../AppearanceControl.tsx` — shared Dark/Light/System selector rendered by desktop and tablet command bars.
