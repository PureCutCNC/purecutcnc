# Issue #1173 handoff: rotary rough/finish over a protected neighbour

Branch `fix/issue-1173-rough-overlap-jitter`, based on `integration/0.6.0` at
`a1b64cc7`. The WIP commit `59310aed` holds the code so far. The plan of record is
the approved comment on #1173, plus Frank's two decisions recorded there on
2026-11-08. Both are summarised below. The PR goes into `integration/0.6.0` with
`Closes #1173` and a Manual impact section. It is not merged: Frank dry-runs
the exported programs in gSender first.

## Frank's file

`work/bolt-test-02-x.camj` and his original export
`work/bolt-test-02-x-mm_02_around_Rotary_rough_2.nc` live only in the primary
checkout's `work/` (gitignored). Copy both into **your worktree's** `work/`
before measuring: `cp <primary checkout>/work/bolt-test-02-x.camj <worktree>/work/`.
Never commit them, and never put them in `test-fixtures/`.

The operations:
- op0197 *Rotary rough 2*: the Turn (f0186), flat Ø1/4", stepover 0.32, stepdown 0.125, leave 0.02, feed 30 ipm.
- op0198 *Rotary finish 2*: the same Turn and tool, leave 0.
- op0195 / op0196: the Hex (f0184), ball cutters.

Geometry: a Ø2 in bar along X. The Hex is 1.5 in across flats over 0.75..1.25. The Ø1 Turn runs 1.2..3.75 and starts 0.05 in inside the Hex.

## Causes (measured at a1b64cc7)

1. **Z zigzag over the hex corners.** The conservative cell read pads a full
   cell (`rotarySampling.ts`, `safeToolTipZAt` with the cell pad) plus a
   per-angle lift. On ring 1.325 in, tip + leave read 0.8861 / 0.8808 / 0.8900
   at A19/20/21. The exact footprint read rises smoothly to 0.886 (corner + leave).
2. **Tiny blocks.** The refinement bisects the zigzag in the overlap. On the
   shank, the lift is one value per angle for the whole bar: the Hex's facets
   raised it from 0.009 to 0.019 in for A280–284. The finish has an older cause
   as well: the per-angle lift wobbles by about 0.0005 in on any cylinder, so the
   refinement halves good chords down to 0.4455° steps (8 ms).
3. **Lift, rapid A, plunge.** Every link planner needs `toAlong > fromAlong`, so a
   gap inside one ring (over a corner) went to travel height
   (`emitRotaryRuns`).

## What is implemented (commit 59310aed)

All of it is in `src/engine/toolpaths/rotaryModel.ts` unless named otherwise.
- **A. Exact neighbour columns.** `rotaryNeighbourColumns` picks the columns
  within the sampling radius + one cell of a neighbour's along extent.
  `mergeNeighbourColumns` reads them with `exactTipRows` on the mesh with
  neighbours, refines them on those exact rows, and samples any angle the
  refinement adds on the base prep for the other columns. Both drivers call it
  after their base refinement. These columns are in `ringOnlyIndices` (renamed
  from `wallFootIndices`), so no helix band crosses them.
- **B. Base grid on the target + stubs only** (`baseMesh`) for around operations with
  neighbours. Link rows still read `samplingMesh`, with their **own**
  `linkWorkspace`. Sharing the base workspace read the link rows on the target
  alone and gouged the finish by 0.019 in.
- **C. `feedThroughRingGaps`.** A round-bar rough feeds through an interior ring
  gap of at most `MAX_LINK_ACROSS_DEG` at the gap samples' own tips. It applies
  only when every gap sample has a finite tip at or above the previous layer and
  below the blank, and lies inside the region.
- **Upward-only merge** (approved by Frank). `raiseShortAroundSegments` runs after
  `mergeCollinearCuts` on every around rough and finish. It drops an interior
  point next to a step finer than the base angle grid (`RotaryTargets.baseAngleStep`)
  only when the chord stays 0..`AROUND_RAISE_TOLERANCE_MM` (0.02 mm) above every
  original point it spans.
