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
 * None of them reads the sampled height map. `squareRotaryTouchRadius` is the
 * blank's material bound inside a finite cutter's cross-sectional footprint
 * (#1016 C2-F2, corrected by C2-F2b); the ray radius alone is still never a
 * tool-support or safe-height function.
 */

import {
  barCentre,
  barInscribedRadius,
  barMaxRadius,
  barPivotZ,
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
 * The highest blank material a rough layer's cutter can reach at one program
 * angle: the largest tool-space `Y` of the square cross-section inside the
 * cutter's across-slab. The rough emits a layer when its tip radius is still
 * below this value and skips it otherwise (#1016 C2-F2, corrected by C2-F2b).
 *
 * ## The cutter is a cylinder, not a disc in the cross-section
 *
 * The generator turns the stock by `+angle` (`toolSpacePoint` in
 * `rotaryFrame.ts`) and keeps the tool over the centreline. At program angle
 * `theta`, a stock point whose offset from `(centre, pivot)` is `(u, v)` sits
 * at
 *
 *     X = u cos theta - v sin theta
 *     Y = u sin theta + v cos theta
 *
 * in the tool's own frame, where the pass ray is the `+Y` axis and a layer's
 * tip is at `(0, R)`. The cutter's axis lies along that ray with its flat (or
 * ball) bottom at the tip, so in this cross-section it occupies
 * `|X| <= rt` (across) and `Y >= R`. A ball nose's lower surface is contained
 * in that cylinder, so the same footprint is a valid upper bound for it.
 *
 * The earlier bound took the largest *radial* distance `r(phi)` over an
 * angular window. That is not where the cutter is: at a fixed pass angle the
 * cutter spans a slab across the ray, and the material that matters is its
 * extent **along the cutter axis** inside that slab. On a 20 mm blank at `A0`
 * with a 4 mm flat and a 0.1 mm stepdown the old bound emitted layers at
 * `Z = 20.1421` and `20.0421` above the `Z = 20` face — pure air.
 *
 * ## The bound
 *
 * The blank cross-section is the square `|u| <= side / 2`, `|v| <= side / 2`.
 * The deepest material the layer can touch is
 *
 *     S = max{ Y : |u|, |v| <= side / 2, |X| <= rt }.
 *
 * This does **not** depend on `R`: the slab is unbounded above, so moving the
 * tip changes only where the cutter's bottom is, not how high the blank
 * reaches inside the slab.
 *
 * ## Computing S exactly
 *
 * The rotated square is convex and `Y` is linear, so the maximum over the
 * square ∩ slab is attained at a vertex of that intersection: either a rotated
 * square vertex whose `|X| <= rt`, or a crossing of a square edge with
 * `X = ±rt`. Both are enumerated exactly — no sampling and no angular window.
 *
 * ## The layer gate
 *
 * The rough emits a layer when `R < S` and skips it when `R >= S`.
 * - If `R >= S`, no blank point in the slab is above the tip, so the layer
 *   would cut nothing and skipping it cannot change what is left.
 * - If `R < S`, the blank point attaining `S` is inside the cutter's footprint
 *   and above the tip, so the layer cuts material. The layer above it was
 *   skipped (`barMaxRadius` is the "above" layer for the first one), so
 *   `R > S - stepdown`: the first bite at that angle is less than one stepdown
 *   deep. The generator's `tips < previousRadius` test decides which along
 *   positions still need cutting.
 *
 * `S` is the blank material's upper bound, never the model: an emitted layer
 * may still cut less than the full blank because the model may already stand
 * below it, but a skipped layer can never leave model material behind.
 *
 * Round bars: the maximum over a disc is the bar radius at every angle, and
 * callers short-circuit them, so their output stays byte for byte identical.
 */
export function squareRotaryTouchRadius(
  stock: BarStock,
  angleDeg: number,
  toolRadius: number,
): number {
  if (!Number.isFinite(angleDeg) || !Number.isFinite(toolRadius)) {
    throw new RangeError(
      `squareRotaryTouchRadius: angle and tool radius must be finite, got (${angleDeg}, ${toolRadius})`,
    )
  }
  if (!isSquareStock(stock)) return barInscribedRadius(stock)
  const halfSide = barInscribedRadius(stock)
  if (!(halfSide > 0) || !Number.isFinite(halfSide)) return 0
  const reach = Math.abs(toolRadius)
  const radians = (angleDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  // The rotated square's vertices, relative to (centre, pivot).
  const xs: number[] = []
  const ys: number[] = []
  for (const [across, up] of CORNERS) {
    const u = across * halfSide
    const v = up * halfSide
    xs.push(u * cos - v * sin)
    ys.push(u * sin + v * cos)
  }
  const tolerance = 1e-12 * Math.max(1, reach, halfSide)
  let best = Number.NEGATIVE_INFINITY
  // A vertex inside the slab.
  for (let i = 0; i < CORNERS.length; i++) {
    if (Math.abs(xs[i]) <= reach + tolerance) best = Math.max(best, ys[i])
  }
  // A maximum on the slab's boundary: an edge crossing X = ±reach.
  for (let i = 0; i < CORNERS.length; i++) {
    const j = (i + 1) % CORNERS.length
    const dx = xs[j] - xs[i]
    if (dx === 0) continue
    for (const boundary of [-reach, reach]) {
      const t = (boundary - xs[i]) / dx
      if (t < -tolerance || t > 1 + tolerance) continue
      const clamped = Math.min(1, Math.max(0, t))
      best = Math.max(best, ys[i] + clamped * (ys[j] - ys[i]))
    }
  }
  return best
}
