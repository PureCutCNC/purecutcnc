# INDEX — src/

Application source. React + TypeScript + Zustand. Tauri-wrapped for desktop.

## Entry points
- `main.tsx` — React root, bootstraps the app
- `App.tsx` — top-level layout and routing between sketch / 3D / simulation views
- `App.css`, `index.css` — global styles

## Subfolders
- [store/](store/INDEX.md) — Zustand state (the single source of truth for projects). **All mutations go through here.**
- [engine/](engine/INDEX.md) — pure-logic CAM core: toolpaths, G-code, simulation, CSG, mesh import
- [components/](components/INDEX.md) — React UI (canvas, viewport3d, simulation, panels)
- [import/](import/) — DXF / SVG / STL / OBJ parsers that normalize into `.camj`; `camj.ts` adds partial-import (merge selected folders from another `.camj` into the current project)
- [text/](text/) — text-to-geometry (font → machinable paths)
- [sketch/](sketch/) — sketch geometry helpers (segment math, profile ops)
- [types/](types/) — core data model. `project.ts` is the canonical `.camj` schema
- [utils/](utils/) — units, analytics, icons, version, misc helpers
- [platform/](platform/) — platform abstraction (web vs Tauri)
- [styles/](styles/) — shared CSS (incl. `tablet.css` for touch UX)
- [assets/](assets/) — `icons.camj` source, fonts, etc.

## Loose files
- `toolLibrary.ts` — built-in tool definitions and tool-library helpers

## Conventions
- Strict TS, no `any`. See `types/project.ts` for canonical data shapes.
- 2D internal coords have Y growing downward; G-code export inverts to Cartesian. See [ARCHITECTURE.md §6](../ARCHITECTURE.md).
- Use `utils/units.ts` for mm/inch conversions — never hardcode unit math.
