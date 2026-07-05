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
    - `operation`: `'add'` (raised), `'subtract'` (pocket/cut), `'region'` (machining-area mask), `'model'` (imported 3D), `'line'` (open engrave path), or `'construction'` (sketch-only reference geometry — see below).
    - `z_top` & `z_bottom`: Vertical bounds of the feature (per-instance).
- **FeatureDefinition:** Shared, canonical, *untransformed* shape data (`profile`, `dimensions`, `text`, `stl`, `kind`, `operation`) referenced by one or more instances. See §4.
- **Construction geometry** (`operation: 'construction'`, issue #199): sketch-only reference geometry (points/lines/shapes, open or closed). It lives in its own **Construction** tree section, renders muted/dashed on the 2D canvas, participates in snapping, mirroring, cutting, dimensions, and as a constraint *reference* — but is **hard-excluded** from CSG/3D preview, simulation, toolpaths, and CAM targets. The exclusion is centralized in `src/store/helpers/featureRoles.ts` (`isMachinable` / `modelFeatures()`); use those predicates instead of ad-hoc `operation !== 'region'` checks. Guarded by `src/engine/constructionExclusion.test.ts`.
- **Machine Origin:** Defines the translation between internal project coordinates and machine G-code coordinates.

## 4. Feature References (Definitions & Instances)

PureCutCNC supports SketchUp-style **linked copies**: editing a shared shape updates every copy, while placement (move/rotate/resize/mirror), name, visibility, lock, and Z stay per-copy. The former monolithic feature is split into a **definition** (the shared shape) and **instances** (placed copies). Full design, the operation-semantics matrix, and slice-by-slice history live in [`planning/FEATURE_REFERENCES_Plan.md`](planning/FEATURE_REFERENCES_Plan.md); live status is in [`planning/FEATURE_REFERENCES_Ledger.md`](planning/FEATURE_REFERENCES_Ledger.md).

- **`FeatureDefinition`** (`project.featureDefinitions: Record<id, def>`): the shared, canonical, *untransformed* shape — `kind`, `profile`, `dimensions`, `text`, `stl`, `operation`.
- **`SketchFeature`** = an **instance** (every feature-tree row): `definitionId` + `transform` (a `Matrix2D` mapping definition-local geometry into world space), plus per-instance `name`, `folderId`, `visible`, `locked`, `z_top`/`z_bottom`, and `constraints`.
- A **linked copy** is another instance with the **same `definitionId`**. **Make Unique** clones the definition and repoints one instance. **Copy** makes a linked (reference) copy by default — governed by project `meta.copyMode` (default `'reference'`).

**Resolver boundary.** The canonical world geometry comes from the resolver — `resolveFeatureInstance(project, id)` / `resolveProfile(definition, transform)` (`src/store/helpers/resolveFeatures.ts`), which composes definition + transform. Toolpaths, hit-testing, and export read through it. For performance the 2D canvas renders from each instance's **baked** `sketch.profile` (the dual-stored copy, see below) instead of re-resolving every frame; that baked copy is kept equal to the resolved geometry by `rebakeAllInstances`. New code that needs world geometry should go through the resolver rather than assume `feature.sketch.profile` is authoritative.

**Dual storage / backward compatibility (important).** Each instance also stores a **baked** `sketch` (a world-space `profile`), kept in sync with its definition by `rebakeAllInstances` (`src/store/helpers/featureDefinitions.ts`) on creation, transforms, definition edits, snapshot ops, and linked-constraint re-solve. A saved `.camj` therefore contains **both** `featureDefinitions` and fully-baked `features[]`. A pre-references build opens it by reading `features[].sketch`, and — because it spreads through fields it doesn't recognize on load+save — **preserves** `featureDefinitions` / `definitionId` / `transform`; linked relationships therefore *survive* an old-build round-trip. ⚠️ **Caveat:** *editing* a linked instance in an old build changes only that instance's baked `sketch`, not the shared definition, so the instance diverges from its definition. A current build renders that divergence until the next definition edit re-bakes every instance from the (unchanged) definition — at which point the old-build edit is silently discarded and it never propagated to siblings. So old builds are safe to **view and round-trip**, but **editing** linked features in an old build is not durable.

**Versioning.** `Project.version`: `'1.0'` = legacy flat features; `'2.0'` = definitions + instances; `'2.1'` = adds construction geometry (`LATEST_PROJECT_VERSION` in `src/types/project.ts`). Legacy `1.0` files migrate on load (one definition + one identity-transform instance per old feature; resolved geometry byte-equivalent). Saving stamps the version **by content**: a file is written as `'2.1'` only when it actually contains construction geometry, otherwise `'2.0'` — so pre-construction builds warn on exactly the files they could silently machine wrong. Loading a file newer than `LATEST_PROJECT_VERSION` shows a one-time warning (`openProjectFromText` → `loadWarning` → App) and opens best-effort. When bumping the schema, update `LATEST_PROJECT_VERSION` and the `version` union.

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

Icons are **SVG-first**: editable per-icon SVG files are the source of truth and the build assembles them into a sprite. (Reworked in issue #176 — the previous `src/assets/icons.camj` CAD-profile source has been removed; see `src/assets/icons/README.md` for the contributor guide.)

- **Source of truth:** `src/assets/icons/<name>.svg` — one standalone, editor-friendly SVG per icon on a 24×24 viewBox. These open and edit directly in Inkscape/Illustrator and can carry colours/fills (not just monochrome outlines).
- **Build output:** `public/icons.svg` — an SVG `<symbol>` sprite generated from the folder. This file is **generated; do not edit it directly**. The sprite root carries **no `display:none`** so the same file works both as an external `<use>` target (this app's `Icon.tsx`) and as a fetch+inline sprite (the purecutcnc.github.io guide loader).
- **Build command:** `npm run sync-icons` (also runs first in the full `npm run build`).
- **Generator:** `scripts/build-icon-sprite.ts` reads each `src/assets/icons/*.svg`, strips its outer `<svg>` wrapper (and editor cruft), and wraps the contents in `<symbol id="<name>" viewBox="…">`. The pure assembly logic lives in `src/components/iconSprite.ts` (unit-tested by `iconSprite.test.ts`).
- **Icon naming:** The filename becomes the symbol `id` (e.g. `view-top.svg` → `<symbol id="view-top">`).
- **Monochrome vs colour:** `Icon.tsx` defaults to `fill="none" stroke="currentColor" strokeWidth="1.5"`, so outline icons inherit text colour. Pass `<Icon id="…" fullColor />` to drop those defaults and let an icon's own per-element paint render.
- **Usage in components:** Import `Icon` from `src/components/Icon.tsx` and pass the filename (sans `.svg`) as the `id` prop: `<Icon id="view-top" size={18} />`. The component renders a `<use href="icons.svg#id" />` reference.
- **Adding new icons:** Drop a `<name>.svg` into `src/assets/icons/`, then run `npm run sync-icons`. See `src/assets/icons/README.md` for sizing/colour conventions.
- **Legacy:** the original `src/assets/icons.camj` CAD-profile source and its camj-based scripts (`convert-camj-to-icons.js`, `seed-icons-from-camj.js`, `redraw-icons.js`, `convert-icons-to-camj.js`) have been removed — the per-icon SVGs are now the sole source. The migration history lives in git (issue #176).

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
