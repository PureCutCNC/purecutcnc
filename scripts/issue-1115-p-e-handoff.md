# #1115 slice p-e: cut the per-angle rough cost

p-d2 measured the rotary angle pool (warm medians, busto rect): serial rough 35.1 s against 5.2 s before #1050 (6.7×), serial finish 32.6 s against 8.3 s (3.9×). With the pool, finish meets the 1.5× target but rough does not: each rough worker carries about 100 MB of setup (79 MB of it bucket index), so the 512 MiB budget allows only 3 workers, and 2→8 workers scale only about 2.4×. Frank decided to cut the rough cost itself before wiring the pool into the app (p-d3). This slice does that.

## Step 1: find where one angle's time goes (measure first)

- Instrument rough on `work/busto-rect-stock.camj` op0021 (serial path, probe from p-a/p-d2). Per angle, split the time into: bucket/strip selection, triangle projection, rasterisation into the map, retained-wall/peak metadata, tool-tip sampling of the row, and refinement overhead. Record counts per angle: triangles considered, triangles that touch a cell, map cells, candidates per cell (mean and max), angles sampled (base and refinement).
- Run the same breakdown on the pre-#1050 reference (`--root`), as far as its code allows, and on finish op0022 for comparison. Say exactly which phases you could not split at the reference.
- Measure the setup too: what the 79 MB bucket index holds (entries, bytes per entry, how many angles/strips each triangle is listed in).
- Name the phase(s) that grew, with the numbers, before changing code. Instrumentation goes in the probe or behind an injected hook; no `process.`/`globalThis` in engine code, and none of it left on the default path.

## Step 2: cut it, output identical

- Implement the change(s) that remove the most measured time while keeping every map, `cellRise`, wall metadata, move and posted byte identical. Do not repeat the radius-only pre-filter (failed) or p-c's candidate-rejection reordering (no gain).
- If the bucket index can be stored more compactly (for example narrower index types, one shared range list instead of per-angle copies, or per-strip ranges) without changing output, do it: it also lets more pool workers fit the 512 MiB budget. Report the per-worker charge before and after.
- Keep a change only if it is measurably faster (or measurably smaller with no slowdown). If nothing helps, leave the code as it was and report the step-1 numbers; that is a valid outcome.
- Both the sync and the async/pool paths must stay identical to the baseline; keep p-d1's parity tests and p-d2's pool tests green.

## Benchmark

On busto rect and round, rough and finish: serial, and the pool at 4 and 8 workers with the default 512 MiB budget. Cold plus 5 warm runs each, `--baseline work/1115-baseline.json` passing on every run, peak RSS. Report each against the pre-#1050 medians (rect rough 5.2 s, finish 8.3 s; round rough 3.6 s, finish 7.0 s) and the 1.5× target, next to p-d2's numbers. Strictly one benchmark process at a time, nothing else running.

## Tests that must bite

Any new structure (compact bucket index, cached projection, etc.) gets a test that fails if it returns different triangles or bounds than the old one; the p-b mutations (drop no-centre triangles, global instead of clipped maximum, stale scratch data) must still be caught on the new code. Report each mutation.

Off limits: `workerExecutor.ts`, `toolpath.worker.ts`, `protocol.ts`, UI, locales, settings, saved format.

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
