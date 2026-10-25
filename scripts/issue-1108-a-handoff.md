# #1108 — rotary projects keep add/subtract nesting (approved plan)

Frank, testing 0.6.0: "in the rotary project we lost the add/subtract auto assignment (rect inside a pocket also gets created as a pocket)". On the fix for Around: "I think we should change the rule for around to also follow this." Plan approved by Frank 2026-10-25.

## Cause
`inferManualFeatureOperation` in `src/store/helpers/manualFeatureOperation.ts` returns early:
`if (activeFace(project) === 'around' || barSeedsModel(project)) return 'subtract'`.
That was meant to stop the first shape on a bar from becoming a base add (the bar already is the material, #395 / #1054 slice 1), but it also skips `inferNestedSolidOperation` (`src/import/classifier.ts`) for every later shape, so islands are lost.

## Build
1. Replace the early return. When the bar is the material (`barSeedsModel(project)` or the active face is `'around'`), add one extra solid to `existingSolids` before calling `inferNestedSolidOperation`: an `'add'` rectangle (`rectProfile` from `src/types/project`) that strictly contains the new profile and every existing solid profile (compute their bounds with `flattenProfile` from `src/engine/toolpaths/geometry`, and pad generously). `inferNestedSolidOperation` already chooses the smallest containing solid, so this "material" solid wins only when nothing else contains the shape. Result: inside nothing → `subtract`; inside a subtract → `add`; inside an add → `subtract`. Do not change `inferNestedSolidOperation`. Keep the open-profile and self-invalid behaviour of `inferNestedSolidOperation` (it returns `'add'` for an open profile). Check what the old early return gave an open profile on a bar (always `'subtract'`) and keep that for open profiles on a bar, so lines stay what they were. Say what you did in the report.
2. Block projects (`barSeedsModel` false and not Around) are unchanged.
3. Around nests in the unrolled sheet coordinates on Around features only (`featuresAtActiveFace` already gives that). Add a short code comment on the known limit: a container crossing the seam does not contain a shape on the other side of it.
4. Update the doc comment above the function to the new rule.
5. Tests in `src/store/helpers/manualFeatureOperation.test.ts`: keep the file's style. Cover, on a round bar (`roundStock`) and on a square blank (find the square-bar helper next to `roundStock` in `src/types/project.ts` or `src/types/barStock.ts`), for Top, Bottom and Around: lone shape → subtract; shape inside a subtract → add; shape inside an add that is inside a subtract → subtract; an open profile → what it was before. Block project unchanged: first shape add, a shape inside it subtract. The existing assertion "and over an Around subtract" expecting `'subtract'` must now expect `'add'`; change it and say so. Use features whose profiles really contain the test shape (today's `aroundFeature` rect at (20,40) 10×10 and `box` at (30,45) 8×8 do not nest, so build proper nested fixtures).

## Mutations (each must fail)
- Drop the material solid → the lone-shape case fails.
- Keep the old early return for Around only → an Around island case fails.

## Rules
Edit only `manualFeatureOperation.ts` and its test. No engine change, no e2e, no locale change. Do NOT run `npm test`, `npm run build`, `build:gates` or Playwright (shared laptop). Run: `npx tsx src/store/helpers/manualFeatureOperation.test.ts`, the other tests next to it that import this helper (grep), `npx tsc -p tsconfig.app.json --noEmit`, `npx eslint` on the two files. New code: no `any`, no `process.`/`globalThis`. Leave edits uncommitted.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, what you built, the open-profile decision, each mutation and whether it was caught, commands with exit codes, `RISKS`.
