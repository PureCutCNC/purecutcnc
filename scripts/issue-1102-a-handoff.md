# #1102 slice A — Setup properties dialog (proposals 1, 2, 20)

Files: `src/components/cam/SetupPropertiesDialog.tsx`, `src/components/cam/SetupRegistrationEditor.tsx`, the setup-dialog block of `src/styles/face.css` (around lines 500–540: `.setup-dialog-body`, `.setup-face-options`, `.setup-flip-sketch`, `.setup-registration*`, `.dialog--setup …`), `cam.setup.*` keys in the five `cam.ts` locale modules.

Today the dialog (opened from the ⚙ on a setup card) shows, for every non-Around setup: Name; Face up as six disabled buttons (Top, Bottom, Left, Right, Front, Back) plus the hint `cam.setup.faceFixed` ("…other faces are not supported"); Flip about select; the A/B `FlipSketch` and its caption; Shared origin + `cam.setup.touchOff` hint; `SetupRegistrationEditor` (a fieldset with large stacked selects, a full-width Add reference, a hint); the missing-registration note; Operator notes; a full-width `Delete setup…` button inside the body.

## Build
1. **(1) Top shows only what Top uses.** When `setupFace(setup) === 'top'`: show Name, Face up, Shared origin (+ touch-off hint) and Operator notes. Hide Flip about, `FlipSketch` and the registration editor and note. Saving a Top setup still calls `updateSetup` with `{ name, flipAxis: axis, registration, notes }` as today. The hidden fields keep the values they had, so the saved project is identical except for name and notes. Bottom keeps everything. Around keeps today's Name + notes.
2. **(2) Face up is one read-only chip.** Replace the six disabled buttons and the `faceFixed` hint with one `<span className="face-chip face-chip--{face}">` showing the face name (`cam.setup.top` / `cam.setup.bottom`). Delete the now unused `left`, `right`, `front`, `back` and `faceFixed` keys from all five packs **only if** nothing else uses them (grep `src/` first and say what you found). Remove the now-dead `.setup-face-options` CSS.
3. **(20) Registration in the dialog's own style.** Inside the fieldset, lay out Reference kind, Reference target, Feature (or the coordinate inputs) as `properties-field` label/value rows, like Name and Flip about above them, with the same font size and control height as the rest of the dialog, not full-width stacked browser selects. `Add reference` becomes a normal-width `feat-btn` aligned left. The existing reference list keeps its ✕ buttons. Keep the hint text.
4. **(20) Delete setup… goes to the footer's left side.** Today it is a full-width button inside the body. Put it in the footer before Cancel / Save (push those to the right), styled as a normal-width secondary button, same disabled rule, same label and behaviour, including the confirm step (the confirm step's primary button stays where it is).
5. A pure helper, e.g. `setupDialogSections(face): { flip: boolean; registration: boolean; faceUp: boolean }`, decides what shows; test it for top, bottom and around.

## Mutations
- `registration: true` for top → the helper test fails.
- `flip` shown for around → fails.

## Checks
`npx tsx src/components/cam/<your new test>.ts`, `npx tsx src/components/cam/setupTargetHints.test.ts`, tsc, eslint on the changed files, the i18n check.

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
