# V-Carve Skeleton Split Connection Fix

## Problem
When a contour offset produces a 1→N split (one parent contour splits into multiple child contours), the skeleton arms from the parent level were not connecting to corners in the child contours. This left orphaned corners that never received any toolpath cuts.

## Solution
Fixed the split handling logic in `vcarveRecursive.ts` to properly connect parent arms to child corners at split points.

### Changes Made

1. **Enabled split connections** (line 63):
   ```typescript
   const ENABLE_SPLIT_CONNECTIONS = true  // was: false
   ```

2. **Fixed recursion parameters** in split handler (lines 2254-2303):
   - Changed `allowWallAnchorFallback` from `false` to `true` in `buildFreshSeedBootstrapCuts`
     - Allows fresh corners in child regions to bootstrap from parent contour wall
   - Changed final `allowFreshSeedRestart` parameter from `false` to `true` in `traceRegion`
     - Allows new corners to emerge and connect at deeper levels within each child
   - Removed the early-exit check `if (connectedSeededArms.length === 0) continue`
     - Now recurses into all children, not just those with initial connections

### How It Works

When a 1→N split occurs:

1. **Parent→Child Bridge**: `bridgeSplitArms` connects each active parent arm to the nearest child corner using projected ray-casting and inside-contour validation

2. **Fresh Seed Bootstrap**: `buildFreshSeedBootstrapCuts` detects any new corners in child contours and connects them via:
   - Centerline rescue walk from nearby parent arms
   - Direct connection if within budget and segment stays inside
   - Wall-anchor fallback to parent contour for isolated corners

3. **Recursive Continuation**: Each child recurses with:
   - Arms that received split-time connections
   - Fresh corners that successfully bootstrapped
   - Ability to detect and connect new corners at deeper levels

### Verification

Tested with multiple operations from `v-carve-skeleton-tests.camj`:
- `op0006` (letter C): 0 orphan corners
- `op0008` (letter A): 0 orphan corners  
- `op0009` (letter T): 0 orphan corners

All previously orphaned corners now receive proper skeleton arm connections.

## Technical Details

The fix ensures three key behaviors:

1. **Continuity**: Parent arms flow into child regions through split points
2. **Completeness**: All corners (existing and fresh) get connected
3. **Correctness**: Connections stay inside contours and follow inward direction guides
