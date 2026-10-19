# #1045 slice F — make the square guard provably conservative (Codex review pass 3)

Base: the #1045 feature branch (slices A–E2). Read `scripts/issue-1045-e-handoff.md` (design of the standing-material guard), then `src/engine/gcode/squareSweepGuard.ts` and its tests. `gh` may be blocked: the review is quoted below. Off limits: `src/components/**`, `src/app/**` except tests.

## Review pass 3 (Codex, at 19786871), all must fix
1. "Grid resolution can miss the cutter entirely. squareSweepGuard.ts:155: the along-bin cap widens bins beyond small cutters. Reproduced on a 20×1,000 mm square blank, Ø0.2 flat, X500, tip radius 9, A0→360, stepdown 2: posts without warnings, despite a 5.142 mm corner bite. No grid cells change. Resolution must remain conservative when capped; angular bins also need cutter-size coverage."
2. "Material lowering confuses vertical height with radial distance. squareSweepGuard.ts:489: a flat at tip 9 leaves radius 9/cos(φ) off its axis, but cutSample records 9. Reproduced with an Ø8 non-turning cut at A0, then an Ø1 turning descent A10.25→10.3 to tip 6.95: posts without warnings, taking 2.197 mm against a tolerance-inclusive bound of approximately 2.124 mm. Lowering needs the actual ray/cutter intersection."
3. "The ball gouge still exceeds the stated tolerance. rotaryAroundPasses.test.ts:1137: the hex repro now measures 0.01364 mm emitted gouge where tol is 0.005 mm. The test passes by adding measured endpoint undercut to its allowance. Removing that addition fails."
Also: "replacing grid lowering with `material[...] = 0` survives both boundary tests and the square export regression block."

## What to do
- **Conservative by construction.** The guard may refuse a safe program in a corner case (say so in its warning) but must never admit an unsafe one. Wherever a cell is coarser than the geometry it summarises, the cell must over-estimate standing material when measuring engagement and under-estimate removal when lowering. If the bins needed for a cutter would exceed the memory/time budget, refuse with a clear message (e.g. "the blank is too long for the export check at this cutter size; split the operation") instead of widening bins.
- **Exact radial lowering:** what a cut leaves in a cell is the radius from the pivot at which that cell's angular ray meets the cutter body (flat: the disc at the tip and the cylinder; ball: the sphere), not the tip height. Measure engagement the same way.
- **Angle bound (finding 3):** the handoff's rule is `tol = max(0.005 mm converted, along path's s²/(8r))`. Make the test assert the emitted motion against exactly that number, with no added measured allowance, and make the subdivision meet it (or, if it truly cannot for a reason, state the reason and the bound it does meet, and make that the documented and tested bound).
- **One seeded property test against an independent reference** (new `src/engine/gcode/squareSweepGuard.property.test.ts`): ≥ 200 seeds of random square blanks (side 10–60, length 20–1000), random flat/ball cutters (Ø0.2–12), random programs of 1–4 operations mixing non-turning cuts and turning cuts at random tips and A spans (including > 360°), with stepdown/stockToLeave bounds. The reference is a dense exact model (fine polar sampling of the blank cross-section per along slice, with the true cutter body), written independently of the guard. Assert: **every program the guard admits has, in the reference, no turning cut exceeding its bound** (conservative), and report the false-refusal rate on programs the generator itself emits for Frank-like inputs (must be 0 for a normal rough+finish).
- Codex's three repros and the `material[...] = 0` mutation as tests.

## Mutations (each must fail; restore from `cp` backup)
- widen bins past the cutter again; record tip height instead of the radial intersection; lowering sets material to 0; drop the angular cutter coverage; add a measured allowance back into the angle test.

## Checks
`npx tsx` on the new property test, `squareSweepGuard.test.ts`, both around suites, `squareRotaryOutput`, `squareRotaryProgramSafety`, `exportRotarySafety`, every `src/engine/gcode/*.test.ts`; `npx tsc -p tsconfig.app.json --noEmit`; eslint; exit codes. Report guard time on the 60×200 mm Ø4 flat rough and on a 20×1000 mm Ø3 ball rough+finish.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, each finding fixed how, the conservativeness argument in a few lines, property-test numbers (seeds, admitted, refused, false refusals), timings, mutations, commands with exit codes, `RISKS`.
