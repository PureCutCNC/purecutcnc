# CAM App — Requirements & Design Document

> **Status:** Pre-development spec  
> **Scope:** 2.5D CAM with full 3D view-only preview, designed for 3-axis mill/router  
> **Last updated:** 2026-03-24 — POC scope defined; build phases restructured around POC-first approach

---

## 1. Vision

A parametric sketch-based CAM application for 2.5D CNC machining. The primary innovation is collapsing the traditional sketch → feature operation two-step (as in Fusion 360) into a single step — sketch entities carry their own volumetric intent (add/subtract, depth). AI is a first-class citizen via MCP tool calls, not just a text box.

Target users: hobbyists, small shops, makers who need more than Carbide Create but don't want the complexity of Fusion 360's CAM module.

---

## 2. Core Design Decisions

### 2.1 Feature = Mini Sketch + Volumetric Intent (Parametric CSG)

Each feature is a self-contained mini sketch — a single closed profile of arbitrary complexity — combined with volumetric intent:

- **Subtract** — removes material (pocket, hole, profile cut)
- **Add** — adds material above stock surface (boss, raised pad)

```
Feature = Sketch (single closed profile)  +  operation (add/subtract)  +  z_top  +  z_bottom
```

Every feature carries its own sketch with local dimensions and constraints. The sketch can be as simple as a circle or as complex as an imported DXF profile — the structure is identical either way.

**One feature = one closed profile.** No nesting, no islands embedded inside features. If a pocket contains a standing boss, that is two separate features — the CSG evaluation of the feature tree resolves the geometry correctly without any special island handling.

The feature tree is evaluated as a CSG (Constructive Solid Geometry) sequence — later entries override earlier ones at their XY footprint. Island/hole geometry emerges naturally from the boolean evaluation; winding direction (CCW = outer boundary, CW = inner boundary) is a property of the resolved output, handled automatically by `clipper.js`.

This is closer to how machinists think than the sketch→extrude→cut workflow in traditional CAD, and more integrated than Fusion 360's approach — volumetric intent lives directly in the sketch rather than in a separate feature operation step.

**Stock boundary** follows the same rule — it is also a closed profile, not just a width/height pair. Default stock is a rectangular profile but any shape is valid (casting blanks, pre-cut stock, irregular plate).

The app's internal 2D project space is an implementation detail, chosen to make
sketch interaction and canvas rendering straightforward. It is not the
user-facing machining coordinate system. As stock becomes fully profile-based,
the internal top-left of project space will not necessarily coincide with any
meaningful "corner" of the stock. User-facing CAM setup therefore must not rely
on exposing those raw internal coordinates.

**CAM origin** is a separate setup object placed visually on the sketch. It
defines machine zero for export and simulation, but it does not redefine the
internal project coordinate system. Export is responsible for converting from
internal project space into machine space.

### 2.2 Parametric Dimensions

Any depth or dimension value can be a literal number or a reference to a named dimension. Named dimensions support formulas:

```
pocket_depth = stock_thickness - 3
hole_spacing = 15
```

Change `stock_thickness` and all dependent features update automatically.

### 2.3 Feature Tree as Source of Truth

The feature tree drives everything downstream:

```
Feature Tree
  ├── clipper.js      → 2D canvas (sketch view)
  ├── manifold WASM   → Three.js  (3D view)
  ├── CAM engine      → toolpaths → G-code
  └── MCP server      → AI agent
```

Nothing writes back to the feature tree except the sketch tools and AI agent.

### 2.4 AI via MCP Tool Calls (Agentic)

The CAM engine is exposed as an MCP server. The AI calls tools, receives results, and can make multiple coordinated changes in one conversation turn. This is fundamentally different from text-to-JSON generation — Claude is an agent with real-time feedback.

### 2.5 Multi-Provider AI

A provider abstraction layer supports any model backend. Weaker local models gracefully fall back to JSON mode.

### 2.6 Unified Three.js Scene

One Three.js scene serves both the 3D preview and simulation. Mode switching is layer visibility changes, not scene rebuilds.

### 2.7 3D View is View-Only

No 3D modeling. The 3D representation is derived from the feature tree via CSG evaluation (manifold WASM). It updates live but users cannot edit in 3D — all editing happens in the 2D sketch view.

---

