---
status: Done
created: 2026-05-23
---

# Parallel Finish Tab Z-Awareness Plan

## Goal

3D surface parallel finish currently carves a hole in its toolpath above every tab in the project, regardless of how far below the cutting surface the tab sits. The user has observed that a tab whose `z_top` is well below the locally machined Z still causes the toolpath to skip the tab's XY footprint. The fix: tabs must affect the parallel finish only where the cutter would actually intersect tab material, and otherwise be ignored.

## Approach

Replace the current "subtract every tab footprint from coverage" behaviour (which is unconditional and 2D) with a Z-aware constraint that mirrors how subtract features are already handled:

1. In `generateFinishSurfaceParallel`, stop using `buildProtectedFootprintPaths` for tabs by passing `includeTabs: false`. Tabs are no longer removed from the 2D coverage contour.
2. Extend `minCutZAtPoint` (constructed in `generateFinishSurfaceToolpath` and threaded into the parallel strategy) so that for any point inside an active tab's XY footprint it returns at least `tab.z_top`. The existing `clampSurfaceSegmentToMinZ` already enforces `cutZ = max(surfaceZ, minCutZAtPoint(point))`, so:
   - Where the local surface sits above `tab.z_top`, the clamp is a no-op — the cutter sweeps over the tab area normally.
   - Where the local surface dips at or below `tab.z_top`, Z is raised to `tab.z_top`, preserving tab material from `z_bottom` upward.
3. The tab XY footprint test should expand the tab rectangle by the cutter radius so the cutter centerline cannot pass closer to the tab than its actual edge. (Same expansion the old `buildProtectedFootprintPaths` was applying.)
4. Only the parallel strategy is affected. Waterline already passes a per-ring `z` to `buildProtectedFootprintPaths` and handles tabs through its own machinery (`includeTabs: false`); no change there.

### Why not a Z-keyed call to `buildProtectedFootprintPaths`?

Parallel finish has no single Z — each scanline sample point has its own surface Z. A 2D Z-keyed query would force an arbitrary choice (operation top? bottom?) and reintroduce the same class of bug.

## Files affected

- `src/engine/toolpaths/finishSurfaceParallel.ts` — pass `includeTabs: false` to `buildProtectedFootprintPaths`. No other change in this file.
- `src/engine/toolpaths/finishSurface.ts` — extend the `minCutZAtPoint` closure built in `generateFinishSurfaceToolpath` so that for any XY point inside an expanded tab footprint (tab rect expanded by `tool.radius`), the returned floor is `max(currentFloor, tab.z_top)`. Precompute the expanded tab footprints (Clipper paths + `z_top`) once outside the closure for performance.
- `src/engine/toolpaths/finishSurface.test.ts` — add a regression test described below.

No new files. No changes to `modelProtection.ts`, the waterline strategy, or the data model.

## Tests

Add a structural unit test in `src/engine/toolpaths/finishSurface.test.ts`:

- **`testParallelFinishCutsOverDeepTab`** — build a flat-ish STL feature with model top at e.g. Z=10 over a small XY area, place a tab whose `z_top` is well below the lowest cut Z (e.g. tab z range −5..−2 while the surface is at +10). Run parallel finish. Assert that the generated moves cover the XY area above the tab (no hole punched in the toolpath over the tab) — concretely, sample the move points inside the tab's expanded footprint and require at least one cutting move there at the surface Z. The current code would generate zero moves above the tab footprint; the fix should produce coverage.

- **`testParallelFinishPreservesTabWhenSurfaceDipsIntoIt`** — a model surface that locally dips below `tab.z_top` inside the tab footprint. Assert that move Zs inside the tab footprint never drop below `tab.z_top` (within numerical tolerance), confirming the clamp engages.

Both tests use the existing parallel finish entry point (`generateFinishSurfaceToolpath` with `pocketPattern !== 'waterline'`) and the project/fixture builders already in `finishSurface.test.ts`.

## Open questions / risks

- The tab radial expansion: keeping it at exactly `tool.radius` matches the prior behaviour and is symmetric with how the waterline path treats tabs. No edge-case change expected, but worth flagging in case future tooling wants per-operation control.
- Performance: building one expanded Clipper path per tab once, then doing `PointInPolygon` per surface sample, is the same per-point cost shape that `safeSubtractBottomZAtPoint` already pays. Surfaces with many sample points × many tabs could grow, but the projects we target have a handful of tabs at most.

## Out of scope

- Rough surface, waterline finish, and any non-parallel strategy.
- Adjusting tab geometry semantics (still rectangular `z_bottom..z_top` boxes).
- The companion question of tab handling in 2.5D pocket/profile strategies — already handled by their own paths and not affected here.
