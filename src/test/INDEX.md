# INDEX — src/test/

Shared test-only infrastructure.

## Files

- `projectFixtures.ts` — constructs authoritative format 3.0 projects from concise geometry-bearing test drafts, replaces strict feature sets, and resolves instance geometry for assertions

These helpers are for tests only. Production code must use the normal store creation paths or the project-format decoder.
- `pocketLeftover.ts` — geometric leftover measurement for the #550 pocket-finish defect: Clipper booleans at 1e6 counts per unit compute the morphological opening of the nominal region by the finish tool radius and subtract the swept envelope of the emitted cuts, so a reachable corner no round cutter can enter never counts as a defect. Test/diagnostic infrastructure; the CLI form is `scripts/issue-550-leftover-probe.ts`
