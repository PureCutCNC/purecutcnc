# Open Feature → `'line'` Operation Type

## Problem

Open features (polylines, splines) are currently created with `operation: 'subtract'`. This is semantically incorrect — they don't subtract volume from the stock (they're 2D lines, not extrusions). In the 3D view they now render as lines at Z Top, but their operation type still says "Subtract".

We need a dedicated `'line'` operation type that:
- Is semantically correct (a line is neither additive nor subtractive)
- Locks Z Bottom to 0 and non-editable
- Renders as thick lines in the 3D view (already implemented via `Line2`)
- Cannot be changed by the user
- Still participates in CAM operations where it makes sense (follow-line carving)

## Changes

### 1. [`src/types/project.ts:153`](../../src/types/project.ts:153) — Type definition

```typescript
export type FeatureOperation = 'add' | 'subtract' | 'region' | 'model' | 'line'
```

### 2. [`src/store/slices/pendingAddSlice.ts:426`](../../src/store/slices/pendingAddSlice.ts:426) — Spline creation

Change `operation: 'subtract'` → `operation: 'line'` for spline features (open profiles).

### 3. [`src/store/slices/pendingAddSlice.ts:457`](../../src/store/slices/pendingAddSlice.ts:457) — Polyline creation

Change `operation: 'subtract'` → `operation: 'line'` for polyline features (open profiles).

### 4. [`src/store/projectStore.ts:4790`](../../src/store/projectStore.ts:4790) — Imported open profiles

Change from:
```typescript
const operation: FeatureOperation = shape.profile.closed ? 'add' : 'subtract'
```
to:
```typescript
const operation: FeatureOperation = shape.profile.closed ? 'add' : 'line'
```

### 5. [`src/components/feature-tree/PropertiesPanel.tsx:1231`](../../src/components/feature-tree/PropertiesPanel.tsx:1231) — Single-edit operation selector

Detect when the selected feature has `profile.closed === false` (or `operation === 'line'`) and show a locked "Line" option instead of the Add/Subtract/Region dropdown.

Current logic (simplified):
```typescript
{operationLockedToAdd || selectedFeature.operation === 'model' ? (
  // locked display
) : (
  // dropdown with add/subtract
)}
```

New logic:
```typescript
{!selectedFeature.sketch.profile.closed || selectedFeature.operation === 'line' ? (
  // locked "Line" display
) : operationLockedToAdd || selectedFeature.operation === 'model' ? (
  // locked display (existing)
) : (
  // dropdown with add/subtract (existing)
)}
```

### 6. [`src/components/feature-tree/PropertiesPanel.tsx:1106`](../../src/components/feature-tree/PropertiesPanel.tsx:1106) — Multi-edit operation selector

Detect when ALL selected editable features are open (non-closed). Show a locked "Line" option in the multi-edit case.

### 7. [`src/components/project/TextToolDialog.tsx`](../../src/components/project/TextToolDialog.tsx) — Text tool dialog

The text tool creates closed profiles (outlines), so it should continue to use `'add'`/`'subtract'`. No change needed.

### 8. NO CHANGE: [`src/text/index.ts:197`](../../src/text/index.ts:197) — `invertOperation`

Keep unchanged. The caller already skips open features:
```typescript
if (!expanded.sketch.profile.closed) continue
```

### 9. NO CHANGE: [`src/engine/csg.ts`](../../src/engine/csg.ts) — Feature mesh/solid building

Keep using `!profile.closed` checks. The `'line'` operation is just for the UI label; the geometry logic already handles open profiles correctly.

### 10. NO CHANGE: Toolpath filters

Per the toolpath filtering analysis below, the only operation that meaningfully uses open features is **follow-line carving** ([`carving.ts:166-167`](../../src/engine/toolpaths/carving.ts:166)), which doesn't filter by operation type. All other filters either already reject open profiles via `featureHasClosedGeometry` or filter on `'add'`/`'model'` which open features never were.

| Toolpath | Currently includes open features? | Impact of `'line'` |
|---|---|---|
| Follow-line carve | ✅ Yes (no op filter) | ❌ None — still works |
| Pocket / V-carve | ❌ No (rejected by closed-geometry check) | ❌ None |
| Edge route inside | ✅ Yes (as `'subtract'`) but meaningless | ✅ Correctly excluded |
| Surface clean | ❌ No (filter `'add'`/`'model'`) | ❌ None |
| Rest regions | ❌ No (filter `'add'`/`'model'`) | ❌ None |
| Model protection | ❌ No meaningful inclusion | ❌ None |

## Implementation Order

1. Update type definition in `project.ts`
2. Update creation sites in `pendingAddSlice.ts` and `projectStore.ts`
3. Update PropertiesPanel single-edit and multi-edit UI
4. Run `npm run build` to verify

## Files Modified (summary)

| File | Change |
|---|---|
| `src/types/project.ts:153` | Add `'line'` to `FeatureOperation` union |
| `src/store/slices/pendingAddSlice.ts:426` | Spline: `'subtract'` → `'line'` |
| `src/store/slices/pendingAddSlice.ts:457` | Polyline: `'subtract'` → `'line'` |
| `src/store/projectStore.ts:4790` | Imported open: `'subtract'` → `'line'` |
| `src/components/feature-tree/PropertiesPanel.tsx:1106,1231` | Locked "Line" display for open profiles |

No changes needed to: `csg.ts`, `text/index.ts`, any toolpath files.
