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

import { DEFAULT_CLIPPER_SCALE } from '../../engine/toolpaths/geometry'
import { uniqueName } from '../../import'
import type {
  FeatureOperation,
  FeatureTreeEntry,
  Project,
  SketchFeature,
  SketchProfile,
} from '../../types/project'
import {
  clipperContourToProfile,
  executeClipTree,
  flattenFeatureToClipperPath,
  getClipperChildren,
  offsetClipperPaths,
  type ClipperPolyNode,
  unionClipperPaths,
} from './clipping'

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
  contourDepth = 0,
): SketchFeature[] {
  const created: SketchFeature[] = []
  const contour = node.Contour()
  const nextContourDepth = contour.length > 0 ? contourDepth + 1 : contourDepth

  if (contour.length > 0) {
    const profile = clipperContourToProfile(contour)
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
      nextContourDepth,
    ))
  }

  return created
}

export function cutFeaturesByCutterGrouped(
  project: Project,
  cutter: SketchFeature,
  targets: SketchFeature[],
  createDerivedFeature: DerivedFeatureFactory,
): DerivedFeatureGroup[] {
  const clipPaths = [flattenFeatureToClipperPath(cutter)]
  const existingNames = [...project.features.map((feature) => feature.name)]
  const groups: DerivedFeatureGroup[] = []

  for (const target of targets) {
    const subjectPaths = [flattenFeatureToClipperPath(target)]
    const polyTree = executeClipTree(subjectPaths, clipPaths, 2)
    const cutNameStem = normalizeDerivedFeatureNameStem(target.name)
    const nextFeatures = collectDerivedFeaturesFromPolyTree(
      project,
      polyTree,
      target,
      target.operation,
      `${cutNameStem} Cut`,
      createDerivedFeature,
    )

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
    const profile = clipperContourToProfile(path)
    if (!profile) {
      continue
    }

    const nextProject = { ...project, features: [...project.features, ...createdFeatures] }
    createdFeatures.push(createDerivedFeature(
      nextProject,
      baseFeature,
      profile,
      baseFeature.operation,
      uniqueName(index === 0 ? `${baseFeature.name} Offset` : `${baseFeature.name} Offset ${index + 1}`, [
        ...project.features.map((feature) => feature.name),
        ...createdFeatures.map((feature) => feature.name),
      ]),
    ))
  }

  return createdFeatures
}
