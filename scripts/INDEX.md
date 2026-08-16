# INDEX — scripts/

Repository scripts fall into three groups. Use the npm entrypoints when one is
available; do not treat one-off diagnostics as normal quality gates.

## Required quality and build tools

- [`check-docs.ts`](check-docs.ts) and [`docs-check-core.ts`](docs-check-core.ts) — validate active-document links, planning metadata, and normalized agent entrypoints; covered by [`check-docs.test.ts`](check-docs.test.ts) and run through `npm run docs:check`.
- [`check-license-headers.ts`](check-license-headers.ts) — enforce Apache 2.0 headers under `src/`.
- [`check-i18n-format.ts`](check-i18n-format.ts) — enforce one canonical source format for `src/i18n/locales/**` (one entry per line, single quotes, trailing comma, `en` key order and key set, `import type` for the `en` catalog, and non-ASCII whitespace written as `\uXXXX` so an invisible U+00A0 cannot hide in a diff), plus **sentence case on `en/**` only** against the `SENTENCE_CASE_TERMS` allowlist (#511; German capitalizes nouns grammatically, so the case rule cannot apply to other locales — see [`GLOSSARY.md`](../src/i18n/GLOSSARY.md)). Parses with the TypeScript AST, not a regex. Run via `npm run check:i18n`; `-- --fix` rewrites files into canonical form (case is not auto-fixed — it needs judgement per string).
- [`check-e2e-lanes.ts`](check-e2e-lanes.ts) — build gate (#528): every `e2e/*.spec.ts` must belong to exactly one `test:e2e:*` CI lane in `package.json`. CI runs the lanes as a parallel matrix and they name their specs explicitly, so a spec in no lane is never run — silently, because Playwright still discovers it locally. Also catches a lane entry naming a file that does not exist, and a spec claimed by two lanes. Run via `npm run check:e2e-lanes`; `--list` prints the lane membership.
- [`check-fast-lane.sh`](check-fast-lane.sh) — decide fast-lane eligibility mechanically (size budget + protected paths) per the workflow section of [`AGENTS.md`](../AGENTS.md); run via `npm run check:fast-lane`, and by the `fast-lane-guard` CI job in `--ci` mode. Dependency-free bash, deliberately outside `npm run build` because it needs a fetched base ref.
- [`run-tests.ts`](run-tests.ts) — discover and run structural `src/**/*.test.ts` files.
- [`build-summary.sh`](build-summary.sh) — run `npm run build` once and print a compact failing-stage + extracted-errors summary (full output saved to a log whose path is printed); `--from-log FILE` summarizes an existing build log instead of re-running. Agents should use this instead of re-running the build to grep for failures.
- [`edit-lines.ts`](edit-lines.ts) — deterministic line-range file editor for agents (`show`/`replace`/`insert-after`/`delete`, `--expect` stale-line guard, prints a diff of exactly what changed, atomic writes, `--self-test`). The sanctioned fallback when an exact-match edit fails; replaces `sed -i` surgery.
- [`build-icon-sprite.ts`](build-icon-sprite.ts) — generate `public/icons.svg` from editable SVG sources.
- [`backlog-hygiene.ts`](backlog-hygiene.ts) — enforce the Backlog Contract (`AGENTS.md`): label unprioritized issues, decay quiet ones (`stale` → close after a grace period), and rewrite the pinned digest. Reads GitHub's native issue-level Priority field. Run weekly by [`backlog-hygiene.yml`](../.github/workflows/backlog-hygiene.yml); **defaults to a dry run**, pass `--apply` to mutate.

## Optional delegated-agent harness

- [`dispatch-task.sh`](dispatch-task.sh), [`finish-task.sh`](finish-task.sh), and [`worker-status.sh`](worker-status.sh) — provider-neutral integration-manager worktree lifecycle. `claude-deepseek` remains the default provider; select `--provider dsh` for DeepSeek Harness. `dispatch-task.sh --handoff REPO_PATH` gives either provider a compact bootstrap to read a tracked in-worktree handoff; direct stdin is reserved for a small instruction.
- [`run-claude-deepseek-agent.sh`](run-claude-deepseek-agent.sh) — credential-backed Claude/DeepSeek leaf launcher.
- [`run-dsh-agent.sh`](run-dsh-agent.sh) and [`dsh-progress-filter.jq`](dsh-progress-filter.jq) — DeepSeek Harness leaf launcher and incremental live session-event filter. They use DSH's own credential store and sandbox modes, tail newly appended observed assistant/tool/tool-result records into the manager log, and leave the full raw session under `~/.dsh`.
- [`claude-deepseek-agent-prompt.md`](claude-deepseek-agent-prompt.md) — bounded provider-neutral worker prompt template (historic filename retained for compatibility).
- [`test-claude-deepseek-agent.sh`](test-claude-deepseek-agent.sh), [`test-dsh-agent.sh`](test-dsh-agent.sh), [`test-dispatch-task.sh`](test-dispatch-task.sh), and [`worker-progress-filter.jq`](worker-progress-filter.jq) — harness tests and Claude progress filtering.

Use this path only after explicit delegation approval and follow
[`manager-delegate`](../.agents/skills/manager-delegate/SKILL.md). Direct
implementation remains the default execution mode.

DSH implementation sessions intentionally leave worktree edits uncommitted:
its workspace-write sandbox cannot write the linked worktree's shared Git
metadata in the primary checkout. After a zero-exit DSH session with changes,
`dispatch-task.sh` creates exactly one manager-owned commit; failed and
no-change runs are never auto-committed. Live tool-result snippets are capped
at 320 characters by default (`DSH_TOOL_RESULT_MAX_CHARS`); inspect DSH's raw
session artifact when the full output matters.

## Diagnostics and fixtures

- [`pocket-output-probe.ts`](pocket-output-probe.ts) — dump a project's pocket move streams to JSON, then compare two dumps. Answers the three questions a green suite and a clean diff cannot: whether existing output really is untouched (field-by-field diff, not a regression test's own expectation), whether a change ever *raises* a feed (compared geometrically by midpoint containment — an index-wise comparison lies as soon as the two runs split moves differently), and what it costs (estimated cycle time plus the arc-run proxy that predicts lost G2/G3 before export). A third mode, `levels`, checks depth dependence: an offset ring tree is reused at every Z, so levels cutting the same path length should carry the same length-weighted mean feed. `dump builtin` uses an 11-case matrix covering both patterns, sharp/rounded corners, islands, a narrow neck, multi-level, stock-to-leave, and helix entry; pass a `.camj` path to probe a real project, and a JSON object to override operation fields.

The remaining TypeScript, Python, JSON, and `.camj` files are focused import,
surface-toolpath, waterline, roughing, and legacy V-carve diagnostics. They may
have special inputs or emit local artifacts. They are outside the default lint
gate; use `npm run lint:scripts` when intentionally maintaining them.
