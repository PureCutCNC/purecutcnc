---
status: current
authoritative-for: delegated execution state for issue 622 feed reduction and corner controls
last-verified: 2026-08-25
---

# Integration Handoff — Issue #622 Feed Reduction and Corner Controls

> The approved GitHub issue remains the plan and source of truth. This file
> records delegated slice execution only.

## Role and stop condition

The integration manager turns issue #622 into worker slices, independently
reviews each slice against the real diff and the real emitted geometry, and
delivers one pull request once the behaviour and the required checks are green.

## Integration state

- Integration branch: `fix/issue-622-feed-and-corner-controls`
- Base commit: `a8e09a1` (`main` after #632)
- Approved issue and plan: https://github.com/PureCutCNC/purecutcnc/issues/622
- Manager session: 2026-08-25
- Status: `slices 1, 2, 4 landed; slice 3 (D4) parked unmerged; slice 5 dispatched, awaiting review`
- User authorization for external-worker dispatch: granted 2026-08-25 for as
  many slices as the issue needs.

## Slices

`src/engine/toolpaths/pocket.ts` is the contention point for D1, D4 and D5, so
those stay sequential and manager-owned. Only slices with disjoint file
ownership are delegated.

| slice | scope | owner | state |
| --- | --- | --- | --- |
| 1 | D1 + D2 — one `applyLevelFeed` per finish band level (`pocket.ts`, `surface.ts`) | manager | landed |
| 2 | D6 — feed-colour legend scoped to the selected operation | delegated | landed |
| 3 | D4 — Z-invariant traversal | manager | **parked unmerged** on `wip/issue-622-d4-seam-anchor` |
| 4 | D5 — `cleanWallCorners` on the finish wall contour | manager | landed |
| 5 | audit fixtures per (kind, control) | delegated | dispatched 2026-08-26, in flight |

## Slice 2 — the legend describes the selected operation

### The decision

Recorded by the owner on the issue: **scope the legend to the selected
operation.** One operation is one rung ladder, and within one ladder the ramp
index and the feed scale are in bijection — so the duplicate label and the
non-monotonic ramp both become unreachable rather than merely unlikely.

### What is wrong today

`unionFeedColourLegendSteps` (`src/components/toolpathVisibility.ts`) unions
every toolpath in the preview and dedupes by `scale:step`. With a 60 % rough and
a 70 % finish in one project that produces fifteen entries:

```
rough  slot 60%   1.0000  0.9800  0.9600  0.9200  0.8400  0.7600  0.6800  0.6000
finish slot 70%   1.0000  0.9850  0.9700  0.9400  0.8800  0.8200  0.7600  0.7000
union             100 99 98 97 96 94 92 88 84 82 76 76 70 68 60
```

Two distinct failures:

1. `76%` twice — scale 0.76 is rung 5 of the 60 % ladder and rung 6 of the 70 %
   ladder, so both survive the dedupe, in two different colours.
2. The ramp is not monotonic in the label — `70%` is rung 7 (darkest of its
   ladder) and `68%` is rung 6 (lighter), so the higher feed gets the darker
   swatch.

### Required shape

- The legend derives from the **selected** operation's toolpath and that
  operation's own slot scale. `feedColourLegendSteps(toolpath, slotScale)` is
  already exported and is the per-toolpath scan to use; the union helper is what
  goes away at the call sites.
- Both call sites already have the selection in scope:
  `Viewport3D.tsx` computes `selectedToolpathForLegend`, and `SketchCanvas.tsx`
  takes `selectedOperationId` as a prop.
- With no operation selected, or the selected operation having no toolpath, the
  legend shows nothing. The panel already hides an empty legend, so this needs
  no new panel branch.
- Keep the per-toolpath `WeakMap` cache. No move scan may run on a render path.

### The test that records today's behaviour, and must be inverted

`e2e/feedColours.smoke.spec.ts` has
`'mixed pockets show the union of emitted scales in both panels, independent of
selection'`, which asserts `['100%','99%','95%','85%','75%','60%']` stays the
same whichever operation is selected. **That test encodes the defect.** Rewrite
it so each selection shows its own operation's ladder, and say in a comment why
the union assertion is gone. The same applies to any union assertion in
`src/components/toolpathFeedLegend.test.ts`.

### Watch items

- `SketchCanvas.tsx` sits under a `max-lines` ESLint ratchet. The change should
  be net-neutral or smaller; do not raise the cap.
- `feedLegendStepLabels`'s escalating-decimals logic exists because the fine top
  rungs collide at high slot feeds *within one ladder* (slot 90 % yields two
  `100 %` entries at whole percents). That is a separate, still-real concern —
  leave it alone.
- `toolpathFeedLegendCpu.test.ts` guards that the legend scan does not run per
  render. Keep whatever it asserts true.

### Slice 2 dispatch card

- **Slice id:** `legend-selected-op`
- **Summary:** the feed-colour legend describes the selected operation instead of
  the union of every toolpath in the preview.
- **Allowed files:**
  `src/components/toolpathVisibility.ts`,
  `src/components/canvas/SketchCanvas.tsx`,
  `src/components/viewport3d/Viewport3D.tsx`,
  `src/components/toolpathFeedLegend.test.ts`,
  `src/components/toolpathFeedLegendCpu.test.ts`,
  `e2e/feedColours.smoke.spec.ts`
- **Forbidden files:** everything under `src/engine/**` (the manager owns
  `pocket.ts` and `surface.ts` on this branch), `src/theme/**`, `src/types/**`,
  `src/store/**`, and every other `planning/` document.
- **Required invariants:**
  1. A legend rendered for one operation can never contain two entries with the
     same label, and its ramp step increases monotonically as the scale falls.
  2. No move scan on a render path — the per-toolpath `WeakMap` cache stays.
  3. `src/theme/palette.ts` is untouched; this is a scoping change, not a
     colour-mapping change.
  4. The e2e union assertion is rewritten, not deleted, and its replacement says
     why the union is gone.
- **Required checks:** `npx tsx src/components/toolpathFeedLegend.test.ts`,
  `npx tsx src/components/toolpathFeedLegendCpu.test.ts`,
  `scripts/build-summary.sh` once, and
  `PURECUT_E2E_PORT=1441 PURECUT_E2E_ISOLATED=1 npx playwright test e2e/feedColours.smoke.spec.ts --workers=2`
  (kill strays afterwards with `lsof -ti tcp:1441 | xargs -r kill`).


## Slice 2 — accepted with a manager correction

The worker's scoping change was correct at both call sites. It was merged only
after a defect the slice's own checks could not have caught.

`unionFeedColourLegendSteps` was the only place the legend steps were **sorted**.
`scanFeedColourLegendSteps` returns first-encounter order — whatever order the
toolpath emits its scales in — so moving the panel onto `feedColourLegendSteps`
handed it an unordered ladder and it rendered `75%` first.

Three e2e assertions caught it, two of them in tests the slice never touched.
The worker's own Playwright run had failed to start (no `node_modules` in the
task worktree, so `vite.config.ts` would not load) and it proceeded anyway, so
the new legend expectations had never been executed once. `npm run build` passed
throughout — it does not run e2e.