- **`rotarySampling.ts`** (output-identical speedups, hashes checked on op0195–0198):
  an exact-tip row returns before building the height map it never reads, and
  `exactFootprintTips` turns each candidate once per angle instead of once per
  column. Together they took the #1155 cpuRatio check from 3.5x to 1.97x.
- **Tests and helpers:**
  - `src/test/rotaryDepthCompare.ts`: a baseline move at or above the air radius no
    longer counts as a cut (regression and mutation in `rotaryDepthCompare.test.ts`).
    This was the "2.59 mm Hex-target rough regression": the comparator took a
    travel link above the bar as the deepest pass. It was not a gouge.
  - `rotaryNeighbours.test.ts` and `rotaryNeighbourPartialOverlap.test.ts`: the Hex
    "grown by the leave" is now a **rounded** offset (Euclidean distance), the
    sampler's own definition of the leave. Pushing the faces out keeps a sharp
    corner `leave * (1/cos30° - 1)` further out (0.062 mm at 0.4 mm), which only the
    old over-read cleared. **Codex must review this contract change.**
  - Re-recorded counts with comments: head-band rings 415 -> 1939 and bolt run
    7127 -> 3989 (`rotaryNeighbours`); gate-gap links 65 -> 62
    (`rotarySquareRingLinks`); the deepest-cut tolerance 0.01 -> 0.03 and the sweep
    coverage guard 2000 -> 1800 (`rotaryAroundPasses`). **Re-check them**: the first
    two were measured before the merge trigger was narrowed to the base angle step.
  - New `rotaryNeighbourOverlapJitter.test.ts` (header lists seven mutations), and
    `scripts/issue-1173-block-counter.ts`.

### Measured on Frank's file (sync driver)

| | op0197 at a1b64cc7 | op0197 now | op0198 at a1b64cc7 | op0198 now |
|---|---|---|---|---|
| Z flips >0.1 mm (both legs) | 22 | 2 (hex-flat-centre V) | 23 | 1 (same V) |
| blocks <10 ms | 82 | 24 (all 9.64 ms knees) | 613 | 39 (8 knees, 31 at A≈126°) |
| shortest block | 1.15 ms | 9.64 ms | 1.7 ms | 3.4 ms |
| commanded A-rate, worst adjacent ratio | 1.38 | 1.11 | 1.22 | 1.11 |
| in-ring breaks | 12 | 0 | 0 | 0 |
| moves / ms | 5794 / 253 | 4388 / 243 | 9459 / 252 | 4981 / 259 |

From the gouge probe on the fix before the merge-trigger change: op0197 ring
−0.0194, helix −0.0200, link −0.0298 in (the leave is kept); op0198 0.0000 (as at
a1b64cc7, leave 0). The ledge probe gives 0 for both. **Re-run both on the tip.**

## Open items, in order

1. **Suites.** A rerun of every `src/engine/toolpaths/rotary*.test.ts` and
   `squareRotary*.test.ts` was running at handoff and never reported. Run them
   one at a time and fix anything red. `rotaryRegion.test.ts` is known red:
   `round/rotary_rough/around` (and possibly the other around rows) needs its
   `NO_REGION_HASHES` row re-recorded with a comment. Fix C and the merge change
   that output by design: it was byte-identical with both switched off.
2. **New test file mutations.** Run
   `npx tsx src/engine/toolpaths/rotaryNeighbourOverlapJitter.test.ts`, then apply each of
   the seven mutations in its header one at a time, see the named check fail, and
   restore. It has not been run yet, so fix the test where it is wrong. The
   "first ring peaks at corner + leave within 0.0005" check assumes the exact
   read. The two `rotarySampling.ts` speedups change no output, so they need no
   mutation; confirm with the four op hashes before and after.
3. **Build and gates.** `npm run build` from the worktree (report the exit code),
   `npm run check:gcode`, and the rotary e2e specs isolated:
   `PURECUT_E2E_PORT=1437 PURECUT_E2E_ISOLATED=1 npm --prefix <worktree> run test:e2e -- --workers=2 e2e/rotaryModel.smoke.spec.ts e2e/aroundModel.smoke.spec.ts e2e/around3d.smoke.spec.ts e2e/aroundFace.smoke.spec.ts e2e/setupCam.smoke.spec.ts`.
   Frank's dev server is on :1420 and the docs session may use :1438. One heavy
   process at a time.
