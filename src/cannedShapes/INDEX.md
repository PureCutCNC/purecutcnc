# INDEX — src/cannedShapes/

Canned-shape model (issue #1112): a feature definition that stores a shape's
kind and parameters and generates its outlines on read, the way Text stores a
string and generates glyphs.

## Files

- `types.ts` — the extension point slices D–G code against: `CannedShapeGenerator` (`kind`, `labelKey`, `generate`, optional `normalizeParams`/`convertParams`, `summary`), `CannedShapeOutline`, `CannedShapeSummary`, and `defineCannedShape` for type erasure at registration.
- `registry.ts` — generator and editor maps. Built-ins seed from `generators/`; tests register test-only shapes with `registerCannedShapeGenerator`. `registerCannedShapeEditor` is the hook later slices use to open their dialog from the Properties "Edit <shape>…" button.
- `index.ts` — the read path: `isCannedFeature`, `resolveCannedShapeShapes` (nesting depth → Add/Subtract, placement transform, mirror winding), `resolveCannedShapeProfiles`, `cannedShapeFrame`, `cannedShapeSummary`, `cannedShapeLabelKey`.
- `generators/index.ts` — the built-in list. Slices D–G export a generator from their own module and append it here; nothing else in the model changes. A generator module imports `defineCannedShape` from `../types`, never from this package's index (that would cycle through the registry).
- `cannedShapes.test.ts` — model tests; runs the two test-only generators from `src/test/cannedShapeFixture.ts` because slice A ships no real shape.

## Rules

- Parameters are JSON-only (`CannedShapeParams`), so save → load → regenerate is exact.
- A generator that stores lengths supplies `convertParams`; `convertProjectUnits` routes the definitions through it, so a unit switch converts the parameters with the frame.
- The stored `definition.profile` is a placement frame derived from the parameters, never the geometry.
- Closed outlines nest by containment: depth 0 = the feature's operation, 1 = the opposite, 2 = the operation again. Open outlines keep the feature's operation.
