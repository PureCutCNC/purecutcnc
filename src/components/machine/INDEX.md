# INDEX — src/components/machine/

Machine definition editing UI. In-app editor and manager for custom CNC machine definitions.

## Files
- `MachineDefinitionManagerDialog.tsx` — machine lifecycle manager dialog: list of definitions (name + Built-in/Custom badge + active highlight) on the left, selected machine details and actions on the right. Opened from the Properties panel via "Manage machines…". Actions: Use this machine, Edit (custom only), Duplicate to edit, Import JSON, Export JSON, Remove (custom only). Reuses `MachineDefinitionEditorDialog` for editing.
- `MachineDefinitionEditorDialog.tsx` — hybrid editor modal (focused form + raw JSON `DisclosureSection` + inline Zod validation + variable reference help). Portaled to `document.body` via `createPortal`.
- `machineDefinitionForm.ts` — pure form↔`MachineDefinition` mapping/merge module. No React imports. Exports `toFormData`, `mergeFormData`, `joinLines`/`splitLines`, and `validateDef` (non-throwing Zod wrapper with user-friendly error formatting).

## Conventions
- Dialogs reuse the `dialog-backdrop`/`dialog` modal pattern and `DisclosureSection` from `common/`.
- Form↔definition mapping is kept pure (no React) so it's unit-testable.
- Store mutations go through `projectStore` actions (`setSelectedMachineId`, `addMachineDefinition`, `updateMachineDefinition`, `duplicateMachineDefinition`, `removeMachineDefinition` in `machineDefsSlice`).
- For CSS, see `src/styles/dialog.css` (`.machine-editor-*`, `.machine-manager-*` classes) and `src/styles/tablet.css` (touch-target overrides).
