# Issue #1015, slice L: make the rotary sampler cost scale with the strip, not the model

Follow the Session rules in issue #962. Base: `feat/issue-1015-rotary-model` (PR #1025). `gh` may be
blocked in your sandbox; this file carries what you need. Engine code: **output must stay
byte-identical** (every move of every rotary operation, on every existing test and on Frank's file).

## The problem (measured by the manager, Node, idle machine)

Frank's bust (`/Users/frankp/Projects/purecutcnc/work/rotary-busto.camj`, 492,458 triangles,
1,474,007 vertices, 3 in bar) with his **Rotary finish** (1/16 in ball, stepover 0.16 → 943 angles,
322 samples per angle, cell 0.005 in) takes about **69 ms per angle, ~65 s** in
`sampleRotaryModel` (`src/engine/toolpaths/rotaryModel.ts`). Per angle:

- `turnModelInto` over all vertices: ~10 ms;
- `getCachedHeightMap` → `buildHeightMap` (`finishSurfaceParallel.ts`) over the whole turned
  model: ~48 ms;
- the 322 `safeToolTipZAt` calls: ~0.4 ms.

Every sample sits on the line over the centreline (`y = centre` for an X bar, `x = centre` for a Y
bar), and `safeToolTipZAt` only reads cells within `ceil(tool.radius / cellSize)` of the query
cell. So almost all of the map is built and never read.

Probes: `work/finishProbe.ts` and `work/stripProbe.ts` in the feature worktree are gitignored; the
second is the manager's prototype of step 1 below (run with `npx tsx work/stripProbe.ts` from the
worktree root; it prints `differing 0`). Copy what helps into your slice worktree's `work/`.

## What to build

**Step 1: rasterise only the rows (columns, for a Y bar) that the samples read.** Keep the
height map's grid exactly as today: same `bbox`, same `cellSize` from `chooseHeightMapCellSize`
on the full turned bbox (the cap and its warning must not change), same `originX/originY`,
`width`, `height`, and a full-size `data` array filled with `-Infinity`. Only rasterise cells
whose row lies within the reach of the line (`neighborCells + 1` rows either side of the query
row, clamped to the grid). Same arithmetic per cell as `buildHeightMap` (the prototype shows that
shifting the origin instead changes 61 of 2,576 samples through rounding; keeping the grid gives
0). Add this as an optional row (or column) window on the height-map builder in
`finishSurfaceParallel.ts`; do not change any existing caller's behaviour, and do not put a
windowed map into `getCachedHeightMap`'s shared cache. Manager's measurement: 48 → 14 ms per angle.

**Step 2: stop touching the whole mesh at every angle.** After step 1 the remaining per-angle
cost is turning every vertex (~10 ms) and scanning every triangle (~9 ms). Once per operation,
in the bar's cross-section (across, up relative to the axis), work out for each triangle the range
of polar angles it covers and its least distance from the axis (the true triangle-to-axis
distance in that plane, not just its vertices; a triangle containing the axis covers every angle),
and bucket triangles by angle. At each angle, turn and rasterise only the triangles that can
reach the strip (`|turned across| ≤ reach`), conservatively: when in doubt, include. The
`bbox` must stay exactly what `turnModelInto` produces today from all vertices (it sets the grid
origin and the cell size): find a way that is provably identical (for example the extremes in
the across direction come from the cross-section's convex hull vertices, computed once, with the
same arithmetic as `turnModelInto`, and `fround` as today), or, if you cannot make that
identical, keep a cheap all-vertex pass for the bbox only and say so. Turned vertex values used
for rasterising must be computed with exactly the arithmetic `turnModelInto` uses today.

Both steps apply to rough and finish (they share `sampleRotaryModel`), and to a bar along Y.

## Tests (they must bite: break the code, see a test fail, put it back; list each mutation)

- A reference test: keep today's full-map sampler as a test-only reference and compare
  `tipRadius` bit for bit against the new path on **asymmetric** seeded random meshes (not
  symmetric along or across the bar): triangles crossing the axis, long thin triangles spanning
  large angles, triangles just inside and just outside the strip at several angles, and a
  bar along Y. Many angles each, including angles that put a triangle exactly at the strip edge.
- A mutation that narrows the strip by one row, and one that drops the "triangle contains the
  axis" case, must each fail a test.
- Existing: `src/engine/toolpaths/rotaryModel.test.ts` (including the 30-case property test),
  `rotaryOperation.test.ts`, the conformance corpus test, all unchanged and green.

## Proof on Frank's file

Generate both of Frank's operations (`op4028` Rotary rough 2, `op4029` Rotary finish) through
`generateRotaryOperation` before (on the base commit) and after, compare the moves for exact
equality, and report the times for each. Print the probe output at the end (Node output piped to
a file flushes late on macOS).

## Off limits

Everything outside `src/engine/toolpaths/rotaryModel.ts`, `finishSurfaceParallel.ts` and their
tests (plus new test helpers if needed). No behaviour change for non-rotary operations.

## Report

Changes per file, each mutation and whether a test caught it, before/after times and the
equality result on Frank's file, the exact commands with exit codes, RISKS.
