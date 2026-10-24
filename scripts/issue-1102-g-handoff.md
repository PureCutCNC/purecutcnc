# #1102 slice G — New project dialog: project type first (proposal 16)

Files: `src/components/project/NewProjectDialog.tsx`, the new-project rules in `src/styles/dialog.css` (`.project-template-*`, `.properties-field--new-project-type`, `.dialog--new-project`), `dialogs.newProject.*` keys in the five `dialogs.ts` locale modules.

Today the left column is: Project name, Template (four cards: Blank metric, Blank imperial, Current project, Template file), then Project type as a dropdown (`Select` over `PROJECT_TYPES` = milling, plasma, rotary, labels from `projectTypeLabelKey`). The type decides the stock (block or bar) and what the project can do. For blank templates the preview on the right already switches to bar fields for rotary (`usesBarStock`).

## Build
1. **(16)** Move Project type to the top of the left column, above Project name. Show it as three tiles in one row, reusing the `project-template-card` look (title + one-line meta). Title from `projectTypeLabelKey(type)`. New meta keys in all five packs: `dialogs.newProject.projectTypeMillingMeta` "Flat stock, top and bottom", `…PlasmaMeta` "Sheet cutting", `…RotaryMeta` "Bar in a rotary axis". Use proper radio semantics: a container with `role="radiogroup"` and `aria-label` = `dialogs.newProject.projectType`, each tile `role="radio"` with `aria-checked`, arrow keys moving the choice, Tab entering the group once. Same `projectTypeChoice` state and the same effect on the preview and on Create as today. Remove the dropdown.
2. The tiles must fit the left column at the dialog's desktop width and at 1024 px tablet width (wrap to one per row below that if needed). Keep `autoFocus` on the name input.
3. Pure helper `projectTypeKeyNav(current, key)` (ArrowRight / ArrowDown → next, ArrowLeft / ArrowUp → previous, wrapping), with a test.

## Mutations
- No wrap at the end → fails.

## Checks
Your new test, existing tests next to `NewProjectDialog.tsx` (`ls src/components/project/`), tsc, eslint, the i18n check.

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
