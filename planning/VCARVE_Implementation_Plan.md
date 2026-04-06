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

### Included in the robust implementation target
- New `v_carve` operation kind
- Separate contour-parallel fallback operation for comparison and temporary use only
- V-bit-only validation
- True geometric medial-axis / straight-skeleton solving for the main V-carve path
- Sketch overlay and 3D linework visualization
- Simulation support using the existing V-bit surface model
- Operation validation and user-facing warnings

### Explicitly excluded from this milestone
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

### 2. Contour-parallel V-carve is a fallback, not the end state

The existing contour-parallel implementation is useful as a temporary fallback and as a validation reference, but it is not the desired end state:

- resolve the target region as closed polygons with holes
- generate inward offset contours
- assign each contour a depth based on its offset distance from the boundary
- stop when the region collapses or the maximum carve depth is reached

This approach is acceptable only as a temporary shipping aid. It is too busy, requires overly tight spacing for high-quality text, and is not the operation we should ultimately market as V-carving. The primary implementation target is a robust geometric skeleton solver.

### 3. Depth clamped by V-bit geometry

The depth computed from the medial axis radius must be clamped:

- **Minimum depth:** `tipDiameter / 2 / tan(halfAngle)` — the depth at which the tip flat starts cutting. Below this, the bit is cutting with its flat tip, not its V flanks. This depth is the shallowest useful V-carve depth. If the computed depth is less than this, either skip the segment or carve at minimum depth.
- **Maximum depth:** the operation's `maxCarveDepth` parameter, which the user sets based on material and machine capability. If the computed depth exceeds this, use flat-bottom clearance (outside first-pass scope).

### 4. Main toolpath follows the geometric skeleton, not repeated offsets

The main `V-Carve` operation should:

- compute a geometric medial graph from the closed region
- assign each branch node a local half-width and therefore a carve depth
- traverse that graph with sensible rapid/plunge behavior between disconnected branches

The contour-parallel variant remains available only as:
- a temporary fallback
- a visual/debug comparison against the true solver
- an escape hatch while the geometric implementation is being hardened

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

Maintain:
```ts
'v_carve'
```

Temporary comparison/fallback:
```ts
'v_carve_skeleton'
```

### Operation parameters

```ts
interface VCarveOperationParams {
  kind: 'v_carve'
  targetFeatureIds: string[]
  toolId: string                // must resolve to a VBitTool
  maxCarveDepth: number         // user safety cap, mm
  stepover: number              // contour spacing for fallback op; will become skeleton/path tolerance for the robust op
  feedRate?: number             // override tool default
  plungeRate?: number           // override tool default
  rpm?: number                  // override tool default
}
```

### Transient result type

V-carve generates a `ToolpathResult` (existing type) with moves typed as `'cut'`, `'rapid'`, and `'plunge'`. No new move kinds needed. The Z coordinate of each cut move encodes the variable depth naturally.

---

## Robust Solver Target: Clipper-Topology Skeleton Extraction

The robust target is no longer the contour-parallel solver, and it is no longer the current analytical wavefront prototype. The target is a Clipper-driven topology solver that extracts a usable medial graph from a sequence of absolute inward offsets.

### Input
A simple polygon with optional holes (islands), represented as a list of vertices after profile flattening. Winding: outer boundary CCW, holes CW (Clipper convention).

### Preprocessing
1. Flatten all sketch profile segments (lines and arcs) to polyline approximations at a configurable chord tolerance (default: 0.01 mm).
2. Ensure consistent winding using Clipper's orientation utilities.
3. Remove degenerate edges (zero length, collinear triples).

### Core robust solve

1. Resolve the closed target region with holes using the existing pocket-like region resolver.
2. Generate a sequence of absolute inward Clipper offsets from the original region.
3. Match contours between consecutive offset frames and detect topology events:
   - split: one contour becomes multiple contours
   - collapse: a contour disappears
   - merge around holes: outer and hole-driven regions meet
