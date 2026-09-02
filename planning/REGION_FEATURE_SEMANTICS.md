---
status: current
authoritative-for: region feature meaning and CAM filtering behavior
last-verified: 2026-08-31
---

# Region Feature Semantics

## Purpose

`operation: 'region'` means the feature is a machining-area mask. It is not
material, not an independent cut target, and not a boundary that should be
machined automatically.

A region answers:

> Where may this operation generate cutting moves?

The operation's machinable targets still answer:

> What geometry should this operation cut?

## Persistent and UI model

Regions use the normal `FeatureDefinition` and `FeatureInstance` representation
so they can reuse sketch geometry, placement, visibility, and tree ordering.
They render in the separate Regions tree section and are hard-excluded from
material CSG. Their UI language must say mask/filter rather than add, subtract,
or cut.

Moving regions into a separate persistent collection would be a `.camj` schema
change. It requires its own approved GitHub issue and migration contract; it is
not an incidental refactor.

## Mask composition

Every valid region is a closed profile with `regionMaskMode` equal to `include`
or `exclude` (default `include`). `buildRegionMask` applies regions in feature-
tree order:

1. a first include starts with no allowed area and adds its profile;
2. a first exclude starts with the operation's full subject and removes its
   profile;
3. later includes add their profile back;
4. later excludes remove their profile.

Order therefore matters for nested include/exclude masks. Multiple plain
include regions behave as a union, but the full contract is an ordered mask,
not an unordered union. Closed-profile topology is evaluated through Clipper;
invalid or open region profiles do not create a mask.

## CAM contract

A region is resolved into the operation's **domain before generation**. There
is no post-generation move filtering anywhere in the engine — every generator
receives already-resolved geometry and is region-unaware.

### Typed domains

The domain is **typed**, and the operation's kind decides which resolver
applies:

| Domain | Operations | Resolver |
| --- | --- | --- |
| Area (polygon set) | `pocket`, `surface_clean`, `rough_surface`, V-carve offset/medial, rest regions, waterline finishing, parallel finishing | `resolveRegionDomainArea` or `resolveRegionDomainCentre` |
| Curve (guide, contours, scanlines) | `edge_route_*`, `follow_line`/carving, trochoidal guide | `resolveRegionDomainCurve` |
| Point | `drilling` | filter candidate centres (unchanged) |

Waterline finishing is the area case applied per ring: its rings are already
tool-centre contours, so `resolveRegionDomainCentre(modelSilhouettePaths,
mask, toolOffset)` builds the composite allowed area and each ring is clipped
to it during generation — the rings differ per Z level, but the domain is an
area, never a curve guide.

Applying an area intersection to a curve domain would turn the region's edge
into a machined contour and is forbidden.

### Polarity implies the mode

There is no separate user-facing mode control. The existing include/exclude
polarity selects the behaviour:

- **include → coverage.** Everything inside the region must end up cut. The
  tool may over-reach outside the region to achieve it (e.g. to clear a sharp
  corner). The masked domain is the intersection of the unmasked domain with the
  region dilated by the operation's effective centre inset.
- **exclude → containment.** The tool body stays out of the excluded area. The
  region is subtracted from the unmasked domain with the operation's clearance
  applied.

### The three resolvers

The resolvers in `src/engine/toolpaths/regionDomain.ts` differ by what the
caller's domain already represents and each has a precondition:

- **`resolveRegionDomainArea`** — for pre-erosion area domains. The generator
  will subsequently erode the entire domain by `centreInset`. Include regions
  are pre-dilated by `centreInset` to cancel that erosion; exclude regions are
  subtracted raw, relying on the generator's erosion for clearance.
- **`resolveRegionDomainCentre`** — for tool-centre area domains that will not
  be further eroded. Both polarities dilate the region by `centreInset` so the
  resolver provides the required clearance itself.
- **`resolveRegionDomainCurve`** — for curve-guide domains. Both polarities
  dilate by `centreInset`; the composite allowed area is built with Clipper
  boolean ops and a single call to `splitClosedGuideByForbiddenPaths` produces
  the final ordered spans.

