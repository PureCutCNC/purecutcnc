# PureCutCNC — Foundational Architecture & Standards (ARCHITECTURE.md)

This document is the primary source of truth for the architectural vision, coding standards, and operational constraints of the PureCutCNC project. It takes absolute precedence over general defaults. Always refer to this file and the `planning/` directory for detailed design and implementation context. For tablet UI/UX-specific architecture and design decisions, see [`planning/TABLET_UX_COMBINED_PLAN.md`](planning/TABLET_UX_COMBINED_PLAN.md).

## 1. Project Vision & Purpose
PureCutCNC is a web-based, parametric 2.5D CAM application designed for CNC enthusiasts.
- **Core Innovation:** Collapses the CAD (sketch) and CAM (operation) steps. Features carry their own volumetric intent (add/subtract) and depth (z_top/z_bottom) directly in the sketch.
- **User Persona:** Hobbyists and small shops who need more power than basic 2D tools but less complexity than full 3D CAD/CAM suites.
- **AI integration (future):** Exposing the engine to AI agents via MCP (Model Context Protocol) is a long-term direction, but no agent-facing surface exists in the app today. AI is currently used only as a development aid, not as an in-product feature.

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
- **SketchFeature:** A feature-tree row. Since `version` `2.0` it is an **instance** that references a shared `FeatureDefinition` via `definitionId` + `transform`, while still carrying a baked, world-space copy for compatibility. Contains:
    - `sketch`: A `SketchProfile` made of `segments` (line, arc, bezier) — the **baked** world-space geometry, kept in sync with the definition (see §4).
    - `definitionId` + `transform`: the link to the shared shape and its affine placement.
    - `operation`: `'add'` (raised) or `'subtract'` (pocket/cut).
    - `z_top` & `z_bottom`: Vertical bounds of the feature (per-instance).
- **FeatureDefinition:** Shared, canonical, *untransformed* shape data (`profile`, `dimensions`, `text`, `stl`, `kind`, `operation`) referenced by one or more instances. See §4.
- **Machine Origin:** Defines the translation between internal project coordinates and machine G-code coordinates.

## 4. Feature References (Definitions & Instances)

PureCutCNC supports SketchUp-style **linked copies**: editing a shared shape updates every copy, while placement (move/rotate/resize/mirror), name, visibility, lock, and Z stay per-copy. The former monolithic feature is split into a **definition** (the shared shape) and **instances** (placed copies). Full design, the operation-semantics matrix, and slice-by-slice history live in [`planning/FEATURE_REFERENCES_Plan.md`](planning/FEATURE_REFERENCES_Plan.md); live status is in [`planning/FEATURE_REFERENCES_Ledger.md`](planning/FEATURE_REFERENCES_Ledger.md).

- **`FeatureDefinition`** (`project.featureDefinitions: Record<id, def>`): the shared, canonical, *untransformed* shape — `kind`, `profile`, `dimensions`, `text`, `stl`, `operation`.
- **`SketchFeature`** = an **instance** (every feature-tree row): `definitionId` + `transform` (a `Matrix2D` mapping definition-local geometry into world space), plus per-instance `name`, `folderId`, `visible`, `locked`, `z_top`/`z_bottom`, and `constraints`.
- A **linked copy** is another instance with the **same `definitionId`**. **Make Unique** clones the definition and repoints one instance. **Copy** makes a linked (reference) copy by default — governed by project `meta.copyMode` (default `'reference'`).

**Resolver boundary.** The canonical world geometry comes from the resolver — `resolveFeatureInstance(project, id)` / `resolveProfile(definition, transform)` (`src/store/helpers/resolveFeatures.ts`), which composes definition + transform. Toolpaths, hit-testing, and export read through it. For performance the 2D canvas renders from each instance's **baked** `sketch.profile` (the dual-stored copy, see below) instead of re-resolving every frame; that baked copy is kept equal to the resolved geometry by `rebakeAllInstances`. New code that needs world geometry should go through the resolver rather than assume `feature.sketch.profile` is authoritative.

**Dual storage / backward compatibility (important).** Each instance also stores a **baked** `sketch` (a world-space `profile`), kept in sync with its definition by `rebakeAllInstances` (`src/store/helpers/featureDefinitions.ts`) on creation, transforms, definition edits, snapshot ops, and linked-constraint re-solve. A saved `.camj` therefore contains **both** `featureDefinitions` and fully-baked `features[]`. A pre-references build opens it by reading `features[].sketch`, and — because it spreads through fields it doesn't recognize on load+save — **preserves** `featureDefinitions` / `definitionId` / `transform`; linked relationships therefore *survive* an old-build round-trip. ⚠️ **Caveat:** *editing* a linked instance in an old build changes only that instance's baked `sketch`, not the shared definition, so the instance diverges from its definition. A current build renders that divergence until the next definition edit re-bakes every instance from the (unchanged) definition — at which point the old-build edit is silently discarded and it never propagated to siblings. So old builds are safe to **view and round-trip**, but **editing** linked features in an old build is not durable.

