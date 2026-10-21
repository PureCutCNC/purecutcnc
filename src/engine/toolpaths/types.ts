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

import type { Operation, Point, Tool, DrillType } from '../../types/project'
import type { Units } from '../../utils/units'
import type { EngagementTelemetry } from './engagement'
import type { ToolpathWarning } from './warningCodes'

export type ToolpathMoveKind = 'rapid' | 'plunge' | 'cut' | 'lead_in' | 'lead_out'

export interface ToolpathPoint {
  x: number
  y: number
  z: number
  /** Degrees the stock is turned to, about the bar's axis, when the tool is at
   *  this point. Absent = no rotary component (issue #393). */
  a?: number
}

export interface ToolpathMove {
  kind: ToolpathMoveKind
  from: ToolpathPoint
  to: ToolpathPoint
  /** DIAG source tag identifying which part of the algorithm created this move.
   *  Populated when operation.debugToolpath is active. Used in the 3D viewport
   *  to render shape markers that help visualise toolpath provenance. */
  source?: string
  /** Multiplier applied to the operation's cut feed at G-code export time.
   *  Absent means 1 (normal feed). Set on fully engaged (slotting) pocket cuts
   *  when the operation's pocketSlotFeedPercent is below 100, or — when the
   *  operation's pocketFeedReduction is 'engagement' — on cuts whose
   *  sampled cutter engagement sits above the stepover's nominal wrap angle
   *  (a quantized scale between pocketSlotFeedPercent and 1). Never set on
   *  plunge moves (those use the plunge feed). */
  feedScale?: number
}

export interface ToolpathBounds {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface DrillCycle {
  x: number
  y: number
  clearZ: number
  retractZ: number
  bottomZ: number
  drillType: DrillType
  peckDepth?: number
  dwellTime?: number
}

/**
 * The radial material a square-blank rotary rough leaves standing, sampled on
 * the rough's own grid (#1045 slice L). `tips[k][i]` is the radius from the
 * turning pivot the rough left at `angles[k]` (degrees) and `along[i]`; the
 * values already carry the operation's radial stock to leave. An around finish
 * is licensed only by coverage that reaches its own samples within a bounded
 * bite (see `generateRotaryFinish`); settings alone license nothing.
 *
 * Runtime only: it describes one generated result and is never serialised into
 * a `.camj` file.
 */
export interface SquareRoughLeft {
  readonly angles: readonly number[]
  readonly along: readonly number[]
  readonly tips: readonly (readonly number[])[]
  /** The rough's own radial layer depth, for its between-sample scallop. */
  readonly stepdown: number
  /** The rough's radial stock to leave, already folded into `tips`. */
  readonly stockToLeave: number
  /** The normalized rough cutter, for its between-sample scallop. */
  readonly cutterRadius: number
  readonly ball: boolean
  /**
   * The rough's own pass direction. An along pass cuts a line at each angle, so
   * its sampled result does not bound a retained-end corner the around finish's
   * ring sweeps into; such a rough cannot license an around finish over a
   * retained end (#1045 slice L).
   */
  readonly passDirection: 'around' | 'along'
}

export interface ToolpathResult {
  operationId: string
  moves: ToolpathMove[]
  warnings: ToolpathWarning[]
  bounds: ToolpathBounds | null
  /** Square-blank rotary rough only: the material it leaves, for the around
   *  finish's licensing check (#1045 slice L). */
  squareRoughLeft?: SquareRoughLeft
  /** Square-blank around finish only: the ids of the roughs whose coverage
   *  licensed it. The export requires every one of them earlier in the same
   *  program (#1045 slice L). */
  squareRoughIds?: string[]
  collidingClampIds?: string[]
  /** Indices into `moves` of segments that cross a clamp zone below required
   *  clearance. Refers to the final (adjusted) moves array. */
  collidingMoveIndices?: number[]
  /** True when the source operation has debugToolpath enabled. The 3D viewport
   *  renders extra diagnostic markers (source-tag symbols) when this is set. */
  debugToolpath?: boolean
  /** Structured drill cycle data for canned-cycle G-code emission.
   *  Present only for drilling operations. When non-empty and the active
   *  machine definition supports the cycle, the post-processor emits
   *  G81/G82/G83/G73 blocks instead of expanded G0/G1 moves. */
  drillCycles?: DrillCycle[]
}

export interface PocketToolpathResult extends ToolpathResult {
  stepLevels: number[]
  /** Distance-weighted engagement measurement for the whole operation,
   *  present only when the operation's pocketFeedReduction is
   *  'engagement' (issue #498 telemetry). */
  engagementTelemetry?: EngagementTelemetry
}

/**
 * Ephemeral, debug-only snapshot of a single operation's toolpath at both
 * sides of the always-on linear-move optimization. `raw` is the generated
 * toolpath before adjacent-collinear cut moves are merged; `optimized` is the
 * canonical result that caching, preview, simulation, and export consume.
 *
 * This is never serialised into `.camj` — it exists only in memory for the
 * exported-motion debug view (issue #356) so the "Generated" layer can be
 * rendered alongside the "Optimized" and parsed "Exported G-code" layers.
 */
export interface ToolpathGenerationTrace {
  operationId: string
  raw: ToolpathResult
  optimized: ToolpathResult
}

export interface NormalizedTool {
  id: string
  name: string
  sourceUnits: Units
  units: Units
  pierceHeight?: number
  cutHeight?: number
  pierceDelay?: number
  qtplasmacMaterialNumber?: number
  type: Tool['type']
  diameter: number
  radius: number
  vBitAngle: number | null
  flutes: number
  material: Tool['material']
  defaultRpm: number
  defaultFeed: number
  defaultPlungeFeed: number
  defaultStepdown: number
  defaultStepover: number
  maxCutDepth: number
}

export interface ResolvedFeatureZSpan {
  top: number
  bottom: number
  min: number
  max: number
  height: number
}

export interface ResolvedToolpathOperation {
  operation: Operation
  tool: NormalizedTool | null
  units: Units
}

export interface ResolvedPocketRegion {
  outer: Point[]
  islands: Point[][]
  targetFeatureIds: string[]
  islandFeatureIds: string[]
}

export interface ResolvedPocketBand {
  topZ: number
  bottomZ: number
  targetFeatureIds: string[]
  islandFeatureIds: string[]
  regions: ResolvedPocketRegion[]
}

export interface ResolvedPocketResult {
  operationId: string
  units: Units
  bands: ResolvedPocketBand[]
  warnings: ToolpathWarning[]
}

export interface ClipperPoint {
  X: number
  Y: number
}

export type ClipperPath = ClipperPoint[]

export interface FlattenedPath {
  points: Point[]
  closed: boolean
}
