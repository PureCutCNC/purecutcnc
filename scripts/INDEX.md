# INDEX — scripts/

Repository scripts fall into three groups. Use the npm entrypoints when one is
available; do not treat one-off diagnostics as normal quality gates.

## Required quality and build tools

- [`check-docs.ts`](check-docs.ts) and [`docs-check-core.ts`](docs-check-core.ts) — validate active-document links, planning metadata, and normalized agent entrypoints; covered by [`check-docs.test.ts`](check-docs.test.ts) and run through `npm run docs:check`.
- [`check-license-headers.ts`](check-license-headers.ts) — enforce Apache 2.0 headers under `src/`.
- [`check-fast-lane.sh`](check-fast-lane.sh) — decide fast-lane eligibility mechanically (size budget + protected paths) per the workflow section of [`AGENTS.md`](../AGENTS.md); run via `npm run check:fast-lane`, and by the `fast-lane-guard` CI job in `--ci` mode. Dependency-free bash, deliberately outside `npm run build` because it needs a fetched base ref.
- [`run-tests.ts`](run-tests.ts) — discover and run structural `src/**/*.test.ts` files.
- [`build-summary.sh`](build-summary.sh) — run `npm run build` once and print a compact failing-stage + extracted-errors summary (full output saved to a log whose path is printed); `--from-log FILE` summarizes an existing build log instead of re-running. Agents should use this instead of re-running the build to grep for failures.
- [`edit-lines.ts`](edit-lines.ts) — deterministic line-range file editor for agents (`show`/`replace`/`insert-after`/`delete`, `--expect` stale-line guard, prints a diff of exactly what changed, atomic writes, `--self-test`). The sanctioned fallback when an exact-match edit fails; replaces `sed -i` surgery.
- [`build-icon-sprite.ts`](build-icon-sprite.ts) — generate `public/icons.svg` from editable SVG sources.
- [`backlog-hygiene.ts`](backlog-hygiene.ts) — enforce the Backlog Contract (`AGENTS.md`): label unprioritized issues, decay quiet ones (`stale` → close after a grace period), and rewrite the pinned digest. Reads GitHub's native issue-level Priority field. Run weekly by [`backlog-hygiene.yml`](../.github/workflows/backlog-hygiene.yml); **defaults to a dry run**, pass `--apply` to mutate.

## Optional delegated-agent harness

- [`dispatch-task.sh`](dispatch-task.sh), [`finish-task.sh`](finish-task.sh), and [`worker-status.sh`](worker-status.sh) — provider-neutral integration-manager worktree lifecycle. `claude-deepseek` remains the default provider; select `--provider dsh` for DeepSeek Harness. `dispatch-task.sh --handoff REPO_PATH` gives either provider a compact bootstrap to read a tracked in-worktree handoff; direct stdin is reserved for a small instruction.
- [`run-claude-deepseek-agent.sh`](run-claude-deepseek-agent.sh) — credential-backed Claude/DeepSeek leaf launcher.
- [`run-dsh-agent.sh`](run-dsh-agent.sh) — DeepSeek Harness leaf launcher using DSH's own credential store and sandbox modes.
- [`claude-deepseek-agent-prompt.md`](claude-deepseek-agent-prompt.md) — bounded provider-neutral worker prompt template (historic filename retained for compatibility).
- [`test-claude-deepseek-agent.sh`](test-claude-deepseek-agent.sh), [`test-dsh-agent.sh`](test-dsh-agent.sh), [`test-dispatch-task.sh`](test-dispatch-task.sh), and [`worker-progress-filter.jq`](worker-progress-filter.jq) — harness tests and Claude progress filtering.

Use this path only after explicit delegation approval and follow
[`manager-delegate`](../.agents/skills/manager-delegate/SKILL.md). Direct
implementation remains the default execution mode.

## Diagnostics and fixtures

The remaining TypeScript, Python, JSON, and `.camj` files are focused import,
surface-toolpath, waterline, roughing, and legacy V-carve diagnostics. They may
have special inputs or emit local artifacts. They are outside the default lint
gate; use `npm run lint:scripts` when intentionally maintaining them.
