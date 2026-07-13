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

import {
  defaultOrigin,
  type FeatureDefinition,
  type FeatureFolder,
  type FeatureInstance,
  type FeatureTreeEntry,
  type LocalConstraint,
  type MachineOrigin,
  type NamedDimension,
  type Operation,
  type PersistedImportedMesh,
  type Project,
  type ConstraintSegmentReference,
  type Stock,
  type Tool,
} from '../types/project'
import type { Units } from '../utils/units'
import { convertProjectUnits, convertToolUnits } from '../utils/units'
import { uniqueName } from './normalize'
import { decodeProjectFormat } from '../store/helpers/projectFormat'

export interface CamjInspection {
  /** Parsed source project. Always uses source units (not yet converted). */
  project: Project
  /** Ordered folder ids that are importable (at least one feature in the source). */
  folderIds: string[]
  /** Folder id → display name. */
  folderNames: Record<string, string>
  /** Folder id → number of features contained. */
  folderFeatureCount: Record<string, number>
  sourceUnits: Units
  /** True when source stock is derived from a feature (importable). */
  stockIsFeatureBased: boolean
  warnings: string[]
}

export interface MergeCamjFoldersInput {
  currentProject: Project
  sourceProject: Project
  selectedFolderIds: string[]
  /** When true and source stock is feature-based, replace current stock. */
  importStock?: boolean
}

export interface MergeCamjFoldersResult {
  project: Project
  createdFolderIds: string[]
  createdFeatureIds: string[]
  /** True when the source stock replaced the current stock. */
  stockReplaced: boolean
  warnings: string[]
}

/**
 * Parse a .camj file's text and return the source project plus a folder
 * inspection used to drive the import-selection UI. Throws on JSON parse
 * failure or if the document is missing required arrays.
 */
export function inspectCamjString(text: string): CamjInspection {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Failed to parse .camj file: invalid JSON.')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Failed to parse .camj file: not a project object.')
  }

  const candidate = parsed as Partial<Project>
  if (!Array.isArray(candidate.features) || !Array.isArray(candidate.featureFolders)) {
    throw new Error('Failed to parse .camj file: missing features or featureFolders.')
  }
  if (!candidate.meta || typeof candidate.meta !== 'object') {
    throw new Error('Failed to parse .camj file: missing meta.')
  }

  const { project, convertedLegacy, sourceVersion } = decodeProjectFormat(parsed)
  const sourceUnits: Units = project.meta.units === 'inch' ? 'inch' : 'mm'

  const featureCountByFolder = new Map<string, number>()
  for (const feature of project.features) {
    if (feature.folderId) {
      featureCountByFolder.set(feature.folderId, (featureCountByFolder.get(feature.folderId) ?? 0) + 1)
    }
  }

  const folderIds: string[] = []
  const folderNames: Record<string, string> = {}
  const folderFeatureCount: Record<string, number> = {}
  for (const folder of project.featureFolders) {
    const count = featureCountByFolder.get(folder.id) ?? 0
    if (count === 0) continue
    folderIds.push(folder.id)
    folderNames[folder.id] = folder.name
    folderFeatureCount[folder.id] = count
  }

  const stockIsFeatureBased = Boolean(
    project.stock && project.stock.sourceFeatureId && project.stock.sourceFeature,
  )

  return {
    project,
    folderIds,
    folderNames,
    folderFeatureCount,
    sourceUnits,
    stockIsFeatureBased,
    warnings: convertedLegacy
      ? [`Converted legacy file format ${sourceVersion ?? '1.0'} to 3.0 for import.`]
      : [],
  }
}

/**
 * Build a fresh-id generator that avoids collisions with both the existing
 * project state and ids reserved during the same merge call.
 */
