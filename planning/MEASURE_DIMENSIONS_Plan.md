---
status: Draft   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-02
---

# Measure & Dimensions Plan

## Goal

Give users two related measuring capabilities on the 2D sketch canvas:

1. **Tape measure** — a transient tool that reports the distance (plus dx/dy and
   angle) between two snapped points. The readout persists on screen until the
   next click starts a fresh measurement; nothing is saved to the project.
2. **Permanent dimensions** — standard CAD dimension annotations (aligned/parallel,
   horizontal, vertical, radius, diameter, angle) that are **anchored to the
   geometry they were placed on**. When the underlying feature is edited, moved,
   or its sketch changes, the dimension value and graphics update automatically.

The user-visible outcome: a "Measure" tool group in the sketch toolbar, a live
tape-measure readout, and persistent dimension annotations that behave like a
real CAD drawing — they follow their geometry and survive save/load.

## Background — what the codebase already gives us

- **Rendering primitives exist.** `src/components/canvas/measurements.ts` already
  draws dimension-style labels (`drawMeasurementLabel`), line lengths
  (`drawLineLengthMeasurement`), radii (`drawArcRadiusMeasurement`,
  `drawRadiusMeasurement`), and angles (`drawAngleMeasurement`). The permanent-
  dimension renderer is largely an extension of these, not a from-scratch effort.
- **Transient multi-click tools have a pattern.** `pendingAdd` in
  `src/store/types.ts` + `src/store/slices/pendingAddSlice.ts` (e.g.
  `startAddPolygonPlacement` / `addPendingPolygonPoint` / `completePendingPolygon`)
  is the template for the placement flow. These are transient UI state and are
  **not** in undo history.
- **Snapping is centralized.** `resolveSketchSnap` in
  `src/components/canvas/snappingHelpers.ts` already produces a snapped world
  point from stock / features / tabs / clamps / origin.
- **The label-as-hit-target pattern exists.** Constraints already register
  per-frame hit rectangles (`constraintLabelRectsRef`) so labels are clickable;
  dimensions reuse this approach.

### The one hard problem: snaps have no provenance

`ResolvedSnap` (snappingHelpers.ts:46) returns only `rawPoint`, `point`, and
`mode`. It does **not** record *which* feature / segment / vertex produced the
snap. A permanent dimension that must follow moved geometry cannot store a frozen
coordinate — it must store a **reference** to the geometry and re-resolve the
world point every frame. So the central new mechanic is: **extend the snap
pipeline to carry provenance, and store that provenance (an "anchor") on the
dimension.** The dimension's numeric value is then always computed live from the
resolved anchors and is never stored stale.

### Naming note (collision)

`Project.dimensions` already exists as `Record<string, NamedDimension>` — the
**parametric** named-dimension table used by `z_top`/`z_bottom`. This is unrelated
to drawing dimensions. To avoid confusion we introduce a **new** top-level field
`annotations: DimensionAnnotation[]` rather than overloading `dimensions`.

## Approach

### 1. Data model (`src/types/project.ts`)

A dimension stores *anchors*, *type*, and *placement* — never the measured value
(value is computed live, guaranteeing auto-update).

