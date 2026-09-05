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

import type { Operation, ToolType } from '../../types/project'

export const DEFAULT_WATERLINE_STEEP_SLOPE_DEGREES = 30

interface ScallopTool {
  type: ToolType
  diameter: number
}

/** Convert a ball-endmill cusp height to the spacing between adjacent passes. */
export function scallopHeightToSpacing(radius: number, height: number): number | null {
  if (!(radius > 0) || !(height > 0) || height >= radius) return null
  if (!Number.isFinite(radius) || !Number.isFinite(height)) return null
  return 2 * Math.sqrt(Math.max(0, 2 * radius * height - height * height))
}

/** Convert pass spacing to the cusp left by a ball endmill. */
export function spacingToScallopHeight(radius: number, spacing: number): number | null {
  if (!(radius > 0) || spacing < 0 || spacing >= radius * 2) return null
  if (!Number.isFinite(radius) || !Number.isFinite(spacing)) return null
  return radius - Math.sqrt(Math.max(0, radius * radius - spacing * spacing / 4))
}

export function hasConfiguredFinishScallopHeight(operation: Operation): boolean {
  return operation.finishScallopHeight !== undefined && operation.finishScallopHeight !== 0
}

export function finishScallopHeightIsValid(operation: Operation, tool: ScallopTool): boolean {
  if (tool.type !== 'ball_endmill') return true
  if (!hasConfiguredFinishScallopHeight(operation)) return true
  const height = operation.finishScallopHeight
  return height !== undefined
    && scallopHeightToSpacing(tool.diameter / 2, height) !== null
}

/** Active scallop-derived surface spacing, or null for the legacy controls. */
export function finishScallopSpacing(operation: Operation, tool: ScallopTool): number | null {
  if (tool.type !== 'ball_endmill') return null
  const height = operation.finishScallopHeight ?? 0
  return scallopHeightToSpacing(tool.diameter / 2, height)
}

/** Coarse waterline Z increment for the chosen steep-surface threshold. */
export function finishScallopWaterlineStepdown(operation: Operation, tool: ScallopTool): number | null {
  const spacing = finishScallopSpacing(operation, tool)
  if (spacing === null) return null
  const slopeDegrees = operation.finishSlopeMin ?? DEFAULT_WATERLINE_STEEP_SLOPE_DEGREES
  return spacing * Math.sin(slopeDegrees * Math.PI / 180)
}
