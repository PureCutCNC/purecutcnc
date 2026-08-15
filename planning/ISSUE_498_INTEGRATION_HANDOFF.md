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

### S5 — Derive the feed-colour ladder from the operation's slot feed

**Defect.** `FEED_COLOUR_SCALES` in `src/theme/palette.ts` is a hardcoded
constant `[1, 0.88, 0.76, 0.64, 0.52, 0.4]`. Those are the rungs for a **40%**
slot feed only. The real ladder is a function of the operation's
`pocketSlotFeedPercent`:

```
rung_k = slot + k × (1 − slot) / 5,   k = 0…5
```

At a 75% slot feed the engine emits `1.0 … 0.75`, but the hardcoded thresholds
map `0.75` to colour step 3 of 5 — a mid-ramp colour instead of the slowest —
while `0.95/0.90` collapse into step 1 and `0.85/0.80` into step 2. Six rungs
squash into four, the extreme never renders, and the legend prints six
percentages the engine never emits.

*This came from the S4 handoff, which stated the ladder as literal numbers taken
from a 40% fixture instead of as a function of the setting. The S4 unit test
asserts against the same constant, so it passes and cannot detect the defect —
a test built on the code's own wrong assumption. Fixing the constant without
fixing the test's premise would leave the trap in place.*

**Engine output is correct and must not change.** The emitted `feedScale` values
are right at every slot-feed setting; this is a display-mapping defect only. No
G-code changes.

**Allowed files:** `src/theme/palette.ts`, `src/theme/feedColourRamp.test.ts`,
`src/components/ToolpathVisibilityPanel.tsx`,
`src/components/canvas/previewPrimitives.ts`,
`src/components/canvas/SketchCanvas.tsx`,
`src/components/viewport3d/Viewport3D.tsx`, `e2e/feedColours.smoke.spec.ts`

**Forbidden files:** `src/engine/**`, `src/types/project.ts`, `src/store/**`,
`src/i18n/**` (no new strings needed), `planning/**` other than reading

**Required:**

1. Replace the constant with a derivation from a slot scale — e.g.
   `feedColourScales(slotScale)` returning the six rungs — and thread the
   selected operation's `pocketSlotFeedPercent` through to both the legend and
   the colour-step mapping. An operation with no slot feed, or 100, emits no
   scaled moves at all, so it must render exactly as today.
2. The legend prints the rungs actually in force for the selected operation.
3. `feedColourStep` takes the slot scale so its thresholds match what the engine
   emits.
4. **Rewrite the ramp test to be falsifiable across settings**, not against a
   constant: for slot feeds of at least 40%, 60% and 75%, every rung the formula
   produces must map to its own distinct colour step, the top rung must be
   exactly `toolpathCut`, and the bottom rung exactly `toolpathCutSlow`. The
   current test would pass against the broken code; the new one must fail against
   it. Verify that by reverting to the constant and watching the test fail.
5. Extend `e2e/feedColours.smoke.spec.ts` to cover a non-40% slot feed.

**Required checks:**

```bash
npx tsx src/theme/feedColourRamp.test.ts
npx tsx scripts/run-tests.ts
scripts/build-summary.sh
```

Note: `src/import/classifier.test.ts` fails intermittently (~1 run in 5) from a
machine-speed-dependent CPU budget, unrelated to this slice. If the gate fails
only on that file, re-run once and say so rather than trying to fix it.

**Manager review record:** pending.

### S6 — The reduced feed is held far past the cut that justified it

**Do not start before S5 lands.** Same files, and the ladder fix should merge clean.

**Defect.** The inner region of a pocket runs entirely at slot feed even where the
measured engagement is nearly zero. Measured on the 60 mm square fixture, tool
radius 3, stepover 2.4, slot feed 40%, walking the real emitted moves and
querying the estimator against everything cut before each one:

| Move | Ring half-width | Engagement | Emitted scale |
| --- | --- | --- | --- |
| 2 | 0.60 | 180° | 0.40 |
| 3 | 0.60 | 129° | 0.40 |
| 4 | 0.60 | 76° | 0.40 |
| 5 | 0.60 | **6°** | 0.40 |
| 6 | link | 180° | 0.40 |
| 7–9 | 3.00 | 100° | 0.40 |
| 10 | 3.00 | 30° | 0.40 |
| 12–15 | 5.40 | **78° = exactly nominal** | 0.40 |

