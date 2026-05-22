---
status: Done
created: 2026-05-21
---

# 3D Toolpath Link Optimization Plan

## Goal

Reduce retract/plunge churn in 3D rough surface, waterline finish, and (lightly) parallel finish toolpaths. Replace safe-Z round-trips with same-Z cut links inside already-cleared material, replace retract+rapid+plunge with a single plunge when the next path starts at the same XY, and restructure waterline so one section (pocket / outside wall / island) finishes top-to-bottom before moving on. Cut direction (climb / conventional) selected on the operation must be honored per ring side — i.e. with respect to which side of the contour the material is on — not by uniform winding.

## Approach

Five phases, smallest fix first.

### Phase 1 — Cut direction by ring side (bug fix)

`applyContourDirection` today reverses every ring uniformly. That is correct for one role (pocket-wall cuts: material outside the contour, tool inside) and wrong for the other (outer-wall / island cuts: material inside the contour, tool outside). Mixed-topology operations machine half their rings the wrong way relative to the selected cut direction.

- Add `applyContourDirectionBySide(rings, direction)` that classifies each ring as outer (CCW in natural Clipper orientation, material inside) or hole (CW, material outside), then chooses the winding that puts material on the side that gives the user's selected direction. For outer rings, climb = CCW, conventional = CW. For holes / pocket walls, climb = CW, conventional = CCW.
- Replace uniform direction application in rough surface (`cutClosedContours` is called per region, but `applyContourDirection` is invoked there with no side awareness) and in waterline (`applyContourDirection(pointContours, direction)`).
- Parallel finish has no closed contours — no change to direction logic.

### Phase 2 — Same-XY plunge helper

- Add a helper `linkVerticalIfAligned(currentPos, nextEntry, safeZ)` that returns either a single `plunge` (when `nextEntry.z` is below current and XY matches within epsilon) or `null` (caller falls back to retract+rapid+plunge).
- Wire into the waterline column descent (phase 4) and the rough surface level-to-level transition. Only applies when XY happens to align naturally — we do not engineer start rotations to force alignment (out of scope; that would change entry geometry on the outer ring and is more naturally part of the cross-operation spiral-down backlog item).

### Phase 3 — Same-Z at-Z linking

- Add `linkAtZIfSafe(moves, currentPos, nextEntry, z, safeLinkRegion)`. Emits a single `cut` move at Z when the straight segment lies inside `safeLinkRegion` (the clearable polygon shrunk by tool radius); otherwise returns false so the caller can retract.
- Use in `cutOffsetRegionRecursive` for ring → next-inner-ring inside one roughing region. The safe-link region is the level's clearable polygon eroded by tool radius.
- Use in the waterline column loop for ring → ring at the same Z (multiple disjoint rings within one column at one level — uncommon but possible).
- Cap link distance at ~1.5 × stepover as a safety bound against mesh-noise spurs the containment test might miss.

### Phase 4 — Waterline column ordering

Restructure `generateFinishSurfaceWaterline` from a flat top-down ring loop into a column-based loop.

1. Build all rings as today, tagged with `z` and path geometry.
2. Cluster rings into "columns" — groups whose offset paths overlap (strict containment / intersection test, no tolerance fudging; if the user has walls thin enough that two pockets merge upstream, they're already one ring).
3. Order columns greedily by nearest entry from current position.
4. Inside each column, sort rings top → bottom. Before cutting ring i+1, rotate its closed contour so its start point is the closest point on the ring to ring i's end position. Then the same-XY plunge from phase 2 fires.
5. Between rings at the same Z within a column, use the at-Z link from phase 3.
6. Between columns, retract.

### Phase 5 — Parallel finish closer-endpoint pickup (small)

- Keep zigzag (per prior decision).
- When picking the next scanline, choose the end that's closer to current position rather than always the rotated-X-sorted start. Reverse the segment only when reversing does not violate cutDirection on the closed-contour parts (parallel finish doesn't have closed contours, so always permitted here).
- No retract behavior change in this phase — just less zig-zag traversal back across the table when a long region has many scanlines.

## Files affected

- `src/engine/toolpaths/geometry.ts` — add `applyContourDirectionBySide`.
- `src/engine/toolpaths/pocket.ts` — add `linkAtZIfSafe`, `linkVerticalIfAligned`; thread a `safeLinkRegion` argument through `cutOffsetRegionRecursive` / `cutClosedContours` so they can use the at-Z link instead of retract.
- `src/engine/toolpaths/roughSurface.ts` — build per-level safe-link region (eroded clearable), pass into the recursive cutter; use `linkVerticalIfAligned` between levels; use `applyContourDirectionBySide` for outgoing rings.
- `src/engine/toolpaths/finishSurfaceWaterline.ts` — column clustering, top-to-bottom column descent, same-XY plunge between Z levels in a column, at-Z link for same-Z rings inside a column, side-aware direction.
- `src/engine/toolpaths/finishSurfaceParallel.ts` — closer-endpoint pickup for the next scanline.
- `src/engine/toolpaths/roughSurface.test.ts` — ring-to-ring at-Z link assertion; bug-fix regression confirming an outer-wall + pocket-wall mix cuts in matching climb/conventional sense.
- `src/engine/toolpaths/finishSurface.test.ts` — same-Z waterline link; column ordering (one pocket finishes top-to-bottom before another column starts); side-aware direction; same-XY plunge between Z levels.

## Tests

- `npx tsx src/engine/toolpaths/roughSurface.test.ts`
- `npx tsx src/engine/toolpaths/finishSurface.test.ts`
- Ad-hoc check against `work/3d-operations-on-block.camj`: roughing has fewer safe-Z `rapid` moves between rings; waterline finishes each pocket top-to-bottom; both outer wall and pocket walls cut in the same climb/conventional sense (visual inspection of arrowed paths).
- `npm run build` before completion.

## Open questions / risks

- Column clustering uses geometric overlap of offset paths. If a model has two pockets connected by a slot narrower than the tool, the waterline already merges them into a single ring upstream — they'll cluster as one column, which is the correct behavior.
- Side-aware direction depends on the rings carrying their natural Clipper winding into `applyContourDirectionBySide`. We must classify *before* any prior code has normalized winding. I'll audit the call sites and convert at the right point.
- `linkAtZIfSafe`'s containment test inflates by tool radius and caps link distance at ~1.5 × stepover. A wider un-cleared spur could still allow a bad link in theory; in practice mesh-noise spurs are sub-tool-radius. Tests use synthetic vertical-walled cases where containment is exact.
- Phase 1 alone may change existing test snapshots that asserted on the buggy uniform-direction behavior. We'll update those tests to assert the new correct behavior.

## Out of scope

- **Cross-operation spiral-down / ramp linking between Z levels** (separate cross-operation pass; includes engineering outer-ring start rotation for roughing to make same-XY plunge fire more often).
- **A "single-direction" / "one-way" operation toggle** for zigzag-style finishing — needs UI and a consistent rollout across rough / waterline / parallel / 2.5D. **Backlog item.**
- Any UI or operation-schema changes.
- G-code export, simulation, or feedrate changes.
