# V-Carve Implementation Plan

Status legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete

## What V-Carving Is

V-carving uses a V-shaped bit (fixed included angle, e.g. 60° or 90°) to engrave text or artwork. Unlike `follow_line` which traces a centerline at a fixed depth, V-carving varies the plunge depth continuously so that the cutting edges of the bit exactly touch the boundary walls of the region being carved. The result: narrow strokes get a shallow, fine cut; wide strokes get a deep cut; the surface appearance closely resembles hand-engraved lettering.

The depth-at-a-point relationship is:

```
depth = half_width / tan(half_angle)
```

Where `half_width` is the distance from the medial axis point to the nearest boundary, and `half_angle` is half the included angle of the V-bit.

This is fundamentally different from `follow_line` and requires its own toolpath generator.

---

## Relationship to Existing Operations

| Operation       | Input geometry | Depth control        | Tool type |
|-----------------|---------------|----------------------|-----------|
| `follow_line`   | open or closed profile | fixed depth from op | any |
| `pocket`        | closed profile | constant Z per pass  | flat/ball |
| `v_carve`       | closed profiles (glyphs, artwork outlines) | variable depth from medial axis | V-bit only |

V-carve is a new operation kind that targets **closed profiles** representing the boundary of strokes or artwork regions. It does not clear flat floors — it leaves a prismatic, V-shaped cross-section whose width follows the geometry.

---

## Scope

### Included in first pass
- New `v_carve` operation kind
- V-bit-only validation
- Contour-parallel variable-depth carving using inward offsets
- Sketch overlay and 3D linework visualization
- Simulation support using the existing V-bit surface model
- Operation validation and user-facing warnings

### Explicitly excluded from first pass
- Full straight-skeleton / medial-axis solving
- Combination V-carve + pocket clearing (for very wide regions where the bit cannot reach full width)
- Multi-pass V-carve (roughing + finish)
- Inlay V-carving (complementary male/female V-carve pairs)
- 3D relief carving
- Automatic font-to-V-carve workflow (text features already generate closed outlines; they can be targeted manually)

---

## Key Design Decisions

### 1. Input is closed outline profiles, not centerlines

V-carve works from the **boundary** of what is to be carved, not from a drawn centerline. The user authors (or imports) the closed outline of each letter or artwork region, and the algorithm derives the skeleton automatically.

This is consistent with how `outline` text features already work — they produce closed profiles that define the stroke boundary. Those features can be V-carved directly.

Implication: the user does not draw the carving path. They draw the region. The medial axis is computed, not authored.

### 2. First pass uses contour-parallel offsets, not a skeleton solver

The long-term ideal is medial-axis / straight-skeleton V-carving. However, the first shippable implementation should reuse the existing pocket inset engine:

- resolve the target region as closed polygons with holes
- generate inward offset contours
- assign each contour a depth based on its offset distance from the boundary
- stop when the region collapses or the maximum carve depth is reached

This produces a practical first-pass V-carve for text and artwork without introducing a large new geometry solver up front.

### 3. Depth clamped by V-bit geometry

The depth computed from the medial axis radius must be clamped:

- **Minimum depth:** `tipDiameter / 2 / tan(halfAngle)` — the depth at which the tip flat starts cutting. Below this, the bit is cutting with its flat tip, not its V flanks. This depth is the shallowest useful V-carve depth. If the computed depth is less than this, either skip the segment or carve at minimum depth.
- **Maximum depth:** the operation's `maxCarveDepth` parameter, which the user sets based on material and machine capability. If the computed depth exceeds this, use flat-bottom clearance (outside first-pass scope).

### 4. Toolpath follows inward offset contours in phase 1

For phase 1:

- each inward offset contour is cut at a Z derived from the offset distance
- the sequence progresses from shallow outer contours toward deeper inner contours
- rapids link disconnected contours as in pocketing

Phase 2 can replace this with true skeleton traversal once a robust straight-skeleton implementation exists.

### 5. One operation can target multiple features

Like `pocket` and `follow_line`, `v_carve` should accept multiple target features in a single operation. Each target feature is skeletonized independently. The toolpath sequences them with rapids between.

### 6. V-bit is already a supported tool type, but V-carve uses it differently

The codebase already has `v_bit` as a tool type with an included angle. Phase 1 should:

- require `v_bit` tools for `v_carve`
- use the included angle to convert offset distance into carve depth
- treat the current V-bit definition as sharp-tip for toolpath generation

Tip diameter support can be added later as a refinement.

---

## Data Model Additions

### Operation kind

Add:
```ts
'v_carve'
```

