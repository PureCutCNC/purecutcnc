---
status: Done   # Draft → Approved → In progress → Done | Abandoned
created: 2026-05-29
---

# Clipping Layer Refactor Plan (issue #122)

## Goal

Resolve the design-drift findings in issue #122: heavy computational-geometry
algorithms (arc reconstruction, segment annotation, Kasa circle fitting, RDP,
the offset-simplification pipeline) were added to `src/store/helpers/clipping.ts`,
a file whose architectural purpose is "clipper-lib wrappers" in the state layer.
Per `ARCHITECTURE.md`, pure geometry transforms belong in `src/engine/`. We move
them out, deduplicate the flatten-sampling constants, and refresh the stale
INDEX.md files.

## Approach

- **New engine module** `src/engine/toolpaths/arcReconstruction.ts` holds the
  pure geometry: known-circle reconstruction, the segment-annotation +
  segment-preserving boolean reconstruction, and the offset-simplification
  pipeline (`simplifyOffsetContour` and its private helpers). It imports only
  from `engine/` and `types/project` — no store imports — keeping the dependency
  direction correct (store → engine).
- The `contour` parameters that previously used
  `ReturnType<typeof flattenFeatureToClipperPath>` are retyped to the existing
  `ClipperPath` type from `engine/toolpaths/types.ts`, removing the dependency on
  a `clipping.ts` symbol.
- `clipping.ts` keeps only the Clipper wrappers it was designed to be.
- **Sampling constants:** export `DEFAULT_FLATTEN_CURVE_SAMPLES` (24) and
  `DEFAULT_FLATTEN_ARC_STEP` (π/36) from `engine/toolpaths/geometry.ts`, use them
  as the `flattenProfile` defaults, and import them in the annotation code so the
  duplicated literals (and silent-divergence risk) are gone.
- Update importers (`derivedFeatures.ts`, `projectStore.ts`, `second_cut_test.ts`,
  `offsetSimplify.test.ts`) to pull the moved symbols from the new module.

## Files affected

- *(new)* `src/engine/toolpaths/arcReconstruction.ts` — moved geometry: `KnownCircle`,
  `collectKnownCircles`, `reconstructArcsInProfile`, `clipperContourToProfile`,
  `SegmentAnnotation`, `buildSegmentAnnotations`, `clipperContourToProfilePreserving`,
  and the full offset pipeline (`simplifyOffsetContour` + helpers).
- `src/store/helpers/clipping.ts` — removes the moved code; stays a Clipper wrapper.
- `src/engine/toolpaths/geometry.ts` — adds the two exported flatten constants.
- `src/store/helpers/derivedFeatures.ts` — split imports between the two modules.
- `src/store/projectStore.ts` — split imports.
- `src/store/second_cut_test.ts` — split imports.
- `src/store/helpers/offsetSimplify.test.ts` — import `simplifyOffsetContour` from engine.
- `src/store/INDEX.md` — clipping.ts description back to "Clipper wrappers".
- `src/engine/INDEX.md` — note new module + gpuMesh/heightfieldShader; link simulation INDEX.
- `src/engine/toolpaths/INDEX.md` — add `arcReconstruction.ts` entry.
- *(new)* `src/engine/simulation/INDEX.md` — index the 10 simulation files.

## Tests

- Existing `offsetSimplify.test.ts` and `second_cut_test.ts` continue to exercise
  the moved functions (now imported from the engine module). `npm run build`
  runs the full structural suite; no behavior change is intended, so the
  refactor is verified by the green build + unchanged test assertions.

## Open questions / risks

- Pure code-motion refactor — no algorithm changes. Main risk is an import miss;
  caught by `tsc`/build.

## Out of scope

- The pre-existing `(clipper as any)` workarounds and `App.tsx` prop-passing
  (issue explicitly marks these as non-violations).
- Relocating `clipping.ts` itself out of `store/helpers/` (issue says it should
  stay as the Clipper wrapper where it is).
