# Issue #1103 slice ca-j: helix on square blanks once the layer is round

Part of PR #1152 (issue #1103, continuous A via helix). Frank's retest: on
`busto-rect-stock.camj` (square blank) the Rotary rough never uses the helix,
even on layers where the corners are already gone. Frank approved this slice on
2026-11-05.

## Diagnosis (Codex, measured at 9aac82ff)

`buildContinuousHelix` returns `null` for any non-round stock
(`rotaryContinuous.ts` ~line 789, `if (stock.shape !== 'round') return null`),
before sampling. On busto-rect op0021:

- Layers 1–5: no full-ring bands (the square material-touch gate rejects
  53,600 / 51,680 / 49,120 / 42,240 / 28,240 angle-position samples). Rings
  are correct there.
- Layers 6–10: one eligible band each (40 / 39 / 34 / 33 / 31 rings), layer 11
  two bands (16, 10), layer 12 two bands (6, 6), layer 13 one band (2): all ten
  refused by the shape guard, 0 raster work spent.
- Layers 14–18: no full-ring bands (model tips fail `tip < previousRadius`).

The angle-map cache is also off for square blanks (`rotaryModel.ts` ~1748,
`stock.shape === 'round'` gate on `angleMaps: 'write'`).

## What to build

Let an around-the-bar band on a **square blank** become a helix when it passes
every existing eligibility rule (full rings: material at every angle under the
square material-touch gate, `tip < previousRadius` at every angle, one run),
for rough and finish alike, with:

- the angle-map cache enabled for square-blank around operations exactly as for
  round ones (`'write'` on the ring grid, `'read-write'` in the helix), through
  the ca-i worker transport too (pool and serial must stay byte-identical);
- the square blank's retained-stub protection (`squareBlankRetainedStub`,
  `squareRotaryStubContactFloor`, `squareRotaryTouchRadius` and whatever the
  ring path applies for square blanks, `rotaryModel.ts` ~715 and ~1092-1176)
  applied at **every** helix sample and refinement point, not only at ring
  positions: a helix point must never sit lower than the ring path would allow
  at the same along position and angle;
- the existing tolerance checks, band splitting (ca-g), link rules (#1117 on
  the rough, #1093 on the finish), the shared `MAX_HELIX_RASTER_WORK` budget
  and the seam/boundary rings, all unchanged.

Bands that do not qualify keep today's forward-only rings and arcs.

## Acceptance

1. busto-rect op0021: report per layer the bands, helix-built bands, refused
   bands and why, and helix vs ring turns **measured by actual helix moves**
   (a move that is part of a helix built by `buildContinuousHelix`, not any
   move that changes along and A together: ring links and arcs do that too).
   Expect helix on layers 6–13 where the band qualifies.
2. busto-rect op0022 (finish) and square-to-round op0028 / op0029 (around):
   same report. If a band is refused, say by which rule.
3. A reversals stay 0 on every row. Along-the-bar mode and round-blank rows
   (busto-round op0025, op0015) byte-identical to 9aac82ff (moves sha256 in
   `scripts/issue-1103-baseline.md` ca-i section).
4. Pool (real worker transport) vs serial parity, byte-identical, on busto-rect
   op0021 and op0022 and square op0028 / op0029.
5. **Committed tests**, each with a mutation that must fail the suite:
   - a square-blank fixture whose round layers become a helix;
   - a helix sample inside the retained-stub zone is floored exactly as the ring
     path floors it (mutation: skip the stub floor on helix points);
   - a square-blank layer whose corners are still present stays on rings
     (mutation: drop the material-touch gate for the helix);
   - the cache is used on square blanks (mutation: keep it off; the helix must
     then cost more raster work, assert on the work number).
6. **Simulation check**: no new gouge on the retained stubs or the corners in
   the existing square-blank rotary gouge/safety tests; name the tests run.
7. **Performance**, serial, one process at a time, one warm-up and three timed
   runs: generation time for busto-rect op0021, op0022 and square op0028,
   op0029, before (9aac82ff) and after, through the pool. At most 1.1x.
8. `npm run build` green; `npm run check:gcode` passes.

## Rules

- Scope: the square-blank helix admission, its stub protection at helix
  points, and the cache gate. No change to the budget, tolerances, round-blank
  behaviour, link rules, the postprocessor, settings, UI, locale or format.
- Append a `## ca-j` section to `scripts/issue-1103-baseline.md` with the
  tables above.
- Report: what changed (file:line), the tables, mutation results, timings,
  build exit code.
