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
  loadImportedTriangleMesh,
  normalizeImportedMeshForStorage,
  serializeImportedMesh,
  type ImportedModelFormat,
} from '../engine/importedMesh'
import { clearSTLTransformedGeometryCache } from '../engine/csg'
import { isProfileDegenerate, uniqueName } from '../import'
import {
  type Segment,
  defaultStock,
  defaultOrigin,
  defaultGrid,
  defaultTool,
  defaultMaxTravelZ,
  defaultOperationClearanceZ,
  defaultClampClearanceXY,
  defaultClampClearanceZ,
  getStockBounds,
  inferFeatureKind,
  newProject,
  profileVertices,
  rectProfile,
  circleProfile,
  stockFromFeature,
  type TextFeatureData,
} from '../types/project'
import type {
  BackdropImage,
  Clamp,
  FeatureOperation,
  FeatureFolder,
  FeatureTreeEntry,
  Operation,
  OperationKind,
  OperationPass,
  OperationTarget,
  Point,
  Project,
  SketchProfile,
  SketchFeature,
  PersistedImportedMesh,
  STLFeatureData,
  Tab,
  Tool,
} from '../types/project'
import type { OpenProfileEndpoint } from './types'
import { convertProjectUnits } from '../utils/units'
import { convertLength } from '../utils/units'
import {
  featureHasClosedGeometry,
  generateTextShapes,
  getTextFrameProfile,
  type TextToolConfig,
} from '../text'
import {
  addPoint,
  clampNumber,
  clonePoint,
  crossPoint,
  dotPoint,
  normalizePoint,
  pointLength,
  pointsEqual,
  scalePoint,
  subtractPoint,
} from './helpers/geometry'
import {
  applyLineCornerFillet,
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
import { idNumericSuffix, nextPlacementSession, nextUniqueGeneratedId, syncIdCounter } from './helpers/ids'
import {
  angleToPoint,
  inferProfileOrientationAngle,
  normalizeAngleDegrees,
  normalizeFeatureZRange,
  normalizeTool,
} from './helpers/normalize'
import { createPendingAddSlice } from './slices/pendingAddSlice'
import { createPendingActionsSlice } from './slices/pendingActionsSlice'
import { createPendingCompletionSlice } from './slices/pendingCompletionSlice'
import { createSelectionSlice, emptySelection, sanitizeSelection } from './slices/selectionSlice'
import { createDimensionsSlice } from './slices/dimensionsSlice'
import { createDimensionToolSlice } from './slices/dimensionToolSlice'
import { createFeatureSlice } from './slices/featureSlice'
import { createFeatureGeometrySlice } from './slices/featureGeometrySlice'
import { createConstraintsSlice } from './slices/constraintsSlice'
import { createToolsSlice } from './slices/toolsSlice'
import { createClampsSlice } from './slices/clampsSlice'
import { createTabsSlice } from './slices/tabsSlice'
import { createBackdropSlice, normalizeBackdrop } from './slices/backdropSlice'
import { createMachineDefsSlice } from './slices/machineDefsSlice'
import { createOperationsSlice } from './slices/operationsSlice'
import { createImportMergeSlice } from './slices/importMergeSlice'
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

function translatePoint(point: Point, dx: number, dy: number): Point {
  return { x: point.x + dx, y: point.y + dy }
}

function translateProfile(profile: SketchFeature['sketch']['profile'], dx: number, dy: number): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: translatePoint(profile.start, dx, dy),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc' || segment.type === 'circle') {
        return {
          ...segment,
          to: translatePoint(segment.to, dx, dy),
          center: translatePoint(segment.center, dx, dy),
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: translatePoint(segment.to, dx, dy),
          control1: translatePoint(segment.control1, dx, dy),
          control2: translatePoint(segment.control2, dx, dy),
        }
      }

      return {
        ...segment,
        to: translatePoint(segment.to, dx, dy),
      }
    }),
  }
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

export function transformProfile(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc' || segment.type === 'circle') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          center: transformPoint(segment.center),
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          control1: transformPoint(segment.control1),
          control2: transformPoint(segment.control2),
        }
      }

      return {
        ...segment,
        to: transformPoint(segment.to),
      }
    }),
  }
}

function transformStlFeatureData(
  stl: STLFeatureData | null | undefined,
  transformPoint: (point: Point) => Point,
): STLFeatureData | null | undefined {
  if (!stl?.silhouettePaths) return stl
  return {
    ...stl,
    silhouettePaths: stl.silhouettePaths.map((path) => path.map(transformPoint)),
  }
}

function modelAssetIdForFeature(featureId: string): string {
  return `model-asset-${featureId}`
}

export function normalizeImportedModelStorage(
  featureId: string,
  stl: STLFeatureData | null | undefined,
  modelAssets: Record<string, PersistedImportedMesh>,
): STLFeatureData | null | undefined {
  if (!stl) return stl
  if (stl.meshAssetId && modelAssets[stl.meshAssetId]) {
    const { mesh, fileData, filePath, ...rest } = stl
    return rest
  }

  const transientMesh = stl.mesh
  if (transientMesh) {
    const meshAssetId = stl.meshAssetId ?? modelAssetIdForFeature(featureId)
    modelAssets[meshAssetId] = transientMesh
    const { mesh, fileData, filePath, ...rest } = stl
    return {
      ...rest,
      meshAssetId,
      scale: stl.scale ?? 1,
      axisSwap: 'none',
    }
  }

  if (!stl.fileData) return stl

  const format: ImportedModelFormat = stl.format ?? 'stl'
  const mesh = loadImportedTriangleMesh(format, stl.fileData, stl.axisSwap ?? 'none')
  if (!mesh) return stl

  const normalizedMesh = normalizeImportedMeshForStorage(mesh, stl.scale ?? 1)
  const meshAssetId = stl.meshAssetId ?? modelAssetIdForFeature(featureId)
  modelAssets[meshAssetId] = serializeImportedMesh(normalizedMesh, format)
  return {
    ...stl,
    format,
    meshAssetId,
    filePath: undefined,
    fileData: undefined,
    mesh: undefined,
    scale: 1,
    axisSwap: 'none',
  }
}

export function pruneUnusedModelAssets(project: Project): Project {
  const usedAssetIds = new Set(
    project.features
      .map((feature) => feature.stl?.meshAssetId ?? null)
      .filter((id): id is string => id !== null),
  )
  const nextAssets: Record<string, PersistedImportedMesh> = {}
  for (const [id, asset] of Object.entries(project.modelAssets ?? {})) {
    if (usedAssetIds.has(id)) {
      nextAssets[id] = asset
    }
  }
  if (Object.keys(nextAssets).length === Object.keys(project.modelAssets ?? {}).length) {
    return project
  }
  return { ...project, modelAssets: nextAssets }
}

