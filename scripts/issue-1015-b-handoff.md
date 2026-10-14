# Issue #1015 slice B — the rotary finishing generator

You are the implementation worker for slice B of issue #1015 (machine an
imported 3D model inside a round bar on a rotary axis). Work only in your task
worktree. Do not create, remove, merge, push or switch branches or worktrees.
Do not open a PR. Do not run `git add` or `git commit`: leave your edits
uncommitted and report `COMMIT: none`. `gh` may be blocked; everything you
need is in this file.

Read first: `AGENTS.md`, `src/engine/toolpaths/INDEX.md`, then in full
`src/engine/toolpaths/rotaryModel.ts` and its test (slice A, the per-angle
sampler you build on), `src/engine/rotaryFrame.ts`, `src/engine/aroundFrame.ts`
(`wrapPoint`, `unwrapToolpath`: the wrapped toolpath form every Around
operation produces), `src/engine/toolpaths/types.ts` (`ToolpathResult`,
`ToolpathMove`, `ToolpathPoint`), `src/engine/toolpaths/warningCodes.ts`,
`src/i18n/warningsCoverage.test.ts`, and `safeToolTipZAt` in
`finishSurfaceParallel.ts`. Absolute paths for every write, no `cd`. Smallest
change that does the job; match the surrounding code. No `process.` or
`globalThis` in engine code. `node_modules` is a symlink: type-check with
`npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

## The approved plan, for this slice

"Rotary finish": passes run **along the bar** and step **round it** (the
direction a ball nose leaves the best surface on a long part). Inputs:
tool, stepover (a distance at the bar's surface, turned into an angle step),
feed, stock to leave. The toolpath is the tool over the bar's centreline at
the sampled height for each angle, already in the wrapped form Around
operations use, so export, the 3D view and the simulation take it unchanged.
Nothing below the centreline is ever cut; a model that needs it gets a warning
naming the place. Ball nose first; flat end mills too because the sampler
already handles them; any other tool is refused with a message.

**This slice is the generator only**: a pure function with tests. The
operation kind, the CAM panel, end supports (which along range is cut) and
dispatch from `generateOperation.ts` are later slices. Do not touch
`src/types/project.ts`, `generateOperation.ts`, `src/components/**` or
`src/app/**`.

## Build — add to `src/engine/toolpaths/rotaryModel.ts`

Frozen interface:

```ts
export interface RotaryFinishParams {
  /** Distance between passes, measured round the bar's surface. */
  readonly stepover: number
  /** Distance between samples along a pass. */
  readonly sampleSpacing: number
  /** Material left on the model, measured normal to its surface. */
  readonly stockToLeave: number
  /** The along range the passes cover; the caller (a later slice) derives it from the model and the end supports. */
  readonly alongStart: number
  readonly alongEnd: number
  /** Tool-tip radius from the centreline for rapids and links in air; must be above the bar's surface. */
  readonly safeRadius: number
  /** Requested height-map cell size, passed to the sampler. */
  readonly requestedCellSize: number
}

export function generateRotaryFinish(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: RoundStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
): ToolpathResult
```

Rules:

1. **Angles.** `n = ceil(2π·R / stepover)` passes, `R = stock.thickness / 2`,
   evenly at `a_k = k · 360 / n` for `k = 0 … n−1`, so the real stepover is at
   most the requested one.
2. **Samples along** from `alongStart` to `alongEnd` inclusive, evenly, at
   most `sampleSpacing` apart (both ends included even when the span is not a
   multiple).
3. **Stock to leave, normal to the surface:** sample with the tool's radius
   (and diameter) enlarged by `stockToLeave`, then add `stockToLeave` to the
   returned tip radius. Explain in a comment why this leaves the stock normal
   to the surface for a ball nose (an enlarged ball's centre is the real
   ball's centre offset outward by `s`). Zero stock leaves the sampler's value
   unchanged.
4. **Floor and ceiling.** `NaN` (no model under the tool) and anything below
   zero become `0` (the centreline). A sample whose value was below zero
   before clamping (the model needs a cut below the centreline) adds **one**
   warning per operation, new code `rotaryBelowCentreline`, naming the first
   place: `{along, angle}` rounded to two decimals; English:
   `{operation}: the model reaches below the bar's centreline near {along} along the bar, at {angle}°. Those places are left uncut.`
   Values above `R` are clamped to `R` (air above the surface).
