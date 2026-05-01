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
import type { Operation, Point, Project, SketchFeature } from '../../types/project'
import { expandFeatureGeometry, featureHasClosedGeometry } from '../../text'
import type { ClipperPath, ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  applyContourDirection,
  checkMaxCutDepthWarning,
  flattenProfile,
  fromClipperPath,
  getOperationSafeZ,
  normalizeToolForProject,
  normalizeWinding,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import { isFeatureFirst, mergeToolpathResults, perFeatureOperations } from './multiFeature'
import { buildInsetRegions, buildOuterContours, cutClosedContours, resolveBandBottomZ } from './pocket'
import { resolveInsideEdgeRegions } from './resolver'

function offsetPaths(paths: ClipperPath[], delta: number): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  return solution as ClipperPath[]
}

function unionPaths(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ClipperPath[]
}

function contourStartPoint(points: Point[], z: number): ToolpathPoint {
  const first = points[0] ?? { x: 0, y: 0 }
  return { x: first.x, y: first.y, z }
}

function toClosedCutMoves(points: Point[], z: number): ToolpathMove[] {
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

  const first = points[0]
  const last = points[points.length - 1]
  if (first.x !== last.x || first.y !== last.y) {
    moves.push({
      kind: 'cut',
      from: { x: last.x, y: last.y, z },
      to: { x: first.x, y: first.y, z },
    })
  }

  return moves
}

function pushRapidAndPlunge(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  toXY: ToolpathPoint,
  safeZ: number,
): ToolpathPoint {
  const start = from ?? { x: toXY.x, y: toXY.y, z: safeZ }

  if (!from || from.x !== toXY.x || from.y !== toXY.y || from.z !== safeZ) {
    moves.push({
      kind: 'rapid',
      from: start,
      to: { x: toXY.x, y: toXY.y, z: safeZ },
    })
  }

  moves.push({
    kind: 'plunge',
    from: { x: toXY.x, y: toXY.y, z: safeZ },
    to: toXY,
  })

  return toXY
}

function retractToSafe(moves: ToolpathMove[], from: ToolpathPoint | null, safeZ: number): ToolpathPoint | null {
  if (!from) {
    return null
  }

  const safePoint = { x: from.x, y: from.y, z: safeZ }
  if (from.z !== safeZ) {
    moves.push({
      kind: 'rapid',
      from,
      to: safePoint,
    })
  }
  return safePoint
}

function transitionToCutEntry(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  toXY: ToolpathPoint,
  safeZ: number,
  maxLinkDistance: number,
): ToolpathPoint {
  // Vertical-only move at same XY — no retraction needed
  if (from && from.x === toXY.x && from.y === toXY.y) {
    if (from.z === toXY.z) {
      return toXY
    }
    moves.push({
      kind: toXY.z < from.z ? 'plunge' : 'rapid',
      from,
      to: toXY,
    })
    return toXY
  }

  if (from) {
    const dx = toXY.x - from.x
    const dy = toXY.y - from.y
    const distance = Math.hypot(dx, dy)

    if (distance === 0) {
      return toXY
    }

    if (distance <= maxLinkDistance) {
      // Direct cut link — works across Z levels for 3D ramping
      moves.push({
        kind: 'cut',
        from,
        to: toXY,
      })
      return toXY
    }
  }

  const safePosition = retractToSafe(moves, from, safeZ)
  return pushRapidAndPlunge(moves, safePosition, toXY, safeZ)
}

function generateStepLevels(topZ: number, bottomZ: number, stepdown: number): number[] {
  if (!(stepdown > 0)) {
    return [bottomZ]
  }

  const descending = bottomZ < topZ
  if (!descending) {
    return [bottomZ]
  }

  const levels: number[] = []
  let current = topZ
  while (current - stepdown > bottomZ) {
    current -= stepdown
    levels.push(current)
  }
  levels.push(bottomZ)
  return levels
}

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

function flattenFeatureToClipperPath(feature: SketchFeature): ClipperPath {
  const flattened = flattenProfile(feature.sketch.profile)
  // Clipper normalises closed paths to CCW in Y-up (its outer-polygon convention) regardless
  // of the winding supplied here, so the input orientation does not affect offset output.
  return toClipperPath(normalizeWinding(flattened.points, true), DEFAULT_CLIPPER_SCALE)
}

