# Regression Tests — Handoff 2: Audit-and-fill (editing ops / CAM smoke / lifecycle)

Implementation handoff. Read `AGENTS.md`, root `planning/INDEX.md`, and
`planning/REGRESSION_TESTS_Plan.md` first (this implements its **Phase 3**). Follow
Plan → confirm scope → Implement. You own ONLY this slice's worktree; finish with ONE simple commit
and a report. Do not merge, open a PR, or run browser validation.

## Branch / base / worktree

- Integration branch: `feature-references-v2` (use the current tip of `origin/feature-references-v2`;
  Handoff 1 + the delete→GC fix are already merged there).
- Slice branch: **`regression-tests-2-audit-fill`**
- Worktree: `/Users/frankp/Projects/worktrees/purecutcnc/regression-tests-2-audit-fill`
- Setup (no `npm install`):
  ```bash
  git -C /Users/frankp/Projects/purecutcnc worktree add \
    /Users/frankp/Projects/worktrees/purecutcnc/regression-tests-2-audit-fill \
    -b regression-tests-2-audit-fill origin/feature-references-v2
  cd /Users/frankp/Projects/worktrees/purecutcnc/regression-tests-2-audit-fill
  ln -s /Users/frankp/Projects/purecutcnc/node_modules node_modules
  ```

## Why / the rule

H1 built the shape×transform geometry-fidelity matrix + feature lifecycle. This fills the **remaining
basic-function holes**: per-operation CAM smoke, the sketch-edit ops H1 didn't cover, and the
stock/tabs/align/distribute lifecycle paths. **AUDIT FIRST — do NOT duplicate existing coverage.**
For every candidate below, read the existing suite, confirm whether it's genuinely covered, and add a
test ONLY for a real hole. **Tests only** — do not change product code. If a test reveals a real bug
(like the delete→GC gap H1 surfaced), leave it failing/`.skip`-documented and **STOP and report it** —
do not "fix" it or work around it; management triages fix-or-file.

## Conventions (match existing suites)

Model on `src/store/editInPlace.test.ts` / `src/engine/toolpaths/toolpaths.test.ts`: local
`assert`/`approx`/`pointEq`, a `resetStore(project?)`, `let passed/failed`, `function test(name, fn)`,
top-level calls, final `console.log(\`${passed} passed, ${failed} failed\`)` + `process.exit(1)` on
failure. No framework import (auto-discovered by `scripts/run-tests.ts`, runs in `npm test`).
Determinism only: fixed coords, epsilon compares, no `Date.now()`/random. Put each suite **near the
code it covers**; update the nearest `INDEX.md`.

## Area A — CAM operation smoke (suggested `src/engine/toolpaths/camOperationSmoke.test.ts`)

The **11 `OperationKind`s** (`src/types/project.ts:424`): `pocket`, `v_carve`, `v_carve_recursive`,
`edge_route_inside`, `edge_route_outside`, `surface_clean`, `rough_surface`, `finish_surface`,
`finish_surface_cleanup`, `follow_line`, `drilling`.

**Smoke per operation** = build a basic feature (rect/circle) + stock + a tool, create the operation,
run the **real toolpath generation path** (model the invocation on `toolpaths.test.ts`), assert it
produces a non-empty toolpath **without throwing**, then **post it** through the postprocessor (model on
`postprocessor.test.ts`) and assert non-empty G-code.

**Preliminary audit (verify each, then fill only the real gaps):**

| Kind | Preliminary status | Action |
|---|---|---|
| `pocket` | covered, but only `pocketPattern:'offset'` is exercised | **Add `parallel` + `waterline`** pattern smokes |
| `drilling` | toolpath covered, but `DrillType` (`simple`/`peck`/`dwell`/`chip_breaking`) not differentiated | **Add each drill type**, asserting the post emits the right canned cycle (e.g. peck→`G83`, dwell→`G82`) |
| `v_carve` (non-recursive) | thin (single reference in `toolpaths.test.ts`) | verify it generates **and posts**; fill if not a real smoke |
| `surface_clean` | thin | verify generate+post; fill if missing |
| `follow_line` | thin | verify generate+post; fill if missing |
| `v_carve_recursive` | dedicated `vcarveRecursive.test.ts` | likely covered — confirm a post exists, else add only the post |
| `edge_route_inside/outside` | covered | confirm; no new work unless post is untested |
| `rough_surface`/`finish_surface`/`finish_surface_cleanup` | dedicated suites | covered — confirm post; no new geometry work |

