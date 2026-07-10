# INDEX — src/import/

Geometry file importers: SVG, DXF, STL, OBJ, and .camj.

## Files
- `types.ts` — import types: `ImportedShape`, `ImportContext`, `ImportGeometryMode`, `ClassificationResult`, `ClassifiedShape`
- `classifier.ts` — pure nesting classifier: determines feature roles (line/add/subtract) from geometry mode, paint intent, and strict geometric containment
- `normalize.ts` — profile normalization, affine transforms, degenerate-profile detection, and `createImportedFeature` builder
- `svg.ts` — SVG parser: path/shape/text extraction, unit handling, paint-intent tracking (fill/stroke)
- `dxf.ts` — DXF parser: entity extraction, INSERT expansion, polyline/spline/lwpolyline profiles, open-profile stitching, deduplication
- `stl.ts` — STL/OBJ mesh silhouette extraction
- `camj.ts` — .camj inspection and folder merge
- `index.ts` — barrel re-exports

## Tests
- `svg.test.ts` — SVG paint-intent: inherited/default fill, stroke-only, fill+stroke, inline style precedence, open geometry intent
- `classifier.test.ts` — nesting classifier: Paths/Solid regions/Auto modes, SVG paint intent, 2/3-level alternating nesting, smallest container, cross-layer nesting, ambiguity warnings
- `camj.test.ts` — .camj inspection and merge
- `stl.test.ts`, `obj.test.ts` — mesh silhouette extraction
