# #1102 slice L — Change authoring face only for features through the whole stock

Frank, testing the branch, after the Change-face dialog confused him (a 0.25-deep Top pocket offered "Move to bottom face"; seen from below that pocket sits under 0.5 of material and no Bottom operation can reach it): "changing ownership of the pocket like this case does not make sense. I think we should limit this action only in the features that go full top to bottom (holes and solids)."

Files: `src/store/helpers/activeFace.ts` (a pure helper next to `isThroughFeature`, ~line 379), `src/store/workspaceFace.ts` (`requestAuthoringFaceChange`, ~line 51), `src/components/feature-tree/FaceChip.tsx` (`AuthoringFaceRow`, the properties "Change…" button), `src/components/feature-tree/FeatureContextMenu.tsx` (the "Change authoring face…" entry, ~line 138), `src/components/feature-tree/ChangeFaceDialog.tsx` (`movable`, ~line 76), a test file next to the helper, `featureTree.face.*` keys in the five `featureTree.ts` locale modules. **Engine files are off limits** (`src/engine/**`): import `featureStockSpan` and `spanReachesBothFaces` from `src/engine/setupTargets.ts`, don't change them.

## Build
1. **Rule:** `canChangeAuthoringFace(project, feature): boolean` in `activeFace.ts`. True only when the feature is a flat-face feature (`authoringFace` is not `'around'`), its role is `subtract` or `add` (from its definition's `operation`, read the way `isThroughFeature` in `src/engine/setupTargets.ts` does), and its stock Z span reaches both faces (`featureStockSpan` + `spanReachesBothFaces`). So a through hole or a full-height solid qualifies; a blind pocket, a partial-height add, a region or construction geometry does not. Keep the existing conditions (locked, edit in progress, Around) where they are.
2. **Store guard:** `requestAuthoringFaceChange(featureIds)` returns false and opens nothing when none of the requested features qualify. `ChangeFaceDialog`'s `movable` also requires `canChangeAuthoringFace`. When some selected features qualify and some don't, the dialog moves only the qualifying ones and says how many stay, with a new line `featureTree.face.dialog.notThrough` ("{count} not moved: only features that go through the whole stock can change face."). Put it next to the existing linked-copies note (`linkedStaying`) and match its style.
3. **Entry points stay visible but disabled with a reason** when the feature does not qualify (the file's own comment: a button that silently does nothing is worse than none). Properties "Change…" (`AuthoringFaceRow`, needs the feature, so pass what it needs or compute from `featureIds` + the store) and the context-menu entry: `disabled`, `title` = new key `featureTree.face.changeNotThrough` "Only features that go through the whole stock (a through hole or a full-height solid) can change face." Busy and locked keep their own titles and take precedence.
4. Tests: `canChangeAuthoringFace` for a through subtract (true), a blind subtract (false), a full-height add (true), a partial add (false), an Around feature (false), a region (false). Build fixtures the way `src/components/cam/setupTargetHints.test.ts` / `src/test/projectFixtures.ts` do. Also test that `ChangeFaceDialog`'s selection rule (factor `movable` into a pure function if needed) drops non-qualifying features.

## Mutations
- Drop the span check → the blind-pocket case fails.
- Drop the role check → the region case fails.

## Checks
Your new test, existing tests next to the files you changed (`ls src/store/helpers/*.test.ts src/components/feature-tree/*.test.ts`), tsc, eslint on changed files, the i18n check. List the e2e specs that change a feature's face (`grep -n "Change authoring face\|face-row__change\|change-face" e2e/*.ts`) and which feature each one moves; the manager fixes them.

## Rules for every #1102 slice

Issue #1102 (approved by Frank; these follow-up slices come from his hands-on test of the branch, 2026-10-24): UI-only cleanup of the setup and CAM panels before 0.6.0 ships. Hobby scope: no new options, each item removes, hides, shrinks or moves an existing control. No change to toolpaths, G-code, machine profiles or the project file format; a saved project opens and exports exactly as before. Read `INDEX.md`, `AGENTS.md` (Coding Standards), then the files named below on this branch (it is based on `integration/0.6.0`, which differs from `main`).

- **Off limits:** every file not named in your slice. Slices A–K of #1102 are already on this branch; read their code as it is now. No other #1102 slice runs at the same time. Shared files (the locale modules) only in your own keys.
- **Do not touch `e2e/**`.** The manager runs and fixes the browser specs. In the report, list every user-visible label, aria-label, title or class you changed, removed or renamed, so the manager can update the specs.
- **Keep accessible names stable where the issue does not change them** (aria-labels used by tests and screen readers), even when the visible text gets shorter.
- **Locales:** five packs, `src/i18n/locales/{en,de,fr,es,zh-CN}/`. Add each new key to all five, in the same position as in `en`, with a real translation (see `src/i18n/GLOSSARY.md`). Remove each key your change leaves unused from all five. Never change an existing value you did not mean to change. Run `npx tsx scripts/check-i18n-format.ts`.
- **New files** get the Apache license header copied from a neighbouring file. No `any`. No `process.` or `globalThis`.
- **Tests must bite.** Put every rule (what shows when) in a small pure function next to the component, with a `*.test.ts` using `node:assert/strict` like `src/components/cam/setupTargetHints.test.ts`. Run each mutation listed below by hand: back up with `cp`, break the line, run the test, confirm it fails, restore. Report each one.
- **This laptop is shared.** Do NOT run `npm test`, `npm run build`, `build:gates` or any Playwright/e2e command. Run only: `npx tsc -p tsconfig.app.json --noEmit`, `npx eslint <the files you changed>`, `npx tsx <each test file you added or changed, plus existing tests of the files you changed>`, and the i18n check. Give their exit codes.
- Leave the edits uncommitted; the dispatcher commits them.

## Report format
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, per item what you built, the locale keys added and removed, the labels / aria-labels / classes changed for the e2e specs, each mutation and whether it was caught, commands with exit codes, `RISKS` (anything you were unsure of or left out).
