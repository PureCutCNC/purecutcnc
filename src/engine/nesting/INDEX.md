# INDEX — src/engine/nesting/

Sheet nesting for issue #741: place copies of part footprints on a sheet. Pure
geometry — no store, no project model, no UI. Callers turn features into
footprints and placements back into instance transforms.

- `index.ts` — public API: `nest`, the default strategies, and the types
- `types.ts` — `NestRequest` / `NestResult` and friends. Spacing (`minimumGap`), footprint growth (`expandFootprint`), hole shrinking (`shrinkHoles`) and part order (`orderParts`) are always caller-supplied; the placer holds no gap of its own
- `packer.ts` — `nest()`: bottom-left fill over no-fit polygons. The sheet is its bounding rectangle plus "rectangle minus sheet" pieces as obstacles; grown shapes are tested against grown shapes, raw footprints against the sheet. NFPs are cached per part pair and relative rotation, minus the inner-fit region of the fixed part's shrunk holes (#859); an optional `gravity` picks the sheet corner parts pack toward (callers aim it at the machine origin)
- `clipperOps.ts` — integer-domain polygon helpers (scale, rotate, union, difference, filled outer contours, region pieces with islands, the frame around a region, NFP from convex pieces)
- `convex.ts` — ear-clipping + Hertel–Mehlhorn convex decomposition and convex Minkowski sums; replaces Clipper's quad-union `MinkowskiSum`, which took 41 s for one 270-vertex NFP
- `job.ts` — `NestJob`, the serializable form of a request for the worker (growth travels as `growthPadding`), and `requestFromJob`
- `simplify.ts` — `simplifyRing`: iterative Ramer–Douglas–Peucker within a tolerance; `expandByHalfGap` grows by the tolerance first so the simplified footprint still contains the exact offset (#855)
- `flatten.ts` — `flattenProfileWithin`: tolerance-bounded flattening of arcs, circles and béziers, so callers can fold the chord error into the gap
- `defaults.ts` — `expandByHalfGap` (square joins: Clipper's round joins can cut inside the true offset), its mirror for holes `shrinkByHalfGap`, and `largestFirst`
- `packer.test.ts` — measured-geometry guarantees: gap between parts and to obstacles, inside the sheet (incl. non-rectangular), rotation set, overflow counts, determinism, input validation, parts inside holes (gap to the hole's edge, islands, round holes, a rotated host), a round sheet
- `convex.test.ts` — pieces are convex and tile the polygon exactly; convex sum area
- `flatten.test.ts` — every point of the true curve is within tolerance of the polygon; chord count stays near minimal
- `defaults.test.ts` — the grown footprint, plain and simplified, contains the exact gap/2 offset at every corner; simplification cuts vertices; a shrunk hole keeps gap/2 from every edge and island; largest-first order

A footprint's own holes are filled; parts go inside a part only through `NestPart.holes` (#859), which callers fill with the holes nothing would machine inside.
