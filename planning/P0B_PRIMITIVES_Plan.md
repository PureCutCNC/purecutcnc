---
status: In progress
created: 2026-06-23
---

# P0b Primitives Plan — Slot/Obround and Regular Polygon

## Goal

Add two new sketch creation primitives that CNC users commonly need but must
currently construct by hand: a **slot/obround** (two semicircular end caps
connected by straight sides) and a **regular polygon** (equilateral N-gon from
3–50 sides). Both produce standard `SketchProfile` shapes that participate fully
in existing toolpaths, constraints, fillets, transforms, and undo.

Neither primitive adds a new `FeatureKind`. They are **creation macros**: the
tool generates an ordinary `'composite'` (slot) or `'polygon'` (ngon) profile
and commits it like any other feature. Post-commit, the profile is editable
through the normal vertex/segment workflow.

---

## 1. Slot / Obround

### 1.1 Interaction model — three-click with live width preview

```
P1 click  →  P2 click  →  cursor sets width live  →  P3 click commits
                                   ↑
                           "Width" button opens numeric field
                           (same pattern as text-entry dimensions)
```

1. **Click P1** — snaps and anchors the center of one end cap. Workflow panel:
   "Click second end-center."
2. **Drag toward P2 / hover** — live preview of the axis line + length readout.
3. **Click P2** — axis is locked. The slot preview immediately appears using a
   default width (see §1.4). Workflow panel transitions to "Move to set width,
   click to commit" and shows a **Width** button for manual entry.
4. **Move cursor** — width tracks the perpendicular distance from the cursor to
   the axis line. The slot profile re-renders live at each frame. A "W = …"
   label updates on the canvas.
5. **Click P3** — commits the slot at the current width. **Escape at any phase
   cancels the entire tool** with no partial rewind.
6. **Width button** — at any point after P2, pressing the Width button (or
   pressing `D` / `Tab`) opens the numeric entry field pre-filled with the
   current live width. Enter commits; Escape returns to live-drag mode.

This is the same pattern as the text tool's dimension entry: the live-drag gives
a natural feel; the button provides keyboard-exact entry for CNC precision. Both
paths lead to the same commit.

### 1.2 PendingAdd state

```typescript
// Add to PendingAddTool union in src/store/types.ts
| {
    shape: 'slot'
    points: Point[]   // points[0] = P1; points[1] = P2 once set
    session: number
  }
```

Width is **not** stored in `PendingAddTool` — it is computed each frame from
the current canvas pointer position (perpendicular distance to the axis), the
same way the rect tool computes W/H from the drag delta. The dimension-edit
field (`DimensionEditState`) holds a typed override when the Width button is
open.

The perpendicular distance from a point `Q` to the line through `P1`→`P2`:

```
axis     = P2 − P1
axisLen  = |axis|
perp     = |((Q − P1) × axis)| / axisLen    // 2D cross product magnitude
width    = perp * 2          // full width = 2 × half-width; any value > 0 accepted
```

### 1.3 Geometry generation — `slotProfile`

```typescript
slotProfile(p1: Point, p2: Point, width: number): SketchProfile
```

An obround is two line segments (long sides) connecting two semicircular arc
segments (end caps). Four segments total.

```
r     = width / 2
angle = atan2(p2.y − p1.y, p2.x − p1.x)

// Axis and perpendicular unit vectors (screen Y-down)
ux = cos(angle),  uy = sin(angle)
px = −sin(angle), py = cos(angle)

A = { x: p1.x + r*px, y: p1.y + r*py }   // top of left cap
B = { x: p2.x + r*px, y: p2.y + r*py }   // top of right cap
C = { x: p2.x − r*px, y: p2.y − r*py }   // bottom of right cap
D = { x: p1.x − r*px, y: p1.y − r*py }   // bottom of left cap

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
```

`clockwise: true` is the same convention as `circleProfile`. Verify with the
arc-winding unit test (§1.7) — flip to `false` if the profile renders as
concave/inverted. This is a one-bit change with no other impact.

Add `slotProfile` to `src/types/project.ts` alongside the existing primitive
helpers.

### 1.4 Default width on P2 commit

When the user clicks P2, the cursor may already be off-axis (some perpendicular
distance). Use the cursor's actual perpendicular distance as the initial width
if it is above the minimum; otherwise use a unit-aware fallback:

```
fallbackWidth = units === 'mm' ? 6 : 0.25
initialWidth  = perp * 2 > 0 ? perp * 2 : fallbackWidth
```