Also cover both `OperationTarget` sources where meaningful (`features` vs `stock`) and `pass`
`rough`/`finish` only where the kind actually branches on it — don't combinatorially explode; one smoke
per real code path.

## Area B — Sketch-edit op fidelity (suggested `src/store/editOpFidelity.test.ts`)

H1 covered the **move-a-point** edit round-trip per kind; `editInPlace.test.ts` covered **fillet** +
linked propagation. Fill the **other** sketch-edit ops, asserting BOTH (1) **segment kinds are
preserved** appropriately (lines stay lines, arcs stay arcs under similarity, circle stays circle) and
(2) the edit **propagates to a linked instance** (a duplicate-as-reference sibling sharing the
`definitionId`) — the FR angle the helper-level `profileEdit.test.ts` does not exercise.

Ops to audit/fill (confirm exact action names in `src/store/types.ts`; reference `profileEdit.test.ts`,
`polygonSplit.test.ts`, `openProfileJoin.test.ts`, `offsetSimplify.test.ts` for existing helper-level
coverage):
- **insert point** / **delete point** on a profile
- **disconnect** (break a closed profile open) and **open-profile join**
- **arc handle** edit (drag an arc's control — segment stays `arc`)
- **profile break** (`applyProfileBreak`)

For each: drive the **real store action** through `enterSketchEdit` → op → `applySketchEdit`, assert the
resolved segment-kinds + geometry on the edited instance, that the **definition holds the canonical
shape**, and that a **linked sibling reflects the change** after the definition rebake. Skip ops H1 or
`editInPlace` already fully cover (note them in the report rather than re-testing).

## Area C — Lifecycle: stock / tabs / align-distribute (suggested `src/store/featureLifecycleOps.test.ts`)

No existing tests hit these (audit confirmed). Drive the real store actions (`src/store/types.ts`):
- **Stock:** `setStock(...)` and `setStockSourceFeature(...)` — basic create + change; assert stock
  profile/source updates and that deleting the source feature resets stock (the `deleteFeatures`
  stock-reset path at `featureSlice.ts:570`).
- **Tabs:** `startAddTabPlacement`/`autoPlaceTabsForOperation` → `updateTab` → `deleteTab` (and
  `enterTabEdit`/`moveTabControl`) — basic add/edit/delete on an operation; assert tab count + geometry.
- **Align / distribute:** `alignFeatures(...)` and `distributeFeatures(...)` on **≥3** features — assert
  the expected coordinate result (e.g. align-left sets a common minX; distribute equalizes spacing) and
  that the ops are undoable.

## Out of scope
- No product-code changes (tests only; STOP+report on real bugs). No browser/Playwright tests (that's
  the separate Phase 4 slice). Do not re-cover what H1/`editInPlace`/the dedicated CAM suites already
  test. Don't touch other worktrees or non-test files except the nearest `INDEX.md`.

## Acceptance criteria
- New suites exist for the real holes in Areas A/B/C, are deterministic, and print `N passed, 0 failed`.
- They drive the **real** store actions / generation / post path (not re-implementations), and the CAM
  smokes assert **both** toolpath generation and a non-empty post.
- Every "covered already, skipped" decision is listed in the report (so management can confirm the audit).
- `npm run build` (tsc -b + full `npm test` + vite) green.
- Any real product bug surfaced is left failing/`.skip`-documented and reported — NOT worked around.
- Nearest `INDEX.md` updated.

## Final report (report back to management; do NOT merge)
```
Branch:
Worktree:
Commit(s):
Files changed:
Audit results:   (per Area A/B/C candidate: COVERED-skipped | HOLE-filled, with the existing suite checked)
Coverage added:   (operations smoked; edit ops; lifecycle cases)
Any real bugs surfaced:   (list, with the failing assertion — do not fix)
Verification run:   (suite counts + npm run build)
Known gaps / deferred:
```
