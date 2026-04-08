# Pocket Parallel Implementation Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete
- `[>]` deferred / moved to backlog

## Goal
Add a second pocket floor-clearing strategy that uses parallel lines instead of repeated contour offsets.

This should be available as a pattern selection inside the existing `pocket` operation, not as a separate operation kind.

The first target is:
- rough pocket floor clearing with parallel lines
- finish pocket floor clearing with parallel lines
- configurable line angle

Wall finishing should remain contour-based.

## Why This Is Needed
The current pocket generator is purely offset-contour based:
- rough pocket repeatedly insets the target region and cuts each contour
- finish floor also reuses inset contours

That works, but it does not give the user a raster / parallel pocket pattern, which is often preferable for:
- wood
- soft materials
- visible floor finish control
- directional chip evacuation
- alignment with grain or part geometry

There is already a similar clipped line-fill idea in `surface_clean`, so this feature should reuse that style of geometry generation where possible.

## Confirmed Product Decisions

### 1. This is a pattern choice on `pocket`, not a new operation
Pocket remains one operation kind:

```ts
kind: 'pocket'
```

Pattern becomes an operation property.

Reason:
- avoids duplicating pocket UI and validation
- keeps target/tool/pass behavior identical
- lets rough/finish use the same operation kind with different floor behavior

### 2. Pattern affects floor clearing only
The new setting changes how the floor is cleared.

It does **not** change:
- target resolution
- depth stepping
- safe-Z behavior
- wall finishing contours

Reason:
- simpler mental model
- avoids conflating floor finish strategy with wall finish strategy

### 3. Finish walls stay contour-based
For `pass: 'finish'`:
- `Finish Walls` continues to mean contour finishing along boundaries
- `Finish Floor` uses the selected pocket pattern

So if the user selects:
- `Finish Walls = true`
- `Finish Floor = true`
- `Pattern = Parallel`

then the finish op will do:
- contour wall finishing
- parallel floor clearing

### 4. Angle is only meaningful for parallel pattern
`Parallel` uses an angle in degrees.
`Offset` ignores the angle.

Reason:
- keep the UI clean
- avoid fake parameters on contour pockets

### 5. First pass uses one angle for the whole operation
No cross-hatch or alternating-angle pass in v1.

Reason:
- much smaller scope
- enough to validate the geometry and machining behavior
- cross-hatch can be added later if needed

## Data Model Changes

Add a pocket-specific floor pattern field to `Operation`.

Recommended shape:

```ts
export type PocketPattern = 'offset' | 'parallel'
```

```ts
interface Operation {
  ...
  pocketPattern: PocketPattern
  pocketAngle: number
}
```

### Semantics
- `pocketPattern`
  - `offset`: current behavior
  - `parallel`: new clipped line-fill behavior
- `pocketAngle`
  - degrees
  - interpreted in sketch XY space
  - `0` means fill lines parallel to +X
  - `90` means fill lines parallel to +Y

### Defaults
- `pocketPattern: 'offset'`
- `pocketAngle: 0`

Reason:
- preserves existing projects/behavior
- keeps backward compatibility simple

## UI / Workflow

### CAM Properties
For `kind === 'pocket'`:

- show `Pattern`
  - `Offset`
  - `Parallel`
- when `Pattern === 'parallel'`, show `Angle`

For `pass === 'finish'`:
- existing `Finish Walls`
- existing `Finish Floor`
- these stay unchanged

### Rough Pocket
Rough pocket with:
- `Pattern = Offset`
  - current contour-inset behavior
- `Pattern = Parallel`
  - fill each machinable region at each Z with clipped parallel lines

### Finish Pocket
Finish pocket with:
- `Finish Walls = true`
  - contour wall finish
- `Finish Floor = true`
  - floor finish using selected pattern

## Geometry Design

### 1. Reuse resolved pocket bands
Do not invent a second region resolver.

Parallel pocket should use the same resolved pocket band structure the current pocket operation already uses:
- target region
- islands
- band top/bottom

Then build a different floor path pattern on top of those regions.

### 2. Parallel fill is generated in local rotated scan space
Recommended approach:

1. Rotate region geometry by `-angle`
2. Generate horizontal scan segments in rotated space
3. Clip scanlines against:
   - outer region
   - minus islands
4. Rotate resulting segment endpoints back by `+angle`

Reason:
- keeps segment generation simple
- reuses the proven `surface_clean` scanline idea
- avoids special-case line equations for arbitrary angles

### 3. Tool-center region must respect cutter radius
Parallel fill must run inside the same effective machining region as contour pocketing.

That means:
- inset outer boundary by tool radius plus radial stock-to-leave
- expand islands by tool radius plus radial stock-to-leave
- then clip the parallel lines to that effective region

