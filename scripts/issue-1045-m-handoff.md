# #1045 slice M — the square around finish protects itself; no licensing

Base: the #1045 feature branch (through slice L). Read `scripts/issue-1045-k-handoff.md` and `scripts/issue-1045-l-handoff.md`, then the around-mode finish/rough in `src/engine/toolpaths/rotaryModel.ts`, `rotaryOperation.ts` (the licensing: `squareRoughStatus` etc.), and the export match in `src/engine/gcode/motionPipeline.ts`. Off limits: `src/components/**`, `src/app/**` except tests, `src/engine/simulation/**`.

## Decision (Frank, 2026-10-21)
A square-blank around-the-bar **finish** is self-protecting: it removes any standing blank material above its finish surface in its own stepdown layers, from the blank's corner radius down, exactly as the around rough does, then makes its finish pass. It never depends on another operation being run, exported or effective. The finish-needs-a-rough licensing (slices K/L) is removed. Accepted cost: after a rough those layers mostly cut air.

Why: Codex pass 7 found the licensing still leaking (an empty exported rough still licensed the finish; a Ø12 finish after a Ø4 rough with longer end supports bit 3.6 mm into material the rough never reached). Licensing reasons about another operation; a self-protecting finish needs only its own geometry.

## Build
1. **Generator:** on a square blank, `generateRotaryFinish` in around mode emits, before its finish rings, the same layered clearing the around rough does (same per-sample touch-radius rule, stub floor, retained-end pull-in, alternating rings, A bounded) down to the finish surface + its stockToLeave, using the finish operation's own stepdown (use the rotary stepdown field the finish already has; if it has none, the rough's default for that tool — state which). Then the finish pass. Round bars: unchanged (a round bar has no corners standing above the turned surface beyond what the finish already handles — confirm and say so, or apply the same if it does).
2. **Remove** the licensing: `squareRoughStatus`/coverage, `rotarySquareFinishNeedsRough` and the export check that the licensing rough precedes the finish (keep the regenerate-and-match check, exact). Remove their locale keys from all five locales and the coverage test.
3. **Remaining Codex pass-7 items, fix:**
   - "The reference still loses interior removal (squareAroundGenerator.property.test.ts:375) ... for a Ø4 ball, tip 2, ray offset 20°, solid extending to radius 6.5: the body removes radii 2.300–5.848, but the reference records nothing there. Plunge engagement is also calculated but never asserted at line 1075." → fix the reference's ray/body intersection for interior spans and assert plunge engagement.
   - "Default cutting programs receive no property coverage (line 990): all five surviving default cases are bare finishes that refuse before replay." → with licensing gone, bare finishes generate; make sure at least 30 cases run at the adapter's default parameters (shorter bars, not coarser reference), including finish-only, rough+finish, along-rough + around-finish, with and without retained ends.
   - "Conformance remains a branch regression (scripts/gcode-conformance/corpus.test.ts:125 fails because rotary-model-rough-own-axis emits G93; passes on integration)." → find which #1045 change made that corpus program emit G93 and fix it (or, if G93 is now correct for that move, update the corpus expectation with the reason — say which).
4. Property test assertions: every generated program (any combination, any order, any subset exported) stays within bound against the independent reference.

## Mutations (restore from `cp` backup)
- drop the finish's own clearing layers → the finish-only property cases fail; reference without interior spans → the ball interior unit test fails; plunge engagement unasserted → a plunge repro test fails.

## Checks
`npx tsx` on the property test (≤ 4 min), both around suites, `rotaryModel`, `rotaryMerge`, the square rotary tests, `squareRotaryOutput`, `squareRotaryProgramSafety`, `exportRotarySafety`, every `src/engine/gcode/*.test.ts`; `npm run check:gcode` (must pass); `npx tsc -p tsconfig.app.json --noEmit`; `npm run lint`; exit codes. Report generation/export times on the slice-G inputs and on a default square-to-round rough→finish, before/after (the finish is now longer).

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, what was removed, how the finish clears, property-test numbers (cases at defaults, worst values), the G93 finding, timings, mutations, commands with exit codes, `RISKS`.
