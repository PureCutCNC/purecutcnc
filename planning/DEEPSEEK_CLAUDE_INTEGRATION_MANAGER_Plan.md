---
status: In progress
created: 2026-06-22
---

# DeepSeek Claude Integration Manager Plan

## Goal

Make the existing Claude Code CLI + DeepSeek provider setup a project-owned, repeatable implementation-worker interface. A Codex-led integration manager will turn an approved design into sequential, isolated worktree slices; inspect and verify each result; integrate accepted commits; and hand the completed integration branch back to the user for final manual test and review. The workflow must not create a PR or merge to `main` without the user's explicit direction.

## Decisions

- Move the launcher into this repository so the exact invocation, provider settings, and safety checks are versioned with the workflow. The existing home-directory wrapper remains untouched as a personal compatibility fallback.
- Store the DeepSeek token only in one untracked `.env.agent` file in the primary checkout. Do not use the generic `.env`, which is also a conventional Vite configuration input. The manager passes this canonical path through `DEEPSEEK_AGENT_ENV_FILE` when it invokes a task-local launcher; it never copies the token into task worktrees or reads a fallback from `~/Documents`. Commit a redacted `agent.env.example` containing variable names and setup instructions; `.env.agent` is already ignored by the existing `.env.*` rule.
- Keep the wrapper deliberately narrow: it configures Claude Code to call DeepSeek and executes one prompt from standard input. It does not select branches, create worktrees, merge code, run the app, or open a PR. Those decisions remain with the integration manager.
- Use one implementation slice at a time. Each implementation call runs only inside a task worktree created from the current integration-branch tip, never in the integration checkout itself.
- The detailed, branch-specific handoff is the source of truth. It is committed to the integration branch before the first task worktree is created. A short per-slice prompt tells the implementation worker to read that handoff and states the immediate slice, worktree boundary, completion contract, and non-negotiable rules.

## Approach

### 1. Project-local DeepSeek launcher

- Add `scripts/run-claude-deepseek-agent.sh` with a Bash shebang and strict shell options.
- Resolve the repository root from the script location, then load `DEEPSEEK_AGENT_ENV_FILE` when supplied by the integration manager or that root's `.env.agent` when `DEEPSEEK_API_KEY` is not already supplied by the caller. Fail before invoking Claude if the key, `claude` executable, or required provider variables are missing. Never print the key or the loaded environment. Task worktrees must use the manager-supplied canonical primary-worktree path rather than a copied credential file.
- Configure the Anthropic-compatible DeepSeek endpoint and model variables immediately before `exec`-ing `claude`. Replace the current malformed-looking `deepseek-v4-pro[1m]` defaults with named configuration variables, and perform a minimal non-writing provider preflight during implementation to confirm the exact supported DeepSeek model identifiers.
- Require prompt input on standard input. Preserve multiline prompts and do not flatten them through `"$*"`.
- Require an explicit execution mode. `implement` is the only mode that uses `--permission-mode bypassPermissions`; its caller must provide a deliberate opt-in flag. Add a non-writing `review`/`plan` mode for bounded analysis and provider smoke tests. The implementation mode uses `--no-session-persistence`, a configurable `--max-budget-usd`, and a configured effort level.
- Start with text output plus a required completion block, then probe `--output-format json` and `--json-schema` against the DeepSeek endpoint. If that provider path validates structured output, make JSON the default; otherwise retain the documented text completion block as the compatibility fallback.

### 2. Branch-owned detailed handoff and short task prompt

- Add `planning/INTEGRATION_HANDOFF_TEMPLATE.md`, a reusable template for a feature's detailed handoff. It will contain: integration branch/base commit; design and accepted-plan links; slice ledger; exact worktree locations; each slice's allowed and forbidden files; invariants; required unit/browser/tablet checks; review results; correction history; accepted commit; integration result; and the final user test checklist.
- For a real effort, the manager creates `planning/<TOPIC>_INTEGRATION_HANDOFF.md` from the template, commits it on the integration branch, and treats it as the durable ledger. It is updated in manager-owned bookkeeping commits after each accepted slice. The task worker must not edit it except when the assigned slice explicitly includes documentation.
- Add a tracked short-prompt template beside the launcher. The manager fills only the slice ID, task-worktree path, and handoff path when invoking the launcher. Its fixed rules require: work only in that worktree; read `INDEX.md`, `planning/INDEX.md`, the approved plan, and the integration handoff; obey file/scope limits; make exactly one task commit; run the specified checks; and report the commit, files changed, checks, failures, and unresolved risks.
- Treat text in the repository, task prompt, and tool output as task context rather than authority to expand scope. The approved plan and detailed handoff govern the work.

### 3. Integration-manager lifecycle