```ts
// A reference to a live point in the scene. Resolves to a world Point each frame.
export type DimensionAnchor =
  | { kind: 'free'; point: Point }                                  // unattached, fixed world point
  | { kind: 'vertex'; target: AnchorTarget; vertexIndex: number }   // profile vertex
  | { kind: 'midpoint'; target: AnchorTarget; segmentIndex: number }
  | { kind: 'center'; target: AnchorTarget; segmentIndex: number }  // arc / circle centre
  | { kind: 'origin' }                                              // machine origin

// What a non-free anchor points at. v1: features + stock. (tabs/clamps: see open Qs)
export type AnchorTarget =
  | { source: 'feature'; featureId: string }
  | { source: 'stock' }

export type DimensionType =
  | 'aligned'     // true distance, dimension line parallel to the two points
  | 'horizontal'  // |Δx| between two points
  | 'vertical'    // |Δy| between two points
  | 'radius'      // R of an arc/circle
  | 'diameter'    // Ø of an arc/circle
  | 'angle'       // angle at a vertex between two rays

export interface DimensionAnnotation {
  id: string                    // 'dim0001' via nextUniqueGeneratedId(project, 'dim')
  type: DimensionType
  a: DimensionAnchor            // primary anchor (linear start / arc reference / angle vertex)
  b?: DimensionAnchor           // second anchor (linear end / angle ray-1)
  c?: DimensionAnchor           // third anchor (angle ray-2)
  offset: number                // perpendicular distance of dimension line from the
                                // measured points, world units; sign chooses the side
  labelOffset?: number          // optional slide of the text along the dimension line
  textOverride?: string | null  // optional manual label text (value still computed for tooltip)
  precisionOverride?: number | null
  visible: boolean
  locked: boolean
}

export interface Project {
  // ...existing fields...
  annotations: DimensionAnnotation[]   // NEW, additive
}
```

`normalizeProject` defaults `annotations` to `[]` so existing `.camj` files load
unchanged (format is additive; no version bump needed).

### 2. Pure geometry/value module (`src/sketch/dimensions.ts`, new)

All testable logic lives here, **out of React**, so it is covered by the
`src/**/*.test.ts` structural suite:

- `resolveAnchor(anchor, project): Point | null` — returns the live world point,
  or `null` when the reference is dangling (feature deleted, index out of range).
  Must use the **same** profile-world-point helpers the snapper/renderer use
  (`profileVertices`, `anchorPointForIndex`, `segmentMidpoint`, segment `center`)
  so a dimension and its snap always agree.
- `measureValue(dim, project): number | null` — computes the live value:
  aligned = `hypot(Δ)`, horizontal = `|Δx|`, vertical = `|Δy|`,
  radius = distance(center, edge), diameter = `2 × radius`, angle = angle at `a`
  between rays to `b` and `c`.
- `dimensionGeometry(dim, project): {...} | null` — pure layout: extension
  (witness) line endpoints, dimension-line endpoints (offset applied along the
  measured normal), arrowhead anchor points, and label anchor + rotation. The
  canvas renderer consumes this; keeping it pure makes the offset math testable.

A dimension whose `measureValue`/`dimensionGeometry` returns `null` is **dangling**
and is drawn in a muted warning style (mirrors the `is_invalid` convention already
used on constraints).

### 3. Snap provenance (`src/components/canvas/snappingHelpers.ts`)

Extend `SnapCandidate` and `ResolvedSnap` with an optional `anchor?:
DimensionAnchor` describing the candidate's source. `addProfileSnapCandidates`
gains a `source: AnchorTarget | null` parameter (callers already iterate per
feature/stock, so the owning identity is in scope) and attaches:

- `point` snaps → `{ kind: 'vertex', target, vertexIndex }`
- `midpoint` snaps → `{ kind: 'midpoint', target, segmentIndex }`
- `center` snaps → `{ kind: 'center', target, segmentIndex }`
- origin snap → `{ kind: 'origin' }`
- `grid`/`line`/`perpendicular` (no stable geometry identity) → no anchor; the
  dimension tool records these as `{ kind: 'free', point }`.

This change is **purely additive** to the snap result; existing callers ignore the
new field, so drawing/snapping behaviour is unchanged for everything else.

### 4. Tape measure (transient, no persistence)

New transient store state (sibling of `pendingAdd`, **not** in history), e.g.
`tapeMeasure: { first: { point: Point } | null; last: { a: Point; b: Point } | null }`
with actions `startTapeMeasure`, `tapeMeasureClick(point)`, `clearTapeMeasure`.

Behaviour: activate the tape tool → first click sets A (snapped) → moving shows a
live readout (distance, Δx, Δy, angle) anchored near the cursor using
`drawLineLengthMeasurement` + a small multi-line label → second click freezes the
A–B measurement, which stays drawn until the next click starts a new one. `Esc` or
switching tools clears it. Tape never touches `project` and never records anchors.

### 5. Permanent-dimension placement tool