Manager fix in `3431156`: sort in `feedColourLegendSteps`, not in the scan, so
the scan stays a pure encounter-order primitive and the sort is paid once per
cache miss and stored in the `WeakMap` alongside the steps. Re-run: 5 passed.

**Process lesson for the remaining delegated slices:** a task worktree has no
`node_modules`. Symlink the primary checkout's copy before dispatching any slice
whose required checks include Playwright, or the worker will silently skip them.

Two items accepted rather than corrected, both recorded rather than acted on:

- the worker edited this ledger's status table, which the dispatch card
  forbade — benign and accurate, so it stands;
- `unionFeedColourLegendSteps` is now dead in production. The worker kept it
  with a comment calling it a building block for a future multi-toolpath
  summary. That is speculative, but removing it is outside the slice.

## Slice 3 — D4, first approach rejected

Discarding the carried position at the start of each level (`currentPosition =
null`) makes every level byte-identical — 0 divergent segments on four fixtures
in both reduction modes — but emits a **discontinuous move stream**: the
traverse from the previous level's end to the new entry disappears into a
fabricated zero-length rapid, because `retractToSafe(moves, null, …)` emits
nothing and `pushRapidAndPlunge` starts from the destination. Not a gouge, but
every consumer that walks the chain — simulation, the 3D preview, the time
estimator — is then wrong about the travel. It also invalidated the "cheaper
travel" figure first reported on the issue, which had measured the broken chain.

