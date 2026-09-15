# INDEX — src/import/

Geometry file importers: SVG, DXF, STL, OBJ, STEP, and .camj.

## Files
- `types.ts` — import types: `ImportedShape`, `ImportContext`, `ImportGeometryMode`, `ClassificationResult`, `ClassifiedShape`; the accepted extensions (`.stp` detects as `step`)
- `stepUnits.ts` — STEP declared length units: only units a `GLOBAL_UNIT_ASSIGNED_CONTEXT` assigns count, mapped to the Open CASCADE output unit and the dialog's source-units default (issue #784)
- `stepTessellation.ts` — pure STEP tessellation core: Open CASCADE read → one named body per solid, absolute chordal tolerance, triangle cap, OCCT's parse diagnostic; runs in the worker and in Node tests
- `step.worker.ts` — module worker that loads the `occt-import-js` WASM (a `?url` asset passed as `wasmBinary`) and tessellates one file per worker
- `stepImportClient.ts` — main-thread client: byte and triangle caps (with the measurements they came from), a one-shot worker per import, cancellation by `terminate()`, typed failures
- `stepProtocol.ts` — STEP failure codes and worker message validation
- `classifier.ts` — pure nesting classifier: determines import roles and exposes the shared smallest-strict-container operation inference used by manual closed-feature defaults
- `normalize.ts` — profile normalization, affine transforms, degenerate-profile detection, and `createImportedFeature` builder
- `svg.ts` — SVG parser: path/shape/text extraction, unit handling, paint-intent tracking (fill/stroke)
- `dxf.ts` — DXF parser: entity extraction, INSERT expansion, polyline/spline/lwpolyline profiles, open-profile stitching, deduplication
- `stl.ts` — STL/OBJ mesh silhouette extraction
- `camj.ts` — .camj inspection and folder/stock merge through the shared strict format decoder, including legacy-source conversion
- `index.ts` — barrel re-exports

## Tests
- `svg.test.ts` — SVG paint-intent: inherited/default fill, stroke-only, fill+stroke, inline style precedence, open geometry intent
- `classifier.test.ts` — nesting classifier: Paths/Solid regions/Auto modes, SVG paint intent, alternating nesting, smallest container, cross-layer nesting, ambiguity warnings, and manual-operation inference
- `camj.test.ts` — current-format .camj inspection plus folder, linked-instance, asset, constraint, operation, and stock merge coverage
- `stl.test.ts`, `obj.test.ts` — mesh silhouette extraction