4. Convert those events into a medial graph whose nodes/edges carry local boundary distance.
5. For each graph point, compute:

```ts
depth = distanceToBoundary / tan(halfAngle)
z = topZ - min(depth, maxCarveDepth)
```

6. Traverse the resulting graph into cuttable toolpath branches.

### Why this path replaces the analytical solver

The current analytical wavefront solver is blocked on:
- simultaneous event timing
- event-node merging
- ring rebuild correctness after split/collapse

Clipper offsetting is already the most reliable polygon engine in this repo. Using it to detect topology evolution gives us:
- robust integer-geometry offsets
- natural hole/counter handling
- no floating-point event queue as the core source of truth

The tradeoff is approximation to the chosen offset step size, which is acceptable so long as it stays below machining tolerance.

### Temporary fallback algorithm

The contour-parallel offset solver remains in the codebase as a fallback/comparison tool:

1. Resolve the closed target region with holes using the existing pocket-like region resolver.
2. Generate inset contours at repeated spacing intervals.
3. For each inset distance `d`, compute:

```ts
depth = d / tan(halfAngle)
z = topZ - min(depth, maxCarveDepth)
```

4. Emit contour-following cut moves at that Z.

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

### Main robust path

`src/engine/toolpaths/vcarve.ts`
- `generateVCarveToolpath(project: Project, operation: Operation): ToolpathResult`
- orchestrates the robust solver

Suggested split:
- `vcarve/geometry.ts`
- `vcarve/clipperSkeleton.ts`
- `vcarve/depth.ts`
- `vcarve/traverse.ts`

The current `vcarve/skeleton.ts` analytical solver remains in the tree only as an experimental reference path until the Clipper topology solver replaces it.

### Temporary fallback path

`src/engine/toolpaths/vcarveParallel.ts` or existing fallback generator
- contour-parallel inset solver
- retained temporarily for side-by-side validation

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

### Temporary comparison mode
- Keep `V-Carve Parallel` / fallback visible only while the robust solver is being validated.
- Once the geometric solver is trusted, retire the fallback or hide it behind an advanced/debug flag.

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

### Current state
- `[x]` Contour-parallel fallback `v_carve` is implemented and usable.
- `[~]` Experimental centerline attempts have been explored and rejected as not good enough.
- `[ ]` Robust geometric medial-axis / straight-skeleton `v_carve` remains the actual unfinished implementation target.

### VC1. V-bit tool type
- `[x]` Add `v_bit` to the tool kind union
- `[x]` Add `VBitTool` interface with included angle and tip diameter
- `[x]` Add V-bit creation in the tool library UI
- `[ ]` Add common presets (60°, 90°)

### VC2. `v_carve` operation schema and UI
- `[x]` Add `v_carve` to operation kind union
- `[x]` Add `VCarveOperationParams` with all fields
- `[x]` Surface operation controls in CAM panel
- `[x]` Validation: reject non-v-bit tools, reject open profiles, enforce depth range

### VC3. Profile flattening and polygon preparation
- `[~]` Flat polygon extraction from closed sketch profiles (reuse / extend existing geometry helpers)
- `[~]` Winding normalization (outer CCW, holes CW)
- `[~]` Degenerate edge removal

### VC4. Geometric skeleton computation
- `[~]` Initial wavefront data structures and event geometry extracted into dedicated `vcarve/` modules
- `[~]` `skeleton.ts` foundation in progress — active wavefront state, direct adjacent-edge collapse timing, split-event candidate detection, ring rebuild/split scaffolding, collapse-node cleanup, and a raised iteration budget exist
- `[~]` Handle convex polygons cleanly
- `[~]` Handle reflex vertices and split events
- `[~]` Handle polygons with holes
- `[ ]` Unit tests for known shapes: rectangle → cross skeleton, equilateral triangle → centroid, serif `r` / `k` style glyph branching
- `[ ]` Reject solver output that misses expected terminal corner branches or produces internal illegal crossings