The fix has to separate the two roles `currentPosition` currently plays:
`transitionToCutEntry` must keep receiving the real position so the stream stays
chained, while `nextRoughSection`'s ordering and `rotateContourToNearestEntry`'s
seam take a level-invariant planning seed. That is a parameter threaded through
`cutOffsetRegionNode` / `cutOffsetNodeRings`, which are shared with the pocket
finish floor, `surface_clean` and `rough_surface`.

### Slice 3 — the design, and the obstacle in the way of it

The seam choice and the motion source must separate, but the discontinuity was
**not** caused by choosing a canonical seam — it was caused by passing `null` as
the transition's `from`. Choosing the seam canonically while still passing the
real position keeps the stream chained: the level-boundary traverse simply
targets a different point.

```
today   [1108] rapid (58,38,4) -> (58,38,25)            retract
        [1109] rapid (58,38,25) -> (40.283,20.283,25)   traverse to the nearest seam
wanted  [1109] rapid (58,38,25) -> (40.400,20.000,25)   traverse to the canonical seam
```

So the parameter to thread is a **seam anchor**, consumed only by the first
contour's `rotateContourToNearestEntry` / ordering, while `fromPosition` keeps
driving `transitionToCutEntry` untouched.

The obstacle is shape, not logic: `cutOffsetNodeRings` already takes seventeen
positional parameters and `cutOffsetRegionNode` mirrors it. An eighteenth
positional flag would be the wrong answer — per AGENTS.md's structural
conventions this is the point at which the parameter list should become an
options object. That refactor touches every caller (pocket rough, pocket finish
floor, `surface_clean`, `rough_surface`), so it wants to be its own slice with
byte-identity evidence per caller **before** the seam anchor is introduced, not
bundled with it.

Suggested split:

1. `cutOffsetNodeRings` / `cutOffsetRegionNode` take an options object;
   byte-identical output asserted for every caller.
2. The seam anchor is added to that object and set level-invariantly by the
   rough band; per-level identity asserted, move-chain continuity asserted
   (`from` of every move equals `to` of the previous one).


## Slice 3 — parked, and why

The seam-anchor fix works: `levelInvariance.test.ts` passes 19/19, every level
emits byte-identical geometry and feed across pocket and `surface_clean` with
zero chain breaks, and 8 of its 9 invariance assertions fail against the pre-fix
engine. It is committed on `wip/issue-622-d4-seam-anchor` and merged nowhere.

It is parked because the owner did not ask for it. The question was *why do the
cleanup loops jump left and right between the two rough passes* — a question,
answered by: per-level traversal is seeded from wherever the previous level
finished, so seams and S-links land differently at each depth. Turning that
explanation into a change removed a deliberate travel optimisation and tripped
`engagementPocket.test.ts`'s cache-equivalence test, whose three-lobe fixture
exists **to prove that per-level traversals differ** — i.e. the behaviour is
documented design, not an oversight.

Costs measured before parking, so a later decision has numbers rather than
adjectives:

| fixture | sections | levels | rapid XY |
| --- | --- | --- | --- |
| pocket, no island | 1 | 3 | 50.1 -> 50.3 mm (+0.5 %) |
| pocket, island | several | 3 | 350 -> 420 mm (+20 %) |
| `surface_clean`, two bosses | several | 14 | 879 -> 1932 mm (+120 %) |