**Mechanism, and it is not one bug but two rules composing.** The 3.4 mm diagonal
links between rings are genuine full-width slots — 180° measured — so reducing
their feed is correct. What follows is not: the quantizer's minimum fragment
length (one tool diameter, 6 mm) plus its rise hysteresis hold the reduced feed
into the *following* ring. Measured directly:

```
slot burst 4.8 mm, then 130 mm at exactly nominal
  -> scale 0.40 for 15.6 mm, then 1.00 for 118.8 mm
```

So recovery costs about 11 mm of full-feed cutting. On a large ring that is
noise. On the inner rings it is everything, because a link arrives every ring and
the perimeter between links is too short to recover in:

| Ring half-width | Perimeter | vs the 6 mm minimum fragment |
| --- | --- | --- |
| 0.60 | **4.8 mm** | shorter than a single fragment — can never hold its own |
| 3.00 | 24 mm | ~4 fragments |
| 5.40 | 43 mm | ~7 fragments |

**Not a safety defect** — it errs slow, and the links really are slotting. It is a
cycle-time cost and a legibility cost: the display makes the inner half of every
pocket look uniformly dangerous when the engagement there varies from 180° to 6°.

*A hypothesis that measurement killed, recorded so nobody re-runs it:* the rise
condition compares the continuous scale against the target bucket plus a margin,
and the top bucket is 1.0, which suggested the quantizer could never return to
full feed at all. It can — the test above returns at 118.8 mm. The defect is
delayed recovery, not a stuck floor.

**Two candidate fixes**, either or both:

1. Scale the minimum fragment length to the local ring perimeter rather than
   fixing it at one tool diameter, so a short ring can hold its own fragment.
2. Let a rise to **full feed** skip the hysteresis margin. Hysteresis exists to
   stop chatter at bucket boundaries; 1.0 is not a boundary, it is the ceiling.
   Bucket-to-bucket changes keep the current rule.

**Invariants that must survive:** never-raise versus legacy (currently 0
violations across 11 fixtures), depth invariance (currently spread 0.0000),
byte-identical legacy output, and the controller-friendliness rule that
originally motivated the minimum fragment — no short alternating fragments, and
no collapse in arc-fittable run length.

**Required tests:** a long nominal-engagement stretch following a link recovers
full feed within a stated bounded distance; and the innermost ring, whose
engagement genuinely varies 180° → 6°, emits more than one feed value.

**Manager review record:** pending.

### S7 — Rename to "Feed Reduction" and default the slot feed to 60%

**Do not start before S6 lands.** S6 touches the quantizer; this touches its
naming and default. Sequential, not parallel.

**Why the rename is safe.** `pocketEngagementMode` does not exist on `main` — it
was introduced by S2 on this unmerged branch, so no released `.camj` carries it.
`pocketSlotFeedPercent` is **shipped and must not be renamed**.

*One caveat: a project saved during testing on this branch may already contain
`pocketEngagementMode`. After the rename such a file loads with the field ignored
and silently falls back to the default — no data loss, but a tester's saved
setting will revert. Worth knowing rather than debugging twice.*

**Renames:**

| From | To |
| --- | --- |
| `pocketEngagementMode` | `pocketFeedReduction` |
| type `PocketEngagementMode` | `PocketFeedReduction` |
| value `'legacy'` | `'slots_only'` |
| value `'engagement_feed'` | `'engagement'` |
| label "Engagement Mode" | **"Feed Reduction"** |
| option "Legacy" | **"Slots only"** |
| option "Engagement Feed" | **"By engagement"** |

`'slots_only'` stays the default and remains what `undefined` normalizes to; the
behaviour must not change with this slice.

**Default change:** `operationDefaults.ts` sets `pocketSlotFeedPercent: 100` for
new operations, which makes the whole feature inert until someone finds it.
Change it to **60**. Measured cost on the fixture matrix in `slots_only` mode:

| Pattern | Δ cycle time |
| --- | --- |
| offset (the default pattern) | **+0.3%** |
| island / neck | +1.7% to +2.7% |
| parallel | **+8.5% to +10%** |

The parallel figure is the one to be aware of: there the boundary contour and the
first fill line are both classified as slotting, so a much larger share of the
path takes the reduction. Existing saved projects are unaffected — nothing
backfills this field on load, verified against `projectFormat.ts` and `camj.ts`.

**Every consumer must move together.** A rename that misses one is a silent
defect, and one of these is load-bearing beyond compilation:

