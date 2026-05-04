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

import type { Operation, Project } from '../../types/project'
import type { PocketToolpathResult, ToolpathBounds, ToolpathResult } from './types'

export function perFeatureOperations(operation: Operation, project?: Project): Operation[] {
  if (operation.target.source !== 'features') return [operation]
  if (operation.target.featureIds.length <= 1) return [operation]
  const regionFeatureIds = project
    ? operation.target.featureIds.filter((featureId) => (
      project.features.find((feature) => feature.id === featureId)?.operation === 'region'
    ))
    : []
  const machiningFeatureIds = operation.target.featureIds.filter((featureId) => !regionFeatureIds.includes(featureId))
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

export function mergeToolpathResults(operationId: string, parts: ToolpathResult[]): ToolpathResult {
  const moves = parts.flatMap((part) => part.moves)
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
): PocketToolpathResult {
  const base = mergeToolpathResults(operationId, parts)
  const stepLevels = Array.from(new Set(parts.flatMap((part) => part.stepLevels)))
    .sort((a, b) => b - a)
  return { ...base, stepLevels }
}
