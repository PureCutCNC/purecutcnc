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
import type { DirtyRegion, SimulationGrid } from './types'

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
  /**
   * Reference cut feed (project-units-per-second) that maps to the caller's "1×"
   * pace. When set, `advance`'s distance argument is treated as a reference-feed
   * budget: moves whose real feed is below the reference (reduced slot-feed cuts,
   * slower plunges) consume the budget faster than they cover geometry, so the
   * tool visibly slows on them. Omit (or pass 0) for legacy constant-speed
   * playback where every move advances at the caller's pace.
   */
  referenceFeedPerSecond?: number
  /**
   * Plunge feed (project-units-per-second), used only when referenceFeedPerSecond
   * is set, so plunge moves play at their real (usually slower) feed. Omit to play
   * plunges at the reference pace.
   */
  plungeFeedPerSecond?: number
}

export interface PlaybackPose {
  x: number
  y: number
  z: number
  moveKind: ToolpathMove['kind'] | null
  /** feedScale of the current move (undefined when the move has none, i.e. 1×).
   *  Lets the readout show the reduced feed on slotting pocket cuts. */
  feedScale: number | undefined
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
      // Spread the source move so per-move metadata (feedScale, source) rides
      // along to each sub-segment — otherwise the live feed readout loses the
      // reduced slot feed on subdivided cuts.
      out.push({
        ...move,
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
  private frameDirtyRegion: DirtyRegion | null = null
  private readonly referenceFeedPerSecond: number
  private readonly plungeFeedPerSecond: number

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
    this.referenceFeedPerSecond = options.referenceFeedPerSecond && options.referenceFeedPerSecond > 0
      ? options.referenceFeedPerSecond
      : 0
    this.plungeFeedPerSecond = options.plungeFeedPerSecond && options.plungeFeedPerSecond > 0
      ? options.plungeFeedPerSecond
      : 0

    if (this.moves.length === 0) {
      this.finished = true
    }
  }

  /**
   * Feed of `move` relative to the reference cut feed, in (0, 1]-ish units.
   * The tool covers `ratio × budget` geometric distance per unit of the
   * advance budget, so a lower ratio means slower on-screen motion. Returns 1
   * (no scaling) when no reference feed was supplied or for rapids. Cut moves
   * fold their slot-feed reduction straight in via feedScale; plunges use the
   * plunge/reference ratio. Clamped to a small floor to avoid div-by-zero.
   */
  private feedRatioForMove(move: ToolpathMove): number {
    if (this.referenceFeedPerSecond <= 0) return 1
    let ratio: number
    switch (move.kind) {
      case 'cut':
      case 'lead_in':
      case 'lead_out':
        ratio = move.feedScale ?? 1
        break
      case 'plunge':
        ratio = this.plungeFeedPerSecond > 0 ? this.plungeFeedPerSecond / this.referenceFeedPerSecond : 1
        break
      default:
        ratio = 1
    }
    return ratio > 1e-3 ? ratio : 1e-3
  }

  reset(): void {
    this.liveGrid.topZ.set(this.baseGrid.topZ)
    this.moveIndex = 0
    this.moveFraction = 0
    this.distanceTraveled = 0
    this.finished = this.moves.length === 0
    this.lastMoveApplied = -1
    // Restoring the base grid can RAISE cells (un-cut them), which per-move cut
    // tracking never reports — so a reset dirties the whole grid. Callers that
    // upload the dirty region to the GPU pick this up like any other change.
    this.frameDirtyRegion = {
      colMin: 0,
      colMax: this.liveGrid.cols - 1,
      rowMin: 0,
      rowMax: this.liveGrid.rows - 1,
    }
  }

  /**
   * Cells whose heights may have changed since the last `clearDirtyRegion()`.
   * Accumulates across `advance`/`seek*`/`reset` calls until cleared, so the
   * caller controls the upload cadence (typically once per rendered frame).
   */
  getDirtyRegion(): DirtyRegion | null {
    return this.frameDirtyRegion
  }

  clearDirtyRegion(): void {
    this.frameDirtyRegion = null
  }

  private expandDirtyRegion(region: DirtyRegion): void {
    if (this.frameDirtyRegion === null) {
      this.frameDirtyRegion = { ...region }
    } else {
      this.frameDirtyRegion.colMin = Math.min(this.frameDirtyRegion.colMin, region.colMin)
      this.frameDirtyRegion.colMax = Math.max(this.frameDirtyRegion.colMax, region.colMax)
      this.frameDirtyRegion.rowMin = Math.min(this.frameDirtyRegion.rowMin, region.rowMin)
      this.frameDirtyRegion.rowMax = Math.max(this.frameDirtyRegion.rowMax, region.rowMax)
    }
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
      return { x: 0, y: 0, z: 0, moveKind: null, feedScale: undefined }
    }

    if (this.finished) {
      const last = this.moves[this.moves.length - 1]
      return { x: last.to.x, y: last.to.y, z: last.to.z, moveKind: last.kind, feedScale: last.feedScale }
    }

    const move = this.moves[this.moveIndex]
    const p = interpolatePoint(move, this.moveFraction)
    return { x: p.x, y: p.y, z: p.z, moveKind: move.kind, feedScale: move.feedScale }
  }

