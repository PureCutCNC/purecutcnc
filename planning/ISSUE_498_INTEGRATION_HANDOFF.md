---
status: current
authoritative-for: issue #498 delegated slice execution and manager review ledger
last-verified: 2026-08-14
---

# Integration Handoff — Cutter engagement model (#498)

The GitHub issue is the approved plan and source of truth. This file records
execution state only. No tokens, raw environment values, or unredacted provider
output belong here.

## Integration state

- Integration branch: `feat/issue-498-engagement`
- Integration worktree: `/Users/frankp/Projects/worktrees/purecutcnc/hybrid-adaptive-toolpath-3ca117`
- Approved issue and plan: https://github.com/PureCutCNC/purecutcnc/issues/498
- Umbrella: https://github.com/PureCutCNC/purecutcnc/issues/497
- Manager session: 2026-08-14
- Status: `slice in progress`
- User authorization for credential-backed worker dispatch: pending — requested before first dispatch

## Global rules

- One active implementation slice at a time.
- Every worker runs in its own task worktree branched from the current
  integration tip, never in the integration checkout.
- The manager owns worktree/branch creation, review, merge, cleanup, issue-plan
  updates, and PR decisions.
- Reject any worker result without exactly one expected task commit, a clean
  task worktree, scoped changes, and truthful required-check results.
- A green build is not acceptance. Every slice touching engine output is
  reviewed by engine probe, and load-bearing assertions are mutation-checked.

## Domain contract for this issue

The engagement estimator is the measurement every later tier in #497 is judged
by, so its contract is fixed here and must not drift between slices.

**Definition.** Engagement is the angular measure, in `[0, π]`, of the cutter's
**leading semicircle** — the half centred on the motion direction — lying in
uncut material. A full slot is `π`; out of contact is `0`.

**Domain.** Uncut material is *stock minus everything already swept at this
level*. Material outside the region boundary is retained and the cutter is
tangent to it, so it contributes ~zero measure and is not engagement.

**Prior sweeps are modelled as discs, deliberately.** A prior cut segment is
represented as a chain of discs of the cutter radius, spaced so the
under-covered lens between consecutive discs stays below a stated fraction of
the tool radius. This is exact per disc (closed form below), and its error is
*conservative by construction*: under-covering a prior sweep reports more uncut
material, therefore more engagement, therefore a lower feed. The alternative —
exact capsule/rectangle intersection — is fiddlier and buys nothing the
conservative bias does not already provide. `PriorCutIndex.insert` already
splits segments into pieces, so the precedent exists in the file.

**Closed form for one disc.** For query centre `C`, tool radius `r`, prior disc
centre `Q`, let `v = Q − C`, `D = |v|`, `φ = atan2(v.y, v.x)`. A circumference
point `P(θ) = C + r·u(θ)` lies inside the prior disc iff

```
|r·u − v|² ≤ r²  ⟺  u·v ≥ D² / (2r)  ⟺  cos(θ − φ) ≥ D / (2r)
```

so the covered set is the single arc `[φ − h, φ + h]` with
`h = arccos(D / (2r))`, non-empty only when `D ≤ 2r`.

Collect those arcs, clip to the leading semicircle, merge, and measure.
Engagement is the **uncovered** measure.

**Validation identity.** For a straight pass parallel to a prior pass at radial
depth `a_e`, this model must reproduce the analytic wrap angle exactly:

```
covered ⟺ sin θ ≥ a_e/r − 1
uncovered measure over [−π/2, π/2] = arcsin(a_e/r − 1) + π/2 ≡ arccos(1 − a_e/r)
```

Both sides agree at `a_e = 0` (`0`), `a_e = r` (`π/2`), and `a_e = 2r` (`π`).
This identity is S1's first acceptance test, and it is what makes the estimator
falsifiable rather than merely plausible.

**Conservative bias is a hard rule.** Sampling gaps, index misses, and
degenerate geometry all resolve toward *more* engagement. Nothing about
uncertainty may restore full feed.

## Slice ledger

| Slice | Scope | Base commit | Task branch/worktree | Worker status | Manager review | Accepted commit / merge | Required checks | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Pure engagement estimator + feed quantization + telemetry types | `e1ded37` | `feat/issue-498-engagement-core` / `worktrees/purecutcnc/engagement-core` | `not started` | `pending` | `-` | `npx tsx scripts/run-tests.ts src/engine/toolpaths/engagement.test.ts`, `scripts/build-summary.sh` | pure module, no pocket integration |
| S2 | Independent swept-stock oracle + cross-validation | `-` | `-` | `not started` | `pending` | `-` | `-` | must not reuse S1's estimator internals |
| S3 | Operation mode field + pocket wiring + regeneration allowlist | `-` | `-` | `not started` | `pending` | `-` | `-` | scoped after S1/S2 land |
| S4 | CAM panel control + i18n (en/de/es/fr) | `-` | `-` | `not started` | `pending` | `-` | `-` | scoped after S3 |

## Slice instructions

### S1 — Pure engagement estimator

**Goal:** `src/engine/toolpaths/engagement.ts` implements the domain contract
above as a pure module, with unit tests, and nothing else changes.

**Allowed files:**

- `src/engine/toolpaths/engagement.ts`
- `src/engine/toolpaths/engagement.test.ts`
- `src/engine/toolpaths/index.ts` (barrel export line only)
- `src/engine/toolpaths/INDEX.md` (entry for the new module)

**Forbidden files:**

- `src/engine/toolpaths/pocket.ts` and every other generator
- `src/types/project.ts` — S1 adds no operation field
- `src/engine/gcode/**`, `src/components/**`, `src/i18n/**`
- `planning/**` other than reading

**Invariants:**

- Pure module: no `Project`/`Operation` imports, no generator coupling, no I/O.
- Deterministic: no `Math.random`, no `Date.now`, stable iteration order.
- Conservative bias holds at every uncertainty.
- Feed quantization emits a small set of buckets, rounds toward lower feed,
  and applies hysteresis plus a minimum fragment length — because arc fitting
  refuses to join moves whose `feedScale` differs at all
  (`sameRun`, `src/engine/gcode/arcFitting.ts:93`).

**Required checks:**

```bash
npx tsx scripts/run-tests.ts src/engine/toolpaths/engagement.test.ts
scripts/build-summary.sh
```

**Manager review record:**

- Worker invocation: `pending`
- Worker-reported completion: `pending`
- Diff/commit review: `pending`
- Correction attempts: `none`
- Acceptance decision: `pending`

## Integration verification

- Accepted commits and merge order: `pending`
- Repository checks: `pending`
- Browser/tablet checks: not applicable until S4 adds a control
- Known limitations or deferred work: chip thinning (scale above 1) is out of
  scope for #498; per-partition stepdown is out of scope across all of #497

## User-review handoff

Filled in after the final accepted slice.