- `src/types/project.ts` (type and field)
- `src/store/helpers/operationDefaults.ts` (both the rename and the 60)
- **`src/app/useToolpathGeneration.ts` — `operationComputationEquals`.** This is
  the allowlist that gates regeneration. A field missing from it saves and
  displays correctly while the toolpath never recomputes.
- `src/engine/toolpaths/pocket.ts`, `src/engine/toolpaths/types.ts` (doc comment)
- `src/engine/operationBooklet/report.ts`
- `src/components/cam/CAMPanel.tsx`, `src/components/toolpathVisibility.ts`,
  `src/components/ToolpathVisibilityPanel.tsx`
- `src/i18n/locales/*/…` — all **five** locales; only the affected keys change
- tests: `engagementPocket.test.ts`, `operationBooklet.test.ts`,
  `e2e/feedColours.smoke.spec.ts`

**Forbidden:** any behaviour change. This slice renames and re-defaults only.

**Invariants:** never-raise versus legacy, depth invariance, and the
`slots_only`-mode move stream must be identical to today's `legacy`-mode stream
apart from the slot-feed percentage itself. Prove the last one by dumping with
`pocketSlotFeedPercent: 100` on both sides and diffing.

**Note on tooling:** file-wide regex renames are forbidden. Use exact-match edits
or `scripts/edit-lines.ts`.

**Required checks:**

```bash
npx tsx scripts/run-tests.ts
scripts/build-summary.sh
```

**Manager review record:** pending.

### S8 — Stop holding the reduced feed into already-cleared material

**Reported from real use, then reproduced.** On a user's part (0.25″ cutter,
0.32 stepover ratio, 60% slot feed, `engagement` mode, rounded corners) two
adjacent cuts near the island both render at slot feed. The lower one genuinely
bridges two cleared sides — a true slot, correctly slowed. The upper one runs
through **already-cleared material** and should be at full feed. Mirrored on the
opposite side, because the geometry is symmetric.

Measured on that file, saved as `src/engine/test-fixtures/pocket-feed-reduction.camj`:

| | |
| --- | --- |
| Nominal engagement for this stepover | 69° |
| Path at reduced feed | 22.1″ of 44.1″ (50%) |
| **Of that, unjustified** | **7.3″ — 33% of the reduced path** |
| Moves affected | **146 of 750** |

"Unjustified" means the estimator's own measurement at that move is **at or below
nominal** — the cutter is in cleared air or cutting no harder than an ordinary
stepover — while the emitted `feedScale` is still reduced. On the synthetic
island fixture the same query finds moves at literally **0°** emitting 0.40.

**Cause is the quantizer, not the estimator.** The estimator is right; it reports
0–67° at these moves. The reduced feed is carried forward by the rise hysteresis
and the minimum fragment length after a genuine slot. Measured recovery cost:

```
slot burst 4.8 mm, then 130 mm at exactly nominal
  -> 0.40 for 15.6 mm, then 1.00
```

**This settles the S6 disagreement against the worker.** S6's RISKS block argued
production genuinely sees those regions as engaged, so leaving them slow was
correct, and on that basis it implemented only the perimeter-scaled minimum.
Production's own estimator disproves it on real geometry. The declined fix is the
one that matters.

**Units are not implicated — audited, do not spend time there.** Every length in
the engagement path derives from a tool dimension (`minFragmentLength =
toolDiameter`, `baseStep = toolDiameter × 0.5`, `refinedStep = × 0.25`,
`refineSpan = × 2`, `ringMinFragmentLength = min(toolDiameter, perimeter / 8)`).
The only absolute constants are `1e-9`/`1e-12` degenerate-geometry guards, far
below any real move in either unit system, and the rest are dimensionless. The
classification is scale-invariant by construction; the inch project and the mm
fixtures fail identically for the same reason.

**Required fix.** A rise to **full feed** must not require the hysteresis margin.
Hysteresis exists to stop chatter at bucket boundaries; `1.0` is the ceiling,
with nothing above it to oscillate into. Bucket-to-bucket transitions keep the
current rule. Combined with S6's perimeter-scaled minimum this should clear the
146 moves.

**Allowed files:** `src/engine/toolpaths/engagement.ts`,
`src/engine/toolpaths/engagement.test.ts`, `src/engine/toolpaths/pocket.ts`,
`src/engine/toolpaths/engagementPocket.test.ts`

