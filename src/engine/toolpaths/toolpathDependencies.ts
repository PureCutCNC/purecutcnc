/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Pure change-detection for the per-operation toolpath cache (issue #518).
 *
 * Answers two questions with no geometry, no React, and no store state:
 *
 * - `featureInstanceComputationEquals` — did one feature row change in any way
 *   toolpath generation can see?
 * - `diffToolpathInputs` — across two project snapshots, which feature ids
 *   changed in a toolpath-relevant way, and is per-feature narrowing valid at
 *   all (or must every operation regenerate)?
 * - `operationFootprint` / `operationAffectedByChange` — the spatial model
 *   slice S3 narrows with: which world-XY region does one operation read, and
 *   can a change to a given set of feature ids reach it?
 *
 * Every comparison is identity-first: deep compares run only for values whose
 * identity already differs, so an unchanged project stays O(n) with no
 * serialization. Deep comparison reuses `projectsEqual`
 * (`src/store/helpers/normalize.ts`) rather than a second deep-equal — except
 * `modelAssets`, whose megabyte base64 payloads must never be serialized, so
 * it is compared by key set plus per-value reference identity instead
 * (`modelAssetsEquivalent` below).
 */

import type {
  Bounds2D,
  FeatureInstance,
  Operation,
  PersistedImportedMesh,
  Project,
  ProjectMeta,
  SketchProfile,
} from '../../types/project'
import { getProfileBounds, getStockBounds } from '../../types/project'
import { projectsEqual } from '../../store/helpers/normalize'
import { isConstruction, isRegion } from '../../store/helpers/featureRoles'
import { resolveFeatureInstances, resolveFeatureRow } from '../../store/helpers/resolveFeatures'
import { getFeatureGeometryProfiles } from '../../text'
import { normalizeToolForProject } from './geometry'

/**
 * The `ProjectMeta` fields read during toolpath generation.
 *
 * `meta` is compared only through this list — never wholesale. `meta.modified`
 * is rewritten by essentially every store action (~100 sites across every
 * slice), so comparing `meta` by identity or deep equality would invalidate on
 * every mutation and silently undo this entire issue. It must be a field list.
 *
 * Any new `meta` field read by toolpath generation must be listed here.
 *
 * Deliberately excluded, verified: `machineDefinitions` and `selectedMachineId`
 * are post-processor/export inputs and are read nowhere under
 * `src/engine/toolpaths/`; `name`, `created`, `modified`, `showFeatureInfo`,
 * `showDimensions`, and `copyMode` are metadata or display state.
 */
export const MACHINING_META_FIELDS = [
  'units', 'maxTravelZ', 'operationClearanceZ', 'clampClearanceXY', 'clampClearanceZ',
] as const

// Compare only the fields toolpath generation reads through the resolver
// (`resolveFeatureRow`, src/store/helpers/resolveFeatures.ts): definitionId,
// name, transform, constraints, z_top, z_bottom. Excluded (display-only):
//   visible, locked, folderId
// `name` is computation-relevant because it is embedded in user-visible
// toolpath warnings (`warnings[].params.name` — drilling.ts, carving.ts), so a
// cached result would otherwise keep the old name in the CAM panel after a
// rename. The alternative not taken: warnings could carry feature ids resolved
// to names at display time, which would let renames stop invalidating, but
// that touches every warning site and its i18n params and is out of scope.
// `folderId` is excluded deliberately: a feature's machining role lives on its
// definition (`FeatureDefinition.operation`), and `sectionForOperation`
// (`src/store/helpers/featureRoles.ts`) derives the tree section from that
// role rather than from the folder, so folder membership cannot change
// generated geometry. Folder-group transforms are baked into instance
// `transform` values, which are compared.
// Any new computation-relevant field added to FeatureInstance must be listed here.
export function featureInstanceComputationEquals(a: FeatureInstance, b: FeatureInstance): boolean {
  if (a === b) return true
  const aTransform = a.transform
  const bTransform = b.transform
  const transformEqual = aTransform === bTransform || (
    aTransform.a === bTransform.a
    && aTransform.b === bTransform.b
    && aTransform.c === bTransform.c
    && aTransform.d === bTransform.d
    && aTransform.e === bTransform.e
    && aTransform.f === bTransform.f
  )
  return (
    a.definitionId === b.definitionId
    && a.name === b.name
    && transformEqual
    && (a.constraints === b.constraints || projectsEqual(a.constraints, b.constraints))
    && a.z_top === b.z_top
    && a.z_bottom === b.z_bottom
  )
}

export interface ToolpathInputDiff {
  /** Ids whose toolpath-relevant input changed, plus every added and every removed id. */
  changedFeatureIds: Set<string>
  /** When true no per-feature narrowing is valid and every operation must regenerate. */
  invalidatesEveryOperation: boolean
}

/**
 * Whether two `meta` records agree on every machining-relevant field.
 *
 * Compares `MACHINING_META_FIELDS` only, never the record as a whole: the
 * other fields (`modified`, `name`, display state, machine selection, …)
 * cannot change generated geometry, and `modified` churns on nearly every
 * store action. Identity-first: a shared `meta` record compares equal in O(1).
 */
function machiningMetaEquivalent(a: ProjectMeta, b: ProjectMeta): boolean {
  if (a === b) return true
  for (const field of MACHINING_META_FIELDS) {
    if (a[field] !== b[field]) return false
  }
  return true
}

/**
 * Whether two model-asset records are equivalent for toolpath purposes.
 *
 * Compares the **key set**, then each value by **reference identity** — never
 * the payload. `PersistedImportedMesh.positions`/`indices` are base64 strings,
 * megabytes for a real import, and the `projectsEqual` deep compare would
 * serialize them on every diff (identity churns here even without a mesh
 * change: `addFeature` spreads `modelAssets` unconditionally).
 *
 * Identity is sufficient and conservative: persisted mesh payloads are
 * immutable blobs, so a genuinely changed asset gets a new reference, and
 * identity-differs → invalidate is the safe direction. An in-place mutation
 * of a shared asset would defeat it, which the store's immutability
 * convention forbids.
 */
function modelAssetsEquivalent(
  a: Record<string, PersistedImportedMesh>,
  b: Record<string, PersistedImportedMesh>,
): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    if (!(key in b) || a[key] !== b[key]) return false
  }
  return true
}

