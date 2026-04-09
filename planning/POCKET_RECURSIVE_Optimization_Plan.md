# Pocket Recursive Optimization Plan

Legend:
- `[ ]` not started
- `[~]` in progress / partial
- `[x]` complete
- `[>]` deferred / moved to backlog

## Goal
Reduce unnecessary travel in offset-style pocket toolpaths when the pocket contains islands or splits into multiple offset branches.

The current offset pocket generator is breadth-first:
- cut every contour from the current inset level
- then compute the next inset level
- then cut every contour from that next level

That works, but it creates long cross-pocket links when one inset level contains several independent branches.

## Problem
For complex pockets:
- offsetting one level often returns multiple independent regions
- the current generator walks all same-depth contours before descending into any branch
- this makes the tool bounce between branches instead of finishing one local cavity before moving away

The problem is mostly ordering, not geometry.

## Product Decision
Keep the existing offset geometry and cutter-clearance rules.

This pass changes only:
- contour ordering
- branch traversal order
- closed-loop entry point selection

It does **not** change:
- region resolver behavior
- stepover math
- wall vs floor semantics
- safe-Z rules
- parallel pattern generation

## Proposed Strategy

### 1. Use branch-first recursion for offset regions
When an inset region produces child inset regions, descend each child immediately instead of flattening all children from the same depth into one global list.

Conceptually:

```ts
cut(region)
for child in orderedChildren(region):
  cut(child)
```

This gives the desired behavior:
- if a region keeps collapsing as one branch, follow it inward
- if it splits, finish one branch locally, then move to the next sibling

### 2. Order sibling branches greedily from the current tool position
When a region splits into multiple children:
- pick the next child whose outer contour is closest to the current XY position

This is local greedy ordering, not a global TSP solve.

Reason:
- cheap
- deterministic
- enough to reduce the most obvious long moves

### 3. Re-index closed contours to the nearest entry point
For each closed contour:
- find the nearest existing contour vertex to the current XY position
- rotate the point list so cutting starts there

This keeps the contour geometry unchanged while reducing unnecessary link distance caused by arbitrary contour start indices.

### 4. Keep global reconnecting out of scope for v1
The user suggested a second pass to reconnect the generated branches more efficiently.

That is reasonable, but the first pass should stop at:
- branch-first recursion
- greedy sibling selection
- nearest-start closed contour rotation

If the result is still too jumpy, a later pass can build a higher-level reconnect graph over branch endpoints.

## Implementation Plan

### Phase 1: Pocket offset ordering [~]
- [x] Identify the breadth-first hotspot in `src/engine/toolpaths/pocket.ts`
- [ ] Add contour-distance / region-distance helpers
- [ ] Add nearest-start closed contour rotation
- [ ] Replace breadth-first offset traversal with recursive region descent
- [ ] Keep parallel pocket logic unchanged

### Phase 2: Finish floor ordering [ ]
- [ ] Apply the same recursive ordering to offset-style finish floor contours

### Phase 3: Validation [ ]
- [ ] Build the app
- [ ] Test simple rectangle pocket
- [ ] Test pocket with islands
- [ ] Test pocket that splits into multiple branches
- [ ] Confirm no regressions in parallel pocket pattern

## Expected Outcome
Compared with the current offset generator:
- fewer long dashed link moves across the pocket
- more locally coherent spiral / nested behavior
- better behavior around islands and split branches
- no UI or project-format changes