**Versioning.** `Project.version`: `'1.0'` = legacy flat features; `'2.0'` = definitions + instances (current — `LATEST_PROJECT_VERSION` in `src/types/project.ts`). Legacy `1.0` files migrate on load (one definition + one identity-transform instance per old feature; resolved geometry byte-equivalent). Loading a file newer than `LATEST_PROJECT_VERSION` shows a one-time warning (`openProjectFromText` → `loadWarning` → App) and opens best-effort. When bumping the schema, update `LATEST_PROJECT_VERSION` and the `version` union.

**Key files.** `src/store/helpers/resolveFeatures.ts` (resolver), `featureDefinitions.ts` (mint / clone / rebake / make-unique / GC), `instanceTransforms.ts` (matrix helpers incl. `invertMatrix`); the split types in `src/types/project.ts`; creation/transform/edit/snapshot/constraint wiring across `src/store/slices/*` and `src/store/helpers/*`.

## 5. Directory Map
- `src/store/`: Zustand state logic, split into functional slices (selection, pending actions, etc.).
- `src/engine/toolpaths/`: The heart of CAM logic (pocketing, profiling, v-carve, etc.).
- `src/engine/gcode/`: Post-processors and G-code generation logic.
- `src/components/canvas/`: Complex 2D interaction logic, snapping, and viewport transformations.
- `src/import/`: DXF and SVG parsers that normalize external geometry into the `.camj` format.
- `src/text/`: Logic for converting text and fonts into machinable geometry.
- `src/styles/tablet.css`: Tablet-optimized styles for touch/mobile-friendly UI (see [`planning/TABLET_UX_COMBINED_PLAN.md`](planning/TABLET_UX_COMBINED_PLAN.md) for the full tablet UX design).

## 6. Icon System

Icons are managed as a custom build pipeline using the `.camj` project format.

- **Source of truth:** `src/assets/icons.camj` — a standard `.camj` project file where each icon is a named folder of sketch features on a 24×24 unit canvas. This file can be opened and edited in the application itself.
- **Build output:** `public/icons.svg` — an SVG sprite sheet generated from `icons.camj`. This file is **generated; do not edit it directly**.
- **Build command:** `npm run sync-icons` (also runs as part of the full `npm run build`).
- **Conversion script:** `scripts/convert-camj-to-icons.js` reads `icons.camj`, converts each feature's sketch profile to an SVG `<path>`, and writes `<symbol>` elements to `public/icons.svg`. Features with empty segment arrays are skipped.
- **Icon naming:** The folder `name` in `icons.camj` becomes the symbol `id` in the SVG (e.g. folder name `"view-top"` → `<symbol id="view-top">`).
- **Usage in components:** Import `Icon` from `src/components/Icon.tsx` and pass the folder name as the `id` prop: `<Icon id="view-top" size={18} />`. The component renders a `<use href="icons.svg#id" />` reference, so the icon inherits `stroke="currentColor"` and `fill="none"` from the SVG wrapper.
- **Adding new icons:** Add feature folders and features to `icons.camj`, then run `npm run sync-icons`. Each icon group needs a `featureFolders` entry and a `featureTree` entry in addition to the `features` entries.

## 7. Coding Standards & Conventions
- **Strict TypeScript:** No `any`. Use interfaces and types defined in `src/types/project.ts`.
- **State Mutation:** All modifications to the project must go through the `projectStore` actions to ensure consistency and history tracking.
- **UI:** React for component structure + Vanilla CSS for styling. Avoid heavy UI libraries.
- **Testing:** New features or bug fixes in the `engine/` must include corresponding unit tests.

## 8. Operational Gotchas
- **Clipper Scaling:** `clipper-lib` uses integer math. Always use the internal scaling factor when performing clipping operations.
- **Coordinate Systems:** 
    - **Internal:** Uses a screen-coordinate system where (0,0) is top-left, and **positive Y increases downwards**.
    - **Machine:** Standard Cartesian CAM system where **positive Y increases upwards**. 
    - The `MachineOrigin` and G-code export logic are responsible for this inversion.
- **Unit Handling:** Use helpers in `src/utils/units.ts`. The project can be in `mm` or `inch`; always check `project.meta.units`.
- **CSG Debouncing:** 3D model generation is expensive. The `Viewport3D` updates are typically debounced (150ms-300ms).

## 9. AI & MCP Integration (not yet implemented)
There is **no MCP server or agent-facing tool surface in the app today**. Earlier drafts of this document described an aspirational design; treat it as a future direction, not current behavior. When that work begins, the guiding principles will be:
- All mutations should flow through `projectStore` actions (same rule as the UI).
- An agent will need a project-state inspection call before making changes.
- Geometric modifications must produce valid closed profiles, except for explicit open-path engrave features.
