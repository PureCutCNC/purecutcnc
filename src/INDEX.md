# INDEX — src/

Application source. React + TypeScript + Zustand. Tauri-wrapped for desktop.

## Entry points
- `main.tsx` — React root, bootstraps the app
- `App.tsx` — top-level layout and routing between sketch / 3D / simulation views
- `App.css`, `index.css` — global styles

## Subfolders
- [app/](app/) — app-level orchestration hooks (starting with `useToolpathGeneration`)
- [store/](store/INDEX.md) — Zustand state (the single source of truth for projects). **All mutations go through here.**
- [engine/](engine/INDEX.md) — pure-logic CAM core: toolpaths, G-code, simulation, CSG, mesh import
- [components/](components/INDEX.md) — React UI (canvas, viewport3d, simulation, panels)
- [import/](import/) — DXF / SVG / STL / OBJ parsers that normalize into `.camj`; `camj.ts` adds partial-import (merge selected folders from another `.camj` into the current project)
- [text/](text/) — text-to-geometry (font → machinable paths); `index.ts` is the public API, `fontData.ts` the typed `parseFontJson` font-parse seam
- [sketch/](sketch/) — sketch geometry helpers (segment math, profile ops, visible-scene bounds in `sceneBounds.ts`, gear profile generation)
- [hooks/](hooks/INDEX.md) — shared cross-cutting React hooks (`useStableEvent`, `useWindowEvent`/`useEventListener`)
- [commands/](commands/INDEX.md) — shared desktop/tablet command descriptors and store-backed command predicates
- [types/](types/) — core data model. `project.ts` is the canonical `.camj` schema
- [utils/](utils/) — units, analytics, icons, version, misc helpers
- [platform/](platform/) — platform abstraction (web vs Tauri), desktop integration, feature clipboard helpers, and hidden-iframe HTML printing (`printDocument.ts`)
- [styles/](styles/) — shared CSS (incl. `tablet.css` for touch UX)
- [assets/](assets/) — editable per-icon SVG sources in `icons/` (see `icons/README.md`), fonts, etc.
- [test/](test/INDEX.md) — shared helpers for constructing strict current-format test projects

## Loose files
- `toolLibrary.ts` — built-in tool definitions and tool-library helpers

## Conventions
- Strict TS, no `any`. See `types/project.ts` for canonical data shapes.
- 2D internal coords have Y growing downward; G-code export inverts to Cartesian. See [ARCHITECTURE.md §6](../ARCHITECTURE.md).
- Use `utils/units.ts` for mm/inch conversions — never hardcode unit math.
