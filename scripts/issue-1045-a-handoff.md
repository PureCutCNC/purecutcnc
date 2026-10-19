# #1045 slice A — Rotary rough/finish: passes around the bar (engine, round bar)

Base: `integration/0.6.0` (already checked out in this worktree's branch). Read `INDEX.md`, `AGENTS.md`, `src/engine/INDEX.md`, then this file. `gh` may be blocked: everything you need is here.

## Why (Frank, 2026-10-18)

"currently we index A and move along the bar. we need to be able to do the opposite too - fix a position on bar and move A (and Z if needed). that should also be an option on the rotary rough and finish, kind of like we have it for the parallel pocket operation where we can define an angle."

Today `generateRotaryFinish` and `generateRotaryRough` (`src/engine/toolpaths/rotaryModel.ts`) run every pass **along the bar** at one angle and step round in A. On a turned shape that leaves ridges along the bar. Passes **around the bar** (fixed along position, A turns, Z follows the model, then step along) give a lathe-like surface.

## What to build

### `src/types/project.ts`
- `export type RotaryPassDirection = 'along' | 'around'`
- On `Operation`, next to `rotaryChuckSupport` / `rotaryTailSupport`: `rotaryPassDirection?: RotaryPassDirection` with a doc comment ("missing reads as 'along'"). No format bump, no migration, no normalizer change unless the loader strips unknown operation fields (check `projectFormat`/normalizers; if it whitelists fields, add it there and say so).

### `src/engine/toolpaths/rotaryModel.ts`
- `RotaryFinishParams` gains `readonly passDirection?: RotaryPassDirection` (missing = `'along'`). `RotaryRoughParams` inherits it.
- **Along mode must stay byte-identical.** Do not reorder, refactor or re-round anything on the along path. Every existing test must pass unchanged.
- **Around mode grid** (inside `rotaryTargets` or a sibling helper; keep `sampleRotaryModel` itself unchanged):
  - along positions: `alongStart` to `alongEnd` in equal steps no larger than `params.stepover` (use `boundedIntervals`).
  - angles: `n = boundedIntervals(2π · barMaxRadius(stock), params.sampleSpacing)` intervals, `angle_k = 360 · k / n` for `k = 0..n` (both 0 and 360 present, so a ring closes).
  - keep the `MAX_ROTARY_SAMPLES` refusal for the product of the two counts.
- **Ring emission** (finish and rough): a *ring* is one along position `i`; its samples are `tips[k][i]` over `k`. Rings are visited in along order; **the angle direction alternates ring by ring** (ring 0: k = 0..n, ring 1: k = n..0, …), so A stays within [0, 360] for the whole operation. In the rough, the alternation continues across layers (do **not** add `(layer - 1) * 360` in around mode), so A never leaves [0, 360].
  - Finish: NaN = not cut (same as along). Rough: same `needsCut` / layer / `stubFloor` rules as along, per sample.
  - Runs within a ring are the contiguous samples that cut. Use `emitRotaryRuns` for the links; its existing rapid/plunge branch is fine between rings and between runs (travel at `travelZ`, which is above the bar).
  - **Index discipline:** every point's along, angle and tip must come from the same `(k, i)`. On a reversed ring use the reversed `k` for all three (the #1015 slice B bug was a return pass reading its mirror's heights).
- **Steep-step rule in A:** `emitRotaryRuns` decides "steep" with `spacing = Math.hypot(Δx, Δy)`. In a ring Δx = Δy = 0, so every rise would look steep. Make the spacing the surface distance: `Math.hypot(Δx, Δy, rMin · |Δa| · π/180)` where `rMin` is the smaller of the two samples' tip radii from the pivot (`z - barPivotZ(stock)`), floored at 0. Pass what you need (pivot) as a parameter. Along mode has Δa = 0 inside a run, so its output is unchanged — prove it with the byte-identical test.
- **Square blank in around mode:** not in this slice. `generateRotaryFinish` / `generateRotaryRough` with `passDirection: 'around'` on a square stock return no moves and one warning with a new code `rotaryAroundSquareUnsupported` (add it in `src/engine/toolpaths/warningCodes.ts`, all five `src/i18n/locales/*/warnings.ts` with real translations in the same position as `en`, and `warningsCoverage` if it lists codes). English: `'{operation}: passes around the bar are not available on a square blank yet. Use passes along the bar.'` (Slice C replaces this with real support.)