function resolveContourPaths(paths: ClipperPath[], offsetDistance: number): Point[][] {
  const offset = offsetPaths(paths, offsetDistance * DEFAULT_CLIPPER_SCALE)
  return offset
    .map((entry) => fromClipperPath(entry))
    .filter((points) => points.length >= 3)
}

function resolveEffectiveBottom(feature: SketchFeature, project: Project, operation: Operation): number | null {
  const span = resolveFeatureZSpan(project, feature)
  const descending = span.bottom < span.top
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  const effectiveBottom = descending
    ? span.bottom + axialLeave
    : span.bottom - axialLeave

  if (descending && effectiveBottom >= span.top) {
    return null
  }

  if (!descending && effectiveBottom <= span.top) {
    return null
  }

  return effectiveBottom
}

function depthValuesMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-6
}

function appendContoursAtLevels(
  moves: ToolpathMove[],
  currentPosition: ToolpathPoint | null,
  contours: Point[][],
  levels: number[],
  safeZ: number,
  maxLinkDistance: number,
): ToolpathPoint | null {
  let nextPosition = currentPosition

  for (const z of levels) {
    for (const contour of contours) {
      const entryPoint = contourStartPoint(contour, z)
      nextPosition = transitionToCutEntry(moves, nextPosition, entryPoint, safeZ, maxLinkDistance)
      const cutMoves = toClosedCutMoves(contour, z)
      moves.push(...cutMoves)
      nextPosition = cutMoves.at(-1)?.to ?? nextPosition
    }
  }

  return nextPosition
}

export function generateEdgeRouteToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'edge_route_inside' && operation.kind !== 'edge_route_outside') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Only edge-route operations can be resolved by the edge-route generator'],
      bounds: null,
    }
  }

  if (isFeatureFirst(operation)) {
    const parts = perFeatureOperations(operation).map((subOp) =>
      generateEdgeRouteToolpathSingle(project, subOp),
    )
    return mergeToolpathResults(operation.id, parts)
  }
  return generateEdgeRouteToolpathSingle(project, operation)
}

