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

import assert from 'node:assert/strict'
import { roundStock } from '../../types/project'
import { barCentre, barPivotZ } from '../../types/barStock'
import { buildHeightMap, computeXYBounds, safeToolTipZAt } from './finishSurfaceParallel'
import type { HeightMapBuildOptions } from './finishSurfaceParallel'
import { sampleRotaryModel, turnedModelPositions } from './rotaryModel'
import { buildRotaryHeightMap, buildRotaryRasterGeometry } from './rotaryRaster'
import type { NormalizedTool } from './types'

const tool: NormalizedTool = {
  id: 'ball', name: 'ball', sourceUnits: 'mm', units: 'mm', type: 'ball_endmill',
  diameter: 3, radius: 1.5, vBitAngle: null, flutes: 2, material: 'carbide',
  defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 1,
  defaultStepover: 0.5, maxCutDepth: 0,
}

/**
 * A mesh whose triangles deliberately do not line up with the raster's cell
 * lattice: most of them are far smaller than a cell, some start exactly on a
 * grid line (the `floor` boundary), some are degenerate, and one spans the whole
 * map. The fused kernel must reproduce the general kernel's map for each.
 */
function buildFixture(axis: 'x' | 'y'): { positions: Float32Array; index: Uint32Array; stock: ReturnType<typeof roundStock> } {
  const stock = roundStock(20, 40, axis, { x: -3, y: 7 })
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const coordinates: number[] = []
  const indices: number[] = []
  const add = (along: number, acrossOffset: number, upOffset: number): void => {
    coordinates.push(...(axis === 'x'
      ? [along, centre + acrossOffset, pivot + upOffset]
      : [centre + acrossOffset, along, pivot + upOffset]))
    indices.push(indices.length)
  }
  // A broad triangle crossing the whole map, including exact grid boundaries.
  add(0, -6, 0)
  add(20, 6, 0)
  add(20, -6, 0)
  // Small off-lattice triangles, both windings, one zero-area triangle.
  for (let t = 0; t < 600; t++) {
    const along = (t % 200) * 0.1
    const acrossOffset = Math.sin(t * 0.7) * 5
    const upOffset = 2 + Math.cos(t * 0.3) * 3
    add(along, acrossOffset - 0.15, upOffset)
    add(along + (t % 9 === 0 ? 0 : 0.012), acrossOffset + 0.15, upOffset + 0.3)
    add(along + 0.02, acrossOffset, upOffset - 0.2)
  }
  add(5, 0, 0)
  add(5, 0, 0)
  add(5, 0, 0)
  return { positions: new Float32Array(coordinates), index: new Uint32Array(indices), stock }
}

for (const axis of ['x', 'y'] as const) {
  const { positions, index, stock } = buildFixture(axis)
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  for (const angle of [0, 35, -137, 89.9999, 360, 720]) {
    const turned = turnedModelPositions(positions, stock, angle)
    const bbox = computeXYBounds(turned)
    const t = angle * Math.PI / 180
    for (const cellSize of [0.4, 0.73, 2]) {
      const margin = Math.ceil(tool.radius / cellSize) + 1
      const cross = Math.floor((centre - (axis === 'x' ? bbox.minY : bbox.minX)) / cellSize)
      const axial = Math.floor((centre - (axis === 'x' ? bbox.minX : bbox.minY)) / cellSize)
      const windows = [
        undefined,
        axis === 'x'
          ? { minRow: cross - margin, maxRow: cross + margin }
          : { minCol: cross - margin, maxCol: cross + margin },
        axis === 'x'
          ? { minCol: axial - margin, maxCol: axial + margin }
          : { minRow: axial - margin, maxRow: axial + margin },
        axis === 'x'
          ? { minRow: cross - margin, maxRow: cross + margin, minCol: axial - margin, maxCol: axial + margin }
          : { minRow: axial - margin, maxRow: axial + margin, minCol: cross - margin, maxCol: cross + margin },
      ]
      for (const trackCellRise of [false, true]) {
        for (const triangles of [undefined, new Uint32Array([0, 9, 3, 90, 270, 5400])]) {
          for (const window of windows) {
            const options: HeightMapBuildOptions = {
              ...(window ? { window } : {}),
              trackCellRise,
              ...(triangles ? { triangles } : {}),
            }
            const expected = buildHeightMap(turned, index, bbox, cellSize, options)
            const actual = buildRotaryHeightMap({
              axis, centre, pivot, cos: Math.cos(t), sin: Math.sin(t),
              geometry: buildRotaryRasterGeometry(positions, index, axis, centre, pivot),
            }, bbox, cellSize, options)
            assert.deepEqual(actual, expected,
              `raster identity ${axis} A${angle} cell${cellSize} rise${trackCellRise} window${JSON.stringify(window)}`)
          }
        }
      }
      // The tip row the sampler reads must be the one the old turned-mesh path
      // would produce, lift included.
      const window = axis === 'x'
        ? { minRow: cross - margin, maxRow: cross + margin }
        : { minCol: cross - margin, maxCol: cross + margin }
      const map = buildHeightMap(turned, index, bbox, cellSize, { window, trackCellRise: true })
      const along = [0, 0.2, 1, 5.2, 10, 19, 20]
      const expected = new Float32Array(along.map((position) => {
        const z = safeToolTipZAt(axis === 'x' ? position : centre,
          axis === 'x' ? centre : position, map, tool, cellSize * Math.SQRT1_2)
        const raw = Math.fround(z === -Infinity ? NaN : z - pivot)
        return Number.isFinite(raw) ? Math.fround(raw + Math.min(map.cellRise ?? 0, cellSize)) : raw
      }))
      const actual = sampleRotaryModel({ positions, index }, stock, tool, {
        anglesDeg: [angle], along, requestedCellSize: cellSize, conservativeCellBounds: true,
      }, [])
      assert.deepEqual(actual.tipRadius[0], expected, `tip-row identity ${axis} A${angle} cell${cellSize}`)
    }
  }
}

console.log('rotary raster: exact map and tip-row parity passed')
