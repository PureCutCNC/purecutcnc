---
status: In progress   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-14
approved: 2026-06-14
---

# Core State / Canvas / App Architecture Simplification Plan

> Planning-only deliverable for the task in `work/core-state-canvas-refactor-agent-task-2026-06-11.md`
> (that file lives in the **main checkout**, not in the worktree). No source code is changed by this
> plan. It is built solely from that task brief; the baseline sizes below match the brief's own
> figures (`projectStore.ts` ~7k, `SketchCanvas.tsx` ~6k), confirmed by measurement.

## Goal

Reduce PureCutCNC's *structural* complexity — not raw line counts. Concretely: cut the number of
**unrelated reasons to edit the same hotspot file**, collapse repeated app/workflow mechanics into one
shared pattern, and make module ownership obvious. The user-visible behavior must not change at any
point, `.camj` compatibility is preserved, and every project mutation continues to go through
`projectStore` actions. The output is a sequence of independently reviewable/revertible phases that
separate implementation agents can pick up one at a time. Success is **durable**: each in-scope hotspot
ends small and cohesive with a clear owner, and a mechanical guard (see *Definition of done &
anti-regrowth guardrails*) keeps it that way — so "that file is too big, changing it is risky" stops
being a valid excuse for any file in scope.

## Phase status ledger

Management view for the `feat/core-arch-simplification` branch. Updated as each phase lands.

| Phase | Status | Branch / worktree | Notes |
|---|---|---|---|
| P0 — Stale-plan housekeeping | ✅ Done (`4b15583`) | this branch | 5 stale plans archived |
| P1 — Shared util hooks | ✅ Done (`3678ceb` + `d506c77`) | merged | `useLocalStorageState` + `useOutsideDismiss`; all 6 localStorage sites consolidated (incl. `updateCheck.ts` via the React-free cores); build + browser regression green |
| P2 — App orchestration | 🔄 In progress | P2d pending | All 3 named extractions merged + browser-verified: P2a `useToolpathGeneration` (`3930c6d`), P2b `useSimulationModel` (`d9229be`, Simulation tab green), P2c `useTreeContextMenu` + `FeatureContextMenu` (`0b444ce`, context-menu green — feature/clamp branches, quick-ops hover flyout, derived disable flags, dismiss). **App.tsx 1457→739 lines.** **Not yet at DoD:** target `< ~400` + collapse the 22 action handlers + activate `max-lines` guard on `src/App.tsx`+`src/app/**` → remaining **P2d**. |
| P3 — Shared command model | ⬜ Not started | — | tablet-sensitive |
| P4 — Toolbar file-split | ⬜ Not started | — | depends on P3 |
| P5 — Store slice extraction | ⬜ Not started | — | one domain per worktree |
| P6 — SketchCanvas hooks | ⬜ Not started | — | highest risk |
| P7 — Workflow-panel migration | ⬜ Not started | — | tablet-sensitive |

## Hotspot Map — large because they coordinate vs. large because junk accumulated

Current sizes (measured, not estimated):

| File | Lines | Why it's big | Verdict |
|---|---:|---|---|
| `src/store/projectStore.ts` | 7040 | Single Zustand store: lifecycle, history, feature/op/tool/clamp/tab CRUD, import, pending workflows, constraints **+ a block of module-level pure profile/segment-geometry helpers** | **Mixed.** A store *is* a coordination point, so one store is fine — but pure geometry helpers and many domain action bodies don't need to live in the same file. |
| `src/components/canvas/SketchCanvas.tsx` | 6165 | One `forwardRef` component owning view math, draw orchestration, **and** every pointer/gesture/workflow state machine | **Accumulated.** Render-only primitives were already extracted (see below); the remaining bulk is unrelated interaction state machines sharing one closure. |
| `src/components/cam/CAMPanel.tsx` | 2069 | Every per-operation editor in one file | Accumulated (UI-only). Out of primary scope — see Out of Scope. |
| `src/components/layout/Toolbar.tsx` | 2015 | Already internally split into `useToolbarState` + ~12 action-group components + 3 shells, all in one file | **Accumulated, but pre-decomposed.** Cheap to split into files *after* the command model lands. |
| `src/components/simulation/SimulationViewport.tsx` | 1491 | Three.js sim viewport + playback controls | Genuine domain coordination. Out of primary scope. |
| `src/components/feature-tree/PropertiesPanel.tsx` | 1480 | Per-node property UIs in one file | Accumulated (UI-only). Out of primary scope. |
| `src/App.tsx` | 1457 | Composition root **+** toolpath cache/scheduling engine **+** simulation-model derivation **+** tree context-menu state machine + ~22 near-identical action handlers | **Accumulated.** Classic god-component; the clearest, lowest-risk win. |
| `src/components/viewport3d/Viewport3D.tsx` | 1179 | Three.js preview + toolpath overlay | Genuine domain coordination. Out of primary scope. |
| `src/components/layout/AppShell.tsx` | 739 | Desktop/tablet shell wiring | Reasonable for a shell. Leave. |

