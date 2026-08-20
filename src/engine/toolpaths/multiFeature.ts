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
import { xyDistanceSquared } from './geometry'

interface MergeToolpathOptions {
  orderBlocks?: 'input' | 'nearest'
}

export interface ToolpathSection<T extends ToolpathResult = ToolpathResult> {
  /** Stable strategy-local identifier used by precedence constraints. */
  id: string
  /** The complete emitted section, including its safe-Z entry and exit moves. */
  result: T
  /** Safe-Z point targeted by the section's initial rapid. */
  entry: ToolpathPoint
  /** Point reached after the section's final move. */
  exit: ToolpathPoint
  /** Section identifiers that must be completed before this section. */
  predecessors?: readonly string[]
}

export interface ToolpathSectionOrderOptions {
  /** Reference position for choosing the first section. Omit to preserve the first eligible input section. */
  start?: ToolpathPoint | null
}

interface IndexedToolpathSection<T extends ToolpathResult> {
  section: ToolpathSection<T>
  originalIndex: number
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

export function isFeatureFirst(operation: Operation, project?: Project): boolean {
  if ((operation.machiningOrder ?? 'level_first') !== 'feature_first') return false
  if (operation.target.source !== 'features') return false
  if (operation.target.featureIds.length <= 1) return false
  // V-carve operations that target a closed line must be processed together
  // — line-line even-odd fill cannot survive when targets are split across
  // separate per-feature sub-operations (issue #340). This applies only when
  // a line target is actually present: other v-carve targets (e.g. multiple
  // disjoint subtracts) still split per feature as usual.
  if (operation.kind === 'v_carve' || operation.kind === 'v_carve_medial') {
    // Without a project we cannot inspect the targets — be safe, don't split.
    if (!project) return false
    const featuresById = resolvedFeatureMap(project)
    const hasLineTarget = operation.target.featureIds.some(
      (id) => featuresById.get(id)?.operation === 'line',
    )
    if (hasLineTarget) return false
  }
  return true
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

function samePoint(a: ToolpathPoint, b: ToolpathPoint): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z
}

/**
 * Select the nearest section whose declared predecessors have completed.
 *
 * Only XY distance participates in the choice: transitions run at safe Z, so
 * changing Z does not make an otherwise farther XY section preferable. Exact
 * ties retain source order, making repeated generation deterministic.
 */
export function orderToolpathSections<T extends ToolpathResult>(
  sections: readonly ToolpathSection<T>[],
  options: ToolpathSectionOrderOptions = {},
): ToolpathSection<T>[] {
  const ids = new Set<string>()
  for (const section of sections) {
    if (ids.has(section.id)) {
      throw new Error(`Duplicate toolpath section id: ${section.id}`)
    }
    ids.add(section.id)
  }
  for (const section of sections) {
    for (const predecessor of section.predecessors ?? []) {
      if (!ids.has(predecessor)) {
        throw new Error(`Unknown predecessor ${predecessor} for toolpath section ${section.id}`)
      }
    }
  }
  const remaining = sections.map<IndexedToolpathSection<T>>((section, originalIndex) => ({
    section,
    originalIndex,
  }))
  const completed = new Set<string>()
  const ordered: ToolpathSection<T>[] = []
  let current = options.start ?? null

  while (remaining.length > 0) {
    const eligible = remaining.filter(({ section }) =>
      (section.predecessors ?? []).every((predecessor) => completed.has(predecessor)),
    )
    if (eligible.length === 0) {
      throw new Error('Toolpath section precedence constraints contain a cycle')
    }

    let chosen = eligible[0]
    if (current) {
      let bestDistance = xyDistanceSquared(current, chosen.section.entry)
      for (const candidate of eligible.slice(1)) {
        const distance = xyDistanceSquared(current, candidate.section.entry)
        if (distance < bestDistance || (distance === bestDistance && candidate.originalIndex < chosen.originalIndex)) {
          chosen = candidate
          bestDistance = distance
        }
      }
    }

    ordered.push(chosen.section)
    completed.add(chosen.section.id)
    current = chosen.section.exit
    remaining.splice(remaining.indexOf(chosen), 1)
  }

  return ordered
}

function safeTravelSectionForResult<T extends ToolpathResult>(
  result: T,
  originalIndex: number,
): ToolpathSection<T> | null {
  const firstMove = result.moves[0]
  const exit = result.moves.at(-1)?.to
  // A shared safe-travel transition can only replace a section's entry rapid.
  // If a legacy caller provides another shape, preserve its input order rather
  // than manufacturing a potentially unsafe transition.
  if (!firstMove || firstMove.kind !== 'rapid' || !exit) return null
  return {
    id: `result-${originalIndex}`,
    result,
    entry: firstMove.to,
    exit,
  }
}

function hasMatchingSectionEndpoints(section: ToolpathSection): boolean {
  const firstMove = section.result.moves[0]
  const lastMove = section.result.moves.at(-1)
  return firstMove?.kind === 'rapid'
    && lastMove !== undefined
    && samePoint(firstMove.to, section.entry)
    && samePoint(lastMove.to, section.exit)
}

function appendSafeTravelTransition(
  moves: ToolpathResult['moves'],
  from: ToolpathPoint,
  entry: ToolpathPoint,
): void {
  const travelZ = Math.max(from.z, entry.z)
  let current = from
  const lift = { x: current.x, y: current.y, z: travelZ }
  if (!samePoint(current, lift)) {
    moves.push({ kind: 'rapid', from: current, to: lift })
    current = lift
  }

  const across = { x: entry.x, y: entry.y, z: travelZ }
  if (!samePoint(current, across)) {
    moves.push({ kind: 'rapid', from: current, to: across })
    current = across
  }

  if (!samePoint(current, entry)) {
    moves.push({ kind: 'rapid', from: current, to: entry })
  }
}

function mergeOrderedSections(sections: readonly ToolpathSection[]): ToolpathResult['moves'] {
  const moves: ToolpathResult['moves'] = []
  let previousEnd: ToolpathPoint | null = null

  for (const section of sections) {
    const [firstMove, ...remainingMoves] = section.result.moves
    if (!firstMove) continue

    if (previousEnd && !samePoint(previousEnd, firstMove.from)) {
      appendSafeTravelTransition(moves, previousEnd, section.entry)
    } else {
      moves.push(firstMove)
    }
    moves.push(...remainingMoves)
    previousEnd = section.result.moves.at(-1)?.to ?? previousEnd
  }

  return moves
}

function combinedToolpathResult(
  operationId: string,
  parts: readonly ToolpathResult[],
  moves: ToolpathResult['moves'],
): ToolpathResult {
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

export function mergeToolpathSections(
  operationId: string,
  sections: readonly ToolpathSection[],
  options: ({ order?: 'input' | 'nearest' } & ToolpathSectionOrderOptions) = {},
): ToolpathResult {
  for (const section of sections) {
    if (!hasMatchingSectionEndpoints(section)) {
      throw new Error(`Toolpath section ${section.id} must declare its initial rapid target and final endpoint`)
    }
  }
  const ordered = options.order === 'nearest'
    ? orderToolpathSections(sections, options)
    : [...sections]
  const parts = ordered.map((section) => section.result)
  return combinedToolpathResult(
    operationId,
    parts,
    options.order === 'nearest' ? mergeOrderedSections(ordered) : parts.flatMap((part) => part.moves),
  )
}

export function mergeToolpathResults(
  operationId: string,
  parts: ToolpathResult[],
  options: MergeToolpathOptions = {},
): ToolpathResult {
  if (options.orderBlocks !== 'nearest') {
    return combinedToolpathResult(operationId, parts, parts.flatMap((part) => part.moves))
  }

  const sections = parts.flatMap((part, originalIndex) => {
    const section = safeTravelSectionForResult(part, originalIndex)
    return section ? [section] : []
  })
  // An unrecognised section shape cannot prove a safe-Z entry point. Keep the
  // established input order instead of guessing a retract or rapid transition.
  if (sections.length !== parts.filter((part) => part.moves.length > 0).length) {
    return combinedToolpathResult(operationId, parts, parts.flatMap((part) => part.moves))
  }

  const ordered = orderToolpathSections(sections)
  return combinedToolpathResult(operationId, parts, mergeOrderedSections(ordered))
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