/**
 * Diff two project snapshots for toolpath-relevant input changes.
 *
 * Pure: never mutates either argument, and identical snapshots
 * (`previous === next`) return an empty set with `invalidatesEveryOperation`
 * false in O(1).
 *
 * `invalidatesEveryOperation` covers inputs that every operation can read,
 * regardless of its feature targets:
 *
 * - `project.dimensions` — named dimensions feed `resolveDimensionRef`, which
 *   resolves every feature's `z_top`/`z_bottom` in `resolveFeatureZSpan`
 *   (`src/engine/toolpaths/geometry.ts`). Small record whose identity does
 *   not churn on ordinary mutations, so it stays on `projectsEqual`'s deep
 *   compare.
 * - `project.meta` machining fields — `units` feeds `normalizeToolForProject`
 *   (`src/engine/toolpaths/geometry.ts`), `maxTravelZ` / `clampClearanceXY` /
 *   `clampClearanceZ` feed clamp clearance and travel-limit checks
 *   (`src/engine/toolpaths/clamps.ts`, `modelProtection.ts`), and
 *   `operationClearanceZ` feeds retract heights (`geometry.ts`). Compared only
 *   through the exported `MACHINING_META_FIELDS` list — never wholesale, since
 *   `meta.modified` churns on nearly every store action.
 * - `project.modelAssets` — STL payloads behind imported-model features,
 *   compared by key set plus per-value reference identity, never by content
 *   (see `modelAssetsEquivalent`).
 * - feature **order** — per-band topology is order-dependent
 *   (`resolver.ts`, `regions.ts`), so a pure reorder is a real change.
 *
 * `changedFeatureIds` covers per-feature input: added/removed rows, rows whose
 * computation-relevant fields changed, and rows whose referenced
 * `FeatureDefinition` changed (geometry lives on the definition, so an
 * instance row can be byte-identical while its profile changed). A definition
 * missing on either side counts as changed — unknown means invalidate.
 */
