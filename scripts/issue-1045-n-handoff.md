# #1045 slice N — bounded finish work; a reference with no blind spots

Base: the #1045 feature branch (through slice M). Read `scripts/issue-1045-m-handoff.md` for the design (self-protecting square around finish), then `generateRotaryFinish` / `generateRotaryRough` in `src/engine/toolpaths/rotaryModel.ts` and `src/engine/toolpaths/squareAroundGenerator.property.test.ts`. Off limits: `src/components/**`, `src/app/**` except tests, `src/engine/simulation/**`, `src/engine/gcode/postprocessor.ts` (another branch).

## Codex review pass 8 (at 9345c132), must fix
1. "Unbounded finish generation. generateRotaryFinish (rotaryModel.ts:2172) accepts arbitrarily small positive stepdowns. Number.MIN_VALUE produces infinite layers; my subprocess timed out after 15 seconds. MAX_ROTARY_SAMPLES bounds sampling, not this loop, which also lacks cancellation checks. Refuse excessive layer × sample work before emission."
2. "The reference misses real surface engagement. referenceMove:360 bounds its angular window using the blank's maximum radius. Reproduced: Ø4 flat, plunge from tip 10 to 8, material radius 9.95, ray 10° off-axis. Independent contact is 8.1234, giving 1.8266 mm engagement; the reference returns zero. Thus an over-bound plunge can pass despite the new assertion."
3. "Interior spans remain outside the safety proof. referenceMove:466 updates only a diagnostic maximum, retaining no cavity state and asserting no interior engagement or retained-end exclusion. The pass-7 Ø4 ball repro still returns zero engagement for a 3.5477 mm occupied span. The new unit test explicitly expects zero; it preserves this blind spot."
(Codex's own independent replays found the generator itself within bound: at most 1.00003 mm removal with 1 mm finish layers, including finish alone. So items 2–3 are about the test, item 1 about the generator.)

## Build
1. Generator: before emitting, compute the work (layers × rings × samples) for the rough and the finish; refuse with the existing `operationStepoverRatioRange` (or a new clear code, five locales) when it exceeds a stated budget, and refuse a stepdown that is not finite and ≥ a stated minimum (e.g. 0.01 mm converted). Add the cancellation check (`shouldStop`) in the layer loops as the sampler has. Apply the same to the around rough.
2. Reference: the angular window must be derived from the actual material radius at the cutter (or simply the full circle for a plunge's footprint), not the blank's maximum radius; the reference keeps full cavity state per ray (all occupied intervals, not just the outer radius), measures interior engagement (material inside the cutter body anywhere along the ray, including below the outer surface) and asserts it, and asserts retained-end exclusion on interior spans. Fix the unit test that expects zero for the pass-7 ball repro: it must report the 3.5477 mm span and fail if the reference ignores it. Add Codex's plunge repro (Ø4 flat, tip 10→8, material radius 9.95, ray 10°: engagement 1.8266) as a unit test.
3. The property test still passes (≤ 4 minutes, ≥ 38 default cases); report its worst values with the new interior assertion.

## Mutations (each must fail; restore from `cp` backup)
- remove the work budget → a tiny-stepdown test hangs-guard fails (use a time-bounded assertion); angular window from the blank radius again → plunge repro fails; drop interior intervals → ball interior test fails.

## Checks
`npx tsx` on the property test, both around suites, `rotaryModel`, `rotaryMerge`, the square rotary tests, `squareRotaryOutput`, `squareRotaryProgramSafety`, `exportRotarySafety`; `npm run check:gcode`; `npx tsc -p tsconfig.app.json --noEmit`; `npm run lint`; exit codes.

## Report
`STATUS`, `COMMIT: none`, `CHANGED_FILES`, per item, the budget and minimum chosen, property-test worst values (incl. interior), mutations, commands with exit codes, `RISKS`.
