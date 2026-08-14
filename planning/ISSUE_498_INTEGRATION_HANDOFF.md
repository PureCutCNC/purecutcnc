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
| S2b | engagement.ts: nominal deadband, bucket ladder, capsule geometry | `2a8a5e3` | `feat/issue-498-engagement-fix` / removed | `complete` | `accepted` | `873f53d` | all passed | fixed blocker 1 at the source; capsules made the estimator exact |
| S2c | Capsule early-out, per-band cache, pointwise never-raise clamp | `417f43c` | `feat/issue-498-engagement-perf` / removed | `complete` | `accepted after S2d` | `7df0fdc` | all passed | fixed blockers 2 and 3; introduced the depth drift S2d then fixed |
| S2d | Depth-invariant classification, level-scoped clamp, loud cache misses | `7df0fdc` | `feat/issue-498-engagement-cache` / removed | `complete` | `accepted` | `6262dfa`, chain merged `c8fdf85` | all passed | closes every open blocker; chain merged to the integration branch |
| S3 | CAM panel control + booklet row + i18n (en/de/es/fr) | `c8fdf85` | pending | `not started` | `pending` | `-` | see S3 instructions | user-facing surface kept in one slice so the locale review happens once; first slice dispatched via the DSH provider |

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

### S2c review — two blockers fixed, one new defect, not merged

| Check | Result |
| --- | --- |
| Legacy byte-identical vs pre-slice branch | pass, all 11 fixtures |
| Never-raise (geometric, by midpoint containment) | **0 raised** across all fixtures, including the parallel pattern that was 38/102 and 54/140 |
| Independent oracle vs the modified estimator | 56/56 — the early-out drops no coverage it shouldn't |
| Generation cost | `rect-offset` 9.4× → **2.5×**, `multilevel` 39× → **7.8×**, `parallel` 33× → **11.9×**, 200 mm six-level 40× → **14.5×** (4909 ms → 1796 ms) |
| `rect-round` (tessellated arcs) | 26× → 204× → **53.9×** — improved over S2b, still worse than the disc model it replaced |

Legacy timings are unchanged, and the mode defaults to `'legacy'`, so the
remaining cost is opt-in.

**New defect — the emitted feed ratchets down with depth on identical geometry.**
The offset ring tree is Z-invariant, and legacy proves it: every level emits
exactly 60 fed moves with byte-identical XY sequences. Engagement mode emits
126 / 120 / 118 / 110 / 102 moves at successive levels, with differing XY splits
and the same 1362.1 mm of path at each:

| Z | full feed | slot feed |
| --- | --- | --- |
| −0.8 | 64.6% | 35.4% |
| −1.6 | 56.1% | 43.9% |
| −2.4 | 49.1% | 50.9% |
| −3.2 | 41.3% | 58.7% |
| −4.0 | 28.8% | 71.2% |

The same ring, at the same XY, against the same material, is cut 71% slow at the
bottom and 35% slow at the top. Monotonic in depth, which no physical reading
explains.

Most likely mechanism, inferred rather than proven: the per-band cache is looked
up by segment coordinate identity, and a growing share of moves at deeper levels
miss it. `pocket.ts` resolves a miss to `Math.PI` — full engagement, therefore
slot feed — as a deliberate conservative fallback. The drift direction, the
per-level split differences, and the identical path length all fit.

**The fallback is what hid it.** Safe-but-silent turned a cache-correctness bug
into an invisible cycle-time bug: the build passes, every test passes, legacy
stays byte-identical, and the never-raise check is clean, because being wrong in
the slow direction violates nothing anyone asserted. A miss should be loud — a
warning, or a test-visible counter — even while it stays conservative at runtime.

**The invariant the next slice must assert**, which the worker's cache test
missed by testing cache-versus-recompute rather than level-versus-level: *for a
Z-invariant ring tree, the emitted `feedScale` pattern must be identical at every
level.* That is a one-line property over the dump and it fails today.

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

### S2d review — accepted, all blockers closed

Verified with `scripts/pocket-output-probe.ts` across its 11-fixture matrix.

| Check | Result |
| --- | --- |
| Depth dependence (the S2d target) | **spread 0.0000** on the five-level fixture, was 0.2149; no fixture newly depth-dependent |
| Legacy byte-identical vs pre-S2 baseline | pass |
| Never-raise (geometric) | 0 raised |
| Generation cost, 200 mm six-level pocket | **4.1×** legacy (477 ms), from 40× / 4909 ms at S2 |
| `rect-round` (tessellated arcs) | 28.6× (657 ms), back in line with the disc model's 26× and far below S2b's 204× |

Cost across the whole chain, as a factor over legacy:

| Fixture | S2 | S2b | S2c | S2d |
| --- | --- | --- | --- | --- |
| rect-offset | 9.4× | 7.2× | 2.5× | 4.1× |
| rect-round | 26× | 204× | 53.9× | 28.6× |
| rect-multilevel | 39× | 28.8× | 7.8× | 5.6× |
| rect-parallel | 33× | 19.7× | 11.9× | 15.0× |
| 200 mm, 6 levels | 40× | 18.6× | 14.5× | **4.1×** |

Legacy timings are unchanged throughout and the mode defaults to `'legacy'`, so
every remaining cost is opt-in.

The worker's residual risk is stated as an explicit number rather than left
open: the multi-region island fixture still takes **exactly 2** cache misses,
each resolving conservatively to `π`, which matches the 0.0178 mean-feed spread
the probe measures there. A pinned number is reviewable; an unbounded one is not.

## Slice instructions

### S3 — CAM panel control, booklet row, and locales