function generateEdgeRouteToolpathSingle(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'edge_route_inside' && operation.kind !== 'edge_route_outside') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Only edge-route operations can be resolved by the edge-route generator'],
      bounds: null,
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Edge-route operation has no feature targets'],
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

  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Operation stepdown must be greater than zero'],
      bounds: null,
    }
  }

  const expectedFeatureOperation = operation.kind === 'edge_route_inside' ? 'subtract' : 'add'
  const targetFeatures = operation.target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === expectedFeatureOperation || feature.operation === 'region')

  const warnings: string[] = []
  const maxFeatureDepth = targetFeatures.reduce((max, feature) => {
    const span = resolveFeatureZSpan(project, feature)
    return Math.max(max, span.height)
  }, 0)
  const depthWarning = checkMaxCutDepthWarning(tool, maxFeatureDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }

  if (targetFeatures.length !== operation.target.featureIds.length) {
    warnings.push(`Some selected target features are missing or are not ${expectedFeatureOperation}/region features`)
  }

  const closedTargetFeatures = targetFeatures.filter((feature) => featureHasClosedGeometry(feature))
  if (closedTargetFeatures.length !== targetFeatures.length) {
    warnings.push('Edge-route operations only support closed target profiles')
  }

  if (closedTargetFeatures.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...warnings, 'No valid target features were found for this edge-route operation'],
      bounds: null,
    }
  }

  const safeZ = getOperationSafeZ(project)
  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const offsetDistance =
    operation.kind === 'edge_route_inside'
      ? -(tool.radius + radialLeave)
      : tool.radius + radialLeave

  const moves: ToolpathMove[] = []
  let currentPosition: ToolpathPoint | null = null
  const maxLinkDistance = tool.diameter
  const direction = operation.cutDirection ?? 'conventional'
  // Clipper's ClipperOffset always normalises closed-polygon paths to CCW in machine
  // Y-up coords (isClockwise=false) before applying the delta, so the output is always
  // CCW regardless of input winding.  CCW in Y-up = conventional for INSIDE cuts but
  // = climb for OUTSIDE cuts (where conventional requires CW in Y-up, isClockwise=true).
  // Invert the requested direction for outside so applyContourDirection maps correctly.
  const outsideDirection = (direction === 'conventional' ? 'climb' : 'conventional') as typeof direction

  if (operation.kind === 'edge_route_inside') {
    const resolved = resolveInsideEdgeRegions(project, operation)
    warnings.push(...resolved.warnings)
    const insideInset = tool.radius + radialLeave

    for (const band of resolved.bands) {
      const effectiveBottom = resolveBandBottomZ(band, operation)
      if (effectiveBottom === null) {
        warnings.push(`Band ${band.topZ} -> ${band.bottomZ} leaves no cut depth after axial stock-to-leave`)
        continue
      }

      const insetRegions = band.regions.flatMap((region) => buildInsetRegions(region, insideInset))
      const rawContours = buildOuterContours(insetRegions)
      if (rawContours.length === 0) {
        warnings.push(`No valid inside contour could be generated for band ${band.topZ} -> ${band.bottomZ}`)
        continue
      }

      const contours = applyContourDirection(rawContours, direction)
      const levels =
        operation.pass === 'finish'
          ? [effectiveBottom]
          : generateStepLevels(band.topZ, effectiveBottom, operation.stepdown)

      for (const z of levels) {
        currentPosition = cutClosedContours(moves, contours, z, safeZ, maxLinkDistance, currentPosition)
      }
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)

    let bounds: ToolpathBounds | null = null
    for (const move of moves) {
      bounds = updateBounds(bounds, move.from)
      bounds = updateBounds(bounds, move.to)
    }

    return {
      operationId: operation.id,
      moves,
      warnings,
      bounds,
    }
  }

  const routableTargets = closedTargetFeatures
    .map((feature) => {
      const effectiveBottom = resolveEffectiveBottom(feature, project, operation)
      if (effectiveBottom === null) {
        warnings.push(`${feature.name} leaves no cut depth after axial stock-to-leave`)
        return null
      }

      const span = resolveFeatureZSpan(project, feature)
      return {
        feature,
        contourPath: flattenFeatureToClipperPath(feature),
        topZ: span.top,
        bottomZ: effectiveBottom,
      }
    })
    .filter((entry): entry is { feature: SketchFeature; contourPath: ClipperPath; topZ: number; bottomZ: number } => entry !== null)

  if (routableTargets.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...warnings, 'No valid target features were found for this edge-route operation'],
      bounds: null,
    }
  }

  const shouldAttemptCombinedOutside = operation.kind === 'edge_route_outside' && routableTargets.length > 1
  if (shouldAttemptCombinedOutside) {
    const referenceTarget = routableTargets[0]
    const canCombineOutsideTargets = routableTargets.every((target) => (
      depthValuesMatch(target.topZ, referenceTarget.topZ)
      && depthValuesMatch(target.bottomZ, referenceTarget.bottomZ)
    ))

    if (canCombineOutsideTargets) {
      const rawContours = resolveContourPaths(
        unionPaths(routableTargets.map((target) => target.contourPath)),
        offsetDistance,
      )

      if (rawContours.length === 0) {
        warnings.push('No valid combined outer contour could be generated for the selected outside edge targets')
      } else {
        const contours = applyContourDirection(rawContours, outsideDirection)
        const levels =
          operation.pass === 'finish'
            ? [referenceTarget.bottomZ]
            : generateStepLevels(referenceTarget.topZ, referenceTarget.bottomZ, operation.stepdown)

        currentPosition = appendContoursAtLevels(moves, currentPosition, contours, levels, safeZ, maxLinkDistance)
      }
    } else {
      warnings.push(
        'Selected outside edge targets have different effective depth spans. Combined outside routing is not supported for mixed-depth targets yet; generating separate contours may cut internal overlap. Split the operation by depth or align target tops/bottoms.',
      )
    }
  }

  if (moves.length === 0) {
    for (const target of routableTargets) {
      const rawContours = resolveContourPaths([target.contourPath], offsetDistance)
      if (rawContours.length === 0) {
        warnings.push(`No valid contour could be generated for ${target.feature.name}`)
        continue
      }

      const contours = applyContourDirection(rawContours, outsideDirection)
      const levels =
        operation.pass === 'finish'
          ? [target.bottomZ]
          : generateStepLevels(target.topZ, target.bottomZ, operation.stepdown)

      currentPosition = appendContoursAtLevels(moves, currentPosition, contours, levels, safeZ, maxLinkDistance)
    }
  }

  currentPosition = retractToSafe(moves, currentPosition, safeZ)

  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds,
  }
}
