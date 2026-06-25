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

import ClipperLib from 'clipper-lib'
import { addOpenSubject, openPathsFromPolyTree } from '../../engine/clipperOpenPaths'
import { DEFAULT_CLIPPER_SCALE, fromClipperPath } from '../../engine/toolpaths/geometry'
import { uniqueName } from '../../import'
import type {
  FeatureDefinition,
  FeatureOperation,
  FeatureTreeEntry,
  Matrix2D,
  Point,
  Project,
  SketchFeature,
  SketchProfile,
} from '../../types/project'
import { IDENTITY_MATRIX, inferFeatureKind, polygonProfile } from '../../types/project'
import type { OpenProfileEndpoint } from '../types'
import { clonePoint, pointsEqual } from './geometry'
import { nextUniqueGeneratedId } from './ids'
import { normalizeFeatureZRange } from './normalize'
import { createSnapshotDefinition } from './featureDefinitions'
import { resolvedFeatureMap } from './resolveFeatures'
import {
  cloneSegment,
  endPointForOpenProfile,
  normalizeEditableProfileClosure,
  orientOpenProfileFromEndpoint,
  orientOpenProfileTowardEndpoint,
} from './profileEdit'
import { rederiveConstraintGeometry } from '../../sketch/constraintSolver'
import {
  executeClipTree,
  flattenFeatureToClipperPath,
  flattenOpenFeatureToClipperPath,
  getClipperChildren,
  offsetClipperPaths,
  type ClipperPolyNode,
  unionClipperPaths,
} from './clipping'
import {
  buildSegmentAnnotations,
  clipperContourToProfile,
  clipperContourToProfilePreserving,
  collectKnownCircles,
  reconstructArcsInProfile,
  simplifyOffsetContour,
  type SegmentAnnotation,
} from '../../engine/toolpaths/arcReconstruction'
import { splitClosedByOpen } from './polygonSplit'

export interface DerivedFeatureGroup {
  sourceId: string
  features: SketchFeature[]
}

export type DerivedFeatureFactory = (
  project: Project,
  baseFeature: SketchFeature,
  profile: SketchProfile,
  operation: FeatureOperation,
  name: string,
) => { feature: SketchFeature; definition: FeatureDefinition }

export function normalizeDerivedFeatureNameStem(name: string) {
  return name
    .replace(/(?: Join(?: \d+)?)$/u, '')
    .replace(/(?: Offset(?: \d+)?)$/u, '')
    .replace(/(?: Cut(?: Hole)?(?: \d+)?)$/u, '')
    .trim()
}

function collectDerivedFeaturesFromPolyTree(
  project: Project,
  node: ClipperPolyNode,
  baseFeature: SketchFeature,
  baseOperation: FeatureOperation,
  baseName: string,
  createDerivedFeature: DerivedFeatureFactory,
  sourceFeatures: SketchFeature[],
  segAnnotations: Map<string, SegmentAnnotation>,
  contourDepth = 0,
): { features: SketchFeature[]; definitions: FeatureDefinition[] } {
  const features: SketchFeature[] = []
  const definitions: FeatureDefinition[] = []
  const contour = node.Contour()
  const nextContourDepth = contour.length > 0 ? contourDepth + 1 : contourDepth

  if (contour.length > 0) {
    const profile = clipperContourToProfilePreserving(contour, sourceFeatures, segAnnotations)
      ?? clipperContourToProfile(contour)
    if (profile) {
      const logicalDepth = nextContourDepth - 1
      const operation = logicalDepth % 2 === 0 ? baseOperation : (baseOperation === 'add' ? 'subtract' : 'add')
      const name = uniqueName(
        logicalDepth === 0 ? baseName : `${baseName} Hole`,
        [...project.features.map((feature) => feature.name), ...features.map((feature) => feature.name)],
      )
      const nextProject = { ...project, features: [...project.features, ...features] }
      const result = createDerivedFeature(nextProject, baseFeature, profile, operation, name)
      features.push(result.feature)
      definitions.push(result.definition)
    }
  }

  for (const child of getClipperChildren(node)) {
    const childResult = collectDerivedFeaturesFromPolyTree(
      { ...project, features: [...project.features, ...features] },
      child,
      baseFeature,
      baseOperation,
      baseName,
      createDerivedFeature,
      sourceFeatures,
      segAnnotations,
      nextContourDepth,
    )
    features.push(...childResult.features)
    definitions.push(...childResult.definitions)
  }

  return { features, definitions }
}

