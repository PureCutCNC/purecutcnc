# Release Notes

# 0.0.3

## V-Carve Recursive — Z-Smoothing & Retraction Optimization (PR #60)

The recursive V-Carve skeleton tracing engine received significant improvements to path quality and efficiency.

**Z-Smoothing**
- Rescue paths now use linear Z interpolation instead of flat snapping, eliminating abrupt vertical drops in narrow channels and round letter sections (e.g. `e`, `O`)
- Straight fallback segments are now subdivided with smooth Z ramps

**Retraction Optimization**
- Consecutive paths sharing the same XY entry point now transition vertically instead of doing a full retract-to-safe-Z cycle
- Closed contours rotate to the nearest vertex before entry, reducing air travel
- Short same-Z gaps within 4× step size are now bridged with a direct cut instead of retract + rapid + plunge

Net result: −16 rapids across test letters, with former air moves converted to productive cutting.

---

## STL Model Operations — First Usable Cut (PR #62)

The first complete, usable implementation of STL-based 3D rough and finish operations.

**3D Rough**
- Cumulative top-down model-shadow protection
- Region clipping and surrounding feature protection
- Parent stock containment and local split-depth subtract pocket clipping
- Overhang and region-aware pass generation

**3D Finish**
- Parallel top-surface strategy with protected coverage holes
- Local split-depth floor clamping
- Split-line gouge avoidance and tool-radius clearance at floor transitions

**Infrastructure**
- Shared protected-footprint handling across add/model features, tabs, clamps, and subtract pockets
- Cached imported mesh, slice, and finish-height-map plumbing
- Edge-out support for stored model silhouettes

---

## Rest Region Operations (PR #63)

Adds rest machining support for edge route operations.

- Generated rest-region features are created automatically for inside/outside edge route operations
- Original machining targets are preserved; rest regions use a cleared tool reference for independent re-machining
- Region-clipped toolpaths now correctly retract to safe Z after the final clipped cut

---

## GrblHAL Post-Processor Support (PR #61)

Added GrblHAL as a supported post-processor export target.

---

## Rotate with Copy (PR #65)

The rotate tool now supports keeping the original features in place and producing rotated copies.

- A **Keep originals** checkbox appears in the banner once both rotate reference points are set
- When checked, clicking to commit the angle opens a copy-count prompt (default 1) matching the copy-move flow
- Entering a count greater than 1 produces that many evenly-spaced rotated copies, each step applying the chosen angle incrementally
- Originals are always preserved; the newly created copies are selected on completion