function arcToBezierSegments(start: Point, segment: Extract<Segment, { type: 'arc' }>): Array<Extract<Segment, { type: 'bezier' }>> {
  const startAngle = Math.atan2(start.y - segment.center.y, start.x - segment.center.x)
  const endAngle = Math.atan2(segment.to.y - segment.center.y, segment.to.x - segment.center.x)
  const radius = Math.hypot(start.x - segment.center.x, start.y - segment.center.y)

  let sweep = endAngle - startAngle
  if (segment.clockwise && sweep > 0) {
    sweep -= Math.PI * 2
  } else if (!segment.clockwise && sweep < 0) {
    sweep += Math.PI * 2
  }

  const segmentCount = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
  const step = sweep / segmentCount
  const result: Array<Extract<Segment, { type: 'bezier' }>> = []

  for (let index = 0; index < segmentCount; index += 1) {
    const angle0 = startAngle + step * index
    const angle1 = angle0 + step
    const p0 = {
      x: segment.center.x + Math.cos(angle0) * radius,
      y: segment.center.y + Math.sin(angle0) * radius,
    }
    const p3 = {
      x: segment.center.x + Math.cos(angle1) * radius,
      y: segment.center.y + Math.sin(angle1) * radius,
    }
    const tangent0 = { x: -Math.sin(angle0), y: Math.cos(angle0) }
    const tangent1 = { x: -Math.sin(angle1), y: Math.cos(angle1) }
    const handleScale = (4 / 3) * Math.tan(step / 4) * radius

    result.push({
      type: 'bezier',
      control1: {
        x: p0.x + tangent0.x * handleScale,
        y: p0.y + tangent0.y * handleScale,
      },
      control2: {
        x: p3.x - tangent1.x * handleScale,
        y: p3.y - tangent1.y * handleScale,
      },
      to: p3,
    })
  }

  return result
}

function transformProfileAffine(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  const nextSegments: Segment[] = []
  let current = profile.start

  for (const segment of profile.segments) {
    if (segment.type === 'arc') {
      const beziers = arcToBezierSegments(current, segment)
      for (const bezier of beziers) {
        nextSegments.push({
          type: 'bezier',
          control1: transformPoint(bezier.control1),
          control2: transformPoint(bezier.control2),
          to: transformPoint(bezier.to),
        })
      }
    } else if (segment.type === 'bezier') {
      nextSegments.push({
        ...segment,
        control1: transformPoint(segment.control1),
        control2: transformPoint(segment.control2),
        to: transformPoint(segment.to),
      })
    } else {
      nextSegments.push({
        ...segment,
        to: transformPoint(segment.to),
      })
    }

    current = segment.to
  }

  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: nextSegments,
  }
}

function rotatePointAround(point: Point, origin: Point, angle: number): Point {
  const local = subtractPoint(point, origin)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return {
    x: origin.x + local.x * cos - local.y * sin,
    y: origin.y + local.x * sin + local.y * cos,
  }
}

function mirrorDirectionAcrossAxis(direction: Point, axis: Point): Point {
  const projected = scalePoint(axis, dotPoint(direction, axis))
  return subtractPoint(scalePoint(projected, 2), direction)
}

function mirrorAngleAcrossLine(angleDegrees: number, lineStart: Point, lineEnd: Point): number | null {
  const axis = normalizePoint(subtractPoint(lineEnd, lineStart))
  if (!axis) {
    return null
  }

  const mirrored = mirrorDirectionAcrossAxis(angleToPoint(angleDegrees), axis)
  return normalizeAngleDegrees(Math.atan2(mirrored.y, mirrored.x) * (180 / Math.PI))
}

function mirrorProfile(
  profile: SketchFeature['sketch']['profile'],
  transformPoint: (point: Point) => Point,
): SketchFeature['sketch']['profile'] {
  return {
    ...profile,
    start: transformPoint(profile.start),
    segments: profile.segments.map((segment) => {
      if (segment.type === 'arc' || segment.type === 'circle') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          center: transformPoint(segment.center),
          clockwise: !segment.clockwise,
        }
      }

      if (segment.type === 'bezier') {
        return {
          ...segment,
          to: transformPoint(segment.to),
          control1: transformPoint(segment.control1),
          control2: transformPoint(segment.control2),
        }
      }

      return {
        ...segment,
        to: transformPoint(segment.to),
      }
    }),
  }
}

function featureResizeBasis(feature: SketchFeature): { u: Point; v: Point } {
  const orientationAngle = normalizeAngleDegrees(
    feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
  )
  const v = angleToPoint(orientationAngle)
  const u = angleToPoint(orientationAngle - 90)
  return { u, v }
}

function snappedResizeScales(
  referenceVector: Point,
  previewVector: Point,
  u: Point,
  v: Point,
): { scaleU: number; scaleV: number } | null {
  const refU = dotPoint(referenceVector, u)
  const refV = dotPoint(referenceVector, v)
  const previewU = dotPoint(previewVector, u)
  const previewV = dotPoint(previewVector, v)

  const scaleU = Math.abs(refU) <= 1e-9 ? 1 : previewU / refU
  const scaleV = Math.abs(refV) <= 1e-9 ? 1 : previewV / refV

  const unit = normalizePoint(referenceVector)
  if (!unit) {
    return null
  }

  const axisSnapTolerance = Math.cos((12 * Math.PI) / 180)
  const alignU = Math.abs(dotPoint(unit, u))
  const alignV = Math.abs(dotPoint(unit, v))

  if (alignU >= axisSnapTolerance && alignU >= alignV) {
    return { scaleU, scaleV: 1 }
  }

  if (alignV >= axisSnapTolerance && alignV >= alignU) {
    return { scaleU: 1, scaleV }
  }

  return { scaleU, scaleV }
}

function scaleNumericZSpan(
  zTop: SketchFeature['z_top'],
  zBottom: SketchFeature['z_bottom'],
  scale: number,
): Pick<SketchFeature, 'z_top' | 'z_bottom'> {
  if (typeof zTop !== 'number' || typeof zBottom !== 'number') {
    return { z_top: zTop, z_bottom: zBottom }
  }

  return {
    z_top: zBottom + (zTop - zBottom) * scale,
    z_bottom: zBottom,
  }
}

