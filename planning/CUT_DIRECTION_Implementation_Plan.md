# Cut Direction (Conventional / Climb) Implementation Plan

## Status: IN PROGRESS

## Background

CNC milling has two fundamental cut directions:

- **Conventional cut** (CW in machine coordinates): The cutter tooth enters the material gradually. Generates more heat but is safer for worn machines and climb-cutting-unfriendly materials.
- **Climb cut** (CCW in machine coordinates): The cutter tooth bites in aggressively, producing a cleaner surface finish. Preferred on modern rigid machines.

## Coordinate System

The app uses screen coordinates (+Y down). The G-code postprocessor inverts Y
(`dy = origin.y - point.y`) to produce machine coordinates (+Y up / forward).

Shoelace signed area in screen coordinates (+Y down):
- CW on screen → positive signed area → `isClockwise()` returns **false**
- CCW on screen → negative signed area → `isClockwise()` returns **true**

After Y-flip in G-code export:
- CCW on screen → CW in machine → **conventional cut**
- CW on screen → CCW in machine → **climb cut**

`normalizeWinding(contour, true)` = `isClockwise` = true = CCW on screen = **conventional**
`normalizeWinding(contour, false)` = `isClockwise` = false = CW on screen = **climb**

## Root Cause of Wrong Edge-Outside Direction

`flattenFeatureToClipperPath` in `edge.ts` uses `normalizeWinding(points, false)` = CW on screen. Clipper treats this as a hole polygon. Offsetting a hole polygon outward with a positive delta keeps it CW on screen. After Y-flip: CCW in machine = **climb** (wrong).

**Fix**: change to `normalizeWinding(points, true)` so Clipper sees it as an outer polygon. Offset expands it outward keeping CCW on screen → **conventional** by default.

## What Needs to Change

### 1. Data Model (`src/types/project.ts`)
```ts
export type CutDirection = 'conventional' | 'climb'

// In Operation interface (optional for backward compat):
cutDirection?: CutDirection
```

Applies to: `pocket`, `edge_route_inside`, `edge_route_outside`, `v_carve`, `surface_clean`.
Does NOT apply to: `follow_line` (open path), `v_carve_recursive` (diagonal skeleton cuts).

### 2. Store Default (`src/store/projectStore.ts`)
Add `cutDirection: 'conventional'` in `defaultOperationForTarget`.

### 3. Geometry Helper (`src/engine/toolpaths/geometry.ts`)
```ts
export function applyContourDirection(contours: Point[][], direction: CutDirection = 'conventional'): Point[][] {
  // conventional = CCW on screen = normalizeWinding(c, true)
  // climb       = CW on screen  = normalizeWinding(c, false)
  const wantClockwise = direction === 'conventional'
  return contours.map(c => normalizeWinding(c, wantClockwise))
}
```

### 4. Edge Toolpath (`src/engine/toolpaths/edge.ts`)
- **Fix winding input**: `flattenFeatureToClipperPath` → `normalizeWinding(points, true)` (was `false`)
- **edge_route_outside**: normalize `resolveContourPaths` result with `applyContourDirection` before passing to `appendContoursAtLevels`
- **edge_route_inside**: pass `operation.cutDirection` to `cutClosedContours`

### 5. Pocket Toolpath (`src/engine/toolpaths/pocket.ts`)
- **`cutClosedContours`**: add `direction?: CutDirection = 'conventional'` parameter, normalize contours inside
- **`cutOffsetRegionRecursive`**: add `direction` parameter, pass to `cutClosedContours`
- **`generateRoughBandMoves`**: add `direction` parameter; for parallel pattern, normalize `boundaryContours` before looping; for offset pattern, pass to `cutOffsetRegionRecursive`
- **`generateFinishBandMoves`**: add `direction` parameter; pass to `cutClosedContours` for walls and floor
- **`generatePocketToolpath`**: extract `operation.cutDirection ?? 'conventional'` and thread to both band generators

### 6. V-Carve Offset (`src/engine/toolpaths/vcarve.ts`)
Before `toClosedCutMoves(contour, z)`, normalize: `normalizeWinding(contour, (op.cutDirection ?? 'conventional') === 'conventional')`.

### 7. Surface Cleanup (`src/engine/toolpaths/surface.ts`)
- The internal `generateRoughBandMoves` and finish pass call `cutOffsetRegionRecursive` and `cutClosedContours`. Pass `direction` parameter through.
- `generateSurfaceCleanToolpath`: extract direction and thread through.

### 8. UI (`src/components/cam/CAMPanel.tsx`)
Add a `<select>` for cut direction, visible for `pocket | edge_route_inside | edge_route_outside | v_carve | surface_clean`:

```tsx
{['pocket', 'edge_route_inside', 'edge_route_outside', 'v_carve', 'surface_clean'].includes(operation.kind) && (
  <label className="properties-field">
    <span>Cut Direction</span>
    <select
      value={selectedOperation.cutDirection ?? 'conventional'}
      onChange={(e) => updateOperation(selectedOperation.id, { cutDirection: e.target.value as CutDirection })}
    >
      <option value="conventional">Conventional</option>
      <option value="climb">Climb</option>
    </select>
  </label>
)}
```

## Testing Checklist

- [ ] Edge route outside (rough + finish) cuts CW on machine (conventional) by default
- [ ] Edge route outside switches to CCW (climb) when set
- [ ] Pocket offset pattern: same conventional/climb toggle works
- [ ] Pocket parallel pattern: boundary contours follow direction
- [ ] V-carve offset contours follow direction
- [ ] Surface clean contours follow direction
- [ ] Edge route inside follows direction
- [ ] Existing projects without `cutDirection` field default to conventional
- [ ] `npm run build` passes with no TypeScript errors

## Files Changed

1. `src/types/project.ts`
2. `src/store/projectStore.ts`
3. `src/engine/toolpaths/geometry.ts`
4. `src/engine/toolpaths/edge.ts`
5. `src/engine/toolpaths/pocket.ts`
6. `src/engine/toolpaths/vcarve.ts`
7. `src/engine/toolpaths/surface.ts`
8. `src/components/cam/CAMPanel.tsx`
