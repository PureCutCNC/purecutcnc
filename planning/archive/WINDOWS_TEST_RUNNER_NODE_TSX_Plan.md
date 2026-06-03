---
status: Done
created: 2026-06-03
---

# Windows Test Runner Node TSX Plan

## Goal

Fix the remaining Windows CI test-launch failure on PR #134, where spawning `npx.cmd` still fails with `spawnSync npx.cmd EINVAL` before any test file runs.

## Approach

- Stop spawning the `npx`/`npx.cmd` package-manager shim from `scripts/run-tests.ts`.
- Resolve the installed `tsx` CLI from `node_modules` and launch it with `process.execPath` (`node`) for each test file.
- Keep the current per-test process isolation and improve launch-error output to name the `node` + `tsx` command path.

## Files affected

- `scripts/run-tests.ts` — replace shim-based child execution with direct `node <tsx-cli> <test-file>` execution.
- `planning/archive/WINDOWS_TEST_RUNNER_NODE_TSX_Plan.md` — archive this completed follow-up plan after verification.
- `planning/INDEX.md` — track this plan while active, then remove it when archived.

## Tests

- Run `npm test`.
- Run `npm run build`.
- Push to PR #134 so the Windows workflow can verify the actual runner platform.

## Open questions / risks

None. This keeps the same test execution model but removes Windows `.cmd` spawning from the inner loop.

## Out of scope

- Changing individual tests.
- Changing the GitHub Actions workflow.
