# Plan: DXF Post-Import Arc/Circle Simplification

**Branch:** `feat/dxf-arc-simplification`
**Status:** In progress

## Problem

DXF files sometimes export true arcs and circles as dense polylines (many short line
segments). SPLINE entities are also sampled into line strips during import. The result
is that imported geometry has hundreds of tiny lines where a handful of arc segments
would be correct and far more compact.

## Scope

- **In scope:** collinear-line merging, arc detection, full-circle detection
- **Out of scope (TODO):** spline fitting (Bézier/NURBS recovery from line approximations)

## Solution

Add a post-import simplification pass in `src/import/simplify.ts` that runs on each
`SketchProfile` after stitching in `importDxfString`.

### Passes (in order)

1. **Collinear-line merge** — consecutive `line` segments whose directions are nearly
   parallel (sine of included angle < 1e-4) are merged into a single segment.

2. **Arc fitting** — greedy left-to-right scan over runs of consecutive `line` segments.
   For each run, try from the longest possible sub-run down to `minArcSegments` (default 6).
   Use the Kasa least-squares circle fit; accept if max point deviation ≤
   `radiusToleranceFraction × radius` (default 1%). Replace accepted runs with a single
   `arc` segment. Clockwise direction is derived from the cross-product sum of
   center-relative vectors over the sampled points (in screen coords, Y-down).

3. **Full-circle detection** — if, after arc fitting, a *closed* profile contains exactly
   one `arc` segment whose endpoints coincide with `profile.start`, replace it with a
   `circle` segment.

### Configuration

`SimplifyOptions` (exported from `simplify.ts`):

| Field | Default | Description |
|---|---|---|
| `minArcSegments` | `6` | Min consecutive line segments to attempt arc fitting |
| `radiusToleranceFraction` | `0.01` | Max deviation as a fraction of fitted radius |

An optional `arcSimplifyOptions?: Partial<SimplifyOptions>` field is added to
`ImportContext` so callers can tune or disable the pass.

## Files

| File | Change |
|---|---|
| `src/import/simplify.ts` | New — all simplification logic |
| `src/import/simplify.test.ts` | New — unit tests |
| `src/import/dxf.ts` | Wire in simplification at end of `importDxfString` |
| `src/import/types.ts` | Add `arcSimplifyOptions` to `ImportContext` |
| `src/import/INDEX.md` | Create — document all import files |

## Testing

Tests in `simplify.test.ts` cover:
- Collinear merge (two segments → one)
- Arc detection: N points on a known circle → single arc segment
- Full-circle: closed N-gon approximating a circle → `circle` segment
- Mixed profile: arc run interleaved with non-arc segments
- Below-minimum-segment run is not fitted
- Tolerance boundary (tight/loose)

Run with: `npx tsx src/import/simplify.test.ts`
