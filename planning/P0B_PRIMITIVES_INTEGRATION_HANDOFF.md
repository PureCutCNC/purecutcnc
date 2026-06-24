# Integration Handoff — P0b Primitives (Slot / Ngon)

> Authoritative ledger for the integration manager and implementation workers. Do not store tokens, raw environment values, or unredacted provider debug output here.

## Role and stop condition

The integration manager turns the approved design into sequential worktree slices, independently reviews and verifies each slice, and merges only accepted commits into the integration branch. Stop after the final repository verification and hand the result to the user for manual test and review. Do not create a PR, archive the feature plan, or merge to `main` without explicit user direction.

## Integration state

- Integration branch: `feat/p0b-primitives`
- Integration worktree: `/Users/frankp/Projects/purecutcnc` (main checkout, on the integration branch)
- Base commit: `08d67b65a565af4c05ca16cdbb8ac1922215285e`
- Approved plan: `planning/P0B_PRIMITIVES_Plan.md`
- Manager session: `2026-06-23`
- Status: `complete — awaiting user test`
- User authorization for credential-backed worker dispatch: granted (2026-06-23, this session)
- Final commit: `ee7fb3c` (2026-06-24)

## Global rules

- One active implementation slice at a time.
- Every worker runs in its own task worktree branched from the current integration tip, never in the integration checkout.
- The worker may use `bypassPermissions` only through the project launcher in explicit implementation mode.
- The manager owns worktree/branch creation, review, merge, cleanup, plan status, browser regression, push, and PR decisions.
- Reject any worker result without exactly one expected task commit, a clean task worktree, scoped changes, and truthful required-check results.
- Browser/tablet-affected work (S2, S3) requires manual regression before final user handoff.

## Slice ledger

| Slice | Scope | Base commit | Task branch / worktree | Worker status | Manager review | Accepted commit / merge | Required checks | Notes |
|-------|-------|-------------|------------------------|---------------|----------------|-------------------------|-----------------|-------|
| S1 | Geometry helpers + store layer + unit tests | `08d67b6` | `p0b-s1-geometry` / retired | `complete` | `accepted` | `dc22b5d` (merge `2935865`) | pass | 7/7 slot tests, 7/7 ngon tests, build clean |
| S2 | Canvas interaction + preview | `dc22b5d` | `p0b-s2-canvas` / retired | `complete` | `accepted` | `7989700` (merge `c82c9ca`) | pass | build clean; visual check deferred to user |
| S3 | Toolbar + workflow panel | `7989700` | `p0b-s3-toolbar` / retired | `complete` | `accepted` | `bf8ffc6` (merge `b87da06`) | pass | build clean |
| S4 | Icons (manager only) | `bf8ffc6` | n/a — manager direct | `complete` | `accepted` | `ee7fb3c` | pass | slot=obround pill, ngon=flat-top hexagon |

---

## Slice instructions

### S1 — Geometry helpers, store layer, and unit tests

**Goal:** Add `slotProfile` and `ngonProfile` helpers to `src/types/project.ts`, extend the store's `PendingAddTool` union and `ProjectStore` interface, implement the corresponding slice actions, and ship unit tests. No React, no canvas, no toolbar.

**Allowed files:**

- `src/types/project.ts` — add `slotProfile` and `ngonProfile`
- `src/store/types.ts` — extend `PendingAddTool` union; add method signatures to `ProjectStore`
- `src/store/slices/pendingAddSlice.ts` — implement `startAddSlotPlacement`, `startAddNgonPlacement`, `setPendingNgonSides`, `placePendingSlotAt`
- `src/store/slices/featureSlice.ts` — implement `addSlotFeature`, `addNgonFeature`
- `src/types/slot.test.ts` *(new file)*
- `src/types/ngon.test.ts` *(new file)*

**Forbidden files:**

- Any file under `src/components/`
- Any file under `src/commands/`
- `src/assets/` (icons)
- Any file not listed above

**Invariants:**

- `FeatureKind`, `inferFeatureKind`, and the existing profile helpers (`rectProfile`, `circleProfile`, `ellipseProfile`, `polygonProfile`, `splineProfile`) must not change.
- Existing `PendingAddTool` union variants and `ProjectStore` method signatures must not change (additive only).
- Existing store tests must continue to pass.
- Every new source file must carry the Apache 2.0 license header matching the existing files.
- Strict TypeScript — no `any`, no suppressions.

**`slotProfile` spec (`src/types/project.ts`):**