export function resizeFeatureFromReference(
  feature: SketchFeature,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): SketchFeature | null {
  const referenceVector = subtractPoint(referenceEnd, referenceStart)
  const referenceLength = pointLength(referenceVector)
  if (referenceLength <= 1e-9) {
    return null
  }

  const unit = scalePoint(referenceVector, 1 / referenceLength)
  const projectedLength = dotPoint(subtractPoint(previewPoint, referenceStart), unit)
  const constrainedPreview = addPoint(referenceStart, scalePoint(unit, projectedLength))
  const { u, v } = featureResizeBasis(feature)
  const previewVector = subtractPoint(constrainedPreview, referenceStart)
  const snappedScales = snappedResizeScales(referenceVector, previewVector, u, v)
  if (!snappedScales) {
    return null
  }

  const uniformModelScale = feature.kind === 'stl'
    ? projectedLength / referenceLength
    : null
  const scaleU = uniformModelScale ?? snappedScales.scaleU
  const scaleV = uniformModelScale ?? snappedScales.scaleV
  if (
    !Number.isFinite(scaleU)
    || !Number.isFinite(scaleV)
    || scaleU <= 1e-6
    || scaleV <= 1e-6
  ) {
    return null
  }

  const transformPoint = (point: Point): Point => {
    const local = subtractPoint(point, referenceStart)
    const localU = dotPoint(local, u)
    const localV = dotPoint(local, v)
    return {
      x: referenceStart.x + u.x * localU * scaleU + v.x * localV * scaleV,
      y: referenceStart.y + u.y * localU * scaleU + v.y * localV * scaleV,
    }
  }

  const profile = transformProfileAffine(feature.sketch.profile, transformPoint)
  const resizedZ = feature.kind === 'stl'
    ? scaleNumericZSpan(feature.z_top, feature.z_bottom, scaleU)
    : { z_top: feature.z_top, z_bottom: feature.z_bottom }

  return {
    ...feature,
    kind: feature.kind === 'text' ? 'text' : (feature.kind === 'stl' ? 'stl' : inferFeatureKind(profile)),
    stl: feature.stl
      ? {
          ...transformStlFeatureData(feature.stl, transformPoint)!,
          scale: feature.stl.scale * scaleU,
        }
      : feature.stl,
    z_top: resizedZ.z_top,
    z_bottom: resizedZ.z_bottom,
    sketch: {
      ...feature.sketch,
      origin: transformPoint(feature.sketch.origin),
      orientationAngle: normalizeAngleDegrees(
        feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
      ),
      profile,
    },
  }
}

export function rotateFeatureFromReference(
  feature: SketchFeature,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): SketchFeature | null {
  const startVector = subtractPoint(referenceEnd, referenceStart)
  const endVector = subtractPoint(previewPoint, referenceStart)
  const startLength = pointLength(startVector)
  const endLength = pointLength(endVector)
  if (startLength <= 1e-9 || endLength <= 1e-9) {
    return null
  }

  const angle = Math.atan2(crossPoint(startVector, endVector), dotPoint(startVector, endVector))
  if (!Number.isFinite(angle)) {
    return null
  }

  const rotatePoint = (point: Point) => rotatePointAround(point, referenceStart, angle)
  const profile = transformProfile(feature.sketch.profile, rotatePoint)
  return {
    ...feature,
    kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(profile),
    stl: transformStlFeatureData(feature.stl, rotatePoint),
    sketch: {
      ...feature.sketch,
      origin: rotatePoint(feature.sketch.origin),
      orientationAngle: normalizeAngleDegrees(
        (feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile)) + angle * (180 / Math.PI),
      ),
      profile,
    },
  }
}

export function mirrorFeatureFromReference(
  feature: SketchFeature,
  referenceStart: Point,
  referenceEnd: Point,
): SketchFeature | null {
  const axis = normalizePoint(subtractPoint(referenceEnd, referenceStart))
  if (!axis) {
    return null
  }

  const mirrorPoint = (point: Point): Point => {
    const local = subtractPoint(point, referenceStart)
    const projected = scalePoint(axis, dotPoint(local, axis))
    return addPoint(referenceStart, subtractPoint(scalePoint(projected, 2), local))
  }
  const profile = mirrorProfile(feature.sketch.profile, mirrorPoint)
  const orientationAngle = mirrorAngleAcrossLine(
    feature.sketch.orientationAngle ?? inferProfileOrientationAngle(feature.sketch.profile),
    referenceStart,
    referenceEnd,
  )
  if (orientationAngle === null) {
    return null
  }

  return {
    ...feature,
    kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(profile),
    stl: transformStlFeatureData(feature.stl, mirrorPoint),
    sketch: {
      ...feature.sketch,
      origin: mirrorPoint(feature.sketch.origin),
      orientationAngle,
      profile,
    },
  }
}

function backdropResizeBasis(backdrop: BackdropImage): { u: Point; v: Point } {
  const orientationAngle = normalizeAngleDegrees(backdrop.orientationAngle ?? 90)
  return {
    u: angleToPoint(orientationAngle - 90),
    v: angleToPoint(orientationAngle),
  }
}

export function resizeBackdropFromReference(
  backdrop: BackdropImage,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): BackdropImage | null {
  const referenceVector = subtractPoint(referenceEnd, referenceStart)
  const referenceLength = pointLength(referenceVector)
  if (referenceLength <= 1e-9) {
    return null
  }

  const unit = scalePoint(referenceVector, 1 / referenceLength)
  const projectedLength = dotPoint(subtractPoint(previewPoint, referenceStart), unit)
  const constrainedPreview = addPoint(referenceStart, scalePoint(unit, projectedLength))
  const { u, v } = backdropResizeBasis(backdrop)
  const previewVector = subtractPoint(constrainedPreview, referenceStart)
  const snappedScales = snappedResizeScales(referenceVector, previewVector, u, v)
  if (!snappedScales) {
    return null
  }

  const { scaleU, scaleV } = snappedScales
  if (
    !Number.isFinite(scaleU)
    || !Number.isFinite(scaleV)
    || scaleU <= 1e-6
    || scaleV <= 1e-6
  ) {
    return null
  }

  const local = subtractPoint(backdrop.center, referenceStart)
  const localU = dotPoint(local, u)
  const localV = dotPoint(local, v)

  return {
    ...backdrop,
    center: {
      x: referenceStart.x + u.x * localU * scaleU + v.x * localV * scaleV,
      y: referenceStart.y + u.y * localU * scaleU + v.y * localV * scaleV,
    },
    width: backdrop.width * scaleU,
    height: backdrop.height * scaleV,
  }
}

export function rotateBackdropFromReference(
  backdrop: BackdropImage,
  referenceStart: Point,
  referenceEnd: Point,
  previewPoint: Point,
): BackdropImage | null {
  const startVector = subtractPoint(referenceEnd, referenceStart)
  const endVector = subtractPoint(previewPoint, referenceStart)
  const startLength = pointLength(startVector)
  const endLength = pointLength(endVector)
  if (startLength <= 1e-9 || endLength <= 1e-9) {
    return null
  }

  const angle = Math.atan2(crossPoint(startVector, endVector), dotPoint(startVector, endVector))
  if (!Number.isFinite(angle)) {
    return null
  }

  return {
    ...backdrop,
    center: rotatePointAround(backdrop.center, referenceStart, angle),
    orientationAngle: normalizeAngleDegrees(backdrop.orientationAngle + angle * (180 / Math.PI)),
  }
}

