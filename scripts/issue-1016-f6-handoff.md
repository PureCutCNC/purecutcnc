# #1016 C2 slice F6 — exact retained-stub contact (square blanks)

Approved by Frank 2026-10-18 (revert F5, fix the stub intrusion first). MACHINE MOTION. Follow #962 Session rules. DSH writes code, COMMIT: none. Format 3.3. Round-bar output byte-identical (round stubs are a #1042 item).

## Defect (independent Codex review, measured)
`withRetainedBar` (src/engine/toolpaths/rotaryModel.ts ~1031) adds the retained square stubs (`squareBlankRetainedStub`, material from each bar end to the cut range ends `alongStart`/`alongEnd`) to the mesh the sampler reads, and the tool-shape sampling lifts a sample only where its discrete footprint samples hit the stub. That misses thin overlaps:
- 25 mm square, default chuck (x -40..15), Square to round start 10 len 30 Ø20, 6 mm flat, stepover 0.4: the finish at A0 plunges at x20.933333 to tip radius 9.999256; the cutter (radius 3) reaches x17.933333, i.e. 0.066667 mm axially into the retained x<18 stub, 2.500744 mm deep over that overlap.
- At A7.769784 the kept endpoint at x18 has tip radius 13.001261 vs exact contact 13.025160: 0.023899 mm into the stub face, about 1.01 mm axially.
Present in the original C2 feature, not introduced by later slices.

## Fix
After sampling, for square blanks only, floor every sample's tip by the exact stub contact, per pass angle theta and along position c, for each retained stub end E (lower stub ends at alongStart, upper starts at alongEnd):
- axial distance from the cutter axis to the stub: d = max(0, c - alongStart) for the lower stub (0 if c is inside/over the stub), mirrored for the upper; if d >= rt there is no overlap.
- the cutter's cross-section at the closest stub plane has half-width rho = sqrt(rt^2 - d^2).
- flat: floor = squareRotaryTouchRadius(stock, theta, rho, 'flat_endmill') (max height along the cutter axis of the square cross-section within |x| <= rho).
- ball (centre at tip+rt): floor = squareRotaryTouchRadius(stock, theta, rho, 'ball_endmill') - (rt - rho). Prove in the comment (the ball's slice at that plane is a disc of radius rho centred at tip+rt; the shank adds nothing above that).
- tip = max(tip, floor). Use the helper's existing exact closed form; no sampling. Keep the mesh stubs (they still bound the model elsewhere) unless proven redundant.
Apply in the shared sampling/target path so both rough and finish get it; do not change travel/safe heights, links, layer gate, warnings or round bars.

## Tests (new src/engine/toolpaths/squareRotaryStub.test.ts)
- Both Codex cases: no cutter position intrudes into the retained stub (independent exact oracle: for every cut move endpoint and densely along each cut segment, the cutter solid — flat cylinder with flat bottom, or ball + shank — does not intersect the stub prism beyond 1e-6 mm).
- Seeded property test: sides 12/25/2 in, flat and ball 0.5..6 mm, x and y axis, both stub ends, chuck-limited and model-limited ranges, mm/inch: zero intrusions.
- The band still reaches the target radius where the cutter fully clears the stubs (simulate visible mode at detail 280: cells beyond one cutter radius from the stubs at target radius + 0.05).
- Round fixtures byte-identical; re-capture square fingerprints in src/engine/gcode/squareRotaryOutput.test.ts only if they move.
Mutations that must fail: floor removed; ball offset (rt - rho) dropped; rho = rt regardless of d (over-lift: add an assertion that tips far from the stubs are unchanged and that a sample with d just under rt is lifted only by the exact small amount).

## Checks
node --import tsx squareRotary*, rotaryModel, rotaryOutput, legacyMachineParity, squareRotaryProgramSafety, executorParity, workerRuntime tests; eslint changed; tsc -p tsconfig.app.json --noEmit. Not check:gcode. No browser/full build/pools.
Off limits: everything except rotaryModel.ts, squareRotaryStock.ts, the new test, squareRotaryModel/RoughAir tests if expectations move, squareRotaryOutput.test.ts, src/engine/toolpaths/INDEX.md. No primary checkout, .env.agent, credentials, git writes, push, PR, cleanup.
Report in your final message: STATUS, COMMIT: none, CHANGED_FILES, the floor and its proof, intrusion numbers before/after, move counts, each mutation and result, commands with exit codes, RISKS.
