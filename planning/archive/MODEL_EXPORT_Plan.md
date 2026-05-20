---
status: Done
created: 2026-05-18
---

# Model Export Plan

## Goal

Let users export the current project's 3D model to common mesh/CAD interchange formats so they can hand it off to slicers, viewers, or other CAM tools. Ship STL first (binary + ASCII), but build the surrounding plumbing so adding OBJ, 3MF, STEP, etc. later is a small, self-contained change instead of another round of UI work.

User-visible outcome: a new "Export Model…" entry (separate from the existing G-code export) opens a dialog where the user picks a format, sets format-specific options (binary vs ASCII for STL, what to include), picks a filename, and clicks Export — which then drives the native Save dialog (or browser save flow) to choose the location.

## Approach

### 1. Format registry (new)

Introduce a small registry in `src/engine/modelExport/` so each format is one file:

```ts
// src/engine/modelExport/types.ts
export interface ModelExportFormat<TOptions = unknown> {
  id: string                        // 'stl'
  name: string                      // 'STL (Stereolithography)'
  extension: string                 // 'stl'
  mimeType: string                  // 'model/stl' (or 'application/octet-stream')
  defaultOptions: TOptions
  // Renders the React fragment for format-specific options.
  renderOptions: (props: {
    options: TOptions
    onChange: (next: TOptions) => void
  }) => React.ReactNode
  // Produces the file bytes/text from the assembled mesh + user options.
  export: (input: ModelExportInput, options: TOptions) => Promise<ModelExportOutput>
}

export interface ModelExportInput {
  project: Project
  // Pre-built triangle mesh in *world* coordinates (Y-up, the same orientation
  // that's shown in the 3D viewport, with the render-only inversions undone so
  // the exported geometry uses the project's design coordinates).
  triangles: { positions: Float32Array, index: Uint32Array }
}

export interface ModelExportOutput {
  data: Uint8Array | string
  encoding: 'binary' | 'text'
}
```

`src/engine/modelExport/index.ts` exports `MODEL_EXPORT_FORMATS: ModelExportFormat[]` and a `getModelExportFormat(id)` helper. Adding OBJ later = add `obj.ts` and one line in the index.

### 2. Mesh assembly (new)

`src/engine/modelExport/assemble.ts` builds the triangle mesh once, format-agnostic:

