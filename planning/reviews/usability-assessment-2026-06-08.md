# PureCutCNC — Usability & Concept Assessment

**Date:** 2026-06-08
**Assessed by:** GitHub Copilot (DeepSeek V4 Pro) in VS Code
**Scope:** Codebase review of `purecutcnc/` — usability, user interaction, and competitive positioning. No changes made.

---

## Overall Verdict

**PureCutCNC is a genuinely original and technically impressive piece of work.** Its core concept — collapsing CAD sketch and CAM operation into a single step — is a real innovation in a space dominated by CAD-first then CAM-later workflows. The engine is deep, the architecture is clean, and the feature set punches well above what you'd expect from a solo-developed browser app. That said, there are significant usability gaps that separate it from "hobbyist-ready" and even more from "competitive with Carbide Create / Fusion 360 CAM."

---

## 1. The Core Concept: Where It Sits in CAD/CAM

### The Innovation Is Real

Traditional CAD/CAM pipelines (Fusion 360, SolidWorks + HSM, even Carbide Create) enforce a strict separation:

```
Draw sketch → Extrude/solid model → Switch to CAM workspace → Select geometry → Define operation → Set depths → Generate toolpaths
```

PureCutCNC collapses this to:

```
Draw sketch (with built-in Z bounds + add/subtract intent) → Operation inherits geometry and depth from the feature
```

This is **not just a UI shortcut** — it's a different mental model. A machinist doesn't think "I'll sketch a rectangle, extrude it, then pocket it." They think "This area is a 6mm-deep pocket." PureCutCNC captures that directly. The `SketchFeature` carrying `z_top`/`z_bottom`/`operation: 'add' | 'subtract'` is the right abstraction.

### Competitive Positioning

| | Carbide Create | Fusion 360 CAM | PureCutCNC |
|---|---|---|---|
| 3D modeling | None | Full parametric | None (view-only CSG) |
| Sketch→CAM gap | Separate steps | Separate steps | **Collapsed** |
| Operation types | Basic (pocket, contour, v-carve, drill) | Comprehensive | Pocket, profile, v-carve (offset + recursive), edge route, follow-line, drill, surface rough/finish |
| 3D surface machining | No | Yes | **Yes** (imported mesh roughing + finishing) |
| Simulation | No | Yes | Yes (voxel heightfield) |
| Tablet support | Partial | No | Yes (implemented) |
| AI integration | No | No | Planned (MCP) |
| Price | Free/$120 | $680/year | Open source (Apache 2.0) |
| Platform | Desktop (native) | Desktop (native) | **Browser + Tauri desktop** |

PureCutCNC's sweet spot is **between** Carbide Create (too simple for many) and Fusion 360 (too complex/expensive). If it reaches its design goals, it could be the best option for the hobbyist who wants:

1. True 2.5D CAM with surface machining
2. No CAD → CAM mode-switching ceremony
3. Runs in a browser (zero install for web users)
4. Import DXF/SVG from any CAD tool

### The Open-Source Angle

Being Apache 2.0 licensed and browser-based is a significant differentiator. There is **no other open-source browser CAM tool** with this feature depth. The closest competitors are desktop-only (FreeCAD Path, Blender CAM) or far simpler (jscut, Kiri:Moto). This positioning alone could build a community if the usability catches up.

---

## 2. Usability Assessment

### 2.1 What Works Well

**The feature-tree-as-CSG model is elegant.** Features are ordered, drag-reorderable, and the boolean evaluation "just works" — islands and holes emerge naturally. This is closer to how machinists think than traditional CAD.

**The sketch editing is surprisingly deep.** Direct on-canvas editing (drag nodes, insert points, fillet corners, arc center handles, marquee selection, move/copy/resize/rotate/offset) rivals entry-level CAD tools. The snapping system (grid, feature, point, line, midpoint, center) is thorough.

**The dimension annotation system is well-designed.** `DimensionAnnotation` anchors can attach to feature vertices, midpoints, centers, circle edges — and survive feature transforms because anchors resolve geometrically each frame rather than storing frozen coordinates. This is ahead of many commercial tools.

**The toolpath preview is immediate.** Toolpaths render on the 2D canvas as you change operation parameters. The async pipeline (compute one operation per frame with paint gaps) keeps the UI responsive. The 3D preview and simulation round out a complete "inspect before export" loop.

**The native file format (.camj) is clever.** Icons are stored as .camj projects editable in the app itself. The format is used for the icon sprite sheet pipeline, which is a nice dogfooding touch.

**The build and code quality is professional.** Strict TypeScript, Zustand with slices, pure-logic engine separated from React components, structural tests on every file, documented INDEX.md conventions, and a disciplined Plan→Approve→Implement→Archive workflow. This is not prototype code.

