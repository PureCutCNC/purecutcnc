# Issue #1155 slice rn-a: rotary rough/finish keep clear of neighbour models

Issue #1155: an around-the-bar rotary rough or finish ignores every model on the
bar except its own target and cuts straight through them. The plan is the
approved comment on #1155 (Frank approved it on 2026-11-05). Branch
`feat/issue-1155-rotary-neighbours`, based on `integration/0.6.0` at `428a285e`.

## Cause (read at 428a285e)

- `rotaryContext` builds the sampled surface from the **target's** models only:
  `resolveFinishModelSurface(project, models)` (`src/engine/toolpaths/rotaryOperation.ts:165`).
  The along range comes from that surface's extent (`rotaryOperation.ts:167-179`).
- `prepareRotaryTargets` samples that mesh plus the retained bar stubs beyond the
  cut range (`src/engine/toolpaths/rotaryModel.ts:1696`, `withRetainedBar`). The
  stubs are appended after the model, and `retainedTriangleStart` marks where they
  start (`rotaryModel.ts:1196-1234`).
- So inside the target's range the drop cutter sees only the target. On
  `work/bolt-test-02.camj` *Rotary rough 2* / *Rotary finish 2* (op0197 / op0198,
  target Turn f0186, Ø1 in over 0.75–3.75 in) cut the Hex f0184 (1.5 in across
  flats, 0.75–1.25 in) down to the Turn.
- Precedent for the rule: Around follow-line already treats **every** STL model on
  the bar as material (`src/engine/aroundFrame.ts:285-335`, `aroundMaterialBands`).

## The approved rule

An around-the-bar rotary rough or finish never cuts into **any other STL model
feature on the bar**. That means a resolved feature whose definition is kind
`stl` with operation `model`: canned Turn/Polygon and imported models. Visibility,
and whether another operation targets the model, do not matter. This is the same
set `aroundMaterialBands` reads. Flat add/subtract and line features are not
neighbours. Overlapping models are a **union**: inside its range the operation
cuts down to the higher of the target and its neighbours.

## What to build

1. In `rotaryOperation.ts`, collect the **neighbours**: models that are not targets
   and whose along extent overlaps the target's along range. A model that does not
   overlap is left out (the stubs already stand there), so projects with an
   unrelated second model stay byte-identical. Pass the neighbour mesh to the
   generators **separately** from the target surface.
2. In `rotaryModel.ts` (`prepareRotaryTargets`, both drivers), the sampling mesh is
   target + neighbours + stubs, in that order. The neighbours go **before** the
   stubs so `retainedTriangleStart` still marks only wall triangles. The sampler,
   around refinement, helix raster maps (`angleMaps`, `rotaryModel.ts:1720-1735`)
   and ring/helix eligibility then see the neighbour with no second code path.
   Square blanks in around mode keep their stubs out of the mesh exactly as today
   (`rotaryModel.ts:1692`); neighbours still go in.
3. These stay **target-only**: the along range, `modelOutsideBar` (a neighbour
   sticking out of the bar must not raise the warning for this operation),
   `modelIds`/`modelNames` (so the finish-without-rough advisory is unchanged) and
   the #1096 region mask. A region limits where the target is cut and never
   uncovers a neighbour.
4. `src/engine/toolpaths/finishModelSurface.ts`: any joined-mesh cache key must
   cover the neighbour ids, so a target-only mesh and a target+neighbour mesh
   never share an entry.
5. Along mode uses the same mesh and gets the same rule. Engrave/follow-line is
   unchanged.

## Measured by the planner (prototype, not the build you will write)

Node probe on `work/bolt-test-02.camj`, sync driver, single runs. The prototype
appended the other models to the sampled surface and kept the range from the
target. Head span 0.75–1.25 in, minimum emitted tip radius:

| op | today | with neighbour |
|---|---|---|
| op0197 Turn rough | 0.5294 | 0.7798 |
| op0198 Turn finish | 0.5092 | 0.7595 |