- Reuse the same Manifold pipeline `buildBooleanModel` already uses in `src/engine/csg.ts`, but stop one step short of `manifoldMeshToGeometry` so we keep raw `vertProperties` + `triVerts`. Refactor `csg.ts` to extract a `buildBooleanModelMesh(project, visibleFeatures)` that returns `{ positions, index } | null`; `buildBooleanModel` becomes a thin wrapper around it that wraps in a Three.js mesh.
- Include STL `add` features in the boolean union (today `buildBooleanModel` skips them because they're drawn as an overlay; for export the user expects the full visible model — confirm in the dialog with an "include imported meshes" option, default on).
- Skip `region` features and open polyline features (they aren't real solids).
- "Machined result" (stock minus subtracts) is explicitly a follow-up. v1 exports only the design model.
- **Coordinates: internal design coords, preserved 1:1.** Z is up (matches STL convention). Y is whatever the rest of the app uses internally (screen-Y from the 2D sketch). Rationale: the STL importer in this codebase reads triangle positions straight into internal coords without any Y flip, so exporting with a Y-flip breaks round-trip — the re-imported model lands mirrored across the X-axis from the original. Exporting in internal coords keeps round-trip exact and matches what the 3D viewport and G-code pipeline already treat as canonical. External viewers/slicers see the model with the sketch top-view Y direction; Z is still up so it's right-side-up. Users who care about a specific Y orientation in a downstream tool can rotate it there.

### 3. STL writer (new)

`src/engine/modelExport/stl.ts`:

- `STLOptions = { format: 'binary' | 'ascii', includeImportedMeshes: boolean }`
- Binary STL: standard 80-byte header + uint32 triangle count + 50 bytes/triangle (12 floats + 2-byte attr). Compute per-face normal from the three vertices.
- ASCII STL: emit `solid <name> … endsolid` with `facet normal … outer loop … endloop endfacet`.
- Unit test (`stl.test.ts`): round-trip a known mesh through the binary writer and re-parse it with the existing `src/import/stl.ts` parser; assert vertex count, triangle count, and bounds match.

### 4. Platform: binary file save (extension)

The current `PlatformApi` only has `saveTextFile`. Add `saveBinaryFile(suggestedName, data: Uint8Array, extension, existingPath?)`:

- **Browser** (`src/platform/browser.ts`): reuse the existing `saveFile` helper but pass the `Uint8Array` directly to `new Blob([...])` / `writable.write(...)` (both accept binary). Generalize `saveFile` to take `BlobPart` instead of `string`.
- **Desktop** (`src/platform/desktop.ts`): use `writeFile` (binary) from `@tauri-apps/plugin-fs` instead of `writeTextFile`.

ASCII STL can still go through `saveTextFile`; binary STL needs `saveBinaryFile`.

### 4b. Curve quality control

2D-extrude features pass through `profileToPolygon` in `csg.ts`, which uses a fixed `ARC_STEP_RADIANS = π/18` (10°) — fine for the viewport but coarse for STL. We parameterize this:

- `profileToPolygon(profile, arcStepRadians)` and `buildFeatureSolid(..., arcStepRadians?)` take an optional override; default preserves viewport behavior. Bezier subdivision scales the same way so curve quality is consistent.
- New `CurveQuality` type (`'coarse' | 'normal' | 'fine' | 'very_fine'`) maps to `{10°, 5°, 2°, 1°}` per arc segment in `CURVE_QUALITY_ARC_STEP_RADIANS`.
- `ModelExportAssembleOptions` carries `curveQuality`; the assemble pass threads it into `buildFeatureSolid`.
- Dialog adds a `Select` for "Curve quality" (default Normal/5°) above the format-specific options. Re-assembles on change so the triangle count summary reflects the choice.

### 5. Model Export dialog (new)

`src/components/export/ModelExportDialog.tsx`:

- Format dropdown (driven by `MODEL_EXPORT_FORMATS`) — disabled options grey out cleanly when only STL exists, so the UI doesn't visibly change once we add formats.
- Filename input (defaulted to `project.meta.name`, sanitized).
- Format-specific options panel rendered by `format.renderOptions(...)` — for STL: binary/ascii radio, "Include imported (STL) meshes" checkbox.
- A small summary line (e.g. "Triangles: 12,438 — est. file size: 610 KB"). Compute size from triangle count for binary STL; skip for ASCII.
- Footer: Cancel / Export. Export calls the chosen format's `export(...)`, then `platform.saveBinaryFile` or `saveTextFile` depending on `encoding`. Show warnings if the mesh is empty.
- Track a `lastModelExportPath` in the store (mirrors the existing `lastExportPath` for G-code) so subsequent exports default to the same folder. Plumb via `markModelExported(path)` on the project store.

Reuse the existing dialog CSS (`dialog-backdrop`, `dialog`, `dialog-section`, …) — no new styling needed.

### 6. Entry point

- Add an "Export model" icon button in the global toolbar's first group, directly after the existing "Import geometry" button. Use the existing `export` icon in `public/icons.svg` (same tray glyph as `import`, arrow reversed — no new icon to author).
- Wire it through `GlobalActions` → `Toolbar` → `App.tsx` the same way `onImport` is plumbed today, adding an `onExportModel` prop alongside `onImport`.
- Add a state pair in `App.tsx` (`showModelExportDialog`) wired identically to the G-code dialog.
- Leave the existing CAM panel G-code "Export" button untouched.
- Hook into desktop menu later if needed — out of scope for v1.

## Files affected

- *(new)* `src/engine/modelExport/types.ts` — registry/option types.
- *(new)* `src/engine/modelExport/index.ts` — `MODEL_EXPORT_FORMATS`, `getModelExportFormat`.
- *(new)* `src/engine/modelExport/assemble.ts` — builds `{positions,index}` from the project.
- *(new)* `src/engine/modelExport/stl.ts` — binary + ASCII STL writers.
- *(new)* `src/engine/modelExport/stl.test.ts` — unit tests (round-trip through importer).
- `src/engine/csg.ts` — extract `buildBooleanModelMesh` so it can be shared without the Three.js wrapping; no behavior change for the viewport.
- `src/engine/INDEX.md` — list the new `modelExport/` subfolder.
- *(new)* `src/components/export/ModelExportDialog.tsx` — the dialog.
- `src/platform/api.ts` — add `saveBinaryFile` to the interface.
- `src/platform/browser.ts` — implement `saveBinaryFile`, generalize internal `saveFile` to accept `BlobPart`.
- `src/platform/desktop.ts` — implement `saveBinaryFile` via `writeFile`.
- `src/store/projectStore.ts` (or matching slice) — add `lastModelExportPath` + `markModelExported`.
- `src/components/layout/Toolbar.tsx` — add `onExportModel` prop on `GlobalActions` / `Toolbar` / `GlobalToolbar` / `CreationToolbar`; render an `export`-icon `ToolbarActionButton` next to the existing `import` button.
- `src/App.tsx` — `showModelExportDialog` state, render `ModelExportDialog`, pass `onExportModel` to the toolbar wherever `onImport` is already passed.

## Tests

- `src/engine/modelExport/stl.test.ts`:
  - Binary writer: triangle/vertex counts and AABB match input after re-parsing with `src/import/stl.ts`.
  - ASCII writer: same round-trip, plus a small text-shape assertion (`solid` / `endsolid`, expected number of `facet` blocks).
  - Empty input → returns valid empty STL (0 triangles).
- `src/engine/modelExport/assemble.test.ts` (optional, light): with a trivial project (one box add feature), asserts the resulting mesh has the expected triangle count and AABB.
- No UI snapshot tests — dialog behavior is exercised manually via `npm run build` + browser smoke check (the user runs the dev server).

## Open questions / risks

- **What does "the model" mean?** v1 = the design model that's visible in the 3D viewport (the unioned manifold result + STL adds when the option is on). The "machined result" (stock minus subtracts) is a separate export — explicitly a follow-up.
- **Non-manifold STL adds.** `buildFeatureSolid` already falls back to a 2.5D silhouette extrusion when an imported STL isn't manifold. The export will inherit that fallback, so a non-manifold STL "add" gets exported as a blocky extrusion. Worth a non-blocking warning in the dialog if any feature hit the fallback.
- **Large meshes.** Binary STL is fine to several million triangles, but the manifold union can be slow for very heavy STL features. We already accept this slowness in the 3D viewport, so no new perf work in v1; if it bites, we can cache the assembled mesh keyed off the same hash `buildBooleanModel` uses.
- **iOS / mobile save.** Browser save flow already works for G-code; same path applies. Binary STL via `Blob` works on all current targets.

## Out of scope

- OBJ, 3MF, STEP exporters (the registry makes these straightforward follow-ups).
- Exporting the "machined-result" geometry (stock minus subtracts).
- Per-feature / per-selection export.
- Color / material export (vertex colors, MTL).
- Desktop menu entry for Export Model (G-code menu plumbing stays as-is).
- Tabs and clamps in the exported mesh (they're CAM scaffolding, not the model).
