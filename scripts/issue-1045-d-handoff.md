# #1045 slice D — fixes from Codex review pass 1 (round and square)

Base: the #1045 feature branch with slices A, B, C merged. Read `scripts/issue-1045-a-handoff.md` and `scripts/issue-1045-c-handoff.md` for the design, then the around-mode branches of `generateRotaryFinish` / `generateRotaryRough` in `src/engine/toolpaths/rotaryModel.ts`. `gh` may be blocked: the review is quoted below. Off limits: `src/components/**`, `src/app/**`, i18n (unless a new warning is truly needed).

## Review findings (Codex, read-only, at 449e3250 — before slice C merged; re-check each on the current code)

1. **Must fix — retained round ends can be gouged.** "`rotaryModel.ts:1481` places rings within a cutter radius of retained ends, while the exact stub floor at `rotaryModel.ts:1589` applies only to square stock. Reproduced with Ø40 × 60 stock, cut band X18–42, Ø6 flat cutter, stepover 2.7, sample spacing 0.75, cell 1: at X20.6667 the cutter overlaps the retained end by 0.3333 mm but cuts at Z24.9735 against its Z40 top. No warning."
   - Reproduce it first, in a test. Then run the same input in **along** mode and say whether along gouges too. Fix around mode so no ring's cutter body enters a retained end (the chuck/tail support bands) on a round bar — the same rule the along path and the square path (C2-F7, cutter centre pulled one cutter radius inside each retained end) use; reuse their code, do not write a second rule. If along mode on a round bar gouges as well, fix it in the same way and report the output change (it is a safety fix, so byte-identity yields).
2. **Must fix — safe angular endpoints do not ensure a safe sweep.** "`emitRotaryRuns` interpolates directly when the steep-step threshold passes. On the radius-8 hex model, radius-1.5 ball, sample spacing 1.5 and cell 0.002, the A325.7143→330 move reaches radius 7.9247 at its midpoint; independent cutter contact requires 7.9643: 0.0396 mm gouge."
   - The error between two angle samples on a convex section is about `R·Δθ²/8` (bar radius R, angle step Δθ in radians). Cap the around-mode angle step so that this is at most a stated tolerance (use the tolerance the along path already accepts between samples, or 0.005 mm in mm units, converted for inch — say which and why), in addition to the `sampleSpacing` arc step. Prove it with the hex case above: no gouge beyond the tolerance at any point along any move.
3. **Tests check endpoints only; two safety mutations survive.** "In-memory mutations setting around link heights (`rotaryModel.ts:1705,1885`) to the pivot, and changing NaN fallback (`:1872`) to leave blank stock untouched, both pass."
   - Extend the independent property tests (round in `rotaryAroundPasses.test.ts`, square in `rotarySquareAroundPasses.test.ts`) to check **every move** — cuts, links, rapids, plunges — at interpolated points along the move (at least 8 per move plus every endpoint), against the independent reference body, and that every non-cut move with an A change is at or above the travel height.
   - Add a rough test where part of the band has no model under the tool: the rough must remove the blank there down to the axis fallback (or the stub floor), as the along rough does.

## Mutations (each must fail a test; restore from `cp` backup)
- links at the pivot instead of travel height (finish and rough);
- NaN fallback leaves blank stock;
- remove the new angle-step cap;
- remove the retained-end pull-in for round bars.

## Checks
`npx tsx` on `src/engine/toolpaths/rotaryAroundPasses.test.ts`, `rotarySquareAroundPasses.test.ts`, `rotaryModel.test.ts`, every `src/engine/gcode/*.test.ts` and the square rotary tests; `npx tsc -p tsconfig.app.json --noEmit`; eslint on changed files. Exit codes. Report timings for the around finish before/after the angle cap on the slice A stepped-cylinder input.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, each finding: reproduced? fixed how? along affected?, mutations and results, commands with exit codes, timings, `RISKS`.
