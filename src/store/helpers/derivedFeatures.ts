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
import { DEFAULT_CLIPPER_SCALE, fromClipperPath } from '../../engine/toolpaths/geometry'
import { uniqueName } from '../../import'
import type {
  FeatureOperation,
  FeatureTreeEntry,
  Point,
  Project,
  SketchFeature,
  SketchProfile,
} from '../../types/project'
import { polygonProfile } from '../../types/project'
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
) => SketchFeature

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
): SketchFeature[] {
  const created: SketchFeature[] = []
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
        [...project.features.map((feature) => feature.name), ...created.map((feature) => feature.name)],
      )
      const nextProject = { ...project, features: [...project.features, ...created] }
      created.push(createDerivedFeature(nextProject, baseFeature, profile, operation, name))
    }
  }

  for (const child of getClipperChildren(node)) {
    created.push(...collectDerivedFeaturesFromPolyTree(
      { ...project, features: [...project.features, ...created] },
      child,
      baseFeature,
      baseOperation,
      baseName,
      createDerivedFeature,
      sourceFeatures,
      segAnnotations,
      nextContourDepth,
    ))
  }

  return created
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
): SketchFeature[] {
  const result = splitClosedByOpen(target.sketch.profile, openCutter.sketch.profile)
  if (!result || result.pieces.length < 2) return []

  const knownCircles = collectKnownCircles([target, openCutter])
  const created: SketchFeature[] = []
  for (const piece of result.pieces) {
    const profile = knownCircles.length > 0
      ? reconstructArcsInProfile(piece, knownCircles, Math.PI / 4)
      : polygonProfile(piece)
    const name = uniqueName(baseName, [
      ...project.features.map((f) => f.name),
      ...created.map((f) => f.name),
    ])
    created.push(createDerivedFeature(
      { ...project, features: [...project.features, ...created] },
      target,
      profile,
      target.operation,
      name,
    ))
  }
  return created
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
): SketchFeature[] {
  if (closedClipPaths.length === 0) return []
  const targetPath = flattenOpenFeatureToClipperPath(target, DEFAULT_CLIPPER_SCALE)
  const clipper = new ClipperLib.Clipper()
  // Open subject path.
  ;(clipper as any).AddPath(targetPath, ClipperLib.PolyType.ptSubject, false)
  for (const clip of closedClipPaths) {
    ;(clipper as any).AddPath(clip, ClipperLib.PolyType.ptClip, true)
  }
  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  const openPaths: Point[][] = []
  const openPathsRaw = (ClipperLib.Clipper as any).OpenPathsFromPolyTree(polyTree)
  for (const path of openPathsRaw) {
    if (!path || path.length < 2) continue
    openPaths.push(fromClipperPath(path, DEFAULT_CLIPPER_SCALE))
  }

  if (openPaths.length === 0) return []

  const created: SketchFeature[] = []
  for (const points of openPaths) {
    if (points.length < 2) continue
    const profile: SketchProfile = {
      start: points[0],
      segments: points.slice(1).map((p) => ({ type: 'line' as const, to: p })),
      closed: false,
    }
    const name = uniqueName(baseName, [
      ...project.features.map((f) => f.name),
      ...created.map((f) => f.name),
    ])
    created.push(createDerivedFeature(
      { ...project, features: [...project.features, ...created] },
      target,
      profile,
      target.operation,
      name,
    ))
  }
  return created
}

export function cutFeaturesByCutterGrouped(
  project: Project,
  cutters: SketchFeature[],
  targets: SketchFeature[],
  createDerivedFeature: DerivedFeatureFactory,
): DerivedFeatureGroup[] {
  const closedCutters = cutters.filter((c) => c.sketch.profile.closed)
  const openCutters = cutters.filter((c) => !c.sketch.profile.closed)
  const closedClipPaths = closedCutters.map((cutter) => flattenFeatureToClipperPath(cutter))
  const existingNames = [...project.features.map((feature) => feature.name)]
  const groups: DerivedFeatureGroup[] = []

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
        nextFeatures = trimOpenTargetByClosedCutters(
          project,
          target,
          closedClipPaths,
          baseName,
          createDerivedFeature,
        )
      }
    } else {
      // Closed target. Start with the standard boolean difference for closed cutters,
      // then iteratively split the resulting pieces with each open cutter.
      let workingPieces: SketchFeature[]
      if (closedClipPaths.length > 0) {
        const subjectPaths = [flattenFeatureToClipperPath(target)]
        const polyTree = executeClipTree(subjectPaths, closedClipPaths, 2)
        workingPieces = collectDerivedFeaturesFromPolyTree(
          project,
          polyTree,
          target,
          target.operation,
          baseName,
          createDerivedFeature,
          sourceFeatures,
          segAnnotations,
        )
      } else {
        workingPieces = [target]
      }

      for (const openCutter of openCutters) {
        const splitPieces: SketchFeature[] = []
        const pieceProject = { ...project, features: [...project.features, ...splitPieces] }
        for (const piece of workingPieces) {
          const result = splitClosedFeatureByOpenCutter(
            pieceProject,
            piece,
            openCutter,
            baseName,
            createDerivedFeature,
          )
          if (result.length > 0) {
            splitPieces.push(...result)
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

  return groups
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
  return featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)
    .filter((feature) => feature.sketch.profile.closed)
}

export function previewOffsetFeatures(
  project: Project,
  featureIds: string[],
  distance: number,
  createDerivedFeature: DerivedFeatureFactory,
): SketchFeature[] {
  const selectedFeatures = selectedClosedFeaturesFromIds(project, featureIds)
  if (selectedFeatures.length === 0 || Math.abs(distance) <= 1e-9) {
    return []
  }

  const baseFeature = selectedFeatures[selectedFeatures.length - 1]
  const unionPaths = unionClipperPaths(selectedFeatures.map((feature) => flattenFeatureToClipperPath(feature)))
  const offsetPaths = offsetClipperPaths(unionPaths, distance * DEFAULT_CLIPPER_SCALE)
  const createdFeatures: SketchFeature[] = []

  for (const [index, path] of offsetPaths.entries()) {
    const profile = simplifyOffsetContour(path, selectedFeatures, distance)
    if (!profile) {
      continue
    }

    const operation: FeatureOperation = baseFeature.operation === 'model' ? 'add' : baseFeature.operation
    const nextProject = { ...project, features: [...project.features, ...createdFeatures] }
    createdFeatures.push(createDerivedFeature(
      nextProject,
      baseFeature,
      profile,
      operation,
      uniqueName(index === 0 ? `${baseFeature.name} Offset` : `${baseFeature.name} Offset ${index + 1}`, [
        ...project.features.map((feature) => feature.name),
        ...createdFeatures.map((feature) => feature.name),
      ]),
    ))
  }

  return createdFeatures
}
