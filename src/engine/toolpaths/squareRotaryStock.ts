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
 * It also owns the shared **travel height** ({@link rotaryTravelZ}) that both
 * rotary generators turn at and the square output guard judges a supplied
 * turning move against, so the emitted paths and the guard cannot drift.
 *
 * None of them reads the sampled height map. `squareRotaryTouchRadius` reads
 * `barSurfaceRadius` only as the blank's material bound inside a finite
 * cutter's angular footprint; the ray radius alone is still never a
 * tool-support or safe-height function (#1016 C2-F2).
 */

import {
  barCentre,
  barInscribedRadius,
  barMaxRadius,
  barPivotZ,
  barSurfaceRadius,
  isSquareStock,
} from '../../types/barStock'
import type { BarStock, SquareStock } from '../../types/project'
import { convertLength, type Units } from '../../utils/units'

/**
 * The height every between-run move travels at: the blank's largest surface
 * radius above the turning pivot, plus 1 mm converted to the project's units.
 * Both rotary generators emit their turning links and traverses here, and the
 * square output guard asks the same height of any supplied path (#1016 C2), so
 * this is the one formula — a second copy would drift from the emitted paths.
 *
 * The blank's largest radius is `maxRadius` (a square's corner) rather than the
 * inscribed radius: the model between two pass angles is not otherwise checked,
 * and nothing stands above the blank's own envelope. `safeRadius` is not
 * allowed to cap it down towards the bar; the operation's first positioning
 * move and final retract use the higher of the two heights.
 */
export function rotaryTravelZ(stock: BarStock, units: Units): number {
  return barPivotZ(stock) + barMaxRadius(stock) + convertLength(1, 'mm', units)
}

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

/**
 * The largest square-blank surface radius the cutter can touch at one program
 * angle, for a rough layer whose tip sits at `layerRadius`. A layer is skipped
 * when `layerRadius` is at or above this value; the rough generator uses it to
 * stop starting every angle at the corner radius (#1016 C2-F2).
 *
 * ## The blank's surface
 *
 * The generator turns the stock by `+angle` (`toolSpacePoint` in
 * `rotaryFrame.ts`) and keeps the tool over the centreline, so at program angle
 * `theta` the point under the tool tip has stock angle `90° - theta`. The
 * square is symmetric under that swap, so the radial surface is
 *
 *     r(phi) = (side / 2) / max(|cos phi|, |sin phi|)
 *
 * evaluated at `phi = theta`: half the side on a flat, `side / √2` at a
 * corner, and 45°-periodic in between. At `A = 0` the flats are horizontal and
 * vertical, exactly the blank's own orientation.
 *
 * ## The footprint bound
 *
 * A flat end mill's cutting edge at tip radius `R` is a disc of radius `rt`
 * around the tip; a ball nose's horizontal reach is never wider than `rt`. Put
 * that disc's centre at radius `R` on the pass's ray. A blank point at radius
 * `S` and angle `phi = theta + delta` can be inside the disc only when
 * `R |sin delta| <= rt`. Hence every direction with `|delta| > deltaMax =
 * asin(min(1, rt / R))` is outside the cutter's horizontal reach at **every**
 * radius `>= R`: widening the window past `deltaMax` can only add material
 * this pass cannot cut. `S` is therefore the largest `r` over
 * `[theta - deltaMax, theta + deltaMax]`. The half angular stepover is not
 * added for that reason; the material between two passes belongs to the
 * neighbouring pass, whose own window covers it.
 *
 * ## Why skipping at `R >= S` removes nothing
 *
 * If `R >= S`, no blank surface inside the window reaches `R`, and outside the
 * window nothing at or above `R` is within the cutter's horizontal reach. So
 * the layer would cut no material, and skipping it cannot change what is left.
 *
 * ## Why the first cut is not deeper than one stepdown
 *
 * If `R < S`, take the surface point at radius `S` in the window. The
 * perpendicular from the tip to the pivot-to-point segment has length
 * `R sin|delta| <= rt`, and its foot lies on that segment — inside the blank,
 * which is convex — because `R cos|delta| <= S`. The cutter disc therefore
 * intersects the blank, so an emitted layer is never wholly in air. The first
 * layer that emits has `R > S - stepdown` (the layer above it was skipped) and
 * the surface under the pass is `r(theta) <= S`, so the first cut there is less
 * than one stepdown deep.
 *
 * `r` reaches its maxima at `45° + k*90°`, so the window maximum is one of its
 * two endpoints or a corner it contains; no sampling is needed.
 *
 * Round bars: `barSurfaceRadius` is the bar radius at every angle, so `S` is
 * that radius. Callers short-circuit round bars and keep their old output byte
 * for byte.
 */
export function squareRotaryTouchRadius(
  stock: BarStock,
  angleDeg: number,
  layerRadius: number,
  toolRadius: number,
): number {
  if (!Number.isFinite(angleDeg) || !Number.isFinite(layerRadius) || !Number.isFinite(toolRadius)) {
    throw new RangeError(
      `squareRotaryTouchRadius: angle, layer radius and tool radius must be finite, got (${angleDeg}, ${layerRadius}, ${toolRadius})`,
    )
  }
  if (!isSquareStock(stock)) return barInscribedRadius(stock)
  if (!(layerRadius > 0)) return barMaxRadius(stock)
  const reach = Math.abs(toolRadius)
  const delta = layerRadius <= reach ? Math.PI / 2 : Math.asin(reach / layerRadius)
  const start = angleDeg - (delta * 180) / Math.PI
  const end = angleDeg + (delta * 180) / Math.PI
  // A corner inside the window is the maximum; otherwise r is monotone on the
  // interval and an endpoint is.
  const firstCorner = Math.ceil((start - 45) / 90)
  const lastCorner = Math.floor((end - 45) / 90)
  if (lastCorner >= firstCorner) return barMaxRadius(stock)
  return Math.max(barSurfaceRadius(stock, start), barSurfaceRadius(stock, end))
}
