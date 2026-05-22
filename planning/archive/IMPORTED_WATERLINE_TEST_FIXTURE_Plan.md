---
status: Done
created: 2026-05-22
---

# Imported Waterline Test Fixture Plan

## Goal

Move the `3d-imported-block-test3.camj` regression asset out of the local-only `work/` area into a tracked test-fixture location so the imported-surface waterline regression runs the same way in GitHub Actions and local development.

## Approach

- Add a committed fixture folder for engine/toolpath tests and place the imported block `.camj` file there.
- Update the `finishSurface.test.ts` helper that loads this project so it resolves the fixture from the tracked location instead of `work/`.
- Keep the regression itself intact; this is a fixture-location change, not a behavioral rewrite.
- Update the nearest `INDEX.md` files for the new fixture folder.

## Files affected

- `planning/IMPORTED_WATERLINE_TEST_FIXTURE_Plan.md` — approval record and implementation scope
- `planning/INDEX.md` — move this work to In progress and clean stale plan drift
- `src/engine/toolpaths/finishSurface.test.ts` — load the committed fixture from the new test-fixture path
- *(new)* `src/engine/test-fixtures/INDEX.md` — fixture folder index
- *(new)* `src/engine/test-fixtures/3d-imported-block-test3.camj` — tracked regression asset used by `finishSurface.test.ts`
- `src/engine/INDEX.md` — mention the new fixture folder

## Tests

- Run `npx tsx src/engine/toolpaths/finishSurface.test.ts`
- Run `npm run build`

## Open questions / risks

- Keep fixture placement generic enough to reuse for future committed test assets without mixing them into runtime source folders.

## Out of scope

- Reworking the regression to build the fixture inline in TypeScript
- Any changes to the actual waterline geometry assertions
