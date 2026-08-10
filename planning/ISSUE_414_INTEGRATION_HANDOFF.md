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
- Status: `ready for user review`
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
| S1 | `Tab.shape` field, rect-preserving normalization, creation defaults | `3a8a3ac` | `feat/issue-414-tab-shape-field` (merged, removed) | `complete` | `accepted` | `d560c58` | `npm test`, `npm run build` | Manager verified persistence with a real `saveProject()` -> JSON -> decode -> normalize probe (the worker's own round-trip test never crossed JSON) and mutation-checked the rect default |
| S2 | Pure smooth Z profile helper (`tabProfile.ts`) | `d560c58` | manager-owned (integration checkout) | `n/a` | `n/a` | `d763c8c` | `npm test` | Raised cosine, exact endpoints/peak/zero-slope joins, chord-tolerance-derived sample count |
| S3 | Chain-level smooth crossing integration (`tabSmoothing.ts`) | `d763c8c` | manager-owned (integration checkout) | `n/a` | `n/a` | `fe25189`, `3975e13` | `npm test` (172 files) | Rect-only projects never reach the planner, so rect output is preserved by construction; verified byte-identical across 12 fixtures |
| S4 | Trochoidal smooth-tab fallback warning + design-doc contract | `fe25189` | manager-owned (integration checkout) | `n/a` | `n/a` | `2d78d5e` | `npm test`, `docs:check` | Touches `locales/*/warnings.ts`; S5 touches `locales/*/featureTree.ts` — different files, so they ran concurrently without conflict |
| S5 | Localized Rectangular/Smooth control, single + bulk tab panels | `fe25189` | `feat/issue-414-tab-shape-ui` (merged, removed) | `complete` | `accepted` | `ede7854` | `npm test`, `npm run build` | Locale diff verified by parsing key/value pairs: 275 -> 279 keys per locale, no existing value altered |
| S6 | Verification, e2e, INDEX updates, PR | `ede7854` | manager-owned (integration checkout) | `n/a` | `n/a` | `5f73483` | `npm run build`, full e2e 145/145 | Rect differential re-run after every slice landed; still byte-identical |

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

### S1 — accepted (`d560c58`)

Diff was exactly the four production lines plus a test. Two manager checks beyond
the worker's report:

- **Real persistence probe.** The worker's round-trip test called
  `normalizeProject` twice, which never crosses JSON and so proves nothing about
  saving. Driving `saveProject()` -> JSON text -> `decodeProjectFormat` ->
  `normalizeProject` confirms `smooth` survives, `rect` survives, and a legacy
  tab with no key at all is written back as `rect`.
- **Mutation.** Flipping `tabShape()` to default unknown/missing to `'smooth'`
  failed 3 of 8 tests. Restored from a `cp` backup.

One process note for later slices: the mutation was applied while the dispatch
script's own build gate was still running in the same worktree, so that gate
reported a spurious failure. Re-running it on the restored tree passed. Do not
touch a worktree while its gate is in flight.

### S2/S3 — the geometry core (manager-owned)

- **Rect differential.** 12 fixtures (inside/outside, circle/rect, 4 tabs,
  overlapping tabs of different heights, corner-straddling tab, multi-level
  stepdown, radial stock-to-leave, trochoidal at 17k moves, full-coverage
  warning, non-intersecting tab, malformed Z range, inch units) dumped as JSON on
  `main` and on the branch: **180,056 lines, byte-identical**.
- **Mutations, all caught:** deleting the closed-loop seam wrap-join, replacing
  the overlap `Math.max` with last-wins, and removing the truncated-crossing
  clamp each failed a test. Restored from `cp` backups.
- The overlap mutation initially failed only one assertion, which was too weak —
  a per-x lookup that maxes over overlapping segments can hide a wrong envelope.
  Added a safety-differential test that recomputes the analytic envelope
  independently and checks every emitted segment against it; the mutation then
  failed two.

### S4 — trochoidal fallback (manager-owned)

Verified the emission by mutation, and diffed all five `warnings.ts` locales by
**parsing key/value pairs and comparing the objects** rather than reading the
rendered diff: exactly one key added per locale, 153 -> 154, no existing value
altered. That check is the one that catches an invisible U+00A0 substitution.

### S5 — accepted (`ede7854`)

The control reads through `tabShape()` in both panels, the patch object carries
only `shape`, and the hint states the trade-off the plan asked for. Locale diff
verified by parsing key/value pairs: exactly four keys per locale, 275 -> 279, no
existing value altered.

The worker's own unit tests are good — they even assert that the naive
`commonValue(tabs, t => t.shape)` *would* read mixed, which is the trap. But they
exercise the helpers, not the panel, so an added e2e assertion checks the
user-visible outcome for a pair of legacy tabs.

**A correction worth recording.** That e2e assertion was first written claiming it
would catch the panel switching to raw `tab.shape`. It does not, and the mutation
proved it: `normalizeTab` resolves the missing field at *load*, so the panel never
receives an unresolved tab. Neither layer's removal alone fails the e2e; removing
both does, and each layer individually is caught by its own unit test. The comment
now says exactly that. A test whose comment overstates what it constrains is worse
than no comment, because the next reader trusts it.

Also fixed a cross-slice terminology split: the S4 warning said "Weich"/"Adoucie"
where the S5 control says "Sanft"/"Lisse". Same setting, two names, in the two
places a user sees it back to back.

## Final verification

- `npm run build` green — 173 test files.
- Full isolated e2e suite: **145/145** (`PURECUT_E2E_PORT=1439 PURECUT_E2E_ISOLATED=1`).
- Rect differential re-run after every slice landed: still byte-identical to `main`
  across all 12 fixtures.
- One flaky failure seen mid-run, `src/import/classifier.test.ts`'s
  `elapsedMs < 3_000` bound, was load contention from running a build concurrently
  with a worker; it passes three times in a row on a quiet machine and is unrelated.