function makeIdGenerator(initialUsedIds: Iterable<string>) {
  const used = new Set<string>(initialUsedIds)
  const counters: Record<string, number> = {}
  return function nextId(prefix: string): string {
    counters[prefix] = (counters[prefix] ?? 0) + 1
    let candidate = `${prefix}${String(counters[prefix]).padStart(4, '0')}`
    while (used.has(candidate)) {
      counters[prefix] += 1
      candidate = `${prefix}${String(counters[prefix]).padStart(4, '0')}`
    }
    used.add(candidate)
    return candidate
  }
}

function collectExistingIds(project: Project): Set<string> {
  return new Set([
    ...project.features.map((f) => f.id),
    ...Object.keys(project.featureDefinitions ?? {}),
    ...project.featureFolders.map((f) => f.id),
    ...project.tools.map((t) => t.id),
    ...project.operations.map((o) => o.id),
    ...project.tabs.map((t) => t.id),
    ...project.clamps.map((c) => c.id),
    ...Object.keys(project.dimensions ?? {}),
    ...Object.keys(project.modelAssets ?? {}),
  ])
}

function remapConstraint(
  constraint: LocalConstraint,
  featureIdMap: Map<string, string>,
): LocalConstraint | null {
  const remapSegmentReference = (reference: ConstraintSegmentReference): ConstraintSegmentReference | null => {
    if (reference.target.source === 'stock') return reference
    const mapped = featureIdMap.get(reference.target.featureId)
    if (!mapped) return null
    return {
      ...reference,
      target: { source: 'feature', featureId: mapped },
    }
  }

  const segmentIds = constraint.segment_ids.map((id) => featureIdMap.get(id) ?? id)
  const referencedFeatureIds = constraint.segment_ids.filter((id) => featureIdMap.has(id))
  if (referencedFeatureIds.length !== constraint.segment_ids.length) {
    return null
  }

  const next: LocalConstraint = { ...constraint, segment_ids: segmentIds }
  if (constraint.reference_feature_id) {
    const mapped = featureIdMap.get(constraint.reference_feature_id)
    if (!mapped) return null
    next.reference_feature_id = mapped
  }
  if (constraint.reference_intersection) {
    const a = remapSegmentReference(constraint.reference_intersection.a)
    const b = remapSegmentReference(constraint.reference_intersection.b)
    if (!a || !b) return null
    next.reference_intersection = { a, b }
  }
  return next
}

/**
 * Merge selected folders from a source .camj project into the current project.
 * Returns a new Project plus the ids that were created. The result is not yet
 * passed through syncFeatureTreeProject — the caller (store action) is
 * expected to run that.
 */