This means in most cases the preview immediately shows a reasonable slot, and
the user just clicks P3 when happy.

### 1.5 Feature kind and storage

**Kind: `'composite'`** — no new `FeatureKind` value. The slot profile (2 lines
+ 2 arcs) is structurally a composite; `inferFeatureKind` already returns
`'composite'` for mixed segment profiles. No changes to `inferFeatureKind` or
`FeatureKind` are needed.

**Storage:** same as any other composite feature. `FeatureDefinition.profile`
holds the 4-segment profile. `FeatureDefinition.kind = 'composite'`. The
parametric dimensions (D and W) are not stored explicitly — they are computable
from the profile at any time (D = distance between the two arc centers; W = 2 ×
arc radius).

**Name on commit:** `Slot ${features.length + 1}`.

### 1.6 Dimension readout during creation

- **P1 set, cursor moving toward P2:** dashed axis line with a length label
  using `drawLineLengthMeasurement`.
- **P2 set, cursor moving for width:** full slot preview via `drawPreviewProfile`
  (filled, dashed stroke). A perpendicular dimension line from the axis center
  to the cursor with `W = …` label.
- Reuse existing `drawLineLengthMeasurement` and `drawPreviewProfile`.

### 1.7 Geometry unit tests

New test file `src/types/slot.test.ts` (or added to `project.test.ts`):

| Test | What to verify |
|------|----------------|
| Segment count and types | 4 segments: `line, arc, line, arc` |
| Arc centers | `segments[1].center ≈ p2`, `segments[3].center ≈ p1` |
| Connectivity | Each segment's `.to` = next segment's start |
| Arc radii | Both arc radii ≈ `width/2` |
| Closure | `segments[3].to ≈ profile.start` |
| Axis-aligned correctness | Horizontal slot: all A/B.y = `p1.y ± r` |
| Rotated correctness | 45° slot: midpoint of top-side ≈ `(p1+p2)/2 + r*(−sin45, cos45)` |
| Arc winding | Profile area is positive (not concave / inverted) |

---

## 2. Regular Polygon

### 2.1 Interaction model — anchor + drag, sides field in panel

Follows the circle/ellipse anchor-drag pattern:

1. **Tool activated** — workflow panel immediately shows a **Sides** numeric
   input field (default 6, range 3–50). User can type the desired sides count
   before clicking anything. Live updates the preview once the anchor is set.
2. **Click center** — sets anchor. Workflow panel adds "Drag to first vertex"
   instruction.
3. **Drag** — live preview polygon scales and rotates as the cursor moves. The
   circumscribed radius and first-vertex angle track the cursor. A radius
   dimension label follows the drag handle.
4. **Click to commit** — places the polygon. Escape at any phase cancels.
5. **D / Tab** — opens numeric entry for radius at any point after anchor is
   set; Enter commits.

**Sides field in the panel (not a stepper):** a plain `<input type="number">`
with min=3, max=50. The user types any integer in that range; the field validates
on change and clamps. This is consistent with other numeric fields in the
workflow panel and requires no new component.

### 2.2 PendingAdd state

```typescript
// Add to PendingAddTool union in src/store/types.ts
| {
    shape: 'ngon'
    anchor: Point | null   // center; null before first click
    sides: number          // default 6, range 3–50
    session: number
  }
```

Add a `setPendingNgonSides(n: number)` store action that updates `sides` in
place without resetting the session (so the anchor and any live preview survive
a sides change).

### 2.3 Geometry generation — `ngonProfile`

Wraps the existing `polygonProfile` helper:

```typescript
ngonProfile(
  cx: number, cy: number,
  n: number,
  circumradius: number,
  firstVertexAngle: number,
): SketchProfile {
  const vertices = Array.from({ length: n }, (_, i) => ({
    x: cx + circumradius * Math.cos(firstVertexAngle + (i * 2 * Math.PI) / n),
    y: cy + circumradius * Math.sin(firstVertexAngle + (i * 2 * Math.PI) / n),
  }))
  return polygonProfile(vertices)  // existing helper
}
```

`firstVertexAngle = atan2(cursor.y − anchor.y, cursor.x − anchor.x)`.

Add `ngonProfile` to `src/types/project.ts`.

### 2.4 Feature kind and storage

