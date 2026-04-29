# Debug Toolpath Marker Legend

When the **debug toolpath** checkbox is enabled on a V-carve recursive operation, colored shape markers are rendered at the midpoint of each cut move in the **Sketch (2D canvas) view**. Each marker indicates which part of the algorithm created that move.

| Shape | Color | Swatch | Source Tag |
|-------|-------|--------|------------|
| ● Circle | Red | `#ff6b6b` | `bridgeSplitArms` |
| ◆ Diamond | Yellow | `#ffd93d` | `siblingBridge` |
| ▲ Triangle-up | Green | `#6bcb77` | `bootstrap` |
| ■ Square | Blue | `#4d96ff` | `stepArms` |
| ⬠ Pentagon | Pink | `#ff8fab` | `intCornerBridge` |
| ▼ Triangle-down | Cyan | `#00f2ff` | `sameChildBridge` |
| ✕ X | Purple | `#c084fc` | `contour` |

| ★ Star | Orange | `#ff6b35` | `tryDirectLink` |
| ○ Circle-outline | Gray | `#a8a8a8` | `microContour` |
| • Dot | White | `#ffffff` | (fallback / untagged) |

## Source Tag Definitions

| Tag | Algorithm Step | Description |
|-----|---------------|-------------|
| `bridgeSplitArms` | [`emitCollapseGeometry`](../src/engine/toolpaths/vcarveRecursive.ts:1988) / [`bridgeSplitArms`](../src/engine/toolpaths/vcarveRecursive.ts:1172) | Bridge cuts from parent arm corners into child regions after a micro-offset split (1→N collapse). |
| `siblingBridge` | [`bridgeSiblingChildren`](../src/engine/toolpaths/vcarveRecursive.ts:1342) | Cross-child bridges connecting sibling regions through shared pinch points on the parent contour. |
| `sameChildBridge` | [`bridgeSiblingChildren`](../src/engine/toolpaths/vcarveRecursive.ts:1342) | Same-child bridges connecting corners on the same contour through shared pinch points on the parent contour. |
| `bootstrap` | [`buildFreshSeedBootstrapCuts`](../src/engine/toolpaths/vcarveRecursive.ts:1769) | Fresh-seed bootstrap cuts that restart arm tracking from new corners that appear on a child/next contour. |
| `stepArms` | [`stepArms`](../src/engine/toolpaths/vcarveRecursive.ts:950) | Standard arm-advance cuts — the main skeleton arm tracking step (CONTINUE or 1→1 collapse). |
| `intCornerBridge` | [`buildInteriorCornerBridge`](../src/engine/toolpaths/vcarveRecursive.ts:1918) | Bridge cuts across interior corners of a contour, preventing narrow-feature dropouts. |
| `contour` | Various (e.g. `rotateContour`) | Full contour paths emitted as standalone closed loops (region outlines at a given Z level). |
| `tryDirectLink` | [`tryDirectLink`](../src/engine/toolpaths/vcarveRecursive.ts:2480) | Shortcut connection that links a path endpoint directly to the start of another path when they are close in XY. |
| `microContour` | [`emitCollapseGeometry`](../src/engine/toolpaths/vcarveRecursive.ts:1988) | Micro-offset contour emitted as a standalone path when a region collapses to sub-step-size width. |

## Implementation

- **Source tagging**: [`diagTag()`](../src/engine/toolpaths/vcarveRecursive.ts:936) stamps a `__diagSource` property onto `Path3D` arrays.
- **Tag propagation**: [`pathsToMoves()`](../src/engine/toolpaths/vcarveRecursive.ts:2508) reads `__diagSource` from each path and attaches it as `move.source` on `ToolpathMove`.
- **Marker rendering**: [`drawSourceMarker()`](../src/components/canvas/previewPrimitives.ts:416) in `previewPrimitives.ts` draws the shapes using Canvas 2D API paths.
- **Toggle**: The debug checkbox sets `operation.debugToolpath` in [`CAMPanel.tsx`](../src/components/cam/CAMPanel.tsx:1268), which flows through to `ToolpathResult.debugToolpath` and is consumed by [`drawToolpath()`](../src/components/canvas/previewPrimitives.ts:655).

## Note

The debug checkbox does **not** alter toolpath generation. It only controls whether markers are drawn. All debug-driven logic that previously added X-marker paths (`buildXMarker`) or partial bridge paths has been removed.
