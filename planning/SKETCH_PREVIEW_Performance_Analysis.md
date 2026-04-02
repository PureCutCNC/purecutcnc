# Sketch Preview Performance Analysis

## Problem
The temporary sketch point and shape preview feel sluggish and jumpy during mouse movement, even with snapping disabled. This makes precise rectangle and circle placement unnecessarily difficult.

## Main Findings

### 1. Temporary preview points use React state on every mousemove
In `src/components/canvas/SketchCanvas.tsx`, the preview point for:
- add placement
- move/copy
- resize/rotate

is stored via:
- `setPendingPreviewPoint(...)`
- `setPendingMovePreviewPoint(...)`
- `setPendingTransformPreviewPoint(...)`

These are called directly from `handleMouseMove(...)`, which means ordinary pointer movement triggers React rerenders continuously.

### 2. Mousemove can trigger two redraw paths
The same mousemove also updates live snap state and calls `scheduleDraw()`.

So while placing geometry, the app can do both:
- a direct RAF canvas redraw
- a second redraw after React rerender rebuilds the `draw` callback

That duplication is likely the biggest source of visible jumpiness.

### 3. Each redraw repaints the entire sketch scene
`draw()` currently repaints:
- grid
- backdrop
- stock
- all features
- clamps
- tabs
- toolpaths
- legends
- preview overlays

So moving a single temporary point pays the full scene redraw cost.

### 4. Idle hover hit-testing is also heavier than needed
When no sketch tool is active, idle mousemove still performs feature hit-testing using repeated geometry sampling (`sampleProfilePoints(...)`) through:
- `pointInProfile(...)`
- `pointNearProfile(...)`
- `findHitFeatureId(...)`

This is not the main preview-point bug, but it adds more pressure on pointer responsiveness.

### 5. Hover selection updates are not guarded
`hoverFeature(...)` in `src/store/projectStore.ts` always writes selection state, even if the hovered feature id did not change.

## Conclusion
The sluggish preview is primarily caused by architecture, not by snapping:
- transient mousemove preview data is stored in React state
- mousemove can trigger duplicate draw paths
- the whole sketch scene is redrawn for very small preview changes

Snapping can add cost, but it is not the root cause.

## Recommended Fix Order

### 1. Move preview points to refs
Convert:
- `pendingPreviewPoint`
- `pendingMovePreviewPoint`
- `pendingTransformPreviewPoint`

from React state to refs, the same way origin placement preview already works.

### 2. Use one RAF-driven draw path
Mousemove should:
- update transient refs
- request one canvas redraw

It should not trigger React rerenders for temporary point movement.

### 3. Guard redundant hover updates
Make `hoverFeature(...)` a no-op if the hovered id is unchanged.

### 4. Reduce hover/snap geometry work
Later follow-up:
- cache sampled profile geometry
- reduce repeated `sampleProfilePoints(...)` work during hover and snapping
- consider a lightweight spatial index if needed

## Scope For Current Pass
Implement now:
- step 1
- step 2

Leave for follow-up:
- hover update guard
- geometry caching / hit-test optimization