**Kind: `'polygon'`** — no new `FeatureKind`. A regular polygon is a closed
all-line profile; `inferFeatureKind` already returns `'polygon'` for it (it is
not axis-aligned, so it won't be mis-classified as `'rect'`). No changes to
`inferFeatureKind` needed.

**Name on commit:** derive from sides count:
```
3→"Triangle", 4→"Square", 5→"Pentagon", 6→"Hexagon",
7→"Heptagon", 8→"Octagon", 9→"Nonagon", 10→"Decagon",
11→"Hendecagon", 12→"Dodecagon"
```
Append ` ${features.length + 1}`. Fallback: `Polygon ${n} ${…}`.

### 2.5 Size mode — circumscribed only for MVP

For MVP, the drag handle is always a vertex, so the typed/dragged value is the
**circumscribed radius** (center-to-vertex distance). The radius label on the
canvas reads "R = …" (circumscribed).

For hexagons in CNC use, the "across-flats" dimension (wrench size) is useful.
Inscribed-radius / across-flats can be added as a panel mode toggle in a
follow-on; it requires only a conversion `inscribed_r = circumscribed_r * cos(π/N)`.
Deferring avoids a panel UI decision that doesn't affect the stored geometry.

### 2.6 Dimension readout during creation

After anchor is set and cursor moves:
- Draw all N polygon edges as a dashed preview profile.
- Draw a dashed radius line from anchor to the first vertex with a `R = …` label.

Reuse `drawPreviewProfile` + `drawLineLengthMeasurement`.

### 2.7 Geometry unit tests

New test file `src/types/ngon.test.ts` (or added to `project.test.ts`):

| Test | What to verify |
|------|----------------|
| Segment count | Exactly `n` line segments |
| Equilateral | All edge lengths equal to within ε |
| Circumradius | All vertices exactly `circumradius` from center |
| First vertex angle | `profile.start ≈ (cx + r·cosθ, cy + r·sinθ)` |
| Closure | Last segment `.to ≈ profile.start` |
| Area n=3 | ≈ `(3√3/4) · r²` |
| Area n=6 | ≈ `(3√3/2) · r²` |

---

## 3. Toolbar placement — second row in the shape drawer

The existing drawer is a single-row grid of shape buttons inside a portal
popover. Slot and ngon go into a **second row** within the same drawer, visible
whenever the drawer is open (not conditional on any active tool). A thin divider
or increased row gap separates the two rows.

```
Row 1 (existing):  rect | circle | ellipse | polygon | spline | composite | text
Row 2 (new):       slot | ngon
```

Implementation:

- Add a `tier: 'primary' | 'secondary'` field to each `CREATION_SHAPE_OPTIONS`
  entry. Existing shapes are `'primary'`; slot and ngon are `'secondary'`.
- `CreationActions.tsx` renders primary shapes in one `<div>` row, secondary
  in another, with a `className="toolbar-creation-drawer__secondary-row"`.
- The `gridTemplateColumns` style on the drawer already adapts to the item
  count; keep primary and secondary rows as separate flex rows instead of a
  shared CSS grid.
- No change to `lastShape` tracking in `CreationActions` — the "last used" quick
  button in the main toolbar only reflects the last-used shape regardless of
  tier.

**Icons needed:**
- `slot` — obround (pill) shape. Draw in `src/assets/icons.camj`.
- `ngon` — regular hexagon. Draw in `src/assets/icons.camj`.
- Run `npm run sync-icons` after adding icons.

---

## 4. Touch / tablet interaction

**Slot:**
- Tap 1 → P1. Panel: "Tap second end-center."
- Tap 2 → P2. Slot preview appears at initial width from cursor position.
  Panel: "Drag or tap to set width." Width button opens numeric keyboard.
- Tap 3 → commits at current live width.
- Pinch-to-zoom between steps must not consume the pending state (pointer events
  with `pointerId` tracking already handles this in `usePointerGestures`).

**Regular polygon:**
- Tap 1 → sets anchor. Panel: "Tap for radius."
- Tap 2 at a second point → commits with circumscribed radius = distance from
  anchor to tap. (Same two-tap pattern as circle on tablet.)
- Drag between tap 1 and tap 2 also works (pointer events fire on touchmove).
- Sides field is a standard `<input type="number">` — native numeric keyboard
  appears on mobile.

No new touch infrastructure needed; both tools fit the existing
`usePointerGestures` event flow.

---

## 5. Files affected

### Types

- `src/types/project.ts`
  - Add `slotProfile(p1, p2, width)` — new profile helper
  - Add `ngonProfile(cx, cy, n, circumradius, firstVertexAngle)` — new profile helper
  - *(No changes to `FeatureKind` or `inferFeatureKind`)*

### Store types

- `src/store/types.ts`
  - Extend `PendingAddTool` union with `slot` and `ngon` variants
  - Add `startAddSlotPlacement`, `startAddNgonPlacement`, `setPendingNgonSides`,
    `addSlotFeature`, `addNgonFeature` to `ProjectStore` interface

### Store slices

- `src/store/slices/pendingAddSlice.ts`
  - Implement `startAddSlotPlacement`, `startAddNgonPlacement`, `setPendingNgonSides`
  - Handle `'slot'` in `addPendingPolygonPoint` (for P2) and a new
    `placePendingSlotAt(p3)` action
  - Handle `'ngon'` in `placePendingAddAt` (anchor-drag, same as circle)

- `src/store/slices/featureSlice.ts`
  - Implement `addSlotFeature(name, p1, p2, width, depth)` → `kind: 'composite'`
  - Implement `addNgonFeature(name, cx, cy, sides, circumradius, angle, depth)`
    → `kind: 'polygon'`

### Canvas

- `src/components/canvas/manualEntry.ts`
  - Extend `DimensionEditState.shape` to include `'slot'` (fields: `width`) and
    `'ngon'` (field: `radius`)
  - For `'slot'`: `computeDimensionEditPreviewPoint` returns a point that lies
    perpendicular to the P1→P2 axis at the typed half-width distance from the
    midpoint; this drives the width commit
  - For `'ngon'`: returns a point at `(anchor + radius in current angle direction)`

- `src/components/canvas/useCreationWorkflow.ts`
  - Extend `CreationPanelShape` to include `'slot'` and `'ngon'`
  - Add slot-specific phase logic: `'start'` (waiting for P1), `'axis'` (waiting
    for P2), `'width'` (live cursor sets width → P3 commits)
  - Slot's "Width" button triggers `triggerDimensionEdit` (same path as the
    existing `triggerDimensionFromCreationPanel`)

