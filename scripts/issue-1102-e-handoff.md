# #1102 slice E — Face banner and face switch (proposals 8, 15)

Files: `src/components/layout/FaceBanner.tsx`, `src/components/layout/FaceSwitch.tsx`, the `.face-banner*` and `.face-switch*` rules in `src/styles/face.css` (top of the file, ~lines 1–160), `canvas.face.*` keys in the five `canvas.ts` locale modules and `appShell.face.*` keys in the five `appShell.ts` modules. Leave `AppShell.tsx` alone unless it is unavoidable. It renders `<FaceSwitch />` in the desktop workspace header (~line 623) and `<FaceBanner withSwitch={tabletShell} />` under the tabs (~line 647).

Today, in a two-sided or rotary project, a second row (`FaceBanner`) appears under the workspace tabs on every face: on Bottom a long note "Stock flipped about X (front edge ↔ back edge). Top features are a ghost and cannot be edited here."; on Around "The bar turns in the rotary. This view is its surface unrolled: along the bar, and around it."; and on every face a chip "Drawing on top face" / "Drawing on bottom face" / "Drawing on the surface of the bar" that repeats the face switch. On a 1024 px tablet both get cut off. On desktop the "Other side" toggle (`face-switch__ghost`) is an icon plus the text "Other side"; on tablet it is already icon-only (face.css ~149–160).

## Build
1. **(8) No banner row on desktop.** `FaceBanner` renders nothing when `withSwitch` is false. On tablet (`withSwitch` true) it renders only the `FaceSwitch`, with no notes and no "Drawing on" chip.
2. **(8) Short flip chip in the switch.** In `FaceSwitch`, when the active face is `bottom` and both faces are in use, render after the segments (and after the Other side toggle) a compact chip with the refresh icon and "Flipped about X" / "Flipped about Y" (new key `appShell.face.flipped` with `{axis}`, all five packs). Its `title` is the full existing sentence (`canvas.face.flippedAboutX`/`Y` + `canvas.face.topIsGhost`) and it has `role="status"`. Read the axis the way `FaceBanner` does today (`activeSetup(project).orientation.axis`). It must stay on the switch's single row and not wrap at 1024 px tablet width.
3. **(8) Around explanation as a tooltip.** The Around segment's `title` becomes `canvas.face.aroundTurnsBar` (keep the busy title when busy).
4. **(15) Other side is icon-only everywhere.** Use the tablet look on desktop too: hide the text span, square button. Give the button `aria-label` = `appShell.face.otherSide` ("Other side") so its accessible name doesn't change, and keep the show/hide `title`.
5. Remove `canvas.face.drawingOnTop`, `drawingOnBottom` and `drawingOnAround` from all five packs if nothing else uses them (grep).
6. A pure helper `faceSwitchExtras({ face, bothFaces, axis })` → `{ flipChip: null | 'x' | 'y' }`, with tests (top → null, bottom + both → axis, bottom + single face → null, around → null).

## Mutations
- Flip chip for top → fails.
- Ignore `bothFaces` → fails.

## Checks
Your new test, any existing tests in `src/components/layout/` that import these files, tsc, eslint, the i18n check.

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
