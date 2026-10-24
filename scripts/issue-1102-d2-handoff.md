# #1102 slice D2 — Operations toolbar and operation identity (proposals 14, 17, 10)

Files: `src/components/cam/CAMPanel.tsx` (the operations toolbar around lines 2265–2345, the `tree-root-label` line ~2364, and the `name` / `description` / `kind` field renderers ~1110–1140), a new small component file for the description field if you need one (e.g. `src/components/cam/OperationNoteField.tsx`), the toolbar / identity rules in `src/styles/layout.css`, `cam.panel.*` / `cam.operation.*` keys in the five `cam.ts` locale modules. **Do not edit `GenerationSettingsMenu.tsx`**: another slice changes it. Keep rendering `<GenerationSettingsMenu {...generationSettings} />` as is.

Today the operations section has two rows of controls: gear (generation menu), eye "Show all toolpaths", crossed eye "Hide all toolpaths", Plan, Export, then "Setup properties" and "Add to Top" on a second row. Then a "CAM" label (`cam.panel.cam`, `tree-root-label`) above the setup cards. In operation properties → Identity: Name, Description (4-line textarea), Kind (read-only text input), Pass, Enabled.

## Build
1. **(14) One row.** Order: `Add to {face}` first, styled as the primary action (same handler, same `aria-expanded` / `aria-haspopup`, same warn class when nothing is selected), then Plan, Export, a flexible spacer, the toolpath eye (item 2), and the gear last. Remove the toolbar "Setup properties" button **only when `setupSections.grouped` is true**: then each setup card has its own ⚙. When not grouped (one flat setup, no cards), keep it, because it is the only way to reach that setup's properties. Remove the "CAM" `tree-root-label` line and the `cam.panel.cam` key from all five packs if unused. The row must fit the default panel width (~300 px) at 1440×900. Measure it from the CSS and say how. If it cannot fit, let the two icon buttons wrap rather than the text buttons.
2. **(17) One eye.** Replace Show all / Hide all with one toggle button. When any operation's toolpath is visible it shows `eye` and hides all on click (`aria-label` `cam.panel.hideAllToolpaths`). Otherwise it shows `eye-off` and shows all (`cam.panel.showAllToolpaths`). `aria-pressed` reflects "toolpaths shown". Pure helper `allToolpathsToggle(operations)` → `{ anyVisible, next }`, with a test. Find how per-operation visibility is read in this file (the same state the per-row eye uses).
3. **(10) Identity.** `kind`: plain text, not an input. A `properties-field` row whose value is a `<span className="properties-value">` with `operationKindLabel(operation.kind)`, label unchanged. `description`: when the stored description is empty, show a small link-style button "+ Add note" (new key `cam.operation.addNote`). Clicking it reveals the textarea and focuses it. A non-empty description shows the textarea as today. Hooks can't go inside the `fieldRenderers` closures, so put this in a small component. Keep the field order from `operationFields.ts`.
4. Tests: `allToolpathsToggle` (none visible → show all; some visible → hide all; empty list → disabled).

## Mutations
- `anyVisible` from `every` instead of `some` → fails.

## Checks
Your new test, `npx tsx src/components/cam/operationFields.test.ts`, tsc, eslint, the i18n check.

## Rules for every #1102 slice

Issue #1102 (approved by Frank): UI-only cleanup of the setup and CAM panels before 0.6.0 ships. Hobby scope: no new options, each item removes, hides, shrinks or moves an existing control. No change to toolpaths, G-code, machine profiles or the project file format; a saved project opens and exports exactly as before. Read `INDEX.md`, `AGENTS.md` (Coding Standards), then the files named below on this branch (it is based on `integration/0.6.0`, which differs from `main`).

- **Off limits:** every file not named in your slice. Other #1102 slices are running at the same time on: `SetupPropertiesDialog.tsx`/`SetupRegistrationEditor.tsx` (A), `SetupOperationControls.tsx`/`CrossFaceTargetPicker.tsx` (B), `CamSetupSectionView.tsx` (C), `GenerationSettingsMenu.tsx`/`ToolpathVisibilityPanel.tsx`/`ToolpathRendererControl.tsx`/`useSketchToolpathRenderer.ts`/`SketchCanvas.tsx`/`App.tsx`/`src/app/toolpathGeneration/**` (D1), `CAMPanel.tsx` (D2), `FaceBanner.tsx`/`FaceSwitch.tsx`/`AppShell.tsx` (E), `NewProjectDialog.tsx` (G). Shared files you may edit only in the block that belongs to your slice: `src/styles/face.css`, `src/styles/layout.css`, `src/styles/dialog.css`, and the locale modules.
- **Do not touch `e2e/**`.** The manager runs and fixes the browser specs. In the report, list every user-visible label, aria-label, title or class you changed, removed or renamed, so the manager can update the specs.
- **Keep accessible names stable where the issue does not change them** (aria-labels used by tests and screen readers), even when the visible text gets shorter.
- **Locales:** five packs, `src/i18n/locales/{en,de,fr,es,zh-CN}/`. Add each new key to all five, in the same position as in `en`, with a real translation (see `src/i18n/GLOSSARY.md`). Remove each key your change leaves unused from all five. Never change an existing value you did not mean to change. Run `npx tsx scripts/check-i18n-format.ts`.
- **New files** get the Apache license header copied from a neighbouring file. No `any`. No `process.` or `globalThis`.
- **Tests must bite.** Put every rule (what shows when) in a small pure function next to the component, with a `*.test.ts` using `node:assert/strict` like `src/components/cam/setupTargetHints.test.ts`. Run each mutation listed below by hand: back up with `cp`, break the line, run the test, confirm it fails, restore. Report each one.
- **This laptop is shared.** Do NOT run `npm test`, `npm run build`, `build:gates` or any Playwright/e2e command. Run only: `npx tsc -p tsconfig.app.json --noEmit`, `npx eslint <the files you changed>`, `npx tsx <each test file you added or changed, plus existing tests of the files you changed>`, and the i18n check. Give their exit codes.
- Leave the edits uncommitted; the dispatcher commits them.

## Report format
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, per item what you built, the locale keys added and removed, the labels / aria-labels / classes changed for the e2e specs, each mutation and whether it was caught, commands with exit codes, `RISKS` (anything you were unsure of or left out).
