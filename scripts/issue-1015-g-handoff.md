# Issue #1015 slice G — three machine-motion defects from the second review

You are the implementation worker for a fix slice of issue #1015 (machine an
imported 3D model inside a round bar on a rotary axis). Work only in your task
worktree. Do not create, remove, merge, push or switch branches or worktrees.
Do not open a PR. Do not run `git add` or `git commit`: leave your edits
uncommitted and report `COMMIT: none`. `gh` may be blocked; everything you
need is in this file.

Read first: `AGENTS.md`, `scripts/issue-1015-{a,b,c,d,e,f}-handoff.md` (they
still apply), then in full `src/engine/toolpaths/rotaryModel.ts` and its test,
and `src/engine/toolpaths/rotaryOperation.ts`. Absolute paths for every write,
no `cd`. Smallest change that does the job; match the surrounding code. No
`process.` or `globalThis` in engine code. `node_modules` is a symlink:
type-check with `npx tsc -p tsconfig.app.json --noEmit` and
`npx tsc -p tsconfig.node.json --noEmit`, never `npx tsc -b`.

A second independent review reproduced three defects that would cut the wrong
thing on a machine. Fix all three, each with a test that **measures the
cutter against the model**, not only endpoint coordinates.

## 1. Turning links gouge between pass angles

`emitRotaryRuns` links two passes at the same along position by rising to the
higher of the two end tips, turning, and dropping. The model between the two
pass angles is never checked: on a square prism of half-width 10 mm in a
40 mm bar, a 6 mm ball and a 6 mm stepover, the 34.29° → 51.43° link runs at
tip radius 13.598 mm while the corner at 45° needs 14.141 mm, a 0.542 mm
gouge, in the finish and the rough, on both bar axes.

Rule: a turning link rises to the **bar's surface plus a clearance**
(`R + clearance`, with `clearance = convertLength(1, 'mm', tool.units)`),
turns there, and drops. Nothing (model or standing stock) is ever above the
bar's surface, so the turn is always in air, and it is far shorter than a
retract to `safeRadius`. If `safeRadius` is lower than that (it never should
be), use `safeRadius`. Test: the prism case above (finish and rough, both bar
axes): every turning move's tip radius is `≥ R + clearance` (wrapped
`z ≥ 2R + clearance`); and an independent check, sampling the model with
`sampleRotaryModel` at angles every 1° across each link's sweep at the link's
along position, finds no angle where the link's height is below the sampled
safe tip.

## 2. The cutter's side crosses the model's end into the retained bar

`rotaryAlongRange` limits the **tool centre** to the model's along extent, so
at the model's end the cutter's side reaches a tool radius past it into the
bar that is meant to stay and hold the part. For an off-axis prism spanning
along 10–30 mm with zero supports and a 2 mm flat end mill, the rough plunges
to the centreline at along 10, and the cutter also cuts the bar at 9.5.

Rule: the bar beyond the model's along extent (from the model's ends out to
the bar's ends, or to the supports when they are inside that) is stock to
keep, and the sampler must see it. Add it to the mesh that is sampled: two
closed coaxial cylinders of radius `R`, one from the bar's lower along end to
the model's lower along extent, one from the model's upper along extent to
the bar's upper end, triangulated with enough segments that their facets do
not undercut `R` by more than `minRenderHeight` (say how many). With them in
the mesh the existing tool-shape sampling keeps the cutter's side out of the
retained bar by itself. Keep `rotaryAlongRange` as it is. The outside-bar
check (slice F) must keep looking at the model alone, not at these stubs.
Test: the off-axis prism case: for every cut move, the cutter's swept volume
does not enter the retained region (check that no point of the cutter at any
cut point lies at along < model min or > model max while below `R − ε`; for a
flat end mill the cutter is the disc of radius `r` at the tip, for a ball the
sphere), both bar axes, rough and finish.

## 3. Point merging drifts below the surface

`mergeCollinearCuts` drops a point when it is within tolerance of the line
from the last kept point to the next point, but never rechecks the points it
already dropped against the final segment. On a coaxial curved profile
`r(x) = 6 − 0.001·(x − 20)²` from 10 to 30 mm with 0.05 mm samples, the whole
run collapsed into one straight segment 0.0995 mm below the sampled
clearance, against a 0.001 mm tolerance.

Rule: a merged segment may replace a run of points only if **every** point of
the run is within the tolerance of that segment (Douglas–Peucker, or an
extend-while-all-points-fit loop; say which and its cost on the slice-B
fixture). Test: the profile above: every original sample lies within the
tolerance of the merged path (measure the distance from each sample to the
segment that covers its along position); and no merged point lies below its
covering samples by more than the tolerance. Update the finish fixture's
pinned move count and hash in the test (the old values pinned the bug); say
the new values.

## Mutations

One at a time, restored from a `cp` backup (never `git checkout`); name the
failing test or report a survivor: the link at the higher end tip again; the
retained-bar stubs left out of the sampled mesh; the merge checking only the
immediate neighbour again; the outside-bar check counting the stubs.

## Checks to run and report

The two `tsc --noEmit` commands; `npx eslint` on changed files; `npx tsx` on
`src/engine/toolpaths/rotaryModel.test.ts`,
`src/engine/toolpaths/rotaryOperation.test.ts`,
`src/components/cam/rotaryOperations.test.ts`,
`scripts/gcode-conformance/corpus.test.ts`; `npx tsx scripts/check-license-headers.ts`;
`npm run docs:check`. Then run the whole unit suite once at the end with
nothing else running (`npx tsx scripts/run-tests.ts`) and report its result.
Do not run `npm run build` or any browser test.

## Report

End with `STATUS`, `COMMIT: none`, `CHANGED_FILES`, `CHECKS` (with the full
suite's result), one line per numbered item, the new fixture numbers, the
mutation table, and `RISKS`.
