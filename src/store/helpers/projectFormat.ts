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
  circleProfile,
  defaultClampClearanceXY,
  defaultClampClearanceZ,
  defaultMaxTravelZ,
  defaultOperationClearanceZ,
  defaultOrigin,
  getStockBounds,
  IDENTITY_MATRIX,
  LATEST_PROJECT_VERSION,
} from '../../types/project'
import type {
  FeatureDefinition,
  FeatureInstance,
  Matrix2D,
  PersistedImportedMesh,
  Project,
  SketchFeature,
} from '../../types/project'
import { syncIdCounter } from './ids'
import { normalizeImportedModelStorage, pruneUnusedModelAssets } from './modelAssets'
import {
  dedupeProjectIds,
  normalizeClamp,
  normalizeFeatureDefinition,
  normalizeFeatureZRange,
  normalizeMachineDefinitions,
  normalizeOperation,
  normalizeTab,
  normalizeTool,
  syncFeatureTreeProject,
} from './normalize'
import { createFeatureInstance } from './featureDefinitions'
import { resolveFeatureRow } from './resolveFeatures'
import { normalizeBackdrop } from '../slices/backdropSlice'

export type LegacyFeatureRow = SketchFeature & {
  definitionId?: string
  transform?: Matrix2D
}

export type ProjectFormatInput = Omit<Project, 'features'> & {
  features: Array<FeatureInstance | LegacyFeatureRow>
}

export interface DecodedProjectFormat {
  project: Project
  sourceVersion: string | null
  convertedLegacy: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLegacyFeatureRow(feature: FeatureInstance | LegacyFeatureRow): feature is LegacyFeatureRow {
  return 'sketch' in feature
}

function isFiniteMatrix(value: unknown): value is Matrix2D {
  if (!isRecord(value)) return false
  return ['a', 'b', 'c', 'd', 'e', 'f'].every((key) => Number.isFinite(value[key]))
}

function isFinitePoint(value: unknown): boolean {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y)
}

function normalizeDefinition(id: string, value: unknown): FeatureDefinition {
  if (!isRecord(value)) {
    throw new Error(`Project definition ${id} is not an object.`)
  }
  if (!['rect', 'circle', 'ellipse', 'polygon', 'spline', 'composite', 'text', 'stl'].includes(String(value.kind))) {
    throw new Error(`Project definition ${id} has an invalid kind.`)
  }
  if (!['add', 'subtract', 'region', 'model', 'line', 'construction'].includes(String(value.operation))) {
    throw new Error(`Project definition ${id} has an invalid operation.`)
  }
  if (!isRecord(value.profile)
    || !isFinitePoint(value.profile.start)
    || !Array.isArray(value.profile.segments)
    || typeof value.profile.closed !== 'boolean') {
    throw new Error(`Project definition ${id} has an invalid profile.`)
  }
  for (const segment of value.profile.segments) {
    if (!isRecord(segment)
      || !['line', 'arc', 'circle', 'bezier'].includes(String(segment.type))
      || !isFinitePoint(segment.to)) {
      throw new Error(`Project definition ${id} has an invalid profile segment.`)
    }
    if ((segment.type === 'arc' || segment.type === 'circle') && !isFinitePoint(segment.center)) {
      throw new Error(`Project definition ${id} has an invalid arc or circle center.`)
    }
    if (segment.type === 'bezier'
      && (!isFinitePoint(segment.control1) || !isFinitePoint(segment.control2))) {
      throw new Error(`Project definition ${id} has invalid bezier controls.`)
    }
  }
  if (!Array.isArray(value.dimensions)) {
    throw new Error(`Project definition ${id} has invalid dimensions.`)
  }
  if (value.text !== undefined && value.text !== null && !isRecord(value.text)) {
    throw new Error(`Project definition ${id} has invalid text data.`)
  }
  if (value.stl !== undefined && value.stl !== null && !isRecord(value.stl)) {
    throw new Error(`Project definition ${id} has invalid STL data.`)
  }
  if (value.regionMaskMode !== undefined
    && value.regionMaskMode !== 'include'
    && value.regionMaskMode !== 'exclude') {
    throw new Error(`Project definition ${id} has an invalid region mask mode.`)
  }
  return normalizeFeatureDefinition({
    ...value,
    id,
  } as unknown as FeatureDefinition)
}

