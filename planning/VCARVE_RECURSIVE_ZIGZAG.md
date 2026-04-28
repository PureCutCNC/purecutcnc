# V-Carve Recursive: Zig-Zag Path Analysis

## Symptom

Letter `e` (op0012, `v-carve-skeleton-tests.camj`) shows a visible zig-zag in the bottom-right corner area. Two distinct clusters were identified in the move sequence.

---

## Cluster A — "Pivot" zig-zag (moves 160–163)

### What it looks like

```
[160] A → B  rising  (+dz=0.0173)
[161] B → C  falling (-dz=0.0173)
[162] C → D  rising  (+dz=0.0173)
[163] D → C  falling (-dz=0.0173)  ← back to C, exact same point as [162].from
```

Move 163 ends at the exact same XYZ as move 162 started — a literal back-and-forth to the same point.

### Root cause

Two separate 2-point arm segments both have `C` (`5.3042, 1.7388, 0.7327`) as an endpoint — one ends there, one starts there. These are two **converging skeleton arms at a collapse tip**: both arms tracked to the same nearest vertex in the next offset contour, so they share an endpoint.

`chainPaths` chains them sequentially: `C→D` then `D→C`, visiting the shared collapse point twice and producing a back-and-forth.

---

## Cluster B — Interleaved zig-zag (moves 176–185)

### What it looks like

```
[176] up   xy=0.0110  dz=+0.0173
[177] up   xy=0.0110  dz=+0.0173
[178] down xy=0.0012  dz=-0.0189   ← tiny connector, opposite Z direction
[179] up   xy=0.0100  dz=+0.0362
[180] down xy=0.0010  dz=-0.0194   ← tiny connector
[181] up   xy=0.0100  dz=+0.0367
[182] down xy=0.0013  dz=-0.0199   ← tiny connector
[183] up   xy=0.0100  dz=+0.0373
[184] down xy=0.0012  dz=-0.0201   ← tiny connector
[185] up   xy=0.0100  dz=+0.0375
```

All consecutive endpoints connect with **zero XYZ gap** (exact float equality), so `chainPaths` treats this as one continuous path. But the path alternates between a ~0.01 XY "up" arm step and a ~0.001 XY "down" connector.

### Root cause

Two separate skeleton arm chains that run in **opposite Z directions** were chained end-to-end by `chainPaths` because their endpoints share exact float values. The tiny "down" segments are likely `buildInteriorCornerBridge` or collapse-contour segments that happen to share an endpoint with the arm chain. `chainPaths` sees the exact float match and appends them, interleaving the two chains into one path that oscillates in Z.

---

## Common Root Cause

Both clusters are caused by the same flaw in `chainPaths` in `vcarveRecursive.ts`:

> **`chainPaths` chains any two 2-point segments that share an exact endpoint, regardless of whether the resulting Z direction makes geometric sense.**

It has no awareness of:
1. Whether the chained segment continues in the same Z direction (rising vs. falling).
2. Whether the resulting path doubles back to a point already visited.

---

## Proposed Fixes

### Fix 1 — Direction continuity guard in `chainPaths`

Before appending segment B onto the tail of a chain, check that the Z direction of B is consistent with the last segment of the chain. Specifically:

- If the last segment was rising (`dz > threshold`) and B is falling (`dz < -threshold`), do **not** chain — start a new path instead.
- Same rule in reverse.
- A small `threshold` (e.g. `0.005` in project units) avoids false positives from near-horizontal segments.

This directly prevents cluster B's interleaved pattern.

### Fix 2 — Deduplicate reverse-duplicate arm pairs

Before chaining, remove any pair of 2-point segments `[A→B]` and `[B→A]` where both endpoints are identical (exact float match). Keep only one of the pair (the one whose Z direction is consistent with the surrounding chain, or simply the first encountered).

This directly prevents cluster A's back-and-forth pivot.

### Fix 3 — Upstream: prevent duplicate arm emission

The deeper fix for cluster A is in `stepArms` / `mergeTrackedArms`: when two tracked arms converge to the same nearest vertex in `nextContour`, only one arm segment should be emitted for that vertex. The current `mergeTrackedArms` deduplicates by position threshold on the *input* arms, but not on the *output* cut endpoints — two arms at different positions can still both snap to the same `nextContour` vertex and emit `[A→C]` and `[B→C]`, which `chainPaths` then chains as `A→C→B` (or `B→C→A`), producing the pivot.

---

## Test Case

- File: `/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj`
- Operation: `op0012` (V-Carve skeleton e)
- Script: `scripts/analyze-zigzag.ts`
- Verification: after fix, Z-direction reversals between consecutive cuts should drop to zero (or only at genuine topology transitions like split bridges).