### Operation parameters

```ts
interface VCarveOperationParams {
  kind: 'v_carve'
  targetFeatureIds: string[]
  toolId: string                // must resolve to a VBitTool
  maxCarveDepth: number         // user safety cap, mm
  stepover: number              // reused as contour spacing control
  feedRate?: number             // override tool default
  plungeRate?: number           // override tool default
  rpm?: number                  // override tool default
}
```

### Transient result type

V-carve generates a `ToolpathResult` (existing type) with moves typed as `'cut'`, `'rapid'`, and `'plunge'`. No new move kinds needed. The Z coordinate of each cut move encodes the variable depth naturally.

---

## Phase 1 Algorithm: Contour-Parallel V-Carve

Phase 1 reuses the pocket offset approach:

### Input
A simple polygon with optional holes (islands), represented as a list of vertices after profile flattening. Winding: outer boundary CCW, holes CW (Clipper convention).

### Preprocessing
1. Flatten all sketch profile segments (lines and arcs) to polyline approximations at a configurable chord tolerance (default: 0.01 mm).
2. Ensure consistent winding using Clipper's orientation utilities.
3. Remove degenerate edges (zero length, collinear triples).

### Core contour-offset computation

1. Resolve the closed target region with holes using the existing pocket-like region resolver.
2. Generate inset contours at repeated spacing intervals.
3. For each inset distance `d`, compute:

```ts
depth = d / tan(halfAngle)
z = topZ - min(depth, maxCarveDepth)
```

4. Emit contour-following cut moves at that Z.
5. Stop when:
   - no further inset contours exist, or
   - the computed depth exceeds `maxCarveDepth`.

### Depth mapping

For each skeleton node:
```ts
const halfAngleRad = (tool.includedAngleDeg / 2) * Math.PI / 180
const rawDepth = node.radius / Math.tan(halfAngleRad)
const depth = Math.min(rawDepth, op.maxCarveDepth)
const z = feature.z_top - depth
```

---

## Engine Architecture

Phase 1 should add one top-level generator under `src/engine/toolpaths/`:

### `vcarve.ts`
- `generateVCarveToolpath(project: Project, operation: Operation): ToolpathResult`
- Reuses:
  - pocket region resolution
  - inset contour generation
  - safe-Z rapid/plunge helpers

Phase 2 can split out:
- `vcarve/skeleton.ts`
- `vcarve/depth.ts`
- `vcarve/traverse.ts`

---

## Validation Rules

### Operation-level validation

- Target features must be closed profiles. Open profiles are rejected with a clear message.
- Tool must be `v_bit` kind. Other tool kinds rejected.
- `maxCarveDepth` must be positive.
- `maxCarveDepth` must not exceed stock bottom Z.
- Warn if any target feature produces a skeleton with all radii below the tip minimum (nothing useful will be carved).

### Per-feature warnings

- Warn if the feature polygon is very thin (all skeleton radii near zero) — likely a degenerate or zero-width outline.
- Warn if `maxCarveDepth` clips a significant portion of the inset sequence — suggests the user may want a complementary pocket clear pass.

---

## UI / Workflow

### Tool library
- Add V-bit as a new tool kind in the tool library UI.
- Required fields: included angle, tip diameter, shank diameter.
- Common presets: 60°, 90° sharp-tip bits.

### CAM panel — V-carve operation
- Operation kind: `V-Carve`
- Target: one or more closed features
- Tool: V-bit only (other tools grayed out or hidden)
- Max carve depth (mm)
- Feed rate / plunge rate / RPM (with tool defaults prefilled)
- Safe Z

### Sketch overlay
- Show skeleton graph as a dim overlay when the V-carve operation is selected.
- Show the actual toolpath (variable-depth moves projected to XY) in the standard operation path color.
- Rapid moves shown as dashed lines.

### 3D view
- Show toolpath moves as 3D linework at their actual Z depths.
- The V-shaped cross-section is visible in simulation, not as static linework.

### Simulation
- Replay V-carve moves using the V-bit tool shape.
- The simulation voxel removal should use the conical tool profile at the given depth to carve the correct V-shaped trench cross-section.
- First pass: approximate with the flat-endmill fallback at the max depth of each move; flag as approximate in the UI.

---

## Implementation Phases

### VC1. V-bit tool type
- `[ ]` Add `v_bit` to the tool kind union
- `[ ]` Add `VBitTool` interface with included angle and tip diameter
- `[ ]` Add V-bit creation in the tool library UI
- `[ ]` Add common presets (60°, 90°)