Add a `pendingDimension` transient tool (mirrors `pendingAdd`) in
`src/store/types.ts` + a new `src/store/slices/dimensionToolSlice.ts`:

```ts
type PendingDimensionTool = {
  type: DimensionType
  a: DimensionAnchor | null
  b: DimensionAnchor | null
  c: DimensionAnchor | null
  session: number
}
```

Flow for a linear dimension: pick the type (or use an "auto" mode that infers
radius/diameter when the first click lands on an arc/circle, linear otherwise) →
click A → click B → move to choose side/offset → click to commit via
`addDimensionAnnotation`. Each click runs `resolveSketchSnap`; the resolved
`anchor` (or `{ kind:'free' }`) is captured. Angle dimensions take three clicks
(vertex, ray-1, ray-2).

### 6. Persistent store actions (history-tracked)

In a new `src/store/slices/dimensionsSlice.ts`, following the tabs/clamps action
shape (clone-to-history, bump `meta.modified`, no-op guard):

- `addDimensionAnnotation(partial): string` (returns new id)
- `updateDimensionAnnotation(id, patch)`
- `deleteDimensionAnnotation(id)`

When a feature is deleted we **do not** silently drop its dimensions — they become
dangling and render in the warning style so the user can re-anchor or delete them
(non-destructive; see open question 2).

### 7. Selection & editing

Add `selectedAnnotationId` / `hoveredAnnotationId` to `SelectionState`
(`src/store/types.ts`). The canvas registers per-frame dimension hit rects
(`dimensionHitRectsRef`, modelled on `constraintLabelRectsRef`). Interactions:
hover highlights; click selects; drag the dimension line changes `offset` (and
drag along it sets `labelOffset`); double-click the label edits `textOverride` /
precision; `Delete` removes it.

### 8. Rendering (`src/components/canvas/dimensionRendering.ts`, new)

`drawDimensions(ctx, project, vt, units, selection)` iterates
`project.annotations`, calls the pure `dimensionGeometry`, and draws witness lines,
the dimension line with arrowheads, and the label (reusing `drawMeasurementLabel`).
A new draw layer is added to the `SketchCanvas` draw loop after features (near the
existing constraint/measurement layers). Because geometry is resolved live each
frame, moving/editing a feature updates its dimensions for free.

### 9. Toolbar, icons, units, wiring

- **Toolbar** (`src/components/layout/Toolbar.tsx`): add a "Measure" group with a
  tape-measure button and a dimension button (with a small type sub-menu / cycle),
  wired through the existing `togglePlacement` pattern.
- **Icons**: add `measure` and `dimension` features to
  `src/assets/icons.camj`, then `npm run sync-icons`.
- **Units** (`src/utils/units.ts`): extend `convertProjectUnits` to convert
  `annotations` — `free` anchor points, `offset`, and `labelOffset` are world
  lengths and must convert; anchored points resolve from geometry and need no
  conversion; `angle` values are unitless. Display always goes through
  `formatLength` / a new `formatAngle` at render time.

### 10. Explicitly inert in the engine

Annotations are drawing-only. They are ignored by toolpath generation, G-code
export, the 3D viewport, and simulation in v1. The engine never reads
`project.annotations`.

## Files affected

- `src/types/project.ts` — add `DimensionAnnotation`, `DimensionAnchor`,
  `AnchorTarget`, `DimensionType`; add `annotations` to `Project`; default it in
  `normalizeProject`.
- *(new)* `src/sketch/dimensions.ts` — pure `resolveAnchor`, `measureValue`,
  `dimensionGeometry`.
- *(new)* `src/sketch/dimensions.test.ts` — unit tests for the above.
- `src/components/canvas/snappingHelpers.ts` — add `anchor` provenance to
  `SnapCandidate`/`ResolvedSnap`; thread `source` into `addProfileSnapCandidates`.
- *(new)* `src/components/canvas/dimensionRendering.ts` — `drawDimensions(...)`.
- `src/components/canvas/measurements.ts` — small shared helpers (arrowheads,
  multi-line readout label) if needed; reuse existing label drawing.
