# V-Carve Recursive: Letter A — Dangerous Z Drops Analysis

## Overview

Letter A (`op0008`, `v-carve-skeleton-tests.camj`) produces several cut moves with large
negative dz values that appear as dangerous Z plunges in the toolpath. The XY path looks
correct but Z is wrong in specific places. Two distinct root causes were identified.

---

## Bug 1 — Wrong path entry end (moves [33] and [218])

### Symptom

Move [33]: `cut from z=0.5061 to z=0.3733, dz=-0.1328, xy=0.0522`
Move [218]: `cut from z=0.7500 to z=0.5577, dz=-0.1923, xy=0.1494`

In both cases the tool descends steeply via a `tryDirectLink` cut, then the very next
move immediately rises back up — confirming the tool entered the path from the wrong end.

### What happens

`sortPathsNearestNeighbor` picks the nearest path end in XY to the current position.
For paths that have one shallow end and one deep end, it can pick the deep end because
it happens to be closer in XY. `tryDirectLink` then approves the descent because the
XY distance is within the depth budget (`xyDist < safeZ - min(pos.z, entry.z)`).

The result: the tool plunges to the deepest point of the path first, then climbs back
out — the exact reverse of the correct direction.

**Move [33] detail:**
```
[32] ends at z=0.5061
[33] direct-link: z=0.5061 -> z=0.3733  (wrong end — deep)
[34] immediately rises: z=0.3733 -> z=0.5595
[35..37] flat contour at z=0.5595
```
The path `[34..37]` should have been entered at z=0.5595 (its shallow end), not z=0.3733.

**Move [218] detail:**
```
[217] arm tip at z=0.7500 (maxDepth)
[218] direct-link: z=0.7500 -> z=0.5577  (wrong end — deep)
[219..230] arm chain rising from z=0.5595 to z=0.7500
```
The arm chain `[219..230]` should have been entered at its shallow end (z=0.5595),
not its deep end (z=0.5577).

### Root cause

`sortPathsNearestNeighbor` uses only XY distance to pick the next path and its entry
direction. It does not consider Z: it will happily pick the deep end of a path if that
end is closer in XY, even when the shallow end is only slightly farther away.

### Proposed fix

In `sortPathsNearestNeighbor`, when choosing between the two ends of an open path,
prefer the end whose Z is **closer to the current Z** (or shallower), not just the
end that is closer in XY. A combined cost function:

```
cost = xyDist + alpha * abs(endZ - currentZ)
```

where `alpha` weights Z-proximity. A value of `alpha ≈ 1.0` (same units as XY since
both are in project inches/mm) should be sufficient to prefer the shallower end in
most cases without breaking the XY-nearest-neighbour ordering for paths that are
genuinely far apart.

Alternatively: when both ends are within `tryDirectLink` budget, always prefer the
end with `endZ >= currentZ` (rising or lateral) over the end with `endZ < currentZ`
(descending).

---

## Bug 2 — Collapse/bridge contour emitted at wrong Z (move [73])

### Symptom

Move [73]: `cut from z=0.5595 to z=0.3760, dz=-0.1834, xy=0.0059`

This is the **first cut after a plunge** — not a link move. The path itself starts at
z=0.5595 (the plunge target) and immediately drops to z=0.3760, then runs flat at
z=0.3760 for two more moves, then rises back to z=0.5134 and z=0.5768.

```
[72] plunge to z=0.5595
[73] cut: z=0.5595 -> z=0.3760  (dz=-0.1834)
[74] flat: z=0.3760
[75] flat: z=0.3760
[76] rises: z=0.3760 -> z=0.5134
[77] rises: z=0.5134 -> z=0.5768
```

z=0.3760 corresponds to a depth of `0.75 - 0.3760 = 0.374"` below the surface.
`maxCarveDepth = 0.5"` so this is within the allowed depth range — but the Z value
is geometrically wrong for the V-carve skeleton at this location.

### What happens

The path at [73..77] is a **`bridgeSiblingChildren` path** — the inverted-V walk
that connects two split children through their shared parent contour. The path shape
is: `child-corner → medial-midpoint → child-corner`, where the medial midpoint Z is
computed from the channel radius and the V-bit slope.

The deep point (z=0.3760) is the medial midpoint. Its Z is computed as:
```
targetZ = currentZ - (channel.radius / slope)
```

The channel radius at the midpoint is being computed too large — either because:
1. The perpendicular channel measurement (`findPerpendicularChannelMidpoint`) is
   finding the wrong wall pair (e.g. the far walls of the A's counter instead of
   the local channel walls), producing an inflated radius.
2. The `currentZ` passed into `bridgeSiblingChildren` is the pre-split Z, but the
   walk starts from a child corner at `nextZ` — there may be an off-by-one in which
   Z level is used as the reference for the radius-to-depth conversion.

The path immediately rises back after the deep point, which is consistent with the
medial-axis walk overshooting the true channel width at that location.

### Proposed fix

In `bridgeSiblingChildren`, clamp `pointZ` more aggressively:

```ts
const pointZ = Math.max(minZ, Math.min(nextZ, targetMidpointZ))
```

Currently it clamps to `Math.min(lastZ, targetMidpointZ)` — using `lastZ` (the
previous step's Z) as the upper bound. This allows the midpoint Z to be much deeper
than `nextZ` (the child corner Z) when the channel is wide. Clamping to `nextZ`
instead ensures the bridge never goes deeper than the child corners it connects.

---

## Test Scripts

- `scripts/analyze-letter-a.ts` — full move list + all dangerous drops + Z range check
- `scripts/analyze-letter-a-drops.ts` — focused analysis of each specific drop with context

## Test Case

- File: `/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj`
- Operation: `op0008` (V-Carve skeleton A)
- Verification after fix:
  - No cut move with `dz < -0.05` that is immediately followed by a rising move
  - No path whose first cut descends more than `stepSize` below the plunge target
  - `sortPathsNearestNeighbor` should prefer shallow-end entry for open paths