export function diffToolpathInputs(previous: Project, next: Project): ToolpathInputDiff {
  if (previous === next) {
    return { changedFeatureIds: new Set<string>(), invalidatesEveryOperation: false }
  }

  const changedFeatureIds = new Set<string>()
  const previousById = new Map(previous.features.map((feature) => [feature.id, feature]))
  const nextById = new Map(next.features.map((feature) => [feature.id, feature]))

  // Every added and every removed id.
  for (const feature of next.features) {
    if (!previousById.has(feature.id)) changedFeatureIds.add(feature.id)
  }
  for (const feature of previous.features) {
    if (!nextById.has(feature.id)) changedFeatureIds.add(feature.id)
  }

  // Ids present in both arrays: row-level diff, then definition-level diff.
  for (const id of previousById.keys()) {
    const previousRow = previousById.get(id)
    const nextRow = nextById.get(id)
    if (!previousRow || !nextRow) continue
    if (!featureInstanceComputationEquals(previousRow, nextRow)) {
      changedFeatureIds.add(id)
      continue
    }
    const previousDefinition = previous.featureDefinitions[previousRow.definitionId]
    const nextDefinition = next.featureDefinitions[nextRow.definitionId]
    if (previousDefinition === undefined || nextDefinition === undefined) {
      changedFeatureIds.add(id)
      continue
    }
    if (previousDefinition !== nextDefinition && !projectsEqual(previousDefinition, nextDefinition)) {
      changedFeatureIds.add(id)
    }
  }

  // The order of the ids present in both feature arrays is load-bearing:
  // per-band topology depends on feature order, so a pure reorder
  // invalidates every operation.
  const previousOrder = previous.features
    .filter((feature) => nextById.has(feature.id))
    .map((feature) => feature.id)
  const nextOrder = next.features
    .filter((feature) => previousById.has(feature.id))
    .map((feature) => feature.id)
  const orderChanged = previousOrder.length !== nextOrder.length
    || previousOrder.some((id, index) => id !== nextOrder[index])

  const invalidatesEveryOperation =
    orderChanged
    || !machiningMetaEquivalent(previous.meta, next.meta)
    || (previous.dimensions !== next.dimensions && !projectsEqual(previous.dimensions, next.dimensions))
    || !modelAssetsEquivalent(previous.modelAssets, next.modelAssets)

  return { changedFeatureIds, invalidatesEveryOperation }
}

// ============================================================================
// Per-operation read footprints (issue #518, slice S3a)
// ============================================================================

/**
 * The world-XY region in which a feature change can affect one operation,
 * plus the operation's direct targets. Pure: computed from the project and
 * operation alone, mutates neither.
 *
 * The target-bbox model is sound because (verified against the generators,
 * see the S3a slice instructions):
 *
 * - an island or obstacle only counts if it intersects the target union
 *   (`resolver.ts`), so it lies inside the target bbox;
 * - safe/travel Z derives from the operation's **target** spans plus stock
 *   thickness and `operationClearanceZ` (`geometry.ts`) — no distant feature
 *   can raise a retract;
 * - protected-footprint paths only subtract where they intersect the
 *   operation's own coverage;
 * - rest machining is materialized as region features at creation time, so
 *   there is no live operation-to-operation dependency.
 */
export interface OperationFootprint {
  /** World XY region in which a feature change can affect this operation. `null` = unknown. */
  bounds: Bounds2D | null
  /** Ids the operation targets directly. */
  targetFeatureIds: Set<string>
  /** True when the operation reads the whole model (stock-targeted surfacing). */
  readsWholeModel: boolean
}

