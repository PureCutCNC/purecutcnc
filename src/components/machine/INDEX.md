# INDEX — src/components/machine/

Machine definition UI. Manager, editor, and the project-snapshot update notice.

The list these dialogs edit is the **application** machine library
([`src/machine/`](../../machine/INDEX.md)): built-in machines from the current
build plus **My Machines**. A project stores only the single definition
selected for it, so library CRUD here never edits a project — copying a
definition into the project is always the explicit "Use this machine" /
"Update project copy" action.

## Files
- `MachineDefinitionManagerDialog.tsx` — machine lifecycle manager dialog. Left column lists the library grouped into Built-in machines / My Machines, plus an "In this project" row when the project's embedded machine is not in the library. Right column shows the previewed machine and its actions: Use this machine, Update project copy (when the library copy differs from the project's), Save to My Machines (for a project-only machine), Edit (custom only), Duplicate to edit, Import/Export machine, Remove (custom only). Accepts `focusMachineId` so the update notice can open it on the comparison. Reuses `MachineDefinitionEditorDialog` for editing.
- `MachineUpdateNotice.tsx` — non-blocking notice shown once per opened project when the embedded snapshot differs from the library definition with the same ID. Offers Review update / Keep project copy / Update project copy. Dismissing changes nothing; updating is explicit, dirtying, and undoable. Mounted from `App.tsx` with `key={projectKey}`.
- `MachineDefinitionEditorDialog.tsx` — hybrid editor modal (focused form + raw JSON `DisclosureSection` + inline Zod validation + variable reference help). Portaled to `document.body` via `createPortal`.
- `machineDefinitionForm.ts` — pure form↔`MachineDefinition` mapping/merge module. No React imports. Exports `toFormData`, `mergeFormData`, `joinLines`/`splitLines`, and `validateDef` (non-throwing Zod wrapper with user-friendly error formatting).

## Conventions
- Dialogs reuse the `dialog-backdrop`/`dialog` modal pattern and `DisclosureSection` from `common/`.
- Form↔definition mapping is kept pure (no React) so it's unit-testable.
- Library mutations go through `src/machine/store` (`saveCustomMachine`, `deleteCustomMachine`); the only project mutation is `setProjectMachine` in `machineDefsSlice`.
- For CSS, see `src/styles/dialog.css` (`.machine-editor-*`, `.machine-manager-*`, `.machine-update-notice-*` classes) and `src/styles/tablet.css` (touch-target overrides).