- `src/components/canvas/previewPrimitives.ts` or `SketchCanvas.tsx`
  - Add `drawPendingSlotAxis` (during P1→P2 phase)
  - Add `drawPendingSlotWidth` (during P2→P3 phase, draws full slot profile
    live from perpendicular cursor distance)
  - Add `drawPendingNgon` (during anchor-drag phase, calls `ngonProfile`)

- `src/components/canvas/CanvasWorkflowPanel.tsx`
  - Add panel content for `'slot'` phases (start / axis / width), including the
    Width button wired to `triggerDimensionFromCreationPanel`
  - Add panel content for `'ngon'` phases (start / place), including the Sides
    `<input type="number">` field wired to `setPendingNgonSides`

### Toolbar / commands

- `src/components/layout/toolbar/shared.ts`
  - Add `tier` field to `CREATION_SHAPE_OPTIONS` entries
  - Add `slot` (`tier: 'secondary'`) and `ngon` (`tier: 'secondary'`) entries

- `src/commands/creationShapes.ts`
  - Add `slot` and `ngon` entries to `CREATION_SHAPE_OPTIONS`
  - Handle in `activateShape`

- `src/components/layout/toolbar/CreationActions.tsx`
  - Render primary and secondary rows separately in the drawer
  - Handle `onSlot` and `onNgon` callbacks in `runShapeTool`

### Icons

- `src/assets/icons.camj` — Add `slot` and `ngon` icon folders
- `public/icons.svg` — Regenerated by `npm run sync-icons`

### Tests

- `src/types/slot.test.ts` *(new)* — tests from §1.7
- `src/types/ngon.test.ts` *(new)* — tests from §2.7

---

## 6. Out of scope

- **New `FeatureKind` values** — slot stores as `'composite'`, ngon as
  `'polygon'`. No schema change, no migration needed.
- **Parametric re-edit after commit** — a committed slot or polygon is a regular
  profile; editing goes through vertex/segment drag. A "re-parametrise" panel is
  a future enhancement.
- **Inscribed-radius / across-flats size mode** — deferred; conversion is
  trivial to add as a panel toggle later.
- **Sides > 50** — capped at 50; a 50-gon is visually indistinguishable from a
  circle at any practical CNC scale. Revisit only if a specific use case arises.
- **Rounded / chamfered rectangle** — *moved into scope*; see §9 (extension).
- **Bolt-circle / hole pattern** — separate P2 work item.
- **Duplicate detection in `inferFeatureKind`** — since no new kind is added,
  no false-positive risk.

