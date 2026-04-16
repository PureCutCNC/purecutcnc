# Native Circle Type — Implementation Plan

## Problem Summary

When a circle is placed, `circleProfile()` in `project.ts` immediately decomposes it into **4 arc segments** stored in the `SketchProfile`. The feature gets `kind: 'circle'` and `inferFeatureKind()` can re-recognize it — but because the underlying storage is just 4 arcs, the sketch-edit system treats it as 4 independent arc segments. The user cannot drag the whole circle by its center or resize it uniformly by radius; instead they get 4 arc-handle diamonds, one per arc.

## Root Cause Trace

| Layer | What happens today |
|---|---|
| **`project.ts`** — `circleProfile()` | Builds a `SketchProfile` with 4 `ArcSegment`s. Circle params (cx, cy, r) are not stored anywhere. |
| **`project.ts`** — `inferFeatureKind()` | Can detect the 4-arc pattern and return `'circle'`. This is read-only metadata that doesn't affect editing. |
| **`store/projectStore.ts`** — `addCircleFeature()` | Calls `circleProfile(cx, cy, r)` and stores the result. No `cx/cy/r` persisted. |
| **`store/projectStore.ts`** — `moveFeatureControl()` | Moves individual arc anchors or individual arc handles. No special-casing for `kind: 'circle'`. Dragging one arc handle breaks the circle into independent arcs. |
| **`canvas/scenePrimitives.ts`** — `drawSketchControls()` | Draws 4 anchor dots + 4 arc-handle diamonds on the circle profile. No center/radius handle. |
| **`canvas/SketchCanvas.tsx`** — edit interactions | Tab-to-type-radius works during placement, but **post-placement editing** only offers the generic 4-vertex control scheme. |

## Proposed Solution: Add a `CircleSegment` to the data model

The cleanest fix is to add a first-class `CircleSegment` type to `SketchProfile`. A circle then becomes a profile with `start = {cx+r, cy}` (or any canonical point) and **a single `CircleSegment`** that closes back on itself. This keeps the profile abstraction intact while giving the engine a lossless round-trip: `cx`, `cy`, and `r` are always recoverable from the segment.

### Design: new `CircleSegment`

```ts
export type CircleSegment = {
  type: 'circle'
  center: Point  // cx, cy of the circle
  // radius is implicit: distance from profile.start to center
}

export type Segment = LineSegment | ArcSegment | BezierSegment | CircleSegment
```

A circle profile becomes:
```ts
{
  start: { x: cx + r, y: cy },
  segments: [{ type: 'circle', center: { x: cx, y: cy } }],
  closed: true,
}
```

### Key properties
- **r** is always `Math.hypot(start.x - center.x, start.y - center.y)` — derived on the fly.
- **`inferFeatureKind()`** — detects `segments.length === 1 && segments[0].type === 'circle'` → returns `'circle'`.
- **All downstream consumers** (Clipper, Manifold CSG, toolpaths, snapping, DXF export) receive the profile through `sampleProfilePoints()` — that function must handle `CircleSegment` and emit the same arc-sampled points it does today.

## Affected Files

---

### Core Data & Geometry

#### [MODIFY] [project.ts](file:///Users/frankp/Projects/purecutcnc/src/types/project.ts)
- Add `CircleSegment` type.
- Update `Segment` union.
- Rewrite `circleProfile()` to emit a single-segment circle profile.
- Update `inferFeatureKind()` to detect single `circle` segment.
- Update `sampleProfilePoints()` to handle `circle` segment (emit 360° arc points).
- Update `profileVertices()` — circle has 1 vertex (the start/rightmost point); in edit mode this becomes the radius handle.
- Update `getProfileBounds()` — for a circle segment, return exact `[cx−r, cx+r] × [cy−r, cy+r]` (no sampling needed).

---

### Rendering

#### [MODIFY] [profilePrimitives.ts](file:///Users/frankp/Projects/purecutcnc/src/components/canvas/profilePrimitives.ts)
- In `traceProfilePath()` / `traceDraftSegments()`: handle `type: 'circle'` by emitting a `ctx.arc(center.x, center.y, r, 0, 2π)` call.

#### [MODIFY] [scenePrimitives.ts](file:///Users/frankp/Projects/purecutcnc/src/components/canvas/scenePrimitives.ts)
- In `drawSketchControls()`: detect a circle profile (single `circle` segment) and instead of generic vertex dots, draw:
  - A **center crosshair** marker.
  - A single **radius handle** dot at `profile.start` (the rightmost point).
  - A faint dashed circle outline showing the circle.

---

### Store / Edit

#### [MODIFY] [projectStore.ts](file:///Users/frankp/Projects/purecutcnc/src/store/projectStore.ts)
- `moveFeatureControl()`: for `kind: 'circle'`, intercept the generic arc/anchor logic. When the user drags:
  - **Anchor index 0** (the radius point): recompute radius and rebuild the circle segment with same center.
  - **Any center handle** (new `kind: 'circle_center'` control ref — optional, or just block segment/arc handle usage): translate the circle (move `start` and `center`).
- `addCircleFeature()`: just update to call the new `circleProfile()` — no other change needed.

