# Ellipse Feature — Implementation Plan

## Overview

An ellipse is a natural extension of the circle. It shares the same 2-click placement UX (center → corner of bounding box), but has two independent radii (`rx`, `ry`). The representation uses 4 cubic bezier segments (κ ≈ 0.5523 approximation) stored as a `composite`-style profile, with `kind: 'ellipse'` added to `FeatureKind`.

## Steps

### Step 1 — Data model (`src/types/project.ts`)

- Add `'ellipse'` to `FeatureKind`.
- Add `ellipseProfile(cx, cy, rx, ry): SketchProfile` helper — emits 4 cubic bezier segments (standard κ = 0.5523 approximation), `closed: true`.
- Update `inferFeatureKind()` to detect the 4-bezier ellipse pattern and return `'ellipse'`.
- Update `getProfileBounds()` — for an ellipse detected by `inferFeatureKind`, return exact `[cx−rx, cx+rx] × [cy−ry, cy+ry]` (derive cx/cy/rx/ry from the bezier control points).

### Step 2 — Store types (`src/store/types.ts`)

- Add `{ shape: 'ellipse'; anchor: Point | null; session: number }` to `PendingAddTool`.
- Add `startAddEllipsePlacement` and `addEllipseFeature` to `ProjectStore` interface.

### Step 3 — Store actions (`src/store/slices/pendingAddSlice.ts` + `src/store/projectStore.ts`)

- `startAddEllipsePlacement` — same pattern as `startAddCirclePlacement`.
- In `placePendingAddAt`: handle `shape === 'ellipse'` — compute `rx = |point.x - anchor.x|`, `ry = |point.y - anchor.y|`, call `addEllipseFeature`.
- `addEllipseFeature(name, cx, cy, rx, ry, depth)` in `projectStore.ts` — calls `ellipseProfile`, creates feature with `kind: 'ellipse'`.

### Step 4 — Manual entry (`src/components/canvas/manualEntry.ts`)

- Add `'ellipse'` to `DimensionEditState.shape`.
- In `computeDimensionEditPreviewPoint`: handle `'ellipse'` — use `width`/`height` fields, return `{ x: anchor.x + signX * w, y: anchor.y + signY * h }`.

### Step 5 — Canvas interaction (`src/components/canvas/SketchCanvas.tsx`)

- Add `'ellipse'` to `ClosedPendingAddShape` union.
- In the preview drawing block: handle `pendingAdd.shape === 'ellipse'` — draw an ellipse preview using `ctx.ellipse(...)`.
- In the Tab key dimension-entry flow: handle `'ellipse'` — offer `width` then `height` fields (same as rect).
- Add status bar hint text for ellipse tool.

### Step 6 — Toolbar (`src/components/layout/Toolbar.tsx`)

- Add `onEllipse` prop to `CreationActions`.
- Add `handleEllipse` in the toolbar hook → `togglePlacement('ellipse', startAddEllipsePlacement)`.
- Add `ToolbarActionButton` with `icon="ellipse"` between circle and polygon.

### Step 7 — Icon (`src/assets/icons.camj` + `public/icons.svg`)

- Add an `ellipse` icon to `icons.camj` (a simple horizontal ellipse on 24×24 canvas).
- Run `npm run sync-icons` to regenerate `public/icons.svg`.

### Step 8 — Rendering (`src/components/canvas/profilePrimitives.ts`)

No changes needed — ellipse is stored as 4 bezier segments, which `traceProfilePath` already handles.

### Step 9 — Sketch edit controls (`src/components/canvas/scenePrimitives.ts`)

`inferFeatureKind` returns `'ellipse'` for the 4-bezier pattern. The generic bezier control handles (4 anchors + 8 bezier handles) work out of the box. No special-casing needed for the first pass.

## Out of Scope (follow-up)

- Ellipse-specific sketch-edit UX (rx/ry handle that preserves ellipse constraint while dragging).
- Snapping to ellipse center or quadrant points.
- DXF/SVG import of `<ellipse>` elements.

---

## Implementation Status

**Implemented** — all 9 steps above are complete and merged on `feature/ellipse`.

## Known Limitation — No Native Ellipse Segment Type

The current implementation stores an ellipse as **4 cubic bezier segments** in a standard `SketchProfile`. `inferFeatureKind()` recognises the κ-pattern and returns `'ellipse'`, but the underlying storage is still bezier geometry. This means:

- Once the user edits the ellipse in sketch-edit mode, the bezier handles move independently and the ellipse constraint is lost — it silently degrades to a generic spline (`kind` reverts to `'spline'`).
- There is no lossless round-trip for `cx / cy / rx / ry` — those values are re-derived from the bezier anchors on every read.
- Sketch-edit offers 4 anchor + 8 bezier handle controls rather than a clean center + rx + ry handle set.

This is the same problem that existed with circles before the `CircleSegment` native type was introduced (see `planning/NATIVE_CIRCLE_Implementation_Plan.md`). The fix is to follow the same pattern:

- Add a first-class `EllipseSegment` type to the `Segment` union in `project.ts`.
- Store the ellipse as a single-segment profile: `start = { cx+rx, cy }`, segment carries `center`, `rx`, `ry`.
- Update all consumers (`sampleProfilePoints`, `traceProfilePath`, `getProfileBounds`, sketch-edit controls, snapping) to handle the new segment type.
- Add a migration in `normalizeProject()` to upgrade existing bezier-ellipse profiles on load.

This work should be tracked as **NATIVE_ELLIPSE_Implementation_Plan.md** when prioritised.