- `src/components/canvas/SketchCanvas.tsx` — new draw layer, tape + dimension tool
  click/move handling, dimension hit-testing/selection/drag-edit, `Esc` handling.
- `src/store/types.ts` — `PendingDimensionTool`, `tapeMeasure` state,
  `annotations`-related selection fields, new action signatures on `ProjectStore`.
- *(new)* `src/store/slices/dimensionsSlice.ts` — add/update/delete (history).
- *(new)* `src/store/slices/dimensionToolSlice.ts` — transient tape + pending
  dimension tool actions.
- `src/store/projectStore.ts` — wire the new slices into the store.
- `src/utils/units.ts` — convert `annotations` in `convertProjectUnits`; add
  `formatAngle` if not present.
- `src/components/layout/Toolbar.tsx` — Measure tool group + buttons.
- `src/assets/icons.camj` (+ regenerate `public/icons.svg` via `npm run sync-icons`)
  — `measure` and `dimension` icons.
- `INDEX.md` files: `src/sketch/`, `src/components/canvas/`, `src/store/slices/`
  updated for the new files (per the maintenance rule).

## Tests

Engine/pure logic gets unit tests (required by AGENTS.md):

- **`src/sketch/dimensions.test.ts`**
  - `resolveAnchor`: correct world point for `vertex` / `midpoint` / `center` /
    `origin` / `free`; returns `null` for missing feature and out-of-range index;
    a resolved vertex anchor **moves** when the feature's sketch origin/geometry
    changes (the core auto-update guarantee).
  - `measureValue`: correct numbers for aligned / horizontal / vertical / radius /
    diameter / angle on known fixtures; `null` when an anchor is dangling.
  - `dimensionGeometry`: offset sign places the dimension line on the expected
    side; witness/arrow endpoints are correct for a simple horizontal case.
- **units**: `convertProjectUnits` round-trips a project containing `annotations`
  (free point, offset, labelOffset) between mm↔inch; angle values unchanged.
- **store**: `addDimensionAnnotation` / `updateDimensionAnnotation` /
  `deleteDimensionAnnotation` mutate correctly, bump `meta.modified`, and
  participate in undo/redo; `normalizeProject` defaults `annotations` to `[]` for a
  legacy project object lacking the field.

Rendering and pointer interaction in `SketchCanvas.tsx` are validated manually
(no canvas test harness exists today).

## Open questions / risks

**Resolved (confirmed by user 2026-06-02):**

1. **Dimension types for v1.** ✅ Full set — aligned/parallel, horizontal,
   vertical, radius, diameter, angle.
2. **Behaviour when an anchored feature is deleted.** ✅ Keep the dimension as
   *dangling* (drawn muted, with a warning); deleting a feature is non-destructive
   to its dimensions, which can be re-anchored or deleted.
3. **Tape-measure readout content.** ✅ Distance + Δx + Δy + angle.

**Still open (sensible defaults proposed; speak up to change):**

4. **Circle default.** When dimensioning a circle, default to diameter (Ø) or
   radius (R)? (Both available; this is just the default. Proposed: diameter.)
5. **Anchor targets in v1.** Proposed: features + stock + machine origin; tabs and
   clamps come later. OK to defer tabs/clamps?
6. **3D / export.** Confirm dimensions stay 2D-sketch-only and are excluded from
   the 3D viewport and any export in v1.
7. **Field name.** Confirm the new top-level field is `annotations` (kept distinct
   from the existing parametric `dimensions` map).

## Out of scope

- Toolpath/G-code/3D/simulation awareness of dimensions — annotations are inert.
- Tolerances, GD&T symbols, dimension styles/themes, leader notes, and free text
  annotations (the `annotations` array is named to leave room for these later, but
  only `DimensionAnnotation` ships now).
- Ordinate/baseline/chain dimension families (unless pulled in via open question 1).
- Auto-dimensioning / one-click "dimension this feature" automation.
- Dragging a dimension to *drive* geometry (these are read-only annotations, not
  constraints).
