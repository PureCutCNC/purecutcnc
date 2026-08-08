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

import type { Operation, Point } from '../../types/project'
import type { ToolpathMove, ToolpathPoint } from './types'
import { plungeLimitedFeedScale } from './entry'

export const TROCHOIDAL_ENTRY_STEPS_PER_REVOLUTION = 36
export const MAX_TROCHOIDAL_ENTRY_MOVES = 20_000

export interface TrochoidalOperationBudget {
  remainingPoints: number
}

export function trochoidalEntryStrategy(operation: Operation): 'helix' | 'plunge' {
  return operation.entryStrategy === 'plunge' ? 'plunge' : 'helix'
}

export function appendTrochoidalEntry(
  moves: ToolpathMove[],
  from: ToolpathPoint,
  entry: Point,
  center: Point,
  targetZ: number,
  orbitRadius: number,
  operation: Operation,
  angularDirection: 1 | -1,
): ToolpathPoint {
  const points = trochoidalEntryPoints(from, entry, center, targetZ, orbitRadius, operation, angularDirection)
  let current = from
  for (const next of points) {
    if (points.length === 1) {
      moves.push({ kind: targetZ < current.z ? 'plunge' : 'rapid', from: current, to: next, source: 'trochoidal-entry' })
    } else {
      const angle = Math.min(45, Math.max(0.1, operation.entryRampAngle ?? 5))
      moves.push({
        kind: 'lead_in',
        from: current,
        to: next,
        feedScale: plungeLimitedFeedScale(operation.feed, operation.plungeFeed, angle),
        source: 'trochoidal-entry',
      })
    }
    current = next
  }
  return current
}

/**
 * The entry helix bores the cavity the first orbit continues out of, so it must
 * share the orbit's angular direction exactly — a mismatch reverses the tool at
 * the handoff. `angularDirection` is therefore passed in rather than re-derived.
 */
export function trochoidalEntryPoints(
  from: ToolpathPoint,
  entry: Point,
  center: Point,
  targetZ: number,
  orbitRadius: number,
  operation: Operation,
  angularDirection: 1 | -1,
): ToolpathPoint[] {
  const target = { x: entry.x, y: entry.y, z: targetZ }
  if (targetZ >= from.z || trochoidalEntryStrategy(operation) === 'plunge') {
    return [target]
  }

  const angle = Math.min(45, Math.max(0.1, operation.entryRampAngle ?? 5))
  const pitch = 2 * Math.PI * orbitRadius * Math.tan(angle * Math.PI / 180)
  const revolutions = Math.max(1, Math.ceil((from.z - targetZ) / pitch))
  const steps = revolutions * TROCHOIDAL_ENTRY_STEPS_PER_REVOLUTION
  const startAngle = Math.atan2(entry.y - center.y, entry.x - center.x)
  const points: ToolpathPoint[] = []
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps
    const angleAtStep = startAngle + angularDirection * 2 * Math.PI * revolutions * progress
    points.push({
      x: center.x + Math.cos(angleAtStep) * orbitRadius,
      y: center.y + Math.sin(angleAtStep) * orbitRadius,
      z: from.z + (targetZ - from.z) * progress,
    })
  }
  return points
}

export function trochoidalEntryMoveCount(
  fromZ: number,
  targetZ: number,
  orbitRadius: number,
  operation: Operation,
): number {
  if (trochoidalEntryStrategy(operation) === 'plunge' || targetZ >= fromZ) return 0
  const angle = Math.min(45, Math.max(0.1, operation.entryRampAngle ?? 5))
  const pitch = 2 * Math.PI * orbitRadius * Math.tan(angle * Math.PI / 180)
  if (!(pitch > 0)) return MAX_TROCHOIDAL_ENTRY_MOVES + 1
  return Math.max(1, Math.ceil((fromZ - targetZ) / pitch)) * TROCHOIDAL_ENTRY_STEPS_PER_REVOLUTION
}
