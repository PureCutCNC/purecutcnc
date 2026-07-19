# INDEX — src/engine/designPrint/

Vector renderer for the 2D design/sketch view: printing (issue #254) and
geometry-only SVG export (issue #257). DOM-free: layout math and SVG/HTML
generation are plain string/number logic so the whole pipeline is
unit-testable without a browser. All physical quantities are millimetres
internally; user inputs (margins, offsets, custom paper) are project units
converted by the layout.

## Files

- `types.ts` — print options (paper preset, orientation, margins, print area, scale mode, content toggles, color mode), the resolved `DesignPrintLayout`, SVG-export options (`DesignSvgExportOptions`), and per-project defaults.
- `layout.ts` — pure page math: paper presets, printable/drawable area, print-bounds resolution (visible extents / stock extents / current view), fit/actual/custom scale, custom-scale parsing, centering + registration offsets, clipping detection.
- `svg.ts` — converts project geometry (stock, features with text resolved, imported-model silhouettes, tabs/clamps, origin, dimensions, grid, backdrop, toolpath overlays, localized footer/title block) into a self-contained SVG string in physical mm. `buildDesignPrintSvg` renders the full print page; `buildDesignSvgExport` renders the shared world content as a standalone editable SVG at true 1:1 (tight viewBox, per-feature groups, outlines only, no page scaffolding).
- `html.ts` — wraps the SVG in a printable HTML document (`@page` sizing, white background, no app CSS).
- `index.ts` — public exports.

## Tests

- `designPrint.test.ts` — printable-area math, scale conversion (mm/inch actual size, fit aspect, custom ratio parsing), clipping detection, SVG/HTML smoke tests, and geometry-only SVG export (viewBox/physical size, feature groups, content toggles) over a small deterministic project. Run with `npx tsx src/engine/designPrint/designPrint.test.ts`.

## Consumers

- `src/components/export/PrintDesignDialog.tsx` — the print dialog (preview + options UI).
- `src/platform/printDocument.ts` — prints the generated HTML via a hidden iframe.
- `src/engine/modelExport/svg.ts` — the SVG entry in the Export Model format registry (backed by `buildDesignSvgExport`).
