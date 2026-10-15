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
 * The square blank's own geometry for the rotary sampler (#1016 C2-S3).
 *
 * Two things are genuinely square and belong beside the round versions in
 * `rotaryModel.ts`:
 *
 * - the blank's cross-section is the **box** `|across − centre| ≤ side / 2`,
 *   `|up − pivot| ≤ side / 2`, not the inscribed circle. A model vertex inside
 *   that box is inside the blank; one outside it is air, even when it is
 *   inside the circle the sampled grid would otherwise use. The box is what
 *   `modelOutsideBar` must judge a square project against.
 * - the blank retained beyond the cut range is a **closed square prism** of
 *   that cross-section, coaxial with the turning pivot, not a cylinder. The
 *   stub is what lifts a finite cutter's side off the shoulders that hold the
 *   part at the cut range's ends; a cylinder there would leave the square
 *   corners unsupported and let the cutter enter them.
 *
 * Neither function reads the sampled height map or the ray surface radius:
 * `barSurfaceRadius` is raw blank geometry and can never stand in for a
 * finite cutter's support.
 */

import { barCentre, barInscribedRadius, barPivotZ } from '../../types/barStock'
import type { SquareStock } from '../../types/project'

/** A closed triangle mesh in project (stock) coordinates, as the sampler wants it. */
export interface SquareRotaryMesh {
  readonly positions: Float32Array
  readonly index: Uint32Array
}

/** The four corners of the blank's cross-section, counter-clockwise in `(across, up)`. */
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]

/**
 * True when a stock-space point is outside the blank's physical cross-section
 * — past one of the four flats, not merely outside the inscribed circle.
 * `tolerance` widens the box on every side, so a point the 3D view already
 * draws on the blank is on it, not outside it.
 *
 * `across` is the project coordinate across the bar (Y for an X bar, X for a
 * Y bar); `up` is the project Z. Both are absolute stock coordinates, exactly
 * as `modelOutsideBar` reads a mesh vertex.
 */
export function squareBlankSectionExit(
  stock: SquareStock,
  across: number,
  up: number,
  tolerance: number,
): boolean {
  const halfSide = barInscribedRadius(stock)
  return Math.abs(across - barCentre(stock)) > halfSide + tolerance
    || Math.abs(up - barPivotZ(stock)) > halfSide + tolerance
}

/**
 * The retained end stub for a square blank, `alongFrom` to `alongTo`: a
 * closed square prism of side `thickness` centred on the turning pivot, with
 * two square end caps. Returns `null` for an empty span or a blank with no
 * positive side.
 *
 * `alongFrom`/`alongTo` are project coordinates along the bar's axis (X for an
 * X bar, Y for a Y bar), so the caller passes the blank's end and the cut
 * range's end in whichever order brackets the retained material. The winding
 * matches the round stub's in `rotaryModel.ts`; the sampler reads the maximum
 * height over the triangles, and this stays a real closed solid for any other
 * reader.
 */
export function squareBlankRetainedStub(
  stock: SquareStock,
  alongFrom: number,
  alongTo: number,
): SquareRotaryMesh | null {
  const halfSide = barInscribedRadius(stock)
  if (!(alongTo - alongFrom > 0) || !(halfSide > 0)) return null
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  for (const along of [alongFrom, alongTo]) {
    for (const [signAcross, signUp] of CORNERS) {
      const across = centre + halfSide * signAcross
      const up = pivot + halfSide * signUp
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  const n = CORNERS.length
  const index: number[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    index.push(i, j, n + j, i, n + j, n + i)
  }
  for (let i = 1; i < n - 1; i++) {
    index.push(0, i + 1, i)
    index.push(n, n + i, n + i + 1)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}