Choosing the wrong resolver is a silent clearance bug. The surface-clean case
is the worked example: `buildSurfaceCoverageRegions` has already expanded by
the tool radius, so the domain is the tool-centre path with only `radialLeave`
erosion remaining. Passing a non-zero `centreInset` to `resolveRegionDomainArea`
here would pre-dilate includes expecting a full erosion that never arrives —
the cutter sweeps a full tool radius into excluded areas. `resolveRegionDomainCentre`
is correct at this seam.

### Surface-slope composition

An optional `finish_surface` slope range is a second tool-centre area domain. It is derived from the existing cutter-location (CL) height map, with angles measured from horizontal. User regions resolve first with their existing coverage/containment inset; the slope domain is then intersected with zero additional inset because its cells already describe legal cutter-centre positions. The cutter body may therefore reach across a slope boundary, just as the setting help states.

Slope boundaries are raster boundaries at the operation’s bounded height-map cell size. Missing CL samples are excluded rather than interpreted as flat, opposing one-sided derivatives cannot cancel at a sharp ridge, and disconnected eligible pieces require a safe-Z traverse unless an at-depth segment is proven to remain in the composite domain and above the CL surface. There is no generated-move deletion and no boundary-only contour pass. With both slope fields absent, the slope-domain path returns before allocation and existing region behavior stays byte-identical.

### Safety guarantee

> **masked output ⊆ unmasked output**, in both polarities, for every
> operation.

Coverage over-reach is bounded by the operation's own domain `D`, never by the
region, so a region can only ever narrow what is cut and can never introduce
a cut. This is directly testable per fixture.

### Entry strategies and clearance

Entry strategies (`createEntryPolicy`) run inside masked regions exactly as they
run inside unmasked ones. `EntryPolicy.clearanceRegions` and link containment
(`safeLinkCheck`, `maxLinkDistance`) are built from the masked domain, not the
original, so a helix is never placed in excluded area and a link never crosses
an exclusion at depth.

### Region boundaries

Region boundaries still never become cutting moves in their own right. A region
edge does now participate in the generated geometry as a boundary the toolpath is
built around — concentric offsets, corner smoothing, entries, and ordering are
all computed from the masked shape.

### V-carve depth-dependent caveat

V-carve cut width is depth-dependent (half-width `d·slope`), so one static 2D
region cannot bound both the tool centre and the cut at every depth. The
generator passes `centreInset = maxCarveDepth·slope`, which means the
full-depth pass reaches the include region boundary exactly while shallower
passes over-reach by `(maxCarveDepth − currentDepth)·slope` — bounded by the
operation's own domain, so never a new cut. Exclude containment is unaffected
and correct at every depth. See `planning/REGION_DOMAIN_HANDOFF.md`.

## Invariants

- No selected region means the operation behaves as it would without masking
  (null-mask returns the domain by reference; byte-identical output).
- Regions contribute no stock or model volume and no machining depth.
- Region boundaries do not become cutting moves merely because they are
  selected.
- `masked ⊆ unmasked` for every fixture, in both polarities.
- Coverage over-reach is bounded by the operation's own domain.
- Entry clearance regions and link containment are built from the masked
  domain.
- Missing definitions, open profiles, and unsupported feature roles do not
  silently become machinable targets.
- No-mask parity is byte-identical for every operation.

## Implementation and verification

The shared domain resolvers live in `src/engine/toolpaths/regionDomain.ts`, mask
composition in `src/engine/toolpaths/regions.ts`, and feature-role classification
in `src/store/helpers/featureRoles.ts` — do not duplicate role checks.

Changes require focused coverage for:
- ordered include/exclude composition matching `buildRegionMask`,
- no-mask parity (byte-identical output),
- `masked ⊆ unmasked`,
- exclude containment (`centreInset` clearance from the region boundary, asserted
  as distance not mere non-containment),
- affected operation fixtures and `npm run build`.
