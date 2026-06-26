# INDEX — src/components/machine/

Machine definition editing UI. In-app editor for custom CNC machine definitions.

## Files
- `MachineDefinitionEditorDialog.tsx` — hybrid editor modal (focused form + raw JSON `DisclosureSection` + inline Zod validation). Handles both edit-existing and duplicate-then-edit entry points.
- `machineDefinitionForm.ts` — pure form↔`MachineDefinition` mapping/merge module. No React imports. Exports `toFormData`, `mergeFormData`, `joinLines`/`splitLines`, and `validateDef` (non-throwing Zod wrapper with user-friendly error formatting).

## Conventions
- The dialog reuses the `dialog-backdrop`/`dialog` modal pattern and `DisclosureSection` from `common/`.
- Form↔definition mapping is kept pure (no React) so it's unit-testable.
- Store mutations go through `projectStore` actions (`updateMachineDefinition`, `duplicateMachineDefinition` in `machineDefsSlice`).
- For CSS, see `src/styles/dialog.css` (`.machine-editor-*` classes).