```typescript
export function slotProfile(p1: Point, p2: Point, width: number): SketchProfile {
  const r = width / 2
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
  const px = -Math.sin(angle), py = Math.cos(angle)

  const A = { x: p1.x + r * px, y: p1.y + r * py }
  const B = { x: p2.x + r * px, y: p2.y + r * py }
  const C = { x: p2.x - r * px, y: p2.y - r * py }
  const D = { x: p1.x - r * px, y: p1.y - r * py }

  return {
    start: A,
    segments: [
      { type: 'line', to: B },
      { type: 'arc', center: p2, to: C, clockwise: true },
      { type: 'line', to: D },
      { type: 'arc', center: p1, to: A, clockwise: true },
    ],
    closed: true,
  }
}
```

**`ngonProfile` spec (`src/types/project.ts`):**

```typescript
export function ngonProfile(
  cx: number, cy: number,
  n: number,
  circumradius: number,
  firstVertexAngle: number,
): SketchProfile {
  const vertices = Array.from({ length: n }, (_, i) => ({
    x: cx + circumradius * Math.cos(firstVertexAngle + (i * 2 * Math.PI) / n),
    y: cy + circumradius * Math.sin(firstVertexAngle + (i * 2 * Math.PI) / n),
  }))
  return polygonProfile(vertices)
}
```

**`PendingAddTool` extensions (`src/store/types.ts`):**

```typescript
| { shape: 'slot'; points: Point[]; session: number }
| { shape: 'ngon'; anchor: Point | null; sides: number; session: number }
```

**`ProjectStore` new method signatures (`src/store/types.ts`):**

```typescript
startAddSlotPlacement(): void
startAddNgonPlacement(): void
setPendingNgonSides(n: number): void
placePendingSlotAt(p3: Point): void
addSlotFeature(name: string, p1: Point, p2: Point, width: number, depth: number): void
addNgonFeature(name: string, cx: number, cy: number, sides: number, circumradius: number, firstVertexAngle: number, depth: number): void
```

**`pendingAddSlice.ts` implementation notes:**
- `startAddSlotPlacement` — sets `pendingAdd = { shape: 'slot', points: [], session: nextSession() }`.
- `startAddNgonPlacement` — sets `pendingAdd = { shape: 'ngon', anchor: null, sides: 6, session: nextSession() }`.
- `setPendingNgonSides(n)` — if `pendingAdd.shape === 'ngon'`, update `sides` in place. Clamp to `[3, 50]`. Do not reset `session` or `anchor`.
- `addPendingPolygonPoint` already handles the multi-click pattern. For slot, a separate `placePendingSlotAt(p3)` action is cleaner: it receives the committed width (computed by the canvas layer) and calls `addSlotFeature` before clearing `pendingAdd`.
- Follow the existing `addPendingPolygonPoint` / `startAddPolygonPlacement` pattern for session/cancel logic.

**`featureSlice.ts` implementation notes:**
- `addSlotFeature` creates a `FeatureDefinition` with `kind: 'composite'` and a `slotProfile(p1, p2, width)` profile. Wrap in a `FeatureInstance` at the identity transform (same as `addRectFeature`). Default depth from `projectDefaults.depth`.
- `addNgonFeature` creates `kind: 'polygon'` with `ngonProfile(cx, cy, sides, circumradius, firstVertexAngle)`. Default depth from `projectDefaults.depth`.
- Name parameter is passed in from the canvas layer (e.g. `"Slot 1"`, `"Hexagon 2"`).

**Unit tests (`src/types/slot.test.ts`):**

| Test | Assertion |
|------|-----------|
| Segment count and types | 4 segments: `line, arc, line, arc` |
| Arc centers | `segments[1].center ≈ p2`, `segments[3].center ≈ p1` |
| Connectivity | Each `.to` equals next segment's start (within ε = 1e-10) |
| Arc radii (computed) | Distance from arc center to `.to` ≈ `width/2` |
| Closure | `segments[3].to ≈ profile.start` |
| Horizontal slot | A.y = `p1.y + r`, B.y = `p2.y + r` |
| Rotated 45° | Midpoint of top line ≈ `(p1+p2)/2 + r*(-sin45, cos45)` |

**Unit tests (`src/types/ngon.test.ts`):**

| Test | Assertion |
|------|-----------|
| Segment count | Exactly `n` line segments |
| Equilateral | All edge lengths equal within ε |
| Circumradius | All vertices exactly `circumradius` from center |
| First vertex angle | `profile.start ≈ (cx + r·cosθ, cy + r·sinθ)` |
| Closure | Last segment `.to ≈ profile.start` |
| Triangle area | ≈ `(3√3/4) · r²` for n=3 |
| Hexagon area | ≈ `(3√3/2) · r²` for n=6 |