Already-extracted helpers prove the direction works and are the precedent to follow:
- `store/slices/` — `selectionSlice` (717), `pendingAddSlice` (703), `pendingCompletionSlice` (687),
  `pendingActionsSlice` (529), `dimensionsSlice` (98), `dimensionToolSlice` (135).
- `store/helpers/` — `ids`, `geometry`, `clipping`, `derivedFeatures`, `normalize`, `polygonSplit`.
- `components/canvas/` pure modules — `viewTransform`, `hitTest`, `scenePrimitives`, `previewPrimitives`,
  `profilePrimitives`, `snappingHelpers`, `draftGeometry`, `draftHelpers`, `manualEntry`,
  `measurements`, `dimensionRendering`.
- `hooks/` app-generic primitives with React-free testable cores — `useStableEvent`, `useEventListener`
  (`useWindowEvent`/`useDocumentEvent`), `useRafScheduler`, `usePortalPosition`.
- `components/canvas/CanvasWorkflowPanel` + `useCanvasWorkflowPanel` — the shared draggable
  apply/cancel workflow panel (focus-handoff already centralized here).

## Consolidation candidates (measured duplication)

1. **Sketch command/action logic is forked desktop↔tablet.** `useToolbarState` (in `Toolbar.tsx`),
   `ToolRail.tsx` (tablet), and `TopCommandBar.tsx` each independently:
   - destructure the *same* ~25 store actions (`startMove/Copy/Resize/Rotate/MirrorFeature`,
     `startJoin/Cut/OffsetSelectedFeatures`, `alignFeatures`, `distributeFeatures`, `deleteFeatures`,
     `setSketchEditTool`, `beginConstraint`, every `cancelPending*`, the `startAdd*Placement` family);
   - re-derive the *same* predicates — `hasSelectedFeatures`, `hasLockedSelectedFeatures`,
     `hasClosedSelectedFeatures`, `hasOffsetEligibleSelectedFeatures`, `canAlign` (≥2), `canDistribute`
     (≥3), `featureSketchEditActive`;
   - re-implement the *same* toggle-or-cancel handlers
     (`handleMove/Copy/Resize/Rotate/Mirror/Join/Cut/Offset/Constraint` — byte-for-byte the
     `if (pending…) cancel(); else start()` shape in both `ToolRail` and `useToolbarState`).
   - `CREATION_SHAPE_OPTIONS` is duplicated verbatim in `Toolbar.tsx` and `ToolRail.tsx`.
   - `TopCommandBar` separately encodes undo/redo disable (`history.past.length === 0`) and file
     ops already living in `useToolbarState`. **This is the single highest drift risk in the app.**

2. **`localStorage`-backed preferences** are hand-rolled in 6 places (`App.tsx` ×2 — depth legend +
   snap settings, `PanelSplit.tsx`, `DisclosureSection`/`disclosureState.ts`, `AppShell.tsx`,
   `utils/updateCheck.ts`). No `useLocalStorageState` hook exists.

3. **Outside-click + Escape dismissal** is hand-rolled: 9 files wire `pointerdown` outside-dismiss and
   11 wire their own `keydown`/Escape (`App.tsx`, `ToolRail`, `Toolbar`, `SnapPopover`,
   `DimensionPopover`, `Select`, `CAMPanel`, the three project dialogs, `SimulationViewport`,
   `Viewport3D`). No `useOutsideDismiss`/`useEscapeKey` hook exists, even though `useEventListener`
   already provides the safe subscribe-once base.