**Forbidden:** `src/types/project.ts`, `src/store/**`, `src/components/**`,
`src/i18n/**`, `src/theme/**`, and the estimator's geometry — the engagement
numbers are correct and must not move.

**Required test, stated as a property over the new fixture:** load
`src/engine/test-fixtures/pocket-feed-reduction.camj`, generate its pocket, and
assert that **no move whose measured engagement is at or below nominal emits a
reduced `feedScale`**. It currently fails with 146 violations; it must pass. Use
the estimator to measure each move against everything swept before it, the same
way the manager's probe does. Keep a synthetic case too, so the property is not
tied to one file.

**Also worth covering, untested until now:** this fixture is the first with
`featureDefinitions` and instances (3 of each) and the first in **inches**. The
S2d cache keys on canonical ring identity, and the S2d worker pinned 2 cache
misses on a multi-region band — each miss resolves conservatively to `π`, i.e. a
silently slow region. Report the miss count for this fixture rather than leaving
it unbounded.

**Invariants that must survive:** never-raise versus legacy, depth invariance,
byte-identical `slots_only` output, and no collapse in arc-fittable run length —
do not simply delete the minimum fragment rule.

**Required checks:**

```bash
npx tsx scripts/run-tests.ts
scripts/build-summary.sh
```

**Manager review record:** pending.

#### S8 addendum — the defect grows with geometric complexity

Two further user projects, saved as `pocket-feed-reduction-2.camj` and
`pocket-feed-reduction-3.camj` (all three are inches, 0.25″ cutter, 0.32
stepover, 60% slot feed, `engagement` mode):

| Fixture | Fed moves | Path | Reduced | Unjustified |
| --- | --- | --- | --- | --- |
| pocket-feed-reduction | 750 | 44.1″ | 50% | 7.3″ — 33% of reduced, 146 moves |
| pocket-feed-reduction-2 | 1551 | 48.1″ | 66% | 12.8″ — 40% of reduced, 253 moves |
| pocket-feed-reduction-3 | 1967 | 43.3″ | 58% | 10.9″ — **43%** of reduced, 434 moves |

The share of unearned slowing **rises** with complexity: more rings and more
ring-to-ring links mean more genuine slots, and each one opens a recovery window
that swallows the cutting after it. A fix validated only on the simplest fixture
would look successful while leaving the worst case largely intact.

**The required property must hold on all three**, and the violation counts above
are the before-figures to drive to zero.

#### S8 addendum 2 — the parallel pattern is the worst case

Two further user projects, saved as `pocket-feed-reduction-parallel.camj` and
`pocket-feed-reduction-parallel-2.camj`. Same tool and settings as the others
(inches, 0.25″, 0.32 stepover, 60% slot feed, `engagement`), but
`pocketPattern: 'parallel'`:

| Fixture | Pattern | Path | Reduced | Unjustified |
| --- | --- | --- | --- | --- |
| pocket-feed-reduction | offset | 44.1″ | 50% | 33% of reduced, 146 moves |
| pocket-feed-reduction-2 | offset | 48.1″ | 66% | 40% of reduced, 253 moves |
| pocket-feed-reduction-3 | offset | 43.3″ | 58% | 43% of reduced, 434 moves |
| pocket-feed-reduction-parallel | parallel | 49.2″ | 66% | **52%** of reduced, 74 moves |
| pocket-feed-reduction-parallel-2 | parallel | 59.5″ | **71%** | **56%** of reduced, 84 moves |

Parallel is structurally worse: long fill lines separated by short stepover
links, with the boundary contour and first fill line both classified as slotting.
Each recovery window therefore opens at the start of a long straightforward cut,
so a single event wastes far more path than the short ring segments of the offset
pattern do.

**These two are the acceptance bar.** A fix that clears the offset fixtures but
not these would pass a test written against the simple case while leaving the
worst real-world behaviour intact — 23.6″ of unearned slowing on a 59.5″ path.
Note also that the offending moves are fewer but longer (84 moves covering 23.6″
versus 434 covering 10.9″), so a violation *count* alone understates parallel;
assert on path length as well.

### S9 — Stop bucket-to-bucket merges dragging a cut to the slot feed

