# #1045 slice L — a square around finish only after a rough that really ran; exact match; a faithful reference

Base: the #1045 feature branch (slices A–I, K/K2). Read `scripts/issue-1045-k-handoff.md` (design: export regenerate-and-match; generator safety by independent model), then `rotaryOperation.ts` (`squareRoughStatus` / finish licensing), `motionPipeline.ts` (the match), and `squareAroundGenerator.property.test.ts`. Off limits: `src/components/**`, `src/app/**` except tests, `src/engine/simulation/**`.

## Codex review pass 6 (at 564b556f), must fix
1. "An ineffective rough still licenses a finish. rotaryOperation.ts:64 checks metadata and range, without proving machining coverage. On the 20×40 square fixture, setting rough stepdown to zero produces no rough moves, yet the finish generates 1,547 moves and posts without warnings. Independent Cartesian replay measured an 8.88 mm bite. A valid rough leaving 5 mm followed by a zero-allowance finish also posts, taking 5.41 mm; the property suite uses matching allowances and misses this combination."
2. "The required rough need not appear in the exported program. motionPipeline.ts:1222 regenerates against the complete project operation list. Keeping the rough enabled there but exporting only the finish produces 67,599 bytes without warnings."
3. "The reference does not faithfully replay swept material. squareAroundGenerator.property.test.ts:278 checks one 'nearest' fraction for ordinary ring moves. A Ø4 flat move from tip 10→8 while A0→10 leaves the reference radius at 9.95 on the A0.25 ray, although the cutter removes material at radius 8.2. A pure plunge checks its starting tip and reports zero engagement. At line 291 the outer-wall condition also skips interior ball-shank removal. Line 394 ignores requestedCellSize, violating the required reference resolution."
4. "The comparison admits different posted motion. motionPipeline.ts:1042 uses relative tolerance. A 1e-9 mm coordinate edit passed; with the origin positioned at a rounding boundary, the emitted Z changed from 0.002 to 0.001. Exact deterministic comparison is required."
5. src/engine/toolpaths/INDEX.md:41 still describes the removed guard.

## Rules to build (manager)
- **A finish is licensed by a rough only if that rough actually leaves the finish a bounded bite**, decided by the generator from the rough's own result, not its settings: regenerate (or reuse) the licensing rough's toolpath result and derive, from its own sampled final tips, the radius it leaves at every finish sample (conservatively: the highest the rough leaves within the finish cutter's footprint); refuse the finish (`rotarySquareFinishNeedsRough`, reworded if needed: "rough first: the finish would take more than X mm in one pass here") where `left − finish tip` exceeds the finish's own bound = the larger of the finish's stepdown (if the operation has one) and its stockToLeave + a stated scallop allowance. A rough with no moves licenses nothing.
- **The licensing rough must precede the finish in the same exported program.** At export, a square around finish whose licensing rough is not earlier in the same program (disabled, excluded from this export, in another setup/program, or after it) is refused with a clear code. The regenerate-and-match for the finish uses the same project state as the export.
- **Exact match:** compare the posted toolpath with the regenerated one exactly (same numbers bit for bit; they come from the same deterministic generator).
- **Faithful reference:** the property test's reference sweeps every move continuously (sample each move at steps no coarser than its own resolution in angle, along and Z — not one nearest fraction), handles pure plunges (engagement over the whole Z travel), removes interior material under a ball's shank, and is at least 4× finer than the generator's `requestedCellSize` for every case. Add the reviewer's repros (tip 10→8 while A0→10; pure plunge; shank) as reference unit tests against hand-computed values.
- Property test additions: zero-stepdown / no-move roughs, mismatched allowances (rough leaving 5 mm, finish 0), finish exported without its rough, rough after finish — each must be refused, never posted.

## Mutations (each must fail; restore from `cp` backup)
- license by metadata again; allow an excluded rough; relative-tolerance compare; reference with one nearest fraction per move.

## Checks
`npx tsx` on the property test, both around suites, `rotaryModel`, `rotaryMerge`, the square rotary tests, `squareRotaryOutput`, `squareRotaryProgramSafety`, `exportRotarySafety`, every `src/engine/gcode/*.test.ts`; `npm run check:gcode`; `npx tsc -p tsconfig.app.json --noEmit`; `npm run lint`; exit codes. Keep the property test under 4 minutes. Report export and generation time on the slice-G inputs, and confirm a normal rough→finish square-to-round project (Frank's `square-to-round-test-01.camj` style, defaults) still generates and exports without refusals.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, per finding fixed how, the licensing rule as built, property-test worst values, timings, mutations, commands with exit codes, `RISKS`.
