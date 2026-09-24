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

// Commit and discard a sheet nest (issue #846, step 2 of #741). Pure project →
// project functions; the store slice wraps each in one history entry.

import type { NestPlacement } from '../../engine/nesting'
import type { FeatureFolder, FeatureInstance, NestRecord, NestSettings, Project } from '../../types/project'
import { buildTransformedCopiedFeatures } from './copyFeatures'
import { createFeatureInstance, gcOrphanedDefinitions } from './featureDefinitions'
import { sectionForOperation } from './featureRoles'
import { nextUniqueGeneratedId } from './ids'
import { multiplyMatrix } from './instanceTransforms'
import { uniqueFolderName } from './naming'
import { constraintReference, nestPlacementMatrix } from './nestPart'
import { syncFeatureTreeProject } from './normalize'
import { resolveFeatureInstance, type ResolvedSketchFeature } from './resolveFeatures'

export interface ApplyNestPart {
  /** The part's instances (see `resolveNestParts`). */
  featureIds: string[]
  /** Parts on the sheet, originals included, as asked for. */
  quantity: number
}

export interface ApplyNestInput {
  parts: ApplyNestPart[]
  /** Packer output; `partId` is the index into `parts`. */
  placements: NestPlacement[]
  settings: NestSettings
  /**
   * An existing nest to replace in the same step. The placements must have
   * been computed on the project with that nest discarded.
   */
  replaceNestId?: string
}

export interface ApplyNestResult {
  project: Project
  nestId: string
  copyIds: string[]
}

/**
 * Mints linked copies for the placements and records the nest. Unless the
 * originals are kept in place, each part's placement 0 moves that part's
 * originals (#741 decision 3). Every copy joins each operation that targets
 * its source (decision 5). Returns null when nothing would change.
 */
export function applyNestToProject(current: Project, input: ApplyNestInput): ApplyNestResult | null {
  const project = input.replaceNestId ? discardNestFromProject(current, input.replaceNestId) ?? current : current
  const partSources = input.parts.map((part) => part.featureIds
    .map((id) => resolveFeatureInstance(project, id))
    .filter((feature): feature is ResolvedSketchFeature => feature !== null))
  if (partSources.some((sources, index) => sources.length === 0 || sources.length !== input.parts[index].featureIds.length)) {
    return null
  }

  const placementsOf = (partIndex: number) => input.placements.filter((placement) => placement.partId === String(partIndex))
  const originalPlacements = input.parts.map((_, index) => (
    input.settings.keepOriginals ? null : placementsOf(index).find((placement) => placement.copyIndex === 0) ?? null
  ))
  const copyPlacements = input.parts.map((_, index) => placementsOf(index).filter((placement) => placement !== originalPlacements[index]))
  if (originalPlacements.every((placement) => placement === null) && copyPlacements.every((list) => list.length === 0)) return null

  const nestId = nextUniqueGeneratedId(project, 'nest')
  const folderId = nextUniqueGeneratedId(project, 'fd')
  const nestNumber = (project.nests?.length ?? 0) + 1
  const folder: FeatureFolder = {
    id: folderId,
    name: uniqueFolderName(`Nest ${nestNumber}`, project.featureFolders),
    collapsed: true,
    section: 'features',
    grouped: false,
  }

  const copiesBySource = new Map<string, string[]>()
  const instances: FeatureInstance[] = []
  let existing = [...project.features]
  partSources.forEach((sources, partIndex) => {
    const matrices = copyPlacements[partIndex].map(nestPlacementMatrix)
    if (matrices.length === 0) return
    const partCopies = new Map<string, FeatureInstance[]>()
    for (const source of sources) {
      const created = buildTransformedCopiedFeatures([source], existing, matrices, project.featureDefinitions, 'reference')
      // The nest folder sits in the features section; copies of regions or
      // construction stay at the root of their own section.
      const inFolder = sectionForOperation(source.operation) === 'features'
      const rows = created.map((feature) => createFeatureInstance(
        { ...feature, folderId: inFolder ? folderId : null },
        feature.definitionId,
        feature.transform,
      ))
      partCopies.set(source.id, rows)
      copiesBySource.set(source.id, rows.map((row) => row.id))
      instances.push(...rows)
      existing = [...existing, ...rows]
    }
    // A copy's constraints still name the originals; point references within
    // the part at the sibling copy of the same placement so no copy is ever
    // measured from (and re-solved toward) a part elsewhere on the sheet.
    for (const rows of partCopies.values()) {
      rows.forEach((row, placementIndex) => {
        row.constraints = row.constraints.map((constraint) => {
          const reference = constraintReference(constraint)
          const sibling = reference ? partCopies.get(reference)?.[placementIndex]?.id : undefined
          if (!sibling) return constraint
          return {
            ...constraint,
            ...(constraint.reference_feature_id ? { reference_feature_id: sibling } : {}),
            segment_ids: constraint.type === 'fixed_distance'
              ? [sibling, ...constraint.segment_ids.slice(1)]
              : constraint.segment_ids,
          }
        })
      })
    }
  })
  const copyIds = instances.map((row) => row.id)

  const moveOf = new Map<string, ReturnType<typeof nestPlacementMatrix>>()
  input.parts.forEach((part, index) => {
    const placement = originalPlacements[index]
    if (placement) part.featureIds.forEach((id) => moveOf.set(id, nestPlacementMatrix(placement)))
  })
  const movedOriginals: NestRecord['movedOriginals'] = []
  const features = project.features.map((feature) => {
    const matrix = moveOf.get(feature.id)
    if (!matrix) return feature
    movedOriginals.push({ featureId: feature.id, transform: { ...feature.transform } })
    return { ...feature, transform: multiplyMatrix(matrix, feature.transform) }
  })

  const operations = project.operations.map((operation) => {
    if (operation.target.source !== 'features') return operation
    const added = operation.target.featureIds.flatMap((id) => copiesBySource.get(id) ?? [])
    if (added.length === 0) return operation
    return { ...operation, target: { ...operation.target, featureIds: [...operation.target.featureIds, ...added] } }
  })

  const record: NestRecord = {
    id: nestId,
    name: folder.name,
    folderId: copyIds.length > 0 ? folderId : null,
    parts: input.parts.map((part) => ({ sourceIds: [...part.featureIds], quantity: part.quantity })),
    copyIds,
    movedOriginals,
    settings: { ...input.settings, rotations: [...input.settings.rotations] },
  }

  const next = syncFeatureTreeProject({
    ...project,
    features: [...features, ...instances],
    featureFolders: copyIds.length > 0 ? [...project.featureFolders, folder] : project.featureFolders,
    operations,
    nests: [...(project.nests ?? []), record],
    meta: { ...project.meta, modified: new Date().toISOString() },
  })
  return { project: next, nestId, copyIds }
}