**S8 fixed the wrong-side-of-nominal case; this is the magnitude case.** The S8
acceptance property was binary — "no move at or below nominal may be reduced" —
and it was too weak. A move measured at **74°**, with nominal at 69°, passes that
test while being emitted at **0.60**: the full-slot floor, when the feed map
entitles it to ≈**0.92**. It is 4.5% of the way from nominal to a full slot and
is slowed as if it were slotting outright. *That was a manager specification
error; the S8 worker satisfied exactly what was asked.*

Reported from the app: on `pocket-feed-reduction.camj` the two long horizontal
cuts flanking the island render identically to the genuine bridging slots beside
them. They are not the same — the inner pair measures 180°, the outer pair 74° —
but both emit 0.60, so they look and cut the same.

**The correct property, measured against each move's own entitlement:**

> No move may emit a `feedScale` below `engagementFeedScale(e, nominal, slot)`
> for its own measured engagement `e`.

Current state on the five fixtures (this is *after* S8):

| Fixture | Over-slowed vs entitlement |
| --- | --- |
| pocket-feed-reduction (offset) | 10.6″ of 44.1″ — **24%**, 380 moves |
| pocket-feed-reduction-2 (offset) | 14.7″ of 48.1″ — **31%**, 928 moves |
| pocket-feed-reduction-3 (offset) | 8.1″ of 43.3″ — **19%**, 681 moves |
| pocket-feed-reduction-parallel | 6.1″ of 49.2″ — 12%, 88 moves |
| pocket-feed-reduction-parallel-2 | 6.9″ of 59.5″ — 12%, 130 moves |

Note the ranking **inverts** versus the S8 metric: offset is now the worse
pattern. Offset has many short ring segments adjacent to genuine slots, and
bucket-to-bucket merging drags them to the floor. Optimising against the old
metric would have aimed at the wrong pattern.

**Mechanism.** S8 correctly stopped merges that bridge the full-feed ceiling, but
bucket-to-bucket merges still consolidate and a merge takes the **lower** scale.
A 0.92 fragment adjacent to a 0.60 slot becomes 0.60.

**Three candidate rules — evaluate, do not assume:**

1. Forbid a merge that lowers a fragment by more than one rung.
2. Merge to a **length-weighted** scale rather than the minimum.
3. Drop merging for reduced fragments entirely and rely on S6's
   perimeter-scaled minimum alone.

Each trades cycle time against `feedScale` fragmentation, which is exactly what
the merge exists to protect — arc fitting refuses to join moves whose
`feedScale` differs at all (`sameRun`, `src/engine/gcode/arcFitting.ts`). Pick on
measurement, and state in the completion report which you chose and what the
other two scored.

**Hard bound — the arc-run constraint.** Current `slots_only` versus
`engagement`, from `scripts/pocket-output-probe.ts compare`:

| Fixture | runs (legacy → engagement) | longest run |
| --- | --- | --- |
| pocket-feed-reduction | 12 → 61 | 306 → 72 |
| pocket-feed-reduction-parallel-2 | 33 → 84 | 58 → 63 |

**The chosen rule must not increase the run count by more than 25% over these
engagement-mode figures, nor reduce the longest run below 50 on
`pocket-feed-reduction`.** A rule that fixes over-slowing by shattering the path
into hundreds of short feed fragments is not acceptable — it trades a cycle-time
defect for a G-code-quality one.

**Allowed files:** `src/engine/toolpaths/engagement.ts`,
`src/engine/toolpaths/engagement.test.ts`, `src/engine/toolpaths/pocket.ts`,
`src/engine/toolpaths/engagementPocket.test.ts`

**Forbidden:** the estimator's geometry, `src/types/project.ts`, `src/store/**`,
`src/components/**`, `src/i18n/**`, `src/theme/**`.

**Required tests:** the entitlement property above, asserted on **all five**
fixtures and on a synthetic case, with over-slowed path length bounded (state the
bound you achieve); plus an arc-run assertion against the table above.

**Invariants that must survive:** never-raise versus `slots_only` (0 violations
today), depth invariance (no new dependence), byte-identical `slots_only` output.

**Manager review record:** pending.

### S9 review — accepted, but it was not the dominant cause

Rule 1 chosen (refuse a merge that lowers a fragment by more than one rung).
Invariants hold: 0 raised versus `slots_only`, no new depth dependence, run count
+20%/+9.5% (bound +25%), longest run 72 (floor 50). Merged as `78c8b34`.

Effect was small — over-slowed path, before → after S9:

