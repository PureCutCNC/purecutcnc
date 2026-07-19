# PureCutCNC — Foundational Architecture & Standards (ARCHITECTURE.md)

This document owns the current technical architecture, data model, and
cross-cutting implementation invariants. [`PROJECT.md`](PROJECT.md) owns product
purpose, scope, safety, and terminology; [`AGENTS.md`](AGENTS.md) owns assigned
work and verification; [`planning/INDEX.md`](planning/INDEX.md) routes to
narrow area-specific design references. For tablet interaction architecture,
see [`planning/TABLET_UX_DESIGN.md`](planning/TABLET_UX_DESIGN.md).

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
- **FeatureInstance:** A lightweight feature-tree row. It contains `definitionId` + `transform`, per-instance constraints, name/folder/visibility/lock state, and `z_top`/`z_bottom`. It does **not** contain sketch geometry, kind, text/STL data, or operation.
- **FeatureDefinition:** Shared, canonical, *untransformed* shape data (`profile`, `dimensions`, `text`, `stl`, `kind`, `operation`) referenced by one or more instances. See §4.
- **SketchFeature:** A geometry-bearing runtime/editing shape. It is used for drafts and resolved world-space views, but it is not a serialized `Project.features[]` row in format 3.0.
- **Construction geometry** (`operation: 'construction'`, issue #199): sketch-only reference geometry (points/lines/shapes, open or closed). It lives in its own **Construction** tree section, renders muted/dashed on the 2D canvas, participates in snapping, mirroring, cutting, dimensions, and as a constraint *reference* — but is **hard-excluded** from CSG/3D preview, simulation, toolpaths, and CAM targets. The exclusion is centralized in `src/store/helpers/featureRoles.ts` (`isMachinable` / `modelFeatures()`); use those predicates instead of ad-hoc `operation !== 'region'` checks. Guarded by `src/engine/constructionExclusion.test.ts`.
- **Machine Origin:** Defines the translation between internal project coordinates and machine G-code coordinates.

## 4. Feature References (Definitions & Instances)

PureCutCNC supports SketchUp-style **linked copies**: editing a shared shape updates every copy, while placement (move/rotate/resize/mirror), name, visibility, lock, and Z stay per-copy. The former monolithic feature is split into a **definition** (the shared shape) and **instances** (placed copies). The contract below is current; the completed migration plan and slice ledger are retained only as historical context in [`planning/archive/FEATURE_REFERENCES_Plan.md`](planning/archive/FEATURE_REFERENCES_Plan.md) and [`planning/archive/FEATURE_REFERENCES_Ledger.md`](planning/archive/FEATURE_REFERENCES_Ledger.md).

- **`FeatureDefinition`** (`project.featureDefinitions: Record<id, def>`): the shared, canonical, *untransformed* shape — `kind`, `profile`, `dimensions`, `text`, `stl`, `operation`.
- **`FeatureInstance`** (`project.features: FeatureInstance[]`) = every feature-tree row: `definitionId` + `transform` (a `Matrix2D` mapping definition-local geometry into world space), plus per-instance `name`, `folderId`, `visible`, `locked`, `z_top`/`z_bottom`, and `constraints`.
- A **linked copy** is another instance with the **same `definitionId`**. **Make Unique** clones the definition and repoints one instance. **Copy** makes a linked (reference) copy by default — governed by project `meta.copyMode` (default `'reference'`).

**Resolver boundary.** Canonical world geometry comes from `resolveFeatureInstance(project, id)` / `resolveProfile(definition, transform)` (`src/store/helpers/resolveFeatures.ts`), which composes definition + transform into a `ResolvedSketchFeature`. Toolpaths, hit-testing, rendering, export, and geometry-aware UI reads go through this boundary. A missing definition or invalid instance is rejected or skipped; there is no feature-ID identity fallback and no raw-row geometry fallback.

**Imported-model transforms.** Persisted STL/OBJ mesh vertices remain definition-local. `stl.scale` is applied to the raw mesh first, then the instance `Matrix2D` supplies the complete world-space X/Y affine placement for the Sketch top-view image, 3D preview, CSG, surface CAM/gouge checks, and model export; `z_top`/`z_bottom` continue to own the independent Z fit. `src/engine/importedModelTransform.ts` is the shared matrix adapter for 3D/mesh consumers, while `src/components/canvas/stlTopViewRenderer.ts` composes the same matrix with the canvas view transform. Legacy conversion inverse-rebases baked profile and silhouette geometry into the definition so `resolveStlData()` applies the instance matrix exactly once.

**Baked geometry is internal only.** Some existing rendering, editing, constraint, and copy paths still materialize a geometry-bearing `ResolvedSketchFeature`/`SketchFeature` as a derived cache or short-lived draft. That materialization is allowed only inside the runtime path that requires it. It must never be written into `Project.features`, undo/redo snapshots, or `.camj` output. Definition geometry remains the sole source of truth, and edited resolved views are folded back into definition data and/or instance transforms before project state is committed.

**Versioning and compatibility.** `Project.version` `3.0` is the first strict lightweight-instance format (`LATEST_PROJECT_VERSION` in `src/types/project.ts`). Saved 3.0 files contain canonical `featureDefinitions` and lightweight `features[]` only; older PureCutCNC builds that expect `features[].sketch` cannot open them correctly. Files from 1.0, 2.0, and 2.1 are decoded one way into the 3.0 model in memory. Opening such a file shows a compatibility warning and marks the project dirty; the original file remains untouched until the user saves, at which point the output is 3.0. Current 3.0 files open without that warning. Loading a future version still shows the newer-version warning and proceeds only when its rows satisfy the current strict shape. When bumping the schema, update `LATEST_PROJECT_VERSION`, the version union, and `src/store/helpers/projectFormat.ts` together.

**Key files.** `src/store/helpers/projectFormat.ts` (strict decode/legacy conversion), `resolveFeatures.ts` (resolved read model and commit boundary), `featureDefinitions.ts` (mint / clone / make-unique / GC), `instanceTransforms.ts` (matrix helpers incl. `invertMatrix`); the split types in `src/types/project.ts`; creation/transform/edit/snapshot/constraint wiring across `src/store/slices/*` and `src/store/helpers/*`.

## 5. Directory Map
- `src/store/`: Zustand state logic, split into functional slices (selection, pending actions, etc.).
- `src/engine/toolpaths/`: The heart of CAM logic (pocketing, profiling, v-carve, etc.).
- `src/engine/gcode/`: Post-processors and G-code generation logic.
- `src/components/canvas/`: Complex 2D interaction logic, snapping, and viewport transformations.
- `src/import/`: DXF and SVG parsers that normalize external geometry into the `.camj` format.
- `src/text/`: Logic for converting text and fonts into machinable geometry.
- `src/i18n/`: Typed localization layer — catalogs, locale registry, custom language packs, store/provider (see §9).
- `src/components/language/`: Language manager + custom-language editor dialogs (mirrors `src/components/theme/`).
- `src/styles/tablet.css`: Tablet-optimized styles for touch/mobile-friendly UI (see [`planning/TABLET_UX_DESIGN.md`](planning/TABLET_UX_DESIGN.md) for the current tablet UX contract).

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

## 9. Localization (i18n)

The interface is multi-language (issue #314); machining output is not. The
model mirrors the theme system: a typed registry of built-ins plus
user-created overlay packs, stored as application-local preferences —
switching language never dirties a project, never enters undo history, and
never changes `.camj` data or machine-facing output.

- **Catalog contract** (`src/i18n/catalog.ts`, `locales/`): flat
  dot-namespaced keys (`file.saveProject`), `{placeholder}` interpolation
  (params inserted verbatim; unknown tokens stay visible), and explicit
  `….one`/`….other` plural-variant keys selected via `Intl.PluralRules`.
  English is the canonical catalog — `MessageKey` derives from it, every
  other locale resolves against it per key, so a missing translation renders
  English, never a blank. One module per UI area (`shell.ts`, `sketch.ts`,
  `cam.ts`, …) merged in `locales/<locale>/index.ts`; zh-CN modules are
  typed as complete records of their English counterparts, and tests enforce
  completeness and placeholder parity.
- **Custom language packs** (`src/i18n/registry.ts`,
  `src/components/language/`): overrides-only overlays on a built-in base,
  with a versioned import/export envelope. Override keys unknown to the
  running build are preserved (catalogs grow per release; packs round-trip
  across versions), and a stale active-locale id falls back to a built-in.
  The manager/editor dialogs mirror the theme manager/editor: the
  placeholder-parity gate is the analogue of the theme contrast gate, and
  "Preview in app" persists the draft (Cancel restores the on-open
  snapshot) because language has no presentation-only preview channel.
- **Layering**: the engine stays free of i18n. Toolpath/postprocessor
  warnings are structured `{ code, params }` (`src/engine/toolpaths/
  warningCodes.ts`) translated at presentation by `src/i18n/warningText.ts`.
  Components translate via `useI18n()` (`t`/`tPlural`) so they re-render on
  locale change; module-level `translate()` exists only for non-React call
  sites (platform confirm dialogs, the pre-React fatal-error screen).
  `bootstrap.ts` resolves the locale and sets `document.documentElement.lang`
  before React mounts.
- **Deliberate boundaries** (never translated): serialized identifiers, enum
  values, feature/tool/operation type ids, user-authored names, filenames
  and file-type descriptors, unit symbols, G-code text, raw-JSON validation
  messages, registry-data display names (built-in theme names, theme
  token/group/contrast-check labels), and text drawn into the 2D canvas.
- **Rules for new UI**: every new user-facing string gets a key in its area
  module with zh-CN landing in the same change; no per-file translation
  wrappers; no hardcoded locale checks (`localeId === 'zh-CN' ? … : …` is
  forbidden — missing variants get their own keys); memoized translated
  content includes `languageTag` in its dependency array; count-bearing
  strings use `tPlural`. Terminology lives in `src/i18n/GLOSSARY.md`.

## 10. AI & MCP Integration (not yet implemented)
There is **no MCP server or agent-facing tool surface in the app today**. Earlier drafts of this document described an aspirational design; treat it as a future direction, not current behavior. When that work begins, the guiding principles will be:
- All mutations should flow through `projectStore` actions (same rule as the UI).
- An agent will need a project-state inspection call before making changes.
- Geometric modifications must produce valid closed profiles, except for explicit open-path engrave features.
