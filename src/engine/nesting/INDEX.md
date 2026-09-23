# INDEX — src/engine/nesting/

Sheet nesting for issue #741: place copies of part footprints on a sheet. Pure
geometry — no store, no project model, no UI. Callers turn features into
footprints and placements back into instance transforms.

- `index.ts` — public API: `nest`, the default strategies, and the types
- `types.ts` — `NestRequest` / `NestResult` and friends. Spacing (`minimumGap`), footprint growth (`expandFootprint`) and part order (`orderParts`) are always caller-supplied; the placer holds no gap of its own
- `packer.ts` — `nest()`: bottom-left fill over no-fit polygons. The sheet is its bounding rectangle plus "rectangle minus sheet" pieces as obstacles; grown shapes are tested against grown shapes, raw footprints against the sheet. NFPs are cached per part pair and relative rotation
- `clipperOps.ts` — integer-domain polygon helpers (scale, rotate, union, difference, filled outer contours, NFP from convex pieces)
- `convex.ts` — ear-clipping + Hertel–Mehlhorn convex decomposition and convex Minkowski sums; replaces Clipper's quad-union `MinkowskiSum`, which took 41 s for one 270-vertex NFP
- `defaults.ts` — `expandByHalfGap` (square joins: Clipper's round joins can cut inside the true offset) and `largestFirst`
- `packer.test.ts` — measured-geometry guarantees: gap between parts and to obstacles, inside the sheet (incl. non-rectangular), rotation set, overflow counts, determinism, input validation
- `convex.test.ts` — pieces are convex and tile the polygon exactly; convex sum area
- `defaults.test.ts` — the grown footprint contains the exact gap/2 offset at every corner; largest-first order

Holes in footprints are ignored (filled); part-in-hole placement is a later step of #741.
