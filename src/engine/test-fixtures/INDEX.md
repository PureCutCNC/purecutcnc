# INDEX — src/engine/test-fixtures/

Committed fixtures used by engine tests.

## Files
- `3d-imported-block-test3.camj` — imported-surface regression project used by `toolpaths/finishSurface.test.ts` and `toolpaths/finishSurfaceCleanup.test.ts`
- `model-in-pocket.camj` — imported-model-in-containing-pocket regression project used by `toolpaths/finishSurfaceCleanup.test.ts`
- `v-carve-noise-test.camj` — linked small/large Droid Serif `gA` regression project used to keep medial V-carve sampling and corner filtering free of glyph noise
- `pocket-rounded-corner-coverage.camj` — a pocket whose clearing rings pinch between an elliptical island and a stepped wall, used by `toolpaths/pocketClearance.test.ts`. The fixture that caught corner smoothing leaving stock behind (issue #546): three other pocket fixtures stayed clean while this one showed a 0.21 x 0.05in ridge standing 0.0057in proud
- `pocket-finish-island-leftover.camj` — reduced from issue #550's repro (untracked `work/feed-reduction-test2.camj`): a 3 x 2 in rect with a 10-point star island, 1/4 in offset rough (0.04/0.04 stock) plus 1/8 in offset finish (0/0), round corners on, used by `toolpaths/pocketFinishLeftover.test.ts`. Before the fix the finish pass left 0.015495 in² of reachable stock in 8 patches at the island corners; after, clear (0.000037 in², all hairline residue) — the finish floor had been skipping the tree regions' island contours, the one ring the rough pass always cuts (#550)
