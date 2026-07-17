# INDEX — src/components/

React UI. Components are organized by feature area. Plain CSS for styling — no UI libraries.

## Top-level files
- `AppErrorBoundary.tsx` — top-level React error boundary
- `ErrorScreen.tsx` — fatal-error fallback UI
- `Icon.tsx` — `<Icon id="..." />` renders an SVG sprite reference (`icons.svg#id`)
- `IconGallery.tsx` — dev/debug grid of all available icons
- `Select.tsx` — shared styled `<select>` wrapper
- `ToolpathVisibilityPanel.tsx` — toggles for showing/hiding toolpath layers
- `toolpathVisibility.ts` — `ToolpathVisibility` type + default visibility constant (kept out of the panel component for fast refresh)
- `UnsupportedMobileScreen.tsx` — phone-sized-device blocker screen shown instead of the app (extracted from `main.tsx`)
- `errorFormat.ts` — shared error formatting
- `useIconIds.ts` — hook listing available icon IDs

## Subfolders (by area)
- `common/` — shared cross-panel UI primitives. `DisclosureSection` is the reusable collapsible "Advanced" section (progressive disclosure); its open/collapsed state persists via the pure helpers in `common/disclosureState.ts`.
- `canvas/` — 2D sketch canvas: drawing, snapping, panning/zoom, pointer handling, creation workflow panels, and overlap disambiguation through `useOverlapFeaturePicker` / `OverlapFeaturePicker`. `previewPrimitives.ts` keeps Line/Construction geometry stroke-only; `previewPrimitives.test.ts` covers that rendering-role policy. Dimension annotations + tape measure render via `canvas/dimensionRendering.ts` (pure geometry in `sketch/dimensions.ts`); `canvas/operationSnapshot.ts` renders static operation booklet images.
- `viewport3d/` — Three.js 3D preview of the CSG-derived model, including toolpath overlay helpers
- `simulation/` — voxel toolpath simulation viewport and playback controls
- `cam/` — CAM panels (tools, operations, parameters); per-parameter reference icons via `OperationParameterReference`
- `feature-tree/` — sketch feature tree UI (reordering, visibility, grouping) plus the extracted feature/tab/clamp context menu
- `layout/` — app shell (toolbars, sidebars, mode switching), including the shared `AppearanceControl` and `LanguageControl` (interface-language selector backed by `src/i18n/`); toolbar internals are documented in `layout/toolbar/INDEX.md`
- `project/` — project-level UI (new/open/save, stock, machine, units), including `UnitConversionDialog` for the explicit convert-vs-reinterpret units decision. Import dialog is `ImportGeometryDialog` with analysis delegated to `useImportGeometryAnalysis` (parse/classify caching hook), `ImportGeometryModeSection` (mode select + summary), and `importModelFile` (3D model import utility).
- `export/` — export dialogs: G-code (`ExportDialog`, with a per-operation checklist backed by the pure helpers in `exportOperationSelection.ts`), the Export Model dialog (`ModelExportDialog`, STL mesh + 2D design SVG via `src/engine/modelExport/`), and the Print Design dialog (`PrintDesignDialog`, backed by `src/engine/designPrint/`)
- `machine/` — machine definition editor (focused form + raw JSON + Zod validation)
- `theme/` — theme manager + guided custom-theme editor dialogs (see `theme/INDEX.md`); backed by the registry/selection model in `src/theme/`
- `about/` — About dialog (web only; version info + links). Desktop uses the native About menu.
- `ai/` — MCP / agent-facing UI (placeholder — MCP not yet implemented)
- `onboarding/` — first-run / empty-state UI (`EmptyStateOverlay` shown over the center viewport when the project has no features)

## Conventions
- Heavy compute (CSG, toolpath gen, sim) is debounced. See `Viewport3D` (150–300ms typical).
- Mutations go through `projectStore` actions only — never mutate Zustand state directly from components.
- For touch/tablet styling see `src/styles/tablet.css` and [`planning/TABLET_UX_DESIGN.md`](../../planning/TABLET_UX_DESIGN.md).