// Split a single closed feature with an open cutter. Returns the resulting
// pieces as new features. Returns [] if the cutter does not fully cross
// the target (no-op).
function splitClosedFeatureByOpenCutter(
  project: Project,
  target: SketchFeature,
  openCutter: SketchFeature,
  baseName: string,
  createDerivedFeature: DerivedFeatureFactory,
): { features: SketchFeature[]; definitions: FeatureDefinition[] } {
  const result = splitClosedByOpen(target.sketch.profile, openCutter.sketch.profile)
  if (!result || result.pieces.length < 2) return { features: [], definitions: [] }

  const knownCircles = collectKnownCircles([target, openCutter])
  const features: SketchFeature[] = []
  const definitions: FeatureDefinition[] = []
  for (const piece of result.pieces) {
    const profile = knownCircles.length > 0
      ? reconstructArcsInProfile(piece, knownCircles, Math.PI / 4)
      : polygonProfile(piece)
    const name = uniqueName(baseName, [
      ...project.features.map((f) => f.name),
      ...features.map((f) => f.name),
    ])
    const factoryResult = createDerivedFeature(
      { ...project, features: [...project.features, ...features] },
      target,
      profile,
      target.operation,
      name,
    )
    features.push(factoryResult.feature)
    definitions.push(factoryResult.definition)
  }
  return { features, definitions }
}

// Trim an open target by closed cutters. Uses Clipper's native open-path
// clipping: each closed cutter is added as a closed clip and the open
// target as an open subject, with boolean difference. Result is one or
// more open polylines representing the parts of the target outside all
// cutters.
function trimOpenTargetByClosedCutters(
  project: Project,
  target: SketchFeature,
  closedClipPaths: ReturnType<typeof flattenFeatureToClipperPath>[],
  baseName: string,
  createDerivedFeature: DerivedFeatureFactory,
): { features: SketchFeature[]; definitions: FeatureDefinition[] } {
  if (closedClipPaths.length === 0) return { features: [], definitions: [] }
  const targetPath = flattenOpenFeatureToClipperPath(target, DEFAULT_CLIPPER_SCALE)
  const clipper = new ClipperLib.Clipper()
  // Open subject path.
  addOpenSubject(clipper, targetPath)
  for (const clip of closedClipPaths) {
    clipper.AddPaths([clip], ClipperLib.PolyType.ptClip, true)
  }
  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  const openPaths: Point[][] = []
  const openPathsRaw = openPathsFromPolyTree(polyTree)
  for (const path of openPathsRaw) {
    if (!path || path.length < 2) continue
    openPaths.push(fromClipperPath(path, DEFAULT_CLIPPER_SCALE))
  }

  if (openPaths.length === 0) return { features: [], definitions: [] }

  const features: SketchFeature[] = []
  const definitions: FeatureDefinition[] = []
  for (const points of openPaths) {
    if (points.length < 2) continue
    const profile: SketchProfile = {
      start: points[0],
      segments: points.slice(1).map((p) => ({ type: 'line' as const, to: p })),
      closed: false,
    }
    const name = uniqueName(baseName, [
      ...project.features.map((f) => f.name),
      ...features.map((f) => f.name),
    ])
    const factoryResult = createDerivedFeature(
      { ...project, features: [...project.features, ...features] },
      target,
      profile,
      target.operation,
      name,
    )
    features.push(factoryResult.feature)
    definitions.push(factoryResult.definition)
  }
  return { features, definitions }
}

