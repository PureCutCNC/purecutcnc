# Grbl plasma sequence verdict

The rules that decide whether an exported G-code pierce program (#983) is the
approved per-cut sequence, run on real exported output with no controller:

```
safe Z (operator zero) -> probe -> set Z zero on the sheet -> pierce-height G0
-> M3 (never M4) -> G4 dwell (seconds) -> G1 drop to cut height at the plunge
feed -> lead-in/contour/lead-out at the cut feed -> M5 -> safe Z
```

`verdict.ts` is pure: it resolves modal motion, feed and Z the way the
controller reads them, then reports one finding per violation. `verdict.test.ts`
runs the exporter's own programs as positives and, for each rule, one mutation
of that program as a negative, so a rule that stops working shows up as a
negative that passes. The matrix covers both units, line and arc leads, one and
several contours, pierce height below cut height, a switch offset present and
absent, and a mirrored physical axis.

## Boundaries are read from explicit words

An inherited modal Z is not evidence that a move happened, so the rules read the
Z word each line carries itself:

- The probe must be preceded by a rapid carrying its own Z word (`safeZ`). For a
  later contour the retract after the previous cut satisfies it; a modal Z left
  over from the last cut does not.
- The first feed move after the dwell must carry its own Z word (`order`): a
  modal Z inherited from the pierce-height rapid is not a drop to cut height.
- The pierce-height rapid must carry its own Z word (`order`), not inherit one.
- Every later cut move must stay at the height that drop set (`cutHeight`).
- A torch-off must be followed by a retract carrying its own Z word (`retract`).
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