/**
 * Removes a nest's copies from the project and every operation target, puts
 * moved originals back, and drops the record. The nest folder goes too once
 * nothing else lives in it. Returns null for an unknown nest.
 */
export function discardNestFromProject(project: Project, nestId: string): Project | null {
  const record = project.nests?.find((nest) => nest.id === nestId)
  if (!record) return null
  const copies = new Set(record.copyIds)
  const restored = new Map(record.movedOriginals.map((entry) => [entry.featureId, entry.transform]))

  const features = project.features
    .filter((feature) => !copies.has(feature.id))
    .map((feature) => {
      const transform = restored.get(feature.id)
      return transform ? { ...feature, transform: { ...transform } } : feature
    })
  const operations = project.operations.map((operation) => {
    if (operation.target.source !== 'features') return operation
    const featureIds = operation.target.featureIds.filter((id) => !copies.has(id))
    return featureIds.length === operation.target.featureIds.length
      ? operation
      : { ...operation, target: { ...operation.target, featureIds } }
  })
  const folderStillUsed = features.some((feature) => feature.folderId === record.folderId)
  const featureFolders = record.folderId && !folderStillUsed
    ? project.featureFolders.filter((folder) => folder.id !== record.folderId)
    : project.featureFolders
  const nests = (project.nests ?? []).filter((nest) => nest.id !== nestId)

  const next: Project = {
    ...project,
    features,
    featureFolders,
    featureTree: project.featureTree.filter((entry) => !(entry.type === 'feature' && copies.has(entry.featureId))),
    featureDefinitions: gcOrphanedDefinitions(features, project.featureDefinitions, project.stock.sourceFeature).definitions,
    operations,
    meta: { ...project.meta, modified: new Date().toISOString() },
  }
  if (nests.length > 0) next.nests = nests
  else delete next.nests
  return syncFeatureTreeProject(next)
}
