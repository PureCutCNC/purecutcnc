# Issue #1015 slice A — the per-angle rotary sampler

You are the implementation worker for the first slice of issue #1015 (machine
an imported 3D model inside a round bar on a rotary axis). Work only in your
task worktree. Do not create, remove, merge, push or switch branches or
worktrees. Do not open a PR. Do not run `git add` or `git commit`: leave your
edits uncommitted and report `COMMIT: none`. `gh` may be blocked; everything
you need is in this file.

Read first: `INDEX.md`, `PROJECT.md`, `AGENTS.md`, `src/engine/INDEX.md`,
`src/engine/toolpaths/INDEX.md`, then in full `src/engine/rotaryFrame.ts`,
`src/engine/aroundFrame.ts`, and in `src/engine/toolpaths/finishSurfaceParallel.ts`
the functions `computeXYBounds`, `chooseHeightMapCellSize`,
`heightMapCacheKey`, `getCachedHeightMap`, `buildHeightMap`, `safeToolTipZAt`
and how `generateFinishSurfaceParallel` chains them (around the
`requestedWaterlineCellSize` line). Also read the throwaway measurement
script on another branch for how the chain was driven:
`git show feat/issue-1015-rotary-model-measure-dsh:scripts/bench/rotaryModelSampling.bench.ts`
(read it; do not copy it into this branch). Absolute paths for every write,
no `cd`. Smallest change that does the job; match the surrounding code. No
`process.` or `globalThis` in engine code. `node_modules` is a symlink:
type-check with `npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

## The approved plan (from the issue, decided by the maintainer)

Machine a model that sits inside a round bar: for each angle, turn the model
about the bar's axis and ask the existing 3D height sampling where the tool
may go along the line over the bar's centreline. True tool shape, no unroll
approximation. Later slices build the finishing and roughing operations, end
supports, the CAM panel and export on top of this sampler; **this slice is the
sampler only**, a pure engine module with tests.

What the measurement found and the build must respect:

1. **The height-map cache returns the wrong map across orientations.** It is
   keyed on bounding box and cell size only and lives on whatever object is
   passed as the host. Two orientations with the same box (50° and 130° on the
   fixture) shared one map: 310 of 751 samples wrong, worst 11.35 mm. **Each
   orientation must be its own cache host.**
2. Building the height map is 92–95 % of the time per angle (23–62 ms per
   angle on this laptop). A full turn at 1° is 8–22 s. That is acceptable;
   do not optimise in this slice (no strip sampling, no change to
   `buildHeightMap`).

## Build — new file `src/engine/toolpaths/rotaryModel.ts`

Frozen interface (later slices code against it; keep these names and shapes):

```ts
export interface RotaryModelMesh {
  /** Project coordinates of the model as placed in the unturned bar. */
  readonly positions: Float32Array
  readonly index: Uint32Array
}

export interface RotarySampleOptions {
  /** Angles in degrees, any order, any range (not reduced to one turn). */
  readonly anglesDeg: readonly number[]
  /** Positions along the bar's axis (project X for an X bar, Y for a Y bar). */
  readonly along: readonly number[]
  /** Requested height-map cell size before `chooseHeightMapCellSize` caps it. */
  readonly requestedCellSize: number
  /** Called after each angle with (done, total); generation in a worker reports progress through it later. */
  readonly onAngle?: (done: number, total: number) => void
  /** Return true to stop early; the result then holds the angles done so far. */
  readonly shouldStop?: () => boolean
}

export interface RotarySampling {
  readonly anglesDeg: readonly number[]
  readonly along: readonly number[]
  /**
   * One row per angle, one value per `along` position: the tool tip's radius
   * from the bar's centreline (tool tip height − R) where the tool may go
   * without gouging the model, or `NaN` where no model lies under the tool
   * (free travel). Values may be negative (below the centreline); the
   * generators decide what to do with that.
   */
  readonly tipRadius: readonly Float32Array[]
  readonly stopped: boolean
}

/** The model's vertices as they sit when the stock is turned to `angleDeg`. */
export function turnedModelPositions(positions: Float32Array, stock: RoundStock, angleDeg: number): Float32Array

