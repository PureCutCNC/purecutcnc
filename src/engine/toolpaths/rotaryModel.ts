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

import { roundStockCentre } from '../../types/project'
import type { RoundStock } from '../../types/project'
import { toolSpacePoint } from '../rotaryFrame'
import { chooseHeightMapCellSize, computeXYBounds, getCachedHeightMap, safeToolTipZAt } from './finishSurfaceParallel'
import type { NormalizedTool } from './types'
import type { ToolpathWarning } from './warningCodes'

export interface RotaryModelMesh {
  /** Project coordinates of the model as placed in the unturned bar. */
  readonly positions: Float32Array
  readonly index: Uint32Array
}

export interface RotarySampleOptions {
  /** Angles in degrees, any order, any range (not reduced to one turn). */
  readonly anglesDeg: readonly number[]
  /** Positions along the bar's axis (project X for an X bar, Y for a Y bar). */
  readonly along: readonly number[]
  /** Requested height-map cell size before `chooseHeightMapCellSize` caps it. */
  readonly requestedCellSize: number
  /** Called after each angle with (done, total); worker generation reports progress through it later. */
  readonly onAngle?: (done: number, total: number) => void
  /** Return true to stop early; the result then holds the angles done so far. */
  readonly shouldStop?: () => boolean
}

export interface RotarySampling {
  readonly anglesDeg: readonly number[]
  readonly along: readonly number[]
  /**
   * One row per angle, one value per `along` position: the tool tip's radius
   * from the bar's centreline (tool tip height − R) where the tool may go
   * without gouging the model, or `NaN` where no model lies under the tool
   * (free travel). Values may be negative (below the centreline); the
   * generators decide what to do with that.
   */
  readonly tipRadius: readonly Float32Array[]
  readonly stopped: boolean
}

/** The model's vertices as they sit when the stock is turned to `angleDeg`. */
export function turnedModelPositions(positions: Float32Array, stock: RoundStock, angleDeg: number): Float32Array {
  const turned = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const point = toolSpacePoint({ x: positions[i], y: positions[i + 1], z: positions[i + 2] }, angleDeg, stock)
    turned[i] = point.x
    turned[i + 1] = point.y
    turned[i + 2] = point.z
  }
  return turned
}

export function sampleRotaryModel(
  mesh: RotaryModelMesh,
  stock: RoundStock,
  tool: NormalizedTool,
  options: RotarySampleOptions,
  warnings: ToolpathWarning[],
): RotarySampling {
  const anglesDeg: number[] = []
  const along = [...options.along]
  const tipRadius: Float32Array[] = []
  const centre = roundStockCentre(stock)
  const radius = stock.thickness / 2
  let stopped = false
  for (const angle of options.anglesDeg) {
    if (options.shouldStop?.()) {
      stopped = true
      break
    }
    const positions = turnedModelPositions(mesh.positions, stock, angle)
    const bbox = computeXYBounds(positions)
    const angleWarnings: ToolpathWarning[] = []
    const cellSize = chooseHeightMapCellSize(bbox, options.requestedCellSize, angleWarnings)
    for (const warning of angleWarnings) {
      if (!warnings.some((existing) => existing.code === warning.code)) warnings.push(warning)
    }
    // The cache key contains bounds and cell size, not orientation or mesh.
    // An angle owns its host, even when another angle has exactly these bounds.
    const heightMap = getCachedHeightMap({}, positions, mesh.index, bbox, cellSize)
    const row = new Float32Array(along.length)
    for (let i = 0; i < along.length; i++) {
      const x = stock.axis === 'x' ? along[i] : centre
      const y = stock.axis === 'x' ? centre : along[i]
      const z = safeToolTipZAt(x, y, heightMap, tool)
      row[i] = z === Number.NEGATIVE_INFINITY ? NaN : z - radius
    }
    anglesDeg.push(angle)
    tipRadius.push(row)
    options.onAngle?.(anglesDeg.length, options.anglesDeg.length)
  }
  return { anglesDeg, along, tipRadius, stopped }
}
