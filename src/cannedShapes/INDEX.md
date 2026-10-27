# INDEX — src/cannedShapes/

Canned-shape model (issue #1112): a feature definition that stores a shape's
kind and parameters and generates its outlines on read, the way Text stores a
string and generates glyphs.

## Files

- `types.ts` — the extension point slices D–G code against: `CannedShapeGenerator` (`kind`, `labelKey`, `generate`, optional `generateMesh`/`capabilities`/`normalizeParams`/`convertParams`, `summary`), `CannedShapeOutline`, `CannedShapeSummary`, `CannedShapeMesh`, `CannedShapeCapabilities`, and `defineCannedShape` for type erasure at registration.
- `registry.ts` — generator and editor maps. Built-ins seed from `generators/`; tests register test-only shapes with `registerCannedShapeGenerator`. `registerCannedShapeEditor` is the hook later slices use to open their dialog from the Properties "Edit <shape>…" button.
- `index.ts` — the read path: `isCannedFeature`, `resolveCannedShapeShapes` (nesting depth → Add/Subtract, placement transform, mirror winding), `resolveCannedShapeProfiles`, `cannedShapeFrame`, `cannedShapeSummary`, `cannedShapeLabelKey`, `cannedShapeCapabilities`/`cannedShapeIsExpandable`, and `generateCannedShapeMesh`.
- `cache.ts` — generated-outline cache keyed on kind + canonical normalized parameters; a parameter change is a miss, registering a replacement generator clears that kind. Hit testing, hover and redraw share one generation.
- `model.ts` — the mesh half of the contract: builds a model kind's mesh into `Project.modelAssets` and points `definition.stl.meshAssetId` at it, so CSG, surface toolpaths, preview and export consume it like an imported model. `rebuildCannedShapeModels` runs on load and unit conversion; `applyFeaturePatch` runs `rebuildCannedShapeModelDefinitions` for a parameter edit.
- `generators/index.ts` — the built-in list. Slices D–G export a generator from their own module and append it here; nothing else in the model changes. A generator module imports `defineCannedShape` from `../types`, never from this package's index (that would cycle through the registry).
- `cannedShapes.test.ts` — model tests; runs the test-only generators from `src/test/cannedShapeFixture.ts` because slice A ships no real shape.
- `cannedShapeCache.test.ts` — three resolutions call a generator once, a parameter change misses, registration invalidates, and key order does not defeat the key.

## Rules

- Parameters are JSON-only (`CannedShapeParams`), so save → load → regenerate is exact.
- A kind with `generateMesh` is a model: its mesh is derived from the parameters, rebuilt on change/load/unit conversion, and non-expandable by default capability.
- A generator that stores lengths supplies `convertParams`; `convertProjectUnits` routes the definitions through it, so a unit switch converts the parameters with the frame.
- The stored `definition.profile` is a placement frame derived from the parameters, never the geometry; hit testing and rendering read the generated outlines instead.
- `capabilities.expandable` defaults to true. A model sets it false and Properties hides "Expand to features".
- Closed outlines nest by containment: depth 0 = the feature's operation, 1 = the opposite, 2 = the operation again. Open outlines keep the feature's operation.