4. **`App.tsx` toolpath engine + simulation model + context menu** are three self-contained subsystems
   wedged into the composition root (details under Phase 2).

5. **`App.tsx`'s ~22 `handleXxxFeature/Tab/Clamp` handlers** are the identical 3-line shape
   `startXxx(id); setCenterTab('sketch'); closeTreeContextMenu()`.

6. **Module-level profile/segment geometry in `projectStore.ts`** — `cloneSegment`,
   `splitBezierSegment`, `splitArcSegment`, `extendOpenProfileAtStart/End`, `reverseOpenProfile`,
   `closeOpenProfile`, `joinOpenProfiles`, `createFilletArcSegment`, `applyLineCornerFillet`,
   `insertPointIntoProfile`, `deleteAnchorFromProfile`, `deleteSegmentFromProfile`,
   `disconnectProfileAtAnchor`, `resolve(Open)CompositeDraftSegments`, `buildArcSegmentFromThreePoints`,
   `translateProfile`, … (~30 pure functions, lines ~135–907). They have no `set()`/store dependency
   and belong next to `src/sketch/` geometry, where they become unit-testable in isolation.

## Micro-function guidance (concrete to this codebase)

**Keep small — they name a real decision or domain invariant:**
- `viewTransform.ts` `worldToCanvas`/`canvasToWorld`/`computeViewTransform` — coordinate-system seam.
- `utils/units.ts` conversions, `store/helpers/clipping.ts` wrappers (integer-scale invariant),
  `hitTest.ts`, `snappingHelpers.ts`, the profile-edit geometry helpers above — all testable invariants.
- `App.tsx` `scheduleAfterPaint` (double-rAF) — one line, but it encodes a non-obvious
  "guarantee a paint between computations" decision; **keep** (move it into the toolpath hook).
- `App.tsx` `operationComputationEquals` — the load-bearing allowlist of computation-relevant
  `Operation` fields; **keep** (move with the cache, keep the "add new field here" comment).

**Inline / merge — indirection without a hidden decision:**
- `App.tsx`'s 22 `handleMove/Copy/Resize/Rotate/Mirror/Offset/Join/Cut/Constraint/...Tab/...Clamp`
  handlers → fold into the shared command descriptors (Phase 3) or one parameterized
  `runCanvasAction(start, { switchToSketch, closeMenu })`.
- `ToolRail.tsx` `startCreationShape`'s `if (shape==='rect')…else if…` ladder → a `{ shape → start }`
  lookup built from the shared `CREATION_SHAPE_OPTIONS`.
- `useCanvasWorkflowPanel`'s `stopActionPointerPropagation` (one-line) — borderline; leave unless the
  surrounding panel code is already being edited.
- Do **not** run a standalone "inline all the things" pass; inline only files a phase already touches.

## Target module boundaries

