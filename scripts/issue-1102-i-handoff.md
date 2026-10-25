# #1102 slice I — Select operations only on the active face (Frank's test, item 2)

Frank, testing the branch: "clicking on top/bottom selects the same in the cam panel. however in cam panel I can still chose an operation from the other side. if I do that while in the simulation view it flips the stock, sketch does not do that. however in the feature tree I can select only features from the selected side. should we limit selection in the CAM panel in the same way? I think we should."

Files: `src/App.tsx` (only `effectiveSelectedOperationId`, ~line 161), `src/components/cam/CAMPanel.tsx` (the operation row rendering inside the setup sections, ~lines 2340–2480, and `handleSelectOperation` ~line 866), `src/components/cam/setupSections.ts` (a pure helper), a test next to it, the `.cam-operation-tree` / ghost-row rules in `src/styles/face.css`, `cam.*` keys in the five `cam.ts` locale modules.

The feature tree is the model (`src/components/feature-tree/FeatureTree.tsx` ~line 379): a feature whose `authoringFace` is not the workspace face renders as a ghost row (`TreeRow` with `ghost`, class `tree-row--ghost`, `data-ghost="true"`, a title such as `featureTree.face.ghostRowBottom` "On the bottom face. Switch to the bottom face to edit it."). It cannot be selected, dragged or edited from there.

## Build
1. **Pure rule.** `operationOnActiveSetup(project, operation): boolean` in `setupSections.ts`. True when the operation's setup (`setupForOperation(project, operation)` from `src/engine/setupOrientation`, falling back the way `SetupOperationControls` does) is the active setup (`activeSetup(project)` from `src/store/helpers/activeFace`). Compare by setup id. A provisional Bottom setup that is not in `project.setups` yet must still count as active when the workspace is on Bottom; check how `camSetupSections` handles the provisional setup and follow it. In a project that is not grouped (`camSetupSections(project).grouped === false`, one flat setup), every operation is on the active setup.
2. **Selection follows the face.** In `App.tsx`, `effectiveSelectedOperationId` is null when the selected operation is not on the active setup. So switching face drops a selection from the other side, and nothing (CAM row, sketch, simulation) can show an other-side operation as selected. Do not clear the stored id, so switching back restores it. That is simply what deriving it does.
3. **Ghost rows in the CAM list.** In `CAMPanel.tsx`, an operation row whose operation is not on the active setup renders like a feature-tree ghost: classes `tree-row tree-row--feature tree-row--ghost`, `data-ghost="true"`, a `title` from a new key per face (`cam.treeRow.ghostTop` "On the top face. Switch to the top face to edit it.", `cam.treeRow.ghostBottom`, `cam.treeRow.ghostAround` "On the around face. Switch to it to edit."; real translations in all five packs). Clicking it, Enter/Space on it, and dragging it do nothing (no `handleSelectOperation`, no drag handlers, no drag grip). Keep the eye (show/hide its toolpath) working. Hide duplicate and delete on ghost rows. Leave the card header, its ⚙ and its export button alone: they act on the setup, not on a selection.
4. Keep the existing row look for active-setup operations exactly as it is.
5. Tests for `operationOnActiveSetup`: Top active with a Top op → true; Top active with a Bottom op → false; Bottom provisional active with an op assigned to it → true; Around op while on Top → false; flat single-setup project → true. Use the fixtures in `src/test/projectFixtures.ts` (`withBottomSetup`, `BOTTOM_SETUP_ID`) as `setupTargetHints.test.ts` does.

## Mutations
- Return true always → the Top-active/Bottom-op case fails.
- Compare faces instead of setup ids, if your implementation can, and say whether a test notices.

## Checks
Your new test, `npx tsx src/components/cam/setupTargetHints.test.ts`, `npx tsx src/components/cam/setupCardHeader.test.ts`, tsc, eslint on changed files, the i18n check. List every e2e spec you think selects an operation from another face (grep `rowByName` and `cam-operation-name` in `e2e/`); the manager fixes them.

## Rules for every #1102 slice

Issue #1102 (approved by Frank; these follow-up slices come from his hands-on test of the branch, 2026-10-24): UI-only cleanup of the setup and CAM panels before 0.6.0 ships. Hobby scope: no new options, each item removes, hides, shrinks or moves an existing control. No change to toolpaths, G-code, machine profiles or the project file format; a saved project opens and exports exactly as before. Read `INDEX.md`, `AGENTS.md` (Coding Standards), then the files named below on this branch (it is based on `integration/0.6.0`, which differs from `main`).

- **Off limits:** every file not named in your slice. Slices A–G of #1102 are already merged into this branch; read their code as it is now. Other slices running at the same time: I (`CAMPanel.tsx`, `App.tsx`, `CamSetupSectionView.tsx`, `src/components/cam/` helpers), J (`FaceSwitch.tsx`, `FaceBanner.tsx`, the face-switch block of `src/styles/face.css`), K (`NewProjectDialog.tsx`, the new-project block of `src/styles/dialog.css`). Shared files you may edit only in the block that belongs to your slice: `src/styles/face.css`, `src/styles/layout.css`, `src/styles/dialog.css`, and the locale modules.
- **Do not touch `e2e/**`.** The manager runs and fixes the browser specs. In the report, list every user-visible label, aria-label, title or class you changed, removed or renamed, so the manager can update the specs.
- **Keep accessible names stable where the issue does not change them** (aria-labels used by tests and screen readers), even when the visible text gets shorter.
- **Locales:** five packs, `src/i18n/locales/{en,de,fr,es,zh-CN}/`. Add each new key to all five, in the same position as in `en`, with a real translation (see `src/i18n/GLOSSARY.md`). Remove each key your change leaves unused from all five. Never change an existing value you did not mean to change. Run `npx tsx scripts/check-i18n-format.ts`.
- **New files** get the Apache license header copied from a neighbouring file. No `any`. No `process.` or `globalThis`.
- **Tests must bite.** Put every rule (what shows when) in a small pure function next to the component, with a `*.test.ts` using `node:assert/strict` like `src/components/cam/setupTargetHints.test.ts`. Run each mutation listed below by hand: back up with `cp`, break the line, run the test, confirm it fails, restore. Report each one.
- **This laptop is shared.** Do NOT run `npm test`, `npm run build`, `build:gates` or any Playwright/e2e command. Run only: `npx tsc -p tsconfig.app.json --noEmit`, `npx eslint <the files you changed>`, `npx tsx <each test file you added or changed, plus existing tests of the files you changed>`, and the i18n check. Give their exit codes.
- Leave the edits uncommitted; the dispatcher commits them.

## Report format
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, per item what you built, the locale keys added and removed, the labels / aria-labels / classes changed for the e2e specs, each mutation and whether it was caught, commands with exit codes, `RISKS` (anything you were unsure of or left out).
