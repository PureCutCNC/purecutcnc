# Integration Handoff — <TOPIC>

> Commit this handoff to the integration branch before creating the first task worktree. It is the authoritative ledger for the integration manager and implementation worker. Do not store tokens, raw environment values, or unredacted provider debug output here.

## Role and stop condition

The integration manager turns the approved design into sequential worktree slices, independently reviews and verifies each slice, and merges only accepted commits into the integration branch. Stop after the final repository verification and hand the result to the user for manual test and review. Do not create a PR, archive the feature plan, or merge to `main` without explicit user direction.

## Integration state

- Integration branch: `<branch>`
- Integration worktree: `<absolute path>`
- Base commit: `<full hash>`
- Approved plan: `<repository path>`
- Manager session: `<identifier or date>`
- Status: `preparing | slice in progress | blocked | ready for user review`
- User authorization for credential-backed worker dispatch: `<recorded authorization or pending>`

## Global rules

- One active implementation slice at a time.
- Every worker runs in its own task worktree branched from the current integration tip, never in the integration checkout.
- The worker may use `bypassPermissions` only through the project launcher in explicit implementation mode.
- The manager owns worktree/branch creation, review, merge, cleanup, plan status, browser regression, push, and PR decisions.
- Reject any worker result without exactly one expected task commit, a clean task worktree, scoped changes, and truthful required-check results.
- Browser- or tablet-affected work requires the applicable manual regression before the final user handoff. Tear down controlled Chrome before the dev server.

## Slice ledger

| Slice | Scope | Base commit | Task branch/worktree | Worker status | Manager review | Accepted commit / merge | Required checks | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | `<summary>` | `<hash>` | `<branch> / <path>` | `not started` | `pending` | `-` | `<commands>` | `-` |

## Slice instructions

### S1 — <title>

**Goal:** <one concise outcome>

**Allowed files:**

- `<path>`

**Forbidden files:**

- `<path or category>`

**Invariants:**

- <behavior or contract that must not change>

**Required checks:**

```bash
<focused command>
```

**Manager review record:**

- Worker invocation: `<date, exit status, redacted output location>`
- Worker-reported completion: `<completion block>`
- Diff/commit review: `<pass or concrete findings>`
- Correction attempts: `<none or links to findings>`
- Acceptance decision: `<accepted | rejected | blocked>`

## Integration verification

- Accepted commits and merge order: `<list>`
- Repository checks: `<commands and results>`
- Browser/tablet checks: `<surfaces, viewport, result, failure artifacts if any>`
- Known limitations or deferred work: `<none or list>`

## User-review handoff

Provide this concise summary after all required checks pass:

```text
Integration branch: <branch>
Detailed handoff: planning/<TOPIC>_INTEGRATION_HANDOFF.md
Accepted slices: <list>
Verification: <commands/results>
Manual test requested: <exact workflows, including tablet when relevant>
Known limitations: <none or list>
No PR has been created. Please review and confirm whether to proceed.
```
