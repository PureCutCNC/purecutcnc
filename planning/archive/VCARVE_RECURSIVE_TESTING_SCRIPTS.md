# V-Carve Recursive — Testing Scripts Guide

This document catalogues the diagnostic scripts under [`scripts/`](scripts/) that were written to debug and verify the recursive skeleton V-carve generator ([`vcarveRecursive.ts`](src/engine/toolpaths/vcarveRecursive.ts)). It explains how to run them, what each does, and the methodology behind building them.

## Prerequisites

All scripts are TypeScript files run directly via [`tsx`](https://github.com/nicolo-ribaudo/tsx) (or `npx tsx`):

```bash
npx tsx scripts/<script-name>.ts
```

Most scripts load a `.camj` project file from a path relative to the project root (e.g. `../../purecutcnc/work/v-carve-skeleton-tests.camj` resolved from `scripts/`). This file contains a project with multiple operations (letters C, A, T, e, o, circle, etc.) that serve as the standard test suite. A few scripts construct their own inline project programmatically instead.

Scripts import directly from the source tree via TypeScript paths (e.g. `import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'`), so they always test the current working-tree code. There is no separate test runner — the build (`tsc -b`) serves as the type-check gate, and scripts serve as the behaviour-check gate.

---

## 1. Quick Verification Scripts

These are lightweight smoke-tests that run the generator on a fixed set of operations and print summary statistics.

### [`quick-verify.ts`](scripts/quick-verify.ts)

Loads the standard `.camj` test file and runs `generateVCarveRecursiveToolpath` on six key operations (C, A, T, e, o, circle). For each, prints the number of `cut` moves, `rapid` moves, and total moves.

**Use case:** Quick regression check after any change — if the cut/rapid counts change unexpectedly, you know something shifted.

```bash
npx tsx scripts/quick-verify.ts
```

### [`debug-vcarve-recursive.ts`](scripts/debug-vcarve-recursive.ts)

Builds an inline project from scratch with the letter-C shape (hardcoded polygon), a 60° V-bit, and a v-carve recursive operation. Runs the generator and prints all suspiciously long cuts (XY length > 1.5× stepover), sorted longest-first.

**Use case:** Spot-checking a specific shape without needing the external `.camj` file. The inline project also appears in the app's CAM panel so you can visually compare the output.

```bash
npx tsx scripts/debug-vcarve-recursive.ts
```

### [`quick-compare.ts`](scripts/quick-compare.ts) *(if exists)*

Compares toolpath output from two different builds (or parameter sets) to detect differences.

---

## 2. Analysis / Summary Scripts

These run the generator over one or more operations and print detailed summaries of the resulting moves — longest cuts, slope violations, Z-level distribution, etc.

### [`analyze-vcarve-recursive.ts`](scripts/analyze-vcarve-recursive.ts)

Loads project `purecutcnc.camj`, finds feature `f0003` / tool `t0012` / operation `op0018`, and runs the generator at three different stepover values (0.01, 0.04, 0.08). For each run it prints warnings and the top-20 longest cuts with full position data.

**Use case:** Testing how stepover affects toolpath quality — smaller stepover should produce smoother paths.

```bash
npx tsx scripts/analyze-vcarve-recursive.ts
```

### [`find-straight-cut2.ts`](scripts/find-straight-cut2.ts)

Runs the generator on operations `op0006` (C) and `op0008` (A), then prints the top-30 longest cuts (of any kind) with slope classification (flat vs sloped).

**Use case:** Finding unexpectedly long cuts that may indicate spurious connections or missing retracts.

```bash
npx tsx scripts/find-straight-cut2.ts
```

### [`analyze-zigzag.ts`](scripts/analyze-zigzag.ts)

Focuses on letter `e` (op0012). Prints detailed position data for two clusters of moves (160-165 and 176-185) that form a zigzag pattern. Checks endpoint matching, identifies interleaved arm chains, and measures tiny "connector" segments.

**Use case:** Investigating zigzag artefacts where two arm chains get incorrectly chained together.

```bash
npx tsx scripts/analyze-zigzag.ts
```

### [`analyze-letter-a-drops.ts`](scripts/analyze-letter-a-drops.ts)

Deep-dive into letter A (op0008) focusing on two specific dangerous Z drops: move [33] (tryDirectLink descending to z=0.3733) and move [73] (bridge path descending to z=0.3760). Uses a `window()` helper to print context around each problematic move.

**Use case:** Understanding why paths enter at the wrong Z level (path-ordering vs tryDirectLink vs bridgeSiblingChildren).

```bash
npx tsx scripts/analyze-letter-a-drops.ts
```

### [`find-zigzag-all.ts`](scripts/find-zigzag-all.ts)

Scans all operations in the test project for zigzag patterns.

### [`analyze-stepped-z.ts`](scripts/analyze-stepped-z.ts)

Analyzes Z-level stepping patterns in the toolpath output.

### [`analyze-t-direction.ts`](scripts/analyze-t-direction.ts)

Analyzes directionality of the letter T toolpath.

### [`analyze-sort-cost.ts`](scripts/analyze-sort-cost.ts)

Analyzes the cost function used by `sortPathsNearestNeighbor` to understand path-ordering decisions.

---

## 3. Path-Level Tracing Scripts

These are the most detailed debugging tools. They inspect the `Path3D[]` arrays emitted by individual internal functions, often by simulating specific stages of the algorithm.

### [`trace-path-ordering.ts`](scripts/trace-path-ordering.ts)

Dedicated to the path-ordering problem around move [29] in letter A. Prints moves [20]-[40] with full context (XY distance, Z delta, positions), then performs a manual analysis of how `sortPathsNearestNeighbor` reorders the paths and why a bridge-split-arm path end gets linked to the wrong next path.

**Use case:** Understanding why paths at different Z levels get linked together.

```bash
npx tsx scripts/trace-path-ordering.ts
```

### [`trace-tryDirectLink.ts`](scripts/trace-tryDirectLink.ts)

Analyses the tryDirectLink behaviour around move [29]. Computes the V-cone radius equation, checks whether the current and corrected slope formulas would accept or reject the link.

**Use case:** Validating the tryDirectLink geometry check before the final decision to remove it.

```bash
npx tsx scripts/trace-tryDirectLink.ts
```

### [`trace-letter-a-bridge-z.ts`](scripts/trace-letter-a-bridge-z.ts)

Reverse-engineers the Z calculation in `bridgeSiblingChildren` for the deep bridge point (z=0.3760) in letter A. Computes the channel radius that would produce that Z, compares it to the actual letter-A geometry, and checks if the radius measurement is physically plausible.

**Use case:** Validating the `bridgeSiblingChildren` Z budget formula and detecting when it uses an incorrect channel radius.

```bash
npx tsx scripts/trace-letter-a-bridge-z.ts
```

### [`trace-o-emission.ts`](scripts/trace-o-emission.ts)

Manually simulates the recursive stepping loop for the letter `o` (op0046) for the first 20 levels. At each level it prints the offset, Z, number of next regions, and the expected emission type (CONTINUE / SPLIT / COLLAPSE). This helped diagnose where the flat contour rings come from (answer: only the COLLAPSE handler emits them via `contourToPath3D`).

**Use case:** Understanding the recursion topology without instrumenting the source code.

```bash
npx tsx scripts/trace-o-emission.ts
```

### [`trace-c-paths.ts`](scripts/trace-c-paths.ts)

Traces the paths emitted for the letter C shape.

### [`trace-o-paths.ts`](scripts/trace-o-paths.ts)

Traces the paths emitted for the letter o shape.

### [`trace-path-source.ts`](scripts/trace-path-source.ts)

Tags each path with its emission source and prints the full ordered list.

### [`trace-vcarve-rescue.ts`](scripts/trace-vcarve-rescue.ts)

Traces the `buildCenterlineRescuePath` behaviour.

### [`trace-paths-deep.ts`](scripts/trace-paths-deep.ts)

Deep trace of all paths with full position data.

---

## 4. Split/Bridge Investigation Scripts

These focus on the topology event handlers: `bridgeSplitArms` (parent→child connections at a split) and `bridgeSiblingChildren` (child→child connections).

### [`inspect-split-bridges.ts`](scripts/inspect-split-bridges.ts)

For each operation (C, A, T), finds the first split site using `buildInsetRegions`, detects corners on both the parent and child contours, then searches the generated toolpath for `cut` moves that connect parent corners to child corners.

**Use case:** Verifying that the correct number and geometry of parent→child bridges are emitted.

```bash
npx tsx scripts/inspect-split-bridges.ts
```

### [`debug-split-connections.ts`](scripts/debug-split-connections.ts)

Detailed debugging of the split-connection logic.

### [`inspect-split-bridges.ts`](scripts/inspect-split-bridges.ts) *(see above)*

### [`check-micro-split.ts`](scripts/check-micro-split.ts)

Checks whether micro-offset splits are handled correctly.

### [`test-split.ts`](scripts/test-split.ts) / [`test-split-logic.ts`](scripts/test-split-logic.ts)

Standalone tests of the split-detection logic independent of the full generator.

### [`inspect-corner-angles.ts`](scripts/inspect-corner-angles.ts)

Inspects the corner angle measurements used by `detectCorners`.

### [`inspect-circle-corners.ts`](scripts/inspect-circle-corners.ts)

Checks how `detectCorners` handles smooth circular contours (expects zero "corners").

---

## 5. Feature-Specific Debug Scripts

### [`debug-letter-a.ts`](scripts/debug-letter-a.ts)

Comprehensive analysis of letter A (op0008). Groups consecutive `cut` moves into segments by continuity, then:
1. Lists all segments with their Z range, XY extent, direction.
2. Finds inter-segment links with gaps > 0.01" (these are tryDirectLink connections).
3. Finds long flat cuts (XY > 0.1") that cross the interior.
4. Finds cuts with large Z drops.
5. Lists top-20 longest cuts.

The segment-grouping approach was key to distinguishing between legitimate skeleton-arm cuts and spurious connection cuts.

```bash
npx tsx scripts/debug-letter-a.ts
```

### [`debug-channel-walk.ts`](scripts/debug-channel-walk.ts)

Debugs the channel-walking behaviour in bridge paths.

### [`debug-child-bisectors.ts`](scripts/debug-child-bisectors.ts)

Debugs the bisector direction calculations for child contours.

### [`debug-compare-full.ts`](scripts/debug-compare-full.ts)

Full comparison between two generator runs.

### [`find-dangling-cuts.ts`](scripts/find-dangling-cuts.ts)

Finds cut moves that don't connect to any other move (orphan segments).

### [`find-orphan-corners.ts`](scripts/find-orphan-corners.ts)

Finds detected corners that never get connected by any arm chain.

### [`find-near-markers.ts`](scripts/find-near-markers.ts)

Finds moves near specific spatial markers.

---

## 6. Methodology: How These Scripts Were Built

### Approach

The scripts follow a progressive-debug methodology:

1. **Smoke-test first** — [`quick-verify.ts`](scripts/quick-verify.ts) and [`debug-vcarve-recursive.ts`](scripts/debug-vcarve-recursive.ts) were written first to establish baseline move counts and catch obvious regressions.

2. **Identify anomalies** — The analysis scripts ([`find-straight-cut2.ts`](scripts/find-straight-cut2.ts), [`debug-letter-a.ts`](scripts/debug-letter-a.ts)) sort cuts by XY length descending. This surfaces suspiciously long or flat cuts that shouldn't exist (like the 0.23" spurious cut in letter C, or the cross-cut in letter A).

3. **Pinpoint the source via segment-grouping** — [`debug-letter-a.ts`](scripts/debug-letter-a.ts) groups consecutive `cut` moves into segments. A legitimate skeleton arm is a continuous diagonal descent; a spurious connection cut appears as an isolated single move that jumps between segments at different Z levels. This grouping made it easy to see that move [29] was an isolated link-cut, not part of any arm chain.

4. **Trace Z-level mismatches** — [`trace-path-ordering.ts`](scripts/trace-path-ordering.ts) and [`analyze-letter-a-drops.ts`](scripts/analyze-letter-a-drops.ts) identified that paths at different Z levels were being linked. The root cause was `sortPathsNearestNeighbor` choosing the closest XY entry point regardless of Z, and `tryDirectLink` approving the connection because its depth budget didn't account for the V-bit slope.

5. **Reverse-engineer internal calculations** — [`trace-letter-a-bridge-z.ts`](scripts/trace-letter-a-bridge-z.ts) reverse-engineered the `bridgeSiblingChildren` Z formula: `targetZ = currentZ - channel.radius / slope`. By plugging in known values from the output, the script revealed the channel radius being measured (0.2156") was far too large for the local channel geometry (~0.04"), indicating the perpendicular bisector search was finding a distant wall instead of the local channel.

6. **Simulate recursion manually** — [`trace-o-emission.ts`](scripts/trace-o-emission.ts) reimplemented the recursion loop separately from the generator, printing topology at each level. This revealed that flat contour rings only come from the COLLAPSE handler, not from CONTINUE steps — which contradicted earlier assumptions.

7. **Validate fixes** — After making a source change, the same scripts are re-run to confirm the specific anomaly disappears while the overall move counts remain stable for unaffected operations.

### Key Patterns

All scripts share these patterns:

| Pattern | Purpose |
|---------|---------|
| `generateVCarveRecursiveToolpath(project, op)` | Single function call to generate the toolpath |
| `.filter(m => m.kind === 'cut').sort(...)` | Find longest cuts (anomaly detection) |
| Consecutive-move grouping | Distinguish arm chains from isolated link-cuts |
| `Math.hypot()` for XY distance | Consistent distance measurement |
| Z-level window printing | See context around a suspicious move index |
| Slope/depth-budget calculations | Validate geometric checks against V-bit angle |

### When to Add a New Script

Add a new script when:

- You spot a new anomaly in the toolpath that existing scripts don't cover.
- You need to reverse-engineer an internal calculation to understand a bug.
- You want to verify a fix is working before committing.
- You need to compare outputs across parameter variations (stepover, tool angle, etc.).

Follow the same convention: start with a JSDoc comment explaining the purpose and run command, import `generateVCarveRecursiveToolpath`, and use the standard `.camj` test file path.

---

## Running All Scripts

There is no single test harness — scripts are run individually. A typical verification workflow:

```bash
# 1. Build (type-check)
npm run build

# 2. Quick regression check
npx tsx scripts/quick-verify.ts

# 3. Spot-check specific operations
npx tsx scripts/debug-letter-a.ts
npx tsx scripts/find-straight-cut2.ts
npx tsx scripts/inspect-split-bridges.ts
```
