# #1115 slice p-b: safety and parity coverage before the optimisation

Strengthen the tests the optimisation in p-c must keep passing, without changing engine code.

- In `src/engine/toolpaths/rotaryRaster.test.ts` (and `thinFeatureHeightMap.test.ts` where it fits): seeded comparisons of the rotary raster against the unchanged general raster, including **sequential calls** with changing angle, cell size, window and triangle subsets on the same reused workspace/buffers, and coverage of retained-wall metadata. Exact equality of maps, `cellRise` and wall metadata, not tolerances.
- Keep the existing independent cutter-body property suites (`rotaryAroundPasses.test.ts`, `squareAroundGenerator.property.test.ts`) as they are.
- Update the nearest `INDEX.md`.
- Mutations that must fail the new tests: drop triangles that miss every cell centre (no-centre triangles); use a triangle's global maximum instead of its clipped maximum; reuse stale candidate data from the previous call (e.g. skip clearing a scratch buffer between calls).

Off limits: all production code; everything else.

## Rules for every slice (issue #1115, approved by Frank 2026-10-31)

Approved decisions: **output stays byte-identical** (same moves, same posted G-code; only the program's date line may differ), and the target is **each around rotary operation within 1.5× its pre-#1050 generation time** on this machine. Format stays 3.3. No UI, settings, simulation or worker changes. Do not repeat the failed radius-only pre-filter. Preserve triangle eligibility, Float32 rounding, the frozen centre-map neighbourhood test, clipped maxima, wall/model separation and angular refinement (#1050).

- You work in your own worktree, based on the previous slice's branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider: if something here is wrong or needs a decision, say so in RISKS and do the closest correct thing.
- `gh` may be blocked in your sandbox; everything you need is here.
- Leave edits uncommitted and report `COMMIT: none`; the dispatcher commits.
- Benchmark files are in this worktree's gitignored `work/` (`busto-rect-stock.camj`, `busto-round-stock.camj`). Never save a modified copy; never commit anything from `work/`. A checkout of the last commit before #1050 (0d35ef77, with its own `node_modules`) is at `/home/frankp/Projects/worktrees/purecutcnc/ref-pre-1050`; read it, never edit it.
- Timings: run serially, one benchmark process at a time, never alongside a test pool. One cold run, then five warm forced regenerations per operation; report every time and the median. Time generation only (not load, simulation or posting). Say which numbers you measured and which you did not; never estimate one.
- Tests must bite: for each behaviour, break the code on purpose, confirm a test fails, restore from a `cp` backup (never `git checkout`). Report each mutation and whether it was caught.
- No `process.` / `globalThis` in engine code (the probe script under `scripts/` may read `process.argv`).
- Run and report with exit codes: `npm run build:gates`, each changed or new test file directly.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; measured timings; RISKS.
