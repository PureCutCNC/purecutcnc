# #1079 — Top/Bottom: a pocket picks up an overlapping feature from the other face

Base: the #1054 branch (open PR #1078, which already changes pocket/surface clearing for bars; build on it). Read `INDEX.md`, `AGENTS.md`, `src/engine/toolpaths/INDEX.md`, then this file. `gh` may be blocked. Off limits: `src/engine/toolpaths/rotaryModel.ts`, `src/engine/gcode/**` (other work).

## Issue
Frank: "Rect 2 on top and Circle 5 overlap each other when looked from top, however they do not touch each other. the top pocket operation picks up the circle from bottom and messes up that pocket."

Repro: `scripts/fixtures-1079/round-stock-top-bottom.camj` (Frank's file; rotary project, round bar Ø2 along X). Top "Pocket Rough" targets Rect 1–3 (Top subtracts, Z 1.5–2). Circle 5 is a **Bottom** subtract at Z 0–0.2 that overlaps Rect 2 in plan. Generated through `computeOperationToolpath`, the Top pocket cuts down to Z 0 (on the base) and warns `regionExtendedBySubtractDepth`. Same on `integration/0.6.0`, so this predates #1054.

Likely cause (confirm first): the pocket resolver's non-target subtract fold (#758/#774: a subtract contiguous below the target extends the pocket to its depth; `resolvePocketRegions` in `src/engine/toolpaths/resolver.ts`) gathers related features without the setup-face rule targets follow (`featureReachableFromFace` / `isThroughFeature` in `src/engine/setupTargets.ts`, #946), and treats Circle 5 as contiguous although 1.3 of material separates it.

## Build
- Every toolpath resolver that reads related (non-target) features — pocket fold and keep-outs, edge routes, surface clean, V-carve (both), follow line, drilling, 3D stepdown's related floors/protected features, rest regions — sees only features reachable from the operation's own face under the existing #946 rule (same face; a through feature; an imported model). List each site you changed and each you checked and left.
- Verify the fold's contiguity test with a gap (same face): a subtract whose top is below the target's floor by more than a tolerance must not extend the pocket. Say what the tolerance is.
- Single-face projects (Top only, the norm for blocks): byte-identical output on the parity corpus and existing fixtures.

## Tests (must bite)
- Frank's fixture: the Top pocket's lowest cut is at its floor (Z 1.5 minus nothing below it), no `regionExtendedBySubtractDepth`; the Bottom pocket likewise stops at its own floor.
- Synthetic: overlapping Top and Bottom subtracts with a gap (both orderings, both setups); a through subtract still reachable from both faces; same-face contiguous (extends) vs same-face with a gap (does not).
- Mutations (restore from `cp` backup): drop the face filter in the pocket fold → Frank's fixture test fails; drop the gap check → the same-face gap test fails.

## Checks
`npx tsx` on the new/changed tests and the pocket/resolver/surface/edge tests, the parity corpus test; `npx tsc -p tsconfig.app.json --noEmit`; `npm run lint`; exit codes.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, the cause (confirmed?), the sites changed/checked, mutations and results, commands with exit codes, `RISKS`.
