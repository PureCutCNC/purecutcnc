# PureCutCNC — Foundational Architecture & Standards (ARCHITECTURE.md)

This document is the primary source of truth for the architectural vision, coding standards, and operational constraints of the PureCutCNC project. It takes absolute precedence over general defaults. Always refer to this file and the `planning/` directory for detailed design and implementation context.

## 1. Project Vision & Purpose
PureCutCNC is a web-based, parametric 2.5D CAM application designed for CNC enthusiasts. 
- **Core Innovation:** Collapses the CAD (sketch) and CAM (operation) steps. Features carry their own volumetric intent (add/subtract) and depth (z_top/z_bottom) directly in the sketch.
- **User Persona:** Hobbyists and small shops who need more power than basic 2D tools but less complexity than full 3D CAD/CAM suites.
- **AI-First:** The application is designed to be manipulated via an AI agent through an MCP (Model Context Protocol) interface. This is now pushed down on the priority list and MCP server functions are not designed and implemented yet.

## 2. Core Architecture
- **State Management:** Driven by a central Zustand store (`src/store/projectStore.ts`). It handles the project lifecycle, feature tree ordering, and undo/redo history.
- **Geometric Engine:**
    - **2D (Clipper):** Uses `clipper-lib` for polygon clipping and region resolution (see `src/engine/toolpaths/resolver.ts`).
    - **3D (Manifold):** Uses `manifold-3d` WASM to perform CSG (Constructive Solid Geometry) for the 3D preview.
- **Rendering:**
    - **Sketch View (2D):** High-performance HTML5 Canvas (`src/components/canvas/SketchCanvas.tsx`).
    - **3D Preview:** Three.js viewport rendering the CSG-derived model (`src/components/viewport3d/Viewport3D.tsx`).
    - **Simulation:** Voxel-based material removal playback (`src/components/simulation/SimulationViewport.tsx`).

## 3. Key Data Models (.camj)
Defined in `src/types/project.ts`:
- **Project:** The root object containing metadata, stock definition, features, tools, and operations.
- **SketchFeature:** The atomic unit of design. Contains:
    - `sketch`: A `SketchProfile` made of `segments` (line, arc, bezier).
    - `operation`: `'add'` (raised) or `'subtract'` (pocket/cut).
    - `z_top` & `z_bottom`: Vertical bounds of the feature.
- **Machine Origin:** Defines the translation between internal project coordinates and machine G-code coordinates.

## 4. Directory Map
- `src/store/`: Zustand state logic, split into functional slices (selection, pending actions, etc.).
- `src/engine/toolpaths/`: The heart of CAM logic (pocketing, profiling, v-carve, etc.).
- `src/engine/gcode/`: Post-processors and G-code generation logic.
- `src/components/canvas/`: Complex 2D interaction logic, snapping, and viewport transformations.
- `src/import/`: DXF and SVG parsers that normalize external geometry into the `.camj` format.
- `src/text/`: Logic for converting text and fonts into machinable geometry.

## 5. Coding Standards & Conventions
- **Strict TypeScript:** No `any`. Use interfaces and types defined in `src/types/project.ts`.
- **State Mutation:** All modifications to the project must go through the `projectStore` actions to ensure consistency and history tracking.
- **UI:** React for component structure + Vanilla CSS for styling. Avoid heavy UI libraries.
- **Testing:** New features or bug fixes in the `engine/` must include corresponding unit tests.

## 6. Operational Gotchas
- **Clipper Scaling:** `clipper-lib` uses integer math. Always use the internal scaling factor when performing clipping operations.
- **Coordinate Systems:** 
    - **Internal:** Uses a screen-coordinate system where (0,0) is top-left, and **positive Y increases downwards**.
    - **Machine:** Standard Cartesian CAM system where **positive Y increases upwards**. 
    - The `MachineOrigin` and G-code export logic are responsible for this inversion.
- **Unit Handling:** Use helpers in `src/utils/units.ts`. The project can be in `mm` or `inch`; always check `project.meta.units`.
- **CSG Debouncing:** 3D model generation is expensive. The `Viewport3D` updates are typically debounced (150ms-300ms).

## 7. AI & MCP Integration
The application exposes its engine via tool calls. When acting as an agent:
- Prefer using the `projectStore` actions to modify state.
- Use `get_project_state` to understand the current feature tree before making changes.
- Ensure all geometric modifications result in valid closed profiles unless specifically creating an open-path engrave feature.