/**
 * Compute the footprint of one operation.
 *
 * Unknown means invalidate — this function never guesses:
 *
 * - an empty target list has no spatial anchor;
 * - a target id whose row or definition fails to resolve;
 * - a target whose geometry yields no profiles;
 * - a missing tool, or one without a usable diameter (the footprint growth
 *   is expressed in tool diameters, so a diameter-less tool has no measure).
 */
export function operationFootprint(project: Project, operation: Operation): OperationFootprint {
  // Stock-targeted surface operations cut the whole model: no per-feature
  // narrowing applies. `bounds` carries the stock's world rectangle so the
  // `bounds === null` rule in `operationAffectedByChange` never fires for
  // them and their construction-only exemption still works.
  if (operation.target.source === 'stock') {
    return {
      bounds: getStockBounds(project.stock),
      targetFeatureIds: new Set<string>(),
      readsWholeModel: true,
    }
  }

  const targetFeatureIds = new Set(operation.target.featureIds)
  if (operation.target.featureIds.length === 0) {
    return { bounds: null, targetFeatureIds, readsWholeModel: false }
  }
  const rowById = new Map(project.features.map((feature) => [feature.id, feature]))
  for (const id of operation.target.featureIds) {
    if (!rowById.has(id)) {
      return { bounds: null, targetFeatureIds, readsWholeModel: false }
    }
  }
  const resolvedTargets = resolveFeatureInstances(project, operation.target.featureIds)
  if (resolvedTargets.length !== operation.target.featureIds.length) {
    // Every id has a row (checked above), so a shortfall means a definition
    // failed to resolve.
    return { bounds: null, targetFeatureIds, readsWholeModel: false }
  }

  // Union the profile bounds of every resolved target. Text features resolve
  // to one profile per glyph, so `getFeatureGeometryProfiles` must be used
  // rather than reading `sketch.profile` directly — a single-profile read
  // would under-measure multi-glyph text.
  const targetUnion = unionProfileBounds(
    resolvedTargets.flatMap((target) => getFeatureGeometryProfiles(target)),
  )
  if (targetUnion === null) {
    return { bounds: null, targetFeatureIds, readsWholeModel: false }
  }

  const tool = operation.toolRef
    ? project.tools.find((candidate) => candidate.id === operation.toolRef) ?? null
    : null
  if (!tool) {
    return { bounds: null, targetFeatureIds, readsWholeModel: false }
  }
  const toolDiameter = normalizeToolForProject(tool, project).diameter
  if (!Number.isFinite(toolDiameter) || toolDiameter <= 0) {
    return { bounds: null, targetFeatureIds, readsWholeModel: false }
  }

  // Grow the target union into the region this operation's cutter can reach.
  // The multiplier is relative to the tool diameter, so it is unit-free.
  //
  // Derived (issue #518, S5), not picked. What actually reaches past the
  // target bbox:
  //
  // - an outside edge route offsets the path by one radius and the cutter
  //   body extends another → 1 diameter;
  // - `buildProtectedFootprintPaths` expands features by about a tool radius
  //   when clipping coverage → half a diameter more;
  // - `trochoidalCutWidth` and `stockToLeaveRadial` genuinely extend the
  //   swept region → additive.
  //
  // So the margin is 2·toolDiameter + trochoidalCutWidth + stockToLeaveRadial,
  // ~1.33x the real geometric reach. `stepover` is deliberately **not** in the
  // sum: it is the spacing between passes *inside* the region, not an
  // extension past it. Do not "restore" it: the earlier 4·toolDiameter +
  // stepover margin was picked, not derived, and its generosity cost exactly
  // the benefit this issue exists to deliver — on the user's fixture it
  // reached 0.82" beyond the stock edge, so any nearby feature regenerated
  // the pocket. Being short would ship a stale toolpath; being generous
  // costs the invalidation win the user is measuring.
  const grow =
    2 * toolDiameter
    + (operation.trochoidalCutWidth ?? 0)
    + (operation.stockToLeaveRadial ?? 0)

  return {
    bounds: {
      minX: targetUnion.minX - grow,
      maxX: targetUnion.maxX + grow,
      minY: targetUnion.minY - grow,
      maxY: targetUnion.maxY + grow,
    },
    targetFeatureIds,
    readsWholeModel: false,
  }
}