export function filletRadiusFromPoint(
  feature: SketchFeature,
  anchorIndex: number,
  previewPoint: Point,
): number | null {
  const profile = feature.sketch.profile
  const anchors = profileVertices(profile)
  const anchorCount = anchors.length
  const hasIncoming = profile.closed || anchorIndex > 0
  const hasOutgoing = profile.closed || anchorIndex < anchorCount - 1
  if (!hasIncoming || !hasOutgoing || anchorIndex < 0 || anchorIndex >= anchorCount) {
    return null
  }

  const corner = anchors[anchorIndex]
  const previousAnchor = anchors[(anchorIndex - 1 + anchorCount) % anchorCount]
  const nextAnchor = anchors[(anchorIndex + 1) % anchorCount]
  const incomingDirection = normalizePoint(subtractPoint(previousAnchor, corner))
  const outgoingDirection = normalizePoint(subtractPoint(nextAnchor, corner))
  if (!incomingDirection || !outgoingDirection) {
    return null
  }

  const incomingIndex = profile.closed ? (anchorIndex - 1 + profile.segments.length) % profile.segments.length : anchorIndex - 1
  const outgoingIndex = anchorIndex
  const incomingSegment = profile.segments[incomingIndex]
  const outgoingSegment = profile.segments[outgoingIndex]
  if (!incomingSegment || !outgoingSegment || incomingSegment.type !== 'line' || outgoingSegment.type !== 'line') {
    return null
  }

  const previewVector = subtractPoint(previewPoint, corner)
  const trim = Math.max(0, dotPoint(previewVector, incomingDirection), dotPoint(previewVector, outgoingDirection))
  if (!(trim > 1e-9)) {
    return null
  }

  const turnDot = clampNumber(dotPoint(incomingDirection, outgoingDirection), -1, 1)
  const interiorAngle = Math.acos(turnDot)
  if (!Number.isFinite(interiorAngle) || interiorAngle <= 1e-3 || Math.abs(Math.PI - interiorAngle) <= 1e-3) {
    return null
  }

  return trim * Math.tan(interiorAngle / 2)
}

export function filletFeatureFromPoint(
  feature: SketchFeature,
  anchorIndex: number,
  previewPoint: Point,
): SketchFeature | null {
  const radius = filletRadiusFromPoint(feature, anchorIndex, previewPoint)
  if (!radius) {
    return null
  }

  return filletFeatureFromRadius(feature, anchorIndex, radius)
}

export function filletFeatureFromRadius(
  feature: SketchFeature,
  anchorIndex: number,
  radius: number,
): SketchFeature | null {
  const profile = applyLineCornerFillet(feature.sketch.profile, anchorIndex, radius)
  if (!profile) {
    return null
  }

  return {
    ...feature,
    kind: ['text', 'stl'].includes(feature.kind) ? feature.kind : inferFeatureKind(profile),
    sketch: {
      ...feature.sketch,
      profile,
    },
  }
}

function translateClamp(clamp: Clamp, dx: number, dy: number): Clamp {
  return {
    ...clamp,
    x: clamp.x + dx,
    y: clamp.y + dy,
  }
}

function translateTab(tab: Tab, dx: number, dy: number): Tab {
  return {
    ...tab,
    x: tab.x + dx,
    y: tab.y + dy,
  }
}

function duplicateFeatureName(name: string, features: SketchFeature[], totalCount: number, step: number): string {
  if (totalCount === 1) {
    // Single copy: "Name Copy"
    const baseName = `${name} Copy`
    if (!features.some((f) => f.name === baseName)) return baseName
    let index = 2
    while (features.some((f) => f.name === `${baseName} ${index}`)) index += 1
    return `${baseName} ${index}`
  }
  // Multiple copies: "Name Copy 1", "Name Copy 2", …
  let index = step
  while (features.some((f) => f.name === `${name} Copy ${index}`)) index += 1
  return `${name} Copy ${index}`
}

function uniqueFolderName(preferred: string, folders: FeatureFolder[]): string {
  return uniqueName(preferred, folders.map((folder) => folder.name))
}

function textFolderBaseName(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return 'Text'
  }
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized
}

