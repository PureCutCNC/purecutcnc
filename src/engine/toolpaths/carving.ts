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

import type { Operation, Point, Project } from '../../types/project'
import { isTrochoidalCarve } from '../../types/project'
import type { ToolpathWarning } from './warningCodes'
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
import { resolveRegionDomainCurve } from './regionDomain'
import { buildRegionMask, splitFeatureTargets } from './regions'
import { helixAngularDirection } from './entry'
import { buildTrochoidalContour, DEFAULT_TROCHOIDAL_POINT_BUDGET } from './trochoidalEdge'
import {
  appendTrochoidalEntry,
  MAX_TROCHOIDAL_ENTRY_MOVES,
  trochoidalEntryMoveCount,
  type TrochoidalOperationBudget,
} from './trochoidalPath'

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

/**
 * Returns true when any of the seven fatal carve-trochoidal warning codes is
 * present.  When true the operation must refuse to emit moves — an all-or-nothing
 * result matching the edge-route contract.
 */
function hasFatalCarveTrochoidalWarning(warnings: ToolpathWarning[]): boolean {
  return warnings.some((warning) => (
    warning.code === 'carveTrochoidalNeedsConstantDiameterTool'
    || warning.code === 'carveTrochoidalWidthTooSmall'
    || warning.code === 'carveTrochoidalAdvanceRange'
    || warning.code === 'carveTrochoidalEntryStrategyUnsupported'
    || warning.code === 'carveTrochoidalInvalidGuide'
    || warning.code === 'carveTrochoidalMoveBudget'
    || warning.code === 'carveTrochoidalEntryBudget'
  ))
}

interface PreparedCarvePath {
  built: ReturnType<typeof buildTrochoidalContour>
  z: number
  entryStartZ: number
  closed: boolean
}

