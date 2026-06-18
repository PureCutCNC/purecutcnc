---
status: Draft
created: 2026-06-18
---

# Pocket Offset Entry Feed Reduction Plan

## Goal

Add an optional reduced-feed entry behavior for offset pocket roughing so the first innermost offset loop can cut at a lower feed rate, such as 50% of the operation feed, before returning to normal feed for the outward offset loops. This should reduce tool load on the first full-engagement pass without changing offset ordering or cut direction.

## Approach

- Treat this as a follow-up to `POCKET_OFFSET_INNER_FIRST_Plan.md`; do not implement it in that PR.
- Decide whether the first implementation is internal/defaulted or exposed as an operation setting.
- If exposed, add an operation field for the reduced-feed percentage with a clear default and migration behavior.
- Extend toolpath move/feed representation only if the current G-code pipeline cannot already express temporary feed-rate changes.
- Apply the reduced feed only to the first closed offset loop emitted for each pocket level/region group, then restore the operation feed for subsequent loops and links.
- Keep feed changes out of geometry generation; offset order, stepover, stock-to-leave, and contour winding should stay unchanged.

## Files affected

- `src/types/project.ts` - add operation data only if this becomes user-configurable.
- `src/store/helpers/operationDefaults.ts` - set the default if a new operation field is added.
- `src/engine/toolpaths/types.ts` - add per-move or feed-change representation only if needed.
- `src/engine/toolpaths/pocket.ts` - mark or emit the first innermost offset loop at reduced feed.
- `src/engine/gcode/` - emit feed-rate changes if toolpath moves gain feed metadata.
- `src/components/cam/` - add UI only if the feature is exposed to users.
- `src/engine/toolpaths/toolpaths.test.ts` - add focused tests for reduced-feed first loops and normal-feed restoration.

## Tests

- Add an offset-pocket test with multiple loops on one level and assert only the first innermost loop uses the reduced feed.
- Add a multi-level test and assert each level applies the reduced feed to its own first innermost loop.
- Add G-code export coverage if feed changes are represented in exported G-code.
- Add default/migration tests if a new operation field is introduced.
- Run `npm run build`.

## Open questions / risks

- Should this be a fixed internal policy, a user-facing setting, or a future advanced setting?
- What default percentage should be used: 50%, tool-derived, or operation-configurable?
- Does the current toolpath/G-code model support per-loop feed changes cleanly, or does this require a broader move representation change?
- Simulators and previews may ignore feed today; confirm whether that is acceptable or whether feed metadata should be visible.

## Out of scope

- Adaptive feed control based on engagement angle or material model.
- General feed scheduling for all toolpath strategies.
- Changing offset order, cut direction, stepover, or entry/retract geometry.
- Changing spindle speed, plunge feed, or ramp strategy.