/**
 * Whether a change to `changedFeatureIds` can affect the operation the
 * footprint was recorded for. Pure: mutates neither project snapshot.
 *
 * Returns true (regenerate) when:
 *
 * - `bounds === null` — the footprint is unknown, so relevance cannot be
 *   determined. Unknown means invalidate.
 * - `readsWholeModel` — the operation cuts the whole model, so every changed
 *   feature invalidates it, except one whose construction or region role
 *   holds on every side where the feature exists (`roleExemptEverywhere`).
 *   Issue #199 guarantees construction geometry can never be a machining
 *   target, region mask, or CSG input — the `constructionExclusion` guard
 *   test fails the build if that regresses — and a region can only filter an
 *   operation whose target list contains it, which a stock-targeted
 *   operation has none of.
 * - otherwise, for each changed id: a direct target always invalidates
 *   (including a region — a targeted region is the operation's mask); a
 *   feature whose construction role holds on every side where it exists is
 *   skipped; a feature whose region role holds on every side where it exists
 *   and that is not a direct target is skipped — the generators split
 *   exactly `operation.target.featureIds` and never scan `project.features`
 *   for regions, so a non-target region cannot reach this operation.
 *   Requiring the role on every side where the feature exists, with absence
 *   raising no objection, is what lets a newly added or removed
 *   region/construction feature stay exempt while a to/from-role conversion
 *   still invalidates; any other changed feature invalidates when its world
 *   bbox in `previous` **or** in `next` intersects the footprint — checking
 *   both sides is what catches a feature that moved into or out of the
 *   footprint. A side where the feature does not exist contributes nothing;
 *   a side where it exists but its bbox cannot be computed invalidates.
 *
 * Bbox intersection is inclusive: touching bounds count as intersecting.
 */
export function operationAffectedByChange(
  footprint: OperationFootprint,
  previous: Project,
  next: Project,
  changedFeatureIds: ReadonlySet<string>,
): boolean {
  if (footprint.bounds === null) return true
  const bounds = footprint.bounds

  if (footprint.readsWholeModel) {
    for (const id of changedFeatureIds) {
      // A stock-targeted operation has no target list, so no region can be a
      // mask for it: a region is as irrelevant as construction geometry,
      // while a to/from-role conversion still invalidates.
      const constructionExempt = roleExemptEverywhere(
        featureConstructionStatus(previous, id),
        featureConstructionStatus(next, id),
      )
      const regionExempt = roleExemptEverywhere(
        featureRegionStatus(previous, id),
        featureRegionStatus(next, id),
      )
      if (!constructionExempt && !regionExempt) return true
    }
    return false
  }

  for (const id of changedFeatureIds) {
    if (footprint.targetFeatureIds.has(id)) return true
    if (roleExemptEverywhere(
      featureConstructionStatus(previous, id),
      featureConstructionStatus(next, id),
    )) {
      continue
    }
    // A region that is not a direct target can only filter an operation whose
    // target list contains it: every generator splits exactly
    // `operation.target.featureIds` (`splitFeatureTargets`) and never scans
    // `project.features` for regions, so a change to a non-target region
    // cannot reach this operation. Requiring the role on every side where
    // the feature exists, with absence raising no objection, mirrors the
    // construction rule: converting a feature to or from a region changes
    // what the operation sees and must still invalidate, while an added or
    // removed region stays exempt. Targeted regions never get here — the
    // target check above returns first.
    if (
      roleExemptEverywhere(
        featureRegionStatus(previous, id),
        featureRegionStatus(next, id),
      )
      && !footprint.targetFeatureIds.has(id)
    ) {
      continue
    }
    const previousBounds = featureWorldBounds(previous, id)
    if (previousBounds === undefined) return true
    const nextBounds = featureWorldBounds(next, id)
    if (nextBounds === undefined) return true
    if (previousBounds !== null && boundsIntersect(previousBounds, bounds)) return true
    if (nextBounds !== null && boundsIntersect(nextBounds, bounds)) return true
  }
  return false
}

