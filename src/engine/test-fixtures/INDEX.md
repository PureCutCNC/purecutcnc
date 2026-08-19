# INDEX — src/engine/test-fixtures/

Committed fixtures used by engine tests.

## Files
- `3d-imported-block-test3.camj` — imported-surface regression project used by `toolpaths/finishSurface.test.ts` and `toolpaths/finishSurfaceCleanup.test.ts`
- `model-in-pocket.camj` — imported-model-in-containing-pocket regression project used by `toolpaths/finishSurfaceCleanup.test.ts`
- `v-carve-noise-test.camj` — linked small/large Droid Serif `gA` regression project used to keep medial V-carve sampling and corner filtering free of glyph noise
- `pocket-rounded-corner-coverage.camj` — a pocket whose clearing rings pinch between an elliptical island and a stepped wall, used by `toolpaths/pocketClearance.test.ts`. The fixture that caught corner smoothing leaving stock behind (issue #546): three other pocket fixtures stayed clean while this one showed a 0.21 x 0.05in ridge standing 0.0057in proud