export function generateFollowLineToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'follow_line') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'carveWrongKind' }],
      bounds: null,
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'carveNoTargets' }],
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
      warnings: [{ code: 'noToolAssigned' }],
      bounds: null,
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'toolDiameterPositive' }],
      bounds: null,
    }
  }

  if (!(operation.carveDepth > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'carveDepthPositive' }],
      bounds: null,
    }
  }

  const isTrochoidal = isTrochoidalCarve(operation)

  // -- Trochoidal guards (fail closed) ---------------------------------------
  if (isTrochoidal) {
    // A V-bit has no constant cutting diameter, so R = (W − D) / 2 computed
    // from its nominal diameter produces a groove that is wrong at every Z.
    // Check the raw toolRecord.type before normalizeToolForProject unit
    // handling changes nothing about type.
    if (toolRecord.type === 'v_bit') {
      return {
        operationId: operation.id,
        moves: [],
        warnings: [{ code: 'carveTrochoidalNeedsConstantDiameterTool' }],
        bounds: null,
      }
    }

    const cutWidth = operation.trochoidalCutWidth ?? tool.diameter * 1.5
    if (!(cutWidth >= tool.diameter * 1.15)) {
      return {
        operationId: operation.id,
        moves: [],
        warnings: [{ code: 'carveTrochoidalWidthTooSmall' }],
        bounds: null,
      }
    }

    const advanceFraction = operation.trochoidalAdvance ?? 0.1
    if (!(advanceFraction > 0 && advanceFraction <= 1)) {
      return {
        operationId: operation.id,
        moves: [],
        warnings: [{ code: 'carveTrochoidalAdvanceRange' }],
        bounds: null,
      }
    }

    if (operation.entryStrategy !== undefined && operation.entryStrategy !== 'helix' && operation.entryStrategy !== 'plunge') {
      return {
        operationId: operation.id,
        moves: [],
        warnings: [{ code: 'carveTrochoidalEntryStrategyUnsupported' }],
        bounds: null,
      }
    }
  }

  const splitTargets = splitFeatureTargets(project, operation.target.featureIds)
  const regionMask = buildRegionMask(splitTargets.regionFeatures)
  const targetFeatures = splitTargets.machiningFeatures
    .flatMap((feature) => expandFeatureGeometry(feature))

  const warnings: ToolpathWarning[] = []
  const depthWarning = checkMaxCutDepthWarning(tool, operation.carveDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }

  if (targetFeatures.length !== splitTargets.machiningFeatures.length || splitTargets.missingFeatureIds.length > 0) {
    warnings.push({ code: 'targetsMissing' })
  }

  if (targetFeatures.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...warnings, { code: 'carveNoValidTargets' }],
      bounds: null,
    }
  }

  // -- Non-fatal trochoidal width warnings -----------------------------------
  if (isTrochoidal) {
    const cutWidth = operation.trochoidalCutWidth ?? tool.diameter * 1.5
    if (cutWidth < tool.diameter * 1.25) {
      warnings.push({ code: 'carveTrochoidalWidthNarrow' })
    }
    if (cutWidth > tool.diameter * 2) {
      warnings.push({ code: 'carveTrochoidalWidthLeavesCore' })
    }
  }

  const safeZ = getOperationSafeZ(project, targetFeatures.map((feature) => resolveFeatureZSpan(project, feature)))
  const moves: ToolpathMove[] = []
  let currentPosition: ToolpathPoint | null = null

  // Follow-line's guide is the tool-centre path — no further erosion happens —
  // so both polarities dilate the region by centreInset in resolveRegionDomainCurve.
  // Under trochoidal the swept half-width replaces the tool radius, so the wider
  // channel still lands the tool centre on the region boundary.
  const cutWidth = isTrochoidal ? (operation.trochoidalCutWidth ?? tool.diameter * 1.5) : 0
  const sweptHalfWidth = isTrochoidal ? cutWidth / 2 : tool.radius
  const centreInset = sweptHalfWidth + Math.max(0, operation.stockToLeaveRadial ?? 0)

  // Derived once and shared by both the orbit and the entry helix.  The entry
  // helix bores the cavity the first orbit continues out of, so deriving the
  // direction at two independent sites would risk a reversal at the handoff.
  // 'internal' is the correct cut side: a slot is a channel with material on
  // both sides.
  const orbitRadius = isTrochoidal ? (cutWidth - tool.diameter) / 2 : 0
  const advanceFraction = isTrochoidal ? (operation.trochoidalAdvance ?? 0.1) : 0
  const advance = isTrochoidal ? advanceFraction * tool.diameter : 0
  const angularDirection = isTrochoidal
    ? helixAngularDirection(operation.cutDirection ?? 'conventional', 'internal')
    : (1 as 1 | -1)

  // One budget per operation, threaded through every target and every fragment.
  const budget: TrochoidalOperationBudget | undefined = isTrochoidal
    ? { remainingPoints: DEFAULT_TROCHOIDAL_POINT_BUDGET }
    : undefined

  for (const feature of targetFeatures) {
    const flattened = flattenProfile(feature.sketch.profile)
    if (flattened.points.length < 2) {
      warnings.push({ code: 'carveNotEnoughGeometry', params: { name: feature.name } })
      continue
    }

    // Fragment the guide polyline by the region mask before generation.
    const fragments = resolveRegionDomainCurve(flattened.points, flattened.closed, regionMask, centreInset)
    if (fragments.length === 0) continue

    const topZ = resolveDimensionRef(project, feature.z_top)
    let carveZ = topZ - operation.carveDepth
    if (carveZ < 0) {
      warnings.push({ code: 'carveDepthClamped', params: { name: feature.name } })
      carveZ = 0
    }

    const cutLevels = buildCarveLevels(topZ, carveZ, operation.stepdown, operation.pass === 'finish')

    if (isTrochoidal) {
      // ---- Trochoidal branch ------------------------------------------------
      // Prepare every fragment at every level first, then append moves.
      // A bad guide or a budget overflow must not leave a partially cut slot.
      const prepared: PreparedCarvePath[] = []
      let remainingPoints = budget!.remainingPoints
      let preparationFailed = false

      for (const fragment of fragments) {
        if (preparationFailed) break
        let previousZ = topZ
        for (const levelZ of cutLevels) {
          const entryStartZ = previousZ
          const entryMoves = trochoidalEntryMoveCount(entryStartZ, levelZ, orbitRadius, operation)
          const fragX = fragment.points[0]?.x ?? 0
          const fragY = fragment.points[0]?.y ?? 0

          if (entryMoves > MAX_TROCHOIDAL_ENTRY_MOVES || entryMoves + 3 >= remainingPoints) {
            warnings.push({ code: 'carveTrochoidalEntryBudget', params: { x: fragX, y: fragY } })
            preparationFailed = true
            break
          }

          const built = buildTrochoidalContour(fragment.points, {
            orbitRadius,
            advance,
            toolDiameter: tool.diameter,
            angularDirection,
            closed: fragment.closed,
            maxPoints: remainingPoints - entryMoves - 3,
          })

          if (built.error || built.points.length < 2 || !built.entryCenter) {
            warnings.push({
              code: built.error === 'move-budget' ? 'carveTrochoidalMoveBudget' : 'carveTrochoidalInvalidGuide',
              params: { x: fragX, y: fragY },
            })
            preparationFailed = true
            break
          }

          const consumedPoints = entryMoves + built.points.length + 3
          if (consumedPoints > remainingPoints) {
            warnings.push({ code: 'carveTrochoidalMoveBudget', params: { x: fragX, y: fragY } })
            preparationFailed = true
            break
          }

          remainingPoints -= consumedPoints
          prepared.push({ built, z: levelZ, entryStartZ, closed: fragment.closed })
          previousZ = levelZ
        }
      }

      budget!.remainingPoints = remainingPoints

      if (hasFatalCarveTrochoidalWarning(warnings)) {
        return { operationId: operation.id, moves: [], warnings, bounds: null }
      }

      // Append phase — per prepared path.
      for (const path of prepared) {
        const { built, z, entryStartZ, closed } = path
        const entry = built.points[0]

        // Skip retract when the tool is already at the entry XY (successive
        // levels of the same fragment).  For the first level of a fragment the
        // tool must retract, rapid across, and plunge.
        const sameEntry = currentPosition
          && Math.abs(currentPosition.x - entry.x) <= 1e-9
          && Math.abs(currentPosition.y - entry.y) <= 1e-9

        if (!sameEntry) {
          currentPosition = retractToSafe(moves, currentPosition, safeZ)
          const rapidFrom = currentPosition ?? { x: entry.x, y: entry.y, z: safeZ }
          const rapidTo = { x: entry.x, y: entry.y, z: safeZ }
          if (!currentPosition || rapidFrom.x !== rapidTo.x || rapidFrom.y !== rapidTo.y) {
            moves.push({ kind: 'rapid', from: rapidFrom, to: rapidTo, source: 'trochoidal-transition' })
          }
          currentPosition = rapidTo
          if (entryStartZ < safeZ) {
            const surfacePoint = { x: entry.x, y: entry.y, z: entryStartZ }
            moves.push({ kind: 'plunge', from: currentPosition, to: surfacePoint, source: 'trochoidal-transition' })
            currentPosition = surfacePoint
          }
        }

        if (Math.abs((currentPosition as ToolpathPoint).z - z) > 1e-9) {
          currentPosition = appendTrochoidalEntry(
            moves,
            currentPosition as ToolpathPoint,
            entry,
            built.entryCenter as Point,
            z,
            orbitRadius,
            operation,
            angularDirection,
          )
        }

        const cutMoves = toProfileCutMoves(built.points, z, closed)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }
    } else {
      // ---- Direct mode (unchanged from pre-trochoidal) ----------------------
      for (const fragment of fragments) {
        for (const levelZ of cutLevels) {
          const entryPoint = profileStartPoint(fragment.points, levelZ)
          currentPosition = pushRapidAndPlunge(moves, currentPosition, entryPoint, safeZ)
          const cutMoves = toProfileCutMoves(fragment.points, levelZ, fragment.closed)
          moves.push(...cutMoves)
          currentPosition = cutMoves.at(-1)?.to ?? currentPosition
          currentPosition = retractToSafe(moves, currentPosition, safeZ)
        }
      }
    }
  }

  if (isTrochoidal && hasFatalCarveTrochoidalWarning(warnings)) {
    return { operationId: operation.id, moves: [], warnings, bounds: null }
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
  }
}
