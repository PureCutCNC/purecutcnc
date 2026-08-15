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
 *
 * Every comparison is identity-first: deep compares run only for values whose
 * identity already differs, so an unchanged project stays O(n) with no
 * serialization. Deep comparison reuses `projectsEqual`
 * (`src/store/helpers/normalize.ts`) rather than a second deep-equal.
 */

import type { FeatureInstance, Project } from '../../types/project'
import { projectsEqual } from '../../store/helpers/normalize'

// Compare only the fields toolpath generation reads through the resolver
// (`resolveFeatureRow`, src/store/helpers/resolveFeatures.ts): definitionId,
// transform, constraints, z_top, z_bottom. Excluded (display-only):
//   name, visible, locked, folderId
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
 *   (`src/engine/toolpaths/geometry.ts`).
 * - `project.meta.units` — feeds `normalizeToolForProject`
 *   (`src/engine/toolpaths/geometry.ts`).
 * - `project.modelAssets` — STL payloads behind imported-model features.
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
    || previous.meta.units !== next.meta.units
    || (previous.dimensions !== next.dimensions && !projectsEqual(previous.dimensions, next.dimensions))
    || (previous.modelAssets !== next.modelAssets && !projectsEqual(previous.modelAssets, next.modelAssets))

  return { changedFeatureIds, invalidatesEveryOperation }
}