  /**
   * Advance the tool along the path, applying cuts as we go.
   *
   * `budget` is a reference-feed distance — the geometry the tool would cover
   * this frame at the reference cut feed (the caller passes `min(speed * dt,
   * maxStepPerFrame)`). Each move consumes the budget scaled by its feed ratio,
   * so a move at half the reference feed covers half the geometry per unit of
   * budget and takes twice as long on screen. With no reference feed every
   * ratio is 1 and this reduces to the legacy "advance by geometric distance".
   * Whether that budget spans one long move partially or many short moves fully
   * is opaque to the caller; either way the cumulative cut is correct.
   */
  advance(budget: number): boolean {
    return this.step(budget, true)
  }

  /**
   * Shared stepping primitive. When `feedScaled` is true the amount is a
   * reference-feed budget scaled per move by its feed ratio (used by playback,
   * so slow moves take longer). When false the amount is plain geometric
   * distance with every ratio treated as 1 (used by seeking, which places the
   * tool at a path distance instantly and must stay linear in geometry so the
   * progress bar maps 1:1).
   */
  private step(amount: number, feedScaled: boolean): boolean {
    if (this.finished || amount <= 0) {
      return false
    }

    let remaining = amount
    let gridChanged = false

    while (remaining > 0 && !this.finished) {
      const move = this.moves[this.moveIndex]
      const length = moveLength(move)

      if (length <= 1e-9) {
        if (isCuttingMove(move) && this.lastMoveApplied !== this.moveIndex) {
          const result = applyMoveToGrid(
            this.liveGrid,
            move,
            this.tool.toolRadius,
            this.tool.toolType,
            this.tool.vBitAngle,
          )
          if (result.changedCount > 0) {
            gridChanged = true
            this.expandDirtyRegion(result.dirtyRegion!)
          }
          this.lastMoveApplied = this.moveIndex
        }
        this.advanceToNextMove()
        continue
      }

      const ratio = feedScaled ? this.feedRatioForMove(move) : 1
      const traveled = length * this.moveFraction
      const available = length - traveled
      // Reference-feed budget needed to finish the remaining geometry of this
      // move: slower moves (ratio < 1) cost more budget per unit of geometry.
      const budgetToFinish = available / ratio

      if (remaining >= budgetToFinish) {
        if (isCuttingMove(move) && this.lastMoveApplied !== this.moveIndex) {
          const result = applyMoveToGrid(
            this.liveGrid,
            move,
            this.tool.toolRadius,
            this.tool.toolType,
            this.tool.vBitAngle,
          )
          if (result.changedCount > 0) {
            gridChanged = true
            this.expandDirtyRegion(result.dirtyRegion!)
          }
          this.lastMoveApplied = this.moveIndex
        }
        this.distanceTraveled += available
        remaining -= budgetToFinish
        this.advanceToNextMove()
      } else {
        const geometricProgress = remaining * ratio
        const prevFraction = this.moveFraction
        const nextFraction = prevFraction + geometricProgress / length

        if (isCuttingMove(move)) {
          const prevPoint = interpolatePoint(move, prevFraction)
          const nextPoint = interpolatePoint(move, nextFraction)
          const partial: ToolpathMove = {
            kind: move.kind,
            from: prevPoint,
            to: nextPoint,
          }
          const result = applyMoveToGrid(
            this.liveGrid,
            partial,
            this.tool.toolRadius,
            this.tool.toolType,
            this.tool.vBitAngle,
          )
          if (result.changedCount > 0) {
            gridChanged = true
            this.expandDirtyRegion(result.dirtyRegion!)
          }
        }

        this.moveFraction = nextFraction
        this.distanceTraveled += geometricProgress
        remaining = 0
      }
    }

    return gridChanged
  }

  /**
   * Position the tool at an absolute path distance. Seeking is geometric
   * (per-move feed ignored) so the progress bar maps 1:1 onto path length.
   *
   * Forward seeks advance incrementally from the current state: cuts only ever
   * lower cells and are order-independent, so advancing from distance d0 to d
   * produces exactly the same grid as a reset + replay to d — without paying
   * for the replay. Only backward seeks reset to the base grid and replay
   * (material cannot be un-cut move by move).
   *
   * Returns true when grid contents changed (including the restore on a
   * backward seek).
   */
  seekToDistance(target: number): boolean {
    const clampedTarget = Math.max(0, Math.min(this.totalPathLength, target))
    const delta = clampedTarget - this.distanceTraveled

    if (delta > 1e-9 && !this.finished) {
      return this.step(delta, false)
    }
    if (delta >= -1e-9) {
      // Already at the target (within float tolerance) — nothing to do.
      return false
    }

    this.reset()
    if (clampedTarget > 0) {
      this.step(clampedTarget, false)
    }
    // A backward seek always un-cuts material, so the grid always changed.
    return true
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
