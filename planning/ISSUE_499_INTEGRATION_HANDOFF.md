---
status: current
authoritative-for: issue #499 fixture-pack contract, span measurement, and manager review ledger
last-verified: 2026-08-16
---

# Integration Handoff — Corner unwinding at inside corners of offset rings (#499)

Execution ledger for issue #499 (tier 2a of #497) on `feat/issue-499-corner-unwinding`.
The GitHub issue is the plan of record; this file carries the slice contracts and
the manager's review record so they cannot drift between slices.

Reopened 2026-08-16 after its trigger fired. See the issue for the evidence.

## Why slice 1 is a fixture pack and not the feature

#497 specified a shared fixture pack — rectangular pocket, acute corner, curved
corner, long neck, island pinch, multi-section pocket, tiny pocket, large complex
boundary — "built once, in #498, and reused by every child."

It was never built. What exists is the builtin matrix in
`scripts/pocket-output-probe.ts:169`, and every pocket in it is rectangular: a
60×60 square, a square with a round island, and a three-rect neck. That matrix is
sound for the job it was written for — proving output did not change — but it
cannot rank tiers against each other, and it contains **no acute corner at all**,
which is where corner engagement is worst.

Two consequences that make this blocking rather than housekeeping:

1. **Slice 2's qualifier threshold has no source.** The corner qualifier needs a
   turn-angle threshold and a span threshold. Both must be derived from measured
   geometry. Without the pack they would be guessed.
2. **A guessed threshold produces whatever answer it encodes.** When the tiers
   were first ranked, slowed cutting was split into "corner spikes" and "slotting
   cores" at a run length of two tool diameters. The spike decays over roughly two
   tool diameters *either side* of a corner, so a corner run is about four — the
   cutoff halved every corner and filed it as too small to matter, and the ranking
   came out backwards. Recorded in the issue as a methodological warning.

**Therefore span is an output of slice 1, never an input.** No threshold may be
written into slice 1's code or tests as a constant to be met.

## Fixture pack contract

Location: `src/test/pocketFixturePack.ts`, beside `projectFixtures.ts`, which it
reuses. TypeScript builders, not `.camj` blobs — the pack must be parametric in
tool diameter and stepover so that any span result expressed in tool diameters
can be checked for tool-independence.

| Fixture | Must isolate |
| --- | --- |
| `rectangular` | Baseline. The 90° interior corner already measured in #498 |
| `acuteCorner` | Worst-case corner engagement. Currently untested anywhere in the repo |
| `curvedCorner` | Where a turn-angle qualifier must **not** fire — tessellated arcs |
| `longNeck` | #500's territory; present so it can be excluded from #499's numbers |
| `islandPinch` | As above, and the case whose boundary geometry gives no hint |
| `multiSection` | Per-section innermost loops; level-ordering effects |
| `tinyPocket` | Degenerate — pocket smaller than an unwind excursion would need |
| `largeComplex` | Cost and determinism at scale |

Each builder returns a `Project` with one `pocket` operation, `pocketPattern:
'offset'`, and a documented reason for every geometric constant it chooses.

## Measurement contract

Per fixture, generated with `pocketFeedReduction: 'engagement'`:

- **Telemetry**, from the shipped `EngagementTelemetry`: `maxEngagement`,
  `p95Engagement`, `distanceAboveNominal`, `totalCutDistance`.
- **Nominal**, from `nominalEngagement(stepover · diameter, radius)`.
- **Spike runs.** Take the contiguous runs of sampled cut path whose engagement
  exceeds nominal. For each run record its **path length** and its **peak
  engagement**. Report per fixture: run count, and the median / p95 / max of run
  length, expressed **both** in project units and in tool diameters.
- **Cost and shape**, as #497 asked: estimated time, point count, feed-change
  count, recovered arc runs, determinism.

Spike span is the median/p95/max of those run lengths. That is the quantity
slice 2's qualifier is derived from, and the reason this slice exists.

### The oracle must be independent

The acute-corner engagement figure must be cross-checked against a **brute-force
leading-semicircle sampler written in the test file** — point-sample the leading
semicircle and test each point against the prior swept capsules directly. That is
a different algorithm from the production arc-union in `engagement.ts`, which is
the point: the estimator must not grade its own homework. #498's manager probe
used exactly this construction and agreed to ~2e-4 rad.

Do **not** import the production estimator to compute the expected value.

### Regression anchor

The pack must reproduce #498's measured 60 mm square figures, which are recorded
in `planning/ISSUE_498_INTEGRATION_HANDOFF.md` line 294 — `r = 3`, stepover
`2.4`, real `inner-first` ring order:

| Position | Engagement |
| --- | --- |
| Straight run | `1.3695` rad (matches `nominalEngagement(2.4, 3) = 1.3694`) |
| Near corner, max | `2.9404` rad (168°) |

If the pack cannot reproduce these, either the pack or the estimator has drifted
since #498 — stop and report it rather than adjusting the expected values.

Carry over #498's caveat: the wall-adjacent ring 0 counts retained material
beyond the wall as stock and overstates its engagement. Rings 1+ carry the
finding. Report ring 0 separately or exclude it, and say which.

## Slice S1 — the fixture pack and its measurement

**Allowed files (both new):**

- `src/test/pocketFixturePack.ts`
- `src/engine/toolpaths/pocketFixturePack.test.ts`

**Forbidden — no production behaviour changes in this slice.** Explicitly:
`src/engine/toolpaths/pocket.ts`, `src/engine/toolpaths/engagement.ts`,
`src/types/project.ts`, `src/store/**`, `scripts/**`, and every file not listed
as allowed. If the slice appears to require editing one of these, stop and report
blocked.

**Invariants:**

- No production code changes. `npm run build` must be green with the engine
  untouched.
- Deterministic: no `Math.random`, no `Date.now`, stable iteration order. The
  determinism check regenerates each fixture and asserts identical output.
- Measure cost with **CPU time, never wall clock** (`AGENTS.md` §Build & Verify;
  wall-clock assertions cost #383 and #386).
- No threshold constants. The test reports measured spans; it must not assert a
  span is under a number chosen in advance. Assertions belong on the regression
  anchor and on determinism, not on span.
- Apache licence header on both new files; strict TypeScript, no `any`, no
  non-null assertions.

**Required checks:**

- `npx tsx scripts/run-tests.ts src/engine/toolpaths/pocketFixturePack.test.ts`
- `scripts/build-summary.sh` (once — re-read its log rather than re-running)

**Report:** the measured table, per fixture, in the completion block's narration —
it is the deliverable, not a side effect.

## Review record

- S1 dispatch: pending.
