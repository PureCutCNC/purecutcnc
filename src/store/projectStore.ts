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

import { create } from 'zustand'
import { copyBundledDefinitions } from '../engine/gcode/definitions'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import {
  clearImportedModelCaches,
} from '../engine/importedMesh'
import { clearSTLTransformedGeometryCache } from '../engine/csg'
import { uniqueName } from '../import'
import {
  defaultOrigin,
  defaultMaxTravelZ,
  defaultOperationClearanceZ,
  defaultClampClearanceXY,
  defaultClampClearanceZ,
  getStockBounds,
  inferFeatureKind,
  newProject,
  circleProfile,
} from '../types/project'
import type {
  Clamp,
  FeatureOperation,
  FeatureTreeEntry,
  Operation,
  Project,
  SketchProfile,
  SketchFeature,
  PersistedImportedMesh,
  Tab,
} from '../types/project'
import type { OpenProfileEndpoint } from './types'
import { convertLength } from '../utils/units'
import {
  clonePoint,
  pointsEqual,
} from './helpers/geometry'
import {
  cloneSegment,
  endPointForOpenProfile,
  normalizeEditableProfileClosure,
  orientOpenProfileFromEndpoint,
  orientOpenProfileTowardEndpoint,
  type ProfileBreakResult,
} from './helpers/profileEdit'
import {
  insertDerivedFeaturesAfterSources,
  insertDerivedFeatureTreeEntries,
  normalizeDerivedFeatureNameStem,
  previewOffsetFeatures as previewOffsetFeaturesWithFactory,
  type DerivedFeatureGroup,
} from './helpers/derivedFeatures'
import { idNumericSuffix, nextUniqueGeneratedId, syncIdCounter } from './helpers/ids'
import {
  normalizeFeatureZRange,
  normalizeTool,
} from './helpers/normalize'
import {
  transformProfile,
} from './helpers/transform'
import { isImportedModelFeature, normalizeImportedModelStorage, pruneUnusedModelAssets } from './helpers/modelAssets'
import { fallbackOperationTarget, defaultOperationForTarget, isOperationTargetValid } from './helpers/operationDefaults'
import { createPendingAddSlice } from './slices/pendingAddSlice'
import { createPendingActionsSlice } from './slices/pendingActionsSlice'
import { createPendingCompletionSlice } from './slices/pendingCompletionSlice'
import { createSelectionSlice, sanitizeSelection } from './slices/selectionSlice'
import { createDimensionsSlice } from './slices/dimensionsSlice'
import { createDimensionToolSlice } from './slices/dimensionToolSlice'
import { createFeatureSlice } from './slices/featureSlice'
import { createFeatureGeometrySlice } from './slices/featureGeometrySlice'
import { createConstraintsSlice } from './slices/constraintsSlice'
import { createTreeVisibilitySlice } from './slices/treeVisibilitySlice'
import { createToolsSlice } from './slices/toolsSlice'
import { createClampsSlice } from './slices/clampsSlice'
import { createTabsSlice } from './slices/tabsSlice'
import { createBackdropSlice, normalizeBackdrop } from './slices/backdropSlice'
import { createMachineDefsSlice } from './slices/machineDefsSlice'
import { createOperationsSlice } from './slices/operationsSlice'
import { createImportMergeSlice } from './slices/importMergeSlice'
import { createProjectLifecycleSlice } from './slices/projectLifecycleSlice'
import { createHistorySlice } from './slices/historySlice'
import { createWorkpieceSlice } from './slices/workpieceSlice'
import {
  propagateConstraintsOnTranslate,
  propagateConstraintsOnRotate,
  rederiveConstraintGeometry,
  validateConstraintsOnFeature,
} from '../sketch/constraintSolver'
import type { ProjectStore } from './types'

