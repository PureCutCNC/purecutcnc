import type { SketchProfile } from '../types/project'
import type { Units } from '../utils/units'

export type ImportSourceType = 'svg' | 'dxf'

export interface ImportedShape {
  name: string
  sourceType: ImportSourceType
  layerName: string | null
  profile: SketchProfile
}

export interface ImportInspection {
  detectedUnits: Units | null
  sourceUnitScale: number
  unitsReliable: boolean
  summary: string
  warnings: string[]
}

export interface ImportParseResult {
  shapes: ImportedShape[]
  warnings: string[]
}

export interface ImportContext {
  fileName: string
  targetUnits: Units
  sourceUnits?: Units
  sourceUnitScale?: number
}
