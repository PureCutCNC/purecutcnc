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
- `CreationActions.tsx` — feature/region creation target and shape picker group.
- `FeatureEditActions.tsx` — selected-feature transform/edit action group.
- `AlignmentActions.tsx` — align and distribute popover groups.
- `ShapeToolActions.tsx` — join/cut shape command group.
- `SketchEditActions.tsx` — in-feature sketch editing command group.
- `BackdropEditActions.tsx` — selected-backdrop transform/delete action group.
- `SnapActions.tsx` — snapping mode action group.
- `MeasureActions.tsx` — tape measure and dimension action group.
- `GlobalToolbar.tsx`, `CreationToolbar.tsx`, `Toolbar.tsx`, `SnapToolbar.tsx` — assembly components exported by the public barrel.
