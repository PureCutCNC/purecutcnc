---
status: Done
created: 2026-05-29
---

# Drilling: Order Holes by Nearest-Neighbor Travel (Issue #119)

## Goal

Optimize drill toolpath generation to visit holes in nearest-neighbor order rather than the feature tree order. This minimizes safe-Z rapid moves across the job, improving cycle time. User experience is unchanged — the operation UI stays the same; only the emitted G-code toolpath improves.

## Approach

1. **Precomputation phase** (new, before the main loop):
   - Iterate once through `targetFeatures` to collect valid drill targets (those with resolvable centers and passing all pre-flight checks: region filtering, Z-span validity, depth warnings).
   - Store each target as a simple record: `{ feature, center, span, index }` (original order preserved for tie-breaking).
   - Skip the same checks that currently cause `continue` statements (invalid circle, outside region, bad Z-span, etc.).

2. **Nearest-neighbor ordering** (new):
   - Sort the precomputed targets by nearest distance to the current tool position.
   - For each iteration, compute distance from the current position to all remaining targets, pick the closest, emit its drill cycle, update `currentPosition`.
   - Tie-breaker: when distances are equal (or very close, within `1e-8` units), prefer the target with the lower original feature index.

3. **Integration**:
   - Replace the existing `for (const feature of targetFeatures)` loop with a nearest-neighbor algorithm that consumes the precomputed target list.
   - Start from `currentPosition = null` (as today); the first drill cycle will position at the first reachable hole.
   - Keep all existing warning and bounds logic unchanged.

4. **No data-model changes**: This is a pure optimization of the generation order; no API, operation schema, or project format changes.

## Files affected

- `src/engine/toolpaths/drilling.ts` — main changes:
  - New helper function to precompute valid drill targets (replaces the validation scattered in the loop body).
  - New nearest-neighbor ordering function.
  - Refactor main loop to use the sorted target list.
  - Inline tests or comments verifying the algorithm.

- *(new)* `src/engine/toolpaths/drilling.test.ts` — unit tests:
  - Test with spatially shuffled circle features; verify emitted hole order follows nearest-neighbor.
  - Test that deterministic tie-breaking by original order holds (two equidistant holes, same source order).
  - Test region filtering is respected before ordering (skipped holes don't affect the path).
  - Smoke test: verify the result is still a valid `ToolpathResult` with the same bounds (or better).

## Tests

- **New:** `drilling.test.ts` with:
  - `it('orders holes by nearest neighbor travel', ...)` — creates 3+ circles in shuffled XY order, generates drilling path, asserts holes are visited in nearest order.
  - `it('tie-breaks equidistant holes by original feature index', ...)` — two circles at same distance, verifies feature order matters.
  - `it('respects region filtering before nearest-neighbor ordering', ...)` — region excludes some circles, verifies only non-excluded holes are ordered.
  - `it('preserves warnings and bounds', ...)` — quick sanity check that all existing warnings still emit, bounds are computed correctly.

## Open questions / risks

- **Initial position tie-breaking**: When `currentPosition` is `null` (start of job), the first hole is chosen from all valid targets. The nearest-neighbor sort will naturally pick one; we should verify this feels reasonable (probably the circle closest to origin, or just first in tree order if equal distance).
- **Performance**: For typical jobs (5–100 holes), nearest-neighbor is O(n²) per sort iteration, which is negligible. For huge jobs (1000+ holes), this might be noticeable, but drilling operations are rarely that large; we can profile if it's a problem later.

## Out of scope

- Offline TSP (traveling salesman) solving — we use simple greedy nearest-neighbor, which is fast and deterministic.
- Reordering of other operation types (pocketing, profiling, etc.) — this fix is drilling-specific.
- Macro-level operation sequencing (e.g., "do all drilling first, then all pocketing") — that's job-level workflow, not generator-level.