export function cutFeaturesByCutterGrouped(
  project: Project,
  cutters: SketchFeature[],
  targets: SketchFeature[],
  createDerivedFeature: DerivedFeatureFactory,
): { groups: DerivedFeatureGroup[]; definitions: FeatureDefinition[] } {
  const closedCutters = cutters.filter((c) => c.sketch.profile.closed)
  const openCutters = cutters.filter((c) => !c.sketch.profile.closed)
  const closedClipPaths = closedCutters.map((cutter) => flattenFeatureToClipperPath(cutter))
  const existingNames = [...project.features.map((feature) => feature.name)]
  const groups: DerivedFeatureGroup[] = []
  const allDefinitions: FeatureDefinition[] = []

  for (const target of targets) {
    const isOpenTarget = !target.sketch.profile.closed
    const sourceFeatures = [...cutters, target]
    const segAnnotations = buildSegmentAnnotations(sourceFeatures)
    const cutNameStem = normalizeDerivedFeatureNameStem(target.name)
    const baseName = `${cutNameStem} Cut`

    let nextFeatures: SketchFeature[] = []
    if (isOpenTarget) {
      // Open targets can only be trimmed by closed cutters (Clipper requirement
      // and geometrically meaningful only this way).
      if (closedCutters.length > 0) {
        const result = trimOpenTargetByClosedCutters(
          project,
          target,
          closedClipPaths,
          baseName,
          createDerivedFeature,
        )
        nextFeatures = result.features
        allDefinitions.push(...result.definitions)
      }
    } else {
      // Closed target. Start with the standard boolean difference for closed cutters,
      // then iteratively split the resulting pieces with each open cutter.
      let workingPieces: SketchFeature[] = []
      if (closedClipPaths.length > 0) {
        const subjectPaths = [flattenFeatureToClipperPath(target)]
        const polyTree = executeClipTree(subjectPaths, closedClipPaths, 2)
        const polyResult = collectDerivedFeaturesFromPolyTree(
          project,
          polyTree,
          target,
          target.operation,
          baseName,
          createDerivedFeature,
          sourceFeatures,
          segAnnotations,
        )
        workingPieces = polyResult.features
        allDefinitions.push(...polyResult.definitions)
      } else {
        workingPieces = [target]
      }

      for (const openCutter of openCutters) {
        const splitPieces: SketchFeature[] = []
        const pieceProject = { ...project, features: [...project.features, ...splitPieces] }
        for (const piece of workingPieces) {
          const splitResult = splitClosedFeatureByOpenCutter(
            pieceProject,
            piece,
            openCutter,
            baseName,
            createDerivedFeature,
          )
          if (splitResult.features.length > 0) {
            splitPieces.push(...splitResult.features)
            allDefinitions.push(...splitResult.definitions)
          } else {
            // No valid split (open cutter doesn't fully cross this piece). Keep piece.
            splitPieces.push(piece)
          }
        }
        workingPieces = splitPieces
      }

      // If workingPieces is the original target (no cutters applied or all failed),
      // emit nothing — the caller treats empty groups as no-op.
      if (workingPieces.length === 1 && workingPieces[0].id === target.id) {
        nextFeatures = []
      } else {
        nextFeatures = workingPieces
      }
    }

    const groupedFeatures: SketchFeature[] = []
    for (const feature of nextFeatures) {
      const uniqueFeature = {
        ...feature,
        name: uniqueName(feature.name, [...existingNames, ...groupedFeatures.map((entry) => entry.name)]),
      }
      groupedFeatures.push(uniqueFeature)
      existingNames.push(uniqueFeature.name)
    }
    groups.push({ sourceId: target.id, features: groupedFeatures })
  }

  return { groups, definitions: allDefinitions }
}

export function insertDerivedFeaturesAfterSources(
  features: SketchFeature[],
  groups: DerivedFeatureGroup[],
  removeIds: Set<string>,
): SketchFeature[] {
  const groupMap = new Map(groups.map((group) => [group.sourceId, group.features]))
  const nextFeatures: SketchFeature[] = []

  for (const feature of features) {
    if (!removeIds.has(feature.id)) {
      nextFeatures.push(feature)
    }
    const derived = groupMap.get(feature.id)
    if (derived?.length) {
      nextFeatures.push(...derived)
    }
  }

  return nextFeatures
}

export function insertDerivedFeatureTreeEntries(
  featureTree: FeatureTreeEntry[],
  features: SketchFeature[],
  groups: DerivedFeatureGroup[],
  removeIds: Set<string>,
): FeatureTreeEntry[] {
  const featureMap = new Map(features.map((feature) => [feature.id, feature]))
  const rootGroupMap = new Map(
    groups
      .filter((group) => {
        const source = featureMap.get(group.sourceId)
        return source?.folderId === null
      })
      .map((group) => [
        group.sourceId,
        group.features
          .filter((feature) => feature.folderId === null)
          .map((feature) => ({ type: 'feature', featureId: feature.id } as FeatureTreeEntry)),
      ]),
  )

  return featureTree.flatMap((entry) => {
    if (entry.type !== 'feature') {
      return [entry]
    }

    const appended = rootGroupMap.get(entry.featureId) ?? []
    if (removeIds.has(entry.featureId)) {
      return appended
    }

    return [entry, ...appended]
  })
}