export function createDerivedFeature(
  project: Project,
  baseFeature: SketchFeature,
  profile: SketchProfile,
  operation: FeatureOperation,
  name: string,
): SketchFeature {
  return normalizeFeatureZRange({
    id: nextUniqueGeneratedId(project, 'f'),
    name,
    kind: inferFeatureKind(profile),
    folderId: baseFeature.folderId,
    sketch: {
      profile,
      origin: clonePoint(baseFeature.sketch.origin),
      orientationAngle: baseFeature.sketch.orientationAngle,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: baseFeature.z_top,
    z_bottom: baseFeature.z_bottom,
    visible: true,
    locked: false,
  })
}

export function previewOffsetFeatures(project: Project, featureIds: string[], distance: number): SketchFeature[] {
  return previewOffsetFeaturesWithFactory(project, featureIds, distance, createDerivedFeature)
}

export function joinOpenProfiles(
  profile: SketchProfile,
  endpoint: OpenProfileEndpoint,
  targetProfile: SketchProfile,
  targetEndpoint: OpenProfileEndpoint,
): SketchProfile | null {
  if (profile.closed || targetProfile.closed || profile.segments.length === 0 || targetProfile.segments.length === 0) {
    return null
  }

  const leading = orientOpenProfileTowardEndpoint(profile, endpoint)
  const trailing = orientOpenProfileFromEndpoint(targetProfile, targetEndpoint)
  const leadingEnd = endPointForOpenProfile(leading)
  const trailingStart = trailing.start
  const segments = leading.segments.map(cloneSegment)

  if (!pointsEqual(leadingEnd, trailingStart)) {
    segments.push({ type: 'line', to: clonePoint(trailingStart) })
  }

  segments.push(...trailing.segments.map(cloneSegment))

  return normalizeEditableProfileClosure({
    ...profile,
    start: clonePoint(leading.start),
    segments,
    closed: false,
  })
}

function clearStaleConstraints(features: SketchFeature[], movedIds: Set<string>): SketchFeature[] {
  // Policy: when the OWNER is moved/edited, update constraint value to new distance.
  // Do NOT delete constraints — they persist as persistent dimensions.
  if (movedIds.size === 0) return features
  let anyChanged = false
  const featureById = new Map(features.map((f) => [f.id, f]))
  const next = features.map((feature) => {
    if (!movedIds.has(feature.id)) return feature
    // This feature was moved — update constraint values to reflect new distances
    const updatedConstraints = feature.sketch.constraints.map((c) => {
      if (c.type !== 'fixed_distance') return c
      // Issue 11: Never update invalid constraints — keep them frozen at last valid position
      if (c.is_invalid) return c
      const refFeatureId = c.reference_feature_id ?? c.segment_ids[0]
      const refFeature = refFeatureId ? featureById.get(refFeatureId) : null
      // Re-derive geometry to get current positions
      const result = rederiveConstraintGeometry(
        feature.sketch.profile,
        refFeature?.sketch.profile ?? null,
        c,
      )
      if (result && result.isValid) {
        // Compute new distance from re-derived geometry
        let newValue: number | undefined
        if (result.referenceSegment) {
          const { a, b } = result.referenceSegment
          const sx = b.x - a.x
          const sy = b.y - a.y
          const segLen = Math.hypot(sx, sy)
          if (segLen > 1e-12) {
            const nx = -sy / segLen
            const ny = sx / segLen
            const rawSigned = (result.anchorPoint.x - a.x) * nx + (result.anchorPoint.y - a.y) * ny
            // Issue 14: Preserve the original sign — only update the magnitude.
            // This prevents the side from flipping when the feature drifts near the segment.
            const originalSign = (c.value ?? 0) >= 0 ? 1 : -1
            newValue = originalSign * Math.abs(rawSigned)
          }
        } else if (result.referencePoint) {
          newValue = Math.hypot(
            result.anchorPoint.x - result.referencePoint.x,
            result.anchorPoint.y - result.referencePoint.y,
          )
        }
        if (newValue !== undefined && Math.abs((c.value ?? 0) - newValue) > 1e-9) {
          anyChanged = true
          return {
            ...c,
            value: newValue,
            anchor_point: result.anchorPoint,
            reference_point: result.referencePoint,
            reference_segment: result.referenceSegment,
            is_invalid: false,
            error_message: undefined,
          }
        }
        // Update cached coords even if value unchanged
        return {
          ...c,
          anchor_point: result.anchorPoint,
          reference_point: result.referencePoint,
          reference_segment: result.referenceSegment,
          is_invalid: false,
          error_message: undefined,
        }
      }
      // No semantic fields — fall back to legacy coordinate update
      if (!c.anchor_point) return c
      let newValue: number | undefined
      if (c.reference_segment) {
        const { a, b } = c.reference_segment
        const sx = b.x - a.x
        const sy = b.y - a.y
        const segLen = Math.hypot(sx, sy)
        if (segLen > 1e-12) {
          const nx = -sy / segLen
          const ny = sx / segLen
          const rawSigned = (c.anchor_point.x - a.x) * nx + (c.anchor_point.y - a.y) * ny
          const originalSign = (c.value ?? 0) >= 0 ? 1 : -1
          newValue = originalSign * Math.abs(rawSigned)
        }
      } else if (c.reference_point) {
        newValue = Math.hypot(
          c.anchor_point.x - c.reference_point.x,
          c.anchor_point.y - c.reference_point.y,
        )
      }
      if (newValue !== undefined && Math.abs((c.value ?? 0) - newValue) > 1e-9) {
        anyChanged = true
        return { ...c, value: newValue }
      }
      return c
    })
    if (updatedConstraints.some((c, i) => c !== feature.sketch.constraints[i])) {
      anyChanged = true
      return { ...feature, sketch: { ...feature.sketch, constraints: updatedConstraints } }
    }
    return feature
  })
  return anyChanged ? next : features
}

export function syncFeatureTreeProject(project: Project): Project {
  const featureFolders = project.featureFolders ?? []
  const folderIdSet = new Set(featureFolders.map((folder) => folder.id))
  const features = project.features.map((feature) => (
    feature.folderId && !folderIdSet.has(feature.folderId)
      ? { ...feature, folderId: null }
      : feature
  ))

  const featureMap = new Map(features.map((feature) => [feature.id, feature]))
  const usedRootFeatures = new Set<string>()
  const usedFolders = new Set<string>()
  const normalizedTree: FeatureTreeEntry[] = []

  for (const entry of project.featureTree ?? []) {
    if (entry.type === 'folder') {
      if (folderIdSet.has(entry.folderId) && !usedFolders.has(entry.folderId)) {
        normalizedTree.push(entry)
        usedFolders.add(entry.folderId)
      }
      continue
    }

    const feature = featureMap.get(entry.featureId)
    if (!feature || feature.folderId !== null || usedRootFeatures.has(entry.featureId)) {
      continue
    }

    normalizedTree.push(entry)
    usedRootFeatures.add(entry.featureId)
  }

  for (const folder of featureFolders) {
    if (!usedFolders.has(folder.id)) {
      normalizedTree.push({ type: 'folder', folderId: folder.id })
      usedFolders.add(folder.id)
    }
  }

  for (const feature of features) {
    if (feature.folderId === null && !usedRootFeatures.has(feature.id)) {
      normalizedTree.push({ type: 'feature', featureId: feature.id })
      usedRootFeatures.add(feature.id)
    }
  }

  const orderedFeatures: SketchFeature[] = []
  const pushedFeatureIds = new Set<string>()

  for (const entry of normalizedTree) {
    if (entry.type === 'folder') {
      for (const feature of features) {
        if (feature.folderId === entry.folderId && !pushedFeatureIds.has(feature.id)) {
          orderedFeatures.push(feature)
          pushedFeatureIds.add(feature.id)
        }
      }
      continue
    }

    const feature = featureMap.get(entry.featureId)
    if (feature && !pushedFeatureIds.has(feature.id)) {
      orderedFeatures.push(feature)
      pushedFeatureIds.add(feature.id)
    }
  }

  for (const feature of features) {
    if (!pushedFeatureIds.has(feature.id)) {
      orderedFeatures.push({ ...feature, folderId: null })
    }
  }

  return {
    ...project,
    features: orderedFeatures,
    featureFolders,
    featureTree: normalizedTree,
  }
}

/**
 * When a feature that serves as the stock source is modified, sync the stock
 * profile and thickness to match. Returns the updated project, or the original
 * if the featureId does not match the stock source.
 */
export function syncStockFromSourceFeature(project: Project, featureId: string): Project {
  const stock = project.stock
  if (!stock.sourceFeature || stock.sourceFeatureId !== featureId) {
    return project
  }

  // Find the updated source feature (it may be in features temporarily during sketch edit)
  const updatedFeature = project.features.find((f) => f.id === featureId)
  if (updatedFeature) {
    // Feature was temporarily restored for editing; update sourceFeature copy.
    // Use the feature's profile directly — it's already in world coordinates.
    const syncedStock = {
      ...stock,
      sourceFeature: updatedFeature,
      profile: updatedFeature.sketch.profile,
      thickness: typeof updatedFeature.z_top === 'number' ? updatedFeature.z_top : stock.thickness,
    }
    return {
      ...project,
      stock: syncedStock,
    }
  }

  // Feature is not in features array — sync from stock.sourceFeature directly
  const source = stock.sourceFeature
  return {
    ...project,
    stock: {
      ...stock,
      profile: source.sketch.profile,
      thickness: typeof source.z_top === 'number' ? source.z_top : stock.thickness,
    },
  }
}

function dedupeProjectIds(project: Project): Project {
  let localCounter = [
    ...project.features.map((feature) => idNumericSuffix(feature.id)),
    ...project.tools.map((tool) => idNumericSuffix(tool.id)),
    ...project.operations.map((operation) => idNumericSuffix(operation.id)),
    ...project.tabs.map((tab) => idNumericSuffix(tab.id)),
    ...project.clamps.map((clamp) => idNumericSuffix(clamp.id)),
  ].reduce((max, value) => Math.max(max, value), 0) + 1

  const nextLocalId = (prefix: string) => `${prefix}${String(localCounter++).padStart(4, '0')}`

  const seenFeatureIds = new Set<string>()
  const features = project.features.map((feature) => {
    if (!seenFeatureIds.has(feature.id)) {
      seenFeatureIds.add(feature.id)
      return feature
    }

    const nextId = nextLocalId('f')
    return {
      ...feature,
      id: nextId,
    }
  })

  const seenToolIds = new Set<string>()
  const tools = project.tools.map((tool) => {
    if (!seenToolIds.has(tool.id)) {
      seenToolIds.add(tool.id)
      return tool
    }

    const nextId = nextLocalId('t')
    return {
      ...tool,
      id: nextId,
    }
  })

  const seenOperationIds = new Set<string>()
  const operations = project.operations.map((operation) => {
    if (!seenOperationIds.has(operation.id)) {
      seenOperationIds.add(operation.id)
      return {
        ...operation,
      }
    }

    const nextId = nextLocalId('op')
    return {
      ...operation,
      id: nextId,
    }
  })

  const seenClampIds = new Set<string>()
  const clamps = project.clamps.map((clamp) => {
    if (!seenClampIds.has(clamp.id)) {
      seenClampIds.add(clamp.id)
      return { ...clamp }
    }

    const nextId = nextLocalId('cl')
    return {
      ...clamp,
      id: nextId,
    }
  })

  const seenTabIds = new Set<string>()
  const tabs = project.tabs.map((tab) => {
    if (!seenTabIds.has(tab.id)) {
      seenTabIds.add(tab.id)
      return { ...tab }
    }

    const nextId = nextLocalId('tb')
    return {
      ...tab,
      id: nextId,
    }
  })

  return {
    ...project,
    features,
    tools,
    operations,
    tabs,
    clamps,
  }
}

function normalizeOperation(operation: Operation, project: Project, index: number): Operation {
  const fallbackTarget = fallbackOperationTarget(project, operation.kind)
  const defaults = defaultOperationForTarget(project, operation.kind, 'rough', fallbackTarget, index)
  const normalized = {
    ...defaults,
    ...operation,
    description: operation.description ?? '',
    machiningOrder: operation.machiningOrder ?? 'level_first',
    waterlineAdaptiveRefinement: operation.waterlineAdaptiveRefinement ?? true,
    waterlineMicroStepover: operation.waterlineMicroStepover ?? 0,
    waterlineRefinementThreshold: operation.waterlineRefinementThreshold ?? 0,
    waterlineMaxRingsPerBand: operation.waterlineMaxRingsPerBand ?? 0,
    waterlineTipStepdown: operation.waterlineTipStepdown ?? 0,
  }

  if (!isOperationTargetValid(project, normalized.kind, normalized.target)) {
    return {
      ...normalized,
      target: fallbackTarget,
    }
  }

  return normalized
}

function normalizeClamp(clamp: Clamp, units: Project['meta']['units'], index: number): Clamp {
  const defaultSize = convertLength(12, 'mm', units)
  const defaultHeight = convertLength(8, 'mm', units)
  return {
    id: clamp.id || `cl${index + 1}`,
    name: clamp.name || `Clamp ${index + 1}`,
    type: clamp.type ?? 'step_clamp',
    x: clamp.x ?? 0,
    y: clamp.y ?? 0,
    w: Math.max(clamp.w ?? defaultSize, convertLength(0.1, 'mm', units)),
    h: Math.max(clamp.h ?? defaultSize, convertLength(0.1, 'mm', units)),
    height: Math.max(clamp.height ?? defaultHeight, convertLength(0.1, 'mm', units)),
    visible: clamp.visible ?? true,
  }
}

function normalizeTab(tab: Tab, units: Project['meta']['units'], index: number): Tab {
  const defaultSize = convertLength(6, 'mm', units)
  const defaultBottom = 0
  const defaultTop = convertLength(3, 'mm', units)
  const zBottom = tab.z_bottom ?? defaultBottom
  const zTop = tab.z_top ?? defaultTop
  return {
    id: tab.id || `tb${index + 1}`,
    name: tab.name || `Tab ${index + 1}`,
    x: tab.x ?? 0,
    y: tab.y ?? 0,
    w: Math.max(tab.w ?? defaultSize, convertLength(0.1, 'mm', units)),
    h: Math.max(tab.h ?? defaultSize, convertLength(0.1, 'mm', units)),
    z_top: Math.max(zTop, zBottom),
    z_bottom: Math.min(zTop, zBottom),
    visible: tab.visible ?? true,
  }
}

function normalizeMachineDefinitions(project: Project): {
  machineDefinitions: MachineDefinition[]
  selectedMachineId: string | null
} {
  const legacyMeta = project.meta as Project['meta'] & {
    machineId?: string | null
    customMachineDefinition?: MachineDefinition | null
  }

  const rawDefinitions = Array.isArray(project.meta.machineDefinitions)
    ? project.meta.machineDefinitions
    : null

  if (!rawDefinitions) {
    const machineDefinitions = copyBundledDefinitions()
    let selectedMachineId: string | null = legacyMeta.machineId ?? null

    if (legacyMeta.customMachineDefinition) {
      const customDefinition = validateMachineDefinition({
        ...legacyMeta.customMachineDefinition,
        builtin: false,
      })
      machineDefinitions.push(customDefinition)
      selectedMachineId = customDefinition.id
    }

    return {
      machineDefinitions,
      selectedMachineId: machineDefinitions.some((definition) => definition.id === selectedMachineId)
        ? selectedMachineId
        : null,
    }
  }

  const definitions: MachineDefinition[] = []
  const seenIds = new Set<string>()
  for (const rawDefinition of rawDefinitions) {
    try {
      const definition = validateMachineDefinition(rawDefinition)
      if (seenIds.has(definition.id)) {
        continue
      }
      seenIds.add(definition.id)
      definitions.push(definition)
    } catch {
      continue
    }
  }

  const selectedMachineId = project.meta.selectedMachineId ?? null

  return {
    machineDefinitions: definitions,
    selectedMachineId: definitions.some((definition) => definition.id === selectedMachineId)
      ? selectedMachineId
      : null,
  }
}

export function normalizeProject(project: Project): Project {
  const modelAssets: Record<string, PersistedImportedMesh> = { ...(project.modelAssets ?? {}) }
  // Migration: convert 4-arc circles to native circle segments
  const upgradedFeatures = project.features.map((feature) => {
    let upgradedFeature = feature
    if (feature.kind === 'circle' && feature.sketch.profile.segments.length === 4) {
      const { profile } = feature.sketch
      const firstArc = profile.segments[0]
      if (firstArc.type === 'arc') {
        const cx = firstArc.center.x
        const cy = firstArc.center.y
        const r = Math.hypot(profile.start.x - cx, profile.start.y - cy)
        upgradedFeature = {
          ...feature,
          sketch: {
            ...feature.sketch,
            profile: circleProfile(cx, cy, r),
          },
        }
      }
    }
    // Migration: convert open profiles from 'subtract'/'add' to 'line' operation
    // (projects saved before the 'line' type was introduced)
    if (!feature.sketch.profile.closed && upgradedFeature.operation !== 'line' && upgradedFeature.operation !== 'model' && upgradedFeature.operation !== 'region') {
      upgradedFeature = {
        ...upgradedFeature,
        operation: 'line',
      }
    }
    return {
      ...upgradedFeature,
      stl: normalizeImportedModelStorage(upgradedFeature.id, upgradedFeature.stl, modelAssets),
    }
  })

  const normalizedMachines = normalizeMachineDefinitions(project)
  const meta = {
    ...project.meta,
    showFeatureInfo: project.meta.showFeatureInfo ?? true,
    showDimensions: project.meta.showDimensions ?? true,
    maxTravelZ: project.meta.maxTravelZ ?? defaultMaxTravelZ(project.meta.units),
    operationClearanceZ: project.meta.operationClearanceZ ?? defaultOperationClearanceZ(project.meta.units),
    clampClearanceXY: project.meta.clampClearanceXY ?? defaultClampClearanceXY(project.meta.units),
    clampClearanceZ: project.meta.clampClearanceZ ?? defaultClampClearanceZ(project.meta.units),
    machineDefinitions: normalizedMachines.machineDefinitions,
    selectedMachineId: normalizedMachines.selectedMachineId,
  }

  const stockBounds = getStockBounds(project.stock)
  const legacyDefaultOrigin =
    project.origin
    && project.origin.name === 'Origin'
    && project.origin.x === stockBounds.minX
    && project.origin.y === stockBounds.minY
    && project.origin.z === project.stock.thickness

  const normalizedBase = syncFeatureTreeProject(dedupeProjectIds({
    ...project,
    meta,
    modelAssets,
    annotations: project.annotations ?? [],
    stock: {
      ...project.stock,
      profile: {
        ...project.stock.profile,
        closed: project.stock.profile.closed ?? true,
      },
    },
    features: upgradedFeatures.map(normalizeFeatureZRange),
    featureFolders: project.featureFolders ?? [],
    featureTree: project.featureTree ?? [],
    tools: project.tools.map((tool, index) => normalizeTool(tool, project.meta.units, index)),
    tabs: (project.tabs ?? []).map((tab, index) => normalizeTab(tab, project.meta.units, index)),
    clamps: (project.clamps ?? []).map((clamp, index) => normalizeClamp(clamp, project.meta.units, index)),
    origin: project.origin
      ? (legacyDefaultOrigin ? defaultOrigin(project.stock) : project.origin)
      : defaultOrigin(project.stock),
  }))

  const normalizedProject = pruneUnusedModelAssets({
    ...normalizedBase,
    backdrop: normalizeBackdrop(project.backdrop, normalizedBase),
    operations: project.operations.map((operation, index) => normalizeOperation(operation, normalizedBase, index)),
  })

  syncIdCounter(normalizedProject)
  return normalizedProject
}

export function cloneProject(project: Project): Project {
  const cloned = structuredClone(project)
  cloned.modelAssets = project.modelAssets
  return cloned
}

function instantiateProjectTemplate(template?: Project, name?: string): Project {
  const now = new Date().toISOString()

  if (!template) {
    return newProject(name)
  }

  const cloned = cloneProject(template)
  return {
    ...cloned,
    meta: {
      ...cloned.meta,
      name: name?.trim() || 'Untitled',
      created: now,
      modified: now,
    },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    features: [],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [],
    operations: [],
    tabs: [],
    clamps: [],
    ai_history: [],
  }
}

export function clearProjectMemoryCaches(): void {
  clearImportedModelCaches()
  clearSTLTransformedGeometryCache()
}

export function projectsEqual(a: Project, b: Project): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ============================================================
// Rule: the first 2.5D feature must be 'add'.
// Imported STL model features are standalone 3D model targets and may be the
// only feature in a project, so they are exempt from the base-solid rule.
// ============================================================

export function isFirstFeatureValid(features: SketchFeature[]): boolean {
  const firstMachiningFeature = features.find((feature) => feature.operation !== 'region')
  if (!firstMachiningFeature) return true
  return firstMachiningFeature.operation === 'add' || isImportedModelFeature(firstMachiningFeature)
}

// ============================================================
// Store implementation
// ============================================================

// ---------------------------------------------------------------------------
// Auto-dirty helper
// Wraps Zustand's set so any patch that changes `project` also sets
// `dirty: true`, unless the patch explicitly provides a `dirty` value.
// ---------------------------------------------------------------------------
type SetFn = (
  update: Partial<ProjectStore> | ((state: ProjectStore) => Partial<ProjectStore>)
) => void

function withAutoDirty(rawSet: SetFn): SetFn {
  return (update) => {
    if (typeof update === 'function') {
      rawSet((state) => {
        const patch = update(state)
        if ('project' in patch && patch.project !== state.project && !('dirty' in patch)) {
          return { ...patch, dirty: true }
        }
        return patch
      })
    } else {
      if ('project' in update && !('dirty' in update)) {
        rawSet({ ...update, dirty: true })
      } else {
        rawSet(update)
      }
    }
  }
}

export const useProjectStore = create<ProjectStore>((rawSet, get) => {
  const set = withAutoDirty(rawSet)
  const applyProfileBreak = (
    featureId: string,
    resolveBreak: (profile: SketchProfile) => ProfileBreakResult | null,
  ) => set((s) => {
    const feature = s.project.features.find((entry) => entry.id === featureId) ?? null
    if (!feature || feature.locked) {
      return {}
    }

    const result = resolveBreak(feature.sketch.profile)
    if (!result) {
      return {}
    }

    const splitFeature = result.splitProfile
      ? createDerivedFeature(
          s.project,
          feature,
          result.splitProfile,
          feature.operation,
          uniqueName(`${normalizeDerivedFeatureNameStem(feature.name)} Split`, s.project.features.map((entry) => entry.name)),
        )
      : null

    const baseFeatures = s.project.features.map((entry) => {
      if (entry.id !== featureId) {
        return entry
      }

      return {
        ...entry,
        kind: ['text', 'stl'].includes(entry.kind) ? entry.kind : inferFeatureKind(result.profile),
        sketch: {
          ...entry.sketch,
          profile: result.profile,
        },
      }
    })
    const createdGroups: DerivedFeatureGroup[] = splitFeature ? [{ sourceId: featureId, features: [splitFeature] }] : []
    let nextProject = syncFeatureTreeProject({
      ...s.project,
      features: splitFeature
        ? insertDerivedFeaturesAfterSources(baseFeatures, createdGroups, new Set())
        : baseFeatures,
      featureTree: splitFeature
        ? insertDerivedFeatureTreeEntries(s.project.featureTree, baseFeatures, createdGroups, new Set())
        : s.project.featureTree,
      meta: { ...s.project.meta, modified: new Date().toISOString() },
    })

    nextProject = syncStockFromSourceFeature(nextProject, featureId)
    if (projectsEqual(nextProject, s.project)) {
      return {}
    }

    return {
      project: nextProject,
      selection: {
        ...s.selection,
        selectedFeatureId: featureId,
        selectedFeatureIds: [featureId],
        selectedNode: { type: 'feature' as const, featureId },
        activeControl: null,
      },
      history: s.history.transactionStart
        ? s.history
        : {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
    }
  })

  return {
  project: normalizeProject(newProject()),
  creationTarget: 'feature',
  backdropImageLoading: false,
  filePath: null,
  lastExportPath: null,
  lastModelExportPath: null,
  dirty: false,
  projectLoading: false,
  projectKey: 0,
  pendingConstraint: null,
  history: {
    past: [],
    future: [],
    transactionStart: null,
  },
  ...createSelectionSlice(set, get, {
    cloneProject,
    normalizeProject,
  }),
  ...createPendingActionsSlice(set),
  ...createPendingCompletionSlice(set, get, {
    cloneProject,
    projectsEqual,
    clearStaleConstraints,
    propagateConstraintsOnTranslate: (features, offsets) =>
      propagateConstraintsOnTranslate(features, offsets, { transformProfile }),
    propagateConstraintsOnRotate: (features, rotations) =>
      propagateConstraintsOnRotate(features, rotations, { transformProfile }),
    validateAllConstraints: (features) => {
      const byId = new Map(features.map((f) => [f.id, f]))
      return features.map((f) => {
        if (f.sketch.constraints.every((c) => c.type !== 'fixed_distance')) return f
        return validateConstraintsOnFeature(f, byId)
      })
    },
    previewOffsetFeatures,
    syncFeatureTreeProject,
    createDerivedFeature,
  }),
  ...createPendingAddSlice(set, get, {
    cloneProject,
    syncFeatureTreeProject,
  }),
  ...createDimensionsSlice(set, get, { cloneProject }),
  ...createDimensionToolSlice(set, get),
  ...createToolsSlice(set, get, { cloneProject, projectsEqual }),
  ...createClampsSlice(set, get, { cloneProject, projectsEqual }),
  ...createTabsSlice(set, get, { cloneProject, projectsEqual }),
  ...createBackdropSlice(set, get, { cloneProject, projectsEqual }),
  ...createMachineDefsSlice(set, get, { cloneProject, projectsEqual }),
  ...createOperationsSlice(set, get, {
    cloneProject,
    projectsEqual,
    syncFeatureTreeProject,
  }),
  ...createImportMergeSlice(set, get, {
    cloneProject,
    syncFeatureTreeProject,
  }),
  ...createFeatureSlice(set, get, {
    cloneProject,
    syncFeatureTreeProject,
    projectsEqual,
    createDerivedFeature,
    syncStockFromSourceFeature,
  }),
  ...createFeatureGeometrySlice(set, get, {
    cloneProject,
    projectsEqual,
    syncFeatureTreeProject,
    syncStockFromSourceFeature,
    joinOpenProfiles,
    inferFeatureKind,
    clearStaleConstraints,
    applyProfileBreak,
  }),
  ...createConstraintsSlice(set, get, {
    cloneProject,
  }),
  ...createTreeVisibilitySlice(set, get, { cloneProject, projectsEqual }),
  ...createProjectLifecycleSlice(set, get, {
    rawSet,
    cloneProject,
    projectsEqual,
    normalizeProject,
    instantiateProjectTemplate,
    clearProjectMemoryCaches,
  }),
  ...createHistorySlice(set, get, {
    cloneProject,
    projectsEqual,
    normalizeProject,
  }),
  ...createWorkpieceSlice(set, get, {
    cloneProject,
    projectsEqual,
    syncFeatureTreeProject,
  }),

  }
})

const repairedInitialProject = normalizeProject(useProjectStore.getState().project)
if (!projectsEqual(repairedInitialProject, useProjectStore.getState().project)) {
  useProjectStore.setState((state) => ({
    project: repairedInitialProject,
    selection: sanitizeSelection(repairedInitialProject, state.selection),
  }))
}
