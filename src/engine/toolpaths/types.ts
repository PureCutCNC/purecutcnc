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
import type { ToolpathWarning } from './warningCodes'

export type ToolpathMoveKind = 'rapid' | 'plunge' | 'cut' | 'lead_in' | 'lead_out'

export interface ToolpathPoint {
  x: number
  y: number
  z: number
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
   *  Set on fully engaged (slotting) pocket cuts when the operation's
   *  pocketSlotFeedPercent is below 100. Absent means 1 (normal feed).
   *  Never set on plunge moves (those use the plunge feed). */
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

export interface ToolpathResult {
  operationId: string
  moves: ToolpathMove[]
  warnings: ToolpathWarning[]
  bounds: ToolpathBounds | null
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
}

export interface NormalizedTool {
  id: string
  name: string
  sourceUnits: Units
  units: Units
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
