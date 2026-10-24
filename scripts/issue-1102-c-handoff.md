# #1102 slice C — Setup cards in the operations list (proposals 5, 9, 21)

Files: `src/components/cam/CamSetupSectionView.tsx`, `src/components/cam/setupSections.ts` (only for a pure helper, if you prefer it there), the `.cam-setup-group*` rules in `src/styles/face.css`, `cam.setup.*` keys in the five `cam.ts` locale modules.

Today each setup card (`CamSetupSectionView`, grouped mode) has a header button "Top operations 1 PROGRAM 01". It wraps to two lines on Bottom/Around at normal panel width. Then come two text-glyph buttons `⚙` (Setup properties, aria-label `cam.setup.propertiesFor`) and `↓` (export setup, aria-label `cam.setup.export`). An open card then shows a status block: the setup name, or "Flipped about X", or "Bar in the rotary", plus "Registration references: N" or the red `cam.setup.noRegistration` warning. An empty setup shows the status block and a "No operations in this setup." box.

## Build
1. **(9) One-line header.** Visible text: the face name (`cam.setup.top` / `bottom` / setup name for Around: use `section.setup.name`), the count (`feature-count`), and a short program chip "P01" (change `cam.setup.program` to `P{number}` in all five packs; check nothing else uses it). Keep the toggle's **accessible name** exactly as today by putting today's full text on `aria-label` ("Top operations", "Bottom operations", "Around operations" + count + "PROGRAM 01" — the e2e specs match `/Top operations/`). Use `title` for the same text. The header must not wrap at the default panel width (about 300 px): `white-space: nowrap`, the name may ellipsize, and the buttons stay on the right.
2. **(9) No status block.** Remove the status line (setup name / flipped / around status / registration count). When `section.registrationMissing` is true, show a `⚠` in the header after the program chip, with `role="img"`, `title` and `aria-label` = `cam.setup.noRegistration`, coloured with the existing warning colour. Remove `cam.setup.registrationCount`, `cam.setup.aroundStatus` and `cam.setup.flipped` from all five packs **only if** nothing else uses them (grep; `flipped` may be used elsewhere: report what you find). Keep the "kept, not cut" note (`data-testid="around-not-cut"`) exactly as it is.
3. **(5) Empty setup is one slim row.** When `section.operations.length === 0`, render only the header row: name, then a dim "no operations" (shorten `cam.setup.empty` to "No operations" in all five packs), and the ⚙. Hide ↓, since it is disabled anyway. No body, no box, even when the setup is active. The ⚙ keeps its aria-label.
4. **(21) Real icons.** Replace the `⚙` and `↓` text glyphs with `<Icon id="gear" />` and `<Icon id="export" />` (`src/components/Icon.tsx`; icons live in `src/assets/icons/`, so check `export.svg` reads as "download/export", or pick the closest existing one and say which). Same `tree-action-btn` size as the operation-row buttons (eye, copy, delete) below them. Keep both aria-labels.
5. A pure helper, e.g. `setupCardHeader(section, t)` returning `{ label, ariaLabel, programChip, warn, empty }`, with tests: top with ops; bottom with missing registration → warn; around → no warn; empty → `empty: true`; program number padding (P01, P12).

## Mutations
- warn true for around → fails.
- Drop the padStart → P1 test fails.
- `empty` from `operations.length < 0` → fails.

## Checks
Your new test, `npx tsx src/components/cam/setupTargetHints.test.ts`, tsc, eslint, the i18n check.

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
