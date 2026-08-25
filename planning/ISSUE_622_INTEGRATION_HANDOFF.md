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
- Status: `slice 1 landed; slice 2 dispatched`
- User authorization for external-worker dispatch: granted 2026-08-25 for as
  many slices as the issue needs.

## Slices

`src/engine/toolpaths/pocket.ts` is the contention point for D1, D4 and D5, so
those stay sequential and manager-owned. Only slices with disjoint file
ownership are delegated.

| slice | scope | owner | state |
| --- | --- | --- | --- |
| 1 | D1 + D2 — one `applyLevelFeed` per finish band level (`pocket.ts`, `surface.ts`) | manager | landed |
| 2 | D6 — feed-colour legend scoped to the selected operation | delegated | dispatched |
| 3 | D4 — Z-invariant traversal | manager | pending |
| 4 | D5 — `cleanWallCorners` on the finish wall contour | manager | pending |
| 5 | audit fixtures per (kind, control) | delegated | pending |

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
