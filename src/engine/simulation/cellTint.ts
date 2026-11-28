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
 * A per-cell colour over the simulated stock (issue #1269, the Verify view).
 *
 * One RGBA8 texel per heightfield cell, laid out like `grid.topZ` (column =
 * x, row = y). The surface shader mixes the texel's rgb over the stock colour
 * by its alpha, so a cell with alpha 0 draws exactly as before. The codes are
 * the caller's (the Verify view's cell classes); the caller supplies the
 * colour of each code, so the colours stay the theme's.
 */

import * as THREE from 'three'
import type { SimulationGrid } from './types'

/** An RGB colour (0..255 per channel) and how strongly it covers the stock (0..1). */
export interface CellTintColour {
  rgb: number
  alpha: number
}

/**
 * Write one texel per cell: the colour of its code, or transparent when the
 * code has no colour (`colours[code]` undefined or null).
 */
export function writeCellTint(
  data: Uint8Array,
  codes: ArrayLike<number>,
  colours: ReadonlyArray<CellTintColour | null | undefined>,
): void {
  if (data.length !== codes.length * 4) throw new RangeError('writeCellTint: one RGBA texel per cell')
  for (let cell = 0; cell < codes.length; cell += 1) {
    const colour = colours[codes[cell]]
    const at = cell * 4
    if (!colour) {
      data[at] = 0
      data[at + 1] = 0
      data[at + 2] = 0
      data[at + 3] = 0
      continue
    }
    data[at] = (colour.rgb >> 16) & 0xff
    data[at + 1] = (colour.rgb >> 8) & 0xff
    data[at + 2] = colour.rgb & 0xff
    data[at + 3] = Math.round(Math.max(0, Math.min(1, colour.alpha)) * 255)
  }
}

/** The tint texture for `grid`, filled from `codes`. Dispose it with the scene. */
export function createCellTintTexture(
  grid: Pick<SimulationGrid, 'cols' | 'rows'>,
  codes: ArrayLike<number>,
  colours: ReadonlyArray<CellTintColour | null | undefined>,
): THREE.DataTexture {
  if (codes.length !== grid.cols * grid.rows) throw new RangeError('createCellTintTexture: one code per grid cell')
  const data = new Uint8Array(grid.cols * grid.rows * 4)
  writeCellTint(data, codes, colours)
  const texture = new THREE.DataTexture(data, grid.cols, grid.rows, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.needsUpdate = true
  return texture
}