export function selectedClosedFeaturesFromIds(project: Project, featureIds: string[]): SketchFeature[] {
  const resolved = resolvedFeatureMap(project)
  return featureIds
    .map((featureId) => resolved.get(featureId))
    .filter((feature): feature is NonNullable<typeof feature> => feature !== undefined)
    .map((feature) => feature as unknown as SketchFeature)
    .filter((feature) => feature.sketch.profile.closed)
}

export function previewOffsetFeaturesInternal(
  project: Project,
  featureIds: string[],
  distance: number,
  createDerivedFeature: DerivedFeatureFactory,
): { features: SketchFeature[]; definitions: FeatureDefinition[] } {
  const selectedFeatures = selectedClosedFeaturesFromIds(project, featureIds)
  if (selectedFeatures.length === 0 || Math.abs(distance) <= 1e-9) {
    return { features: [], definitions: [] }
  }

  const baseFeature = selectedFeatures[selectedFeatures.length - 1]
  const unionPaths = unionClipperPaths(selectedFeatures.map((feature) => flattenFeatureToClipperPath(feature)))
  const offsetPaths = offsetClipperPaths(unionPaths, distance * DEFAULT_CLIPPER_SCALE)
  const features: SketchFeature[] = []
  const definitions: FeatureDefinition[] = []

  for (const [index, path] of offsetPaths.entries()) {
    const profile = simplifyOffsetContour(path, selectedFeatures, distance)
    if (!profile) {
      continue
    }

    const operation: FeatureOperation = baseFeature.operation === 'model' ? 'add' : baseFeature.operation
    const nextProject = { ...project, features: [...project.features, ...features] }
    const result = createDerivedFeature(
      nextProject,
      baseFeature,
      profile,
      operation,
      uniqueName(index === 0 ? `${baseFeature.name} Offset` : `${baseFeature.name} Offset ${index + 1}`, [
        ...project.features.map((feature) => feature.name),
        ...features.map((feature) => feature.name),
      ]),
    )
    features.push(result.feature)
    definitions.push(result.definition)
  }

  return { features, definitions }
}

export function createDerivedFeature(
  project: Project,
  baseFeature: SketchFeature,
  profile: SketchProfile,
  operation: FeatureOperation,
  name: string,
): { feature: SketchFeature; definition: FeatureDefinition } {
  const id = nextUniqueGeneratedId(project, 'f')
  const { definitionId, definition } = createSnapshotDefinition(project, {
    profile,
    kind: inferFeatureKind(profile),
    operation,
  })
  const feature = normalizeFeatureZRange({
    id,
    name,
    kind: inferFeatureKind(profile),
    folderId: baseFeature.folderId,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: baseFeature.z_top,
    z_bottom: baseFeature.z_bottom,
    visible: true,
    locked: false,
    definitionId,
    transform: IDENTITY_MATRIX,
  } as SketchFeature & { definitionId?: string; transform?: Matrix2D })
  return { feature, definition }
}

export function previewOffsetFeatures(project: Project, featureIds: string[], distance: number): { features: SketchFeature[]; definitions: FeatureDefinition[] } {
  return previewOffsetFeaturesInternal(project, featureIds, distance, createDerivedFeature)
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

export function clearStaleConstraints(features: SketchFeature[], movedIds: Set<string>): SketchFeature[] {
  if (movedIds.size === 0) return features
  let anyChanged = false
  const featureById = new Map(features.map((f) => [f.id, f]))
  const resolveProfile = (target: { source: 'feature'; featureId: string } | { source: 'stock' }) =>
    target.source === 'feature'
      ? featureById.get(target.featureId)?.sketch.profile ?? null
      : null
  const next = features.map((feature) => {
    if (!movedIds.has(feature.id)) return feature
    const updatedConstraints = feature.sketch.constraints.map((c) => {
      if (c.type !== 'fixed_distance') return c
      if (c.is_invalid) return c
      const refFeatureId = c.reference_feature_id ?? c.segment_ids[0]
      const refFeature = refFeatureId ? featureById.get(refFeatureId) : null
      const result = rederiveConstraintGeometry(
        feature.sketch.profile,
        refFeature?.sketch.profile ?? null,
        c,
        resolveProfile,
      )
      if (result && result.isValid) {
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
        return {
          ...c,
          anchor_point: result.anchorPoint,
          reference_point: result.referencePoint,
          reference_segment: result.referenceSegment,
          is_invalid: false,
          error_message: undefined,
        }
      }
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
