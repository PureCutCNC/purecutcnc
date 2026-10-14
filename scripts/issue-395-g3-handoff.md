# Issue #395 slice G3 — fixes after the manager's review of G1 and G2

You are the implementation worker for a fix slice of issue #395 (an "Around"
face on a round bar). Work only in your task worktree. Do not create, remove,
merge, push or switch branches or worktrees. Do not open a PR. Do not run
`git add` or `git commit`: leave your edits uncommitted and report
`COMMIT: none`. `gh` may be blocked; everything you need is in this file.

Read first: `AGENTS.md`, `src/engine/simulation/INDEX.md`, then in full
`src/components/simulation/SimulationViewport.tsx`,
`src/components/simulation/aroundView.ts`, `src/app/simulationSetup.ts`,
`src/app/useSimulationModel.ts`, `src/engine/simulation/aroundWrap.ts` and its
test, `src/engine/csg.ts` (`roundBarGeometry`, `roundBarSolid`,
`buildAroundModelSolid`, `buildBooleanModel`), `src/engine/csgAroundFace.test.ts`,
the last test of `e2e/around3d.smoke.spec.ts`. Absolute paths for every write,
no `cd`. Smallest change that does the job; no refactor; match the surrounding
code. `node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

Two slices just landed on this branch: G1 (Around features in the 3D model)
and G2 (the Simulation tab shows an Around setup as the bar, turning under the
tool). Both were reviewed against the code and run in a browser. Fix the six
items below, each with a test that fails before the fix where one is asked for.

## 1. Remove the Unrolled toggle (maintainer's decision)

The maintainer: "I don't think we need unrolled view in the simulation." An
Around setup is simulated as the bar only.

- Remove the Unrolled button, its `unrolled` state, and everything that exists
  only to serve the toggle in `SimulationViewport.tsx`: `playbackViewRef` and
  the resume logic around it (a view change no longer happens, so a playback
  controller is never carried over), `viewOrigin`'s unrolled branch, the
  `unrolled` value of `data-simulation-view` (it is now `bar` or `flat`).
- `SimulationBar.unrolledOrigin` goes; the bar view draws the real origin.
- Remove `viewport.sim.unrolled` and `viewport.sim.unrolledTitle` from all five
  locale `viewport` files. Nothing else in those files changes.
- Remove `simSetup.unrolled` from `e2e/selectors.ts` and the toggle steps from
  the last test of `e2e/around3d.smoke.spec.ts`; rename the test so it no
  longer says "unroll". Keep its bar checks, its three screenshots, the
  playback angle check and the Top-setup `flat` check; assert the Top and the
  Around setup show no button named `Unrolled`. Give that test
  `test.setTimeout(120_000)`: on a software-rendered runner with two workers it
  ran past the default 60 s.
- The heightfield replay is untouched: the unrolled project, the fold and the
  grid's `wrap` stay exactly as they are. Only the flat *view* of an Around
  setup goes.
- Update `src/engine/simulation/INDEX.md`, `src/app/INDEX.md`,
  `src/components/INDEX.md` and comments that mention the toggle or the
  unrolled view of the simulation.

## 2. The camera must not re-frame while the user works

`SimulationBar` and its `frame` are new objects every time the model's setup
input is recomputed (selecting another operation, any project edit). In
`SimulationViewport.tsx` the turn-group effect depends on that object's
identity and sets `hasAutoFramedRef.current = false`, so in the bar view the
camera jumps back to the default framing on every such change, and the turn
group, meshes and fixtures are torn down and rebuilt. A flat setup keeps its
camera; the bar must too.

Fix: the viewport's effects key on the frame's **values** (axis, centre,
radius, sheetStart, circumference), not on object identity, and nothing resets
`hasAutoFramedRef` except what resets it for a flat setup today (the
`projectKey` change). Put the comparison in a small pure helper in
`aroundView.ts` (for example a stable key string, or a hook-free
`sameAroundFrame(a, b)`), with a test in
`src/engine/simulation/aroundWrap.test.ts` or a new
`src/components/simulation/aroundView.test.ts`: two frames built from the same
stock are equal; changing the diameter, the axis or the bar's position is not.
Say in the report which effects' dependency lists you changed and why each is
now stable across an unrelated project edit.

## 3. A test for the seam's neighbour lookup

`aroundCell` in `aroundWrap.ts` makes the shaders read across the seam (the
cell before the first across row is the last one). With its wrap removed
(`if (false) cell.y = …`) every test still passes. Add a test that runs the
GLSL through `glslScalar.testSupport.ts` (extend the support minimally if it
cannot run integer code; say so) or, if that is not possible, move the index
arithmetic into a scalar GLSL function that the support can run, and test it:
index −1 → count−1, count → 0, −2 → count−2, count+1 → 1, in-range unchanged,
for both bar axes. The along axis must not wrap.

## 4. A test that the flat model stays in the union

In `buildBooleanModel`, replacing `union(flat, around)` with the Around solid
alone passes every test. In `csgAroundFace.test.ts`, the scene with a Top pad,
a Top pocket and an Around pocket must still contain the pad: assert vertices
of the model exist at the pad's corners outside the bar's cylinder (pick a pad
that sticks out of the bar, or check the fixture's does), and that the model's
bounding box covers both the bar and the pad.

## 5. The bar solid's facets must sit on the stock mesh's facets

In the browser the uncut bar shows long stripes along its length where the
translucent stock mesh and the model alternate in front. `roundBarSolid`
(Manifold cylinder) and `roundBarGeometry` (THREE cylinder) both use
`ROUND_BAR_SEGMENTS`, but their facets do not start at the same angle. Make
the solid's circle vertices coincide with the stock mesh's (rotate the solid
about its own axis by the phase difference, or build it from the same
angles). Test, both bar axes: every vertex of `roundBarSolid`'s mesh lies
within 1e-6 (relative to the radius) of a vertex position of
`roundBarGeometry` after both are brought into the same space, and the two
have the same number of distinct rim vertices. `roundBarGeometry` itself must
not change (the stock mesh's positions are compared exactly by
`csgRoundStock.test.ts`).

## 6. Small things

- `SimulationViewport.tsx`: after item 1, `bar` being present always means the
  bar view; simplify `wrappedFrame` and the `visibleClamps` / stock choices
  accordingly, without changing what a flat setup does.
- Leave `return () => heightfieldTexture.dispose()` in the static-mesh effect
  as it is.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: `aroundCell`'s wrap removed; the wrap
applied to the along axis too; `union(flat, around)` replaced by `around`;
the phase rotation of `roundBarSolid` removed; the frame comparison ignoring
`sheetStart`.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
every test file you changed or added, plus every `*.test.ts` under
`src/engine/simulation/`, `src/app/aroundSimulation.test.ts`,
`src/app/simulationSetup.test.ts`, `src/app/useSimulationModel.test.ts`,
`src/engine/aroundFeatureSolid.test.ts`, `src/engine/csgAroundFace.test.ts`,
`src/engine/csgRoundStock.test.ts`; `npm run check:i18n`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check`;
`npx tsx scripts/check-e2e-lanes.ts`. Search the whole tree for `unrolled` and
`Unrolled` afterwards and list every remaining hit with one word on why it
stays (the engine's `unrolledProject` and the Sketch view's unrolled sheet
stay). One test process at a time. Do not run `npm run build`, `npm test` or
any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, one line per
numbered item, the mutation table, the locale keys removed per file, the
remaining `unrolled` hits, and `RISKS`: anything that surprised you, any item
above you think is wrong (say so rather than work around it), and anything you
did not do.
