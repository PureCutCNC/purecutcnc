# Region Feature Semantics

## Purpose

`operation: 'region'` means the feature is a machining area filter. It is not material, not a cut target, and not something that should be machined by itself.

A region answers this question:

> Where is this operation allowed to generate cutting moves?

It does not answer:

> What geometry should this operation cut?

## General Rule

For any CAM operation that includes one or more region features in its target list:

1. Generate the operation's normal toolpath from its real machining targets.
2. Clip/filter the resulting machining area or generated path to the selected region profiles.
3. Keep only cutting motion inside the union of the selected regions.
4. Insert safe retracts/links when clipping splits a path into disconnected fragments.
5. Do not machine the region boundary unless a separate operation explicitly targets that boundary as normal geometry.

If no regions are selected, the operation should behave as it does today.

## Target Semantics

Operation targets can include both machining features and region features.

Examples:

- Pocket: subtract feature(s) are the pocket geometry; region feature(s) limit where the pocket toolpath is allowed.
- Edge route: add/subtract feature(s) define the route geometry; region feature(s) limit which generated route segments remain.
- Surface clean: add feature(s) define the surface region to clean; region feature(s) further mask the generated path.
- Rough surface: STL model is the 3D geometry; region feature(s) limit roughing to selected XY areas.
- Finish surface: STL model is the 3D surface; region feature(s) limit finishing passes to selected XY areas.
- V-carve: subtract/text-derived geometry defines the carve; region feature(s) limit generated carve moves where practical.
- Drilling: circle features define holes; region feature(s) may filter which drill points are allowed.

## Region Combination

When multiple regions are selected for one operation:

- Treat them as an allowed-area union.
- Cutting is allowed inside any selected region.
- Holes inside region profiles should be preserved if/when compound region profiles are supported.
- Region features should be order-independent.

## Geometry Model

Regions are 2D sketch profiles in project XY space.

They should be interpreted as:

- closed profiles only,
- no Z material contribution,
- no stock/model boolean contribution,
- no automatic edge machining,
- no operation depth of their own except where a UI needs display metadata.

Regions remain stored as `project.features` in the short term, but the UI renders them in a separate `Regions` tree section instead of mixing them into the normal material/model feature list. Their operation badge should communicate “mask/filter,” not “add/subtract material.”

Longer term, regions should probably move out of the normal feature list into a dedicated project collection and feature-tree root. That would prevent regions from being mistaken for cuttable add/subtract/model features and would better match tabs and clamps as CAM helper geometry.

Region Z should be derived from stock/project context for display only. Users should not edit region top/bottom Z as machining depth; a region is a vertical XY filter through the resulting model.

## Implementation Guidance

There are two possible implementation points:

1. Region clipping before path generation:
   - Best for pocket-like algorithms that already work with polygon regions.
   - Intersect the operation's resolved machining areas with the region union before offsetting/fill generation.

2. Region clipping after path generation:
   - Best for open paths, drilling points, contour paths, or generated 3D paths.
   - Split generated cut moves at region boundaries.
   - Keep inside fragments.
   - Add retract/link moves between retained fragments.

Prefer pre-generation clipping when it preserves algorithm correctness and avoids generating unnecessary paths. Use post-generation clipping when the operation produces paths that are easier to filter than to pre-resolve.

## Current Status

The first range-aware pass is implemented for the current CAM operations.

Completed:

1. Shared region-resolution helper:
   - collect selected `operation === 'region'` features,
   - validate closed profiles,
   - union region profiles,
   - expose Clipper paths and point-in-region tests.

2. Operation target validation:
   - allow region features as auxiliary targets for operations that support clipping,
   - require at least one real machining target where the operation needs one,
   - reject region-only operations unless the specific operation explicitly supports that mode.

3. 2.5D operations:
   - pocket,
   - edge route inside/outside,
   - surface clean,
   - follow line,
   - V-carve / recursive V-carve,
   - drilling.

4. 3D operations:
   - rough surface should clip roughing areas/toolpaths to selected region union,
   - finish surface should clip scanlines/surface paths to selected region union.

5. Path-splitting utilities:
   - split line/cut moves at region boundaries,
   - preserve move Z interpolation for 3D paths,
   - discard outside fragments,
   - insert safe transitions between kept fragments.

6. UI language:
   - label region features as machining masks/regions,
   - avoid implying regions are cut geometry,
   - operation hints should say regions limit the operation rather than being machined.

7. Tests:
   - operation with no region matches existing behavior,
   - single region clips path output,
   - multiple regions act as union,
   - region-only invalid where a real target is required,
   - clipped 3D moves preserve interpolated Z,
   - linking between clipped fragments retracts safely.

Remaining follow-up:

1. Move regions out of `project.features` into a dedicated project collection.
2. Add broader per-operation fixture coverage for multi-region union and region-only invalid cases.
3. Decide whether region masks need compound-profile holes before the generic sketch model supports explicit compound topology.

## Non-Goals

Regions should not:

- create stock,
- create model solids,
- create automatic cut boundaries,
- alter feature Z spans for material modeling,
- participate in boolean add/subtract model construction,
- be exported as geometry unless an explicit export mode asks for region geometry.

## Recommended First Step

Start with shared helper infrastructure, then wire it into rough/finish surface first because those operations motivated the STL workflow:

1. Add a region resolver that returns a unioned allowed-area mask.
2. Update rough surface target parsing to separate model vs regions.
3. Clip rough surface generated regions to the allowed mask before pocket offsetting.
4. Update finish surface scanline generation to only emit intervals inside the allowed mask.
5. Add tests for model + one region and model + two disjoint regions.

After that, roll the same semantics into 2.5D operations operation-by-operation.