### 2.2 The Usability Gaps

#### A. The App Shell Is Overwhelming

The `AppShell` layout with LCR panels, toolbar orientation switching, workspace layout variants (`lcr`/`lc`/`c`/`cr`), and mode tabs (Sketch/3D/Simulation) creates a **lot** of chrome. Looking at `App.tsx`, there are ~30+ pieces of state just for layout concerns (`toolbarOrientationPreference`, `isToolbarForcedTop`, `workspaceLayout`, `centerTab`, `rightTab`, `depthLegendCollapsed`, `snapSettings`, `activeSnapMode`, `zoomWindowActive`, `toolpathVisibility`, `treeContextMenu`, `menuPosition`…). This is the kind of complexity that makes first-time users feel lost.

**Recommendation:** Consider a simpler default layout. Most users don't need 4 workspace layout variants. Pick one good one and let power users opt into complexity.

#### B. The Sketch → Operation Workflow Has Friction

The design doc says features carry their own Z bounds. In practice, the user still has to:

1. Draw a sketch feature
2. Set its z_top/z_bottom in the Properties panel
3. Select it
4. Open the CAM panel
5. Click "Add Operation"
6. Choose an operation kind
7. Configure tool, stepdown, stepover, feeds, etc.
8. The operation targets the selected feature

That's still 8 steps — not fundamentally fewer than Fusion 360's "sketch → extrude → create operation." The innovation is that Z bounds live on the feature (so the operation inherits them), but the user still has to manually create the operation. A true "collapsed" workflow would auto-suggest or auto-create operations from feature intent. For example: a subtract feature with z_bottom below stock surface should automatically offer a pocket operation.

**Recommendation:** Add a "Quick Operation" flow — right-click a feature → "Pocket this" or "Profile this" — that creates the operation with sensible defaults in one click.

#### C. The Properties Panel Is a Wall of Fields

`PropertiesPanel.tsx` exposes every property of the selected entity (feature, stock, grid, origin, backdrop, clamp, tab, tool, operation). This is functional but means the user sees dozens of numeric fields. For a hobbyist, this is intimidating. Carbide Create's approach is better: show only the 3-4 most important fields by default, with an "Advanced" disclosure for the rest.

#### D. No Onboarding or Guided Workflow

There is no "first run" experience. A new user opens the app and sees an empty canvas, a feature tree, a properties panel, a CAM panel, and toolbars. They don't know where to start. Even a simple overlay saying "Draw a shape or import a file to get started" would help. Better: a step-by-step guided workflow like Carbide Create's.

#### E. The Toolbar Model Needs Simplification

The app has three separate toolbar components (`GlobalToolbar`, `CreationToolbar`, `Toolbar`) plus a `TopCommandBar` and `ToolRail`. The toolbar can be top or left. This is a lot of toolbar surface area. Fusion 360 solves this with a context-sensitive toolbar that changes based on the active workspace — a model worth considering.

#### F. Undo/Redo Is Limited to Keyboard Shortcuts

`Ctrl+Z`/`Ctrl+Shift+Z` work, but there are no visible undo/redo buttons in the UI. For new users and tablet users, this is a problem.

#### G. Error Feedback Is Subtle

The clamp collision detection (toolpaths that intersect clamps) flags colliding clamps with warnings, but these render as text in the CAM panel. There's no visual highlight on the canvas showing where the collision occurs. A red zone overlay on the sketch would be far more intuitive.

#### H. No Visual "What You See Is What You Get" Stock Setup

The stock is defined as a profile, and the machine origin is a separate object. A new user who imports an SVG won't immediately understand how the coordinate system maps to their physical machine. A visual setup wizard showing the stock rectangle, the origin marker, and an arrow indicating machine axes would go a long way.

---

## 3. User Interaction Deep Dive

### 3.1 The Canvas Interaction Model

The `SketchCanvas` is the heart of the app. It uses raw HTML5 Canvas with pointer events for drawing, selection, and editing. The interaction model is ambitious:

- **Drawing tools**: Rectangle, circle, polygon, spline, line/polyline
- **Editing**: Drag nodes, insert points, fillet corners, arc center handles
- **Selection**: Click to select, marquee selection, Ctrl+A
- **Transforms**: Move, copy, resize, rotate, offset, mirror
- **Measurements**: On-canvas distance/radius/angle readouts during drawing and editing
- **Dimension annotations**: Persistent dimensions anchored to geometry
- **Snapping**: Grid, feature, point, line, midpoint, center

This is genuinely competitive with desktop CAD sketching. However:

