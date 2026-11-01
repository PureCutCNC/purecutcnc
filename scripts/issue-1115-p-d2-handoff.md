# #1115 slice p-d2: angle worker pool, Node adapter, benchmark gate

Approved design: `scripts/issue-1115-p-d-design.md` (its item 2). p-d1 already gave rotary sampling an async driver with an injected `runBatch`. This slice adds a real worker pool behind `runBatch` and **measures whether the 1.5× target is reachable**. Browser and Tauri wiring is p-d3 and is out of scope here.

## What to do

- Create an angle-job protocol and worker kernel. A worker is set up once per operation with its own transferred copy of the prepared raster geometry and bucket data (no SharedArrayBuffer). It then receives jobs (angle and index, grid descriptor, along positions) and returns rows, lifts and warnings. Bucket-plan revisions go out only when reach grows.
- Create a pool that implements `runBatch`, with epoch, batch and index validation so late, duplicate or stale replies are rejected. Results are assembled by index.
- Add a Node `worker_threads` transport, following `src/app/toolpathGeneration/workerThreadAdapter.ts`. The same kernel must later run in a browser module worker.
- Worker count: `min(angleCount, 8, max(1, hardwareConcurrency - 2))`, capped by a 512 MiB typed-buffer budget computed before dispatch. Unknown concurrency means serial. A startup or resource failure discards the batch and reruns it serially; a computation error stays an error.
- Extend `scripts/rotary-generation-probe.ts` to run the async path with `--workers N`, and record per-phase times and peak RSS.

## Tests that must bite

- Pool output is identical to the serial path on the p-a fixtures and the canned, X-axis and Y-axis cases from p-d1.
- Replies completing in reverse order, duplicates and stale epochs: rejected or reordered, and output stays identical.
- Wall metadata is retained and thin peaks are kept (`thinFeatureHeightMap.test.ts` cases through the pool).
- Mutations, each one caught: assemble in arrival order; omit wall metadata from a reply; accept a stale epoch.

## Benchmark (the gate)

Run the probe on busto-rect-stock and busto-round-stock (copy them from `../1115-p-a-dsh/work/`). Use serial, 2, 4 and 8 workers; cold plus 5 warm runs each; baseline identity check on every run; peak RSS for each. Report:
- the per-phase split, showing what stays serial;
- each operation's time against the pre-#1050 medians recorded by p-a (rough 5.2 s, finish 8.3 s on rect) and against the 1.5× target.

**Run benchmarks strictly one at a time, with nothing else running.** At 8 workers this machine is saturated, so never alongside tests or another probe. If a run is OOM-killed, report it; don't retry in parallel.

## Rules

- Output byte-identical.
- Off limits: `workerExecutor.ts`, `toolpath.worker.ts`, `protocol.ts`, UI, locales (p-d3).
- Measured numbers only, and say which ones you measured.

## Report

Changes per file; tests; mutations; commands with exit codes; the benchmark table; a one-line verdict on whether the 1.5× target is reachable and what blocks it if not; RISKS.
