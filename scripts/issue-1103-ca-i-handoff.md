# Issue #1103 slice ca-i: worker-sampled angle maps fill the parent cache

Part of PR #1152 (issue #1103, continuous A via helix). Frank's retest found the
app and node disagree on the same file, and chose this fix on 2026-11-04.

## The bug (diagnosed, reproduced)

In the app, `toolpath.worker.ts` (~line 228) samples rotary rows through
`createRotaryAnglePool`. The pool's kernel builds its prep with
`angleMaps: 'off'` (`rotaryAngleKernel.ts` ~line 118), so rows sampled by
worker threads never reach the parent workspace's angle-map cache. The ring
grid asks for `angleMaps: 'write'` (`rotaryModel.ts` ~line 1748) precisely so
the helix that follows can read those maps (`rotaryContinuous.ts` ~576-596,
`angleMaps: 'read-write'`). A cache hit costs 0 raster work
(`rotarySampling.ts` ~1127-1132); a miss costs the candidate count, charged
against `MAX_HELIX_RASTER_WORK` (24 M).

Result on `busto-round-stock.camj` op0025 (Rotary rough), helix / ring turns
on layers 1-3:

- pool (the app):   0/44, 0/44, 35/10
- serial (node):   40/5, 36/9, 35/10

Layer 1 starts with 0 parent maps and exhausts the budget after 140 rows;
layer 2 exhausts during refinement; layer 3 finds 281 maps from earlier layers
and succeeds. The posted program matches the app's exported program line for
line, so the postprocessor is not involved.

Reproduction (from a scratch probe; recreate it as a committed test, see
below): run `computeOperationToolpathAsync(project, op, { rotaryRunBatch: prep =>
createRotaryAnglePool(prep, createNodeRotaryAngleWorkerSource({ availableParallelism: 4 }), { maxWorkers: 2 }).batches })`
versus the same with `availableParallelism: 1`, and versus
`computeOperationToolpath` (sync), then compare moves.

## What to build

When the parent prep's `angleMaps` is `'write'` or `'read-write'`, every row a
worker samples puts its height map into the **parent** workspace's angle-map
cache, under the same key (`cachedAngleKey`), the same byte budget
(`MAX_ANGLE_MAP_CACHE_BYTES`) and the same eviction / `full` rules the serial
path uses, so that the cache state after any batch is the same as if the batch
had run serially. Concretely:

- The kernel/worker returns the built map (or exactly what the parent cache
  stores) alongside the sample when the parent asked for maps; transfer it
  (transferable buffers), do not copy it twice.
- The parent inserts results in **job order**, not completion order, so
  insertion and eviction are deterministic regardless of which worker finishes
  first.
- A worker never reads the parent's cache (it has none); a `'read-write'` row
  that the parent already holds must not be sent to a worker at all, or must be
  served from the parent cache with `reused` and `rasterWork: 0` exactly as the
  serial path reports it. Pick one, and keep `rasterWork` / `reused` totals
  equal to serial.
- `'off'` preps (every non-helix caller) keep today's behaviour: no maps
  transferred, nothing cached, byte-identical output.

## Acceptance

1. **Parity.** For busto-round op0025 and op0015, busto-rect op0021 and op0022,
   and the square-to-round around rows (op0028, op0029), the moves produced
   through the real worker pool (Node worker transport, 2 workers and 4
   workers) are byte-identical to `serialRotaryBatches` and to the sync
   `computeOperationToolpath`. Report the moves sha256 for each and confirm the
   serial ones match the hashes in `scripts/issue-1103-baseline.md` (ca-h).
   busto-round op0025 through the pool must show the helix on layers 1-3
   (40/5, 36/9, 35/10 turns).
2. **Committed test**: a pool-versus-serial parity test on a fixture small
   enough for CI (a chiral or seam fixture from `rotaryContinuous.test.ts` is
   fine) that runs the real worker transport, asserts equal moves and equal
   helix share, and fails if worker maps are not returned. Plus a test that
   insertion is in job order (shuffle completion order, same cache contents).
3. **Mutation tests**, each must fail the suite: worker maps dropped; maps
   inserted in completion order with a byte budget small enough to evict;
   `rasterWork` charged for a parent-cache hit; an `'off'` prep transferring maps.
4. **Performance**, measured serially, one process at a time, one warm-up and
   three timed runs: generation time through the pool for busto-round op0025,
   op0015 and busto-rect op0021, op0022, before (1bef4c37) and after. The pool
   path must not be slower than before by more than 1.1x; report the transfer
   bytes per operation. Report peak RSS before and after.
5. Along-the-bar mode and every non-rotary operation byte-identical.
6. `npm run build` green; `npm run check:gcode` passes.

## Rules

- Scope: the worker / pool / kernel transport and the parent cache insert only.
  Do not change the helix budget, the ring or helix generators, the cache key or
  its byte budget, link rules, or the postprocessor.
- No new setting, UI, locale or format change.
- Append a short `## ca-i` section to `scripts/issue-1103-baseline.md` with the
  parity hashes, the timings and the transfer bytes.
- Report: what changed (file:line), parity table, timings, mutation results,
  build exit code.
