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

import type { Point, SketchFeature, SketchProfile } from '../../types/project'

/** Parameters the wizard owns for a flat 2-sided V-carve inlay. */
export interface InlayParams {
  /** Included V-bit angle in degrees. */
  vBitAngle: number
  /** Nominal cutter diameter in project units; the surface groove may not exceed it. */
  vBitDiameter: number
  /** Pocket V-carve depth `D`. */
  pocketDepth: number
  /** How far the plug shoulder sits above the pocket surface `G`. */
  surfaceGap: number
  /** Fit adjustment `delta`: shrinks the plug only. */
  fitAdjustment: number
  stockThickness: number
  /** Minimum material left under the plug `P`. */
  plugBaseThickness: number
  /** V-ring stepdown `delta z`; drives the contour stepover. */
  wallStep: number
  /** Mirror the plug about the vertical centre line of its placement. */
  mirror: boolean
}

export interface InlayInputShape {
  profile: SketchProfile
  /** Source role; drives the offset direction. */
  operation: 'subtract' | 'add'
  sourceFeature: SketchFeature
}

export interface InlayGeometryInput {
  shapes: InlayInputShape[]
  params: InlayParams
  units: 'mm' | 'inch'
  /** X coordinate of the plug's mirror axis. */
  plugOrigin: Point
}

export type InlayRole = 'pocketFloor' | 'plugRidge' | 'plugShoulder'

export interface InlayShape {
  profile: SketchProfile
  /** Feature operation for the generated feature (plug boundaries are inverted). */
  operation: 'subtract' | 'add'
  role: InlayRole
  sourceFeatureId: string
}

export type InlayProblemCode = 'tooThin' | 'grooveWiderThanBit' | 'baseTooThin' | 'depthTooDeep'

export interface InlayProblem {
  code: InlayProblemCode
  detail?: string
}

export interface InlayDerived {
  /** tan(half angle). */
  slope: number
  carveDepth: number
  plugDepth: number
  floorInset: number
  ridgeInset: number
  shoulderInset: number
  stepover: number
  /** Groove width at the stock surface: `2 * T * slope`. */
  grooveWidth: number
}

export interface InlayGeometry {
  pocketFloor: InlayShape[]
  plugRidge: InlayShape[]
  plugShoulder: InlayShape[]
  frame: SketchProfile
  derived: InlayDerived
  problems: InlayProblem[]
}