function createTextFeatureAt(project: Project, config: TextToolConfig, anchor: Point): SketchFeature | null {
  const generatedShapes = generateTextShapes(config, { x: 0, y: 0 }).filter((shape) => !isProfileDegenerate(shape.profile))
  if (generatedShapes.length === 0) {
    return null
  }

  const featureName = uniqueName(textFolderBaseName(config.text), project.features.map((feature) => feature.name))
  const isFirstMachiningFeature = !project.features.some((feature) => feature.operation !== 'region')
  const textData: TextFeatureData = {
    text: config.text,
    style: config.style,
    fontId: config.fontId,
    size: config.size,
  }

  return normalizeFeatureZRange({
    id: nextUniqueGeneratedId(project, 'f'),
    name: featureName,
    kind: 'text',
    text: textData,
    folderId: null,
    sketch: {
      profile: getTextFrameProfile(config, anchor),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: isFirstMachiningFeature ? 'add' : config.operation,
    z_top: project.stock.thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
  })
}

function duplicateClampName(name: string, clamps: Clamp[]): string {
  const baseName = `${name} Copy`
  if (!clamps.some((clamp) => clamp.name === baseName)) {
    return baseName
  }

  let index = 2
  while (clamps.some((clamp) => clamp.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function duplicateTabName(name: string, tabs: Tab[]): string {
  const baseName = `${name} Copy`
  if (!tabs.some((tab) => tab.name === baseName)) {
    return baseName
  }

  let index = 2
  while (tabs.some((tab) => tab.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

export function folderIdForOperation(project: Project, folderId: string | null, operation: FeatureOperation | undefined): string | null {
  if (!folderId) return null
  const folder = project.featureFolders.find((entry) => entry.id === folderId) ?? null
  if (!folder) return null
  const folderSection = folder.section ?? 'features'
  return operation === 'region'
    ? folderSection === 'regions' ? folderId : null
    : folderSection === 'regions' ? null : folderId
}

function toolMatchesTemplate(existingTool: Tool, candidate: Omit<Tool, 'id'>): boolean {
  return (
    existingTool.name === candidate.name
    && existingTool.units === candidate.units
    && existingTool.type === candidate.type
    && existingTool.diameter === candidate.diameter
    && existingTool.vBitAngle === candidate.vBitAngle
    && existingTool.flutes === candidate.flutes
    && existingTool.material === candidate.material
    && existingTool.defaultRpm === candidate.defaultRpm
    && existingTool.defaultFeed === candidate.defaultFeed
    && existingTool.defaultPlungeFeed === candidate.defaultPlungeFeed
    && existingTool.defaultStepdown === candidate.defaultStepdown
    && existingTool.defaultStepover === candidate.defaultStepover
  )
}

function operationKindLabel(kind: OperationKind): string {
  switch (kind) {
    case 'pocket':
      return 'Pocket'
    case 'v_carve':
      return 'V-Carve offset'
    case 'v_carve_recursive':
      return 'V-Carve skeleton'
    case 'edge_route_inside':
      return 'Edge route inside'
    case 'edge_route_outside':
      return 'Edge route outside'
    case 'surface_clean':
      return 'Surface clean'
    case 'rough_surface':
      return '3D Surface rough'
    case 'finish_surface':
      return '3D Surface finish'
    case 'finish_surface_cleanup':
      return '3D Surface cleanup'
    case 'follow_line':
      return 'Engrave'
    case 'drilling':
      return 'Drill'
  }
}

function isOperationTargetValid(project: Project, kind: OperationKind, target: OperationTarget): boolean {
  if (kind === 'drilling') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.kind === 'circle')
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  if (kind === 'follow_line') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return features.length === target.featureIds.length
      && machiningFeatures.length > 0
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  if (kind === 'surface_clean') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => (feature.operation === 'add' || feature.operation === 'model') && feature.sketch.profile.closed)
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  if (kind === 'finish_surface' || kind === 'finish_surface_cleanup') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const modelCount = features.filter((f) => f.operation === 'model' && f.kind === 'stl').length
    const allValid = features.every((f) =>
      (f.operation === 'model' && f.kind === 'stl') ||
      (f.operation === 'region' && f.sketch.profile.closed)
    )

    if (modelCount !== 1) return false
    if (!allValid) return false
    return true
  }

  if (kind === 'rough_surface') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.some((feature) => feature.operation === 'model' && feature.kind === 'stl')
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  if (kind === 'v_carve' || kind === 'v_carve_recursive') {
    if (target.source !== 'features' || target.featureIds.length === 0) {
      return false
    }

    const features = target.featureIds
      .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
      .filter((feature): feature is SketchFeature => feature !== null)

    if (features.length !== target.featureIds.length) {
      return false
    }

    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.operation === 'subtract' && featureHasClosedGeometry(feature))
      && regionFeatures.every((feature) => featureHasClosedGeometry(feature))
  }

  if (target.source !== 'features' || target.featureIds.length === 0) {
    return false
  }

  const features = target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)

  if (features.length !== target.featureIds.length) {
    return false
  }

  if (kind === 'pocket' || kind === 'edge_route_inside') {
    const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
    const regionFeatures = features.filter((feature) => feature.operation === 'region')
    return machiningFeatures.length > 0
      && machiningFeatures.every((feature) => feature.operation === 'subtract' && feature.sketch.profile.closed)
      && regionFeatures.every((feature) => feature.sketch.profile.closed)
  }

  const machiningFeatures = features.filter((feature) => feature.operation !== 'region')
  const regionFeatures = features.filter((feature) => feature.operation === 'region')
  return machiningFeatures.length > 0
    && machiningFeatures.every((feature) => (feature.operation === 'add' || feature.operation === 'model') && feature.sketch.profile.closed)
    && regionFeatures.every((feature) => feature.sketch.profile.closed)
}

function defaultOperationName(kind: OperationKind, pass: OperationPass, operations: Operation[]): string {
  const baseName = kind === 'follow_line' || kind === 'v_carve' || kind === 'v_carve_recursive' || kind === 'drilling' || kind === 'rough_surface' || kind === 'finish_surface'
    || kind === 'finish_surface_cleanup'
    ? operationKindLabel(kind)
    : `${operationKindLabel(kind)} ${pass === 'rough' ? 'Rough' : 'Finish'}`
  if (!operations.some((operation) => operation.name === baseName)) {
    return baseName
  }

  let index = 2
  while (operations.some((operation) => operation.name === `${baseName} ${index}`)) {
    index += 1
  }
  return `${baseName} ${index}`
}

function defaultWaterlineMicroStepover(tool: Tool): number {
  return Math.max(0, tool.defaultStepover * tool.diameter)
}

function defaultOperationForTarget(
  project: Project,
  kind: OperationKind,
  pass: OperationPass,
  target: OperationTarget,
  index: number,
  resolved?: { tool: Tool; toolRef: string | null },
): Operation {
  const tool = resolved?.tool ?? project.tools[0] ?? defaultTool(project.meta.units, 1)
  const toolRef = resolved ? resolved.toolRef : (project.tools[0]?.id ?? null)

  // V-carves should carve to a useful depth, not the 1 mm engrave default. Mirror
  // the tool-change handler in CAMPanel: derive the cap from the tool's max cut
  // depth, falling back to the stock thickness so wide areas aren't clipped shallow.
  const isVCarve = kind === 'v_carve' || kind === 'v_carve_recursive'
  const vCarveMaxDepth = tool.maxCutDepth > 0
    ? tool.maxCutDepth
    : (project.stock.thickness > 0 ? project.stock.thickness : convertLength(1, 'mm', project.meta.units))

  return {
    id: `op${index + 1}`,
    name: defaultOperationName(kind, pass, project.operations),
    description: '',
    kind,
    pass,
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target,
    toolRef,
    stepdown: kind === 'finish_surface_cleanup'
      ? convertLength(1, 'mm', project.meta.units)
      : tool.defaultStepdown,
    stepover: tool.defaultStepover,
    feed: tool.defaultFeed,
    plungeFeed: tool.defaultPlungeFeed,
    rpm: tool.defaultRpm,
    pocketPattern: kind === 'finish_surface' || kind === 'finish_surface_cleanup' ? 'parallel' : 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: convertLength(1, 'mm', project.meta.units),
    maxCarveDepth: isVCarve ? vCarveMaxDepth : convertLength(1, 'mm', project.meta.units),
    cutDirection: 'conventional',
    machiningOrder: 'feature_first',
    waterlineAdaptiveRefinement: true,
    waterlineMicroStepover: defaultWaterlineMicroStepover(tool),
    waterlineRefinementThreshold: 0,
    waterlineMaxRingsPerBand: 0,
    waterlineTipStepdown: 0,
    ...(kind === 'drilling' ? {
      drillType: 'simple' as const,
      peckDepth: convertLength(2, 'mm', project.meta.units),
      dwellTime: 0.5,
      retractHeight: project.stock.thickness + convertLength(1, 'mm', project.meta.units),
    } : {}),
  }
}

function fallbackOperationTarget(project: Project, kind: OperationKind): OperationTarget {
  if (kind === 'drilling') {
    const firstCircle = project.features.find((feature) => feature.kind === 'circle')
    return firstCircle
      ? { source: 'features', featureIds: [firstCircle.id] }
      : { source: 'stock' }
  }

  if (kind === 'follow_line') {
    const firstFeature = project.features[0]
    return firstFeature
      ? { source: 'features', featureIds: [firstFeature.id] }
      : { source: 'stock' }
  }

  if (kind === 'v_carve' || kind === 'v_carve_recursive') {
    const firstSubtractFeature = project.features.find((feature) => feature.operation === 'subtract' && featureHasClosedGeometry(feature))
    return firstSubtractFeature
      ? { source: 'features', featureIds: [firstSubtractFeature.id] }
      : { source: 'stock' }
  }

  if (kind === 'finish_surface' || kind === 'finish_surface_cleanup') {
    const modelFeature = project.features.find((feature) => feature.operation === 'model' && feature.kind === 'stl')
    if (modelFeature) {
      // Optionally include a region if one exists
      const regionFeature = project.features.find((feature) => feature.operation === 'region' && feature.sketch.profile.closed)
      if (regionFeature) {
        return { source: 'features', featureIds: [modelFeature.id, regionFeature.id] }
      }
      return { source: 'features', featureIds: [modelFeature.id] }
    }
  }

  if (kind === 'rough_surface') {
    const modelFeature = project.features.find((feature) => feature.operation === 'model' && feature.kind === 'stl')
    if (modelFeature) {
      // Optionally include a region if one exists (for constraining the outer boundary)
      const regionFeature = project.features.find((feature) => feature.operation === 'region' && feature.sketch.profile.closed)
      if (regionFeature) {
        return { source: 'features', featureIds: [modelFeature.id, regionFeature.id] }
      }
      return { source: 'features', featureIds: [modelFeature.id] }
    }
  }

  if (kind === 'surface_clean' || kind === 'edge_route_outside') {
    const firstAddOrModelFeature = project.features.find((feature) => (
      (feature.operation === 'add' || (kind === 'edge_route_outside' && feature.operation === 'model'))
      && feature.sketch.profile.closed
    ))
    if (firstAddOrModelFeature) {
      return { source: 'features', featureIds: [firstAddOrModelFeature.id] }
    }
  }

  if (kind === 'pocket' || kind === 'edge_route_inside') {
    const firstSubtractFeature = project.features.find((feature) => feature.operation === 'subtract' && feature.sketch.profile.closed)
    if (firstSubtractFeature) {
      return { source: 'features', featureIds: [firstSubtractFeature.id] }
    }
  }

  const firstFeature = project.features.find((feature) => feature.sketch.profile.closed)
  return firstFeature
    ? { source: 'features', featureIds: [firstFeature.id] }
    : { source: 'stock' }
}

function buildRotatedCopies(
  sourceFeatures: SketchFeature[],
  existingFeatures: SketchFeature[],
  pivot: Point,
  angle: number,
  count: number,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const projectLike: Project = { ...newProject(), features: existingFeatures, tools: [], operations: [] }

  for (let step = 1; step <= count; step += 1) {
    const stepAngle = angle * step
    const rotatePoint = (point: Point) => rotatePointAround(point, pivot, stepAngle)
    for (const sourceFeature of sourceFeatures) {
      const nextId = nextUniqueGeneratedId(
        { ...projectLike, features: [...existingFeatures, ...created] },
        'f',
      )
      const profile = transformProfile(sourceFeature.sketch.profile, rotatePoint)
      created.push({
        ...sourceFeature,
        id: nextId,
        name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], count, step),
        folderId: sourceFeature.folderId,
        stl: transformStlFeatureData(sourceFeature.stl, rotatePoint),
        sketch: {
          ...sourceFeature.sketch,
          origin: rotatePoint(sourceFeature.sketch.origin),
          orientationAngle: normalizeAngleDegrees(
            (sourceFeature.sketch.orientationAngle ?? inferProfileOrientationAngle(sourceFeature.sketch.profile)) + stepAngle * (180 / Math.PI),
          ),
          profile,
        },
        locked: false,
      })
    }
  }

  return created
}