## 3. UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Toolbar (tools, units, grid, snap, zoom, save/load)        │
├──────────────┬──────────────────────┬───────────────────────┤
│              │                      │                       │
│  AI Chat     │   2D Sketch Canvas   │  Operations Panel     │
│  Panel       │   (primary view)     │  (tool, feed, depth)  │
│              │                      │                       │
├──────────────┴──────────────────────┴───────────────────────┤
│  Feature Tree Panel  (ordered, draggable, color coded)      │
└─────────────────────────────────────────────────────────────┘

Secondary views (toggle/collapsible):
  - 3D Preview panel (side panel or floating)
  - Simulation (full canvas takeover)
  - G-code export (dialog only, not persistent panel)
```

### Panels

| Panel | Purpose |
|---|---|
| AI Chat | Natural language input, conversation history |
| 2D Sketch Canvas | Primary drawing/editing surface |
| Operations Panel | Per-feature machining config (tool, feed, depth, passes) |
| Feature Tree | Ordered list of features, drag to reorder, visibility/lock |
| 3D Preview | View-only CSG solid derived from feature tree |
| Simulation | Voxel material removal playback |

---

## 4. Feature List

### 4.1 Sketch Geometry

Every feature boundary is a **single closed profile** — an ordered sequence of segments where each segment is a line or an arc:

```typescript
type Segment =
  | { type: 'line'; to: Point }
  | { type: 'arc'; to: Point; center: Point; clockwise: boolean }

interface Profile {
  segments: Segment[]   // closed — last segment ends at first point
  origin: Point         // position on stock
}
```

Primitive shapes are convenience constructors that produce a `Profile` — they are not a separate type:

```typescript
Profile.fromRect(x, y, w, h)
Profile.fromCircle(cx, cy, r)
Profile.fromRoundedRect(x, y, w, h, r)
Profile.fromPolygon(points[])
```

**Profile editing on canvas** — selecting a feature exposes its nodes directly:
- Drag nodes to reposition
- Arc segments show center handle
- Click segment to insert node
- Right-click segment to toggle line ↔ arc
- Drag corner node inward to fillet (generates arc segment)

**Sketch edit mode** — double-click a feature to enter its mini sketch. All other features dim, local dimensions and constraints are shown, sketch tools activate. Press Escape or Done to return to main view.

**Open profiles** — valid only for engrave operations (follow a path without needing closure).

**Bolt circle pattern** — generates N drill features arranged on a radius. Each hole is its own feature in the tree.

**Construction geometry** — reference lines/arcs visible on canvas, not machined, not serialized as features.

### 4.2 Constraints & Dimensions

**Two scopes:**

- **Local** — live inside a feature's mini sketch. Control the shape geometry: side lengths, radii, angles, fillets, internal symmetry.
- **Global** — live at project level, reference feature IDs. Control relationships between features: concentric, equidistant, symmetric about stock center.

**Local constraint types:**
- Horizontal / vertical lock
- Equal length / radius
- Tangent (line to arc, arc to arc)
- Dimension (fix length, angle, radius to exact value)
- Fillet (corner radius)

**Global constraint types:**
- Concentric (two features share center)
- Equal spacing (row of features equidistant)
- Symmetric about axis
- Coincident edge / point

**Named dimensions (parametric):**
- Any depth or sketch dimension can reference a named variable
- Named variables support formulas: `pocket_depth = stock_thickness - 3`
- Changing a variable propagates to all referencing features instantly
- Available at both local sketch level and global project level

**v1 scope:** Local constraints + named dimensions. Global constraints in a later phase.

Constraint solver via library (evaluate `sketch-solver`, `planck.js`, or custom numeric solver — see Open Questions).

### 4.3 Drawing Tools (Toolbar)

| Tool | Notes |
|---|---|
| Select / Move | Click + drag |
| Rectangle | Click-drag or exact dimensions |
| Circle | Center+radius or 3-point |
| Line / Polyline | Slots, open profiles |
| Arc | 3-point |
| Drill point | Click to place |
| Bolt circle | N holes on radius |
| Dimension | Annotate + constrain |
| Text engrave | Toolpath from text |

### 4.4 Machining Operations

- Profile (outside / inside / on-line)
- Pocket (with island support)
- Drill (peck, full depth)
- Facing (stock surface flattening)
- Engrave (follow path at fixed depth)
- Roughing + finishing passes
- Tabs on profile operations
- Clamp placement + collision detection

### 4.5 Tabs

- Count, width, height parameters
- Auto distribution (evenly spaced, biased away from corners)
- Manual placement (drag on canvas)
- Stored as perimeter position 0–1 (coordinate-independent)
- AI-controllable ("add tabs on long sides only")

### 4.6 Clamps

- Types: step clamp, toe clamp, vacuum zone, vise jaw
- Placed as objects on canvas (their own layer)
- Collision detection against toolpaths — flagged on operation card
- Saved in project file, never generate G-code
- AI-placeable ("step clamps on left and right edges, 40mm in")

### 4.7 Import

| Format | Method |
|---|---|
| SVG | Parse path/rect/circle elements, convert to geometry JSON |
| DXF | `dxf-parser` library, map entities to geometry schema |
| STL | Slice at Z levels → closed polygons → features (AI classifies) |
| STEP | `opencascade.js` WASM (later) |
| Image trace | AI-assisted outline extraction (stretch goal) |

All imports convert to the internal `.camj` geometry schema. Parsers are adapters — the rest of the app never knows the source.

### 4.8 3D Preview

- Derived from feature tree via `manifold` WASM CSG evaluation
- View-only — no editing in 3D
- Updates live (debounced 150ms)
- Depth color mapping (shallow → deep, blue family; add → green; through → red tint)
- Camera presets: top, front, right, isometric
- Toggleable layers: stock, features, toolpaths, clamps, tool

### 4.9 Simulation

- Three.js voxel-based material removal
- Adaptive voxel resolution (coarse during scrub, fine for final render)
- Web Worker for subtraction math (keeps UI thread free)
- Tool mesh animated along toolpath
- Tool visually correct per type (flat endmill vs ball vs drill)
- Playback controls: play/pause/stop, speed multiplier, scrub
- Tab and clamp overlay during playback
- Screenshot + video export

### 4.10 G-code Export

- Available via Export dialog only (not a persistent panel)
- Machine flavor selection: Grbl, LinuxCNC, Mach3
- Post-processor system (extensible for custom machines)
- Preview with syntax highlighting in dialog
- Download `.nc` file
- Uses the currently placed CAM origin as machine zero
- Does not expose raw internal project coordinates in the export UI

---

## 5. AI Integration

### 5.1 Architecture — MCP Tool Calls

The CAM engine is exposed as an in-process MCP server. The AI agent loop:

```
User message
  → Claude API with tool definitions
  → Claude calls tools
  → App executes, returns results
  → Claude calls more tools or returns final answer
  → Loop until stop_reason != 'tool_use'
