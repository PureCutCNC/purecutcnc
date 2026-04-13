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

import type { Operation, Point, Project, SketchFeature } from '../../types/project'
import { expandFeatureGeometry } from '../../text'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import {
  checkMaxCutDepthWarning,
  flattenProfile,
  getOperationSafeZ,
  normalizeToolForProject,
  resolveDimensionRef,
  resolveFeatureZSpan,
} from './geometry'
import { pushRapidAndPlunge, retractToSafe } from './pocket'

function updateBounds(bounds: ToolpathBounds | null, point: ToolpathPoint): ToolpathBounds {
  if (!bounds) {
    return {
      minX: point.x,
      minY: point.y,
      minZ: point.z,
      maxX: point.x,
      maxY: point.y,
      maxZ: point.z,
    }
  }

  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    minZ: Math.min(bounds.minZ, point.z),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
    maxZ: Math.max(bounds.maxZ, point.z),
  }
}

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

function profileStartPoint(points: Point[], z: number): ToolpathPoint {
  const first = points[0] ?? { x: 0, y: 0 }
  return { x: first.x, y: first.y, z }
}

function toProfileCutMoves(points: Point[], z: number, closed: boolean): ToolpathMove[] {
  if (points.length < 2) {
    return []
  }

  const moves: ToolpathMove[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    moves.push({
      kind: 'cut',
      from: { x: points[index].x, y: points[index].y, z },
      to: { x: points[index + 1].x, y: points[index + 1].y, z },
    })
  }

  if (closed) {
    const first = points[0]
    const last = points[points.length - 1]
    if (first.x !== last.x || first.y !== last.y) {
      moves.push({
        kind: 'cut',
        from: { x: last.x, y: last.y, z },
        to: { x: first.x, y: first.y, z },
      })
    }
  }

  return moves
}

function buildCarveLevels(topZ: number, finalZ: number, stepdown: number, singlePass: boolean): number[] {
  if (singlePass || !(stepdown > 0) || finalZ >= topZ) {
    return [finalZ]
  }

  const levels: number[] = []
  let currentZ = topZ
  while (currentZ > finalZ) {
    currentZ = Math.max(finalZ, currentZ - stepdown)
    levels.push(currentZ)
    if (currentZ <= finalZ) {
      break
    }
  }
  return levels.length > 0 ? levels : [finalZ]
}

export function generateFollowLineToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'follow_line') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Only follow-line operations can be resolved by the carving generator'],
      bounds: null,
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Follow-line operation has no feature targets'],
      bounds: null,
    }
  }

  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['No tool assigned to this operation'],
      bounds: null,
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Tool diameter must be greater than zero'],
      bounds: null,
    }
  }

  if (!(operation.carveDepth > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Carve depth must be greater than zero'],
      bounds: null,
    }
  }

  const targetFeatures = operation.target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)
    .flatMap((feature) => expandFeatureGeometry(feature))

  const warnings: string[] = []
  const depthWarning = checkMaxCutDepthWarning(tool, operation.carveDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }

  if (targetFeatures.length !== operation.target.featureIds.length) {
    warnings.push('Some selected target features are missing')
  }

  if (targetFeatures.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...warnings, 'No valid target features were found for this follow-line operation'],
      bounds: null,
    }
  }

  const safeZ = getOperationSafeZ(project, targetFeatures.map((feature) => resolveFeatureZSpan(project, feature)))
  const moves: ToolpathMove[] = []
  let currentPosition: ToolpathPoint | null = null

  for (const feature of targetFeatures) {
    const flattened = flattenProfile(feature.sketch.profile)
    if (flattened.points.length < 2) {
      warnings.push(`${feature.name} does not contain enough geometry for follow-line carving`)
      continue
    }

    const topZ = resolveDimensionRef(project, feature.z_top)
    let carveZ = topZ - operation.carveDepth
    if (carveZ < 0) {
      warnings.push(`${feature.name} carve depth exceeds stock bottom; clamped to Z 0`)
      carveZ = 0
    }

    const cutLevels = buildCarveLevels(topZ, carveZ, operation.stepdown, operation.pass === 'finish')
    for (const levelZ of cutLevels) {
      const entryPoint = profileStartPoint(flattened.points, levelZ)
      currentPosition = pushRapidAndPlunge(moves, currentPosition, entryPoint, safeZ)
      const cutMoves = toProfileCutMoves(flattened.points, levelZ, flattened.closed)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      currentPosition = retractToSafe(moves, currentPosition, safeZ)
    }
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
  }
}