function normalizeLegacyFeature(
  feature: LegacyFeatureRow,
  modelAssets: Record<string, PersistedImportedMesh>,
): LegacyFeatureRow {
  const sketch = {
    ...feature.sketch,
    origin: feature.sketch.origin ?? { ...feature.sketch.profile.start },
    orientationAngle: feature.sketch.orientationAngle ?? 0,
    dimensions: feature.sketch.dimensions ?? [],
    constraints: feature.sketch.constraints ?? [],
  }
  let upgradedFeature: LegacyFeatureRow = { ...feature, sketch }
  if (feature.kind === 'circle' && sketch.profile.segments.length === 4) {
    const firstArc = sketch.profile.segments[0]
    if (firstArc.type === 'arc') {
      const cx = firstArc.center.x
      const cy = firstArc.center.y
      const radius = Math.hypot(sketch.profile.start.x - cx, sketch.profile.start.y - cy)
      upgradedFeature = {
        ...upgradedFeature,
        sketch: { ...sketch, profile: circleProfile(cx, cy, radius) },
      }
    }
  }

  if (
    !sketch.profile.closed
    && upgradedFeature.operation !== 'line'
    && upgradedFeature.operation !== 'model'
    && upgradedFeature.operation !== 'region'
    && upgradedFeature.operation !== 'construction'
  ) {
    upgradedFeature = { ...upgradedFeature, operation: 'line' }
  }

  return normalizeFeatureZRange({
    ...upgradedFeature,
    stl: normalizeImportedModelStorage(upgradedFeature.id, upgradedFeature.stl, modelAssets),
  })
}

function normalizeInstance(feature: FeatureInstance, definitions: Record<string, FeatureDefinition>): FeatureInstance {
  const raw = feature as unknown as Record<string, unknown>
  const duplicatedField = ['sketch', 'kind', 'operation', 'regionMaskMode', 'text', 'stl']
    .find((field) => field in raw)
  if (duplicatedField) {
    throw new Error(`Project feature ${feature.id || '(unnamed)'} contains definition-owned field ${duplicatedField}.`)
  }
  if (typeof feature.id !== 'string' || feature.id.length === 0 || typeof feature.name !== 'string') {
    throw new Error('Project feature has an invalid identity or name.')
  }
  if (!feature.definitionId || !definitions[feature.definitionId]) {
    throw new Error(`Project feature ${feature.id || '(unnamed)'} references a missing definition.`)
  }
  if (!isFiniteMatrix(feature.transform)) {
    throw new Error(`Project feature ${feature.id || '(unnamed)'} has an invalid transform.`)
  }
  if (!Array.isArray(feature.constraints)) {
    throw new Error(`Project feature ${feature.id || '(unnamed)'} has invalid constraints.`)
  }
  if ((typeof feature.z_top !== 'number' && typeof feature.z_top !== 'string')
    || (typeof feature.z_bottom !== 'number' && typeof feature.z_bottom !== 'string')
    || (typeof feature.z_top === 'number' && !Number.isFinite(feature.z_top))
    || (typeof feature.z_bottom === 'number' && !Number.isFinite(feature.z_bottom))) {
    throw new Error(`Project feature ${feature.id || '(unnamed)'} has an invalid Z range.`)
  }
  if ((feature.folderId !== null && typeof feature.folderId !== 'string')
    || typeof feature.visible !== 'boolean'
    || typeof feature.locked !== 'boolean') {
    throw new Error(`Project feature ${feature.id || '(unnamed)'} has invalid instance metadata.`)
  }
  const normalized: FeatureInstance = {
    id: feature.id,
    name: feature.name,
    definitionId: feature.definitionId,
    transform: { ...feature.transform },
    constraints: feature.constraints.map((constraint) => ({ ...constraint })),
    z_top: feature.z_top,
    z_bottom: feature.z_bottom,
    folderId: feature.folderId,
    visible: feature.visible,
    locked: feature.locked,
  }
  if (
    typeof normalized.z_top === 'number'
    && typeof normalized.z_bottom === 'number'
    && normalized.z_top < normalized.z_bottom
  ) {
    return { ...normalized, z_top: normalized.z_bottom, z_bottom: normalized.z_top }
  }
  return normalized
}

