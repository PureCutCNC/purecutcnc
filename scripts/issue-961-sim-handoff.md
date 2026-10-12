# Issue #961 slice F — the Simulation tab cuts the real plasma kerf

You are the implementation worker for slice F of issue #961. Work only in your
task worktree. Do not create, remove, merge, push or switch branches or
worktrees. Do not open a PR. Do not run `git add` or `git commit`: leave your
edits uncommitted and report `COMMIT: none`. `gh` may be blocked; everything
you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/simulation/INDEX.md`.
Base branch is `integration/0.6.0`; project format stays 3.3; no `process.` or
`globalThis` in engine code; absolute paths for every write, no `cd`. Make the
smallest change that does the job; no refactor.

## Why (approved amendment, 2026-10-12)

Earlier slices of this issue drew a kerf band on the UNCUT sheet in the
Simulation tab, because the plan claimed a kerf is too thin for the simulation
grid. That was wrong: the simulator cuts any cell whose centre lies inside the
cutter and a 1 mm endmill simulates fine. Plasma is skipped only by explicit
`plasma` early returns left as placeholders. The maintainer wants a plasma cut
simulated like any routing cut.

## Behaviour to build (one automatic rule, no option)

- A plasma operation removes material in the simulation: a FLAT cut one kerf
  wide (tool radius = half the torch diameter, as `normalizeToolForProject`
  gives it), THROUGH THE FULL SHEET, along every torch-on move (`lead_in`,
  `cut`, `lead_out`), plus a kerf-wide hole at each pierce (the `plunge` move,
  stationary in XY). The plasma operation is a through-cut by definition, so
  the cut depth is the stock bottom **whatever Z the move carries**: the torch
  path sits at cut height ABOVE the sheet, and using its Z would cut nothing.
- "Play tool" works for a plasma operation. The torch is drawn as the same
  plain cylinder a flat endmill gets, one kerf in diameter, with its tip at the
  move's own Z (cut height). The moves keep their real Z for the pose.
- Plasma operations are simulated in `'selected'` and `'visible'` modes, are
  counted in `simulationOperationCount`, and are replayed as prior operations
  when a later operation is played.
- The kerf band and pierce markers are REMOVED from the Simulation tab. They
  stay in the Sketch and 3D views exactly as they are.
- Milling simulation output must stay identical. Do not touch the hot loop's
  cost for non-plasma tools beyond what a once-per-move branch needs.

## Where

Engine (`src/engine/simulation/`):

- `replay.ts` `applyMoveToGrid`: remove the `toolType === 'plasma'` early
  return. For a plasma tool the cutter is flat and `toolCenterZ` is
  `grid.stockBottomZ` for every sampled cell, ignoring the move's Z. Decide it
  once per move (like `isBall` / `isVBit`), not per cell.
- `replay.ts` `replayItemIntoGrid`: remove the plasma early return.
  `moveIsMaterialRemoving` already covers `cut`, `plunge`, `lead_in`,
  `lead_out`; leave it.
- `replay.ts` `simulateOperationHeightfield`: it finds the tool with
  `findMillingOperationTool`, which returns null for a torch. Use the general
  lookup (`findOperationTool` in `src/toolPolicy.ts`) so a plasma operation is
  simulated.
- `tools.ts` `cutterSurfaceZ`: find its callers. If any path a plasma tool now
  reaches uses it, give `plasma` the flat-cutter answer; otherwise leave the
  value and fix the comment (it still says the preview is #961).
- `toolMesh.ts` `buildToolMesh`: remove the plasma early return so a torch gets
  the flat-endmill cylinder. Check every `switch`/branch on the tool type in
  that file handles `plasma`.
- `playback.ts`: read `PlaybackController`; it should work unchanged once
  `applyMoveToGrid` cuts for plasma. Change it only if it filters plasma.
- Update `src/engine/simulation/INDEX.md` (the `toolMesh.ts` line mentions
  plasma having no mesh).

App (`src/app/useSimulationModel.ts`, ESLint `max-lines` 530 for `src/app/**`):

- Every `findMillingOperationTool` call in this file (the acquire filter, the
  selected-operation result, the replay items, the playback input, the prior
  items) excludes plasma. Use `findOperationTool` instead so plasma is
  included. Keep the existing `drill` exclusion for playback.
- `simulationOperationCount`: drop the `hasPlasmaTool` exclusion.
- Remove the Simulation-tab overlay added by slice B: the
  `simulationPlasmaKerf` memo and return field, `src/app/simulationPlasmaKerf.ts`
  and `src/app/simulationPlasmaKerf.test.ts` (delete both files), the
  `plasmaKerf` prop in `src/App.tsx`, and in
  `src/components/simulation/SimulationViewport.tsx` the `plasmaKerf` prop, its
  ref, the `disposePlasmaKerfObjects` callback and the effect that adds the
  band. For anything else slice B changed in `SimulationViewport.tsx` (the
  dispose helper), restore the `origin/integration/0.6.0` version unless
  something still needs it; `git show origin/integration/0.6.0:<path>` shows
  the original. Remove the `simulationPlasmaKerf` lines from `src/app/INDEX.md`.
- Do NOT change `src/components/plasmaKerfPreview.ts`,
  `src/components/canvas/**`, `src/components/viewport3d/**`.

Browser spec `e2e/plasmaKerfPreview.smoke.spec.ts`: in the Simulation test,
also assert that the "Play tool" button (`ui.simulation.playTool` in
`e2e/selectors.ts`, or whatever that selector is called there) is ENABLED for
the selected plasma operation. Keep the existing assertions. You cannot run a
browser; say it was not run.

## Tests (plain `assert` + `npx tsx file.test.ts`, next to the existing ones)

In `src/engine/simulation/replay.test.ts` (or a new
`replayPlasma.test.ts` beside it), using a real
`generatePlasmaProfileToolpath` result built the way
`src/engine/toolpaths/plasma.test.ts` builds its project and torch, on a grid
whose cell is at most a quarter of the kerf:

- every cell whose centre is within `kerf/2 - cell` of a torch-on move is at
  `stockBottomZ`; every cell farther than `kerf/2 + cell` from all torch-on
  moves is still at `stockTopZ`;
- the pierce point is cut through;
- a toolpath of rapids only cuts nothing;
- the result is the same when every move's Z is raised by 10 (the move's own Z
  does not matter);
- the part side of the part line stays uncut, within one cell (the kerf edge
  lies on the part line), for an outside contour and for a hole;
- `simulateOperationHeightfield` on a plasma operation returns no
  `replayNoTool` warning and a non-zero removed cell count.
- If `useSimulationModel` has a testable seam (see
  `src/app/useSimulationModel.test.ts`), assert a plasma operation is counted
  and gets a playback input; if not, say so in RISKS.

Existing replay/playback/tabbed-edge tests must pass unchanged.

Mutations, one at a time, restored from a `cp` backup (never `git checkout`),
each must fail a test: (a) put the plasma early return back in
`replayItemIntoGrid`; (b) use the move's Z instead of `grid.stockBottomZ`;
(c) double the radius for plasma. Report survivors.

## Checks

`npx tsx` on every test file you add or change, plus
`src/engine/simulation/replay.test.ts`, `playback.test.ts`,
`tabbedEdgeSimulation.test.ts`, `src/app/useSimulationModel.test.ts`,
`src/components/viewport3d/plasmaKerfObjects.test.ts`; `npx tsc -b`;
`npx eslint` on the changed files; `npm run docs:check` if you touched an
INDEX.md. Do not run `npm run build` or `npm test`.

Finish with exactly:

```
STATUS: complete | blocked
COMMIT: none
CHANGED_FILES: <comma-separated paths>
CHECKS: <each command and pass/fail result>
MUTATIONS: <each mutation and whether a test caught it>
RISKS: <none or concise unresolved risks>
```