**Required checks:**

```bash
npm run build
npx vitest run src/types/slot.test.ts src/types/ngon.test.ts
```

**Manager review record:**

- Worker invocation: `-`
- Worker-reported completion: `-`
- Diff/commit review: `-`
- Correction attempts: `-`
- Acceptance decision: `-`

---

### S2 — Canvas interaction and preview

**Goal:** Make the canvas aware of the slot 3-click and ngon anchor-drag workflows: extend `DimensionEditState`, implement the preview drawing functions, wire the creation workflow, and update `SketchCanvas.tsx` draw loop. No toolbar, no workflow panel UI (those are S3).

**Allowed files:**

- `src/components/canvas/manualEntry.ts` — extend `DimensionEditState.shape` for `'slot'` and `'ngon'`
- `src/components/canvas/previewPrimitives.ts` — add `drawPendingSlotAxis`, `drawPendingSlotWidth`, `drawPendingNgon` (create the file if it does not exist; otherwise add to it)
- `src/components/canvas/useCreationWorkflow.ts` — extend `CreationPanelShape` to include `'slot'` and `'ngon'`; add slot 3-phase commit logic and ngon anchor-drag logic
- `src/components/canvas/SketchCanvas.tsx` — wire `'slot'` and `'ngon'` into the draw loop so previews render

**Forbidden files:**

- `src/components/canvas/CanvasWorkflowPanel.tsx` (that is S3)
- `src/components/layout/` (S3)
- `src/commands/` (S3)
- `src/types/` (done in S1)
- `src/store/` (done in S1)
- `src/assets/` (S4)
- Any file not listed above

**Invariants:**

- All existing creation workflow shapes (`'rect'`, `'circle'`, `'ellipse'`, `'polygon'`, `'spline'`, `'composite'`, `'text'`) must continue to work unchanged.
- The `DimensionEditState.shape` discriminant union must be kept exhaustive (update every `switch`/`if` that branches on `edit.shape`). Run `grep -r "edit\.shape\|dimensionEdit\.shape" src/` to find all switch sites before starting.
- `useCreationWorkflow` must handle Escape at any slot phase canceling entirely (call the existing cancel path).
- Width is computed each frame from cursor perpendicular distance; it is **not** stored in `PendingAddTool`.

**Slot perpendicular distance formula:**

```
axis    = p2 − p1
axisLen = |axis|
perp    = |((cursor − p1) × axis)| / axisLen    // 2D cross product magnitude
width   = perp * 2
```

**Slot canvas logic overview:**
- Phase 1 (P1 not yet set): clicking calls `startAddSlotPlacement` then adds P1 to `points`.
- Phase 2 (`points.length === 1`): live draw of axis line with length readout. Click adds P2.
- Phase 3 (`points.length === 2`): live draw of full slot preview from cursor perpendicular distance. Click calls `placePendingSlotAt(pointerPos)` — the canvas layer computes the final width from the cursor and passes it along. The `placePendingSlotAt` store action calls `addSlotFeature`.

**Ngon canvas logic:**
- Before anchor: draw nothing.
- After anchor, while cursor moves: call `ngonProfile(anchor, cursor distance, sides, angle)` and draw with `drawPreviewProfile`. Draw radius line with `R = …` label.
- Click commit: call `addNgonFeature` with computed circumradius and angle.
- Sides count is read from `pendingAdd.sides`.

**Required checks:**

```bash
npm run build
```

**Manager review record:**

- Worker invocation: `-`
- Worker-reported completion: `-`
- Diff/commit review: `-`
- Correction attempts: `-`
- Acceptance decision: `-`

---

### S3 — Toolbar, commands, and workflow panel

**Goal:** Wire slot and ngon into the toolbar drawer (2nd row) and add workflow panel content for both tools.

**Allowed files:**

- `src/components/layout/toolbar/shared.ts` — add `tier: 'primary' | 'secondary'` field to each `CREATION_SHAPE_OPTIONS` entry; mark existing shapes `'primary'`; add `slot` and `ngon` as `'secondary'`
- `src/commands/creationShapes.ts` — mirror the same `tier` field + slot/ngon entries; update `activateShape` to handle `'slot'` and `'ngon'` (call `startAddSlotPlacement` / `startAddNgonPlacement`)
- `src/components/layout/toolbar/CreationActions.tsx` — render primary shapes in one row, secondary shapes in a second row with a separator; no change to `lastShape` tracking
- `src/components/canvas/CanvasWorkflowPanel.tsx` — add panel content for slot phases (`'start'` / `'axis'` / `'width'`) with a Width button wired to `triggerDimensionFromCreationPanel`; add panel content for ngon (`'start'` / `'place'`) with a Sides `<input type="number" min={3} max={50}>` wired to `setPendingNgonSides`

