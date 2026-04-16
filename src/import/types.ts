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
  /** Layer names present in the file, sorted. Empty for formats without layers (SVG). */
  layers: string[]
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
  joinTolerance?: number
  allowCrossLayerJoins?: boolean
  /**
   * When set, only shapes whose layerName is in this list are imported.
   * Shapes with a null layerName are always included regardless of this filter.
   */
  layerFilter?: string[] | null
}