---

## 7. Remaining open questions

| # | Question | Recommendation |
|---|----------|----------------|
*All open questions resolved:*

- **Q1 (Slot Escape):** Escape at any phase cancels the entire slot tool. No partial rewind.
- **Q2 (Ngon sides range):** Free numeric entry, range **3–50**. No hard upper cap at 12.
- **Q3 (Slot minimum width):** Any value **> 0** is accepted. No tool-derived minimum. Validation rejects ≤ 0 only.

---

## 8. Open risks

- **`max-lines` ESLint guards** — `pendingAddSlice.ts` and
  `CanvasWorkflowPanel.tsx` may approach their file-line caps. Extract slot/ngon
  handlers into a `pendingSlotSlice.ts` and a helper if needed at implementation
  time; do not bump the cap.
- **`DimensionEditState.shape` union** — adding `'slot'` and `'ngon'` requires
  updating every `switch`/`if` that discriminates on `edit.shape`. At
  implementation time: `grep -r 'edit\.shape\|dimensionEdit\.shape' src/` to
  enumerate all sites before starting.
- **`CREATION_SHAPE_OPTIONS` duplication** — the array exists identically in
  both `src/components/layout/toolbar/shared.ts` and
  `src/commands/creationShapes.ts`. Keep them in sync; adding `tier` to one
  requires adding it to the other. Refactoring to a single source is out of
  scope here.

---

## 9. Extension — Rounded & Chamfered Rectangles

Added 2026-06-24. Two more secondary-tier canned shapes from the CAD-suggestions
list: a **rounded rectangle** and a **chamfered rectangle**. Packaged as **two
separate tools** (`roundrect`, `chamferrect`), mirroring the slot/ngon pattern.

### 9.1 Core insight — reuse existing corner helpers, no new geometry

`src/store/helpers/profileEdit.ts` already exports two proven pure functions
(the same ones the Sketch Edit fillet/chamfer tools use):

```typescript
applyLineCornerFillet(profile, anchorIndex, radius): SketchProfile | null
applyLineCornerChamfer(profile, anchorIndex, distance): SketchProfile | null
```

So a rounded/chamfered rectangle is **a plain rectangle composite with each
corner passed through the corresponding helper** — no new corner math, and no
involvement of the real feature "operation" pipeline. This realises the user's
"merge rectangle with fillet/chamfer into one" intent at generation time.

### 9.2 Interaction model — rect-style anchor-drag + corner-size field