function buildMirroredCopies(
  sourceFeatures: SketchFeature[],
  existingFeatures: SketchFeature[],
  lineStart: Point,
  lineEnd: Point,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const projectLike: Project = { ...newProject(), features: existingFeatures, tools: [], operations: [] }

  for (const sourceFeature of sourceFeatures) {
    const nextId = nextUniqueGeneratedId(
      { ...projectLike, features: [...existingFeatures, ...created] },
      'f',
    )
    const mirrored = mirrorFeatureFromReference(sourceFeature, lineStart, lineEnd)
    if (!mirrored) {
      continue
    }

    created.push({
      ...mirrored,
      id: nextId,
      name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], 1, 1),
      folderId: sourceFeature.folderId,
      locked: false,
    })
  }

  return created
}

function buildCopiedFeatures(
  sourceFeatures: SketchFeature[],
  existingFeatures: SketchFeature[],
  dx: number,
  dy: number,
  count: number,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const projectLike: Project = {
    ...newProject(),
    features: existingFeatures,
    tools: [],
    operations: [],
  }

  for (let step = 1; step <= count; step += 1) {
    for (const sourceFeature of sourceFeatures) {
      const nextId = nextUniqueGeneratedId(
        {
          ...projectLike,
          features: [...existingFeatures, ...created],
        },
        'f',
      )
      created.push({
        ...sourceFeature,
        id: nextId,
        name: duplicateFeatureName(sourceFeature.name, [...existingFeatures, ...created], count, step),
        folderId: sourceFeature.folderId,
        stl: transformStlFeatureData(sourceFeature.stl, (point) => translatePoint(point, dx * step, dy * step)),
        sketch: {
          ...sourceFeature.sketch,
          origin: ['text', 'stl'].includes(sourceFeature.kind)
            ? { x: sourceFeature.sketch.origin.x + dx * step, y: sourceFeature.sketch.origin.y + dy * step }
            : sourceFeature.sketch.origin,
          profile: translateProfile(sourceFeature.sketch.profile, dx * step, dy * step),
        },
        locked: false,
      })
    }
  }

  return created
}

function buildCopiedClamps(
  sourceClamps: Clamp[],
  existingClamps: Clamp[],
  project: Project,
  dx: number,
  dy: number,
  count: number,
): Clamp[] {
  const created: Clamp[] = []

  for (let step = 1; step <= count; step += 1) {
    for (const sourceClamp of sourceClamps) {
      created.push({
        ...sourceClamp,
        id: nextUniqueGeneratedId(
          {
            ...project,
            clamps: [...existingClamps, ...created],
          },
          'cl',
        ),
        name: duplicateClampName(sourceClamp.name, [...existingClamps, ...created]),
        x: sourceClamp.x + dx * step,
        y: sourceClamp.y + dy * step,
      })
    }
  }

  return created
}

