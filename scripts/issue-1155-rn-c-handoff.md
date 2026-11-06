# Issue #1155 slice rn-c: no gouge where a neighbour only partly overlaps

Issue #1155, a fix slice after Frank's retest of PR #1161 on 2026-11-06. Branch
`feat/issue-1155-rotary-neighbours` (rn-a and rn-b merged). It stays inside the
plan Frank approved on 2026-11-05: no other model feature on the bar may be cut
into.

## What Frank sees

File `/home/frankp/Projects/purecutcnc/work/bolt-test-02-x.camj` (inch, round
bar along X, stock Ø2, one Around setup). Read it from there; never copy it.

- Hex `f0184` (canned polygon): along 0.75..1.25, 6 sides, across flats 1.5
  (flats at radius 0.75).
- Turn `f0186` (canned turn): along 1.2..3.75, Ø1. **It overlaps the Hex by only
  0.05 in at the Turn's start.** In rn-a's test bolt the Turn covered the Hex's
  whole length, so this partial overlap was never tested.
- `op0197` Rotary rough 2 (target Turn, 1/4" flat endmill `t0191`, stock to
  leave 0) and `op0198` Rotary finish 2 (same tool).
- `op0195` / `op0196` Rotary rough / finish (target Hex, 1/4" and 1/8" ball).

In the simulation after Rotary rough 2, the Hex's wall facing the Turn (its end
face at along 1.25) is gouged, and so is the edge where the Turn meets the Hex.

## What to do

1. **Reproduce first, on this file**, with production `computeOperationToolpath`
   (the rn-a probe `scripts/issue-1155-bolt-depth-probe.ts` is a start). Sweep
   the real cutter body (flat cylinder for op0197/op0198, ball for op0195/op0196)
   along every cut move at ≤ ¼ tool-radius steps against the analytic Hex prism
   (and the Ø1 Turn cylinder, for the Hex ops). Report the deepest intrusion,
   its along/angle and the move kind (helix, ring, link, boundary ring, entry,
   retract). If no move intrudes, say so plainly and check whether the
   simulation shows material removed that the moves do not remove, then stop
   and report: that is a display bug, not this slice.
2. **Find the cause** in the code path that produces those moves (for example
   the neighbour along-overlap cull, the cut range or boundary rings at the
   target's start, the retained-stub walls, the helix/ring seam, or the link
   safety check), and fix it there. Do not hide it by lifting the whole op or
   by dropping the neighbour.
3. **Committed test** that builds this partial-overlap geometry in code (Hex
   0.75..1.25 and Turn 1.2..3.75 on a Ø2 inch bar, flat Ø0.25 rough and finish,
   plus the Hex ops with a ball), and runs the same cutter-body check. It must
   fail on the branch head before your fix; give the failing numbers. Also cover
   the mirror case (a Turn ending 0.05 inside a Hex at its far end).

## Acceptance

- On Frank's file and on the committed geometry, no cutter body point sits
  inside the Hex deeper than `minRenderHeight` for op0197/op0198, and none inside
  the Turn for op0195/op0196. Report the before/after depth for each op.
- The rn-a gouge checks, byte-identical controls and the bolt move hashes from
  rn-a/rn-b stay as they are, or the report says which changed and why.
- Moves / helix moves / generation time for the four ops before and after.
- `npm run build` green (report the exit code); `npm test` before pushing.

## Rules

- Scope: rotary sampling/generation code touched by #1155 and its tests. No
  format, UI or locale change, no new option.
- Report: cause (file:line), what changed (file:line), the failing-then-passing
  test, before/after numbers, build exit code.
