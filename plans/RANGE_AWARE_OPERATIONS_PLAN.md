# Range-Aware Operations Plan

## Goal

Make every CAM operation treat selected regions as operation range filters, not machining geometry. A region should answer:

> Where is this operation allowed to keep generated cutting moves?

It should not answer:

> What should this operation machine?

The 3D STL rough/finish work now has the first complete version of this behavior. The next step is to apply the same model consistently across the remaining operations.

## Terminology

- **Machining target**: a real feature the operation cuts or follows, such as a subtract pocket, model feature, edge feature, text, drill hole, or selected stock mode.
- **Region / range**: a closed XY filter profile selected alongside machining targets. It clips generated toolpaths to the allowed area.
- **Allowed-area union**: the union of all selected region profiles for an operation. If no regions are selected, the operation is unrestricted.
- **Region-only target**: an operation target list that contains regions but no compatible machining target. This should be invalid for normal operations.

## Core Rules

1. A region cannot be the only selected target for an operation unless a future operation is explicitly designed to machine regions.
2. Each operation must require at least one compatible machining target plus zero or more regions.
3. Region feature-tree order must not affect operation output.
4. Multiple selected regions act as a union.
5. Regions are vertical XY filters through the resulting model. They do not contribute material, stock, model booleans, or cut depth.
6. Region top/bottom Z should follow stock or project context automatically and should not be directly editable as operation depth.
7. Clipping should keep cut moves inside the allowed-area union and reconnect retained fragments with safe transitions.

## Data Model Direction

Today regions are represented as `SketchFeature` entries with `operation: 'region'`. That makes them easy to draw/select, but it also lets them leak into places where normal add/subtract/model features are expected.

Recommended migration path:

1. **Short term**: keep `operation: 'region'` for compatibility, but centralize validation and path resolution so operations never treat regions as machining targets.
2. **Medium term**: add a dedicated project collection, for example `project.regions`, with a separate feature-tree root.
3. **Long term**: migrate region entries out of `project.features`, with project-load compatibility that converts legacy `operation: 'region'` features into region records.

Proposed region record shape:

```ts
interface MachiningRegion {
  id: string
  name: string
  sketch: Sketch
  visible: boolean
  locked: boolean
  folderId: string | null
}
```

No `z_top`, `z_bottom`, or `operation` field should be user-editable for regions. Display can extrude them visually through stock height, but that is presentation only.

## Shared Helper Work

Add a shared module, likely `src/engine/toolpaths/regions.ts`, that owns:

1. `splitOperationTargets(project, operation, compatibility)`:
   - returns compatible machining targets,
   - returns selected region/range filters,
   - reports missing and incompatible targets,
   - rejects region-only targets for operations that require geometry.

2. `buildRegionMask(project, regions)`:
   - validates closed profiles,
   - unions region paths,
   - exposes Clipper paths,
   - exposes `containsPoint(point)` and move-splitting helpers.

3. `clipToolpathMovesToRegionMask(result, mask, options)`:
   - splits cut moves at region boundaries,
   - interpolates Z/feed metadata along clipped 3D segments,
   - discards outside cut fragments,
   - inserts safe retract/link moves between disconnected kept fragments,
   - leaves rapid/plunge/link moves safe and coherent.

4. `clipPocketRegionsToMask(regions, mask)`:
   - pre-generation clipping for pocket-like algorithms where polygon clipping is safer and faster than post-clipping paths.

## Operation-Specific Plan

### Pocket

Current issue: pocket validation/resolution allows region targets alongside subtract targets, and may allow region-only selection. Fix this first.

Rules:

- Compatible machining targets: closed `subtract` features.
- Region filters: closed regions only.
- Invalid: region-only pocket target.
- Implementation: intersect resolved subtract pocket subjects with region union before offsetting/fill generation.

Tests:

- subtract-only pocket unchanged,
- subtract + one region clips pocket output,
- subtract + two disjoint regions clips to union,
- region-only pocket invalid and produces a clear warning/no moves.

### Edge Route Inside / Outside

Rules:

- Compatible machining targets:
  - inside: closed `subtract` features,
  - outside: closed `add` and `model` features.
- Region filters: closed regions only.
- Implementation: generate normal contours, then clip cut segments to the region mask. For closed contours, clipping can split them into open contour fragments.

Tests:

- region clips only the selected portion of an edge route,
- clipped fragments retract/link safely,
- region-only invalid.

### Surface Clean

Rules:

- Compatible machining targets: current surface-clean target features.
- Region filters: closed regions only.
- Implementation: prefer pre-generation clipping of surface coverage regions. If that is not practical for some pass styles, post-clip cut moves.

Tests:

- no-region output unchanged,
- region clips rough/finish surface-clean passes,
- protected/additive obstacles still work inside clipped areas.

### V-Carve / Recursive V-Carve

Rules:

- Compatible machining targets: current V-carve geometry targets, usually closed subtract/text-derived features.
- Region filters: closed regions only.
- Implementation: pre-clip source geometry if possible. If recursive tracking makes that risky, generate normally and post-clip cut moves with Z interpolation.

Tests:

- region limits V-carve output,
- clipped recursive paths do not produce unsafe links,
- region-only invalid.

### Follow Line / Engrave

Rules:

- Compatible machining targets: open/line geometry accepted by follow-line.
- Region filters: closed regions only.
- Implementation: post-clip open path segments to allowed mask with Z interpolation.

Tests:

- line crossing region emits only inside portion,
- line outside region emits no cuts,
- line with two regions emits two fragments with safe linking.

### Drilling

Rules:

- Compatible machining targets: drill-compatible points/circles.
- Region filters: closed regions only.
- Implementation: filter drill points by point-in-region union before generating cycles.

Tests:

- holes inside region kept,
- holes outside region dropped,
- multiple regions act as union,
- region-only invalid.

### 3D Rough / Finish

Current state:

- rough/finish already support region filters and local subtract-depth constraints from the STL work.

Follow-up:

- move their region handling onto the shared helper,
- add explicit region-only invalid tests,
- add dedicated tab/clamp/region fixture tests if not already covered.

## UI / Store Work

1. Fix operation target validation in `projectStore.ts` and CAM panel helpers:
   - region-only invalid for pocket and other normal operations,
   - target hints should say “select at least one compatible feature; regions are optional filters.”

2. Region properties:
   - remove editable Z fields for regions,
   - display region vertical extent as stock/project-derived,
   - keep operation badge language as “Region” / “Filter”, not add/subtract material.

3. Feature tree:
   - short term: keep regions in the features root but visually distinguish them.
   - medium term: add a `Regions` root section, similar to tabs/clamps.
   - migration should preserve existing project files.

4. Selection:
   - region selection should be allowed as auxiliary target selection,
   - operation creation should not infer a region-only operation.

## Implementation Order

1. Build shared target-splitting and region-mask helpers. **Done.**
2. Fix validation so pocket and all current operation creation paths reject region-only targets. **Done.**
3. Wire pocket to the shared helpers first. **Done.**
4. Add post-clipping helper for open/cut moves. **Done.**
5. Wire edge route, follow-line, and drilling. **Done.**
6. Wire surface clean and V-carve. **Done.**
7. Refactor 3D rough/finish to use the shared helper while preserving current behavior. **Done.** Rough/finish now use shared target splitting, rough uses the shared region mask union for outline clipping, and finish uses the shared tuple-contour clipping helper while preserving per-region scanline ordering.
8. Move region UI/data model toward a separate root/collection. **Partially done.** Regions now render under a separate `Regions` tree section while remaining stored in `project.features`. Region Z is no longer editable, the 3D display follows stock height, and a real `project.regions` collection remains a follow-up.

## Implementation Status

Implemented in `feature/range-aware-ops`:

- Added `src/engine/toolpaths/regions.ts` for target splitting, region-mask unioning, point containment, and post-clipping cut moves to region masks.
- Pocket, inside edge, surface clean, V-carve offset, and V-Carve skeleton now pre-clip resolved machining geometry to selected region filters where practical.
- Edge out and follow-line now post-clip generated cut moves to selected region filters with safe retract/link moves between retained fragments.
- Drilling now filters drill centers through selected region masks.
- Feature-first operation splitting now preserves selected regions as auxiliary filters on each split machining target instead of treating regions as per-feature machining targets.
- CAM operation creation/update validation now rejects region-only selections and accepts compatible machining features plus optional closed regions.
- Region targets are shown as filters in the CAM target summary.
- Region Z fields are hidden/locked in the properties panel. Multi-edit Z changes apply only to selected non-region features.
- Store updates guard against programmatic `z_top`/`z_bottom` patches changing region features.
- Region preview meshes render through current stock thickness instead of using feature Z metadata.
- The feature tree now excludes regions from the normal `Features` section and renders them in a separate `Regions` section.
- The creation toolbar now has a `Feature` / `Region` target toggle. Region mode creates closed sketch geometry directly as `operation: 'region'`, and open-path completion is blocked until the profile is closed.
- The add/subtract operation popup stays available for material features, but no longer offers `Region` as a type conversion.
- Pocket operations now include a rest-region helper action. It computes the pocket areas not reachable by the operation's assigned tool, including radial stock-to-leave, and creates closed region filters that can be reused by a later pocket operation with a smaller tool.
- Focused tests cover pocket region-only rejection, pocket clipping, follow-line clipping, drilling filtering, feature-first region preservation, and unchanged 3D rough/finish region behavior.

## Backlog / Open Design Questions

1. Should region masks include holes before the generic feature/profile system has explicit compound topology?
2. Should post-clipped toolpaths preserve feed/plunge distinctions beyond current move kinds?
3. How should region filters interact with tabs? Initial rule should be: regions restrict where cuts are generated; tabs still protect material inside those allowed cuts.
4. How should region filters interact with clamps? Initial rule should be: clamps remain collision/no-cut constraints regardless of region selection.
5. Should region filter selection be per-operation only, or should operations support named reusable region groups later?

## Definition of Done

This work is complete when:

1. Every operation rejects region-only targets unless explicitly designed otherwise. **Implemented for current operation creation/validation and toolpath generation.**
2. Every operation accepts compatible targets plus optional regions. **Implemented for current 2.5D operations; 3D rough/finish already supported this.**
3. Region tree/order has no effect on generated paths. **Implemented for the shared helpers and current operation target splitting.**
4. Toolpaths are clipped to selected region unions with safe links. **Implemented for pocket-like pre-clipping and open/contour post-clipping.**
5. Region Z is no longer user-editable material depth. **Implemented.**
6. Tests cover no-region parity, single-region clipping, multi-region union, and region-only invalid behavior for each operation family. **Partially implemented.** The current suite covers the main helper paths and representative operations; broader per-operation fixtures should be added as follow-up regression coverage.
