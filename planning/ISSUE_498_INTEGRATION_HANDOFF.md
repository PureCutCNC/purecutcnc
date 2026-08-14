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
- User authorization for credential-backed worker dispatch: granted 2026-08-14 as standing authorization for every slice of #498 (credential read, DeepSeek network egress, confined `bypassPermissions` worker). Review and merge remain manager-owned; no slice merges without an independent diff review.

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
| S1 | Pure engagement estimator + feed quantization + telemetry types | `c969e0e` | `feat/issue-498-engagement-core` / removed | `complete` | `accepted` | `b59178f`, merged `620229d` | both passed | 945 insertions across the 4 allowed files |
| S2 | Operation mode field + pocket wiring + regeneration allowlist | `a44eec5` | `feat/issue-498-engagement-pocket` / retained | `complete` | **rejected — 3 blockers** | `2a8a5e3`, NOT merged | both passed | branch kept; corrections build on it |
| S2b | engagement.ts: nominal deadband, bucket ladder, capsule geometry | `-` | `-` | `not started` | `pending` | `-` | `-` | fixes blockers 1 and 3 |
| S2c | pocket.ts: per-band caching + parallel-pattern clamp | `-` | `-` | `not started` | `pending` | `-` | `-` | fixes blocker 2; needs S2b's API |
| S3 | CAM panel control + booklet row + i18n (en/de/es/fr) | `-` | `-` | `not started` | `pending` | `-` | `-` | user-facing surface kept in one slice so the locale review happens once |

The original S2 (standalone oracle) was dropped: the S1 review already cross-validated
the estimator against an independently written brute-force sampler, so a dedicated
oracle slice would have repeated work already done.

### S2 review — rejected, three blockers

Verified by generating real toolpaths across a 12-fixture matrix and measuring them.
None of this was visible from the diff, the worker's tests, or the build gate; all
three required running the generator and looking at the output.

**What passed.** Legacy output is byte-identical across all 12 fixtures, checked by
diffing dumped move streams rather than by reading the worker's regression test. The
`operationComputationEquals` allowlist is wired correctly. Fixtures with
`pocketSlotFeedPercent: 100` produce zero scaled moves and +0.0% time, so the
"nothing to interpolate toward" rule holds. Corner detection works: the reduced-feed
bands wrap every ring corner and run out about two tool diameters, matching the
independent measurement taken before the slice existed. No emitted run is shorter
than the minimum fragment length — an early fragmentation concern of mine was
unfounded, and Pass D does its job.

**Blocker 1 — a straight run at nominal engagement is charged a full bucket.**
`engagementFeedScale` returns 1 only for `engagement <= nominal`, and quantization
rounds down, but a real straight run measures **4.16e-8 rad above nominal** — dust
from S1's deliberately conservative disc under-coverage. That dust costs 12% feed:
`scale(nominal + 1e-6) = 0.88`. The bucket ladder tops out at 0.88 and never includes
1.0, so there is no gentle rung to land on. Cost: **+30.4% estimated cycle time**
across the matrix (+46% on a plain square pocket), almost all of it on straight runs
where nothing is wrong. Fix: a deadband at nominal sized to at least the estimator's
own error bound, and a bucket ladder whose top rung is 1.0.

*Manager error worth recording:* this exact discontinuity was noted during the S1
code review and judged "conservative-safe". In isolation it is a 12% rounding choice;
composed with an estimator biased to over-report, it fires on every cut. Reviewing a
quantizer in isolation from the estimator that feeds it was the mistake.

**Blocker 2 — engagement mode raises feeds above legacy on the parallel pattern.**
Compared geometrically (each engagement move's midpoint matched to the legacy segment
containing it — an index-wise comparison is invalid because the two modes split moves
differently): `rect/parallel-basic` 38/102 moves raised, `rect/parallel-45` 54/140,
`rect/offset-round` 3/1796. The worker's clamp against a replica legacy index does not
hold on the parallel pattern. Safety-relevant: cutting faster than today where the
shipped classifier said "slotting".

**Blocker 3 — toolpath generation is 9× to 40× slower.** CPU time, 5 iterations:

| Fixture | Legacy | Engagement | Factor |
| --- | --- | --- | --- |
| rect-offset | 24 ms | 227 ms | 9.4× |
| rect-round | 14 ms | 356 ms | 26× |
| rect-multilevel | 13 ms | 510 ms | 39× |
| rect-parallel | 4.5 ms | 148 ms | 33× |
| 200 mm pocket, 6 levels | 122 ms | 4909 ms | 40× |

Five seconds on a moderate pocket, in an app that regenerates on every parameter
change. Three compounding causes:

1. *The disc-chain model, which is a manager specification error.* Prior sweeps are
   chained discs at `0.04·r`, so a 200 mm job builds ~130,000 discs **per level**. The
   external review originally proposed exact angular intervals over swept **capsules**
   — one capsule per segment, O(segments) rather than O(path length). That was traded
   away for "simpler to verify, conservative by construction" without ever measuring
   the cost. The disc model is correct; it is just the wrong complexity class.