function assertProjectEnvelope(input: unknown): asserts input is ProjectFormatInput {
  if (!isRecord(input)) throw new Error('Failed to load project: not a project object.')
  if (!isRecord(input.meta)) throw new Error('Failed to load project: missing metadata.')
  if (!Array.isArray(input.features)) throw new Error('Failed to load project: missing features.')
  if (!Array.isArray(input.tools) || !Array.isArray(input.operations)) {
    throw new Error('Failed to load project: missing tools or operations.')
  }
  if (!isRecord(input.stock)) throw new Error('Failed to load project: missing stock.')
}

/** Decode 1.0/2.0/2.1 baked rows or validate a lightweight 3.0 project. */
export function decodeProjectFormat(input: unknown): DecodedProjectFormat {
  assertProjectEnvelope(input)
  const sourceVersion = typeof input.version === 'string' ? input.version : null
  const convertedLegacy = sourceVersion === null
    || sourceVersion === '1.0'
    || sourceVersion === '2.0'
    || sourceVersion === '2.1'
  const sourceFeature = (input.stock as unknown as Record<string, unknown>).sourceFeature
  const hasLegacyRows = input.features.some(isLegacyFeatureRow)
    || (sourceFeature !== null && sourceFeature !== undefined && isRecord(sourceFeature) && 'sketch' in sourceFeature)
  if (!convertedLegacy && hasLegacyRows) {
    throw new Error(`Project format ${sourceVersion ?? '(missing)'} contains legacy baked feature geometry.`)
  }
  return {
    project: normalizeProject(input),
    sourceVersion,
    convertedLegacy,
  }
}

