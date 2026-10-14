# Issue #1015, slice K: show the hidden model on Around, pick it in the operation

Follow the Session rules in issue #962. Base: `feat/issue-1015-rotary-model` (PR #1025 into
`integration/0.6.0`). `gh` may be blocked in your sandbox; this file carries what you need.

## Why

On a round bar the imported model lives inside the bar, so the Around view (the bar's surface
unrolled flat) does not draw it, and it cannot be selected there. Rotary rough / Rotary finish
target it automatically (`operationTargetFromSelection` in `src/components/cam/operationValidity.ts`:
the selected models, or every imported model when none is selected). Frank, testing on his bust,
found this "a bit weird". He chose (2026-10-14) **both** fixes below, in this PR. A third small
fix rides along.

## K1. A band for each model on the Around view

- `src/components/canvas/aroundSheet.ts`: add `modelBands` to `AroundSheet`, next to
  `clampBands`. One entry per imported model feature (the same set `importedModelFeatureIds`
  returns; `isImportedModel` in `src/engine/setupTargets.ts` is the rule) that is `visible`:
  `{ featureId, name, along: { min, max } }`, where `along` is the model's extent along the bar
  axis, read from its footprint (`getProfileBounds` of its sketch profile, `minX/maxX` for a bar
  along X, `minY/maxY` along Y). Clip `along` to the sheet's `along`. Do not load the mesh.
  Widen `AroundSheetProject` with what you need (`features`, `featureDefinitions`).
- `src/components/canvas/SketchCanvas.tsx`, where the sheet's `clampBands` are drawn (around
  line 1236): draw each model band across the whole sheet (one circumference), **under** the
  features and toolpaths, as a light translucent fill with a dashed outline in a colour taken
  from the existing canvas palette (not the clamp colour), plus one short label inside the band
  near its top-left: the model's name and a note, en text: `{name} — inside the bar, machined by
  Rotary rough and Rotary finish`. The label must stay readable at the default zoom on a 3 in
  bar; skip it when the band is narrower on screen than the text.
- The band is reference only: not selectable, not snappable, not hit-tested, no context menu.
  It appears only when the active face is Around (the sheet is null otherwise, so Top and
  Bottom are untouched).
- Do not add it to the booklet snapshot (`operationSnapshot.ts`).

## K2. The target model shown and pickable in the rotary operation's properties

- `src/components/cam/CAMPanel.tsx`, field `targetSource`: for a rotary operation
  (`isRotaryOperationKind`), replace the "Use current selection" button with a checklist of the
  project's imported models (one checkbox per model, its name; checked = in
  `operation.target.featureIds`). Toggling writes `{ source: 'features', featureIds }` through
  `updateOperation`, keeping the project's model order. The last checked box is disabled, so the
  target is never empty. A model id in the target that no longer exists is dropped from the
  list shown and from the next write. Follow `CrossFaceTargetPicker.tsx` for markup and
  classes; put the logic in a small pure helper (for example `rotaryTargetToggle(project,
  target, featureId)` in `operationValidity.ts`) so it is unit-tested without React.
- The read-only "Target" row above it stays as it is (it already names the models).
- With one model only, show the single checked, disabled box: it tells the user which model is
  cut.
- Non-rotary operations are unchanged.

## K3. "Change" authoring face is hidden on the Around face

`requestAuthoringFaceChange` (`src/store/workspaceFace.ts`) refuses while the active face is
Around, so these controls silently do nothing there. Hide them when the active face is Around:
- `AuthoringFaceRow` in `src/components/feature-tree/FaceChip.tsx` (the "Change" button);
- the ghost-feature context menu in `src/components/feature-tree/FeatureContextMenu.tsx`
  (around line 138: today hidden only when the feature itself is Around). The main menu
  (line 505) already checks `selectionOnAround`; leave it.

## Locales

New keys in all five locales (`en`, `de`, `fr`, `es`, `zh-CN`), in the same position as in
`en`: the band label and the picker legend / help (for example "Models to machine"). Proper
translations, no English in other locales. No existing value changes. Run `npm run check:i18n`.

## Tests (they must bite: break the code, see a test fail, put it back; list each mutation)

- `aroundSheet` test: a model **off-centre** along a bar (not symmetric), a hidden model (no
  band), a non-model feature (no band), a bar along Y, a model longer than the bar (clipped).
- The picker helper: toggle on, toggle off, the last one cannot be removed, a stale id dropped,
  order kept.
- A component or store-level test that the Change control is absent on Around and present on
  Top (FaceChip and the ghost menu).
- `e2e/rotaryModel.smoke.spec.ts`: add one case on the existing fixture: open the rotary
  operation's properties, assert the model checkbox is there, checked and disabled (one model).
  You cannot run a browser; write it carefully and say so. The manager runs it.

## Off limits

The engine (`src/engine/toolpaths/**`, `src/engine/gcode/**`), `src/types/project.ts`, the
project format, the simulation. Output stays byte-identical: run `npx vitest run
src/engine/toolpaths/rotaryModel.test.ts src/engine/toolpaths/rotaryOperation.test.ts` and the
test files you touch. Then `npm run build:gates`.

## Report

What changed per file, each mutation and whether a test caught it, the exact commands run with
exit codes, and a RISKS section (anything you guessed, anything you could not run).
