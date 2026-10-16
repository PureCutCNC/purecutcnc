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

/**
 * The square-blank cut kernel entry point (issue #1016 C2-R1F).
 *
 * The physical material model — finite flat/ball cutter bodies, correlated
 * along/Z sweeps, and the per-cell remaining radial intervals that make an
 * interior groove and a surviving outer lip representable — lives in
 * `squareMaterial.ts`. This module keeps the original C2-R1 import surface so
 * the replay/playback callers and their tests are unchanged.
 */

import type { ToolType } from '../../types/project'
import type { ToolpathMove } from '../toolpaths/types'
import {
  applySquareMoveToGrid as applySquareMaterialMove,
  squareSurfaceRadius as materialSurfaceRadius,
  validateSquareBarDescriptor,
} from './squareMaterial'
import type { SquareApplyResult } from './squareMaterial'
import type { SimulationGrid, SquareBarDescriptor } from './types'

export {
  squareMaterialIntervals,
  setSquareMaterialIntervals,
  cloneSquareMaterial,
  squareToolSupported,
} from './squareMaterial'
export type { SquareApplyResult } from './squareMaterial'

/**
 * Radial distance from the pivot to the surface of a square blank of `side` at
 * `angle` radians: `halfSide / max(|sin|,|cos|)` — half the side on a flat,
 * `side/√2` at a corner. Raw blank geometry, not a cutter-support height.
 */
export function squareSurfaceRadius(side: number, angle: number): number {
  return materialSurfaceRadius(side, angle)
}

/** Validate a transient square descriptor before it initializes a grid. */
export function validateSquareBar(descriptor: SquareBarDescriptor): void {
  validateSquareBarDescriptor(descriptor)
}

/**
 * The physical square cut kernel. See `squareMaterial.ts` for the cutter model
 * and the interval representation this writes.
 */
export function applySquareMoveToGrid(
  grid: SimulationGrid,
  move: ToolpathMove,
  toolRadius: number,
  toolType: ToolType,
): SquareApplyResult {
  return applySquareMaterialMove(grid, move, toolRadius, toolType)
}
