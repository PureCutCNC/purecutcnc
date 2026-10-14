# Issue #1015 slice C — rotary roughing and the along range (end supports)

You are the implementation worker for slice C of issue #1015 (machine an
imported 3D model inside a round bar on a rotary axis). Work only in your task
worktree. Do not create, remove, merge, push or switch branches or worktrees.
Do not open a PR. Do not run `git add` or `git commit`: leave your edits
uncommitted and report `COMMIT: none`. `gh` may be blocked; everything you
need is in this file.

Read first: `AGENTS.md`, `src/engine/toolpaths/INDEX.md`, then in full
`src/engine/toolpaths/rotaryModel.ts` and its test (slices A and B: the
per-angle sampler and `generateRotaryFinish`; read
`scripts/issue-1015-b-handoff.md` for the rules B follows, they hold here
too), `src/engine/rotaryFrame.ts`, `src/engine/aroundFrame.ts`,
`src/store/helpers/roundWorkholding.ts` (where a chuck and a tailstock sit on
a bar), `src/engine/toolpaths/warningCodes.ts`,
`src/i18n/warningsCoverage.test.ts`. Absolute paths for every write, no `cd`.
Smallest change that does the job; match the surrounding code. No `process.`
or `globalThis` in engine code. `node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

## The approved plan, for this slice

- **"Rotary rough"**: the same sampling as the finish, cut in layers of radius
  from the bar's surface inwards (stepdown), each layer the finishing path
  clamped to that radius, skipping air.
- **End supports**: two numbers on each rotary operation, stock kept at the
  chuck end and at the tail end. The path does not go there; chuck and
  tailstock keep-outs are respected.

Still engine only: no `project.ts`, no `generateOperation.ts`, no
`src/components/**`, no `src/app/**` (slice D wires the operations in).

## Build — in `src/engine/toolpaths/rotaryModel.ts`

### 1. The along range

```ts
export interface RotarySupports {
  /** Bar length kept uncut at the chuck end, measured from that end of the bar. */
  readonly chuckEnd: number
  /** Bar length kept uncut at the tail end. */
  readonly tailEnd: number
}

export function rotaryAlongRange(
  stock: RoundStock,
  clamps: readonly Clamp[],
  modelAlong: { readonly min: number; readonly max: number },
  tool: NormalizedTool,
  supports: RotarySupports,
): { start: number; end: number } | null
```

- The **chuck end** is the bar end nearer to the centre of a `chuck` clamp
  (along the bar's axis); with no chuck clamp, the bar's lower along end. The
  tail end is the other one.
- From each end inward: the support length, and, for every `chuck` or
  `tailstock` clamp at that end, the clamp's inner edge plus the tool radius
  (the tool's side must not touch it). The range starts at the larger of those
  on the chuck side and ends at the smaller on the tail side.
- **Intersect with the model's own along extent** (`modelAlong`, the model's
  bounding box along the bar). Beyond the model the bar is left at full
  radius, which is what keeps a model cut all the way round attached to the
  supports. Say so in a comment: passes that ran past the model's end would
  find nothing under the tool and cut down to the centreline there, parting
  the work.
- An empty range returns `null`; the generators then return no moves and one
  warning, new code `rotaryNoRoom`, English:
  `{operation}: no room to cut between the end supports and the chuck and tailstock. Shorten the supports or move the model.`

### 2. Shared sampling

Extract from `generateRotaryFinish` one internal helper that turns params into
the angle list, the along list and the sampled tip radii, with stock to leave
applied as B does it (enlarged tool, then `+ s`), the floor at 0, the ceiling
at `R`, and the below-centreline warning. Both generators call it, so the
roughing **samples once** and reuses that for every layer. `generateRotaryFinish`'s
output must not change: run its tests unmodified and compare the move list on
the fixture before and after your refactor (same length, same points).

### 3. `generateRotaryRough`

```ts
export interface RotaryRoughParams extends RotaryFinishParams {
  /** Radial depth of each layer. */
  readonly stepdown: number
}

