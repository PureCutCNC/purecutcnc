# #1115 slice p-d3: run the rotary angle pool in the app

Approved design: `scripts/issue-1115-p-d-design.md` (read it whole; this slice is its item 3). p-d1 added the async sampling driver, p-d2 the angle pool with a Node `worker_threads` transport, p-e the compact bucket index (per-worker charge about 64 MiB on busto, so 7 workers fit the 512 MiB budget). Today the app still generates rotary operations serially in the single toolpath worker. This slice makes the app use the pool.

Frank's decision (2026-11-02, on #1115): this work lands even if rough misses the 1.5× target. Timings are reported, not a gate.

## What to do

- **Browser transport.** A main-thread-owned pool of module workers running the same angle kernel as p-d2, connected to the toolpath (generation) worker by transferred `MessagePort`s, as the design describes. The main thread creates and terminates workers and never touches mesh data. The generation worker stays the coordinator and drives the p-d1 async driver with the pool as its `runBatch`.
- **Wiring.** `workerExecutor.ts`, `toolpath.worker.ts`, `protocol.ts`: rotary operations (around and along) generate through the async driver and the pool; every other operation is unchanged. The worker count and the 512 MiB budget are p-d2's rule (`min(angleCount, 8, max(1, hardwareConcurrency - 2))`); unknown concurrency, a pool startup failure or a resource failure runs serially, and a computation error stays an error.
- **Cancellation.** Stop, a new generation request or a project change terminates the in-flight batch: the coordinator and the pool reject late replies by epoch, and no cancelled job's result reaches a later generation. Operation data is released after each operation.
- **Vite and Tauri.** Build the angle worker as a module worker for `vite build`, the dev server and the packaged Tauri app (check that the built `dist/` contains it and that the worker URL resolves under the Tauri asset protocol; `csp: null` today). No COOP/COEP, no SharedArrayBuffer, no hosting change.
- No UI and no settings: no new option, no new text, no locale change.

## Tests that must bite

- Output parity in the app path: a test that drives the generation worker's rotary path with the pool (Node transport is fine for unit level) and with the serial path gives identical moves and posted bytes on the p-a fixtures and the canned cases.
- Cancellation: start a generation, cancel mid-batch, start another; the second result equals a fresh run and no reply from the first is accepted.
- Fallback: a worker that fails to start makes the run serial with identical output; a computation error surfaces as an error.
- Mutations, each one caught: keep a cancelled job's results; accept an obsolete epoch; skip the serial fallback on startup failure.
- Browser: the existing rotary e2e specs (`e2e/rotaryModel.smoke.spec.ts` and any other rotary spec) pass with the pool active, and one assertion proves the pool really ran in the browser (for example a test-only counter of angle-worker replies exposed the way existing e2e hooks are). Run e2e with `PURECUT_E2E_PORT=1439 PURECUT_E2E_ISOLATED=1 npm run test:e2e -- <spec> --workers=2 --reporter=list`, then stop anything left on port 1439.

## Measure

- Probe (Node transport): busto rect and round, rough and finish, serial and the default pool; cold plus 5 warm, baseline identity on every run, peak RSS, and the actual worker count chosen (p-e's fix rounds changed the charge slightly and were not re-benchmarked).
- Browser: the square-to-round case in `e2e/rotaryModel.smoke.spec.ts`, its create-to-ready time with the pool and with the pool disabled, measured in the same run setup.
- One benchmark process at a time, nothing else running.

## Rules

- Output byte-identical in every path.
- Run `npm run build` (lint, tsc, tests, icons) and report its exit code; it must pass.
- Report what you could not run, in particular the packaged Tauri app: Frank tests desktop himself, so give him exact steps (which file, which operation, what to look for).

## Report

Changes per file; tests; mutations; commands with exit codes; the timing table; Tauri/desktop test steps for Frank; RISKS. Include a `## Manual impact` line: none (no visible change except speed).
## Rules for every slice (issue #1115, approved by Frank 2026-10-31)

Approved decisions: **output stays byte-identical** (same moves, same posted G-code; only the program's date line may differ), and the 1.5× target is now reported, not a gate (Frank, 2026-11-02). Format stays 3.3. No UI, settings or simulation changes; worker changes are this slice's scope. Do not repeat the failed radius-only pre-filter. Preserve triangle eligibility, Float32 rounding, the frozen centre-map neighbourhood test, clipped maxima, wall/model separation and angular refinement (#1050).

- You work in your own worktree, based on the previous slice's branch. Read `INDEX.md`, `AGENTS.md`, and the `INDEX.md` of every folder you touch. Do exactly what this handoff asks, nothing wider: if something here is wrong or needs a decision, say so in RISKS and do the closest correct thing.
- `gh` may be blocked in your sandbox; everything you need is here.
- Leave edits uncommitted and report `COMMIT: none`; the dispatcher commits.
- Benchmark files are in this worktree's gitignored `work/` (`busto-rect-stock.camj`, `busto-round-stock.camj`). Never save a modified copy; never commit anything from `work/`. A checkout of the last commit before #1050 (0d35ef77, with its own `node_modules`) is at `/home/frankp/Projects/worktrees/purecutcnc/ref-pre-1050`; read it, never edit it.
- Tests must bite: for each behaviour, break the code on purpose, confirm a test fails, restore from a `cp` backup (never `git checkout`). Report each mutation and whether it was caught.
- No `process.` / `globalThis` in engine code (the probe script under `scripts/` may read `process.argv`).
- Run and report with exit codes: `npm run build:gates`, each changed or new test file directly.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; measured timings; RISKS.