5. **Wrapped points.** Each sample becomes a point with the tool over the
   centreline: for an X bar `{x: along, y: centre, z: R + tip, a}`, for a Y bar
   `{x: centre, y: along, z: R + tip, a}`, `centre = roundStockCentre(stock)`.
   This is exactly `wrapPoint` of the sheet point; assert that in a test rather
   than calling `wrapPoint` with an invented sheet coordinate.
6. **Zigzag.** Pass `k` runs from `alongStart` to `alongEnd` when `k` is even,
   back when odd. Between passes a `cut` link turns from `a_k` to `a_{k+1}` at
   the same along position, at the higher of the two tips at that end, with a
   short rise or drop as separate moves where the heights differ (rise first,
   turn, then drop). The angle keeps increasing across the whole job (never
   reset to 0).
7. **Entry and exit.** Start with a `rapid` at `safeRadius` over the first
   sample (angle `a_0`), then a `plunge` to the first tip; finish with a
   `rapid` retract to `safeRadius`. All other moves are `cut`.
8. **Tools.** `ball_endmill` and `flat_endmill` only. Anything else returns no
   moves and one warning, new code `rotaryToolUnsupported`, English:
   `{operation}: Rotary finishing needs a ball nose or flat end mill.`
9. **Point count.** Merge collinear points along each pass: drop an interior
   point whose distance from the straight line between its kept neighbours is
   at most 1 µm (0.001 mm; 0.00004 in for an inch project, read from
   `tool.units`), keeping every pass's first and last point. Report point
   counts (before and after) for the fixture below at stepover 0.2 mm and 0.5 mm.
10. **Progress and stop** pass straight through to `sampleRotaryModel`. When
    stopped, return no moves and no warning (the caller knows it stopped).
11. Declare both warning codes next to the other rotary/around ones in
    `warningCodes.ts`; add their messages to all five `warnings` locale files
    (en, de, fr, es, zh-CN: only the new keys, each file's own quote style, no
    existing value changed); `src/i18n/warningsCoverage.test.ts` must pass.

## Tests — extend `src/engine/toolpaths/rotaryModel.test.ts`

- **Coaxial cylinder** (radius `rc`), ball nose, no stock: every `cut` point
  on a pass lies at `z = R + rc` (tolerance stated, from cell size and facet
  sag), `y = centre` (X bar) / `x = centre` (Y bar), every point carries `a`;
  the distinct pass angles are `k · 360 / n` with the `n` of rule 1; passes
  alternate direction; the first move is a rapid at `safeRadius` and the
  last a retract to it. Both bar axes.
- **Stock to leave** on the coaxial cylinder: `z = R + rc + s` for a ball.
  On the square prism at 0° (flat top): `z = R + w + s`.
- **Wrapped form:** `unwrapToolpath` of the result gives sheet points whose
  across coordinate is `sheetStart + a · C / 360` and whose height is the tip
  radius; and every point equals `wrapPoint` of that sheet point (shows the
  export, 3D view and simulation will read it right).
- **Below the centreline:** a model that dips below the axis somewhere (for
  example a thin plate through the axis, so that at some angles the tool would
  have to go below zero): no point below `z = R`, exactly one
  `rotaryBelowCentreline` warning, with a plausible along and angle.
- **Links:** at every pass end the link's height is the higher of the two
  tips; no link moves along the bar.
- **Range:** no point outside `[alongStart, alongEnd]`.
- **Tools:** a V-bit is refused with `rotaryToolUnsupported` and no moves; a
  flat end mill on the coaxial cylinder gives `z = R + rc`.
- **Point merging:** a pass over a flat stretch keeps its two ends and drops
  the middle; a curved stretch keeps its points.
- **Fixture (report, assert only that it runs and produces moves):** the
  model from slice A's fixture in a 40 mm bar, 3 mm ball, stepover 0.5 mm,
  sample spacing 0.2 mm: time, angles, moves before/after merging.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: `n` from `floor` instead of `ceil`; stock
to leave added without enlarging the tool; `NaN` kept instead of the floor;
the clamp at `R` removed; passes not alternating; the link at the lower of
the two tips; the angle reset each pass; the warning emitted per sample.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
`src/engine/toolpaths/rotaryModel.test.ts`, `src/i18n/warningsCoverage.test.ts`,
`src/engine/aroundFrame.test.ts`; `npm run check:i18n`;
`npx tsx scripts/check-license-headers.ts`; `npm run docs:check` (update the
`rotaryModel.ts` line in `src/engine/toolpaths/INDEX.md`). One test process
at a time. Do not run `npm run build`, `npm test` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS`, the mutation
table, the locale keys added per file, the fixture numbers, and `RISKS`:
anything that surprised you, any rule above you think is wrong (say so rather
than work around it), anything you did not do.
