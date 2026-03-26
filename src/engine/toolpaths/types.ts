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
}

export interface NormalizedTool {
  id: string
  name: string
  sourceUnits: Units
  units: Units
  diameter: number
  radius: number
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

export interface ClipperPoint {
  X: number
  Y: number
}

export type ClipperPath = ClipperPoint[]

export interface FlattenedPath {
  points: Point[]
  closed: true
}
