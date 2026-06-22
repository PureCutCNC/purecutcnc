# Slice 10 — Re-solve dependent constraints after linked-definition propagation

Implementation handoff. Read `AGENTS.md` and root `planning/INDEX.md` first. Follow
Plan → confirm scope → Implement. You own ONLY this slice's worktree; finish with ONE simple commit
and a report. Do not merge, do not open a PR, do not run browser validation (management does that),
do not touch other worktrees or `planning/` files.

## Problem (user-reported, browser-confirmed)

A feature can be constrained to another feature (e.g. Circle 2 has `fixed_distance` constraints to
Rect 1's edges — "0.5 from the left edge, 0.25 from the bottom edge"). The constraint references the
**host instance** by id.

- **Editing the host directly** (Rect 1) re-solves the constrained child correctly — Circle 2 follows
  the edited geometry. ✅ (works today)
- **Editing a LINKED copy** (Rect 1 Copy, a 2nd instance of the same definition) propagates a shape
  change to the 1st instance via the shared definition (rebake), **but** features constrained to the
  1st instance (Circle 2) are **NOT** re-solved — they stay at their old position, now inconsistent
  with the 1st instance's new geometry. ❌ (the bug)

This is **introduced by the feature-references work** (linked instances don't exist on `main`, so this
can't occur there). It is NOT the optional "copy the constrained child with the feature" topic — that
is a separate future session. This slice is purely: *when a definition edit changes a sibling
instance's geometry, re-solve the features constrained to that sibling.*

## Repro
1. Draw Rect 1. Draw Circle 2 inside it and add `fixed_distance` constraints from Circle 2 to Rect 1's
   edges.
2. Copy Rect 1 (→ Rect 1 Copy, a linked reference instance; Circle 2 is not copied — expected).
3. Edit Sketch on **Rect 1 Copy** and reshape it (e.g. drag a corner).
4. Observe: Rect 1 changes too (shared definition — correct), but Circle 2 does NOT move to keep its
   constraints against Rect 1's new shape. Expected: Circle 2 re-solves, exactly as it does when you
   edit Rect 1 directly.

## Root cause (path-level — verified)
The geometry-edit actions live in `src/store/slices/featureGeometrySlice.ts` (`moveFeatureControl`,
`insertFeaturePoint`, `deleteFeaturePoint`, `filletFeaturePoint`, `disconnectFeaturePoint`, profile
join/break). Each does, in order:
1. mutate the edited feature's profile,
2. `clearStaleConstraints([editedId])`, `propagateConstraintsOnTranslate([editedId → {0,0}])`,
   `validateConstraintsOnFeature(... fixed_distance ...)` — the dependent-constraint handling, keyed on
   the **directly-edited** feature, run against the feature map **before** step 3,
3. `syncEditedFeatureDefinition(project, editedId)` — the FR addition: writes the edit into the shared
   `FeatureDefinition` and `rebakeAllInstances(...)` updates the compatibility `sketch.profile` of
   **every** instance of that definition (the siblings).

The gap: step 3 changes sibling instances' geometry, but nothing re-runs the dependent-constraint
re-solve for features bound to those siblings. `rebakeAllInstances` (`helpers/featureDefinitions.ts`)
has zero constraint handling.

## STEP 1 — trace the working re-solve (do this first)
Before changing anything, determine exactly how a **direct** edit re-solves a dependent so you can
mirror it. Note: `moveFeatureControl` propagates `{dx:0,dy:0}` and `validateConstraintsOnFeature` only
refreshes cache/validity — management could NOT confirm which call actually *repositions* the
dependent on a pure shape edit. Reproduce the direct-edit case (constraint + host shape edit) and find
the precise repositioning step. Strong leads:
- The move/resize completion path in `src/store/slices/pendingCompletionSlice.ts` repositions
  dependents via `deps.validateAllConstraints(deps.propagateConstraintsOnTranslate(...))` /
  `propagateConstraintsOnRotate(...)` (lines ~192, ~516).
- `solveFeatureTranslation(...)` in `src/sketch/constraintSolver.ts` is the solver that computes the
  offset to satisfy a feature's `fixed_distance` constraints against current reference geometry;
  `propagateRigidTransforms` applies it.
Write a one-paragraph note in your report stating exactly what repositions the dependent on a direct
edit — this is the contract the fix must satisfy.

## STEP 2 — fix
After `syncEditedFeatureDefinition` rebakes the instances, re-run the dependent-constraint **re-solve**
for every feature whose `fixed_distance` constraints reference any **rebaked instance id** (i.e. every
instance sharing the edited definition — not just the directly-edited one). Use the SAME solver you
identified in step 1 so behavior matches a direct edit. Implementation guidance:
- The set of affected reference ids = all instances of the edited definition (use
  `getInstanceIdsForDefinition(project, definitionId)`), since each was rebaked to new geometry.
- Re-solve dependents against the rebaked geometry and write their updated positions, then validate.
- Keep it idempotent / stable (re-solving when nothing changed must not drift geometry).
- Preferred home: inside `syncEditedFeatureDefinition` after the `rebakeAllInstances` call (so all five
  edit actions are covered through the one choke point), OR a small shared helper it calls.
- Reuse existing constraint helpers (`propagateConstraintsOnTranslate`/`solveFeatureTranslation`/
  `validateAllConstraints`); do NOT write a new solver.

## Out of scope / leave alone
- Copying the constrained child along with the feature (a separate planned "constraints + references"
  session). This slice only re-solves EXISTING dependents after propagation.
- Resolver / transform commands / duplicate / snapshot / creation / tree / properties / edit-in-place
  internals (slices 01–09). Touch only the constraint re-solve after definition propagation.
- Non-`fixed_distance` constraint types beyond what the direct-edit path already handles.

## Acceptance criteria
- Editing a linked instance's shape re-solves features constrained to ANY sibling instance, identical
  to how a direct edit of that sibling re-solves them.
- Editing the host directly is unchanged (no regression).
- A feature with no linked siblings behaves exactly as before.
- No geometry drift when re-solving with no effective change (stability); undo/redo intact.
- `npm run build` (tsc -b + full `npm test` + vite) green.

## Required tests (focused, `npx tsx`)
Add e.g. `src/store/linkedConstraintResolve.test.ts`:
- Build a definition shared by two instances. Add a `fixed_distance` constraint from a 3rd feature to
  the FIRST instance. Edit the SECOND instance's shape through the real store actions
  (`enterSketchEdit`→edit→`applySketchEdit`, or the direct geometry action). Assert the constrained
  feature re-solves against the first instance's NEW geometry (its position/constraint satisfied),
  matching the result of editing the first instance directly.
- Regression: editing the host directly still re-solves the dependent.
- Stability: a no-op re-solve does not move geometry.
Confirm no regressions in the existing FR + constraint suites and run `npm run build`. Update the
nearest `INDEX.md` for any new file.

## Final report (report back to management; do NOT merge)
```
Branch:
Worktree:
Commit(s):
Files changed:
STEP-1 finding:   (exactly what repositions a dependent on a direct edit — the contract)
Behavior implemented:
Verification run:   (focused tests + npm run build)
Browser validation: Not run; reserved for management.
Known gaps:
Manual/browser validation needed:
```