```

### 5.2 MCP Tool Categories

```
Sketch:      create_feature, update_feature, delete_feature, list_features
             add_segment, update_segment, delete_segment
             enter_sketch_mode, exit_sketch_mode
Operations:  create_operation, update_operation, reorder_operations, list_operations
Stock:       set_stock, set_stock_profile, get_stock
Tools:       add_tool, list_tools, update_tool
Dimensions:  set_dimension, set_dimension_formula, list_dimensions
Constraints: add_local_constraint, add_global_constraint, list_constraints, check_conflicts
Clamps:      place_clamp, list_clamps, check_collisions
Simulation:  run_simulation, get_simulation_result
Project:     get_project_state, validate_project, estimate_machining_time
```

### 5.3 Multi-Provider Support

```
AIProvider (abstract)
  ├── AnthropicProvider      → api.anthropic.com
  ├── OpenAIProvider         → api.openai.com
  └── OpenAICompatibleProvider → custom endpoint
        ├── Ollama           → http://localhost:11434
        ├── LM Studio        → http://localhost:1234
        ├── Groq, Together   → remote OpenAI-compatible
        └── any other
```

Provider config stored in `localStorage` (API keys, endpoint, model). Never stored in project file.

### 5.4 Model Capability Tiers

| Tier | Behaviour | Example Models |
|---|---|---|
| `full_agent` | MCP tool calls, full agentic loop | Claude Sonnet/Opus, GPT-4o, Llama 3.1 70B |
| `json_only` | Returns geometry JSON, app parses | Llama 3.1 8B, Mistral 7B |
| `text_only` | Describes changes, user applies | Very small models |

Graceful fallback — weaker models don't break the app.

---

## 6. Project File Format — `.camj`

```json
{
  "version": "1.0",
  "meta": {
    "name": "Mounting Plate",
    "created": "2026-03-24T10:00:00Z",
    "modified": "2026-03-24T11:30:00Z",
    "units": "mm"
  },
  "stock": {
    "profile": {
      "segments": [
        { "type": "line", "to": [80, 0] },
        { "type": "line", "to": [80, 50] },
        { "type": "line", "to": [0, 50] },
        { "type": "line", "to": [0, 0] }
      ],
      "origin": [0, 0]
    },
    "thickness": 15,
    "material": "aluminum_6061"
  },
  "dimensions": {
    "pocket_depth": { "value": 10, "formula": null },
    "hole_spacing": { "value": 15, "formula": null },
    "wall_clearance": { "value": 3, "formula": "stock_thickness - 12" }
  },
  "features": [
    {
      "id": "f1",
      "name": "Main pocket",
      "sketch": {
        "segments": [
          { "type": "line", "to": [60, 10] },
          { "type": "arc",  "to": [70, 20], "center": [60, 20], "clockwise": false },
          { "type": "line", "to": [70, 30] },
          { "type": "arc",  "to": [60, 40], "center": [60, 30], "clockwise": false },
          { "type": "line", "to": [20, 40] },
          { "type": "line", "to": [20, 10] }
        ],
        "origin": [0, 0],
        "dimensions": [
          { "id": "d1", "type": "distance", "value": 10, "name": "wall_offset" }
        ],
        "constraints": [
          { "id": "lc1", "type": "equal_radius", "segment_ids": ["s2", "s4"] }
        ]
      },
      "operation": "subtract",
      "z_top": 0,
      "z_bottom": "pocket_depth",
      "visible": true,
      "locked": false
    }
  ],
  "global_constraints": [
    { "id": "gc1", "type": "concentric", "feature_ids": ["f3", "f4"] }
  ],
  "tools": [
    { "id": "t1", "type": "flat_endmill", "diameter": 6, "flutes": 2, "material": "carbide" }
  ],
  "operations": [
    {
      "id": "op1",
      "type": "pocket",
      "feature_ref": "f1",
      "tool_ref": "t1",
      "stepdown": 3,
      "stepover": 0.45,
      "feed": 800,
      "rpm": 18000,
      "strategy": "2.5d",
      "tabs": []
    }
  ],
  "clamps": [
    { "id": "cl1", "type": "step_clamp", "x": 5, "y": 25, "w": 20, "h": 15, "height": 30 }
  ],
  "ai_history": [
    { "role": "user", "content": "80x50mm plate with a rounded pocket" },
    { "role": "assistant", "content": "..." }
  ]
}
```

Key design principles:
- **One feature = one closed profile** — no nested islands; relationships between features expressed via feature tree ordering and CSG evaluation
- **Stock is a profile** — not just width/height; supports irregular stock boundaries
- **Sketch embedded in feature** — each feature carries its own segments, local dimensions, and local constraints
- **Global constraints at project level** — reference feature IDs, handle cross-feature relationships
- **Geometry and operations are separate** — one feature can have multiple operations (rough + finish)
- **Tool library is embedded** — everything to reproduce G-code is in one file
- **AI history is saved** — reopen and continue refining with full context
- **`DimensionRef`** — any depth value can be a literal number or a named dimension string
- **`strategy` field** — always `"2.5d"` now, ready for `"3d_contour"` etc later
- **API keys never stored** in project file

---

## 7. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Language | TypeScript | Type safety for CAM math, self-documenting schema, compile-time error catching |
| UI framework | React | Component model fits panel-based layout |
| Build tool | Vite | Fast dev server, optimised production builds |
| State management | Zustand | Lightweight, TypeScript-friendly |
| 2D canvas | Canvas API / SVG | Sketch view, toolpath visualization |
| 3D rendering | Three.js | Unified scene for preview + simulation |
| CSG evaluation | `manifold` WASM | Robust polygon booleans for 3D preview |
| 2D booleans | `clipper.js` | Polygon clipping for 2D canvas CSG |
| Schema validation | `zod` | Runtime validation of `.camj` and AI responses |
| Constraint solver | `sketch-solver` (TBD) | Geometric constraint system |
| DXF import | `dxf-parser` | Entity mapping to geometry schema |
| Desktop wrapper | Tauri (later) | Smaller than Electron, native feel |

---

## 8. POC Scope

The POC validates the core sketch interaction and 3D representation pipeline before any CAM work begins. The sketch engine and feature model are the most novel and highest-risk parts of the app — proving them first de-risks everything downstream.

### POC Goals

Validate these specific unknowns:
- Does the sketch edit UX feel natural and responsive?
- Does the profile → CSG → 3D pipeline perform well enough in the browser?
- Does the one-feature-one-profile model hold up under real editing?

### POC — In Scope

- App shell + panel layout (AI chat placeholder, 2D canvas, feature tree, 3D preview)
- Stock definition — boundary profile + thickness + material
- Feature tree — add, delete, reorder (drag), visibility toggle, lock toggle
- Sketch edit mode — enter/exit per feature, node handles, drag nodes, line↔arc toggle, fillet
- Primitive constructors as starting points — rect, circle, polygon (serialize to segment arrays immediately, no primitive shorthand stored)
- 2D canvas — live profile rendering, node handles, grid, snap
- 3D view — CSG evaluation (manifold) → Three.js solid, live debounced update
- Add / subtract operation toggle per feature
- z_top / z_bottom per feature (numeric literals only, no formulas yet)
- Basic local dimensions (numeric, no constraint solver yet)
- Project save / load (`.camj` — final schema, no shortcuts)

### POC — Explicitly Out of Scope

- AI / MCP integration
- Toolpaths, G-code, operations panel
- Machining simulation
- Imports (SVG, DXF, STL)
- Constraint solver
- Clamps and tabs
- Named dimensions / formulas
- Global constraints

### Non-Negotiables During POC

Even in the POC, these must not be cut — they are expensive to retrofit:

- **Final `.camj` schema** — segments, z_top/z_bottom, operation, DimensionRef. No primitive shortcuts.
- **Feature tree ordering correct** — CSG evaluation depends on order; reorder UI must work properly.
- **Z values on every feature** — visible and editable in UI. Builds correct user habits.
- **Full segment array drives 3D** — no bounding box shortcuts for the CSG pipeline.

### POC Success Criteria

The core loop must feel good end to end:

```
1. Define stock (boundary + thickness)
2. Add feature → pick primitive or draw freehand
3. Enter sketch edit mode → move nodes, toggle line/arc, fillet corner
4. Set operation (add/subtract) + z_top / z_bottom
5. 3D view updates live
6. Reorder features in tree → 3D updates correctly
7. Save → reload → everything intact
```

---

## 9. Build Phases (Post-POC)

### Phase 1 — AI Foundation
- Multi-provider AI settings panel
- In-process MCP server scaffold
- Basic tool set (create/update/list features, get project state)
- AI chat panel wired to MCP loop
- JSON fallback mode for weaker models

### Phase 2 — Sketch Engine Completion
- Constraint solver integration (local constraints)
- Named dimensions + formula engine
- Global constraints (cross-feature)
- Bolt circle pattern tool
- Construction geometry
- Text engrave tool

### Phase 3 — Imports
- SVG import → segment array conversion
- DXF import (`dxf-parser`)
- AI-assisted feature classification for imports

### Phase 4 — CAM Engine
- Operations panel
- Profile, pocket, drill, facing, engrave operations
- Toolpath math (profile offsetting, pocket passes, drill cycles)
- Tabs (auto + manual placement)
- Clamp placement + collision detection
- Tool library + material presets + speeds & feeds
- G-code export (Grbl, LinuxCNC, Mach3)
- Post-processor system

### Phase 5 — Simulation
- Voxel-based material removal (Three.js)
- Web Worker for subtraction math
- Playback controls + speed scrubbing
- Tool mesh animation
- Screenshot + video export

### Phase 6 — Polish & Distribution
- STL import + AI feature classification
- Speeds & feeds database
- Tauri desktop wrapper
- Offline-first PWA option
- STEP import (opencascade.js)

---

## 10. Out of Scope (v1)

- True 3-axis surfacing (waterline, scallop, contour)
- Lathe operations
- Multi-setup / fixture changes
- Tool length compensation (post-processor concern)
- Cloud sync / collaboration
- STEP import (Phase 5+ consideration)
- Mobile support

---

## 11. Open Questions

- [ ] Constraint solver library — evaluate `sketch-solver`, `planck.js`, or custom numeric solver
- [ ] App name — shortlist: **Kerf**, **Chisel**, **Forje**
- [ ] Offline-first PWA vs Tauri for desktop — decide before Phase 6
- [ ] STL slicing strategy — write custom slicer or adapt existing library
- [ ] G-code post-processor plugin format — file-based or in-app editor?
