# Issue #1177 handoff: ledge on the Hex flat at the turned shoulder

Branch `fix/issue-1177-hex-shoulder-ledge`, based on `integration/0.6.0` at
`1c4ab3e8` (includes the #1173 fix, PR #1174). The plan of record is the
diagnosis comment on #1177, approved by Frank for 0.6.0. The PR goes into
`integration/0.6.0` with `Closes #1177` and a Manual impact section. It is not
merged until Frank checks it in the app.

## Frank's file

`work/bolt-test-02-x.camj` is gitignored. If it is missing from your worktree's
`work/`, copy it from the primary checkout's `work/`. Never commit it, and never
put it in `test-fixtures/`. `work/hex-edge-ledge.png` is Frank's screenshot.

- op0197 *Rotary rough 2* and op0198 *Rotary finish 2*: the Turn (f0186), flat 1/4" endmill.
- op0195 / op0196: the Hex (f0184).
- The Ø1 Turn starts 0.05 in (1.270 mm) inside the 1.5 in Hex. Hex end X=31.750 mm, Turn start X=30.480 mm.

## Cause (Codex, read-only, at 55c7d964)

`rotaryBandEnds` (`rotaryModel.ts`, ~:1568) sees the taller Hex and keeps the
start pull. Because of that, `rotaryCutterSpan` (~:1678) puts the first cutter
centre one radius past the Turn start, inside the Hex overlap. `rotaryWallFeet`
(~:2335) clears the turned side, but nothing cleans up across the Hex flat, so the
cutter only just reaches the flat near the overlap and leaves a wedge between
sweeps. Protection is not inflated: it uses the real cutter disc
(`rotarySampling.ts`, ~:1461).

Measured, Turn rough + finish only, height left above the Hex plane:
- X=30.734, A=15°/20°/25°: 0.277/0.390/0.496 mm.
- X=31.496: 0.048–0.076 mm.

## Task

1. Add a bounded shoulder-cleanup sweep, in rough and finish, that reaches across
   the overlapping Hex flat. It must keep the neighbour protection: no gouge into
   the Hex anywhere. Check the cutter can actually reach before you choose
   between ring refinement and a local sweep. Pick the smallest change.
2. Do not reopen #1173: the shank depth must stay identical to the Hex-removed
   control, and `rotaryNeighbourOverlapJitter.test.ts` must stay green unchanged.
   Keep the #1173 smoothness numbers on op0197/op0198: no A direction flips, no
   new blocks under 10 ms, no new adjacent A-rate jumps over 1.5x, no new G0 Z
   lifts.
3. No new UI or options (hobby scope: one automatic behaviour).

## Acceptance

- A committed test on a fixture built in the test (not Frank's file) that
  reproduces this overlap: after rough + finish, the swept cutter reaches the Hex
  plane within 0.05 mm at the shoulder (the X=30.734, A=25° spot on Frank's file
  is 0.496 mm today), and never cuts below the Hex. Show it fails when the fix
  is reverted (mutation run).
- Re-measure on Frank's file: the residual above the Hex flat at the spots above,
  Turn ops only and full sequence, plus a gouge check against the Hex.
- Regenerate exports into `work/`: `bolt-test-02-x-mm-1177_op0197.nc`,
  `_op0198.nc`, `_all.nc` (mm, same as #1173).
- `npm run build` green; run the rotary suites and the e2e specs that assert
  rotary output.
