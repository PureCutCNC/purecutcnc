# INDEX — src/components/machine/

Machine definition UI. Manager, editor, and the project-snapshot update notice.

The list these dialogs edit is the **application** machine library
([`src/machine/`](../../machine/INDEX.md)): built-in machines from the current
build plus **My Machines**. A project stores only the single definition
selected for it, so library CRUD here never edits a project — copying a
definition into the project is always the explicit "Use this machine" /
"Update project copy" action.

## Files
- `MachineDefinitionManagerDialog.tsx` — machine lifecycle manager dialog. Left column lists the library grouped into Built-in machines / My Machines, plus an "In this project" row when the project's embedded machine is not in the library **or still breaks a template rule** (a project copy is always repairable, even when a library entry shares its id). Right column shows the previewed machine and its diagnostics, then its actions: Use this machine, Update project copy (when the library copy differs from the project's), Save to My Machines, Edit (custom library entries and any project copy), Duplicate to edit, Import/Export machine, Remove. Accepts `focusMachineId` so the update notice can open it on the comparison. Reuses `MachineDefinitionEditorDialog` for editing.
- `MachineDiagnosticList.tsx` — the shared diagnostics list (#1119): template path, one-based line, offending text/word and translated rule name. The engine supplies a stable `ruleCode`; `machineDiagnosticRuleKeys.ts` maps it to the catalog, so a French list never shows an English rule label. Rendered by the manager, the editor and the export dialog, with the raw values as data attributes for the browser smokes.
- `machineDiagnosticRuleKeys.ts` — the one `ruleCode` → catalog-key table; typed as a complete `Record`, so a new engine rule without a translation fails to compile.
- `machineManagerRows.ts` — pure row model (`buildMachineManagerRows`, `defaultMachineManagerKey`). A row key is prefixed `library:`/`project:` because both rows can carry the same machine id.
- `machineEditorDiagnostics.ts` — pure derivation of the editor's live diagnostics from the Advanced JSON when it is readable, otherwise from the focused form merged onto the definition.
- `machineLibraryNotices.ts` — pure list of the library's own state (write-blocked banner plus deduplicated error diagnostics) for the manager.
- `MachineUpdateNotice.tsx` — non-blocking notice shown once per opened project when the embedded snapshot differs from the library definition with the same ID. Offers Review update / Keep project copy / Update project copy. Dismissing changes nothing; updating is explicit, dirtying, and undoable. Mounted from `App.tsx` with `key={projectKey}`.
- `MachineDefinitionEditorDialog.tsx` — hybrid editor modal (focused form + raw JSON `DisclosureSection` + inline Zod validation + persistent template diagnostics + variable reference help). Portaled to `document.body` via `createPortal`. Save is enabled only when the definition really differs from the one the editor opened on (issue #1112 F4): the comparison goes through `common/formDraft.ts` against the JSON round trip Save itself parses, so an untouched definition — including the one a Duplicate opens — offers nothing to write and reformatting the raw JSON is not an edit.
- `PlasmaMachineFields.tsx` — focused machine-kind selector and plasma command block, with the material select/wait/feed sequence, controller-owned piercing and optional THC overrides (G-code machines only). Commands are metadata only until #959.
- `machineDefinitionForm.ts` — pure form↔`MachineDefinition` mapping/merge module. No React imports. Exports `toFormData`, `mergeFormData`, `joinLines`/`splitLines`, and `validateDef` (non-throwing Zod wrapper with user-friendly error formatting).

## Conventions
- Dialogs reuse the `dialog-backdrop`/`dialog` modal pattern and `DisclosureSection` from `common/`.
- Form↔definition mapping is kept pure (no React) so it's unit-testable.
- Library mutations go through `src/machine/store` (`saveCustomMachine`, `deleteCustomMachine`); the only project mutation is `setProjectMachine` in `machineDefsSlice`.
- For CSS, see `src/styles/dialog.css` (`.machine-editor-*`, `.machine-manager-*`, `.machine-update-notice-*` classes) and `src/styles/tablet.css` (touch-target overrides).
