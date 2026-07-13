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

import { isConstruction } from '../../store/helpers/featureRoles'
import { resolvedFeatureMap } from '../../store/helpers/resolveFeatures'
import type { Operation, Project } from '../../types/project'
import type { PocketToolpathResult, ToolpathBounds, ToolpathPoint, ToolpathResult } from './types'

interface MergeToolpathOptions {
  orderBlocks?: 'input' | 'nearest'
}

interface IndexedToolpathPart<T extends ToolpathResult> {
  part: T
  originalIndex: number
  start: ToolpathPoint
  end: ToolpathPoint
}

export function perFeatureOperations(operation: Operation, project?: Project): Operation[] {
  if (operation.target.source !== 'features') return [operation]
  if (operation.target.featureIds.length <= 1) return [operation]
  const featuresById = project ? resolvedFeatureMap(project) : null
  const regionFeatureIds = featuresById
    ? operation.target.featureIds.filter((featureId) => (
      featuresById.get(featureId)?.operation === 'region'
    ))
    : []
  // Construction geometry is neither a machining target nor a region mask —
  // drop it from the per-feature split entirely (issue #199).
  const constructionFeatureIds = featuresById
    ? operation.target.featureIds.filter((featureId) => {
      const feature = featuresById.get(featureId)
      return feature !== undefined && isConstruction(feature)
    })
    : []
  const machiningFeatureIds = operation.target.featureIds.filter(
    (featureId) => !regionFeatureIds.includes(featureId) && !constructionFeatureIds.includes(featureId),
  )
  if (machiningFeatureIds.length <= 1) return [operation]
  return machiningFeatureIds.map((featureId) => ({
    ...operation,
    target: { source: 'features', featureIds: [featureId, ...regionFeatureIds] },
  }))
}

export function isFeatureFirst(operation: Operation): boolean {
  if ((operation.machiningOrder ?? 'level_first') !== 'feature_first') return false
  if (operation.target.source !== 'features') return false
  return operation.target.featureIds.length > 1
}

function mergeBounds(a: ToolpathBounds | null, b: ToolpathBounds | null): ToolpathBounds | null {
  if (!a) return b
  if (!b) return a
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  }
}

function blockStart(part: ToolpathResult): ToolpathPoint | null {
  const firstMove = part.moves[0]
  if (!firstMove) return null
  if (firstMove.kind === 'rapid') return firstMove.to
  return firstMove.from
}

function blockEnd(part: ToolpathResult): ToolpathPoint | null {
  return part.moves.at(-1)?.to ?? null
}

function xyDistanceSquared(a: ToolpathPoint, b: ToolpathPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dx * dx + dy * dy
}

function samePoint(a: ToolpathPoint, b: ToolpathPoint): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

function orderPartsByNearestBlock<T extends ToolpathResult>(parts: T[]): T[] {
  const blocks = parts.reduce<IndexedToolpathPart<T>[]>((acc, part, originalIndex) => {
    const start = blockStart(part)
    const end = blockEnd(part)
    if (start && end) acc.push({ part, originalIndex, start, end })
    return acc
  }, [])
  if (blocks.length <= 1) return parts

  const ordered: IndexedToolpathPart<T>[] = [blocks[0]]
  const remaining = blocks.slice(1)
  let current = blocks[0].end

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = xyDistanceSquared(current, remaining[0].start)
    for (let i = 1; i < remaining.length; i += 1) {
      const distance = xyDistanceSquared(current, remaining[i].start)
      if (
        distance < bestDistance
        || (distance === bestDistance && remaining[i].originalIndex < remaining[bestIndex].originalIndex)
      ) {
        bestIndex = i
        bestDistance = distance
      }
    }

    const [next] = remaining.splice(bestIndex, 1)
    ordered.push(next)
    current = next.end
  }

  return ordered.map((block) => block.part)
}

function mergeMoves(parts: ToolpathResult[], normalizeTransitions: boolean): ToolpathResult['moves'] {
  if (!normalizeTransitions) return parts.flatMap((part) => part.moves)

  const moves: ToolpathResult['moves'] = []
  let previousEnd: ToolpathPoint | null = null

  for (const part of parts) {
    if (part.moves.length === 0) continue

    const [firstMove, ...remainingMoves] = part.moves
    if (previousEnd && !samePoint(previousEnd, firstMove.from)) {
      if (firstMove.kind === 'rapid') {
        moves.push({ ...firstMove, from: previousEnd })
      } else {
        moves.push({ kind: 'rapid', from: previousEnd, to: firstMove.from })
        moves.push(firstMove)
      }
    } else {
      moves.push(firstMove)
    }
    moves.push(...remainingMoves)
    previousEnd = part.moves.at(-1)?.to ?? previousEnd
  }

  return moves
}

export function mergeToolpathResults(
  operationId: string,
  parts: ToolpathResult[],
  options: MergeToolpathOptions = {},
): ToolpathResult {
  const orderedParts = options.orderBlocks === 'nearest' ? orderPartsByNearestBlock(parts) : parts
  const moves = mergeMoves(orderedParts, options.orderBlocks === 'nearest')
  const warnings = parts.flatMap((part) => part.warnings)
  const bounds = parts.reduce<ToolpathBounds | null>((acc, part) => mergeBounds(acc, part.bounds), null)
  const collidingClampIds = Array.from(
    new Set(parts.flatMap((part) => part.collidingClampIds ?? [])),
  )
  return {
    operationId,
    moves,
    warnings,
    bounds,
    ...(collidingClampIds.length > 0 ? { collidingClampIds } : {}),
  }
}

export function mergePocketToolpathResults(
  operationId: string,
  parts: PocketToolpathResult[],
  options: MergeToolpathOptions = {},
): PocketToolpathResult {
  const base = mergeToolpathResults(operationId, parts, options)
  const stepLevels = Array.from(new Set(parts.flatMap((part) => part.stepLevels)))
    .sort((a, b) => b - a)
  return { ...base, stepLevels }
}