#### [MODIFY] [store/types.ts](file:///Users/frankp/Projects/purecutcnc/src/store/types.ts)
- Optionally add `'circle_center'` to `SketchControlRef` kind if we want an explicit center drag handle. (Can also omit in first pass — just support radius drag.)

---

### Sketch Canvas interaction

#### [MODIFY] [SketchCanvas.tsx](file:///Users/frankp/Projects/purecutcnc/src/components/canvas/SketchCanvas.tsx)
- In the dimension-typing flow (Tab key), the `shape: 'circle'` DimensionEdit already works for placement. **No change needed there.**
- In **sketch_edit** mode, when `editingFeature.kind === 'circle'`:
  - The active control cycling (`editDimSteps`) should offer `arc_radius` for the single segment (or a new `circle_radius` step). This already works generically if the segment type is handled correctly.
  - The `computeEditDimSteps()` in `draftHelpers.ts` currently checks `seg.type === 'arc'` — this must also match `seg.type === 'circle'`.

#### [MODIFY] [draftHelpers.ts](file:///Users/frankp/Projects/purecutcnc/src/components/canvas/draftHelpers.ts)
- `computeEditDimSteps()`: treat `circle` segment similarly to `arc` (offer radius tab-edit step).
- `buildPendingProfile()`: already calls `circleProfile()` — no change needed.

---

### Snapping

#### [MODIFY] [snappingHelpers.ts](file:///Users/frankp/Projects/purecutcnc/src/components/canvas/snappingHelpers.ts)
- The snapping system uses `sampleProfilePoints()`, so it gets circle points for free once `sampleProfilePoints()` handles the new segment. 
- However, **center snap** for circles: add a special case to snap to the circle center (the `center` field of the `CircleSegment`). This is a nice-to-have for the first pass.

---

### Import (DXF / SVG)

#### [MODIFY] [dxf.ts](file:///Users/frankp/Projects/purecutcnc/src/import/dxf.ts)
- `circleEntityProfile()`: currently builds the 4-arc approximation. Change it to emit the new single-segment native circle profile.

#### [MODIFY] [svg.ts](file:///Users/frankp/Projects/purecutcnc/src/import/svg.ts)
- The `<circle>` SVG element handler: change to emit native circle profile instead of 4-arc decomposition.

---

### CAM Engine

#### [MODIFY] [geometry.ts](file:///Users/frankp/Projects/purecutcnc/src/engine/toolpaths/geometry.ts) + [resolver.ts](file:///Users/frankp/Projects/purecutcnc/src/engine/toolpaths/resolver.ts)
- The CAM layer receives profiles via `sampleProfilePoints()` / `flattenProfile()`, which will correctly expand the circle segment. **No deep CAM changes expected** — verify by testing a pocket and edge route on a circle.

---

### Viewport 3D / CSG

#### [MODIFY] [csg.ts](file:///Users/frankp/Projects/purecutcnc/src/engine/csg.ts)
- CSG uses `sampleProfilePoints()` to polygonize profiles for Manifold. Once that function handles the new segment, no further change is needed.

---

## Migration: existing saved projects

Existing `.camj` files store circles as 4 `arc` segments with `kind: 'circle'`. On load, **`inferFeatureKind()`** already recognizes this pattern and returns `'circle'`. We add a **migration step** in `normalizeProject()` that detects `kind === 'circle'` features with a 4-arc profile and converts them to the new single-segment format. This is a one-time repair on load — the round-trip stays clean.

## Open Questions

> [!IMPORTANT]
> **Q1: Center drag handle?** Should sketch-edit mode offer a separate "drag the center" handle? The simplest first pass just has 1 handle (the radius point at `start`). Moving the whole circle is done via the existing move feature / translate flow. We can add a center handle later.

> [!IMPORTANT]
> **Q2: Should `sampleProfilePoints()` for a circle produce a fixed number of points or use an angular step?** The current arc code uses `Math.PI / 18` per arc, resulting in 20 points for a full circle (4 × 5). We should increase this slightly for a full circle (suggest 64 or `Math.PI / 32` step) to improve CAM accuracy for larger circles. This needs a decision before we write the sampling code.

## Verification Plan

### Automated
- [ ] Existing snapshot/unit tests for `circleProfile()` and `inferFeatureKind()` must pass.
- [ ] New unit test: create a circle feature, serialize/deserialize from JSON, confirm it round-trips as `CircleSegment` (not 4 arcs).
- [ ] Migration test: load a legacy 4-arc circle project, confirm it upgrades to single-segment.

### Manual (browser)
1. Place a circle → verify it renders as a smooth circle.
2. Enter sketch-edit → verify just 1 radius handle appears (not 4 arc diamonds).
3. Drag radius handle → verify circle stays circular (radius changes uniformly).
4. Tab to type radius while in sketch-edit → verify it commits correctly.
5. Import a DXF with `CIRCLE` entity → verify it comes in as native circle.
6. Run pocket + edge-route operations on a circle → verify toolpaths are unchanged.
7. Open an old `.camj` with a 4-arc circle → verify the migration works, circle looks correct.