### VC5. Depth assignment
- `[~]` `depth.ts` foundation in progress — radius-to-depth mapping and branch sampling helpers exist
- `[x]` Clamp to `maxCarveDepth`
- `[ ]` Clamp to tip minimum
- `[ ]` Emit warnings when clamping is significant

### VC6. Skeleton traversal and toolpath generation
- `[~]` `traverse.ts` foundation in progress — skeleton graph to branch polyline conversion exists
- `[~]` Branch-to-move conversion helper exists with conservative rapid/plunge sequencing
- `[~]` Internal geometric pipeline helper exists (`prepare -> solve -> cleanup -> branch sampling -> moves`)
- `[~]` Internal top-level geometric orchestrator exists and is now wired into the experimental `v_carve_skeleton` path for live testing
- `[~]` Branches now sort by descending max radius for more sensible traversal order
- `[~]` Smoke harness now verifies rectangle / triangle / circle-like convex cases; circle-like collapse is now a single center-node cut internally, but reflex branching is still incorrect
- `[ ]` Implement `vcarve.ts` — top-level robust orchestrator
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
The straight skeleton algorithm is non-trivial to implement robustly due to numerical precision at near-coincident events. Use explicit epsilon handling for event merging and edge collapse. For this repo, assume we are implementing this ourselves on top of existing polygon/Clipper infrastructure rather than depending on an external library.

### Rejected approximations
The following approaches are specifically not considered acceptable end-state solutions for CAMCAM V-carving:
- coarse raster thinning / image skeletonization
- contour-parallel paths presented as the primary V-carve mode
- triangulation dual-graph approximations that create illegal interior crossings

These may be useful as temporary debugging aids, but they are not robust enough for the product we want to ship.

### Very thin or zero-width regions
Skeleton radii near zero produce near-zero depth. These branches should be omitted from the toolpath or clamped to the minimum tip depth. Do not attempt to carve regions smaller than the tip diameter.

### Concave polygon holes
When the target feature has interior islands (added `add` features overlapping a subtract feature), the carved region is the `subtract` area minus the `add` islands. The skeleton must treat island boundaries as interior holes. This requires the polygon-with-holes skeleton, not just the simple polygon variant.

### Long skeleton branches in wide regions
In very wide strokes, the skeleton center depth will exceed `maxCarveDepth`. All nodes there are clamped. The toolpath will still be generated but the carve floor will be flat, not V-shaped, in those wide areas. This is the expected behavior for the first pass. The correct solution (flat pocket pre-clearing) is a later feature.

### Performance
The robust geometric solver must still be practical for text and imported artwork. Profile on:
- 500-vertex glyph or logo region
- multi-letter outline text
- polygon-with-holes examples

Do not accept a solution that requires coarse rasterization or silent internal resolution relaxation to finish.

---

## Recommended Build Order

1. VC3 — polygon preparation hardening
2. VC4 — geometric skeleton core algorithm
3. VC5 — depth assignment
4. VC6 — traversal and toolpath generation
5. VC7 — view integration
6. VC8 — simulation
7. VC9 — G-code output
8. retire or hide the contour-parallel fallback once the robust solver is trusted

---

## Exit Criteria

This work is done when:
- User can define a V-bit tool with included angle and tip diameter
- User can create a `V-Carve` operation targeting one or more closed features
- The geometric medial-axis / straight-skeleton is computed and variable-depth toolpath is generated
- Toolpath is visible in sketch and 3D views
- Simulation replays the V-carve moves (approximate is acceptable for first pass)
- Validation clearly rejects open profiles and non-V-bit tools
- G-code export includes the V-carve moves with correct Z depth variation
- The result is good enough on serif text and outline artwork that the contour-parallel fallback is no longer the preferred path
- The robust solver handles realistic text/artwork without requiring hidden internal resolution relaxation or visibly incorrect branch behavior