The cost scales with sections x level boundaries, not with the seam rotation:
with a single section it is ~nothing. In cycle-time terms the worst case is
small — 1,053 mm of extra rapid against 24 m of cutting is roughly 0.3–1.2 %
depending on the machine's rapid rate — but it buys determinism nobody asked for.

If it is ever revived: `engagementPocket.test.ts`'s cache-equivalence premise has
to be inverted (levels then share one traversal, so one classification is built
and every level consumes it), and the depth-dependent feed it fixes should be
argued on its own merits first.

## Slice 5 — clearing-control effect contract

### What this is for

`operationFields.test.ts` already asserts that the panel's exposed set matches
`CLEARING_CONTROL_SUPPORT`. Nothing asserts that a control declared to apply
actually **does the thing its name says, in the place its name says**. That gap
is what let D5 ship: `cleanWallCorners` was declared to apply to `pocket`, the
panel offered it, toggling it changed the output — every existing check passed —
and it was rounding the wrong ring the whole time. The owner found it by looking
at the preview.

An on/off sweep cannot close this. The manager ran one across every kind and
every control: it produced four "offered but inert" flags and **all four were
fixture limitations, not defects**, while all five real defects in this issue
were invisible to it. So this slice asserts *where the effect lands*.

### The deliverable

One new test file, `src/engine/toolpaths/clearingControlEffects.test.ts`, that
walks `CLEARING_CONTROL_SUPPORT` and for every (kind, control) cell asserts:

- **declared `applies: false`** — toggling the control leaves the emitted move
  stream byte-identical, on a fixture that could have expressed it;
- **declared `applies: true`** — toggling changes the output **and** the change
  lands where the control claims, per the predicate table below.

Iterate the declaration rather than hand-listing cells, so a new kind or control
fails until it is classified — the same ratchet the declaration already carries.

### Predicates — what "lands in the right place" means

| control | assert |
| --- | --- |
| `roundOutsideCorners` | the clearing rings' sharpest single-vertex turn drops; a sharp turn is replaced by an arc of many small turns |
| `cleanWallCorners` | the **wall-defining** ring gains motion, and the interior rings and floor do not. For a finish pass the wall-defining ring is the wall contour, not the outermost floor ring — that distinction is the D5 defect and this is its regression test |
| `slotFeed` | `feedScale` appears, equals exactly `pocketSlotFeedPercent / 100`, and appears only on cuts that are far from any prior kerf |
| `engagementMode` | more than one distinct `feedScale` is emitted — a ladder, not a single rung |
| `machiningOrder` | `feature_first` emits each feature's moves contiguously; `level_first` interleaves them |
| `cornerRelief` | extra motion appears at the region's **concave** corners and nowhere else |

Out of scope: `roundLinkCorners` and `pocketPattern`. They are owned by
`usesTangentLinks` and `OPERATION_PATTERN_SUPPORT`, not by
`CLEARING_CONTROL_SUPPORT`, and pulling them in widens the slice past one file.

### Fixtures — read this before writing any

Every false "inert" in the manager's sweep came from a fixture that could not
express the control. A cell that cannot be exercised must be **skipped with a
recorded reason in the test**, never asserted as inert.

- `cornerRelief` needs a **concave** corner. A plain rectangle has none, which is
  why relief read as inert on `edge_route_outside`.
- `machiningOrder` needs **two or more target features**. A single-feature
  `rough_surface` is byte-identical under both settings by design —
  `roughSurface.test.ts:1375` asserts exactly that.
- `finish_surface` offers `parallel`/`waterline`; `offset` **resolves to**
  `parallel`, so an offset↔parallel toggle compares a pattern with itself.
- `finish_surface_cleanup` × `roundOutsideCorners` is wired
  (`floorSmoothRadius`, `finishSurfaceCleanup.ts:765`) but its level boundaries
  are sliced model silhouettes, which `planContourSmoothing` leaves alone when
  the path already tracks a circle at least as broad as the request. If no
  fixture can make it bite, record that as the reason rather than asserting.
- `edge_route_inside` produced no moves at all in the sweep — it needs a closed
  region to cut inside of. Close that gap or record why it stays open.