**Forbidden files:**

- `src/store/` (done in S1)
- `src/types/` (done in S1)
- `src/components/canvas/useCreationWorkflow.ts` (done in S2)
- `src/components/canvas/manualEntry.ts` (done in S2)
- `src/components/canvas/previewPrimitives.ts` (done in S2)
- `src/components/canvas/SketchCanvas.tsx` (done in S2)
- `src/assets/` (S4)
- Any file not listed above

**Invariants:**

- The `CREATION_SHAPE_OPTIONS` arrays in `shared.ts` and `creationShapes.ts` must stay identical (same entries, same order, same fields). Both must gain the `tier` field on every entry.
- The existing primary-row layout (grid, spacing, icon sizing) must not change.
- The secondary row renders **only when the creation drawer is open** (same visibility as the first row — it is inside the drawer popover, not always-visible).
- The Width button (slot) follows the same `triggerDimensionFromCreationPanel` pattern as text tool's dimension button.

**Toolbar drawer structure:**
```
Row 1 (primary):   rect | circle | ellipse | polygon | spline | composite | text
Separator (thin divider or gap class)
Row 2 (secondary): slot | ngon
```

**Ngon name-derivation helper (use in `CanvasWorkflowPanel.tsx` or the commit path):**
```
3→Triangle, 4→Square, 5→Pentagon, 6→Hexagon,
7→Heptagon, 8→Octagon, 9→Nonagon, 10→Decagon,
11→Hendecagon, 12→Dodecagon; else `Polygon${n}`
Append ` ${features.length + 1}`
```

**Required checks:**

```bash
npm run build
```

**Manager review record:**

- Worker invocation: `-`
- Worker-reported completion: `-`
- Diff/commit review: `-`
- Correction attempts: `-`
- Acceptance decision: `-`

---

### S4 — Icons (manager only)

**Goal:** Add `slot` (obround/pill shape) and `ngon` (regular hexagon) icons to `src/assets/icons.camj` using the app itself, then regenerate `public/icons.svg` via `npm run sync-icons`.

This slice is performed by the integration manager directly — no worker dispatch.

- Open `src/assets/icons.camj` in the running app.
- Create a new folder/layer named `slot` and draw an obround (horizontal pill) shape.
- Create a new folder/layer named `ngon` and draw a regular hexagon.
- Save, then run `npm run sync-icons` to regenerate `public/icons.svg`.
- Run `npm run build` to verify.

**Required checks:**

```bash
npm run sync-icons && npm run build
```

**Manager review record:**

- Completion: `-`
- Acceptance decision: `-`

---

## Integration verification

- Accepted commits and merge order: `-`
- Repository checks: `npm run build`
- Browser/tablet checks: `pending — manual regression after all slices merged`
- Known limitations or deferred work:
  - Parametric re-edit of committed slot/ngon (future enhancement)
  - Inscribed-radius / across-flats mode for ngon (future toggle)
  - `pendingAddSlice.ts` / `CanvasWorkflowPanel.tsx` line-count: if either approaches its ESLint max-lines cap, extract slot/ngon handlers to a sibling file rather than bumping the cap

## User-review handoff

```text
Integration branch: feat/p0b-primitives
Detailed handoff: planning/P0B_PRIMITIVES_INTEGRATION_HANDOFF.md
Accepted slices: <to be filled>
Verification: npm run build — <result>
Manual test requested:
  Slot:  1. Open a sketch  2. Click Slot in the shape drawer (second row)
         3. Click P1 (first end-center)  4. Click P2 (second end-center)
         5. Move cursor to set width, verify live preview  6. Click P3 to commit
         7. Verify slot appears in feature tree as "Slot 1" (composite)
         8. Test Width button for numeric entry
  Ngon:  1. Click Ngon in the shape drawer (second row)
         2. Set Sides to 3 (triangle), 6 (hexagon), 12 in the panel
         3. Click center, drag for radius, verify live preview
         4. Click to commit; verify name (Triangle, Hexagon, etc.)
  Tablet: repeat both workflows with touch input
Known limitations: none beyond deferred items above
No PR has been created. Please review and confirm whether to proceed.
```
