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
- `CreationActions.tsx` — feature/region creation target and shape picker group. On a square blank's Around sheet the 2D drawing controls are hidden (the sheet is round-only, #1016 C2-U1/U2) and only the one-shot solid entries remain.
- `RotaryPatternActions.tsx` — the Thread and Flutes entries (desktop toolbar and tablet rail variants), shown only on an active Around face with a **round** bar: the unrolled sheet's raw coordinates describe a round bar, so a square blank does not offer them (#1016 C2-U2).
- `RotaryPatternDialog.tsx` — the Thread and Flutes parameter dialogs; validates locally and calls `addRotaryPattern` once.
- `RotarySolidActions.tsx` — the one-shot Around solids (#1016 C2-U2): Polygon / hex on a round bar and Square to round on a square blank. Exactly one entry is offered at a time, keyed on the bar's shape, and only while the Around workflow is *available* (`aroundUnavailableReason`) — a loaded non-rotary file that retained an Around setup and a bar offers nothing the store would refuse (#1016 C2-U2F). The entry and its dialog unmount with the face or with any change to the physical context the form was opened against (units, bar shape/axis/size/origin, setup, project load — one key from `solidContextSignature`), so a half-filled form can neither be resurrected nor post numbers measured against an older bar. Desktop toolbar and tablet rail variants.
- `RotarySolidDialog.tsx` — the Polygon and Square-to-round form for `addRotarySolid` (#1016 C2-U2). One discriminated form; it maps a chuck-end start/length into absolute stock-space endpoints (X from `minX`, Y from `maxY`), validates the across-flats ceiling and the finished-diameter bound locally, and shows a typed store refusal as real text. Defaults are the stock's exact round-tripping numbers (never four-decimal rounded past the bar's own bound, #1016 C2-U2F). It autofocuses Start, traps Tab/Shift+Tab inside the frame, lets an open picker own the first Escape, and returns focus to the canvas on close; a field or tool edit clears a stale store refusal, and Create re-checks the context signature before calling the store. No parameter block is stored.
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