- **Context switching is high.** You draw with one tool, then switch to Select to edit, then switch to Dimension to annotate. There's no automatic tool switching (e.g., Esc to Select, or double-click to edit).

- **Sketch edit mode** (double-click a feature) dims other features and shows local dimensions — this is good but discoverability is zero. There's no visual hint that double-clicking enters edit mode.

### 3.2 The CAM Panel Flow

The `CAMPanel` has two modes: Operations and Tools. The Operations tab shows a list of operations with an "Add Operation" menu (`OperationAddMenu`). Each operation card shows:
- Operation kind and name
- Selected tool
- Depth and step parameters
- Feed and speed
- Toolpath visibility toggle

The flow is: select features → add operation → configure parameters → see toolpath update on canvas.

This works but requires the user to understand the relationship between features, operations, and targets. If you select the wrong features before adding an operation, the operation targets nothing and shows no toolpath — with no obvious error message.

### 3.3 The 3D Preview and Simulation

The 3D preview (Three.js + manifold-3d WASM) is impressive for a browser app. CSG evaluation from the feature tree produces a solid model. The simulation viewport shows voxel-based material removal. However:

- The 3D view auto-frames only on first open (`hasAutoFramed3DRef`). After making changes, the user must manually zoom.
- The simulation is per-operation or all-visible-operations — good flexibility, but the detail cell count slider (`simulationDetailCells`) is a technical parameter that users shouldn't need to understand.

---

## 4. Architecture Quality Notes

The codebase is well-structured. Key strengths:

- **Pure engine separation.** `src/engine/` has no React, no DOM — fully testable in isolation. This is the right architecture for CAM logic.
- **Zustand store with slices.** The store is large (~2000+ lines) but sliced by concern (`selectionSlice`, `pendingActionsSlice`, `pendingAddSlice`, `pendingCompletionSlice`, `dimensionsSlice`, `dimensionToolSlice`). This is the right pattern.
- **Toolpath cache.** The `toolpathCacheRef` in `App.tsx` with `operationComputationEquals` comparison is a smart optimization that avoids recomputing toolpaths when only display properties change.
- **Coordinate discipline.** Screen Y-down internal, Cartesian Y-up for G-code export. The `MachineOrigin` handles the inversion. This is well-documented in `ARCHITECTURE.md`.
- **Unit handling.** `src/utils/units.ts` provides conversion helpers that check `project.meta.units`. Good discipline.

Potential concerns:
- `App.tsx` is very large — it contains the toolpath pipeline, simulation result computation, keyboard shortcuts, context menu logic, and all dialog state. This will become hard to maintain.
- `SketchCanvas.tsx` is a single file handling drawing, editing, selection, snapping, measurements, dimension rendering, backdrop images, clamps, tabs, text, and file drops. Consider splitting into focused hooks/components.

---

## 5. Summary

| Dimension | Rating | Notes |
|---|---|---|
| **Concept originality** | ★★★★★ | Collapsing CAD/CAM into features with volumetric intent is genuinely novel |
| **CAM engine depth** | ★★★★☆ | Pocket, profile, v-carve (2 algorithms), surface machining, drilling — comprehensive for 2.5D |
| **Sketch editing** | ★★★★☆ | Deep, competitive with entry-level CAD; needs better discoverability |
| **UI polish** | ★★★☆☆ | Functional but overwhelming; too much chrome, no onboarding |
| **Tablet/mobile** | ★★★★☆ | Implemented via shell mode system and pointer event conversion; good foundation |
| **Code quality** | ★★★★★ | Strict TS, clean architecture, good test coverage, disciplined workflow |
| **Market positioning** | ★★★★☆ | Unique space between Carbide Create and Fusion 360; open source + browser is a strong differentiator |
| **Beginner friendliness** | ★★☆☆☆ | No guided workflow, too many panels, no tooltips, no onboarding |

### The Three Things That Would Move the Needle Most

1. **Guided workflow / onboarding.** A 3-step flow (import/draw → set up stock → generate operations) with progressive disclosure would transform the first-run experience.

2. **Operation auto-creation.** When a user draws a subtract feature with z_bottom < stock surface, offer a "Create Pocket Operation" button on the feature itself. This closes the gap between the elegant feature model and the manual operation creation step.

3. **Properties panel progressive disclosure.** Hide advanced fields behind a disclosure toggle. Show only name, operation, z_top, z_bottom by default. This would make the panel far less intimidating.

PureCutCNC has the bones of something special. The concept is right, the engine is solid, and the code is clean. The remaining work is mostly UX refinement — making the powerful engine accessible to the hobbyists it's designed for.
