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
    - **2D (Clipper):** Uses `clipper-lib` for polygon clipping. Region masks are composed in `src/engine/toolpaths/regions.ts` (`buildRegionMask`) and resolved into typed operation domains by the area/centre/curve resolvers in `src/engine/toolpaths/regionDomain.ts` (`resolveRegionDomainArea` / `resolveRegionDomainCentre` / `resolveRegionDomainCurve`); the resolver table in [`planning/REGION_FEATURE_SEMANTICS.md`](planning/REGION_FEATURE_SEMANTICS.md) owns which operation kind uses which resolver. `src/engine/toolpaths/resolver.ts` resolves features and operations into Clipper input regions (V-carve line/subtract acceptance, even-odd nesting) — it does not resolve region masks.
    - **3D (Manifold):** Uses `manifold-3d` WASM to perform CSG (Constructive Solid Geometry) for the 3D preview.
- **Rendering:**
    - **Sketch View (2D):** `src/components/canvas/SketchCanvas.tsx` owns input, navigation and frame scheduling. Canvas is the default renderer; the sketch toolpath panel offers an application-local GPU opt-in (`purecutcnc.toolpathRenderer`, never part of `.camj`, history or CAM invalidation). `useSketchToolpathRenderer` lazy-loads one WebGL2 surface plus a foreground Canvas, disposes both on switch/unmount, and preserves GPU preference while visibly falling back to Canvas on failure. Context restoration or explicit Retry recovers GPU output.
    - **Toolpath backend contract:** `renderSketchToolpaths` passes the same ordered results, view transform, backing dimensions, visibility and emphasis to both backends. `gpuToolpathRenderer` retains full XY segments, uses shared layer/style rules, and resolves opaque coverage before applying alpha once per layer/feed bucket. `gpuToolpathAnnotations` composites the shared Canvas arrow/debug raster in each operation's painter slot; it reuses cached arrow placement and navigation deferral. Final sketch interaction overlays stay above paths. Booklet snapshots always use full-detail Canvas independently of the selected live renderer. GPU default enablement and Canvas retirement remain separate maintainer gates.
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
- **Machine snapshot** (issue #403): `meta.machineDefinitions` holds **zero or one** complete definition — the machine selected for this project — and `meta.selectedMachineId` always equals `machineDefinitions[0]?.id ?? null`. The pickable *library* (bundled definitions from the current build plus the app-local **My Machines** list) lives in `src/machine/` as an application preference and is never serialized into a `.camj`. `getActiveMachineDefinition(project)` is the export boundary and reads only the embedded snapshot, so library edits and app upgrades cannot change an existing project's G-code; replacing the snapshot is always an explicit, dirtying, undoable user action. Legacy files that stored a whole library are compacted on decode, with their custom definitions migrated into My Machines. See [`planning/G-code_Export_Design.md`](planning/G-code_Export_Design.md).

## 4. Feature References (Definitions & Instances)

PureCutCNC supports SketchUp-style **linked copies**: editing a shared shape updates every copy, while placement (move/rotate/resize/mirror), name, visibility, lock, and Z stay per-copy. The former monolithic feature is split into a **definition** (the shared shape) and **instances** (placed copies). The contract below is current; the completed migration plan and slice ledger are retained only as historical context in [`planning/archive/FEATURE_REFERENCES_Plan.md`](planning/archive/FEATURE_REFERENCES_Plan.md) and [`planning/archive/FEATURE_REFERENCES_Ledger.md`](planning/archive/FEATURE_REFERENCES_Ledger.md).

- **`FeatureDefinition`** (`project.featureDefinitions: Record<id, def>`): the shared, canonical, *untransformed* shape — `kind`, `profile`, `dimensions`, `text`, `stl`, `operation`.
- **`FeatureInstance`** (`project.features: FeatureInstance[]`) = every feature-tree row: `definitionId` + `transform` (a `Matrix2D` mapping definition-local geometry into world space), plus per-instance `name`, `folderId`, `visible`, `locked`, `z_top`/`z_bottom`, and `constraints`.
- A **linked copy** is another instance with the **same `definitionId`**. **Make Unique** clones the definition and repoints one instance. **Copy** makes a linked (reference) copy by default — governed by project `meta.copyMode` (default `'reference'`).

**Resolver boundary.** Canonical world geometry comes from `resolveFeatureInstance(project, id)` / `resolveProfile(definition, transform)` (`src/store/helpers/resolveFeatures.ts`), which composes definition + transform into a `ResolvedSketchFeature`. Toolpaths, hit-testing, rendering, export, and geometry-aware UI reads go through this boundary. A missing definition or invalid instance is rejected or skipped; there is no feature-ID identity fallback and no raw-row geometry fallback.

**Imported-model transforms.** Persisted STL/OBJ mesh vertices remain definition-local. `stl.scale` is applied to the raw mesh first, then the instance `Matrix2D` supplies the complete world-space X/Y affine placement for the Sketch top-view image, 3D preview, CSG, surface CAM/gouge checks, and model export; `z_top`/`z_bottom` continue to own the independent Z fit. `src/engine/importedModelTransform.ts` is the shared matrix adapter for 3D/mesh consumers, while `src/components/canvas/stlTopViewRenderer.ts` composes the same matrix with the canvas view transform. Legacy conversion inverse-rebases baked profile and silhouette geometry into the definition so `resolveStlData()` applies the instance matrix exactly once.

**Imported-model 3D orientation is per-definition — deliberately unlike 2D placement** (issue #241). `stl.orientation` (`{ rx, ry, rz }` degrees, applied X→Y→Z, absent = identity) rotates the definition-local mesh before `stl.scale` and the Z fit. It is a *shape* property, not placement: `silhouettePaths`, `profile`, and `topViewDataUrl` are all definition-level artifacts derived from mesh orientation, so a per-instance orientation would need a per-instance copy of each and would break the definition/instance split. The asymmetry with the 2D rotate tool — which *is* per-instance placement — is the price; **Make Unique** is the escape hatch for orienting one copy on its own. Rotation is **rigid**: `z_top`/`z_bottom` are recomputed from the rotated mesh's Z extent, anchored at `z_bottom`, because the Z fit would otherwise restretch the rotated mesh into the old band and silently distort the model. The orientation must appear in `stlTransformedGeometryCacheKey`; omitting it serves stale geometry to CAM and export. `src/components/project/importedModelArtifacts.ts` owns the one derivation shared by first import and re-orientation.

**Baked geometry is internal only.** Some existing rendering, editing, constraint, and copy paths still materialize a geometry-bearing `ResolvedSketchFeature`/`SketchFeature` as a derived cache or short-lived draft. That materialization is allowed only inside the runtime path that requires it. It must never be written into `Project.features`, undo/redo snapshots, or `.camj` output. Definition geometry remains the sole source of truth, and edited resolved views are folded back into definition data and/or instance transforms before project state is committed.

**Versioning and compatibility.** `Project.version` `3.0` was the first strict lightweight-instance format; `LATEST_PROJECT_VERSION` in `src/types/project.ts` tracks the newest schema this build understands (currently `3.1`). Saved 3.0 files contain canonical `featureDefinitions` and lightweight `features[]` only; older PureCutCNC builds that expect `features[].sketch` cannot open them correctly. Files from 1.0, 2.0, and 2.1 are decoded one way into the current model in memory. Opening such a file shows a compatibility warning and marks the project dirty; the original file remains untouched until the user saves, at which point the output is the current version. Current files open without that warning. Version `3.1` reinterpreted drilling's `retractHeight` as a distance above the material surface (issue #481); older files are migrated in memory on load, keyed on the on-disk version so relative files are never rewritten. Loading a future version still shows the newer-version warning and proceeds only when its rows satisfy the current strict shape. When bumping the schema, update `LATEST_PROJECT_VERSION`, the version union, and `src/store/helpers/projectFormat.ts` together.

**Key files.** `src/store/helpers/projectFormat.ts` (strict decode/legacy conversion), `resolveFeatures.ts` (resolved read model and commit boundary), `featureDefinitions.ts` (mint / clone / make-unique / GC), `instanceTransforms.ts` (matrix helpers incl. `invertMatrix`); the split types in `src/types/project.ts`; creation/transform/edit/snapshot/constraint wiring across `src/store/slices/*` and `src/store/helpers/*`.

## 5. Directory Map
- `src/store/`: Zustand state logic, split into functional slices (selection, pending actions, etc.).
- `src/engine/toolpaths/`: The heart of CAM logic (pocketing, profiling, v-carve, etc.).
- `src/engine/gcode/`: Post-processors and G-code generation logic.
- `src/components/canvas/`: Complex 2D interaction logic, snapping, and viewport transformations.
- `src/import/`: DXF and SVG parsers that normalize external geometry into the `.camj` format.
- `src/text/`: Logic for converting text and fonts into machinable geometry.
- `src/i18n/`: Typed localization layer — catalogs, locale registry, custom language packs, store/provider (see §9).
- `src/machine/`: Application machine library — bundled + **My Machines** registry, versioned local-storage persistence, and project-snapshot comparison (see §3).
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
- **Region resolution is typed per operation domain.** `regionDomain.ts` offers three resolvers (`resolveRegionDomainArea` / `resolveRegionDomainCentre` / `resolveRegionDomainCurve`); choosing the wrong one is a silent clearance bug — see the resolver table in [`planning/REGION_FEATURE_SEMANTICS.md`](planning/REGION_FEATURE_SEMANTICS.md). Never re-implement mask composition or dilation per operation: a clearance-rule fix in `regionDomain.ts` must reach every operation kind, and duplicated logic drifts (issue #476).
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
  `cam.ts`, …) merged in `locales/<locale>/index.ts`; zh-CN and de modules are
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
  module with zh-CN and de landing in the same change; no per-file translation
  wrappers; no hardcoded locale checks (`localeId === 'zh-CN' ? … : …` is
  forbidden — missing variants get their own keys); memoized translated
  content includes `languageTag` in its dependency array; count-bearing
  strings use `tPlural`. Terminology lives in `src/i18n/GLOSSARY.md`.

## 10. AI & MCP Integration (not yet implemented)
There is **no MCP server or agent-facing tool surface in the app today**. Earlier drafts of this document described an aspirational design; treat it as a future direction, not current behavior. When that work begins, the guiding principles will be:
- All mutations should flow through `projectStore` actions (same rule as the UI).
- An agent will need a project-state inspection call before making changes.
- Geometric modifications must produce valid closed profiles, except for explicit open-path engrave features.

## 11. End-to-End Pipeline (UI action → G-code)

Sections 2–8 own each layer's contract in isolation. This section owns the
**ordering between them**: the path one operation takes from a user action to
emitted G-code. Each stage names its entry point; per-stage detail stays in the
area `INDEX.md` files rather than being restated here.

### The path

1. **User action → store.** All mutations go through `projectStore` actions
   (`src/store/projectStore.ts`, slices under `src/store/slices/`). Operation
   target selection filters with `isMachinable` in `operationsSlice.ts` — this
   is where construction geometry stops being eligible for CAM (§3).
2. **Generation is driven from the app layer, not the engine.**
   `useToolpathGeneration` (`src/app/useToolpathGeneration.ts`) owns
   `generateToolpathForOperation`, which dispatches on `operation.kind` to
   exactly one generator. There is no single engine-level `generateToolpath()`:
   the engine exports one `generate*Toolpath` per strategy and the hook chooses
   between them. Results are cached per operation id and revalidated by
   `isCacheHit`, so a cache miss — not a store subscription — is what triggers
   recomputation.
3. **Inside a generator**, using `generatePocketToolpath` (`pocket.ts`) as the
   reference shape:
   1. `resolveFeatureInstance` (`src/store/helpers/resolveFeatures.ts`) —
      definition + transform into world geometry (§4 resolver boundary).
   2. `resolvePocketRegions` / `resolveInsideEdgeRegions` (`resolver.ts`) —
      features and operation into Clipper input regions.
   3. `buildRegionMask` (`regions.ts`) — compose the region mask.
   4. `resolveRegionDomainArea` / `…Centre` / `…Curve` (`regionDomain.ts`) —
      mask into a typed operation domain. Which resolver a kind uses is owned
      by the table in [`planning/REGION_FEATURE_SEMANTICS.md`](planning/REGION_FEATURE_SEMANTICS.md), not by the
      generator (§8).
   5. The pattern branch, dispatched through `OPERATION_PATTERN_SUPPORT`
      (`pocketPatterns.ts`) — kind → generator is step 2's job; pattern *within*
      a kind is this table's.
4. **Post-generation, back in the hook**, in this order: tab warnings → tab
   motion → `optimizeLinearMoves` → clamp warnings. The order is load-bearing —
   `applyTabWarnings` judges each tab against the cut Z range and the tab
   appliers raise that range, so warning after applying would report every
   applied tab as lying outside the range it just created.
5. **Emission.** `ExportDialog` resolves the machine through
   `getActiveMachineDefinition(project)` — the export boundary (§3) — then calls
   `runPostProcessor` (`src/engine/gcode/postprocessor.ts`), which owns arc
   fitting, modal tracking, and canned cycles.
6. **Parallel consumers.** The same `ToolpathResult` also feeds simulation
   (`simulateOperationHeightfield`, `src/engine/simulation/replay.ts`), the
   operation booklet, and model export. They consume generator output; they are
   not stages on the export path.

### Three crossings worth knowing

- **Y-down → Y-up happens exactly once**, at `projectToMachinePoint`
  (`src/engine/gcode/utils.ts`), called only from inside `postprocessor.ts`.
  Everything upstream — resolver, region mask, generators, simulation — is
  internal Y-down (§8).
- **Units are not converted per stage.** A project is stored in one system and
  every generator works in it unchanged. `convertProjectUnits` runs only on an
  explicit unit switch (`workpieceSlice.ts`) and on import merge
  (`src/import/camj.ts`); the postprocessor reads `project.meta.units` once as
  its output units. A generator that converts units is a bug, not a stage.
- **Construction geometry is excluded at each point of use, not filtered once
  upstream.** `isMachinable` gates CAM target selection
  (`operationsSlice.ts`); `modelFeatures()` gates CSG (`src/engine/csg.ts`) and
  the 3D viewport. Use those predicates rather than ad-hoc checks (§3).

Toolpath warnings raised anywhere in stages 3–4 are structured
`{ code, params }` (`warningCodes.ts`) and are translated only at presentation
by `src/i18n/warningText.ts` — the engine stays free of i18n (§9).