### `src/engine/toolpaths/rotaryOperation.ts`
- Pass `operation.rotaryPassDirection` into the params. Nothing else.

## Off limits
UI (`src/components/**`), `src/app/**` (cache inputs are slice B), booklet, `src/utils/units.ts`, operation defaults, `src/engine/gcode/**` product code, the simulation, `squareRotary*.ts`. Tests may be added anywhere under `src/engine/**`.

## Tests that must bite (new file `src/engine/toolpaths/rotaryAroundPasses.test.ts`, plus additions where natural)
Use **asymmetric** models: a cone (radius changes along the bar), a stepped cylinder (two radii with a shoulder), and one model that is asymmetric *in angle* (e.g. a hex prism, or a cylinder with an off-centre bump), built like the existing tests in `rotaryModel.test.ts` build theirs.

1. **Byte-identical along mode:** for the cone, the stepped cylinder and a square blank model (the C2 square fixtures/test helpers), finish and rough output with the field missing deep-equals output with `'along'`, and both deep-equal the output before your change (record it by running the generator on the base commit in a scratch script, or assert against the existing tests' expectations — say which).
2. **Ring shape:** in around mode every cut move inside a ring has constant along coordinate; A of every move is within [0, 360]; consecutive rings run in opposite angle directions.
3. **Independent reference (seeded property test, ≥ 50 seeds):** random revolved profiles (cones and steps, random radii/lengths inside a round bar), ball and flat tools of random radius. For a solid of revolution with profile `r_m(x)`, the lowest safe tip at along `x` is the max over the tool footprint `(dx, dy)` (disc of the tool radius) of `sqrt(max(0, r_m(x+dx)² − dy²)) − lift(dx, dy)` (`lift = 0` for flat; `r − sqrt(r² − dx² − dy²)` for ball), plus `stockToLeave`. Assert every emitted cut point (finish, around mode) has tip ≥ reference − (sampling allowance stated in the test, derived from sampleSpacing and tool radius, ≤ 0.02 mm at the test's spacing). This reference must not call `sampleRotaryModel` or anything in `rotaryModel.ts`.
4. **Angle-asymmetric index check:** on the angle-asymmetric model, every emitted point's tip equals the sampler's tip at that point's own (along, angle), on forward *and* reversed rings.
5. **Steep step in A:** on the hex prism (or bump), no single cut move in around mode has `|Δz|` greater than its surface distance unless it is purely vertical or flat (the stepped up-then-across pattern).
6. **The field changes the output:** around vs along on the same input produce different move lists.
7. **Square refusal:** square blank + around → no moves, one `rotaryAroundSquareUnsupported` warning.
8. **Posted program:** post one around-mode finish through the existing postprocessor test helpers (as the rotary gcode tests do): the program uses inverse-time feed on the turning moves the way thread output does, and every A word is within [0, 360].

## Mutations you must run and report (each must make a test fail; restore from a `cp` backup, never `git checkout`)
- drop the arc term in the steep-step spacing;
- stop alternating the ring direction;
- read the tip with the forward `k` on a reversed ring;
- use `stepover` instead of `sampleSpacing` for the angular step;
- add `(layer - 1) * 360` back in around-mode rough.

## Checks
`NODE_OPTIONS=--no-experimental-global-navigator npx vitest run src/engine/toolpaths/rotary*.test.ts src/engine/gcode` and `npm run build:gates`, exit codes captured. Report finish and rough generation time, along vs around, on the stepped-cylinder test input. Do not run the whole test suite in parallel with anything else.

## Report
Final message: `STATUS`, `COMMIT: none`, `CHANGED_FILES`, what changed per file and why along mode is unchanged, the timings, each mutation and whether it was caught, commands with exit codes, `RISKS` (anything you were unsure of, anything the plan did not cover).