| Fixture | Before | After |
| --- | --- | --- |
| pocket-feed-reduction | 10.6″ | 10.0″ |
| pocket-feed-reduction-2 | 14.7″ | 13.1″ |
| pocket-feed-reduction-3 | 8.1″ | 7.3″ |
| pocket-feed-reduction-parallel | 6.1″ | 6.1″ |
| pocket-feed-reduction-parallel-2 | 6.9″ | 6.8″ |

### What has now been ruled out, with evidence

**1. The metric is sound.** Concern: the manager's probe samples one midpoint per
move while production classifies per chunk (`toolDiameter × 0.5`, three interior
points, max per chunk), so a long move with varying engagement could be misjudged.
Re-measured at production's own granularity: `10.0″ → 8.9″` on test1 and
`6.8″ → 7.0″` on test7. The gap is minor; **the over-slowing is real**, about 20%
of path on offset and 12% on parallel.

**2. The fragment merge is not the dominant cause.** S9 targeted it directly and
recovered ~0.6″ of 10.6″.

**3. The per-band cache's order divergence is not the cause.** The S9 worker's
RISKS block attributed the residual to the cache classifying against a canonical
traversal whose engagement differs from emission order. Production's own
`engagementTelemetry` disproves it — production and emission-order truth agree:

| Fixture | production `distanceAboveNominal` | emission-order truth |
| --- | --- | --- |
| test1 | 30.8″ of 44.1″ | 31.4″ of 44.1″ |
| test7 | 23.3″ of 59.5″ | 27.9″ of 59.5″ |

Production is not seeing *more* engagement than reality; on parallel it sees
slightly less. So it knows the engagement is low at those moves and emits a low
feed anyway. The cause is downstream of the estimate.

**4. There is no under-slowing worth worrying about.** Emitted above entitlement:
0.5″ (1%, 20 moves) on test1, **0.0″** on test7. The conservative bias holds, so
none of this is a safety concern — it is purely cycle time.

### Where to look next — do not guess again

Three plausible causes have now been tested and eliminated. The remaining
candidates are all in the chunk→fragment→scale assignment inside
`applyEngagementFeedToLevel`, not in the estimator and not in the merge:

- the hold/hysteresis path that survived S8 and S9,
- the legacy-slot clamp spans (`legacySlotSpans`) over-covering,
- the chunk→fragment walk assigning a fragment's scale to chunks it does not own.

**The next slice should instrument that assignment before changing it** — emit,
per chunk, the measured engagement, the entitled scale, the fragment it was
assigned to and that fragment's scale. The three marginal slices in a row (S6,
S8, S9) all came from acting on a plausible mechanism rather than an observed
one. The instrumentation is cheap and the answer is currently unknown.

### S10 diagnosis and fix — exact emitted-traversal cache

The requested chunk-to-fragment instrumentation showed that assignment,
hysteresis, and the legacy-slot clamp were behaving correctly on the concrete
defect. The cached input was already wrong: on the long horizontal cut through
`x = 2`, `y = 0.705` in `pocket-feed-reduction.camj`, the cache supplied `π`
engagement (0.60 rung), while an emission-order replay measured about 1.29 rad
(74 degrees, 0.92 rung).

This overturns conclusion 3 above. Aggregate telemetry was too coarse to detect
a pointwise redistribution of engagement: similar total distance above nominal
did not mean the same moves had been classified the same way. The per-band
canonical traversal omitted or reordered real prior cuts relative to the
position-seeded emitted traversal.

The fix keeps the existing emitted path order unchanged and caches engagement
classification by the exact ordered cut-segment stream for each distinct level
traversal. Identical levels reuse one classification; a genuinely different
traversal gets its own. Cache lookup verifies both the cut occurrence and exact
coordinates, so repeated geometry cannot silently reuse another occurrence's
prior-cut context. Ring-perimeter metadata remains geometry-only and is shared
across those classifications.

Evidence after the fix:

- The defect cut now emits 0.92 from `x = 1.146875` through `x = 2.84`; the
  former 0.60 span from `x = 1.2675` through `x = 2.7775` is gone.
- All five real fixtures have zero moves raised above `slots_only` at the same
  point.
- `pocket-feed-reduction` has 69 feed runs (before fix: 73) and longest run 72,
  preserving the S9 arc-run constraint.
- The focused pocket suite asserts byte-identical `slots_only`, never-raise,
  depth invariance, zero cache misses, exact multi-lobe traversal handling, and
  the real `x = 2`, `y = 0.705` regression.