export function sampleRotaryModel(
  mesh: RotaryModelMesh,
  stock: RoundStock,
  tool: NormalizedTool,
  options: RotarySampleOptions,
  warnings: ToolpathWarning[],
): RotarySampling
```

Rules:

- **Turning uses the frozen sign.** A vertex `v` of the unturned stock is
  where `toolSpacePoint(v, angleDeg, stock)` says when the stock is turned to
  `angleDeg` (`rotaryFrame.ts`); take its x, y, z. Never write your own
  rotation formula.
- **Per angle:** turn the vertices → `computeXYBounds` of the turned
  positions → `chooseHeightMapCellSize(bbox, requestedCellSize, warnings)` →
  `getCachedHeightMap` with a **fresh host object for this angle** → for each
  `along` value, `safeToolTipZAt` at the point over the centreline (X bar:
  `(along, centre)`; Y bar: `(centre, along)`, `centre` from
  `roundStockCentre`) → `tipRadius = z − R`, `R = stock.thickness / 2`;
  `-Infinity` (nothing under the tool) becomes `NaN`.
- Deduplicate warnings: a capped cell size on every angle must give one
  `surfaceHeightMapReduced` warning, not one per angle.
- Report progress after each angle through `onAngle`; check `shouldStop`
  before each angle.
- No module-level caches. Nothing in this file may keep a map between calls.

## Tests — new file `src/engine/toolpaths/rotaryModel.test.ts`

`npx tsx`-style like its neighbours (plain asserts, license header, final
`console.log('… passed')`). Build meshes in the test (a triangulated cylinder
and a square prism, closed, with enough segments that facet error is well
under the tolerance you assert, and say the tolerance's origin: cell size and
facet sag).

- **Turning:** `turnedModelPositions` agrees with `toolSpacePoint` vertex by
  vertex, both bar axes; angle 0 returns the same coordinates; 360 the same
  as 0 within 1e-9.
- **Cylinder coaxial with the bar** (radius `rc`, shorter than the bar), ball
  nose: `tipRadius ≈ rc` at every angle in a set spanning all four quadrants
  and beyond 360°, at along positions well inside the cylinder; `NaN` at an
  along position farther than a tool radius past the cylinder's end. Both bar
  axes.
- **Square prism** of half-width `w` coaxial with the bar, ball nose radius
  `rt`, along positions inside it: derive by hand and write in the test the
  expected tip radius at 0°, 22.5° and 45° (at 0° the flat top: `w`; at 45° the
  corner is directly under the tool; at 22.5° the ball touches the tilted
  face — show the formula), and assert within the stated tolerance. Both bar
  axes.
- **The cache:** a mesh and two angles whose turned bounding boxes are equal
  (the square prism at 30° and 120°, or the measurement's 50°/130° case if you
  can reproduce it): the two sampled rows equal each angle sampled alone with
  a fresh call, and the test proves the boxes really were equal (so it would
  catch a shared host).
- **Stopping and progress:** `onAngle` is called once per angle with
  increasing `done`; `shouldStop` returning true after two angles gives two
  rows and `stopped: true`.
- **Warnings:** a tiny `requestedCellSize` that forces the cap on every angle
  gives exactly one `surfaceHeightMapReduced` warning.
- **Fixture timing (report, do not assert):** the model in
  `src/engine/test-fixtures/3d-imported-block-test3.camj` (asset
  `model-asset-f4e6f18b-f62d-4c6a-8009-b46d7d581c5b`, loaded the way the
  measurement script loads it, placed inside a 40 mm bar), 36 angles, 3 mm
  ball, `requestedCellSize = min(rt / 3, 0.1)`: print ms per angle. Keep this
  case fast enough that the whole test file runs in well under a minute.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: one shared cache host for all angles; the
angle's sign flipped in the turn; X and Y swapped for a Y bar; `−R` dropped
from `tipRadius`; `-Infinity` kept instead of `NaN`; `shouldStop` ignored;
warnings not deduplicated.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
the new test file, `src/engine/rotaryFrame.test.ts`,
`src/engine/toolpaths/finishSurface.test.ts`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check` (add the two
files to `src/engine/toolpaths/INDEX.md`). One test process at a time. Do not
run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, the fixture timing, and `RISKS`: anything that surprised you, any rule
above you think is wrong (say so rather than work around it), anything you
did not do.
