# INDEX — src/components/

React UI. Components are organized by feature area. Plain CSS for styling — no UI libraries.

## Top-level files
- `AppErrorBoundary.tsx` — top-level React error boundary
- `ErrorScreen.tsx` — fatal-error fallback UI
- `Icon.tsx` — `<Icon id="..." />` renders an SVG sprite reference (`icons.svg#id`)
- `IconGallery.tsx` — dev/debug grid of all available icons
- `Select.tsx` — shared styled `<select>` wrapper
- `ToolpathVisibilityPanel.tsx` — toggles for showing/hiding toolpath layers
- `errorFormat.ts` — shared error formatting
- `useIconIds.ts` — hook listing available icon IDs

## Subfolders (by area)
- `canvas/` — 2D sketch canvas: drawing, snapping, panning/zoom, pointer handling
- `viewport3d/` — Three.js 3D preview of the CSG-derived model, including toolpath overlay helpers
- `simulation/` — voxel toolpath simulation viewport and playback controls
- `cam/` — CAM panels (tools, operations, parameters)
- `feature-tree/` — sketch feature tree UI (reordering, visibility, grouping)
- `layout/` — app shell (toolbars, sidebars, mode switching)
- `project/` — project-level UI (new/open/save, stock, machine, units)
- `export/` — export dialogs (G-code, SVG, DXF, STL preview)
- `ai/` — MCP / agent-facing UI (placeholder — MCP not yet implemented)

## Conventions
- Heavy compute (CSG, toolpath gen, sim) is debounced. See `Viewport3D` (150–300ms typical).
- Mutations go through `projectStore` actions only — never mutate Zustand state directly from components.
- For touch/tablet styling see `src/styles/tablet.css` and `planning/TABLET_UX_COMBINED_PLAN.md`.
