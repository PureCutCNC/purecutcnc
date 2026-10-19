# #1045 slice C — passes around the bar on a square blank

Base: the #1045 feature branch with slices A and B merged. Read `INDEX.md`, `AGENTS.md`, `src/engine/INDEX.md`, `src/engine/gcode/INDEX.md`, the slice A handoff (`scripts/issue-1045-a-handoff.md` if still present; otherwise read `generateRotaryFinish` / `generateRotaryRough` around-mode branches in `src/engine/toolpaths/rotaryModel.ts`), then this file. `gh` may be blocked.

## Why
Slice A added Rotary rough / finish passes **around the bar** (rings at fixed along positions, A turning, alternating direction so A stays in [0, 360]) and refuses them on a square blank with `rotaryAroundSquareUnsupported`. Frank's main square use is Square to round (a round section turned from a square blank): around-the-bar passes are exactly what gives it a smooth surface, so the square blank must get them too, in this PR.

## What today forbids it (read these before writing code)
- `src/engine/gcode/motionPipeline.ts` (square branch, around line 1112): any move that commands a new angle below `rotaryTravelZ` is refused (`tracked.lowestTurnZ`), because "a turning move under that height sweeps the standing corner". An around-mode ring on a square blank *is* a turning cut below that height — by design, with the engagement bounded by the rough's layer.
- `src/engine/squareRotarySafety.ts`, `src/engine/toolpaths/squareRotaryStock.ts`, `src/engine/setupTargets.ts` (`squareRotaryWorkAdmitted`, `setupGenerationBlock`): the square admission and physical guards.
- `rotaryModel.ts` square rules on the along path: `squareRotaryTouchRadius` per angle (skip bands with no material), `stubFloor` (retained-stub contact floor), `retainedStubStepForced`, the shoulder refinement in `rotaryAlongPositions`.

**First step, before any code:** list every place that assumes a square blank's cutting moves happen at a constant angle (search more than one way: `lowestTurnZ`, `rotaryTravelZ`, `isSquareStock`, `squareRotary`, "angle", "turn"). Put the list in your report with what you changed or why each one is still right.

## What to build
1. **Generator (`rotaryModel.ts`), around mode on square:**
   - Remove the `rotaryAroundSquareUnsupported` refusal and its warning code (code, five locales, coverage test).
   - Apply the along path's square rules **per sample, at that sample's own angle**: a rough sample whose layer radius is at or above `squareRotaryTouchRadius(stock, angle_k, …)` is not cut (it is air); the `stubFloor` contact floor applies per (k, i); the ring positions include the square shoulder refinement the along path uses, or you explain why rings at `stepover` spacing are enough near a retained stub.
   - Rough engagement: a ring at layer L never cuts more than `stepdown` into material standing at that angle (corners included). The first layer starts from the corner radius, as the along rough does.
   - Finish around on square: same as round, with the stub floor; it must not sweep standing corners deeper than what the rough leaves. If a finish-without-rough on a raw square blank would turn full-depth into a corner, refuse that case with a clear warning (state the rule you chose).
2. **Post guard (`motionPipeline.ts`):** admit turning *cut* moves below `rotaryTravelZ` only for an admitted square rotary operation whose `rotaryPassDirection` is `'around'`, and only when the guard can show the swept engagement of each such move is within that operation's own bound (layer depth for the rough; stock to leave plus a stated tolerance for the finish). Rapids that turn below `rotaryTravelZ` stay refused. Every along-mode and round-bar output stays byte-identical, and every existing refusal test keeps refusing.
3. **Simulation:** check that the square simulation path renders around-mode rings (turning cuts) correctly; fix only if it does not, and say what you checked.

## Tests that must bite
- Byte-identical: along-mode square fixtures (the C2 square fixtures, `squareRotaryProgramSafety.test.ts`, `squareRotaryChuckSwitch.fixture.camj`) and all round output unchanged.
- **Independent reference (seeded property test, ≥ 50 seeds)** on a square blank: random revolved models (cones/steps) inside a random square blank. Model the blank's material independently (a square cross-section at each along position, minus what earlier layers removed) and assert for around-mode rough that every cut move's radial engagement into standing material at its own angle is ≤ stepdown + tolerance, and that no cut point is below the model's safe tip (same reference style as slice A's property test). The reference must not call the generator's helpers.
- The post guard admits an around-mode square program and still refuses: a turning **rapid** below travel height, an along-mode turning cut below travel height, an around-mode program whose engagement exceeds its bound (craft one by editing a move), and a non-rotary operation carrying A.
- Shoulder: a square-to-round section with retained square ends on both sides; no cut point enters the retained stub (stub floor respected) on forward and reversed rings.

## Mutations (each must fail a test; restore from `cp` backup)
- skip the per-sample touch-radius check;
- drop the stub floor in around mode;
- admit turning rapids below travel height in the guard;
- admit around-mode turning cuts without the engagement check;
- use ring 0's angle direction for every ring.

## Off limits
`src/components/**`, `src/app/**` except the simulation setup if step 3 needs it, i18n other than removing the refusal code.

## Checks
`npx tsx` on every changed test file and `src/engine/gcode/*.test.ts`, `npm run check:gcode`, `npm run build:gates` (exit codes; an EPERM on `node_modules/.tmp` from the sandbox is environmental — say so and run `npx tsc -p tsconfig.app.json --noEmit` instead). Report generation times, along vs around, on a square-to-round input.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, the constant-angle audit list, per-file changes, the engagement bound and why it holds, timings, each mutation and result, commands with exit codes, `RISKS`.
