---
name: manager-delegate
description: Run the integration-manager delegation loop — analyze a task, plan it in a GitHub issue, get approval, delegate implementation to the DeepSeek-backed Claude CLI worker in an isolated worktree, review the real diff, then merge into the integration branch. Use when acting as the manager session that dispatches bounded implementation slices rather than writing the code directly.
---

# manager-delegate

This skill encodes PureCutCNC's integration-manager loop: **you plan and review; a
DeepSeek-backed worker implements** one bounded slice at a time in its own git
worktree. You never let the worker's self-report stand in for acceptance — you
verify the real artifacts and own the merge.

Read `AGENTS.md` (§"DeepSeek implementation workers", §"Git & Branching",
§"Workflow: Issue → Plan → Approve → Implement → PR") first — it is authoritative.
This skill automates that documented flow; it does not replace those rules.

## The loop

1. **Analyze & plan in a GitHub issue.** Open an issue, write the plan in it,
   get the user's approval before implementing. No `planning/*_Plan.md` files —
   the issue is the plan of record. (See the issue-driven gate in AGENTS.md.)
2. **Write the handoff prompt.** Copy `scripts/claude-deepseek-agent-prompt.md`
   and fill every bracketed field for the slice (slice id, summary, allowed/
   forbidden files, invariants, required checks, plan + handoff paths). Those
   referenced paths must be **tracked files visible in the worktree** — never
   `work/` (gitignored, absent from worktrees). Save to a temp file.
3. **Request permission (see below), then dispatch.** Pipe the prompt into
   `scripts/dispatch-task.sh`. It creates the worktree+branch, runs the worker,
   runs an independent build gate, and reports — it does **not** merge.
   Run it in the background (redirect output to a file) and watch the slice's
   progress log instead of blocking a foreground call on the whole run (see
   "Watching a dispatched worker" below).
4. **Review the real diff, not the report.** The worker ends with a
   `STATUS/COMMIT/CHANGED_FILES/CHECKS/RISKS` block — that is a report, not
   acceptance. Inspect the actual worktree diff, the commit, and the build/test
   output. Re-dispatch a correction slice if needed.
5. **Merge after approval.** Once you (and the user, when they want to see it)
   accept the diff, run `scripts/finish-task.sh` to merge `--no-ff` into the
   integration branch and tear down the worktree.

## Required permissions — request BEFORE dispatching

`dispatch-task.sh` needs three elevated capabilities at once:

1. **Read the credential file** `.env.agent` (the DeepSeek key).
2. **Outbound network** to the DeepSeek endpoint (`api.deepseek.com`).
3. **Spawn a `bypassPermissions` worker** `claude` process in the task worktree.

Sandboxed agents block network and the credential read by default. **Ask the user
for explicit approval for these three capabilities before invoking dispatch — and
do not silently skip the dispatch step.** If the sandbox/approval blocks it,
surface the blocker and ask; never quietly fall back to implementing the slice
yourself or abandoning the delegation.

- **Codex:** run from the worktree/repo root with `sandbox=workspace-write`,
  `sandbox_workspace_write.network_access=true`, and `approval-policy=on-request`.
- **Claude Code:** approve the `dispatch-task.sh` Bash invocation when prompted.

The user's explicit approval is required before any credential-backed dispatch
(AGENTS.md §"Credential & token handling").

## Watching a dispatched worker — judge idle time, never wall-clock

The worker streams its activity into a per-slice progress log at
`$PURECUT_WORKTREE_BASE/SLUG.progress.log` (path echoed at dispatch time; the
raw event stream is kept beside it at `….progress.log.ndjson`). Long slices
are normal: a healthy worker can run 10+ minutes while emitting a steady drip
of `[note]`/`[tool]`/`[gen]` lines.

- Dispatch in the background with output redirected to a file; do not block a
  foreground shell call (with its own timeout) on the whole slice.
- Poll `scripts/worker-status.sh --slug SLUG` every 30–60s. It is instant and
  bounded — safe to call as often as needed.
- **Patience rule: never kill a worker because of total elapsed time.** Act
  only on the probe's state:
  - `running` — leave it alone, whatever the runtime.
  - `stale` (no progress for 5+ minutes) — inspect the log tail and the
    worktree diff before deciding; a build or install step can legitimately
    be quiet for a while. Kill only if clearly wedged.
  - `verifying` — worker done, independent build gate running.
  - `done` — read the dispatch report and start the review.
- `[tool]` lines are tool calls observed by the harness — the model cannot
  fake or forget them, so they are the reliable liveness signal. `[note]`
  lines are the worker narrating its phases.

## Commands

```
# Dispatch one implement slice (after approval). Prompt on stdin.
scripts/dispatch-task.sh --issue NN --task-slug SLUG [--base BRANCH] < prompt.md
#   default --base: feat/core-arch-simplification
#   creates worktree at $PURECUT_WORKTREE_BASE/SLUG on feat/issue-NN-SLUG
#   runs the worker, then `npm run build` as an independent gate; never merges.

# Read-only review of an existing worktree (optional helper).
scripts/dispatch-task.sh --mode review --worktree DIR < prompt.md

# Poll a running dispatch (instant; see "Watching a dispatched worker").
scripts/worker-status.sh --slug SLUG

# Merge an approved slice and tear down its worktree (--no-ff).
scripts/finish-task.sh --slug SLUG [--base BRANCH]
#   refuses to merge into main/master without --allow-main.
#   also removes the slice's progress log artifacts.
```

The leaf launcher `scripts/run-claude-deepseek-agent.sh` (credential scrub,
worktree confinement, mode→permission mapping) is the trusted primitive both
scripts call. Do not modify it.

## Guardrails (enforced by the scripts — do not re-derive)

- Worktrees live under `$PURECUT_WORKTREE_BASE`
  (default `/Users/frankp/Projects/worktrees/purecutcnc`), never the primary
  checkout or `main`.
- Branch-first, always: `feat/issue-NN-SLUG` off the integration branch.
- Independent build gate (`npm run build`) after the worker — the worker's
  reported checks are not trusted.
- `finish-task.sh` refuses to merge a dirty worktree or a dirty integration
  checkout, and refuses `main`/`master` without `--allow-main`.
- No Co-Authored-By lines, no "generated by" footers (AGENTS.md coding standards).
