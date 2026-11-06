# Issue #1155 slice rn-d: a full ring at the foot of a neighbour's wall

Issue #1155, a fix slice after Frank's second retest of PR #1161 on 2026-11-06.
Branch `feat/issue-1155-rotary-neighbours` (rn-a, rn-b, rn-c merged). It stays
inside the plan Frank approved on 2026-11-05.

## What Frank sees

File `/home/frankp/Projects/purecutcnc/work/bolt-test-02-x.camj` (inch, round
bar along X). Read it from there; never copy it.

- Hex `f0184` along 0.75..1.25 (flats at radius 0.75); Turn `f0186` along
  1.2..3.75, Ø1. They overlap by 0.05 in at the Turn's start.
- `op0198` Rotary finish 2 (Turn, 1/4" flat `t0191`), around the bar.
- `op0197` Rotary rough 2 (Turn, same tool, stock to leave radial 0.02).

Simulation after Rotary finish 2: a stair-step ledge at the foot of the Hex's
end face (along 1.25), varying with angle, up to one stepover wide.

## Cause (measured by the coordinator on 3505887e; confirm it)

- The finish's band starts at the op's range start plus the tool radius,
  1.325. There it runs one full ring, but the flat's bottom spans 1.200..1.450
  and its left 0.05 in is over the Hex, so that ring rides at Hex height.
- The tool can first reach the Turn's surface at centre 1.25 + 0.125 = 1.375.
  The helix is already running from 1.325 at about 0.04 in per turn, so each
  angle crosses 1.375 on a different turn, which leaves the stair-step ledge.
- The rough does not have this: each depth layer below the Hex's top starts
  its full ring and helix where the tool first reaches that depth. That
  position is 1.4043, about 0.009 in further than wall + leave + radius
  = 1.25 + 0.02 + 0.125 = 1.395. The likely reason is rn-c's whole-cell
  conservative pad rounding the reachable position out by up to a cell.

## What to build

1. **Finish:** where a neighbour's wall rises out of the band (the surface the
   tool follows steps up by more than the surface tolerance within one tool
   radius along the bar), split the band there. Put a full ring at the wall's
   foot, at wall face + stock to leave + tool radius (ball and flat alike;
   for a ball, the position where the ball's side touches the face plus the
   leave). Start or end the helix (or the forward-only rings) from that ring.
   Do this at both ends: a neighbour may rise at the start or at the far end of
   the band.
2. **Rough:** the first full ring of each layer next to a neighbour's wall sits
   at exactly wall face + stock to leave + tool radius. Take the wall position
   from the neighbour's real face (its mesh), not the conservative height-map
   cell, so it is not pushed out by up to a cell. It must still never cut into
   the neighbour or its allowance.
3. No change where there is no neighbour wall: byte-identical controls (the
   existing rotary suites and the no-neighbour hashes from rn-a/rn-c).

## Acceptance

- Committed test on the partial-overlap geometry (Hex 0.75..1.25, Turn
  1.2..3.75, Ø2 inch bar), flat Ø0.25 rough and finish plus a ball finish:
  - every angle at the wall's foot is cut down to the target surface + leave
    from wall + leave + radius onwards. Measure the material left at the foot
    per angle with the cutter-body sweep: the ledge width must be ≤ the
    surface tolerance, and today's is about one stepover. It must fail before
    your fix; report the numbers;
  - the gap from the Hex face to the nearest cut point is the leave
    (±0.001 in) at every angle and depth, for rough and finish;
  - no cutter-body point inside the Hex or inside Hex ⊕ leave (rn-c's sweep).
  - Mirror case: a neighbour rising at the band's far end.
- Mutations, each failing a named test: drop the wall-foot ring; place it at
  range start + radius; take the wall from the height-map cell again.
- On Frank's file: before/after ledge width per op, moves / helix moves /
  generation time for the four rotary ops.
- `npm run build` green (report the exit code). The #1156 cross-axis golden
  (`src/engine/gcode/crossAxisHeldPrograms.golden.json`) holds real around
  programs; if they change, say so, and the coordinator re-freezes it.

## Rules

- Scope: rotary rough/finish band and ring placement and their tests. No format,
  UI or locale change, no new option.
- Report: cause confirmed or corrected (file:line), what changed (file:line),
  failing-then-passing tests, before/after numbers, build exit code.
