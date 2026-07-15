---
status: current
authoritative-for: region feature meaning and CAM filtering behavior
last-verified: 2026-07-15
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

An operation separates selected feature IDs into machinable targets and region
features through the shared role predicates. Construction geometry belongs to
neither group. Unless an operation explicitly defines otherwise, a region-only
selection is invalid because there is nothing to machine.

Operations apply the mask at the most appropriate boundary:

- polygon-based strategies intersect/difference their resolved areas before
  offsets or fills when that preserves the algorithm;
- path-based strategies split cut moves at mask boundaries, retain the inside
  fragments, interpolate Z on split 3D moves, and insert safe transitions;
- drilling filters candidate centers through the mask;
- surface roughing, finishing, cleanup, and rest-region calculations use the
  same ordered-mask semantics rather than treating the region boundary as a
  model contour.

Pocket, edge route, follow-line/carving, V-carve offset and medial, drilling,
surface-clean, rough-surface, finish-surface, and rest-machining paths all use
the shared region helpers where their target model permits regions.

## Invariants

- No selected region means the operation behaves as it would without masking.
- Regions contribute no stock or model volume and no machining depth.
- Region boundaries do not become cutting moves merely because they are
  selected.
- Retained path fragments preserve move type, feed semantics, and interpolated
  Z.
- Disconnected retained fragments use safe-Z transitions.
- Masking recomputes bounds and reports clipping warnings where applicable.
- Missing definitions, open profiles, and unsupported feature roles do not
  silently become machinable targets.

## Implementation and verification

The shared implementation lives in `src/engine/toolpaths/regions.ts`, with
area-level use in the relevant toolpath strategies and resolver. Feature-role
classification lives in `src/store/helpers/featureRoles.ts`; do not duplicate
it with ad-hoc operation checks.

Changes require focused coverage for ordered include/exclude behavior, no-mask
parity, region-only validation, Z interpolation, and safe transitions, plus the
affected operation fixtures and `npm run build`.