**Goal:** expose `pocketEngagementMode` in the UI so the feature can be tried in
the real app, and report it in the operation booklet. Engine behaviour is already
complete and merged — this slice adds no toolpath logic.

**Allowed files:**

- `src/components/cam/CAMPanel.tsx`
- `src/engine/operationBooklet/report.ts`
- `src/i18n/locales/{en,de,es,fr}/*.ts`
- one e2e spec under `e2e/` if the control needs coverage
- `src/components/cam/operationValidity.test.ts` and the booklet test, if the new row needs assertions

**Forbidden files:**

- `src/engine/toolpaths/**` — the engine is done; changing it here would escape review
- `src/types/project.ts`, `src/store/**`, `src/app/**` — the field, its default and
  the regeneration allowlist all already exist and are verified
- `planning/**` other than reading

**Invariants:**

- The control follows the existing pocket-field pattern in `CAMPanel.tsx`; it is
  visible only for pocket operations, exactly like the slot-feed percentage.
- The mode is opt-in and defaults to `'legacy'`. A project saved before this
  slice must open unchanged and generate an identical toolpath.
- The booklet row appears only when the mode is not `'legacy'`, mirroring how
  `pocketSlotFeedPercent` is reported only when below 100 (`report.ts`).
- Every user-visible string is translated in **all four** locales. Add only the
  new keys; do not touch an existing value. `es/*` uses double quotes where the
  other locales use single — match each file, not its sibling.

**Required checks:**

```bash
npx tsx scripts/run-tests.ts
scripts/build-summary.sh
```

**Manager review record:** pending. The locale diff will be reviewed by parsing
key/value pairs on both sides and comparing dictionaries, never by reading the
rendered diff — an invisible U+00A0 substitution has slipped through that way
before.

### S4 — Colour the toolpath by feed

**Goal:** make engagement feed visible. Today the viewport draws every cut in one
colour, so the feature's entire effect is invisible in the app — the only way to
see it is to export G-code and read `F` words. #498's plan anticipated this
("optional debug colouring alongside the existing `debugToolpath` affordances");
this slice delivers it in **both** the Sketch canvas and the 3D view.

**Allowed files:**

- `src/theme/palette.ts` — one new token, see below
- `src/components/canvas/previewPrimitives.ts` — Sketch canvas cut drawing
- `src/components/viewport3d/Viewport3D.tsx` — 3D cut drawing
- `src/components/toolpathVisibility.ts` and `src/components/ToolpathVisibilityPanel.tsx` — the toggle and legend
- `src/i18n/locales/*/…` — **all five locales**, `en de es fr zh-CN`
- one e2e spec under `e2e/`, plus a unit test for the ramp mapping

**Forbidden files:**

- `src/engine/toolpaths/**` — no generator changes; `feedScale` already carries everything needed
- `src/types/project.ts`, `src/store/**` — this is view state, not project state
- `planning/**` other than reading

**Design, already decided — implement it, do not redesign it:**

1. **One new token, not six.** Add `toolpathCutSlow` beside `toolpathCut` in
   `palette.ts`, in **both** representations (the `rgba()` string used by the
   canvas and the numeric `0x…` used by three.js) and **both** themes. Derive the
   intermediate steps by interpolating between `toolpathCut` and
   `toolpathCutSlow`. Six new token pairs would be six chances to drift.
2. **Ramp on lightness.** Dark theme: full feed keeps today's coral, slower cuts
   get brighter through amber toward near-white. Light theme: same ordering
   inverted, coral toward deep red/near-black. Ordering must be carried by
   lightness, not hue — that is what makes it survive colour-blindness and
   greyscale, and the operation booklet prints.
3. **Discrete, six steps**, matching the emitted buckets exactly
   (`1.00, 0.88, 0.76, 0.64, 0.52, 0.40`). The legend shows a swatch per step
   with its percentage, so a colour on screen maps to a number.
4. **Cut moves only.** Rapids, plunges, lead-ins and retractions keep their
   existing tokens. Plunges never carry `feedScale` — `effectiveFeed` ignores it
   by design — so colouring them would be a lie.
5. **A toggle, in the existing toolpath legend row.** Default it **on** when the
   selected operation has `pocketEngagementMode === 'engagement_feed'`, off
   otherwise. Always-on would silently redefine what red means for every user,
   including everyone who never enables the mode.

**Invariants:**

- **A move with `feedScale` absent or `1` renders in exactly today's
  `toolpathCut`.** Legacy projects, and every non-pocket operation, must look
  pixel-identical to before this slice. This is the load-bearing property.
- No colour literals anywhere — `scripts/check-color-literals.ts` runs in the
  build gate and will reject them. Everything goes through the palette.
- Both themes are updated together; a token added to one and not the other is a
  type error by construction, so let the compiler help you.
- Only the new keys are added to each locale; no existing value changes. `es/*`
  uses double quotes where the others use single — match each file, not its sibling.

**Required checks:**

```bash
npx tsx scripts/run-tests.ts
scripts/build-summary.sh
```

**Required tests:**

- Unit: the bucket→colour mapping is monotone in lightness, and `feedScale`
  absent or `1` yields exactly the `toolpathCut` value, in both themes.
- e2e: with the toggle on, a pocket in `engagement_feed` mode renders cut
  segments in more than one distinct colour; with the mode `legacy` it renders
  exactly one. Use `PURECUT_E2E_PORT` and `PURECUT_E2E_ISOLATED=1` — the default
  port silently attaches to a dev server from another checkout.

**Manager review record:** pending. Locale diffs will be verified by parsing
key/value pairs and comparing dictionaries, with a guard that rejects a parse
returning implausibly few keys — a single-quote-only parser silently read zero
keys from `es/*` during S3 and reported it as clean.
