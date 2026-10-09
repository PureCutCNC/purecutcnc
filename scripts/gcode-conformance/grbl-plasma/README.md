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
negative that passes.

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
