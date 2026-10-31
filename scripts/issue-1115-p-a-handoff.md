# #1115 slice p-a: reproducible probe and baseline

Rotary generation around the bar became ~4–6× slower with #1050 (thin features in the height map). Before optimising anything, build the probe every later slice measures with.

- New `scripts/rotary-generation-probe.ts` (+ a focused test, + a line in `scripts/INDEX.md`). It loads a `.camj` read-only, picks operations by id, forces generation through the same engine entry the app's worker uses, and records: fixture path + SHA-256, operation id/kind/axis/tool/feeds/simulation detail, per-run generation time, warnings, a hash of the generated moves, and a hash of the posted program with the date line normalised. Output one JSON result file (default under `work/`). A `--baseline <json>` option compares a run with a stored baseline and fails on any identity mismatch (different fixture hash, operation id or settings) or any move/program hash difference.
- A `--root <checkout>` option runs the same measurement against another checkout's engine (dynamic import from that tree), so the pre-#1050 reference at `/home/frankp/Projects/worktrees/purecutcnc/ref-pre-1050` can be timed. If its API differs, use the smallest adapter and say so; if the fixture cannot load there, report that and time the closest equivalent you can set up, stating exactly what differs.
- Run it: `work/busto-rect-stock.camj` operations `op0021` (Rotary rough) and `op0022` (Rotary finish), both around — find the ids in the file if these differ and report them; the round file `work/busto-round-stock.camj` and any along operation as controls. Current head and the pre-#1050 reference. Save the head result as the baseline JSON at `work/1115-baseline.json` and print a table: operation, cold, five warm, median, pre-#1050 median, ratio.
- Tests: the probe refuses a wrong operation id and a baseline whose fixture hash or settings differ, and flags a changed move hash. Mutations: let the probe accept a substituted operation; accept mismatched settings; skip the move-hash comparison.

Off limits: all engine code; everything else.

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