### VC2. `v_carve` operation schema and UI
- `[ ]` Add `v_carve` to operation kind union
- `[ ]` Add `VCarveOperationParams` with all fields
- `[ ]` Surface operation controls in CAM panel
- `[ ]` Validation: reject non-v-bit tools, reject open profiles, enforce depth range

### VC3. Profile flattening and polygon preparation
- `[ ]` Flat polygon extraction from closed sketch profiles (reuse / extend existing geometry helpers)
- `[ ]` Winding normalization (outer CCW, holes CW)
- `[ ]` Degenerate edge removal

### VC4. Straight skeleton computation
- `[ ]` Implement `skeleton.ts` — straight skeleton from simple polygon
- `[ ]` Handle convex polygons (no split events)
- `[ ]` Handle reflex vertices (split events)
- `[ ]` Handle polygons with holes
- `[ ]` Unit tests for known shapes: rectangle → cross skeleton, equilateral triangle → centroid

### VC5. Depth assignment
- `[ ]` Implement `depth.ts`
- `[ ]` Clamp to tip minimum and `maxCarveDepth`
- `[ ]` Emit warnings when clamping is significant

### VC6. Skeleton traversal and toolpath generation
- `[ ]` Implement `traverse.ts` — depth-first graph walk
- `[ ]` Insert rapid moves between branches
- `[ ]` Implement `vcarve.ts` — top-level orchestrator
- `[ ]` Multi-feature sequencing with rapids between features

### VC7. View integration
- `[ ]` Sketch overlay: skeleton ghost + toolpath moves
- `[ ]` 3D linework at correct Z depths

### VC8. Simulation integration
- `[ ]` Replay V-carve moves in simulation
- `[ ]` First-pass approximation with flat-endmill fallback
- `[ ]` Mark simulation as approximate when V-bit shape is not yet modeled

### VC9. G-code output
- `[ ]` Verify existing G-code emitter handles variable-Z cut moves correctly (it should; it is move-based)
- `[ ]` Confirm rapid/plunge/cut sequencing matches V-carve toolpath move structure
- `[ ]` Add V-bit tool comment block in G-code header

---

## Risks and Edge Cases

### Straight skeleton complexity
The straight skeleton algorithm is non-trivial to implement robustly due to numerical precision at near-coincident events. Consider using an epsilon tolerance for event merging. Robust open-source implementations exist (e.g. CGAL's straight skeleton, or the `polygon-skeletonize` JS library) — evaluate whether to adapt one rather than implementing from scratch.

### Very thin or zero-width regions
Skeleton radii near zero produce near-zero depth. These branches should be omitted from the toolpath or clamped to the minimum tip depth. Do not attempt to carve regions smaller than the tip diameter.

### Concave polygon holes
When the target feature has interior islands (added `add` features overlapping a subtract feature), the carved region is the `subtract` area minus the `add` islands. The skeleton must treat island boundaries as interior holes. This requires the polygon-with-holes skeleton, not just the simple polygon variant.

### Long skeleton branches in wide regions
In very wide strokes, the skeleton center depth will exceed `maxCarveDepth`. All nodes there are clamped. The toolpath will still be generated but the carve floor will be flat, not V-shaped, in those wide areas. This is the expected behavior for the first pass. The correct solution (flat pocket pre-clearing) is a later feature.

### Performance
Straight skeleton computation is O(n log n) in the vertex count. For typical engraving text this is fast. For artwork with many vertices, the flattened polygon may be large. Profile the skeleton computation for a 500-vertex polygon and set a practical vertex budget.

---

## Recommended Build Order

1. VC1 — V-bit tool type (small, unlocks everything else)
2. VC2 — operation schema and UI (unblocks testing)
3. VC3 — polygon preparation (reuse existing geometry helpers where possible)
4. VC4 — straight skeleton (core algorithm; bulk of the work)
5. VC5 — depth assignment (small, depends on VC4)
6. VC6 — traversal and toolpath generation (depends on VC4, VC5)
7. VC7 — view integration (depends on VC6)
8. VC8 — simulation (depends on VC6; first pass can be approximate)
9. VC9 — G-code output (verify existing emitter; likely minimal work)

---

## Exit Criteria

The first pass is done when:
- User can define a V-bit tool with included angle and tip diameter
- User can create a `V-Carve` operation targeting one or more closed features
- The medial axis skeleton is computed and variable-depth toolpath is generated
- Toolpath is visible in sketch and 3D views
- Simulation replays the V-carve moves (approximate is acceptable for first pass)
- Validation clearly rejects open profiles and non-V-bit tools
- G-code export includes the V-carve moves with correct Z depth variation
