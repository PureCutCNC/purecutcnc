# #1102 slice B — What it cuts (proposals 3, 4, 6)

Files: `src/components/cam/SetupOperationControls.tsx`, `src/components/cam/CrossFaceTargetPicker.tsx`, `src/components/cam/setupSections.ts` (only to add a pure helper, if you prefer it there), the `.cam-setup-reach*` and `.cam-cross-face-picker` rules in `src/styles/face.css`, `cam.setup.*` keys in the five `cam.ts` locale modules.

`SetupOperationControls` renders at the top of an operation's "What it cuts" group: the Setup chip + `Move…`, the `CrossFaceTargetPicker` (Top/Bottom feature operations), then `Check generated reach` and one reach card per target from `operationTargetReach(...)`. Every card says "Unverified: current toolpaths have not been measured on both sides" until checked. That includes single-sided pockets, Around operations and Rotary rough/finish, where nothing has two sides.

## Build
1. **(3) Reach only where two faces meet.** Add a pure `visibleTargetReach(face, reaches)` that keeps an entry only when `face !== 'around'` and (`entry.verdict.through` or `entry.verdict.status === 'cross-face'` or `entry.verdict.status === 'rejected'`). Keep rejected, because "cannot reach" is an error the user must see. Render `Check generated reach` and the cards only for the kept entries, and nothing at all when none are kept. `checkReach()` keeps measuring the same related operations as today.
2. **(3) Badge.** In the reach card, replace the `face-chip--thru` CROSS-FACE chip with a small `⇄` in a span whose `title` and `aria-label` are a new key `cam.setup.crossFaceTitle` ("Reached from the other face"). Remove `cam.setup.crossFace` ("⇄ CROSS-FACE") from all five packs once nothing uses it.
3. **(4) No Move… on rotary passes.** Hide the `Move…` button when `operation.kind` is `'rotary_rough'` or `'rotary_finish'`. They can only live on Around. Keep the Setup chip. Other operations keep Move…. Pure helper `canMoveOperation(kind)`; reuse the existing rotary-kind predicate in `src/types/project.ts` (around line 663) rather than a second list.
4. **(6) Other-face targets folded away.** `CrossFaceTargetPicker` is used in two places: here and in the Add-operation menu (`CAMPanel.tsx` passes it as `targetPicker`; don't edit CAMPanel). Render it as `<details className="cam-cross-face-picker">`, closed by default, with a `<summary>` reading "Also from the {side} side ({count})", where side is the other face (top when `face` is bottom, and the reverse). Add one new key `cam.setup.crossFaceSummary` with `{side}` and `{count}`, and reuse `cam.setup.top` / `cam.setup.bottom` lowercased if that reads right in each language, otherwise add two words. When any candidate is ticked, append the picked names to the summary, each followed by `⇄` (e.g. "Also from the top side (3): Circle 6 ⇄"), so the picks show while it is closed. Inside: drop the `crossFaceHelp` paragraph and the CROSS-FACE chip on each row. Keep the checkboxes, their names and the "not compatible" hint. Remove `crossFacePicker` (the old legend) and `crossFaceHelp` from all five packs if nothing else uses them.
5. Tests for `visibleTargetReach` (top single-sided → empty; through → kept; cross-face → kept; rejected → kept; around → empty) and `canMoveOperation`.

## Mutations
- Drop the `face !== 'around'` guard → around test fails.
- Drop the rejected case → fails.
- Return true for `rotary_rough` → fails.

## Checks
Your new tests, `npx tsx src/components/cam/setupTargetHints.test.ts`, `npx tsx src/components/cam/operationTargetLists.test.ts`, tsc, eslint, the i18n check.

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
