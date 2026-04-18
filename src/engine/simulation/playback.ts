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

import type { ToolType } from '../../types/project'
import type { ToolpathMove } from '../toolpaths/types'
import { applyMoveToGrid } from './replay'
import type { SimulationGrid } from './types'

export interface PlaybackToolInfo {
  toolType: ToolType
  toolRadius: number
  vBitAngle: number | null
}

export interface PlaybackOptions {
  /**
   * Upper bound on the length of any single move used during playback. Longer moves
   * are split into equal sub-segments before replay, which keeps the moves-per-frame
   * throttle meaningful regardless of how coarse the source toolpath is.
   * Pass 0 or a negative value to disable subdivision.
   */
  maxSegmentLength?: number
}

export interface PlaybackPose {
  x: number
  y: number
  z: number
  moveKind: ToolpathMove['kind'] | null
}

export function cloneSimulationGrid(source: SimulationGrid): SimulationGrid {
  return { ...source, topZ: new Float32Array(source.topZ) }
}

function moveLength(move: ToolpathMove): number {
  const dx = move.to.x - move.from.x
  const dy = move.to.y - move.from.y
  const dz = move.to.z - move.from.z
  return Math.hypot(dx, dy, dz)
}

function interpolatePoint(move: ToolpathMove, fraction: number): { x: number; y: number; z: number } {
  return {
    x: move.from.x + (move.to.x - move.from.x) * fraction,
    y: move.from.y + (move.to.y - move.from.y) * fraction,
    z: move.from.z + (move.to.z - move.from.z) * fraction,
  }
}

function isCuttingMove(move: ToolpathMove): boolean {
  return move.kind === 'cut' || move.kind === 'plunge' || move.kind === 'lead_in' || move.kind === 'lead_out'
}

/**
 * Split any move longer than `maxSegmentLength` into equal-length sub-segments.
 * Splitting is semantically safe because `applyMoveToGrid` removes material based on
 * distance-to-segment, and the sub-segments' swept volumes union to the original.
 */
export function subdivideMoves(moves: ToolpathMove[], maxSegmentLength: number): ToolpathMove[] {
  if (!(maxSegmentLength > 0) || moves.length === 0) {
    return moves.slice()
  }

  const out: ToolpathMove[] = []
  for (const move of moves) {
    const length = moveLength(move)
    if (length <= maxSegmentLength + 1e-9) {
      out.push(move)
      continue
    }
    const subdivisions = Math.ceil(length / maxSegmentLength)
    for (let i = 0; i < subdivisions; i += 1) {
      const t0 = i / subdivisions
      const t1 = (i + 1) / subdivisions
      out.push({
        kind: move.kind,
        from: interpolatePoint(move, t0),
        to: interpolatePoint(move, t1),
      })
    }
  }
  return out
}

export class PlaybackController {
  readonly baseGrid: SimulationGrid
  readonly liveGrid: SimulationGrid
  readonly moves: ToolpathMove[]
  readonly tool: PlaybackToolInfo
  readonly totalPathLength: number

  private moveIndex = 0
  private moveFraction = 0
  private distanceTraveled = 0
  private finished = false
  private lastMoveApplied = -1

  constructor(
    baseGrid: SimulationGrid,
    moves: ToolpathMove[],
    tool: PlaybackToolInfo,
    options: PlaybackOptions = {},
  ) {
    this.baseGrid = baseGrid
    this.liveGrid = cloneSimulationGrid(baseGrid)
    const maxSegmentLength = options.maxSegmentLength ?? Math.max(tool.toolRadius * 1.5, 0.5)
    this.moves = subdivideMoves(moves, maxSegmentLength)
    this.tool = tool
    this.totalPathLength = this.moves.reduce((sum, move) => sum + moveLength(move), 0)

    if (this.moves.length === 0) {
      this.finished = true
    }
  }

  reset(): void {
    this.liveGrid.topZ.set(this.baseGrid.topZ)
    this.moveIndex = 0
    this.moveFraction = 0
    this.distanceTraveled = 0
    this.finished = this.moves.length === 0
    this.lastMoveApplied = -1
  }