The Hex flats radius is 0.75. The Hex ops (op0195 / op0196, with the Turn as
their neighbour) **changed** even though the Turn lies inside the Hex over their
band: rough 2108→2028 moves, finish 9210→9282. Their minimum tip did not drop.
The cause was not isolated; the likely one is the height-map hull/grid moving with
the extra mesh (`rotarySampling.ts:635-651`). The probe and the prototype diff are
in the coordinator's notes folder as `1155-probe.ts` / `1155-probe-hack.diff`; ask
the coordinator if you want them.

## Acceptance

1. **Bolt report** on `work/bolt-test-02.camj` (read from the primary checkout's
   `work/`, never copied). For op0195–op0198, before (428a285e) and after: moves,
   helix moves (moves inside a helix built by `buildContinuousHelix`, not any move
   that changes along and A together), minimum tip radius over the head span and
   over the shank, and warnings.
2. **Explain or remove the Hex-op drift.** Either make op0195/op0196 byte-identical
   to 428a285e, or say what moved them (file:line) and show that no emitted point
   sits deeper than the 428a285e run at the same along/angle, beyond one
   height-map cell.
3. **Byte-identical controls**, moves sha256 measured by you at 428a285e and after,
   on every operation in the tables of `scripts/issue-1103-baseline.md`
   (busto-round op0025/op0015, busto-rect op0021/op0022, square-to-round
   op0028/op0029 around and along). First confirm each has no neighbour model
   overlapping its target. If one has, report it and leave it out of the controls.
4. **Committed tests** in a new `src/engine/toolpaths/rotaryNeighbours.test.ts`,
   built in code from canned Turn + Polygon models (no new fixture file). Each must
   fail under the named mutation, and the report gives the failing test for each:
   - Bolt case on a round bar, around rough and finish, flat and ball cutters:
     a **gouge check against the Hex solid**. Sweep the real cutter body (flat
     cylinder / ball) along every cut move at steps of at most a quarter tool
     radius. No body point may lie inside the analytic hex prism deeper than
     `minRenderHeight`; for the rough, also not inside the hex grown by stock to
     leave. Mutation: leave the neighbours out of the mesh.
   - The same bolt case in along mode, and on a square blank in around mode.
     Mutation: same as above.
   - Neighbours appended **after** the stubs are caught. Mutation: swap the order
     so the wall boundary covers neighbour triangles.
   - A #1096 include region on the Turn op that covers the Hex: Hex still survives.
     Mutation: apply the region to the neighbour mesh.
   - Helix: the shank band still becomes a helix and the head band falls back to
     rings (`full` false, `rotaryModel.ts:3815-3830`). Assert both, including the
     gouge check on helix moves. Mutation: let the helix sample the target-only mesh.
   - A neighbour sticking out of the bar does not raise `rotaryModelOutsideBar` on
     the Turn op. Mutation: run the outside-bar check on the combined mesh.
   - A model outside the target's along range changes nothing (moves hash equals
     the no-neighbour run). Mutation: drop the overlap cull.
5. **Pool vs serial parity**, byte-identical, on the bolt op0197/op0198 through the
   real worker transport.
6. **Performance**: a committed `cpuRatio` assertion (read `docs/PERF_ASSERTIONS.md`
   first): Turn rough with neighbour vs the same op without it, at most 2.5x. Also
   report wall time, serial, one process at a time, one warm-up and three timed
   runs, for op0195–op0198 before and after.
7. `npm run build` green (report the exit code); `npm run check:gcode` passes;
   `npm test` before pushing.

## Rules

- Scope: neighbour collection, the sampling mesh composition and the cache key
  above. No change to toolpath caching/invalidation (slice rn-b), tolerances,
  helix budget, link rules, the postprocessor, settings, UI, locale, `.camj`
  format or the 3D view's fold (`csg.ts`).
- No new manual option (hobby scope).
- No `process.env`/`globalThis` switches in engine code.
- Frank's files live only in the primary checkout's `work/`; read them from there
  and never copy them into the repo or `test-fixtures/`.
- Report: what changed (file:line), the tables above, mutation results, timings,
  build exit code.