Identical to the rectangle tool, plus one numeric field (like ngon's "Sides"):

1. **Tool activated** — panel shows a corner-size field: **Corner radius** for
   `roundrect`, **Chamfer** for `chamferrect` (unit-aware default, see §9.5).
2. **Click first corner** → anchor. **Drag / move** → live preview of the
   rounded/chamfered rectangle (W×H from drag delta, corner from the field).
3. **Click opposite corner** → commits. **Escape** cancels the whole tool.
4. **Dimensions button / Tab** → reuses the rect W/H numeric entry
   (`DimensionEditState.shape: 'rect'` path) for keyboard-exact W and H. The
   corner value is always set through the panel field, never the dim-edit.

### 9.3 PendingAdd state

```typescript
// Add to PendingAddTool union in src/store/types.ts
| { shape: 'roundrect';   anchor: Point | null; corner: number; session: number }
| { shape: 'chamferrect'; anchor: Point | null; corner: number; session: number }
```

`corner` is the radius (roundrect) or chamfer distance (chamferrect). A single
`setPendingRectCorner(n)` store action updates it in place without resetting the
session (same contract as `setPendingNgonSides`).

### 9.4 Geometry generation — `roundedRectProfile` / `chamferedRectProfile`

```typescript
roundedRectProfile(c1: Point, c2: Point, radius: number): SketchProfile
chamferedRectProfile(c1: Point, c2: Point, distance: number): SketchProfile
```

Both follow the same shape:

```
1. Build the base axis-aligned rect composite from opposite corners c1,c2:
   4 line segments, closed, vertices ordered CCW/CW consistently with rectProfile.
2. clamp = min(width, height) / 2; corner = min(corner, clamp - ε)   // never overlap
3. Loop applying the helper to each still-sharp corner:
     for (let i = 0; i < 4; i++) {
       const idx = firstLineLineCorner(profile)   // both adjacent segments are lines
       if (idx < 0) break
       const next = applyLineCornerFillet(profile, idx, corner)   // or ...Chamfer
       if (!next) break                                            // corner too large
       profile = next
     }
   return profile
```

**Why the loop, not a static `0..3`:** each fillet/chamfer splits a corner into
extra segments, shifting all later indices. Re-scanning for the next *line→line*
corner each pass is robust: tangent/cut junctions are line→arc or already-cut and
are skipped automatically, so exactly the 4 original corners are processed and
the loop self-terminates. The §9.2 clamp guarantees the helper never returns
`null` for a valid drag.

**Placement (layering):** these helpers must live in the **store-helper layer**,
NOT in `src/types/project.ts`. `profileEdit.ts` already imports from
`types/project`, so `project.ts` importing `applyLineCornerFillet` back would be
a circular dependency. Add `roundedRectProfile` / `chamferedRectProfile` to a new
`src/store/helpers/cannedRectProfiles.ts` (or append to `profileEdit.ts`), which
may freely import `rectProfile` from `types/project` *and* the corner helpers
from `profileEdit.ts`. (Unlike `slotProfile`/`ngonProfile`, which have no store
dependency and rightly live in `project.ts`.) The feature-creation slice imports
the new helpers from the store layer.

### 9.5 Default corner size

```
defaultCorner = units === 'mm' ? 5 : 0.2     // sensible starting value
```
Always re-clamped to `min(W,H)/2` at generation, so an aggressive corner value
on a small rectangle degrades gracefully to a stadium/half-cut shape rather than
failing.

### 9.6 Feature kind, storage, naming

- **Kind: `'composite'`** for both (rounded has arcs; chamfered is 8 lines — both
  are generic editable profiles, stored exactly like slot). No new `FeatureKind`.
- **Name on commit:** `Rounded rect ${n}` / `Chamfered rect ${n}`.
- Post-commit the profile is a normal composite, editable via vertex/segment drag.
  The corner parameter is not stored separately (re-parametrise is out of scope,
  consistent with slot/ngon).

### 9.7 Files affected (delta on top of §5)

- `src/store/helpers/cannedRectProfiles.ts` *(new)* — add `roundedRectProfile`,
  `chamferedRectProfile` (reuse `rectProfile` from `types/project` +
  `applyLineCornerFillet`/`applyLineCornerChamfer` from `profileEdit`). NOT in
  `project.ts` — see §9.4 layering note.
- `src/store/types.ts` — extend `PendingAddTool` with the two variants; add
  `startAddRoundRectPlacement`, `startAddChamferRectPlacement`,
  `setPendingRectCorner`, `addRoundRectFeature`, `addChamferRectFeature`.
- `src/store/slices/pendingAddSlice.ts` — placement starters, `setPendingRectCorner`,
  and `placePendingAddAt` handling (anchor-drag, same as rect/ngon).
- `src/store/slices/featureSlice.ts` — `addRoundRectFeature`,
  `addChamferRectFeature` → `kind: 'composite'`.
- `src/components/canvas/SketchCanvas.tsx` — `drawPendingRoundRect` /
  `drawPendingChamferRect` previews; corner-size panel input (clone of the ngon
  Sides field, `type="text" inputMode="decimal"`, commit on blur/Enter); step text.
- `src/components/canvas/useCreationWorkflow.ts` — add `'roundrect'`/`'chamferrect'`
  to `CreationPanelShape`; reuse rect dim-edit for W/H.
- `src/components/layout/toolbar/shared.ts` + `src/commands/creationShapes.ts` —
  add both as `tier: 'secondary'` (keep the two copies in sync).
- `src/components/layout/toolbar/CreationActions.tsx` + `Toolbar.tsx` +
  `CreationToolbar.tsx` — `onRoundRect` / `onChamferRect` wiring (shapeCommands[9],[10]).
- `src/assets/icons.camj` — add `roundrect`, `chamferrect` icon folders; run
  `npm run sync-icons`.
- `src/types/roundrect.test.ts` *(new)* — segment counts (rounded: 8 = 4 line +
  4 arc; chamfered: 8 line), arc radii ≈ corner, closure, clamp degrades safely,
  W/H preserved on the straight edges.

### 9.8 Toolbar second row becomes

```
Row 2 (secondary):  slot | ngon | roundrect | chamferrect
```

### 9.9 Out of scope (this extension)

- Per-corner radii / selective corner rounding — uniform all-corners only.
- Typed corner entry through the dim-edit flow — corner is the panel field only.
- Mixed (some rounded, some chamfered) — that's manual Sketch Edit, not a canned
  shape.