2. *Nine-cell insertion.* Each disc is inserted into every cell its `2r`-padded bbox
   touches. Inserting into one cell and querying the 3×3 neighbourhood is identical in
   correctness and roughly 9× cheaper, since inserts dominate.
3. *No per-band caching.* Cost scales linearly with level count, so the index is
   rebuilt at every Z. #498's plan called for classifying once per band because the
   ring tree is Z-invariant; that was not implemented. Worth 5–6× on deep pockets.

### Measurement finding: rounding corners lowers peak tool load

Not previously claimed anywhere in the repo. `roundOutsideCorners` is documented in
`offsetSmoothing.ts` and the strategy INDEX purely as a stock-left-behind and
chip-stacking concern. Measured, it also reduces the engagement spike: sharp corners
reach the bottom feed bucket (0.40, full-slot), while the same corners with rounding
on reach only 0.64–0.76, and cycle-time cost drops from +46.3% to +31.7%. The tool
sweeps an arc instead of pivoting in place.

The wall-adjacent root ring stays sharp and still spikes — which is `pocket.ts:1276`
behaving exactly as documented, since filleting the root ring would leave stock against
the wall. The estimator found that asymmetry from geometry alone, which is further
evidence it tracks real physics rather than noise.

Consequence for #499: if rounding already takes the spike from 0.40 to 0.64, corner
unwinding has materially less headroom on rounded pockets than on sharp ones. That
belongs in its reopen trigger.

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

- Worker invocation: 2026-08-14, exit 0, independent build gate passed, one commit, clean worktree, changes confined to the four allowed files.
- Worker-reported completion: STATUS complete, COMMIT `b59178f`, both required checks reported passing. Treated as a report, not acceptance.
- Diff/commit review: **accepted.** Reviewed the module in full. Grid lookup proven sound (a disc within `2r` of a query always lands in the query's own cell, since discs are inserted across a bbox padded by one cell size). Arc wrap handling correct: `h ≤ π/2` bounds the arc below `π` wide, so the single wrap branch at `b > 3π/2` is exhaustive. No `any`, no non-null assertions, licence header present.
- Independent verification (manager probe, written before the worker's output existed, brute-force sampling the leading semicircle rather than unioning arcs — a different algorithm answering the same question): validation identity holds across `a_e ∈ [0, 2r]`; estimator agrees with the oracle to ~2e-4 rad; virgin material reports `π`; conservative bias holds; feed map emits exactly 6 distinct values.
- **Own-trail handling is structural, not heuristic.** A prior kerf directly behind the tool cannot intersect the leading semicircle at all, because `h ≤ π/2` keeps its covered arc entirely outside `[−π/2, π/2]`. The estimator therefore needs no analogue of `PriorCutIndex`'s `ownTrailLateralTolerance`. Verified: a straight slot trailing its own kerf reports exactly `π`.
- Mutation checks (`cp` backup, never `git checkout`): inverting `π − covered` → covered, widening the leading-semicircle clip to the full circle, and removing the bucket quantization were each caught by the worker's tests. The bucket mutation is the important one — it is the arc-fitting constraint, and the test rejects any scale outside the 6-bucket set.
- Correction attempts: none required.
- Acceptance decision: `accepted`, merged as `620229d`.

**Finding that changes #499 — ring corners spike, and the worker's risk note was wrong.**

The worker flagged that its own analysis of concentric corners showed "engagement dips, never a spike", which would have undercut #497 failure mode 1 and all of #499. Measured directly on a 60 mm square pocket, `r = 3`, stepover `2.4`, in the generator's real `inner-first` ring order:

| Position | Engagement |
| --- | --- |
| Straight run | `1.3695` rad — reproduces `nominalEngagement(2.4, 3) = 1.3694` to four decimals |
| Near corner, max | `2.9404` rad (168°) — a `+π/2` spike, essentially slotting |

The spike is identical on every interior ring, so it is structural rather than an artifact of one ring, and it decays back to nominal over roughly two tool diameters of path either side of the corner. Physically consistent: on a straight run the inner ring's kerf swallows the tool's whole inboard flank, leaving only the outboard arc engaged, whereas at the corner the inner kerf sits a diagonal `stepover·√2` away and stops covering the tool.

Two consequences. The straight-run agreement is strong independent evidence the estimator is right on a realistic pattern, not just on synthetic fixtures. And **#499's reopen trigger is satisfied on the geometry alone** — a 90° over-engagement running two tool diameters per corner is not a short transient that reduced feed fully answers. Confirm against S3's real-project telemetry before reopening.

Caveat on the measurement: the probe has no region boundary, so the wall-adjacent ring 0 counts retained material beyond the wall as stock and overstates its engagement. Rings 1+ are unaffected — under `inner-first` their outboard side genuinely is uncut stock — and they carry the finding.

## Integration verification

- Accepted commits and merge order: `pending`
- Repository checks: `pending`
- Browser/tablet checks: not applicable until S4 adds a control
- Known limitations or deferred work: chip thinning (scale above 1) is out of
  scope for #498; per-partition stepdown is out of scope across all of #497

## User-review handoff

Filled in after the final accepted slice.