export function generateRotaryRough(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: RoundStock,
  tool: NormalizedTool,
  params: RotaryRoughParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
): ToolpathResult
```

- **Layers.** Radii `r_L = R − L·stepdown` for `L = 1, 2, …`, down to the
  lowest target tip; the last layer is exactly the lowest target (no layer
  below it). Layer count `ceil((R − lowestTarget) / stepdown)`.
- **Target at a layer:** `max(target tip, r_L)`, where the target tip is the
  sampled tip with stock to leave (from the shared helper).
- **Skip air:** at layer `L` a sample needs cutting only where its target tip
  is below `r_{L−1}` (`r_0 = R`); elsewhere the previous layers already left
  it at its final height, or it is above the surface. Each pass at each layer
  is split into **runs** of samples that need cutting. Between runs, and
  between passes when the next run does not start where the last ended,
  retract to `safeRadius` (`rapid`), move there (`rapid`), and `plunge` to the
  run's first point. Material may stand above `r_{L−1}` between runs, so never
  traverse below `safeRadius` outside a run.
- **Order:** layer by layer, outermost first; within a layer, passes in angle
  order, alternating direction like the finish. Where a pass's run ends at the
  same along end where the next pass's run starts, link as the finish does
  (rise to the higher of the two targets, turn, drop) instead of retracting.
- Tools: `ball_endmill` and `flat_endmill`, as the finish.
- Same point merging, progress and stop behaviour as the finish.

### 4. Warning code

`rotaryNoRoom` next to the other rotary codes, messages in all five
`warnings` locale files (en, de, fr, es, zh-CN; only the new key, each file's
own quote style, no existing value changed); `warningsCoverage.test.ts` must
pass.

## Tests — extend `src/engine/toolpaths/rotaryModel.test.ts`

Use at least one model that is **not symmetric along the bar** (a coaxial
cone or a stepped cylinder) in every group below; a symmetric model hid a
reversed-pass bug in slice B.

- **Range:** no chuck clamp, supports 10 and 15 on a bar from 0 to 150, model
  from 5 to 145: range `[10, 135]`. A chuck clamp near the upper end swaps the
  ends. A tailstock clamp whose inner edge plus the tool radius reaches past
  the tail support moves the boundary to that edge. A model shorter than the
  space between supports gives the model's own extent. Supports that leave no
  room give `null` and the generators return `rotaryNoRoom`. Both bar axes.
- **Rough layers on the cone:** every cut point is at or above its target tip
  (never deeper than the model plus stock); for each sample the deepest point
  equals its target tip; the layer radii are `R − L·stepdown` and the last one
  is the lowest target; no layer below it.
- **Skip air:** at a sample whose target tip is above `r_{L−1}`, layer `L`
  has no cut point.
- **No traverse inside material:** every move between runs is at
  `safeRadius` (rapids) or a plunge; no `cut` move links two runs except the
  finish-style end link.
- **Sampling once:** count calls to the sampler (wrap it in the test or
  expose a counter through the `onAngle` hook): one per angle for the whole
  roughing, not one per angle per layer.
- **Finish unchanged** by the refactor (its existing tests, plus the fixture
  comparison above).
- **Fixture (report):** slice A's model in a 40 mm bar, 6 mm flat end mill,
  stepover 2 mm, stepdown 2 mm, sample spacing 0.5 mm: time, layers, moves.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: the range not intersected with the model;
the chuck end always the lower end; the clamp keep-out without the tool
radius; a layer cut below its target; air not skipped; a traverse between runs
at `r_{L−1}` instead of `safeRadius`; sampling inside the layer loop.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
`src/engine/toolpaths/rotaryModel.test.ts`, `src/i18n/warningsCoverage.test.ts`;
`npm run check:i18n`; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check` (update the `rotaryModel.ts` line in
`src/engine/toolpaths/INDEX.md`). One test process at a time. Do not run
`npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, the locale keys added per file, the fixture numbers, and `RISKS`:
anything that surprised you, any rule above you think is wrong (say so rather
than work around it), anything you did not do.