4. **Exports for Frank.** Write op0197 and op0198 from Frank's file, posted with
   his machine, to `<worktree>/work/` (for example `bolt-test-02-x-1173_op0197.nc`).
   Use the app's own export path on an isolated dev server, or a small node script
   over `runPostProcessor` (see how `scripts/rotary-generation-probe.ts` loads the
   engine and posts).
5. **PR** into `integration/0.6.0`: `Closes #1173`, a Manual impact section (the
   `manual-impact` skill), no attribution footer, no co-author lines. Do not merge.

## Acceptance (approved, item 2 as revised by Frank)

Checked on op0197, and items 1, 2 and 4 on op0198 too:
1. **Z:** on the overlap rings, every emitted tip equals the exact footprint maximum
   + leave at its angle, within the surface tolerance. No Z sign flip >0.1 mm except
   where that profile itself has a minimum (hex flat centres).
2. **Blocks:** no G93 block under 10 ms except the listed geometric knee steps (each
   at least 3.4 ms), and the commanded A-rate between adjacent blocks of a run within
   1.5x. The A≈126° Turn-mesh step on the finish shank is out of scope.
3. **Breaks:** 0 lift-rapid-plunge or travel-height moves inside a ring of the overlap.
4. **No gouge, no ledge:** gouge probe deepest at or below −0.0194 in into the Hex on
   every move kind for the rough (it keeps the leave), at most `minRenderHeight` for
   the finish; ledge probe 0, foot at the Turn + leave.
5. **Controls:** columns out of the neighbour's reach sample exactly what the same
   project without the Hex samples. Projects with no neighbour are byte-identical to
   a1b64cc7 **except** for fix C and the approved merge (re-record with comments,
   saying which). The #1155 suites stay green, and `npm run check:gcode` passes.
6. **Committed tests**, each with its mutation seen failing (the list is in the new
   test file's header).
7. **Performance:** op0197 generation within 1.2x of a1b64cc7, measured serially
   (243 vs 253 ms now), and the #1155 cpuRatio check within its 2.5x.

### Commands (from the worktree; Frank's .camj in `work/`)

```text
npx tsx scripts/issue-1173-block-counter.ts work/bolt-test-02-x.camj op0197
npx tsx scripts/issue-1173-block-counter.ts work/bolt-test-02-x.camj op0198
SHOW_FLIPS=1 SHOW_TINY=1 SHOW_RATIO=1 npx tsx scripts/issue-1173-block-counter.ts work/bolt-test-02-x.camj op0197
npx tsx scripts/issue-1155-rn-c-gouge-probe.ts work/bolt-test-02-x.camj op0197 op0198
npx tsx scripts/issue-1155-rn-d-ledge-probe.ts work/bolt-test-02-x.camj op0197 op0198
```

For the a1b64cc7 numbers, use a detached worktree outside every checkout:
`git -C <primary checkout> worktree add --detach <worktrees>/1173-base a1b64cc7`,
symlink node_modules, and run the same counter there. Remove it when done; one
already exists at `<worktrees>/1173-base` and can be reused, then removed.

## Scope: files DSH may touch

- `src/engine/toolpaths/rotaryModel.ts`, `src/engine/toolpaths/rotarySampling.ts`
- the rotary test files named above and `src/engine/toolpaths/rotaryNeighbourOverlapJitter.test.ts`
- `src/test/rotaryDepthCompare.ts` and its test
- `scripts/issue-1173-block-counter.ts`, plus a new export script if one is needed
- `src/engine/toolpaths/INDEX.md`, `src/test/INDEX.md`, `scripts/INDEX.md`

Do not touch the rotary continuous/helix module, link planners outside these
changes, the postprocessor, settings, UI, locale or the `.camj` format. No
`process.env` or `globalThis` in engine code. Report: what changed (file:line), the
table above re-measured on the tip, mutation results, build exit code, and e2e
results.
