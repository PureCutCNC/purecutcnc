---
status: current
authoritative-for: issue #452 delegated slice execution state and ledger
last-verified: 2026-08-05
---

# Integration Handoff — Region domain redesign (#452)

> Execution ledger for delegated multi-slice work on issue #452. The GitHub
> issue is the approved plan and source of truth; this file records execution
> state only. Do not store tokens, raw environment values, or unredacted
> provider debug output here.

## Role and stop condition

The integration manager turns the approved plan in
[#452](https://github.com/PureCutCNC/purecutcnc/issues/452) into sequential
worktree slices, independently reviews and verifies each slice, and merges only
accepted commits into the integration branch. Stop condition: all six phases
merged into the integration branch, green build, one PR opened against `main`
with `Closes #452`.

## Integration state

- Integration branch: `feat/issue-452-region-domain`
- Integration worktree: `/Users/frankp/Projects/worktrees/purecutcnc/optimistic-cannon-2e722c`
- Base commit: `240e15be1d61649b0fc18221031a18012910c156`
- Approved issue and plan: https://github.com/PureCutCNC/purecutcnc/issues/452#issuecomment-5199629410
- Manager session: 2026-08-05
- Status: `slice in progress`
- User authorization for credential-backed worker dispatch: `granted 2026-08-05 for all six slices of this issue`

## Global rules

- One active implementation slice at a time.
- Every worker runs in its own task worktree branched from the current
  integration tip, never in the integration checkout.
- The worker may use `bypassPermissions` only through the project launcher in
  explicit implementation mode.
- The manager owns worktree/branch creation, review, merge, cleanup, issue-plan
  updates, browser regression, push, and PR decisions.
- Reject any worker result without exactly one expected task commit, a clean
  task worktree, scoped changes, and truthful required-check results.
- `src/engine/toolpaths/**` is a protected path: full lane, never fast lane.
  Every slice needs focused unit tests and a green `npm run build`.

## Design contract for every slice

The full model lives in the approved issue comment. The load-bearing points a
worker must not re-derive:

1. **Regions resolve into the operation's domain before generation.** No
   post-generation move filtering. Generators become region-unaware.
2. **The domain is typed.** Area operations intersect polygons; curve
   operations split guides into ordered open spans; drilling filters points.
   Never apply area intersection to a curve domain — it turns the region's edge
   into a machined contour.
3. **Polarity implies the mode; there is no new user-facing control.**
   `include` → coverage (`D ∩ (R ⊕ r)`), `exclude` → containment (`D \ X`).
4. **`r` is the operation's effective centre inset** (`tool.radius +
   stockToLeaveRadial`), computed once per operation and reused. Two
   approximations of one clearance is how a seam becomes a gouge.
5. **`masked output ⊆ unmasked output`** in both polarities, always. Coverage
   over-reach is bounded by the operation's own domain `D`, never by the region,
   so a region can only narrow what gets cut and can never introduce a cut.
6. **Entry clearance regions and link-containment checks must be built from the
   masked domain**, not the original.
7. **Region boundaries never become cutting moves in their own right.**

## Slice ledger

| Slice | Branch | Status | Commit | Merged |
| --- | --- | --- | --- | --- |
| p0-rough-surface-guard | `feat/issue-452-p0-rough-surface-guard` | accepted | `330cd76` | `f62924a` |
| p1-region-domain-resolver | `feat/issue-452-p1-region-domain-resolver` | accepted | `e302911` | `8b96d33` |
| p2-area-generators | `feat/issue-452-p2-area-generators` | dispatched | — | — |
| p3-curve-generators | `feat/issue-452-p3-curve-generators` | pending | — | — |
| p4-trochoidal-regions | `feat/issue-452-p4-trochoidal-regions` | pending | — | — |
| p5-delete-clippers | `feat/issue-452-p5-delete-clippers` | pending | — | — |

Dependencies: p0 and p1 are independent of everything and of each other. p2, p3
and p4 each require p1. p5 requires p2, p3 and p4.

## Worker protocol notes

- **p0 reported `STATUS: complete` with `COMMIT: none`.** The diff, tests and
  build gate were all correct and independently verified, but the worker left
  the work staged-but-uncommitted. The manager committed the reviewed diff and
  merged. Subsequent prompts state the one-commit requirement explicitly and in
  stronger terms; if the pattern repeats, treat it as a launcher-level problem
  rather than a per-slice one.

## Debt to clear before the PR

- `regionDomain.ts` duplicates ~90 lines of geometry predicates from
  `guideFragments.ts` (`segmentIntersectionParams`, `pointInWorldPath`,
  `distinctSorted`, `pointAt`, `sameWorldPoint`, `normalizeWorldPath`). The
  copies are semantically identical — both use `XY_EPSILON = 1e-9`, verified at
  review — but two copies of subtle geometry predicates will drift. p1's prompt
  forbade touching `guideFragments.ts`, which forced the duplication; that was a
  prompt defect, not a worker one. **p3 owns the fix**: export the shared helpers
  from `guideFragments.ts` and delete the copies.

## Notes

- Dispatch from this worktree requires
  `DEEPSEEK_AGENT_ENV_FILE=/Users/frankp/Projects/purecutcnc/.env.agent` —
  `.env.agent` exists only in the primary checkout.
- `--base feat/issue-452-region-domain` on every dispatch and finish; the script
  default (`feat/core-arch-simplification`) is the wrong branch for this work.