/** Union of profile bounds; `null` when `profiles` is empty. */
function unionProfileBounds(profiles: SketchProfile[]): Bounds2D | null {
  let union: Bounds2D | null = null
  for (const profile of profiles) {
    const profileBounds = getProfileBounds(profile)
    if (union === null) {
      union = {
        minX: profileBounds.minX,
        maxX: profileBounds.maxX,
        minY: profileBounds.minY,
        maxY: profileBounds.maxY,
      }
    } else {
      union.minX = Math.min(union.minX, profileBounds.minX)
      union.maxX = Math.max(union.maxX, profileBounds.maxX)
      union.minY = Math.min(union.minY, profileBounds.minY)
      union.maxY = Math.max(union.maxY, profileBounds.maxY)
    }
  }
  return union
}

/**
 * Whether `id` is construction geometry in `project`: `true`/`false` when the
 * row and its definition resolve, `null` when they do not (unknown). The
 * operation role lives on the definition, never on the instance row.
 */
function featureConstructionStatus(project: Project, id: string): boolean | null {
  const row = project.features.find((feature) => feature.id === id)
  if (!row) return null
  const definition = project.featureDefinitions[row.definitionId]
  if (!definition) return null
  return isConstruction(definition)
}

/**
 * Whether `id` is a region (machining mask) in `project`: `true`/`false` when
 * the row and its definition resolve, `null` when they do not (unknown). The
 * operation role lives on the definition, never on the instance row.
 */
function featureRegionStatus(project: Project, id: string): boolean | null {
  const row = project.features.find((feature) => feature.id === id)
  if (!row) return null
  const definition = project.featureDefinitions[row.definitionId]
  if (!definition) return null
  return isRegion(definition)
}

/**
 * Whether a machining-role exemption (construction or region) holds for one
 * feature across two snapshots, given its three-state role status on each
 * side: `true` = the feature holds the role, `false` = it does not,
 * `null` = it is absent on that side.
 *
 * The role must hold on every side where the feature exists, and absence
 * raises no objection:
 *
 * - present on both sides and holding the role on both → exempt;
 * - **added** or **removed** while holding the role → exempt — the S6b fix:
 *   the earlier "role on both sides" test never fired for an added feature
 *   (its `previous` status is `null`), so drawing a region or construction
 *   feature still regenerated everything;
 * - converted to or from the role → not exempt, in both directions;
 * - holding the role on neither side (both `false`, or absent on both) →
 *   not exempt — the caller falls through to the bbox check, which is safe.
 */
function roleExemptEverywhere(previousStatus: boolean | null, nextStatus: boolean | null): boolean {
  return previousStatus !== false
    && nextStatus !== false
    && (previousStatus === true || nextStatus === true)
}

/**
 * The world bbox of one feature in one snapshot: `null` when the feature does
 * not exist on that side (contributes nothing), `undefined` when it exists
 * but its bbox cannot be computed (missing definition, or a geometry kind
 * with no profiles) — the caller must invalidate, never guess.
 */
function featureWorldBounds(project: Project, id: string): Bounds2D | null | undefined {
  const row = project.features.find((feature) => feature.id === id)
  if (!row) return null
  const resolved = resolveFeatureRow(project, row)
  if (!resolved) return undefined
  const union = unionProfileBounds(getFeatureGeometryProfiles(resolved))
  // `null` means "no profiles" — the row exists but has no measurable
  // geometry, which is uncomputable, not absent.
  return union === null ? undefined : union
}

/** Inclusive: touching bounds count as intersecting. */
function boundsIntersect(a: Bounds2D, b: Bounds2D): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}
