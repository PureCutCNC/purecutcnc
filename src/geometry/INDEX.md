# INDEX — src/geometry/

Layer-neutral geometry primitives: pure functions over the canonical shapes in
`types/project.ts`, with no store, rendering, or import-pipeline semantics.

This folder exists so producers and consumers of the same geometry can share one
implementation without depending on each other. `src/text/` produces profiles
and `src/store/` consumes them — neither should import the other's helpers, so
the shared primitives live here instead.

## Files
- `profile.ts` — `clonePoint`, `transformProfile`, `translateProfile`,
  `cloneProfile`. Imported by `src/store/**` and `src/text/`.
- `profile.test.ts` — direct unit tests, including the `circle`-segment cases
  that private copies of these helpers historically got wrong (issue #234).

## Conventions
- Pure and side-effect free. No store access, no React, no Clipper/Three.
- Anything here must handle **every** segment kind that carries points beyond
  `to`: `arc` and `circle` both have a `center`, `bezier` has two controls.
  Forgetting one leaves those points untransformed and silently misplaces
  geometry.
- Not a home for domain-specific math: toolpath geometry stays in
  `engine/toolpaths/`, import-matrix math in `import/normalize.ts`, and
  store-only transforms (`mirrorProfile`, `transformProfileAffine`,
  `transformStlFeatureData`) in `store/helpers/transform.ts`.