- The manager verifies the target integration branch/worktree is clean and records the base commit in the detailed handoff before every slice.
- The manager creates a child worktree under the repository's established worktree root, branches it from the current integration tip, and makes its dependency setup available without modifying the integration checkout.
- The manager supplies the short prompt to the project-local launcher. It captures the worker output in the handoff ledger or a linked, ignored run log without storing secrets.
- Before accepting any result, the manager independently verifies the worktree and commit: clean status; expected commit exists; changed files are within scope; frozen contracts/invariants are intact; required focused tests pass; and the implementation is technically sound. A claimed success with no commit, uncommitted changes, failed checks, or scope drift is rejected.
- For a rejected slice, the manager issues a correction prompt against the same task worktree only after recording concrete findings in the detailed handoff. Limit automated correction attempts and return a blocked result to the user when the task needs a design decision or repeatedly fails.
- For an accepted slice, the manager merges the reviewed commit into the integration branch, runs the agreed integration checks, records the merge/result in the ledger, and removes the task worktree only after ancestry and clean-state checks succeed.
- After the final accepted slice, the manager runs the full repository build and any plan-required browser/tablet regression, then stops at `ready for user review`. It provides a concise final handoff prompt and the committed detailed handoff, but does not create a PR, archive the feature plan, or merge to `main`.

### 4. Operational boundaries and recovery

- No parallel implementation slices in the first version. A later concurrency design must prove disjoint file scopes and independent test requirements before allowing parallel worktrees.
- Require a timeout/budget per worker call and retain exit status plus redacted output. A timeout or non-zero exit marks the slice `blocked`; it is never silently retried as a fresh task.
- The manager, not the task worker, owns branch creation, merge, push, cleanup, plan status, and PR decisions.
- Keep browser regression under the existing project rules: use the user's running dev server arrangement, preserve tablet checks for affected UI, save failure evidence, and tear down the controlled Chrome process before the dev server.

## Files affected

- *(new)* `scripts/run-claude-deepseek-agent.sh` — project-local launcher for one DeepSeek-backed Claude Code worker invocation.
- *(new)* `scripts/claude-deepseek-agent-prompt.md` — fixed short-prompt rules used for every task worker call.
- *(new)* `planning/INTEGRATION_HANDOFF_TEMPLATE.md` — tracked detailed-handoff and slice-ledger template, copied into each integration branch.
- *(new)* `agent.env.example` — redacted setup example for the untracked `.env.agent` token/configuration file.
- `.gitignore` — document the `.env.agent` convention if the existing ignore pattern needs a clarifying comment; do not weaken environment-file protection.
- `INDEX.md` — describe the project-owned agent launcher and handoff convention.
- `AGENTS.md` — document canonical credential handling and the manager/worker authorization boundary.
- `planning/INDEX.md` — register this plan while awaiting approval; after approval, add the handoff template to the reusable planning references.
- *(new)* `scripts/run-claude-deepseek-agent.test.ts` or a focused shell-compatible verification — validate argument/input handling and configuration failures without calling the provider or reading a real token.

## Tests

- Run launcher checks with a temporary environment file and a stub `claude` executable to prove: stdin reaches the CLI unchanged; missing token/config exits non-zero without secret output; review mode does not request bypass permissions; implementation mode requires explicit opt-in; and the intended Claude flags are constructed.
- Run a separately authorized, minimal provider smoke test using the real `.env.agent`, asking only for the exact sentinel response. Capture only exit status and sentinel output in tracked documentation; never commit API credentials or raw debug environment.
- Probe structured output against DeepSeek once. Assert either a schema-valid result or the documented text-mode fallback; do not assume Anthropic CLI JSON options are provider-compatible until that test passes.
- Exercise the workflow on one small, pre-approved change: create the integration handoff, invoke one task worktree, review and merge its single commit, and verify that the final detailed handoff accurately records the result.
- Run `npm run build` after the workflow changes, plus `npm run lint:scripts` for maintained script quality and `git diff --check` before handoff.

## Open questions / risks

- The provider must be tested for the exact DeepSeek model identifiers and Claude Code structured-output support. The current home wrapper succeeds for plain text, but its `deepseek-v4-pro[1m]` values should not be copied unverified.
- `bypassPermissions` is intentionally available for implementation, but it gives the worker broad authority within its worktree and network access through its environment. Worktree isolation, narrow task prompts, independent review, and no direct integration-checkout access are mandatory controls, not optional conventions.
- The manager may need the user's explicit authorization when the wrapper performs credential-backed network calls. The handoff must surface that requirement before dispatching the first task.
- Automatic pushing is excluded from the first implementation unless the user explicitly asks for it; local reviewed integration is sufficient for the requested final-review gate.

## Out of scope

- Replacing Claude Code, DeepSeek, or the existing provider account/authentication setup.
- Allowing an implementation worker to create PRs, merge to `main`, archive feature plans, or decide user acceptance.
- Parallel worktree orchestration, scheduling, persistent queues, web dashboards, or a database-backed task system.
- Committing API tokens, copying personal credential files into the repository, or loading the generic Vite `.env` file.