This should mirror the existing `buildInsetRegions(...)` logic rather than inventing different clearance rules.

### 4. Stepover stays the spacing control
For parallel pocket:
- `stepoverDistance = tool.diameter * operation.stepover`
- neighboring parallel lines are spaced by that distance

This means the existing `Stepover Ratio` field remains meaningful for both patterns.

### 5. Segment ordering should be serpentine
After clipped line segments are generated:
- alternate direction between neighboring scan rows when possible
- process them in scan order

Reason:
- reduces rapids
- produces the expected raster pocket feel

This can be done exactly as `surface_clean` currently alternates segment direction.

## Toolpath Behavior

### Rough Parallel Pocket
For each step level:
1. build the effective tool-center regions for that band
2. generate clipped parallel segments
3. transition between segments using existing safe-Z / short-link logic
4. retract at the end of the Z level

Short-term note:
- we can initially use the existing `transitionToCutEntry(...)`
- if this creates too many cut-links across open air, we can tighten that later specifically for parallel fill

### Finish Parallel Floor
At final finish depth:
1. compute finish regions using current finish inset rules
2. if `Finish Floor` is enabled and `Pattern = Parallel`, generate parallel segments there
3. if `Finish Walls` is enabled, still cut contour walls

Order recommendation:
1. finish walls
2. finish floor

This matches the current finish implementation shape and keeps the change isolated.

## Module / Code Structure

Recommended extraction:

- keep `pocket.ts` as the main pocket generator
- add focused helpers in the same module first

Suggested helper names:

```ts
buildPocketParallelSegments(
  regions: ResolvedPocketRegion[],
  stepoverDistance: number,
  angleDeg: number,
): Point[][]
```

```ts
toOpenCutMoves(points: Point[], z: number): ToolpathMove[]
```

Potential later extraction if it grows:
- `src/engine/toolpaths/patterns/parallel.ts`

But for first pass, keeping it near pocket generation is better for iteration speed.

## Validation Rules

### Operation validation
- `pocketPattern` must be one of `offset | parallel`
- `stepover` must still be `> 0` and `<= 1`
- `pocketAngle` can be any finite number; normalize to `[0, 180)` for behavior if desired

### Geometry validation
- if clipped parallel segments are empty for a region, warn but do not fail the whole op
- if finish floor is enabled but no floor segments survive clipping, surface the warning in CAM

## Expected Limitations in First Pass

### 1. No cross-hatch
Only one angle.

### 2. No island-optimized linking
First pass will likely retract more than ideal around fragmented regions.

### 3. No adaptive direction changes per island/region
Whole operation uses one angle.

### 4. No separate rough-angle / finish-angle
One angle field only.

## Tracked Implementation Steps

### PP1. Schema + defaults
- [x] Add `PocketPattern`
- [x] Add `pocketPattern` to `Operation`
- [x] Add `pocketAngle` to `Operation`
- [x] Set defaults in operation creation / migration path

### PP2. CAM UI
- [x] Add `Pattern` field to pocket properties
- [x] Add `Angle` field when `Pattern === 'parallel'`
- [x] Keep finish walls/floor toggles unchanged

### PP3. Parallel segment generation
- [x] Add rotated scanline helper for arbitrary angle
- [x] Clip segments to effective tool-center regions
- [x] Return open line segments in serpentine order

### PP4. Rough pocket integration
- [x] Use `parallel` floor pattern in rough pocket generation
- [x] Keep `offset` roughing as current behavior

### PP5. Finish pocket integration
- [x] Use selected floor pattern for `Finish Floor`
- [x] Keep wall finishing contour-based

### PP6. Validation + warnings
- [x] Surface empty-region / empty-floor warnings clearly
- [x] Confirm bad input angles or spacing fail safely

### PP7. Verification
- [~] Rough pocket, rectangular region, `Offset`
- [x] Rough pocket, rectangular region, `Parallel 0°`
- [x] Rough pocket, rectangular region, `Parallel 45°`
- [x] Pocket with islands using `Parallel`
- [ ] Finish pocket with:
  - [ ] walls only
  - [ ] floor only
  - [ ] walls + floor

## Exit Criteria
This first pass is good enough when:
- pocket operations can choose `Offset` or `Parallel`
- `Parallel` produces clipped, non-destructive floor-clearing lines
- angle is user-controlled
- finish walls still behave exactly as before
- finish floor respects the selected pattern
- existing offset pocket behavior is unchanged when the new pattern is not selected

## Follow-Ups / Backlog
- [>] Cross-hatch pocket pattern
- [>] Separate rough-angle and finish-angle
- [>] Better linking / fewer retracts for fragmented parallel fill
- [>] Optional climb/conventional pass-direction control
- [>] Adaptive angle suggestions based on region aspect ratio
