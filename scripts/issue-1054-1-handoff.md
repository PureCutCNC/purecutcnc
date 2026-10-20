# #1054 slice 1 — the bar seeds the model on every face of a rotary project

Base: `integration/0.6.0`. Read `INDEX.md`, `AGENTS.md`, `src/engine/INDEX.md`, then this file. `gh` may be blocked: what you need is here.

Off limits (other workers): `src/engine/toolpaths/rotaryModel.ts`, `src/engine/gcode/**` (#1045 and #1054 slice 2), `src/engine/operationBooklet/**`, `src/store/helpers/provisionalSetup.ts`, `src/store/helpers/setups.ts` (slice 2).

## Why (Frank, 2026-10-19)
"make top/bottom in the rotary project behave like Around - the stock becomes model and we allow pockets into it" ... "then top/bottom and Around can be used in parallel". Approved plan: "The bar seeds the model on every face of a rotary project (round and square). A Top/Bottom subtract cuts into the bar directly, without drawing a base add; Top, Bottom and Around cuts all show on one bar in the 3D view. Feature validation stops asking for a base add in a rotary project." Depth stays absolute (a pocket floor is measured from the feature top, as today).

## What the audit found (Codex, read-only, integration @ f14e0ed3)
- Around seeds its model from the bar: `buildAroundModelSolid` (`src/engine/csg.ts:1006`) starts from `roundBarSolid`, subtracts wrapped slabs, unions additions clipped to the bar. Round only.
- Flat CSG starts empty and needs an add feature to seed material (`csg.ts:1107`), so on Top a pocket in a rotary project has nothing to cut in the 3D model.
- `buildStockMesh` (`csg.ts:190`) draws a round cylinder or extruded square/block — display only.
- Feature/operation validation that expects a base add: find it (search the subtract/add role rules, `featureRoles.ts`, `operationDefaults.ts` `isOperationTargetValid`, pocket hints in `src/components/cam/operationValidity.ts`) and list each site.

## Build
1. In a rotary project with bar stock (round or square, either axis), the 3D model of the part starts from the **bar solid** (cylinder or square prism about the true pivot, the bar's length) on every face: Top and Bottom subtract features cut into it (Bottom features in their flipped frame, as the existing Bottom transform does), add features union with it clipped to the bar, and the Around wrapped cuts apply to the **same** solid, so one model shows all faces. Reuse `roundBarSolid` and add the square equivalent; one builder, not one per face.
2. Feature/operation validation: in a rotary project a subtract (pocket) needs no base add — the bar is the material. Milling and plasma projects keep today's rules exactly.
3. Block projects (milling, plasma) byte-identical: same CSG, same validation, same hashes.

## Tests (must bite)
- Model: rotary round and square, axis X and Y: a Top pocket, a Bottom pocket and an Around pocket on one bar produce one solid whose volume equals the bar's minus the three pocket volumes (independent analytic volumes); the solid's bounds are the bar's.
- Validation: a pocket with no base add is valid in a rotary project and still refused in a milling project.
- Block projects: CSG output deep-equals the base for the existing CSG test fixtures.
- Mutations (restore from cp backup): seed flat faces empty again → fails; skip the Around cuts on the shared solid → fails; relax validation for milling too → fails.

## Checks
`npx tsx` on the changed and related tests (`src/engine/csg*.test.ts`, feature-role/operation-validity tests, around model tests); `npx tsc -p tsconfig.app.json --noEmit`; `npm run lint`; exit codes. You cannot run a browser: say which browser specs could be affected (3D view, Around face) and the manager will run them.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, the validation sites found and what changed at each, per-file changes, mutations and results, commands with exit codes, `RISKS`.