Build 2D fixtures in the test file with the existing helpers. For the 3D kinds
reuse the committed `.camj` fixtures (`3d-imported-block-test3.camj`,
`model-in-pocket.camj`) rather than adding new ones.

### Slice 5 dispatch card

- **Slice id:** `control-effect-contract`
- **Allowed files:** `src/engine/toolpaths/clearingControlEffects.test.ts` (new),
  `src/engine/toolpaths/INDEX.md` (its Tests entry only).
- **Forbidden files:** every other file. In particular **all engine source** —
  `pocket.ts`, `surface.ts`, `roughSurface.ts`, `finishSurfaceCleanup.ts`,
  `clearingControls.ts` — is manager-owned on this branch. If a predicate cannot
  be satisfied, that is a **finding to report**, not a licence to change the
  engine. Report it in `RISKS` and leave the assertion failing or skipped with a
  reason.
- **Required invariants:**
  1. The suite iterates the declaration; it does not hand-list cells.
  2. A cell that cannot be exercised is skipped with a written reason, never
     asserted as inert.
  3. Assertions are on the **location** of the effect, not merely that the move
     stream changed.
  4. No engine behaviour changes. `npm run build` must be green **without** any
     edit outside the two allowed files.
- **Required checks:** `npx tsx src/engine/toolpaths/clearingControlEffects.test.ts`,
  `npx tsx src/engine/toolpaths/operationFields.test.ts` (or wherever the
  declaration test lives), and `scripts/build-summary.sh` once.
- **Note:** a task worktree may lack `node_modules`. If a check cannot run, say
  so in `CHECKS` — do not report a check as passed that you did not run.


## Session handoff — state as of slice 5 dispatch

Everything needed to pick this up is on disk or on the issue; nothing
load-bearing lives only in a conversation.

**Branch.** `fix/issue-622-feed-and-corner-controls`, local only, not pushed, no
PR. Landed: D1+D2 (finish wall block feed classification), D6 (legend scoped to
the selected operation), the `OffsetRingOptions` refactor, D5 (wall-corner
rounding moved onto the finish wall contour). `npm run build` green at
`3829781`.

**Parked.** `wip/issue-622-d4-seam-anchor` holds the D4 seam-anchor experiment,
merged nowhere. Its costs and the reason it is parked are recorded above. Do not
revive it without an explicit owner decision — the behaviour it changes is
documented design, not a defect.

**In flight.** One delegated slice:

- slug `control-effect-contract`, branch `feat/issue-622-control-effect-contract`
- worktree `$PURECUT_WORKTREE_BASE/control-effect-contract`
- poll with `scripts/worker-status.sh --slug control-effect-contract`
- `node_modules` was symlinked into the worktree at dispatch, so its checks can
  actually run — the previous slice's Playwright run failed to start for want of
  it and the worker proceeded anyway
- merge with
  `scripts/finish-task.sh --slug control-effect-contract --base fix/issue-622-feed-and-corner-controls`
  **after** review, never on the strength of the completion block

**Review obligations for slice 5**, learned the hard way on slice 2:

1. Confirm each reported check actually ran. Slice 2 reported a green build while
   its e2e run had failed to start; three assertions were wrong.
2. Treat every "skipped with a reason" as a claim to test. A cell skipped because
   the worker could not build a fixture is not the same as a cell that cannot be
   exercised, and the difference is the whole point of the slice.
3. Mutation-check the `cleanWallCorners` row against `3829781^` — it must fail
   there, since that is the commit where the control still rounded the floor
   root. If it passes against the pre-D5 engine it is not testing D5.
4. Read the real diff, not the report.

**Remaining after slice 5:** rebase onto current `main`, `npm run build`,
`npm run test:e2e`, then open the PR with `Closes #622`. The issue body carries
D1–D6 with their measurements; D3 is recorded as withdrawn and D4 as parked, and
both should stay that way in the PR description.

**Filed separately:** #635, the finish pass's inner double-slot opening —
pre-existing since v0.3.0, deliberately out of this issue's scope.
