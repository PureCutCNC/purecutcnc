# #1115 slice p-d1: serial sync/async parity for rotary sampling

Approved design: `scripts/issue-1115-p-d-design.md` (read it whole; this slice is its item 1). Goal of p-d overall: build the per-angle height maps on a worker pool with byte-identical output. **This slice adds no workers.** It only reshapes rotary sampling so a pool can drive it later, and proves the reshaped code gives identical output.

## What to do

- In `src/engine/toolpaths/rotaryModel.ts`, separate the code into four parts:
  - sampling preparation (strip plan, bucket plan, raster geometry, workspace reuse);
  - the per-angle job (build one angle's map, sample the tool tips, return the **unlifted** Float32 row plus `min(cellRise ?? 0, cellSize)` and that angle's warnings);
  - ordered assembly (apply the lift centrally through the existing Float32 assignment, then merge warnings in angle order with the existing first-code-wins rule);
  - refinement decisions.

  Split these into new modules beside it if that keeps files under the ESLint size guards, and update `src/engine/toolpaths/INDEX.md`.
- Keep today's synchronous driver as the default path that `rotaryOperation.ts` / `generateOperation.ts` call. Add an **asynchronous driver** that runs the same per-angle job through an injected `runBatch(jobs) => Promise<results>` and assembles results by original index. Each refinement batch completes before any failure is evaluated. Preserve midpoint caching, insertion order, budgets and the eight-round limit. Lazy dense link sampling stays synchronous.
- In this slice the async driver's `runBatch` is an in-process serial implementation. No `Atomics`, no blocking.
- Do not duplicate the numerical algorithm: both drivers call the same per-angle job and the same assembly.

## Tests that must bite

- Sync vs async parity on the p-a fixtures (busto rect and round, around and along; copy them from `../1115-p-a-dsh/work/` into this worktree's ignored `work/`). Rows, lifts, warnings, moves and posted bytes must be identical. Also check one canned Turn/Polygon case and one X-axis and one Y-axis bar.
- The async runner returns results **out of order** (reverse them): output must still be identical.
- The p-a probe (`scripts/rotary-generation-probe.ts`) with `--baseline work/1115-baseline.json` passes on the sync path, and on the async path if you add a flag for it.
- All p-b tests and `thinFeatureHeightMap.test.ts` stay green.
- Mutations, each one caught: drop the central lift; assemble in arrival order instead of index order; change midpoint insertion order in refinement.

## Rules

- Output byte-identical. Every move and posted program must equal the baseline.
- **One heavy process at a time.** Never run a benchmark alongside a test pool; the machine has a per-process memory cap.
- Off limits: workers, the app's worker executor and protocol, UI, locales. Those belong to p-d2 and p-d3.

## Report

Changes per file; tests added; each mutation and whether it was caught; commands with exit codes; measured sync timings before and after on the probe (no slowdown beyond noise); RISKS.