/** Normalize a decoded project without ever placing resolved geometry in features. */
export function normalizeProject(input: ProjectFormatInput): Project {
  const modelAssets: Record<string, PersistedImportedMesh> = { ...(input.modelAssets ?? {}) }
  const rawDefinitions = isRecord(input.featureDefinitions)
    ? input.featureDefinitions as Record<string, FeatureDefinition>
    : {}
  let featureDefinitions: Record<string, FeatureDefinition> = Object.fromEntries(
    Object.entries(rawDefinitions).map(([id, definition]) => {
      const normalized = normalizeDefinition(id, definition)
      return [id, {
        ...normalized,
        id,
        stl: normalizeImportedModelStorage(id, normalized.stl, modelAssets) ?? null,
      }]
    }),
  )

  const features: FeatureInstance[] = input.features.map((feature) => {
    if (!isLegacyFeatureRow(feature)) {
      return normalizeInstance(feature, featureDefinitions)
    }

    const normalized = normalizeLegacyFeature(feature, modelAssets)
    const definitionId = feature.definitionId ?? feature.id
    if (!featureDefinitions[definitionId]) {
      featureDefinitions = {
        ...featureDefinitions,
        [definitionId]: normalizeFeatureDefinition({
          id: definitionId,
          kind: normalized.kind,
          profile: normalized.sketch.profile,
          dimensions: normalized.sketch.dimensions.map((dimension) => ({ ...dimension })),
          text: normalized.text ? { ...normalized.text } : null,
          stl: normalized.stl ? { ...normalized.stl } : null,
          operation: normalized.operation,
          regionMaskMode: normalized.regionMaskMode,
        }),
      }
    }
    const transform = feature.transform ?? IDENTITY_MATRIX
    if (!isFiniteMatrix(transform)) {
      throw new Error(`Legacy project feature ${feature.id || '(unnamed)'} has an invalid transform.`)
    }
    return createFeatureInstance(normalized, definitionId, transform)
  })

  const rawSourceFeature = (input.stock as unknown as Record<string, unknown>).sourceFeature as
    | FeatureInstance
    | LegacyFeatureRow
    | null
    | undefined
  let sourceFeature: FeatureInstance | null | undefined = rawSourceFeature == null
    ? rawSourceFeature
    : undefined
  if (rawSourceFeature) {
    if (isLegacyFeatureRow(rawSourceFeature)) {
      const normalized = normalizeLegacyFeature(rawSourceFeature, modelAssets)
      const definitionId = rawSourceFeature.definitionId ?? rawSourceFeature.id
      if (!featureDefinitions[definitionId]) {
        featureDefinitions = {
          ...featureDefinitions,
          [definitionId]: normalizeFeatureDefinition({
            id: definitionId,
            kind: normalized.kind,
            profile: normalized.sketch.profile,
            dimensions: normalized.sketch.dimensions.map((dimension) => ({ ...dimension })),
            text: normalized.text ? { ...normalized.text } : null,
            stl: normalized.stl ? { ...normalized.stl } : null,
            operation: normalized.operation,
            regionMaskMode: normalized.regionMaskMode,
          }),
        }
      }
      sourceFeature = createFeatureInstance(
        normalized,
        definitionId,
        rawSourceFeature.transform ?? IDENTITY_MATRIX,
      )
    } else {
      sourceFeature = normalizeInstance(rawSourceFeature, featureDefinitions)
    }
  }

  const authoritativeProject: Project = {
    ...input,
    version: LATEST_PROJECT_VERSION,
    modelAssets,
    featureDefinitions,
    features,
    stock: {
      ...input.stock,
      sourceFeature,
    },
    annotations: input.annotations ?? [],
    featureFolders: input.featureFolders ?? [],
    featureTree: input.featureTree ?? [],
    tabs: input.tabs ?? [],
    clamps: input.clamps ?? [],
  }
  const machines = normalizeMachineDefinitions(authoritativeProject)
  const meta = {
    ...authoritativeProject.meta,
    showFeatureInfo: authoritativeProject.meta.showFeatureInfo ?? true,
    showDimensions: authoritativeProject.meta.showDimensions ?? true,
    copyMode: authoritativeProject.meta.copyMode ?? 'reference',
    maxTravelZ: authoritativeProject.meta.maxTravelZ ?? defaultMaxTravelZ(authoritativeProject.meta.units),
    operationClearanceZ: authoritativeProject.meta.operationClearanceZ ?? defaultOperationClearanceZ(authoritativeProject.meta.units),
    clampClearanceXY: authoritativeProject.meta.clampClearanceXY ?? defaultClampClearanceXY(authoritativeProject.meta.units),
    clampClearanceZ: authoritativeProject.meta.clampClearanceZ ?? defaultClampClearanceZ(authoritativeProject.meta.units),
    machineDefinitions: machines.machineDefinitions,
    selectedMachineId: machines.selectedMachineId,
  }

  const stockBounds = getStockBounds(authoritativeProject.stock)
  const legacyDefaultOrigin = authoritativeProject.origin
    && authoritativeProject.origin.name === 'Origin'
    && authoritativeProject.origin.x === stockBounds.minX
    && authoritativeProject.origin.y === stockBounds.minY
    && authoritativeProject.origin.z === authoritativeProject.stock.thickness
  const deduped = dedupeProjectIds({
    ...authoritativeProject,
    meta,
    stock: {
      ...authoritativeProject.stock,
      profile: {
        ...authoritativeProject.stock.profile,
        closed: authoritativeProject.stock.profile.closed ?? true,
      },
    },
    tools: authoritativeProject.tools.map((tool, index) => normalizeTool(tool, authoritativeProject.meta.units, index)),
    tabs: authoritativeProject.tabs.map((tab, index) => normalizeTab(tab, authoritativeProject.meta.units, index)),
    clamps: authoritativeProject.clamps.map((clamp, index) => normalizeClamp(clamp, authoritativeProject.meta.units, index)),
    origin: authoritativeProject.origin
      ? (legacyDefaultOrigin ? defaultOrigin(authoritativeProject.stock) : authoritativeProject.origin)
      : defaultOrigin(authoritativeProject.stock),
  })
  const normalizedBase = syncFeatureTreeProject(deduped)
  const prunedProject = pruneUnusedModelAssets({
    ...normalizedBase,
    backdrop: normalizeBackdrop(authoritativeProject.backdrop, normalizedBase),
    operations: authoritativeProject.operations.map((operation, index) => normalizeOperation(operation, normalizedBase, index)),
  })
  const resolvedStockSource = prunedProject.stock.sourceFeature
    ? resolveFeatureRow(prunedProject, prunedProject.stock.sourceFeature)
    : null
  const project = resolvedStockSource
    ? {
        ...prunedProject,
        stock: {
          ...prunedProject.stock,
          profile: resolvedStockSource.sketch.profile,
          thickness: typeof resolvedStockSource.z_top === 'number'
            ? resolvedStockSource.z_top
            : prunedProject.stock.thickness,
        },
      }
    : prunedProject
  syncIdCounter(project)
  return project
}
