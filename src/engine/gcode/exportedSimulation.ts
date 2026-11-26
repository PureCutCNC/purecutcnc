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

import { findOperationTool } from '../../toolPolicy'
import type { Operation, Project } from '../../types/project'
import { setupFrameForOperation } from '../setupOrientation'
import { DEFAULT_FLATTEN_ARC_STEP, normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import { exportGeometryTolerance } from '../../utils/units'
import type { GcodeParseStatus, ParsedArcMove, ParsedGcodeMove } from './gcodeMotionParser'
import { parseExportedMotion } from './motionDebug'
import { runPostProcessor } from './postprocessor'
import { pinRotaryAxis, type MachineDefinition, type PinnedMachineDefinition } from './types'
import { machineToProjectPoint } from './utils'

export interface ExportedSimulationResult {
  /** Stock-space toolpaths reconstructed from the exported machine program, keyed by operation ID. */
  paths: Map<string, ToolpathResult>
  /** Worst parse status across all exported operations ('failed' > 'unsupported' > 'verified'). */
  status: GcodeParseStatus
  /** Human-readable parser warnings encountered during parse. */
  warnings: string[]
  /** Structured postprocessor warnings (formatted via i18n in the UI). */
  postWarnings: ToolpathWarning[]
}

const STATUS_RANK: Record<GcodeParseStatus, number> = {
  verified: 0,
  unsupported: 1,
  failed: 2,
}

function worstStatus(a: GcodeParseStatus, b: GcodeParseStatus): GcodeParseStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a
}

function flattenParsedArcInMachineSpace(
  move: ParsedArcMove,
  tolerance: number,
): ToolpathPoint[] {
  const { from, to, center, clockwise } = move
  const radius = Math.hypot(from.x - center.x, from.y - center.y)
  if (!(radius > 1e-9)) {
    return [from, to]
  }

  const a0 = Math.atan2(from.y - center.y, from.x - center.x)
  const a1 = Math.atan2(to.y - center.y, to.x - center.x)
  let sweep = a1 - a0
  if (clockwise) {
    while (sweep >= 0) sweep -= Math.PI * 2
    if (Math.hypot(to.x - from.x, to.y - from.y) <= 1e-6) {
      sweep = -Math.PI * 2
    }
  } else {
    while (sweep <= 0) sweep += Math.PI * 2
    if (Math.hypot(to.x - from.x, to.y - from.y) <= 1e-6) {
      sweep = Math.PI * 2
    }
  }

  const absSweep = Math.abs(sweep)
  const chordStep = tolerance > 0 && tolerance < radius
    ? Math.min(DEFAULT_FLATTEN_ARC_STEP, 2 * Math.acos(1 - tolerance / radius))
    : DEFAULT_FLATTEN_ARC_STEP
  const steps = Math.max(1, Math.ceil(absSweep / Math.max(chordStep, 1e-3)))

  const points: ToolpathPoint[] = [from]
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps
    const angle = a0 + sweep * t
    const pt: ToolpathPoint = {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      z: from.z + (to.z - from.z) * t,
    }
    if (from.a !== undefined && to.a !== undefined) {
      pt.a = from.a + (to.a - from.a) * t
    } else if (from.a !== undefined) {
      pt.a = from.a
    }
    points.push(pt)
  }
  points.push(to)
  return points
}

function parsedMovesToStockMoves(
  parsedMoves: readonly ParsedGcodeMove[],
  project: Project,
  operation: Operation,
  definition: PinnedMachineDefinition,
): ToolpathMove[] {
  const setup = setupFrameForOperation(project, operation)
  const tolerance = exportGeometryTolerance(project.meta.units)
  const toStock = (point: ToolpathPoint): ToolpathPoint => (
    machineToProjectPoint(point, project.origin, definition, setup)
  )

  const moves: ToolpathMove[] = []
  for (const move of parsedMoves) {
    if (move.kind !== 'arc') {
      const from = toStock(move.from)
      const to = toStock(move.to)
      const isVerticalPlunge = move.kind === 'linear'
        && Math.abs(from.x - to.x) <= 1e-9
        && Math.abs(from.y - to.y) <= 1e-9
        && to.z < from.z - 1e-9
      moves.push({
        kind: move.kind === 'rapid' ? 'rapid' : isVerticalPlunge ? 'plunge' : 'cut',
        from,
        to,
      })
      continue
    }

    const machinePoints = flattenParsedArcInMachineSpace(move, tolerance)
    let prev = toStock(machinePoints[0])
    for (let i = 1; i < machinePoints.length; i += 1) {
      const next = toStock(machinePoints[i])
      moves.push({ kind: 'cut', from: prev, to: next })
      prev = next
    }
  }
  return moves
}

function computeMoveBounds(moves: readonly ToolpathMove[]): ToolpathBounds | null {
  if (moves.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const move of moves) {
    for (const pt of [move.from, move.to]) {
      if (pt.x < minX) minX = pt.x
      if (pt.y < minY) minY = pt.y
      if (pt.z < minZ) minZ = pt.z
      if (pt.x > maxX) maxX = pt.x
      if (pt.y > maxY) maxY = pt.y
      if (pt.z > maxZ) maxZ = pt.z
    }
  }
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

/**
 * Post-process each planned operation into the active machine's output
 * dialect, parse the emitted program back into motion, and transform it to
 * canonical stock coordinates so the simulator replays what the machine
 * actually receives (issue #1261).
 */
export function buildExportedSimulationPaths(args: {
  project: Project
  operations: readonly Operation[]
  plannedPaths: ReadonlyMap<string, ToolpathResult>
  definition: MachineDefinition
}): ExportedSimulationResult {
  const { project, operations, plannedPaths, definition } = args
  const pinnedDefinition = pinRotaryAxis(definition, project.stock)
  const paths = new Map<string, ToolpathResult>()
  const warnings: string[] = []
  const postWarnings: ToolpathWarning[] = []
  let status: GcodeParseStatus = 'verified'

  for (const operation of operations) {
    const planned = plannedPaths.get(operation.id)
    if (!planned) continue

    const rawTool = findOperationTool(project, operation)
    if (!rawTool) continue
    const tool = normalizeToolForProject(rawTool, project)

    const postResult = runPostProcessor({
      project,
      definition,
      operations: [{ operation, tool, toolpath: planned }],
      options: {
        emitToolChanges: false,
        emitCoolant: false,
        programName: operation.name,
      },
    })

    for (const warning of postResult.warnings) {
      postWarnings.push(warning)
    }

    if (!postResult.gcode.trim()) {
      status = worstStatus(status, 'failed')
      paths.set(operation.id, {
        operationId: operation.id,
        moves: [],
        warnings: planned.warnings,
        bounds: null,
      })
      continue
    }

    const parsed = parseExportedMotion(postResult.gcode, pinnedDefinition)
    status = worstStatus(status, parsed.status)
    for (const warning of parsed.warnings) {
      warnings.push(`${operation.name}: ${warning}`)
    }

    const moves = parsedMovesToStockMoves(parsed.moves, project, operation, pinnedDefinition)
    paths.set(operation.id, {
      operationId: operation.id,
      moves,
      warnings: planned.warnings,
      bounds: computeMoveBounds(moves),
    })
  }

  return { paths, status, warnings, postWarnings }
}
