# #1115 slice p-c: candidate rejection without repeated work

`src/engine/toolpaths/rotaryRaster.ts` collects candidate triangle indices, then recomputes each candidate's projection and bounds before rejecting it (~lines 257 and 473). The flat raster (`src/engine/toolpaths/finishSurfaceParallel.ts:667`, `buildHeightMap`) already stores candidate maximum heights and cell bounds in reusable typed arrays before rejection. Adapt that pattern so rejection happens before the expensive reprojection.

- Keep the cheap axial-no-centre path; the extra metadata must not slow that common case.
- Output exactly the same: maps, `cellRise`, wall metadata, moves and posted bytes. Run the p-a probe with `--baseline work/1115-baseline.json` and report it passing (every move and program hash equal).
- All p-b tests and their mutations must still fail when the mutations are applied to the new code.
- Rebenchmark with the probe right after the change: the same operations as p-a, head vs baseline vs pre-#1050, plus peak memory. Keep the change only if generation is measurably faster without a material memory increase; if not, report the numbers and leave the code as it was.
- Update `src/engine/toolpaths/INDEX.md` if the raster's structure changes.

Off limits: everything outside `rotaryRaster.ts`, its tests and the INDEX line.

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