```
src/hooks/
  useLocalStorageState.ts     (new)  React-free core + hook; mirrors usePortalPosition style
  useOutsideDismiss.ts        (new)  pointerdown-outside + Escape, built on useEventListener

src/app/                      (new)  App-orchestration hooks (no JSX engine logic in App.tsx)
  useToolpathGeneration.ts    (new)  cache type, operationComputationEquals, isCacheHit,
                                     generateToolpathForOperation, needed/generating ids,
                                     one-per-frame async pipeline, visibleToolpaths, collidingClampIds
  useSimulationModel.ts       (new)  simulationResult / operationCount / playbackInput derivation
  useTreeContextMenu.ts       (new)  context-menu open/close/position state machine + clampMenuPosition

src/components/feature-tree/
  FeatureContextMenu.tsx      (new)  the menu JSX currently inlined in App.tsx (~190 lines)

src/commands/                 (new)  shared, surface-agnostic command model
  sketchCommands.ts           (new)  command descriptor type + useSketchCommands() (labels, iconIds,
                                     active, disabled, shortcut, onClick, tablet/desktop visibility)
  creationShapes.ts           (new)  single CREATION_SHAPE_OPTIONS source
  fileCommands.ts             (new)  new/open/import/export/save/undo/redo descriptors

src/components/layout/toolbar/ (new) presentational split of Toolbar.tsx, consuming useSketchCommands
  ToolButton.tsx, ProjectNameControl.tsx, GlobalActions.tsx, CreationActions.tsx,
  FeatureEditActions.tsx, AlignmentActions.tsx, ShapeToolActions.tsx, SketchEditActions.tsx,
  BackdropEditActions.tsx, SnapActions.tsx, MeasureActions.tsx

src/store/
  projectStore.ts             SHRINKS to a composition root: the create<ProjectStore>() call that
                              spreads the slice creators below + the shared history-aware `set`,
                              `cloneProject`, `normalizeProject`. Public surface unchanged.
  types.ts                    the public ProjectStore interface — the FROZEN contract (unchanged)
  slices/                     EXTEND the existing createXxxSlice(set, get, deps) pattern the store
                              already spreads (selection / pendingAdd / pendingActions /
                              pendingCompletion / dimensions* slices exist) — one slice per domain:
    projectLifecycleSlice.ts, historySlice.ts, featureCrudSlice.ts, featureTreeOrderSlice.ts,
    operationsSlice.ts, toolsSlice.ts, clampsSlice.ts, tabsSlice.ts, importMergeSlice.ts,
    backdropSlice.ts, machineDefsSlice.ts, pendingMoveTransformSlice.ts, pendingShapeOffsetSlice.ts,
    constraintsSlice.ts
  helpers/profileEdit.ts      (new) the ~30 module-level profile/segment geometry helpers (from store)

src/components/canvas/        (extend the existing pure-module set)
  usePointerGestures.ts, useSnapPreview.ts, usePlacementWorkflow.ts, useTransformWorkflow.ts,
  useDimensionEditWorkflow.ts, useConstraintWorkflow.ts, useCanvasContextMenu.ts (long-press),
  useCanvasKeyboard.ts        (new)  — SketchCanvas.tsx shrinks to a thin shell + imperative handle
```

The **store's public API does not change** in any phase: `Toolbar`, `ToolRail`, `App`, canvas, panels
keep calling the same `useProjectStore()` actions. Only the *implementation* moves into `store/slices/*`
creators that `projectStore.ts` spreads together at its `create<ProjectStore>()` call — exactly how
`createSelectionSlice` / `createPendingAddSlice` / … already work today.

## Execution model — cumulative feature branch + per-phase worktrees

This work ships as **one unit in the next release**, not as independent PRs to `main`. Mirror the
lint-cleanup model:

- Cut one long-lived **cumulative feature branch** off `main` (e.g. `feat/core-arch-simplification`).
- Implement each phase in its **own worktree branched off the cumulative branch** (so each phase builds
  on the prior phases), then merge it **back into the cumulative branch** — never into `main` directly.
  The cumulative branch is what finally merges to `main` for the release.
