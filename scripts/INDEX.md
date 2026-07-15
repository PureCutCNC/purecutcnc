# INDEX — scripts/

Repository scripts fall into three groups. Use the npm entrypoints when one is
available; do not treat one-off diagnostics as normal quality gates.

## Required quality and build tools

- [`check-docs.ts`](check-docs.ts) and [`docs-check-core.ts`](docs-check-core.ts) — validate active-document links, planning metadata, and normalized agent entrypoints; covered by [`check-docs.test.ts`](check-docs.test.ts) and run through `npm run docs:check`.
- [`check-license-headers.ts`](check-license-headers.ts) — enforce Apache 2.0 headers under `src/`.
- [`run-tests.ts`](run-tests.ts) — discover and run structural `src/**/*.test.ts` files.
- [`build-icon-sprite.ts`](build-icon-sprite.ts) — generate `public/icons.svg` from editable SVG sources.

## Optional delegated-agent harness

- [`dispatch-task.sh`](dispatch-task.sh), [`finish-task.sh`](finish-task.sh), and [`worker-status.sh`](worker-status.sh) — integration-manager worktree lifecycle.
- [`run-claude-deepseek-agent.sh`](run-claude-deepseek-agent.sh) — credential-backed leaf launcher.
- [`claude-deepseek-agent-prompt.md`](claude-deepseek-agent-prompt.md) — bounded worker prompt template.
- [`test-claude-deepseek-agent.sh`](test-claude-deepseek-agent.sh) and [`worker-progress-filter.jq`](worker-progress-filter.jq) — harness tests and progress filtering.

Use this path only after explicit delegation approval and follow
[`manager-delegate`](../.agents/skills/manager-delegate/SKILL.md). Direct
implementation remains the default execution mode.

## Diagnostics and fixtures

The remaining TypeScript, Python, JSON, and `.camj` files are focused import,
surface-toolpath, waterline, roughing, and legacy V-carve diagnostics. They may
have special inputs or emit local artifacts. They are outside the default lint
gate; use `npm run lint:scripts` when intentionally maintaining them.