export function mergeCamjFolders(input: MergeCamjFoldersInput): MergeCamjFoldersResult {
  const { currentProject } = input
  const warnings: string[] = []

  const selectedFolderIdSet = new Set(input.selectedFolderIds)
  const wantsStockImport = Boolean(input.importStock)
  if (selectedFolderIdSet.size === 0 && !wantsStockImport) {
    return {
      project: currentProject,
      createdFolderIds: [],
      createdFeatureIds: [],
      stockReplaced: false,
      warnings: ['No folders selected for import.'],
    }
  }

  // 1. Convert source project to target units up front so all numeric values
  //    we copy are already in the right system.
  const sourceProject =
    input.sourceProject.meta.units === currentProject.meta.units
      ? input.sourceProject
      : convertProjectUnits(input.sourceProject, currentProject.meta.units)

  // 2. Identify features inside selected folders.
  const sourceFolderById = new Map(sourceProject.featureFolders.map((f) => [f.id, f]))
  const importedFeatures: FeatureInstance[] = []
  for (const feature of sourceProject.features) {
    if (feature.folderId && selectedFolderIdSet.has(feature.folderId)) {
      importedFeatures.push(feature)
    }
  }

  if (importedFeatures.length === 0 && !wantsStockImport) {
    return {
      project: currentProject,
      createdFolderIds: [],
      createdFeatureIds: [],
      stockReplaced: false,
      warnings: ['Selected folders contain no features.'],
    }
  }

  // 3. Set up id generator + remap tables.
  const usedIds = collectExistingIds(currentProject)
  const nextId = makeIdGenerator(usedIds)

  const folderIdMap = new Map<string, string>()
  const featureIdMap = new Map<string, string>()
  const dimensionIdMap = new Map<string, string>()
  const modelAssetIdMap = new Map<string, string>()
  const toolIdMap = new Map<string, string>()

  // Pre-allocate folder ids (preserve folder order from source).
  const orderedSelectedFolderIds = sourceProject.featureFolders
    .map((folder) => folder.id)
    .filter((id) => selectedFolderIdSet.has(id))

  // 4. Resolve unique names + new ids for folders.
  const existingFolderNames = currentProject.featureFolders.map((f) => f.name)
  const newFolders: FeatureFolder[] = []
  const reservedFolderNames: string[] = []
  for (const folderId of orderedSelectedFolderIds) {
    const sourceFolder = sourceFolderById.get(folderId)
    if (!sourceFolder) continue
    const newId = nextId('fd')
    folderIdMap.set(folderId, newId)
    const folderName = uniqueName(sourceFolder.name, [...existingFolderNames, ...reservedFolderNames])
    reservedFolderNames.push(folderName)
    newFolders.push({
      id: newId,
      name: folderName,
      collapsed: sourceFolder.collapsed,
      section: sourceFolder.section,
    })
  }

  // 5. Resolve features.
  // First pass: allocate ids, model assets, dimensions, and unique names.
  const existingFeatureNames = currentProject.features.map((f) => f.name)
  const reservedFeatureNames: string[] = []
  const reservedNewIds: Map<string, string> = new Map() // sourceFeatureId -> newFeatureId
  for (const feature of importedFeatures) {
    const newFeatureId = nextId('f')
    featureIdMap.set(feature.id, newFeatureId)
    reservedNewIds.set(feature.id, newFeatureId)
  }

  // Decide which named dimensions to bring across: dimensions referenced by
  // z_top/z_bottom of any imported feature.
  const referencedDimensionIds = new Set<string>()
  for (const feature of importedFeatures) {
    if (typeof feature.z_top === 'string') referencedDimensionIds.add(feature.z_top)
    if (typeof feature.z_bottom === 'string') referencedDimensionIds.add(feature.z_bottom)
  }
  const newDimensions: Record<string, NamedDimension> = {}
  for (const sourceDimId of referencedDimensionIds) {
    const sourceDim = sourceProject.dimensions?.[sourceDimId]
    if (!sourceDim) continue
    const newDimId = nextId('dim')
    dimensionIdMap.set(sourceDimId, newDimId)
    newDimensions[newDimId] = { ...sourceDim, id: newDimId }
  }

  const definitionIdsToImport = new Set(importedFeatures.map((feature) => feature.definitionId))
  if (wantsStockImport && sourceProject.stock.sourceFeature) {
    definitionIdsToImport.add(sourceProject.stock.sourceFeature.definitionId)
  }

  // Decide which model assets to bring across from imported definitions.
  const referencedMeshAssetIds = new Set<string>()
  for (const definitionId of definitionIdsToImport) {
    const meshAssetId = sourceProject.featureDefinitions[definitionId]?.stl?.meshAssetId
    if (meshAssetId) referencedMeshAssetIds.add(meshAssetId)
  }
  const newModelAssets: Record<string, PersistedImportedMesh> = {}
  for (const sourceAssetId of referencedMeshAssetIds) {
    const sourceMesh = sourceProject.modelAssets?.[sourceAssetId]
    if (!sourceMesh) continue
    const newAssetId = nextId('mesh')
    modelAssetIdMap.set(sourceAssetId, newAssetId)
    newModelAssets[newAssetId] = sourceMesh
  }

  // 6. Clone only referenced definitions, preserving shared-instance links.
  const definitionIdMap = new Map<string, string>()
  const mergedDefinitions: Record<string, FeatureDefinition> = { ...currentProject.featureDefinitions }
  for (const sourceDefId of definitionIdsToImport) {
    const sourceDef = sourceProject.featureDefinitions[sourceDefId]
    if (!sourceDef) {
      throw new Error(`Imported feature references missing definition ${sourceDefId}.`)
    }
    const newDefId = nextId('f-')
    definitionIdMap.set(sourceDefId, newDefId)
    const meshAssetId = sourceDef.stl?.meshAssetId
    mergedDefinitions[newDefId] = {
      ...sourceDef,
      id: newDefId,
      profile: {
        start: { ...sourceDef.profile.start },
        segments: sourceDef.profile.segments.map((segment) => ({ ...segment })),
        closed: sourceDef.profile.closed,
      },
      dimensions: sourceDef.dimensions.map((dimension) => ({ ...dimension })),
      text: sourceDef.text ? { ...sourceDef.text } : null,
      stl: sourceDef.stl
        ? {
            ...sourceDef.stl,
            meshAssetId: meshAssetId ? (modelAssetIdMap.get(meshAssetId) ?? meshAssetId) : undefined,
          }
        : null,
    }
  }

  // 6b. Build lightweight instances with remapped IDs and constraints.
  const newFeatures: FeatureInstance[] = []
  for (const feature of importedFeatures) {
    const newId = featureIdMap.get(feature.id)!
    const newDefinitionId = definitionIdMap.get(feature.definitionId)
    if (!newDefinitionId) throw new Error(`Imported feature references missing definition ${feature.definitionId}.`)
    const sourceFolderId = feature.folderId
    const featureName = uniqueName(feature.name, [...existingFeatureNames, ...reservedFeatureNames])
    reservedFeatureNames.push(featureName)
    const constraints: LocalConstraint[] = []
    for (const constraint of feature.constraints) {
      const remapped = remapConstraint(constraint, featureIdMap)
      if (remapped) constraints.push(remapped)
    }
    newFeatures.push({
      ...feature,
      id: newId,
      name: featureName,
      definitionId: newDefinitionId,
      transform: { ...feature.transform },
      constraints,
      folderId: sourceFolderId ? folderIdMap.get(sourceFolderId) ?? null : null,
      z_top: typeof feature.z_top === 'string' ? (dimensionIdMap.get(feature.z_top) ?? feature.z_top) : feature.z_top,
      z_bottom: typeof feature.z_bottom === 'string' ? (dimensionIdMap.get(feature.z_bottom) ?? feature.z_bottom) : feature.z_bottom,
    })
  }

  // 7. Decide which operations to import. Only operations whose target is
  //    'features' AND all target featureIds are inside the imported set.
  const importedFeatureSourceIds = new Set(importedFeatures.map((f) => f.id))
  const operationsToImport: Operation[] = []
  for (const operation of sourceProject.operations) {
    if (operation.target.source !== 'features') continue
    const targetIds = operation.target.featureIds
    if (targetIds.length === 0) continue
    if (!targetIds.every((id) => importedFeatureSourceIds.has(id))) continue
    operationsToImport.push(operation)
  }

  // 8. Decide which tools to import: any tool referenced by an imported
  //    operation's toolRef.
  const referencedToolIds = new Set<string>()
  for (const op of operationsToImport) {
    if (op.toolRef) referencedToolIds.add(op.toolRef)
  }
  const existingToolNames = currentProject.tools.map((t) => t.name)
  const reservedToolNames: string[] = []
  const newTools: Tool[] = []
  for (const sourceToolId of referencedToolIds) {
    const sourceTool = sourceProject.tools.find((t) => t.id === sourceToolId)
    if (!sourceTool) continue
    const newToolId = nextId('t')
    toolIdMap.set(sourceToolId, newToolId)
    const toolName = uniqueName(sourceTool.name, [...existingToolNames, ...reservedToolNames])
    reservedToolNames.push(toolName)
    const converted = convertToolUnits(sourceTool, currentProject.meta.units)
    newTools.push({ ...converted, id: newToolId, name: toolName })
  }

  // 9. Build new operations with remapped refs.
  const existingOperationNames = currentProject.operations.map((o) => o.name)
  const reservedOperationNames: string[] = []
  const newOperations: Operation[] = []
  for (const operation of operationsToImport) {
    const newOpId = nextId('op')
    const opName = uniqueName(operation.name, [...existingOperationNames, ...reservedOperationNames])
    reservedOperationNames.push(opName)
    const target = operation.target.source === 'features'
      ? {
          source: 'features' as const,
          featureIds: operation.target.featureIds.map((id) => featureIdMap.get(id) ?? id),
        }
      : operation.target
    const toolRef = operation.toolRef ? (toolIdMap.get(operation.toolRef) ?? null) : null
    newOperations.push({
      ...operation,
      id: newOpId,
      name: opName,
      target,
      toolRef,
    })
  }

  // 10. Optionally import stock from source when feature-based. The source
  //     project's MachineOrigin comes across verbatim (so any custom origin
  //     placement is preserved); if the source has no origin we fall back to
  //     defaultOrigin computed from the new stock's bounds.
  let nextStock: Stock = currentProject.stock
  let nextOrigin: MachineOrigin = currentProject.origin
  let stockReplaced = false
  if (wantsStockImport) {
    const srcStock = sourceProject.stock
    if (!srcStock?.sourceFeatureId || !srcStock.sourceFeature) {
      warnings.push('Source stock is not feature-based; stock import skipped.')
    } else {
      const newStockFeatureId = nextId('f')
      const newDefinitionId = definitionIdMap.get(srcStock.sourceFeature.definitionId)
      if (!newDefinitionId) {
        throw new Error(`Imported stock references missing definition ${srcStock.sourceFeature.definitionId}.`)
      }
      const newStockFeature: FeatureInstance = {
        ...srcStock.sourceFeature,
        id: newStockFeatureId,
        definitionId: newDefinitionId,
        transform: { ...srcStock.sourceFeature.transform },
        constraints: srcStock.sourceFeature.constraints.flatMap((constraint) => {
          const remapped = remapConstraint(constraint, featureIdMap)
          return remapped ? [remapped] : []
        }),
      }
      nextStock = {
        profile: srcStock.profile,
        thickness: srcStock.thickness,
        material: srcStock.material,
        color: srcStock.color,
        visible: srcStock.visible,
        origin: srcStock.origin,
        sourceFeatureId: newStockFeatureId,
        sourceFeature: newStockFeature,
      }
      nextOrigin = sourceProject.origin ?? defaultOrigin(nextStock)
      stockReplaced = true
    }
  }

  // 11. Compose merged project.
  const newTreeEntries: FeatureTreeEntry[] = newFolders.map((folder) => ({
    type: 'folder' as const,
    folderId: folder.id,
  }))

  const mergedProject: Project = {
    ...currentProject,
    meta: { ...currentProject.meta, modified: new Date().toISOString() },
    stock: nextStock,
    origin: nextOrigin,
    dimensions: { ...currentProject.dimensions, ...newDimensions },
    modelAssets: { ...currentProject.modelAssets, ...newModelAssets },
    featureDefinitions: mergedDefinitions,
    features: [...currentProject.features, ...newFeatures],
    featureFolders: [...currentProject.featureFolders, ...newFolders],
    featureTree: [...currentProject.featureTree, ...newTreeEntries],
    tools: [...currentProject.tools, ...newTools],
    operations: [...currentProject.operations, ...newOperations],
  }

  return {
    project: mergedProject,
    createdFolderIds: newFolders.map((f) => f.id),
    createdFeatureIds: newFeatures.map((f) => f.id),
    stockReplaced,
    warnings,
  }
}
