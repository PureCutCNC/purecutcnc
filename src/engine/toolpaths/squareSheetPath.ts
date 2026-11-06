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

/**
 * The two square-blank rules a wrapped sheet path obeys after it is generated
 * (issue #1131). A round bar never reaches this module, so its paths stay
 * byte-identical.
 *
 * 1. **Travel at the corner envelope.** The sheet generators travel at the
 *    project's safe height, which clears a round bar but not a square blank's
 *    standing corners: a rapid that turns A, or moves along the bar over a
 *    section that is still square, sweeps the corner through the cutter. Every
 *    rapid that moves along the bar or turns, below the blank's travel height
 *    (`rotaryTravelZ`, the corner radius + 1 mm), is lifted to it: up, across
 *    at the height, and straight down where it was going. A vertical rapid is
 *    left alone — it stays over the turned section the cut is on.
 * 2. **The cutter stays over the turned section.** The targets were admitted
 *    with their band grown by the cutter radius; a lead-in, ramp or link can
 *    still reach past it. Every move below the travel height is checked along
 *    the bar, grown by the cutter radius, against the round sections Turns
 *    above the targets made, and a path that leaves them is refused.
 */

import type { Operation, Project } from '../../types/project'
import { isSquareStock } from '../../types/barStock'
import { buildSurfaceIndex } from '../../store/helpers/rotarySurface'
import {
  squareSheetRangesBlock,
  squareSheetToolReach,
  type SquareSheetBlock,
} from '../../store/helpers/turnedSheet'
import type { WorldBand } from '../../store/helpers/rotarySurface'
import { rotaryTravelZ } from './squareRotaryStock'
import type { ToolpathMove, ToolpathPoint, ToolpathResult } from './types'

/** Slack below which a coordinate change is no movement. */
const MOVE_EPSILON = 1e-9

function along(point: ToolpathPoint, axis: 'x' | 'y'): number {
  return axis === 'x' ? point.x : point.y
}

/**
 * True when a rapid moves along the bar or turns it. The turn is judged from
 * the angle the controller is at — where the previous move left it, unknown at
 * the operation's start — not only from the rapid's own two ends, because the
 * emitter commands the rapid's end angle from there (`trackOperationAngle` in
 * `gcode/motionPipeline.ts` reads it the same way).
 */
function travels(move: ToolpathMove, axis: 'x' | 'y', controllerA: number | null): boolean {
  const turned = move.to.a !== undefined
    && (controllerA === null || Math.abs(move.to.a - controllerA) > MOVE_EPSILON
      || (move.from.a !== undefined && Math.abs(move.to.a - move.from.a) > MOVE_EPSILON))
  return turned || Math.abs(along(move.to, axis) - along(move.from, axis)) > MOVE_EPSILON
}

/**
 * Rule 1: every travelling rapid below `travelZ` goes up to it, across at it,
 * and back down. The operation's first rapid has no known angle before it, so
 * it starts at the height instead of rising to it at an unknown angle. The
 * rise keeps the angle the controller is at, so only the move at the height
 * turns. Returns the input itself when nothing is lifted.
 */
export function liftSquareSheetTravel<T extends ToolpathResult>(
  result: T,
  axis: 'x' | 'y',
  travelZ: number,
): T {
  const moves: ToolpathMove[] = []
  const collisions = new Set(result.collidingMoveIndices)
  const collidingMoveIndices: number[] = []
  let controllerA: number | null = null
  let lifted = false
  result.moves.forEach((move, index) => {
    const first = moves.length
    if (move.kind !== 'rapid' || !travels(move, axis, controllerA) || Math.min(move.from.z, move.to.z) >= travelZ) {
      moves.push(move)
    } else {
      lifted = true
      const held = controllerA === null ? move.from : { ...move.from, ...(move.from.a !== undefined ? { a: controllerA } : {}) }
      const up = { ...held, z: Math.max(move.from.z, travelZ) }
      const over = { ...move.to, z: Math.max(move.to.z, travelZ) }
      if (controllerA !== null && up.z !== move.from.z) moves.push({ ...move, from: held, to: up })
      moves.push({ ...move, from: up, to: over })
      if (over.z !== move.to.z) moves.push({ ...move, from: over, to: move.to })
    }
    if (move.to.a !== undefined) controllerA = move.to.a
    if (collisions.has(index)) {
      for (let added = first; added < moves.length; added += 1) collidingMoveIndices.push(added)
    }
  })
  if (!lifted) return result
  const liftedResult: T = { ...result, moves, bounds: boundsOf(moves) }
  if (result.collidingMoveIndices) liftedResult.collidingMoveIndices = collidingMoveIndices
  return liftedResult
}

function boundsOf(moves: readonly ToolpathMove[]): ToolpathResult['bounds'] {
  if (moves.length === 0) return null
  const bounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  }
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      bounds.minX = Math.min(bounds.minX, point.x)
      bounds.minY = Math.min(bounds.minY, point.y)
      bounds.minZ = Math.min(bounds.minZ, point.z)
      bounds.maxX = Math.max(bounds.maxX, point.x)
      bounds.maxY = Math.max(bounds.maxY, point.y)
      bounds.maxZ = Math.max(bounds.maxZ, point.z)
    }
  }
  return bounds
}

/**
 * Rule 2: why a wrapped sheet path's cutter leaves the round sections, or null
 * while it stays on them. Every move is judged for the **highest** target in
 * the tree — the one with the fewest Turns above it — so no move can rely on a
 * Turn that sits below some of the work.
 *
 * A move is not tagged with the target it cuts, and guessing that from
 * distance is not safe: an outside route with stock to leave, a lead or a ramp
 * can run well clear of its own feature and closer to another, and would then
 * borrow a Turn that is below its real target (#1131 review). The cost is that
 * one operation whose targets sit under different Turns, with one of those
 * Turns between them in the tree, is refused; one operation per Turn cuts.
 */
export function squareSheetPathBlock(
  project: Project,
  operation: Pick<Operation, 'target' | 'toolRef'>,
  result: ToolpathResult,
): SquareSheetBlock | null {
  if (!isSquareStock(project.stock)) return null
  const index = buildSurfaceIndex(project)
  if (!index) return 'uncut'
  const target = operation.target
  if (target.source !== 'features' || target.featureIds.length === 0) return 'uncut'
  const orders = target.featureIds.map((id) => project.features.findIndex((feature) => feature.id === id))
  if (orders.some((order) => order < 0)) return 'uncut'
  const before = Math.min(...orders)
  const reach = squareSheetToolReach(project, operation)
  const travelZ = rotaryTravelZ(project.stock, project.meta.units)
  const axis = project.stock.axis
  const ranges: WorldBand[] = []
  for (const move of result.moves) {
    if (Math.min(move.from.z, move.to.z) >= travelZ) continue
    const first = along(move.from, axis)
    const second = along(move.to, axis)
    ranges.push({ min: Math.min(first, second) - reach, max: Math.max(first, second) + reach })
  }
  return squareSheetRangesBlock(project, index, ranges, before)
}

/** The travel height a square sheet path is lifted to (rule 1). */
export function squareSheetTravelZ(project: Project): number | null {
  return isSquareStock(project.stock) ? rotaryTravelZ(project.stock, project.meta.units) : null
}