  isFinished(): boolean {
    return this.finished
  }

  getDistanceTraveled(): number {
    return this.distanceTraveled
  }

  getMoveIndex(): number {
    return this.moveIndex
  }

  getMoveCount(): number {
    return this.moves.length
  }

  getPose(): PlaybackPose {
    if (this.moves.length === 0) {
      return { x: 0, y: 0, z: 0, moveKind: null }
    }

    if (this.finished) {
      const last = this.moves[this.moves.length - 1]
      return { x: last.to.x, y: last.to.y, z: last.to.z, moveKind: last.kind }
    }

    const move = this.moves[this.moveIndex]
    const p = interpolatePoint(move, this.moveFraction)
    return { x: p.x, y: p.y, z: p.z, moveKind: move.kind }
  }

  /**
   * Advance the tool by `distance` along the path, applying cuts as we go.
   * `distance` is interpreted in project units — the caller is responsible for
   * throttling it (e.g., `min(speed * dt, maxStepPerFrame)`) before each call.
   * Whether that distance spans one long move partially or many short moves
   * fully is opaque to the caller; either way the cumulative cut is correct.
   */
  advance(distance: number): boolean {
    if (this.finished || distance <= 0) {
      return false
    }

    let remaining = distance
    let gridChanged = false

    while (remaining > 0 && !this.finished) {
      const move = this.moves[this.moveIndex]
      const length = moveLength(move)

      if (length <= 1e-9) {
        if (isCuttingMove(move) && this.lastMoveApplied !== this.moveIndex) {
          const changed = applyMoveToGrid(
            this.liveGrid,
            move,
            this.tool.toolRadius,
            this.tool.toolType,
            this.tool.vBitAngle,
          )
          if (changed > 0) {
            gridChanged = true
          }
          this.lastMoveApplied = this.moveIndex
        }
        this.advanceToNextMove()
        continue
      }

      const traveled = length * this.moveFraction
      const available = length - traveled

      if (remaining >= available) {
        if (isCuttingMove(move) && this.lastMoveApplied !== this.moveIndex) {
          const changed = applyMoveToGrid(
            this.liveGrid,
            move,
            this.tool.toolRadius,
            this.tool.toolType,
            this.tool.vBitAngle,
          )
          if (changed > 0) {
            gridChanged = true
          }
          this.lastMoveApplied = this.moveIndex
        }
        this.distanceTraveled += available
        remaining -= available
        this.advanceToNextMove()
      } else {
        const prevFraction = this.moveFraction
        const nextFraction = prevFraction + remaining / length

        if (isCuttingMove(move)) {
          const prevPoint = interpolatePoint(move, prevFraction)
          const nextPoint = interpolatePoint(move, nextFraction)
          const partial: ToolpathMove = {
            kind: move.kind,
            from: prevPoint,
            to: nextPoint,
          }
          const changed = applyMoveToGrid(
            this.liveGrid,
            partial,
            this.tool.toolRadius,
            this.tool.toolType,
            this.tool.vBitAngle,
          )
          if (changed > 0) {
            gridChanged = true
          }
        }

        this.moveFraction = nextFraction
        this.distanceTraveled += remaining
        remaining = 0
      }
    }

    return gridChanged
  }

  seekToDistance(target: number): boolean {
    const clampedTarget = Math.max(0, Math.min(this.totalPathLength, target))
    this.reset()
    if (clampedTarget <= 0) {
      return false
    }
    return this.advance(clampedTarget)
  }

  seekToFraction(fraction: number): boolean {
    return this.seekToDistance(fraction * this.totalPathLength)
  }

  private advanceToNextMove(): void {
    this.moveIndex += 1
    this.moveFraction = 0
    if (this.moveIndex >= this.moves.length) {
      this.moveIndex = this.moves.length - 1
      this.moveFraction = 1
      this.finished = true
    }
  }
}
