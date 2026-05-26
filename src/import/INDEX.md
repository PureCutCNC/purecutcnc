# INDEX — src/import/

Parsers that convert external file formats into the internal `.camj` `SketchProfile` shape.
All parsers produce `ImportedShape[]` via an `ImportParseResult` and share the context
type in `types.ts`.

## Files

- `types.ts` — shared types: `ImportedShape`, `ImportContext`, `ImportParseResult`,
  `ImportInspection`
- `index.ts` — public re-exports; entry point for consumers
- `dxf.ts` — DXF parser (LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE, SPLINE, INSERT).
  Handles unit detection, layer filtering, T-junction splitting, and open-profile stitching.
  After stitching, passes every profile through `simplify.ts`.
- `svg.ts` — SVG parser (path, rect, circle, ellipse, line, polyline/polygon)
- `stl.ts` — STL parser; delegates mesh ops to `../engine/importedMesh.ts`
- `normalize.ts` — 2D affine-transform helpers and profile degeneracy check used by DXF
  and SVG parsers
- `simplify.ts` — post-import simplification pass: collinear-line merging, arc/circle
  fitting via Kasa least-squares. Called automatically by the DXF importer; can be
  applied to any `SketchProfile` from other importers via `simplifyProfile()`.
- `simplify.test.ts` — unit tests for the simplification pass (`npx tsx src/import/simplify.test.ts`)
- `stl.test.ts` — unit tests for the STL importer
- `obj.test.ts` — unit tests for the OBJ importer
