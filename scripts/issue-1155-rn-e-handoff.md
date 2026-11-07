# Issue #1155 slice rn-e: cut to the model's ends

Issue #1155, a fix slice after Frank's second retest of PR #1161 on 2026-11-06.
Branch `feat/issue-1155-rotary-neighbours` (rn-a…rn-d merged; rn-d added the wall-foot ring and exact footprint tips).

## What Frank sees

File `/home/frankp/Projects/purecutcnc/work/bolt-test-02-x.camj` (inch, round
bar along X). Read it from there; never copy it. `op0195` / `op0196` Rotary
rough / finish target the Hex `f0184` (along 0.75..1.25) with 1/4" and 1/8"
ball endmills. The tool centre stops one tool radius inside each end of the
Hex, so a ball leaves a ridge at both of the Hex's ends.

## Frank's decision (2026-11-06)

He was asked whether the plain bar beyond a model's end is material to keep, or
material the operation may cut into. His answer: **"May cut into it"**.

Rule: a rotary rough or finish runs the tool to the **edge of its target's
surface** at both ends along the bar. A ball's or flat's centre may go up to the
model's end, so the cutter reaches the edge, and the cutter body may cut the
plain bar beyond the end. Only these stop it, all as today:

- other models (the #1155 neighbours);
- the end-support lengths (Chuck-end / Tail-end support);
- the chuck and tailstock keep-outs;
- the bar's outside.

The retained bar beyond the model's length no longer blocks the tool, except
where an end support keeps it.

## Second case Frank found (2026-11-06)

Frank moved the Turn to start exactly where the Hex ends (along 1.25 in) and
set Rotary rough 2's stock to leave to 0. In the simulation, a thick collar
stays on the Hex's end face below the Hex, well beyond the Hex rough's ridge.

The coordinator's probe on 3505887e, using a copy of the file with that edit:
every rough layer below the Hex's flats starts at along **1.4526 in**. It should
start at 1.25 + 0 + 0.125 = 1.375, so it is 0.078 in (about 2 mm) short at
every depth. On the saved file (Turn from 1.2, leave 0.02) the same layers
start at 1.4043 instead of 1.395.

So a target whose range starts right at a neighbour's face is pushed out much
further. The likely cause is the retained-stub wall at the range start, added
on top of the neighbour, plus rn-c's cell pad. rn-d corrects the
neighbour-wall position; this slice must also make the stub wall stop blocking.

Acceptance for this case:
- Turn 1.25..3.75 against Hex 0.75..1.25, flat Ø0.25 rough and finish, leave 0.
- Every layer's first cut sits at 1.375 ± 0.001 in.
- The material left on the Hex face below the flats is ≤ the surface
  tolerance.
- Repeat with leave 0.02: the first cut sits at 1.395 ± 0.001 in.

## What to build

- Find where the cut range and the retained-stub walls clamp the tool centre to
  the target's along extent minus/plus the tool radius (`rotaryOperation.ts`
  range, `rotaryModel.ts` `prepareRotaryTargets` / `withRetainedBar`,
  ring/helix band ends, the ca-j retained-stub floor). Change them so the centre
  may reach the target's ends.
- Beyond the end, the height the tool may go down to comes from the target's
  surface at its end (drop-cutter on target + neighbours). Never from the stub
  walls, except inside an end-support length or a keep-out.
- Boundary rings (#1103) move to the new band ends.
- Rough layers at the ends follow the same rule.
- Along mode follows the same rule.
- Square blanks: the corner material gate and the square-blank safety guards
  stay.

## Acceptance

- Committed test: on the bolt geometry (Hex 0.75..1.25 on a Ø2 inch bar, ball
  Ø0.25 rough and Ø0.125 finish), the material left at each Hex end, measured
  with the cutter-body sweep against the analytic Hex, is ≤ the surface
  tolerance + leave. Today the ridge is about one tool radius wide, so the test
  fails before the fix. Same for a flat finish.
- With an end support covering the region beyond an end, the tool still stops
  short there. With a neighbour model beyond the end, the rn-a…rn-d gouge
  checks still pass.
- Mutations, each failing a named test: restore the centre clamp at
  end ∓ radius; let the tool into an end-support length; drop the neighbour
  check beyond the end.
- Byte-identical controls: projects whose ops already end against an end
  support or a neighbour. Name the suites whose pins change and why.
- `npm run build` green (report the exit code). If the #1156 cross-axis golden
  programs change, say so; the coordinator re-freezes it.

## Rules

- Scope: rotary rough/finish range and end handling, plus tests. No format, UI
  or locale change, and no new option. The manual line "Cuts are restricted to
  the model's length…" changes; list it under Manual impact in the report.
- Report: cause (file:line), what changed (file:line), failing-then-passing
  tests, before/after ridge width and moves/time for the four ops on Frank's
  file, build exit code.
