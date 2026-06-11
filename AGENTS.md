# AGENTS.md — PureCutCNC

## What This Is

PureCutCNC is a browser-based 2.5D CAD/CAM application for CNC hobbyists. It collapses CAD sketching and CAM operation definition into a single workflow. Built with Vite + React + TypeScript, state managed by Zustand, with a Tauri wrapper for desktop builds.

## Code Map (read first)

Start every session by reading [`INDEX.md`](INDEX.md) at the repo root. It maps the codebase folder-by-folder and points to per-folder `INDEX.md` files for deeper detail. When you work inside a folder that has an `INDEX.md`, read it before exploring files there. Prefer the index over grepping blind.

**Maintenance rule:** when you add, rename, remove, or significantly change the purpose of a file, update the nearest `INDEX.md` in the same commit. If you create a new folder with non-trivial content, add an `INDEX.md` there and link it from the parent index.

## Workflow: Plan → Approve → Implement → Archive

**Every task follows this loop. No exceptions — even a one-line bug fix gets a short plan.** The plan can be tiny if the task is tiny; the point is that intent is written down, agreed, and traceable.

1. **Plan.** Before changing any code, write a plan to `planning/<TOPIC>_Plan.md` using [`planning/TEMPLATE.md`](planning/TEMPLATE.md). Add an entry under "Pending approval" in [`planning/INDEX.md`](planning/INDEX.md). The plan's frontmatter starts at `status: Draft`.
2. **Approve.** Share the plan with the user and **wait for an explicit "approved" (or equivalent) signal**. Do not start implementation before approval. If the user asks for changes, update the plan and re-confirm.
3. **Implement.** On approval, set `status: Approved` (then `In progress` once you begin) and move the index entry to "In progress". Implement against the plan. If the plan needs to change mid-flight, update the plan file in the same commit as the deviation.
4. **Archive before PR.** When the work is complete and the build is green, **before opening the PR**: `git mv planning/<TOPIC>_Plan.md planning/archive/`, set `status: Done`, and remove the entry from `planning/INDEX.md`. The PR description should link to the archived plan.
5. **Abandon.** If a plan is dropped before implementation, set `status: Abandoned`, move it to `planning/archive/`, and remove the index entry.

The existing 13 active plans at `planning/` root predate this rule — treat them as `In progress` even though they don't carry the frontmatter.

## Build & Verify

```bash
npm run build          # Full build (icon generation + tsc + tests + vite). Run this before committing.
npm test               # Run the structural test suite (every src/**/*.test.ts via tsx)
npm run dev            # Vite dev server (do NOT start this — the user runs it themselves)
npm run lint           # ESLint over supported source only: src, vite.config.ts, and build/test scripts
npm run lint:scripts   # Optional: lint the one-off diagnostic scripts in scripts/ (not a quality gate)
npm run sync-icons     # Regenerate public/icons.svg from src/assets/icons.camj
```

Always run `npm run build` from the project root to verify changes compile before committing. `npm test` runs automatically as part of the build, so a failing structural test will fail the build. Do not start the dev/preview server.

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

- Every `src/**/*.ts` / `*.tsx` file (including tests and `.d.ts`) starts with the Apache 2.0 license header — copy the exact comment block from any existing source file
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
