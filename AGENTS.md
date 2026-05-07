# AGENTS.md — PureCutCNC

## What This Is

PureCutCNC is a browser-based 2.5D CAD/CAM application for CNC hobbyists. It collapses CAD sketching and CAM operation definition into a single workflow. Built with Vite + React + TypeScript, state managed by Zustand, with a Tauri wrapper for desktop builds.

## Build & Verify

```bash
npm run build          # Full build (icon generation + tsc + vite). Run this before committing.
npm run dev            # Vite dev server (do NOT start this — the user runs it themselves)
npm run lint           # ESLint
npm run sync-icons     # Regenerate public/icons.svg from src/assets/icons.camj
```

Always run `npm run build` from the project root to verify changes compile before committing. Do not start the dev/preview server.

## Key Architecture

Read `ARCHITECTURE.md` for the full picture. The critical points:

- **State:** All project mutations go through `src/store/projectStore.ts` (Zustand). Never mutate state directly.
- **2D geometry:** `clipper-lib` (integer math — always use the internal scaling factor).
- **3D preview:** `manifold-3d` WASM for CSG, rendered via Three.js.
- **Coordinate system:** Internal uses screen coords (Y increases downward). Machine/G-code uses Cartesian (Y increases upward). The `MachineOrigin` and G-code export handle inversion.
- **Units:** Project can be `mm` or `inch`. Check `project.meta.units` and use helpers in `src/utils/units.ts`.

## Directory Layout

```
src/store/          Zustand state + slices
src/engine/toolpaths/   CAM logic (pocket, profile, v-carve, etc.)
src/engine/gcode/       Post-processors and G-code generation
src/components/canvas/  2D sketch canvas and interaction
src/components/viewport3d/  Three.js 3D preview
src/components/simulation/  Voxel-based toolpath simulation
src/import/         DXF, SVG, and STL importers
src/text/           Text-to-geometry conversion
src/types/project.ts    Core data model definitions
```

## Coding Standards

- Strict TypeScript — no `any`
- React + vanilla CSS (no UI component libraries)
- New engine features or bug fixes must include unit tests
- Do not add Co-Authored-By lines to commits
- Do not append "Generated with [tool name]" or similar attribution footers to PR descriptions

## Icon System

Icons live in `src/assets/icons.camj` (a .camj project file editable in the app itself). Running `npm run sync-icons` converts them to `public/icons.svg` as an SVG sprite sheet. Never edit `public/icons.svg` directly.

## STL / 3D Mesh Import

STL files are imported via `src/import/stl.ts`. The pipeline:
1. Parses the binary/ASCII STL into a triangle mesh (`src/engine/importedMesh.ts`)
2. Supports axis orientation swaps (`none`, `yz`, `xz`, `xy`)
3. Extracts a silhouette profile for 2D sketch representation
4. The mesh participates in surface roughing/finishing toolpath generation (`src/engine/toolpaths/roughSurface.ts`, `finishSurface.ts`)

## Planning & Design Docs

Check `planning/` for feature-specific implementation plans before starting work on a feature. These take precedence over general defaults.

## Data Format

The native file format is `.camj`. Core types are in `src/types/project.ts`:
- **Project** — root object (metadata, stock, features, tools, operations)
- **SketchFeature** — atomic design unit with sketch geometry, operation (add/subtract), and Z bounds (z_top/z_bottom)
