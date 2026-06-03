---
status: Done
created: 2026-06-03
---

# Windows Test Runner Plan

## Goal

Fix the Windows CI build so `npm test` can execute the discovered TypeScript test files instead of reporting every test as failed with `exit null`.

## Approach

- Update the test runner to invoke `npx` through the platform-specific executable name (`npx.cmd` on Windows, `npx` elsewhere).
- Preserve current per-file test execution, output, and failure counting.
- Improve failure reporting for child-process launch errors so future harness failures show the actual spawn error instead of only `exit null`.

## Files affected

- `scripts/run-tests.ts` — make child test execution Windows-compatible and report spawn errors.
- `planning/INDEX.md` — track this plan while active, then remove it when archived.

## Tests

- Run `npm test` locally to verify the runner still executes all test files on macOS/Linux.
- Run `npm run build` from the repo root before finishing, per project requirements.

## Open questions / risks

None. The CI failure pattern points at the runner process launch, not the individual tests.

## Out of scope

- Changing individual test files.
- Changing the Windows release workflow beyond the test runner compatibility fix.
