---
name: manager-delegate
description: Run the integration-manager delegation loop — analyze a task, plan it in a GitHub issue, get approval, delegate one bounded implementation slice to a configured external-worker provider in an isolated worktree, review the real diff, then merge into the integration branch. Use when acting as the manager session that dispatches bounded implementation slices rather than writing the code directly.
---

# manager-delegate

This skill encodes PureCutCNC's integration-manager loop: **you plan and review; a
configured external worker implements** one bounded slice at a time in its own git
worktree. You never let the worker's self-report stand in for acceptance — you
verify the real artifacts and own the merge.

Read `AGENTS.md` (§"Execution Modes", §"Git & Branching", §"Workflow: Issue →
Plan → Approve → Implement → PR") first — it is authoritative.
This skill automates that documented flow; it does not replace those rules.

## The loop

1. **Analyze & plan in a GitHub issue.** Open an issue, write the plan in it,
   get the user's approval before implementing. No `planning/*_Plan.md` files —
   the issue is the plan of record. (See the issue-driven gate in AGENTS.md.)
2. **Write the handoff.** Copy `scripts/claude-deepseek-agent-prompt.md` and
   fill every bracketed field for the slice (slice id, summary, allowed/
   forbidden files, invariants, required checks, plan + handoff paths). Save the
   completed handoff at a **tracked path visible in the task worktree** — never
   `work/` (gitignored, absent from worktrees). The selected base must already
   contain that file. Keep stdin to a brief instruction; direct prompts are
   capped at 4 KiB.
3. **Select a provider and request permission (see below), then dispatch.** Pass
   `--handoff REPO_PATH` and pipe the brief instruction into
   `scripts/dispatch-task.sh`. It validates the path in the actual worktree,
   creates one compact provider-neutral bootstrap, runs the worker,
   runs an independent build gate, and reports — it does **not** merge.
   Run it in the background (redirect output to a file) and watch the slice's
   progress log instead of blocking a foreground call on the whole run (see
   "Watching a dispatched worker" below).
4. **Review the real diff, not the report.** The worker ends with a
   `STATUS/COMMIT/CHANGED_FILES/CHECKS/RISKS` block — that is a report, not
   acceptance. Inspect the actual worktree diff, the commit, and the build/test
   output, then run the checks in "Verify before you accept" below. Re-dispatch a
   correction slice if needed.
5. **Merge after approval.** Once you (and the user, when they want to see it)
   accept the diff, run `scripts/finish-task.sh` to merge `--no-ff` into the
   integration branch and tear down the worktree.

## Required permissions — request BEFORE dispatching

Every provider sends the prompt and any repository content the worker reads to
its configured external service. **Ask the user for explicit approval before
invoking dispatch — and do not silently skip the dispatch step.** If the
sandbox/approval blocks it, surface the blocker and ask; never quietly fall back
to implementing the slice yourself or abandoning the delegation.

- `claude-deepseek` (the default) reads `.env.agent`, connects to the DeepSeek
  endpoint, and spawns a `bypassPermissions` Claude worker. It is the legacy
  credential-backed path.
- `dsh` runs `dsh --profile headless` using DSH's configured credential store.
  It does not read or forward `.env.agent`; DSH persists normal profile/session
  state under `~/.dsh`. Review workers use DSH `read-only`; implementation
  workers use DSH `workspace-write` rooted at the task worktree. Any DSH
  escalation without an interactive approver fails closed. A linked worktree's
  Git metadata lives outside that writable root, so a DSH implementation worker
  must leave edits uncommitted and report `COMMIT: none`. After a zero-exit DSH
  run with changes, `dispatch-task.sh` creates exactly one manager-owned commit
  and reports its hash. Failed and no-change DSH runs are never auto-committed;
  inspect the worktree and dispatch report before deciding what to do next.

- **Codex:** run from the worktree/repo root with `sandbox=workspace-write`,
  `sandbox_workspace_write.network_access=true`, and `approval-policy=on-request`.
- **Claude Code:** approve the `dispatch-task.sh` Bash invocation when prompted.

The user's explicit approval is required before any external-worker dispatch.

## Watching a dispatched worker — judge idle time, never wall-clock

Claude/DeepSeek streams observed activity into a per-slice progress log at
`$PURECUT_WORKTREE_BASE/SLUG.progress.log` (path echoed at dispatch time; the
raw event stream is kept beside it at `….progress.log.ndjson`). Long slices
are normal: a healthy worker can run 10+ minutes while emitting a steady drip
of `[note]`/`[tool]`/`[gen]` lines.

DSH's leaf tails DSH's active local session artifact and writes observed
`[assistant]`, `[tool]`, and `[tool-result]` entries as they arrive. Its
`[heartbeat]` marker remains a fallback: it means the DSH process remains alive,
**not** that the worker made tool-level progress. The full raw session remains
under `~/.dsh`; rendered manager-log payloads are normalized and bounded.
Tool-result snippets default to 320 characters; read the raw artifact when the
full output matters.
Inspect the worktree and final response before treating a long DSH run as healthy.

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
- For Claude/DeepSeek, `[tool]` lines are observed tool calls and `[note]` lines
  are worker narration. For DSH, `[assistant]`, `[tool]`, and `[tool-result]`
  are observed from its session artifact, while `[heartbeat]` is liveness only.

## Verify before you accept

A green build is not evidence the change is correct. On #455 every slice compiled,
passed its own tests, passed `npm run build`, and passed e2e — and the user still
found two real bugs within five minutes of using the app. Neither was a worker
mistake. Both were review-design mistakes: the review checked the *control* rather
than the *effect*, and checked against the *plan* rather than against the
*neighbouring shipped feature*.

Run these on every slice that touches engine output or a user-facing control.
Cheapest first; stop when the slice genuinely has no surface for one.

### 1. Engine probe — numbers, no browser

Dump what the generator actually produces and diff it. Build the probe from the
slice's own test fixtures (take everything above the first `test*` function) so it
uses real project/tool/feature shapes rather than hand-rolled ones.

- **For any "unchanged" claim**, dump output as JSON on both branches and `diff`
  them across a fixture matrix — do not read the worker's regression test. On #455
  this confirmed direct mode byte-identical across 12 fixtures (open, closed,
  region-masked, multi-target, V-bit, multi-level stepdown).
- **For new geometry**, print the quantity that would physically go wrong — where
  the *cutter body* ends up, not where the tool centre is. A tool-centre bound is
  usually too loose to notice a wrong magnitude.
- **Compare against the nearest shipped analogue** on the same input. Trochoidal
  Engrave mirrors trochoidal Edge Route; the region overhang was a divergence from
  it, and measuring the two side by side would have shown it immediately. Any
  divergence must be explainable as deliberate, or it is a bug.

This has zero tooling risk and is where geometry defects actually live.

### 2. Assert the output changes — a permanent test, not scratch

For **every new operation parameter**, assert the generated toolpath differs when
the parameter differs. This catches the entire class of "the control writes the
field but nothing recomputes."

That bug is easy to ship because the field, the UI, and the generator can all be
correct while the change never reaches the generator.
`operationComputationEquals` in `src/app/useToolpathGeneration.ts` gates
regeneration off an explicit allowlist, and its comment says so directly: *"Any new
computation-relevant field added to Operation must be listed here."* Adding a field
to `Operation` and not to that list produces exactly this symptom.

**Whenever a slice adds a field to `Operation`, grep for every consumer before
accepting.** Use a sibling field as the probe — `grep -rl trochoidalCutWidth src`
found the allowlist *and* the operation booklet, which was also missing the new
strategy.

### 3. Drive the real app

A scratch Playwright spec, not the browser extension: it reuses the repo's
fixtures and seeding seam, runs headless, and exits cleanly. Exercise the new
control end to end, assert the output changed, and screenshot it to eyeball.

**Always use a dedicated port and an isolated server.** The default 1420 with
`reuseExistingServer` will silently attach to a dev server from another checkout
and test the wrong code.

```bash
PURECUT_E2E_PORT=1439 PURECUT_E2E_ISOLATED=1 npx playwright test <spec>
```

**Port hygiene — Playwright and Vite do leave strays that block the port.** Check
before, and always clean up after, even when the run passed:

```bash
lsof -ti tcp:1439 | xargs -r kill
```

Delete the scratch spec once it has served its purpose; anything worth keeping
belongs in `e2e/*.smoke.spec.ts` as a real test.

### 4. Mutation-check the assertions that matter

A passing test constrains nothing until you have watched it fail. For the two or
three invariants the issue calls load-bearing, break the code on purpose and
confirm the test catches it.

On #455 the worker's region-polarity test passed 9/9 — and still passed with the
swept-half-width substitution *deleted entirely*, the one line the issue named as
"the one place a wrong sign silently cuts outside an include region."

**Restore from a `cp` backup, never `git checkout <file>`.** If the fix under test
is still uncommitted, `git checkout` discards it, and the next "mutation caught"
result is really just the reverted code. That happened, and it looked like a pass.

```bash
cp src/path/file.ts /tmp/file.fixed.ts   # before mutating
# …mutate, run the test, confirm it fails…
cp /tmp/file.fixed.ts src/path/file.ts   # restore
```

### Reviewing i18n

Diff locale files by **parsing key/value pairs on both sides and comparing the
dicts** — never by eyeballing the rendered diff. A worker repairing a parse error
with a Python heredoc silently swapped one space for U+00A0 inside an unrelated
pre-existing French string; it is invisible in `git diff`. Confirm each locale
gained only the intended keys and that no existing value changed. Note that locale
files do not share a quote style — `es/*` uses double quotes where others use
single — so match the file, not the sibling.

## Commands

```
# Dispatch one implement slice (after approval). The detailed handoff is tracked;
# stdin holds only a short manager instruction.
printf '%s\n' 'Implement the assigned slice and report results.' | \
  scripts/dispatch-task.sh --issue NN --task-slug SLUG \
  [--base BRANCH] [--provider claude-deepseek|dsh] --handoff REPO_PATH
#   default --base: feat/core-arch-simplification
#   creates worktree at $PURECUT_WORKTREE_BASE/SLUG on feat/issue-NN-SLUG
#   runs the worker, then `npm run build` as an independent gate; never merges.

# Read-only review of an existing worktree (optional helper).
printf '%s\n' 'Review the assigned diff and report findings.' | \
  scripts/dispatch-task.sh --mode review --worktree DIR \
  [--provider claude-deepseek|dsh] --handoff REPO_PATH

# Poll a running dispatch (instant; see "Watching a dispatched worker").
scripts/worker-status.sh --slug SLUG

# Merge an approved slice and tear down its worktree (--no-ff).
scripts/finish-task.sh --slug SLUG [--base BRANCH]
#   refuses to merge into main/master without --allow-main.
#   also removes the slice's progress log artifacts.
```

The provider leaf launchers own provider-specific credential handling,
worktree confinement, and permission mapping. `run-claude-deepseek-agent.sh`
remains the trusted Claude/DeepSeek primitive; `run-dsh-agent.sh` keeps DSH
within its own read-only/workspace-write modes.

## Guardrails (enforced by the scripts — do not re-derive)

- Worktrees live under `$PURECUT_WORKTREE_BASE` — by default a `worktrees/<repo-name>`
  directory beside the repository — never the primary checkout or `main`.
- Branch-first, always: `feat/issue-NN-SLUG` off the integration branch.
- Independent build gate (`npm run build`) after the worker — the worker's
  reported checks are not trusted.
- `finish-task.sh` refuses to merge a dirty worktree or a dirty integration
  checkout, and refuses `main`/`master` without `--allow-main`.
- No Co-Authored-By lines, no "generated by" footers (AGENTS.md coding standards).