function buildCopiedTabs(
  sourceTabs: Tab[],
  existingTabs: Tab[],
  project: Project,
  dx: number,
  dy: number,
  count: number,
): Tab[] {
  const created: Tab[] = []

  for (let step = 1; step <= count; step += 1) {
    for (const sourceTab of sourceTabs) {
      created.push({
        ...sourceTab,
        id: nextUniqueGeneratedId(
          {
            ...project,
            tabs: [...existingTabs, ...created],
          },
          'tb',
        ),
        name: duplicateTabName(sourceTab.name, [...existingTabs, ...created]),
        x: sourceTab.x + dx * step,
        y: sourceTab.y + dy * step,
      })
    }
  }

  return created
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

export function isImportedModelFeature(feature: SketchFeature): boolean {
  return feature.kind === 'stl' && feature.operation === 'model'
}

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
  setCreationTarget: (target) =>
    set(() => ({
      creationTarget: target,
      pendingAdd: null,
    })),
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
    transformProfile,
    translateClamp,
    translateTab,
    buildCopiedFeatures,
    buildCopiedClamps,
    buildCopiedTabs,
    buildRotatedCopies,
    buildMirroredCopies,
    resizeBackdropFromReference,
    rotateBackdropFromReference,
    resizeFeatureFromReference,
    rotateFeatureFromReference,
    mirrorFeatureFromReference,
    previewOffsetFeatures,
    syncFeatureTreeProject,
    createDerivedFeature,
  }),
  ...createPendingAddSlice(set, get, {
    cloneProject,
    syncFeatureTreeProject,
    createTextFeatureAt,
  }),
  ...createDimensionsSlice(set, get, { cloneProject }),
  ...createDimensionToolSlice(set, get),
  ...createToolsSlice(set, get, { cloneProject, projectsEqual, toolMatchesTemplate }),
  ...createClampsSlice(set, get, { cloneProject, projectsEqual, duplicateClampName }),
  ...createTabsSlice(set, get, { cloneProject, projectsEqual }),
  ...createBackdropSlice(set, get, { cloneProject, projectsEqual }),
  ...createMachineDefsSlice(set, get, { cloneProject, projectsEqual }),
  ...createOperationsSlice(set, get, {
    cloneProject,
    projectsEqual,
    toolMatchesTemplate,
    isOperationTargetValid,
    defaultOperationForTarget,
    defaultOperationName,
    uniqueFolderName,
    syncFeatureTreeProject,
  }),
  ...createImportMergeSlice(set, get, {
    cloneProject,
    uniqueFolderName,
    syncFeatureTreeProject,
  }),
  ...createFeatureSlice(set, get, {
    cloneProject,
    syncFeatureTreeProject,
    projectsEqual,
    createDerivedFeature,
    isImportedModelFeature,
    normalizeImportedModelStorage,
    folderIdForOperation,
    syncStockFromSourceFeature,
    transformProfile,
    pruneUnusedModelAssets,
  }),
  ...createFeatureGeometrySlice(set, get, {
    cloneProject,
    projectsEqual,
    syncFeatureTreeProject,
    syncStockFromSourceFeature,
    translatePoint,
    transformProfile,
    joinOpenProfiles,
    inferFeatureKind,
    clearStaleConstraints,
    applyProfileBreak,
  }),
  ...createConstraintsSlice(set, get, {
    cloneProject,
    translateProfile,
    transformProfile,
  }),

  // ── Project ──────────────────────────────────────────────

  createNewProject: (template, name) =>
    set((state) => {
      clearProjectMemoryCaches()
      const nextProject = normalizeProject(instantiateProjectTemplate(template, name))
      return {
        project: nextProject,
        dirty: false,
        filePath: null,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: emptySelection(),
        projectKey: state.projectKey + 1,
        history: {
          past: [],
          future: [],
          transactionStart: null,
        },
      }
    }),

  setProjectName: (name) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: { ...s.project.meta, name, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setProjectClearances: (patch) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          ...patch,
          modified: new Date().toISOString(),
        },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setShowDimensions: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          showDimensions: visible,
          modified: new Date().toISOString(),
        },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setShowFeatureInfo: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        meta: {
          ...s.project.meta,
          showFeatureInfo: visible,
          modified: new Date().toISOString(),
        },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setOrigin: (origin) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        origin,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  startPlaceOrigin: () =>
    set((s) => ({
      pendingAdd: { shape: 'origin', session: nextPlacementSession() },
      pendingMove: null,
      pendingTransform: null,
      sketchEditSession: null,
      selection: {
        ...s.selection,
        selectedFeatureId: null,
        selectedFeatureIds: [],
        selectedNode: { type: 'origin' },
        mode: 'feature',
        hoveredFeatureId: null,
        activeControl: null,
      },
    })),

  placeOriginAt: (point) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        origin: {
          ...s.project.origin,
          x: point.x,
          y: point.y,
        },
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      return {
        project: nextProject,
        pendingAdd: null,
        pendingTransform: null,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  loadProject: (p) =>
    set((state) => {
      clearProjectMemoryCaches()
      const normalizedProject = normalizeProject(p)
      const stockDefaults = defaultStock(undefined, undefined, undefined, normalizedProject.meta.units)
      const gridDefaults = defaultGrid(normalizedProject.meta.units)
      const nextProject = {
        ...normalizedProject,
        grid: {
          ...gridDefaults,
          ...normalizedProject.grid,
        },
        stock: {
          ...stockDefaults,
          ...normalizedProject.stock,
          origin: normalizedProject.stock?.origin ?? stockDefaults.origin,
          profile: normalizedProject.stock?.profile ?? stockDefaults.profile,
        },
        origin: normalizedProject.origin ?? defaultOrigin(normalizedProject.stock ?? stockDefaults),
      }
      clearProjectMemoryCaches()
      return {
        project: nextProject,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: emptySelection(),
        projectKey: state.projectKey + 1,
        history: {
          past: [],
          future: [],
          transactionStart: null,
        },
      }
    }),

  saveProject: () => {
    const p = pruneUnusedModelAssets(get().project)
    const updated = {
      ...p,
      meta: { ...p.meta, modified: new Date().toISOString() },
    }
    return JSON.stringify(updated, null, 2)
  },

  openProjectFromText: (content, path) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('Failed to parse project file.')
    }
    const normalized = normalizeProject(parsed as ReturnType<typeof normalizeProject>)
    const stockDefaults = defaultStock(undefined, undefined, undefined, normalized.meta.units)
    const gridDefaults = defaultGrid(normalized.meta.units)
    clearProjectMemoryCaches()
    set((state) => ({
      project: {
        ...normalized,
        grid: { ...gridDefaults, ...normalized.grid },
        stock: {
          ...stockDefaults,
          ...normalized.stock,
          origin: normalized.stock?.origin ?? stockDefaults.origin,
          profile: normalized.stock?.profile ?? stockDefaults.profile,
        },
        origin: normalized.origin ?? defaultOrigin(normalized.stock ?? stockDefaults),
      },
      filePath: path,
      dirty: false,
      pendingAdd: null,
      pendingMove: null,
      pendingTransform: null,
      pendingOffset: null,
      selection: emptySelection(),
      projectKey: state.projectKey + 1,
      history: {
        past: [],
        future: [],
        transactionStart: null,
      },
    }))
  },

  markSaved: (path) =>
    rawSet({ filePath: path, dirty: false }),

  markExported: (path) =>
    set({ lastExportPath: path }),

  markModelExported: (path) =>
    set({ lastModelExportPath: path }),

  undo: () =>
    set((state) => {
      const previous = state.history.past.at(-1)
      if (!previous) {
        return {}
      }
      const restored = normalizeProject(cloneProject(previous))
      return {
        project: restored,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: sanitizeSelection(restored, state.selection),
        history: {
          past: state.history.past.slice(0, -1),
          future: [cloneProject(state.project), ...state.history.future].slice(0, 100),
          transactionStart: null,
        },
      }
    }),

  redo: () =>
    set((state) => {
      const next = state.history.future[0]
      if (!next) {
        return {}
      }
      const restored = normalizeProject(cloneProject(next))
      return {
        project: restored,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: sanitizeSelection(restored, state.selection),
        history: {
          past: [...state.history.past, cloneProject(state.project)].slice(-100),
          future: state.history.future.slice(1),
          transactionStart: null,
        },
      }
    }),

  beginHistoryTransaction: () =>
    set((state) => {
      if (state.history.transactionStart) {
        return {}
      }
      return {
        history: {
          ...state.history,
          transactionStart: cloneProject(state.project),
        },
      }
    }),

  commitHistoryTransaction: () =>
    set((state) => {
      const { transactionStart } = state.history
      if (!transactionStart) {
        return {}
      }
      if (projectsEqual(transactionStart, state.project)) {
        return {
          history: {
            ...state.history,
            transactionStart: null,
          },
        }
      }
      return {
        history: {
          past: [...state.history.past, cloneProject(transactionStart)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  cancelHistoryTransaction: () =>
    set((state) => {
      const { transactionStart } = state.history
      if (!transactionStart) {
        return {}
      }
      const restored = normalizeProject(cloneProject(transactionStart))
      return {
        project: restored,
        pendingAdd: null,
        pendingMove: null,
        pendingTransform: null,
        pendingOffset: null,
        selection: sanitizeSelection(restored, state.selection),
        history: {
          ...state.history,
          transactionStart: null,
        },
      }
    }),

  // ── Stock ────────────────────────────────────────────────

  setStock: (stock) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        stock,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  /**
   * Set a feature as the stock source. The feature is removed from project.features
   * and its geometry is used as the stock profile/thickness.
   * Pass null to reset to rectangle stock (restores the feature to the tree).
   *
   * This is a single undo-able action that captures full before/after state.
   */
  setStockSourceFeature: (featureId: string | null) =>
    set((s) => {
      if (featureId === null) {
        // Reset to rectangle stock
        if (!s.project.stock.sourceFeatureId && !s.project.stock.sourceFeature) {
          return {} // Already rectangle stock, no-op
        }

        const restoredFeature = s.project.stock.sourceFeature
        if (!restoredFeature) return {}

        const stockBounds = getStockBounds(s.project.stock)
        const width = stockBounds.maxX - stockBounds.minX
        const height = stockBounds.maxY - stockBounds.minY
        const rectW = Math.max(width, 1)
        const rectH = Math.max(height, 1)

        const nextStock = {
          ...s.project.stock,
          profile: rectProfile(stockBounds.minX, stockBounds.minY, rectW, rectH),
          sourceFeatureId: null as string | null | undefined,
          sourceFeature: null as SketchFeature | null | undefined,
        }

        const nextProject = syncFeatureTreeProject({
          ...s.project,
          stock: nextStock,
          features: [...s.project.features, restoredFeature],
          meta: { ...s.project.meta, modified: new Date().toISOString() },
        })

        if (projectsEqual(nextProject, s.project)) {
          return {}
        }
        if (s.history.transactionStart) {
          return { project: nextProject }
        }
        return {
          project: nextProject,
          history: {
            past: [...s.history.past, cloneProject(s.project)].slice(-100),
            future: [],
            transactionStart: null,
          },
        }
      }

      // Set a feature as stock source
      const feature = s.project.features.find((f) => f.id === featureId)
      if (!feature) return {}
      if (!feature.sketch.profile.closed) return {} // Only closed profiles can be stock

      // If another feature is already the stock source, restore it first
      let features = s.project.features
      let stock = { ...s.project.stock }

      if (stock.sourceFeature && stock.sourceFeatureId) {
        // Restore old source feature to features array
        features = [...features, stock.sourceFeature]
      }

      // Remove the new source feature from features and tree
      features = features.filter((f) => f.id !== featureId)
      const featureTree = s.project.featureTree.filter(
        (entry) => !(entry.type === 'feature' && entry.featureId === featureId)
      )

      // Build stock from feature
      const newStock = stockFromFeature(feature)
      stock = {
        ...stock,
        profile: newStock.profile,
        thickness: newStock.thickness,
        sourceFeatureId: feature.id,
        sourceFeature: feature,
      }

      const nextProject = syncFeatureTreeProject({
        ...s.project,
        stock,
        features,
        featureTree,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      })

      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  /**
   * Enter sketch edit mode for the stock source feature.
   * Temporarily adds the source feature back to project.features and project.featureTree
   * so that mutation actions (moveFeatureControl, insertFeaturePoint, etc.) can find and edit it.
   * The feature is removed from features/tree on applySketchEdit (handled in selectionSlice).
   */
  enterStockSketchEdit: (featureId: string) =>
    set((s) => {
      const stock = s.project.stock
      if (stock.sourceFeatureId !== featureId || !stock.sourceFeature) {
        return {}
      }

      const feature = stock.sourceFeature

      // Temporarily add the feature to features array and feature tree for editing
      const nextProject = syncFeatureTreeProject({
        ...s.project,
        features: [...s.project.features, feature],
        featureTree: [...s.project.featureTree, { type: 'feature' as const, featureId: feature.id }],
      })

      return {
        project: nextProject,
        pendingTransform: null,
        pendingOffset: null,
        selection: {
          ...s.selection,
          selectedFeatureId: featureId,
          selectedFeatureIds: [featureId],
          selectedNode: { type: 'feature', featureId },
          mode: 'sketch_edit',
          sketchEditTool: null,
          activeControl: null,
        },
        sketchEditSession: {
          entityType: 'feature',
          entityId: featureId,
          snapshot: cloneProject(s.project),
          pastLength: s.history.past.length,
        },
        pendingConstraint: null,
      }
    }),

  setGrid: (grid) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        grid,
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setUnits: (units) =>
    set((s) => {
      if (s.project.meta.units === units) {
        return {}
      }

      const convertedProject = convertProjectUnits(s.project, units)
      const nextProject = {
        ...convertedProject,
        meta: { ...convertedProject.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      if (s.history.transactionStart) {
        return { project: nextProject }
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  setAllRegionsVisible: (visible) =>
    set((s) => {
      const nextProject = {
        ...s.project,
        features: s.project.features.map((feature) => (
          feature.operation === 'region' ? { ...feature, visible } : feature
        )),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  toggleFolderVisible: (folderId) =>
    set((s) => {
      const folderFeatures = s.project.features.filter((f) => f.folderId === folderId)
      const anyVisible = folderFeatures.some((f) => f.visible)
      const nextVisible = !anyVisible
      const nextProject = {
        ...s.project,
        features: s.project.features.map((f) =>
          f.folderId === folderId ? { ...f, visible: nextVisible } : f
        ),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  toggleRegionFolderVisible: (folderId) =>
    set((s) => {
      const folderFeatures = s.project.features.filter((f) => f.folderId === folderId && f.operation === 'region')
      const anyVisible = folderFeatures.some((f) => f.visible)
      const nextVisible = !anyVisible
      const nextProject = {
        ...s.project,
        features: s.project.features.map((f) =>
          f.folderId === folderId && f.operation === 'region' ? { ...f, visible: nextVisible } : f
        ),
        meta: { ...s.project.meta, modified: new Date().toISOString() },
      }
      if (projectsEqual(nextProject, s.project)) {
        return {}
      }
      return {
        project: nextProject,
        history: {
          past: [...s.history.past, cloneProject(s.project)].slice(-100),
          future: [],
          transactionStart: null,
        },
      }
    }),

  selectFolderFeatures: (folderId) =>
    set((s) => {
      const ids = s.project.features
        .filter((f) => f.folderId === folderId)
        .map((f) => f.id)
      if (ids.length === 0) {
        return {}
      }
      const primaryId = ids.at(-1) ?? null
      return {
        pendingOffset: null,
        pendingShapeAction: null,
        selection: {
          ...s.selection,
          selectedFeatureId: primaryId,
          selectedFeatureIds: ids,
          selectedNode: primaryId ? { type: 'feature', featureId: primaryId } : null,
          mode: 'feature',
          activeControl: null,
        },
        sketchEditSession: null,
      }
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
