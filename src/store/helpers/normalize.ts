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

import { clearImportedModelCaches } from '../../engine/importedMesh'
import { clearSTLTransformedGeometryCache } from '../../engine/csg'
import { copyBundledDefinitions } from '../../engine/gcode/definitions'
import { validateMachineDefinition } from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import { convertLength } from '../../utils/units'
import { defaultTool, inferFeatureKind, newProject, profileVertices } from '../../types/project'
import type { Clamp, Operation, Point, Project, SketchFeature, Tab, Tool } from '../../types/project'
import { normalizeTextFontId } from '../../text'
import { idNumericSuffix } from './ids'
import { isMachinable } from './featureRoles'
import { isImportedModelFeature } from './modelAssets'
import { fallbackOperationTarget, defaultOperationForTarget, isOperationTargetValid } from './operationDefaults'

export function normalizeAngleDegrees(angle: number): number {
  const normalized = angle % 360
  return normalized < 0 ? normalized + 360 : normalized
}

export function angleToPoint(angleDegrees: number): Point {
  const radians = (angleDegrees * Math.PI) / 180
  return {
    x: Math.cos(radians),
    y: Math.sin(radians),
  }
}

export function inferProfileOrientationAngle(profile: SketchFeature['sketch']['profile']): number {
  const vertices = profileVertices(profile)
  let bestDirection: Point | null = null
  let bestLength = 0

  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index]
    const end = vertices[(index + 1) % vertices.length]
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (length > bestLength) {
      bestLength = length
      bestDirection = { x: dx / length, y: dy / length }
    }
  }

  if (!bestDirection) {
    return 90
  }

  const xAxisAngle = Math.atan2(bestDirection.y, bestDirection.x) * (180 / Math.PI)
  return normalizeAngleDegrees(xAxisAngle + 90)
}

export function normalizeFeatureZRange(feature: SketchFeature): SketchFeature {
  const safeFeature = {
    ...feature,
    text: feature.kind === 'text' && feature.text
      ? {
        ...feature.text,
        text: feature.text.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s*\n+\s*/g, ' ').trim() || 'TEXT',
        fontId: normalizeTextFontId(feature.text.fontId, feature.text.style),
      }
      : null,
    sketch: {
      ...feature.sketch,
      orientationAngle: normalizeAngleDegrees(
        feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
      ),
      profile: {
        ...feature.sketch.profile,
        closed: feature.sketch.profile.closed ?? true,
      },
    },
    kind: feature.kind ?? inferFeatureKind(feature.sketch.profile),
    folderId: feature.folderId ?? null,
  }
  const { z_top, z_bottom } = safeFeature
  if (typeof z_top === 'number' && typeof z_bottom === 'number' && z_top < z_bottom) {
    return {
      ...safeFeature,
      z_top: z_bottom,
      z_bottom: z_top,
    }
  }

  return safeFeature
}

export function normalizeTool(tool: Tool, units: Project['meta']['units'], index: number): Tool {
  const defaults = defaultTool(units, index + 1)
  return {
    ...defaults,
    ...tool,
    vBitAngle: (tool.type ?? defaults.type) === 'v_bit' ? (tool.vBitAngle ?? 60) : null,
  }
}

export function dedupeProjectIds(project: Project): Project {
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

export function normalizeOperation(operation: Operation, project: Project, index: number): Operation {
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

export function normalizeClamp(clamp: Clamp, units: Project['meta']['units'], index: number): Clamp {
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

export function normalizeTab(tab: Tab, units: Project['meta']['units'], index: number): Tab {
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

export function normalizeMachineDefinitions(project: Project): {
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

export function syncFeatureTreeProject(project: Project): Project {
  const featureFolders = (project.featureFolders ?? []).map((folder) => ({
    ...folder,
    grouped: folder.grouped ?? false,
  }))
  const folderIdSet = new Set(featureFolders.map((folder) => folder.id))
  const features = project.features.map((feature) => (
    feature.folderId && !folderIdSet.has(feature.folderId)
      ? { ...feature, folderId: null }
      : feature
  ))

  const featureMap = new Map(features.map((feature) => [feature.id, feature]))
  const usedRootFeatures = new Set<string>()
  const usedFolders = new Set<string>()
  const normalizedTree: import('../../types/project').FeatureTreeEntry[] = []

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

export function syncStockFromSourceFeature(project: Project, featureId: string): Project {
  const stock = project.stock
  if (!stock.sourceFeature || stock.sourceFeatureId !== featureId) {
    return project
  }

  const updatedFeature = project.features.find((f) => f.id === featureId)
  if (updatedFeature) {
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

export function cloneProject(project: Project): Project {
  const cloned = structuredClone(project)
  cloned.modelAssets = project.modelAssets
  return cloned
}

export function instantiateProjectTemplate(template?: Project, name?: string): Project {
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

export function isFirstFeatureValid(features: SketchFeature[]): boolean {
  const firstMachiningFeature = features.find(isMachinable)
  if (!firstMachiningFeature) return true
  return firstMachiningFeature.operation === 'add' || isImportedModelFeature(firstMachiningFeature)
}
