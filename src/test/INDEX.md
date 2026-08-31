# INDEX — src/test/

Shared test-only infrastructure.

## Files

- `spreadLimit.ts` — `maxSpreadableLength()`, the largest array this engine can spread into a call, measured by search rather than hard-coded (issue #668). Tests that must exceed the argument limit assert against the measured value, so a fixture that quietly stopped exceeding it fails instead of passing while proving nothing
- `waterlineHillsFixture.ts` — the rolling-hills-with-flats model #698 is calibrated against, generated rather than checked in as an STL so the shape is readable and the resolution is a parameter. It mixes the four surface characters a 3D finish has to handle at once — a large flat background, flat plateau tops on clamped domes, steep dome flanks, and a gentle ramp — because waterline is uneven across them by construction. `finishSurfaceWaterlineBudget.test.ts` runs a coarse mesh four times; `scripts/waterline-coverage-probe.ts` runs a fine one whose facets do not show up in the measurement
- `projectFixtures.ts` — constructs authoritative format 3.0 projects from concise geometry-bearing test drafts, replaces strict feature sets, and resolves instance geometry for assertions

These helpers are for tests only. Production code must use the normal store creation paths or the project-format decoder.
- `pocketLeftover.ts` — geometric leftover measurement for the #550 pocket-finish defect: Clipper booleans at 1e6 counts per unit compute the morphological opening of the nominal region by the finish tool radius and subtract the swept envelope of the emitted cuts, so a reachable corner no round cutter can enter never counts as a defect. Test/diagnostic infrastructure; the CLI form is `scripts/issue-550-leftover-probe.ts`
