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

import type { Operation, Point, Tool } from '../../types/project'
import type { Units } from '../../utils/units'

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
}

export interface ToolpathBounds {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface ToolpathResult {
  operationId: string
  moves: ToolpathMove[]
  warnings: string[]
  bounds: ToolpathBounds | null
  collidingClampIds?: string[]
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
  warnings: string[]
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
