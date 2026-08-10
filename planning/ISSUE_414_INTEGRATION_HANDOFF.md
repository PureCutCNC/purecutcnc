---
status: current
authoritative-for: issue #414 smooth-tab delegated execution ledger
last-verified: 2026-08-10
---

# Integration Handoff — Issue #414 smooth tabs

The GitHub issue is the approved plan and the source of truth. This file records
execution state only. No tokens, raw environment values, or unredacted provider
output belong here.

## Integration state

- Integration branch: `feat/issue-414-smooth-tabs`
- Integration worktree: `/Users/frankp/Projects/worktrees/purecutcnc/issue-414-smooth-tabs-a0c126`
- Base commit: `3a8a3ac` (merge of PR #477, issue #468 bulk tab/clamp editing)
- Approved issue and plan: https://github.com/PureCutCNC/purecutcnc/issues/414
  (maintainer comment "Maintainer plan — PR 2: smooth tabs")
- Manager session: 2026-08-10
- Status: `slice in progress`
- User authorization for credential-backed worker dispatch: granted 2026-08-10
  ("use management skill and dispatch agents as needed")

## Global rules

- One active implementation slice at a time.
- Every worker runs in its own task worktree branched from the current
  integration tip, never in the integration checkout.
- The manager owns worktree/branch creation, review, merge, cleanup, issue-plan
  updates, browser regression, push, and PR decisions.
- Reject any worker result without exactly one expected task commit, a clean
  task worktree, scoped changes, and truthful required-check results.

## Product decisions carried from the approved plan

- **Rectangular stays the default.** Legacy tabs with no `shape`, newly created
  tabs, and auto-placed tabs are all `rect`. Smooth is explicit opt-in, because
  a fully ramped tab of the same nominal size leaves materially less holding
  cross-section.
- **The XY footprint stays rectangular** for hit-testing, cutter-envelope
  expansion, layout coverage, overlap warnings, and auto-placement. Only the Z
  motion across a crossing changes.
- **Rectangular output is preserved move-for-move.** Any diff in rect output is
  a defect, not an improvement.
- **Trochoidal Edge Route keeps its guide-domain rectangular handling.** A
  smooth tab there falls back to rectangular motion and must emit a localized
  structured warning — never a silent downgrade.
- The static 2D/3D tab object remains the protected envelope; the ramp is
  visible in generated toolpath preview and simulation.
- No user-tunable curve parameters in this PR. The persisted choice is only
  `rect` or `smooth`.

## Slice ledger

| Slice | Scope | Base commit | Task branch/worktree | Worker status | Manager review | Accepted commit / merge | Required checks | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | `Tab.shape` field, rect-preserving normalization, creation defaults | `3a8a3ac` | `feat/issue-414-tab-shape-field` / `worktrees/purecutcnc/tab-shape-field` | `not started` | `pending` | `-` | `npm test`, `npm run build` | Data model only; no engine or UI behaviour change |
| S2 | Pure smooth Z profile helper (`tabProfile.ts`) | `-` | manager-owned (integration checkout) | `n/a` | `n/a` | `-` | `npm test` | Safety-critical geometry; not delegated |
| S3 | Chain-level smooth crossing integration in `tabs.ts` | `-` | manager-owned (integration checkout) | `n/a` | `n/a` | `-` | `npm test`, `npm run build` | Safety-critical; rect branch must stay byte-identical |
| S4 | Trochoidal smooth-tab fallback warning + design-doc contract | `-` | `feat/issue-414-trochoidal-smooth-fallback` | `not started` | `pending` | `-` | `npm test`, `npm run build` | Touches 5 locales — must not run concurrently with S5 |
| S5 | Localized Rectangular/Smooth control, single + bulk tab panels | `-` | `feat/issue-414-tab-shape-ui` | `not started` | `pending` | `-` | `npm test`, `npm run build` | Touches 5 locales — must not run concurrently with S4 |
| S6 | Verification, e2e, INDEX updates, PR | `-` | manager-owned (integration checkout) | `n/a` | `n/a` | `-` | `npm run build`, `npm run test:e2e` | Includes rect-output differential probe and mutation checks |

## Verification contract (manager-owned, not delegated)

1. **Rect differential probe.** Dump generated moves as JSON on `main` and on the
   integration branch across a fixture matrix, and `diff`. Any difference in a
   project containing only rect tabs is a defect.
2. **Smooth geometry assertions.** Exact base Z at footprint entry/exit, exact
   `z_top` at the crossing centre, monotonic rise and fall, no vertical step at
   the footprint boundary, both approach directions, partial first/last source
   moves, deliberately re-segmented paths, overlapping tabs, malformed/reversed
   Z ranges.
3. **Safety differential.** Every emitted segment sits at or above the analytic
   tab envelope within tolerance, while non-tab portions still reach final depth.
4. **Mutation checks.** Break the max-envelope rule at overlaps and the exact
   `z_top` peak on purpose and confirm the tests fail. Restore from a `cp`
   backup, never `git checkout`.
5. **i18n diff by parsed key/value pairs**, not by reading the rendered diff.

## Ledger notes

_(appended per slice as work is accepted)_
