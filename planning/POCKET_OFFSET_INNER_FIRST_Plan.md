---
status: In progress
created: 2026-06-16
---

# Pocket Offset Inner-First Plan

## Goal

Change pocket roughing with `pocketPattern: 'offset'` so each offset set cuts from the deepest innermost remaining offset outward toward the pocket wall. This avoids starting a level with the cutter fully engaged against the pocket wall, while preserving the selected climb/conventional contour direction for each closed offset loop. Also fix the related pocket level-transition safety issue so a retracted tool rapids in XY at safe Z before plunging vertically into the next level.

## Approach

- Keep this as an algorithmic ordering change only; do not add a new operation setting or migration.
- Preserve existing offset geometry generation. `buildInsetRegions` should still produce the same successive inset regions from the tool-radius/radial-leave starting region and the configured stepover.
- Add an explicit traversal mode to `cutOffsetRegionRecursive`, for example `outer-first` and `inner-first`, with the existing outer-first behavior as the default for current non-pocket callers.
- For pocket rough offset generation, pass the new inner-first traversal mode from `generateRoughBandMoves` only in the offset branch.
- Implement inner-first as post-order traversal:
  - Build child inset regions first.
  - Order child regions greedily from the current position.
  - Recursively cut children before cutting the current region.
  - After children finish, rotate/order the current region's contours from the updated current position and cut them with the same `direction` argument already used today.
- Do not reverse contour point order as a proxy for ordering. `applyContourDirection` in `cutClosedContours` remains responsible for climb/conventional winding.
- Allow linking and entry rotation to change naturally because the current position will now be the inner child endpoint when cutting the parent loop.
- Keep outer-first behavior available for shared callers such as rough-surface and surface-clean offset reuse unless tests or review decide those strategies should also change.
- When `transitionToCutEntry` starts from `safeZ` and the next cut entry is at a different XY/deeper Z, bypass direct cut-linking and use the existing rapid-at-safe-Z plus vertical plunge path. Keep same-level links and same-XY plunges unchanged.

## Files affected

- `src/engine/toolpaths/pocket.ts` - add the offset traversal mode, implement inner-first recursion, pass it from pocket rough offset generation, and prevent diagonal cut links when entering a new level from safe Z.
- `src/engine/toolpaths/toolpaths.test.ts` - add focused coverage that a rectangular pocket offset roughing pass emits inner loops before outer wall-adjacent loops, preserves climb/conventional winding, and enters the next depth with a vertical plunge after safe-Z XY rapid travel.
- `src/engine/toolpaths/roughSurface.test.ts` or `src/engine/toolpaths/finishSurfaceCleanup.test.ts` - add or adjust a narrow assertion only if the shared helper signature change risks unintentional caller behavior.

## Tests

- Add a unit test for a simple rectangular subtract pocket using offset roughing, with a tool/stepover that yields multiple offset loops on one Z level.
- Classify closed cut loops by bounds/area and assert the first closed cut loop is the smallest/innermost loop and the last loop is wall-adjacent.
- Run the same ordering assertion for both `cutDirection: 'climb'` and `cutDirection: 'conventional'`, or add a companion assertion that the loop winding still follows the selected direction after the order reversal.
- Include a regression check that the total cut coverage still reaches the expected wall-adjacent offset bounds.
- Add a multi-level pocket regression asserting the first cut at the deeper level is preceded by a vertical plunge at the same XY, not by a diagonal cut from safe Z.
- Run `npm run build` before handoff/PR.

## Open questions / risks

- Shared helper risk: `cutOffsetRegionRecursive` is also used by rough surface and surface-clean paths. The recommended implementation keeps their behavior unchanged by default; reviewers should decide separately whether imported/surface offset paths should also become inner-first.
- Multi-island and split-region pockets can create several child regions. Greedy ordering between sibling children should remain acceptable, but tests should include at least one multi-loop case if the implementation changes sibling ordering.
- Starting on the innermost loop may produce a longer first rapid/plunge than the current outer-first strategy. This is expected, but links must still respect existing safe-Z and safe-link checks.
- `transitionToCutEntry` is shared with rough-surface paths. The level-transition fix is scoped to starts from `safeZ` so rough-surface at-depth linking remains covered by existing tests.

## Out of scope

- New UI controls or operation schema changes.
- Parallel pocket strategy changes.
- Finish-pass ordering changes.
- Changing stepover, stock-to-leave, region resolution, or offset geometry.
- Changing climb/conventional definitions or reversing contour winding directly.

## Agent handoff task

Implement `POCKET_OFFSET_INNER_FIRST_Plan.md` after approval. Start by confirming the plan is approved and moving its `planning/INDEX.md` entry to In progress. Then make the smallest engine change that gives pocket rough offset generation an inner-first traversal while preserving existing contour winding. Add focused tests in `src/engine/toolpaths/toolpaths.test.ts` and run `npm run build`. Do not archive this plan or mark it Done until the user tests the behavior and confirms it is good.