- Phases stay independently reviewable and revertible *within* the cumulative branch (revert the
  phase's merge commit), not as separate mainline PRs.
- `npm run build` must be green before a phase worktree merges into the cumulative branch.

**Phase ordering — revised from the task's suggested order, with rationale.** The task put
App-orchestration (3), store split (4), and canvas extraction (5) before the command model (7). This
plan moves shared utilities and the command model earlier because they (a) are the lowest-risk,
highest-leverage changes, (b) immediately kill the desktop↔tablet drift, and (c) make the later Toolbar
file-split land on already-thin components. Store and canvas — the two behavior-sensitive giants — come
last.

### Phase 0 — Stale-plan housekeeping  *(no app code; do first, on the cumulative branch)*
Retire planning docs that are stale so phase agents working off this branch aren't misled by superseded
or already-shipped guidance. Audit every active entry in `planning/INDEX.md`; for each plan whose work
has already shipped to `main`, and for any plan this effort supersedes, set its frontmatter `status`
(`Done` if shipped, `Abandoned`/superseded if replaced), `git mv` it into `planning/archive/`, and
remove its entry from the active sections of `planning/INDEX.md`. These are **closed, not certified
complete** — removed from the active set, not re-verified against their own acceptance criteria.
Confirmed-stale now (their features are already merged on `main`):
- `MEASURE_DIMENSIONS_Plan.md` (8 measure/dimensions commits on `main`) — close.
- `FEATURE_CREATION_PICKER_POC_Plan.md` (feature-creation picker + quick-ops shipped) — close.
- `REFACTORING_Plan.md` — superseded here for the store/canvas/app hotspots — close/supersede.

Verify-then-likely-close: `WATERLINE_ADAPTIVE_REFINEMENT_Plan.md`, `WATERLINE_CONTAINING_ADD_FIX_Plan.md`
(broad waterline work is merged, but confirm these specific refinements aren't still open first). Net
effect: when a phase agent opens `planning/INDEX.md`, this plan is the only active authority for the
state/canvas/app area.

### Phase 1 — Shared app-utility hooks  *(lowest risk; pure refactor)*
Add `useLocalStorageState` and `useOutsideDismiss` (React-free cores + unit tests, mirroring
`usePortalPosition`). Migrate the 6 localStorage sites and the popover/menu dismissal sites
(start with `App.tsx`, `SnapPopover`, `DimensionPopover`, `ToolRail` flyouts, `Toolbar` popover; leave
modal dialogs if their focus-trap differs). No behavior change.

### Phase 2 — `App.tsx` orchestration extraction  *(low risk; mostly move + test)*
Extract `useToolpathGeneration`, `useSimulationModel`, and `useTreeContextMenu` + `FeatureContextMenu`.
Collapse the 22 action handlers. `App.tsx` becomes a thin composition root (target **< ~400 lines**).
This is where the task's example `useToolpathGeneration` unit tests (cache invalidation + one-per-frame
scheduling) land.

### Phase 3 — Shared sketch command model  *(medium risk; behavior-sensitive UI parity)*
Introduce `useSketchCommands()` + `creationShapes.ts` + `fileCommands.ts`. Re-point `useToolbarState`,
`ToolRail`, and `TopCommandBar` at the shared descriptors and predicates. Goal: one source for every
enable/disable/active/toggle rule. **Requires desktop + tablet verification** (this is the core
tablet-affecting change).

### Phase 4 — `Toolbar.tsx` file split  *(low risk after Phase 3)*
Move the already-internal groups into `components/layout/toolbar/*`. With command logic in the shared
hook, these are thin presentational components. Closes the `TOOLBAR_REVISIT.md` structural-split item.

### Phase 5 — Store slice extraction → `projectStore.ts` becomes a composition root  *(higher risk; one domain per worktree)*
Continue the **existing** `store/slices/createXxxSlice(set, get, deps)` pattern (the store already
spreads `createSelectionSlice` / `createPendingAddSlice` / … at its `create<ProjectStore>()` call).
Carve the ~4000 lines of inline action bodies in `projectStore.ts` into one slice per domain — feature
CRUD first as the template, then operations, tools, clamps, tabs, import/merge, backdrop, machine defs,
pending move/transform/offset/shape, constraints, project lifecycle, history. The public `ProjectStore`
interface in `types.ts` is the **frozen contract** — call sites never change. When done,
`projectStore.ts` is only the composition root (the spread of slice creators + the shared history-aware
`set`, `cloneProject`, `normalizeProject`). Separately move the module-level profile/segment helpers
into `helpers/profileEdit.ts` with unit tests. One domain per worktree onto the cumulative branch, each
independently revertible.

### Phase 6 — Canvas workflow hook extraction from `SketchCanvas.tsx`  *(highest risk)*
Extract the interaction state machines (`usePointerGestures`, `useSnapPreview`, `usePlacementWorkflow`,
`useTransformWorkflow`, `useDimensionEditWorkflow`, `useConstraintWorkflow`, `useCanvasContextMenu`
long-press, `useCanvasKeyboard`). Keep the thin shell + `useImperativeHandle`. RAF scheduling already
uses `useRafScheduler` — preserve it. **Requires browser + tablet verification per extracted machine.**

### Phase 7 — Workflow-panel migration for remaining canvas UI  *(medium risk)*
Move remaining ad-hoc canvas banners (copy-count input, placement hints, apply/cancel) onto
`CanvasWorkflowPanel`/`useCanvasWorkflowPanel` so desktop and tablet share one apply/cancel + focus
handoff. **Tablet verification required.**

### Phase 8 — Opportunistic inlining
Not a standalone phase/worktree. Fold the noisy one-use wrappers listed above into whichever phase touches them.

## Files affected (by phase)

- **P0:** edit `planning/INDEX.md`; `git mv` stale plans into `planning/archive/` and set their `status`. **No `src/` changes.**
- **P1:** *(new)* `src/hooks/useLocalStorageState.ts`(+`.test.ts`), `src/hooks/useOutsideDismiss.ts`(+`.test.ts`); edit `App.tsx`, `PanelSplit.tsx`, `common/disclosureState.ts`, `AppShell.tsx`, `utils/updateCheck.ts`, `SnapPopover.tsx`, `DimensionPopover.tsx`, `ToolRail.tsx`, `Toolbar.tsx`.
- **P2:** *(new)* `src/app/useToolpathGeneration.ts`(+test), `src/app/useSimulationModel.ts`, `src/app/useTreeContextMenu.ts`, `src/components/feature-tree/FeatureContextMenu.tsx`; edit `App.tsx`.
- **P3:** *(new)* `src/commands/sketchCommands.ts`(+test), `creationShapes.ts`, `fileCommands.ts`; edit `Toolbar.tsx` (`useToolbarState`), `ToolRail.tsx`, `TopCommandBar.tsx`.
- **P4:** *(new)* `src/components/layout/toolbar/*`; edit `Toolbar.tsx` (now a shell).
- **P5:** *(new)* `src/store/slices/*Slice.ts` (extending the existing slice set), `src/store/helpers/profileEdit.ts`(+test); edit `projectStore.ts` (→ composition root, interface unchanged), `eslint.config.js` (`max-lines` override for `src/store/**`).
- **P6:** *(new)* `src/components/canvas/use*Workflow.ts` / `usePointerGestures.ts` / etc.; edit `SketchCanvas.tsx`, `eslint.config.js` (`max-lines` override for `src/components/canvas/**`).
- **P7:** edit `SketchCanvas.tsx` + the remaining banner components; reuse `CanvasWorkflowPanel`.

## Tests

- **P1:** unit-test the React-free cores (`useLocalStorageState` read/write/JSON-parse-fallback;
  `useOutsideDismiss` inside/outside/Escape decisioning) — same pattern as `usePortalPosition.test.ts`.
- **P2:** unit-test `useToolpathGeneration`'s cache layer — `operationComputationEquals` field
  coverage, `isCacheHit` identity rules, and the one-per-frame scheduler against a fake rAF (mirrors
  `useRafScheduler.test.ts`). This is the task's named acceptance example.
- **P3:** unit-test `useSketchCommands` predicate/disabled derivation (locked selection, closed-profile
  gating, align≥2 / distribute≥3, sketch-edit-active) so desktop and tablet can't drift.
- **P5:** the moved `profileEdit` helpers get direct unit tests (they were previously untestable inside
  the store). Existing store tests (`createRestOperation`, `openProfileJoin`, `projectStoreTransform`,
  `polygonSplit`, `second_cut`) must stay green unchanged — they are the behavior-preservation guard.
- **All phases:** `npm run build` (runs `npm test`) green before a phase worktree merges into the
  cumulative branch. Engine/pure-logic additions carry unit tests per `AGENTS.md`.

## Manual browser / tablet verification strategy

Behavior-sensitive phases and what to exercise (desktop **and** `tablet.css` touch mode):
- **P3 (command model):** every toolbar/rail/command-bar button — create shapes (feature + region
  targets), move/copy/resize/rotate/mirror, offset, join/cut, align/distribute, constraint,
  sketch-edit tools, undo/redo/save enable states, snap toggles. Confirm tablet rail and desktop
  toolbar agree on enabled/active state in identical selections.
- **P6 (canvas state machines):** pointer draw of each shape, pending-add placement + cancel, drag
  move/copy with copy-count, resize/rotate/mirror reference picking, dimension placement + edit,
  constraint anchor/reference pick, long-press context menu (touch) vs right-click (desktop), axis
  lock, snap preview, zoom-window. Verify focus returns to canvas after each workflow.
- **P7 (workflow panels):** apply/cancel + focus handoff for each migrated banner on both form factors.
- **P2:** toolpath spinner timing (spinner shows on first stale frame, not a frame late) and 3D/sim
  recompute on operation switch.

## Risk assessment

- **P5 (store) and P6 (canvas) are the real risk.** Mitigation: behavior-preserving moves only, one
  domain/state-machine per PR, public store API frozen, existing store/canvas tests as the guard, and
  required manual verification before each merge.
- **P3 can silently change tablet behavior** if a predicate is unified slightly differently than one
  side previously computed it. Mitigation: derive the shared predicates to *exactly* match the current
  `useToolbarState`/`ToolRail` logic, then diff button states on both form factors before merge.
- **Merge-conflict risk during a long sequence:** phases are scoped to disjoint files where possible
  (hooks/ and commands/ are new; store domain split is per-domain) so parallel agents collide less.
- **`.camj` compatibility:** no serialization or schema change in any phase — `types/project.ts` and
  `store/helpers/normalize.ts` are untouched. Call this out in each store-phase merge.

## Rollback strategy

Each phase merges into the cumulative branch as its own merge commit, so a phase can be backed out with
a single revert of that merge without disturbing earlier phases. Phase 5 is further subdivided per
domain (one worktree/merge per domain) so a single domain move can be reverted on its own. Because the
public store API and component prop contracts are invariant across phases, reverting any phase restores
prior behavior without cascading edits. If the whole effort needs to slip the release, the cumulative
branch simply isn't merged to `main` — nothing is on `main` yet. Independence: P1, P2, P4 are trivially
revertible; P3 revert restores per-surface command logic; P5/P6 revert per domain/per state machine.

## INDEX.md files to update during implementation

- `src/INDEX.md` — add `src/app/` and `src/commands/` folders.
- `src/hooks/INDEX.md` — `useLocalStorageState`, `useOutsideDismiss` (P1).
- `src/store/INDEX.md` — new `slices/*Slice.ts` modules, `helpers/profileEdit.ts` (P5).
- `src/components/INDEX.md` + a new `src/components/layout/toolbar/INDEX.md` (P4); note
  `FeatureContextMenu.tsx` under feature-tree (P2).
- `src/components/canvas/` — extend the canvas module list with the new workflow hooks (P6).
- `planning/INDEX.md` — move this plan Pending → In progress on approval; archive on completion.
- `planning/TOOLBAR_REVISIT.md` — close it when P4 lands (it calls for exactly the structural
  Toolbar split done there).

## Acceptance criteria (per phase)

- **P0:** `planning/INDEX.md` active/In-progress sections list no shipped-but-unarchived plans; closed
  plans moved to `planning/archive/` with `status` set; this plan is the sole active authority for the
  state/canvas/app area; **no app source touched**.
- **P1:** the two hooks exist with passing core tests; the 6 localStorage sites and migrated dismissal
  sites use them; no behavior change; build green.
- **P2:** `App.tsx` no longer contains the toolpath cache/pipeline, simulation-model derivation, or the
  context-menu JSX/handlers; `App.tsx` **< ~400 lines**; `useToolpathGeneration` cache+scheduler tests
  pass; spinner timing unchanged; build green.
- **P3:** one `useSketchCommands()` is the only place enable/disable/active/toggle rules live;
  `Toolbar`/`ToolRail`/`TopCommandBar` consume it; `CREATION_SHAPE_OPTIONS` has one definition; desktop
  and tablet button states verified identical; build green.
- **P4:** `Toolbar.tsx` is a thin shell importing `toolbar/*` (**< ~300 lines**); `TOOLBAR_REVISIT.md`
  split satisfied; build green.
- **P5:** `projectStore.ts` is a composition root (**< ~600 lines**); public `ProjectStore` interface
  byte-identical; every action body lives in a `store/slices/*` slice; `profileEdit` helpers
  unit-tested; all prior store tests green; `.camj` round-trips unchanged; `max-lines` guard active on
  `src/store/**`.
- **P6:** `SketchCanvas.tsx` is a thin shell + imperative handle (**< ~600 lines**); each interaction
  state machine lives in its own hook; full manual canvas verification passes on desktop + tablet;
  build green; `max-lines` guard active on `src/components/canvas/**`.
- **P7:** remaining canvas banners use `CanvasWorkflowPanel`; focus handoff verified both form factors.

## Definition of done & anti-regrowth guardrails

The point of this work is that **"that file is too big / too risky to change" stops being true** — so
the plan commits to outcomes, not just code moves, and to a guard that keeps them true. (Per the task,
line count is **not** the success metric — cohesion and clear ownership are; the figures below are a
regression guardrail, not the goal.)

**Per-hotspot end state:**
- `projectStore.ts` → composition root only, every action body in a domain slice, public contract
  unchanged. Guardrail **< ~600 lines**.
- `SketchCanvas.tsx` → thin shell: refs, imperative handle, hook composition, canvas JSX; every
  interaction state machine in its own hook. Guardrail **< ~600 lines**.
- `App.tsx` → composition root, no toolpath/sim/context-menu logic inline. Guardrail **< ~400 lines**.
- `Toolbar.tsx` → shell importing `toolbar/*` presentational groups. Guardrail **< ~300 lines**.
- Every new slice/hook/module is cohesive (one concern) and, where pure, ships with unit tests — so
  future edits are guarded by tests, not by reviewer nerve.

**The anti-regrowth guard** (this is why April's extraction didn't stick — two months of feature work
quietly regrew the files): add an ESLint `max-lines` rule via `overrides` **scoped to the refactored
areas only** (`src/store/**`, `src/components/canvas/**`, `src/App.tsx`, `src/app/**`,
`src/components/layout/toolbar/**`) — **not** repo-wide, so legitimately large engine files (e.g.
`vcarveRecursive.ts`, `dxf.ts`) are untouched. Use a generous cap (≈700, `error`) added in the same
phase that brings each area under it, so it never flags already-clean code. A file silently regrowing
past the cap then fails `npm run lint` instead of surfacing months later. New behaviour has nowhere to
hide: it must land in the owning slice/hook/module.

**License-header guard:** `scripts/check-license-headers.ts` runs inside `npm test` (hence `npm run build`) and fails the gate if any `src/**/*.ts(x)` file lacks the Apache 2.0 header — compliance is now mechanical, not reviewer/agent diligence. Added during this effort as a sibling to the size guard (there was previously no eslint rule, build/test check, hook, or CI step enforcing it).

**Ownership is documented, not implied:** every new module is registered in the nearest `INDEX.md` (per
`AGENTS.md`) so the next agent knows where new code belongs without opening the large files.

## Out of scope

- **CAM/UI-only giants** `CAMPanel.tsx` (per-operation editors) and `PropertiesPanel.tsx` (per-node
  property UIs). They are large but *cohesive* — one file, one responsibility (operation/property
  editing) — and none of the task's seven refactor directions (store boundaries, canvas workflow,
  app orchestration, command/toolbar model, shared hooks/utilities) targets them. A registry-driven
  editor split is a separate UI concern; defer it unless a phase here happens to pass through them.
- **Engine internals** (`engine/toolpaths/*`, `engine/gcode/*`, `vcarveRecursive.ts`, `csg.ts`),
  `import/*`, `simulation`/`viewport3d` 3D internals — domain coordination, not the target.
- **`scripts/`** — diagnostics/tooling, explicitly out of scope.
- **Lint cleanup** — the separate lint agent's mechanical fixes are not combined here. (The `max-lines`
  *guardrail* in Definition of done is a structural regression guard added by this effort, not lint
  cleanup.)
- **Any data-model / `.camj` schema change** — none in this effort.

## Resolved decisions

Both previously-open questions are now decided (user delegated):

1. **Store granularity = one slice per domain (finest sensible grain), not coarse buckets.** Per-domain
   slices give each concern a single owner and isolate reverts; they are the only grain that actually
   removes "the store is too big to touch." A `featuresAndOps.ts` catch-all would just recreate a
   smaller monolith. This is also the pattern the store already uses, so it adds no new convention.
2. **Add `src/app/` for the orchestration hooks** (`useToolpathGeneration`, `useSimulationModel`,
   `useTreeContextMenu`), kept distinct from the generic `src/hooks/` primitives.
