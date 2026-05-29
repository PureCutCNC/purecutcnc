---
status: Done
created: 2026-05-29
---

# Feature-First Block Ordering Plan

## Goal

Optimize `feature_first` toolpath output so per-feature blocks are still completed one feature at a time, but the concatenated block order follows nearest travel from the previous block endpoint instead of blindly preserving target feature order. This should reduce unnecessary safe-Z rapid travel for pocket, edge-route, V-carve, and V-carve-recursive operations that share the multi-feature merge path.

## Approach

- Add a deterministic nearest-neighbor ordering pass in `multiFeature.ts` for generated per-feature `ToolpathResult` blocks.
- Use each block's first and last meaningful move positions to score travel from the current endpoint, preserving original order as the tie-breaker.
- Keep the core `feature_first` behavior intact: all moves from a feature block remain contiguous and are not interleaved with other features.
- Normalize the concatenated block transition if needed so the first move of a reordered block starts from the previous block endpoint rather than relying on stale `from` coordinates from its isolated generation.
- Route pocket-specific merging through the same ordered block list while preserving warning, bounds, clamp, and `stepLevels` aggregation behavior.

## Files affected

- `src/engine/toolpaths/multiFeature.ts` — add shared block ordering/transition helpers and apply them in `mergeToolpathResults` / `mergePocketToolpathResults`.
- `src/engine/toolpaths/toolpaths.test.ts` — add focused tests for non-spatial target order in pocket and edge feature-first operations, and update merge expectations where ordered output changes.

## Tests

- Add or update structural tests in `src/engine/toolpaths/toolpaths.test.ts` to verify:
  - `feature_first` still keeps each feature's full depth/pass block contiguous.
  - non-spatial target feature order is reordered by nearest block travel.
  - deterministic tie-breaking falls back to original target order when distances match.
  - pocket `stepLevels` aggregation remains deduped and sorted after block ordering.
- Run `npm run build` before completing the work.

## Open questions / risks

- Rewriting a block's first move `from` coordinate may change exact move output snapshots/expectations, but it should better represent the actual machine state after reordering.
- V-carve and V-carve-recursive use the shared merge path, so the implementation should avoid assumptions specific to pocket/edge move shapes.

## Out of scope

- Changing level-first behavior.
- Interleaving passes between features.
- Optimizing within a single feature block.
- Changing G-code post-processing or machine-origin behavior.
