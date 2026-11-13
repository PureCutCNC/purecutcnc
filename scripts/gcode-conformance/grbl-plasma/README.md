# Grbl plasma sequence verdict

The rules that decide whether an exported G-code pierce program (#983) is the
approved per-cut sequence, run on real exported output with no controller:

```
safe Z (operator zero) -> probe -> set Z zero on the sheet -> pierce-height G0
-> M3 (never M4) -> G4 dwell (seconds) -> separate G1 Z-only drop to cut height
at the plunge feed -> lead-in/contour/lead-out at the cut feed -> M5 -> safe Z
(measured from the sheet)
```

`verdict.ts` is pure: it resolves modal motion, feed and Z the way the
controller reads them, then reports one finding per violation. `verdict.test.ts`
runs the exporter's own programs as positives and, for each rule, one mutation
of that program as a negative, so a rule that stops working shows up as a
negative that passes. The matrix covers both units, line and arc leads, one and
several contours, pierce height below cut height, a switch offset present and
absent, a mirrored physical axis, and the project Z zero on the table and above
the sheet.

## Boundaries are read from explicit words

An inherited modal Z is not evidence that a move happened, so the rules read the
Z word each line carries itself:

- The probe must be preceded by a rapid carrying its own Z word (`safeZ`). For a
  later contour the retract after the previous cut satisfies it; a modal Z left
  over from the last cut does not. That retract must also come **before** any
  lateral travel toward the pierce: a rapid carrying X or Y that happens first
  has already dragged the torch, so a retract that only follows it is rejected.
- The first feed move after the dwell must be a separate `G1` carrying its own Z
  word and no X, Y or arc word (`order`), plus its own plunge feed (`feed`): a
  modal Z inherited from the pierce-height rapid is not a drop, and a `G2`/`G3`
  or a diagonal `G1` XY+Z move cuts while it descends. The cut starts afterwards
  at the height that drop set.
- The pierce-height rapid must carry its own Z word (`order`), not inherit one.
- Every later cut move must stay at the height that drop set (`cutHeight`).
- A torch-off must be followed by a retract carrying its own Z word (`retract`).
- After a touch-off Z zero is on the sheet, so that retract must be above the
  height the torch just cut at (`retract`), and so must any later safe rapid
  before the next probe (`safeZ`). A retract at or below cut height is the
  operator-zero safe height written into the sheet frame. The checker cannot
  tell a retract that is merely too high; the unit tests pin the exact value.
- A `G38` probe takes over the motion modal group, as on the controller: the
  line after it is not a rapid unless it says `G0`, so a pierce-height move
  that lost its `G0` word is rejected (`order`).
- A program that ends with the torch still on is rejected (`openTorch`): the
  cycle never reached `M5`.

A finding is reported only when the emitted program itself lacks the boundary; a
parser property or a warning is never enough on its own.

Run with `npm run check:gcode`, which runs the verdict test before the
conformance corpus. The corpus itself holds the generated programs
(`grbl-plasma-outline-mm`, `grbl-plasma-outline-inch`, `grbl-plasma-arc-leads`,
`grbl-plasma-nested`) and feeds them to GRBL's own parser (`grbl-gvalidate`).

## What gvalidate can and cannot see

`grbl-gvalidate` is GRBL 1.1's real `gcode.c`, so its arc verdicts are the
firmware's. It cannot simulate a probe: grbl-sim leaves the probe pin unset
(`//TODO: set probe pin when probing`), so a `G38.2` raises `ALARM:4` and every
later block is rejected with `error:9`. That is a simulator artefact, not a
syntax rejection — the probe line itself is parsed and reported. `run.ts` feeds
gvalidate a copy of the program with `$X` (GRBL's kill-alarm-lock realtime
command) after each probe, so the parser reaches the rest of the program, arcs
included. The unmodified program stays on disk; the verdict above is what
checks the touch-off order, signs and torch behaviour. Real probe execution
needs a table, which is the #952 exit condition.
