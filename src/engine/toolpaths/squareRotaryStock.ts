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
 * (#1016 C2-F2, corrected by C2-F2b for the flat footprint and made exact for
 * a ball in C2-F2c); the ray radius alone is still never a tool-support or
 * safe-height function.
 */

import {
  barCentre,
  barInscribedRadius,
  barMaxRadius,
  barPivotZ,
  isSquareStock,
} from '../../types/barStock'
import type { BarStock, SquareStock, Tool } from '../../types/project'
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
 * The exact tip height a retained end stub forces on one sample of a square
 * blank (#1016 C2-F6), for the cutter shape that makes the sample: the lowest
 * tip radius from the turning pivot at which the **real** cutter clears that
 * stub at this pass angle and along position.
 *
 * The mesh stub in `withRetainedBar` bounds the model elsewhere, but the
 * sampler only lifts a sample when its discrete footprint cells land on the
 * stub, so a thin axial overlap between the cutter's rim and the stub's end
 * face can slip between two cell centres (Codex's 25 mm repro: the sample at
 * `x = 20.933333` in the retained `x < 18` material read the Ø20 model's
 * 9.999256 instead of the stub's 12.5). This is the closed-form floor that
 * catches every such sample, with no sampling.
 *
 * ## Why `axialGap` is all the along geometry that is needed
 *
 * A retained stub is the blank's own cross-section prism, so in the tool frame
 * at program angle `theta` its material is the square of
 * {@link squareRotaryTouchRadius} rotated by `theta`. The cutter's axis is the
 * pass ray, perpendicular to the bar, and its body reaches one cutter radius
 * either side of that axis along the bar. The closest plane of the stub is
 * therefore `axialGap` away, where `axialGap = max(0, c - alongStart)` at the
 * lower stub and `max(0, alongEnd - c)` at the upper one; a gap at or beyond
 * the radius has no overlap at all. At that plane the cutter's cross-section is a slab of
 * half-width `rho = sqrt(rt^2 - axialGap^2)`, and the deepest blank material
 * inside it is the closed form the existing helper already computes.
 *
 * ## Flat and ball
 *
 * A flat end mill's bottom is a disc at the tip, so at that plane the cutter
 * occupies `|X| <= rho` for every height above the tip: the floor is simply
 * the square's largest `Y` inside the slab, `squareRotaryTouchRadius(..., 'flat_endmill')`.
 *
 * A ball end mill's lower surface at that plane is a **disc of radius `rho`
 * centred at `(0, tip + rt)`** (the ball's centre on the cutter axis), with
 * the shank above it. Tip `R` touches blank point `(X, Y)` exactly when
 *
 *     R + rt <= Y + sqrt(rho^2 - X^2),
 *
 * so the floor is `max[Y + sqrt(rho^2 - X^2)] - rt`. The helper's ball closed
 * form for reach `rho` returns exactly that maximum minus `rho`, so subtracting
 * `rt - rho` turns it into this floor. The shank is the strip `|X| <= rho`,
 * `Y >= R + rt`, which would only ask `R + rt <= max Y`; the ball's condition
 * is stronger because `max[Y + sqrt(...)] >= max Y`, so **the shank adds
 * nothing above the ball's bound** and needs no second term.
 *
 * Returns `-Infinity` where there is nothing to lift: a round bar (the whole
 * helper is square-only, so a caller that forgets the guard cannot move a round
 * bar), a non-positive radius, or an axial gap at or beyond the cutter radius
 * (a tangency, with the `1e-9`-relative rounding allowance the implementation
 * documents).
 */
export function squareRotaryStubContactFloor(
  stock: BarStock,
  angleDeg: number,
  cutterRadius: number,
  toolType: Tool['type'],
  axialGap: number,
): number {
  if (!isSquareStock(stock)) return Number.NEGATIVE_INFINITY
  const reach = Math.abs(cutterRadius)
  if (!(reach > 0) || !Number.isFinite(reach) || !Number.isFinite(axialGap)) {
    return Number.NEGATIVE_INFINITY
  }
  const gap = Math.max(0, axialGap)
  // A tangency is not an overlap, and it must stay one (#1016 C2-F7):
  // `rotaryCutterSpan` places the first sample of a stubbed end exactly one
  // cutter radius from the stub face, and `(face + reach) - face` can round a
  // few ulps below `reach`. The closed form jumps from `-Infinity` to the
  // blank's full height at that boundary, so an ulp would lift that sample off
  // the model and leave a false shoulder tick on every pass. The tolerance is
  // relative and far below any real overlap (1e-9 of the cutter radius), so a
  // sample that genuinely reaches the stub is still floored.
  if (!(gap < reach * (1 - 1e-9))) return Number.NEGATIVE_INFINITY
  const rho = Math.sqrt(Math.max(0, reach * reach - gap * gap))
  const material = squareRotaryTouchRadius(stock, angleDeg, rho, toolType)
  return toolType === 'ball_endmill' ? material - (reach - rho) : material
}

/**
 * The highest blank material a rough layer's cutter can reach at one program
 * angle, for the cutter shape that cuts the layer. The rough emits a layer
 * when its tip radius is still below this value and skips it otherwise
 * (#1016 C2-F2, corrected by C2-F2b for the flat footprint; the ball's exact
 * contact is C2-F2c).
 *
 * ## The cutter at a pass
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
 * tip is at `(0, R)`. A flat end mill's bottom is a disc at the tip, so in this
 * cross-section the cutter occupies `|X| <= rt` and `Y >= R`, and the deepest
 * material it can touch is the square's largest `Y` inside that slab.
 *
 * A ball end mill is **not** that cylinder. Its tip is the lowest point of a
 * ball of radius `rt` whose centre is at `(0, R + rt)`, with the shank above
 * the centre. A blank point `(X, Y)` in the slab is inside the cutter exactly
 * when
 *
 *     Y >= R + rt - sqrt(rt^2 - X^2)      (the ball, below its centre)
 *     Y >= R + rt                          (the shank, above it)
 *
 * and the second is contained in the first because the root is non-negative.
 * So the layer touches the blank iff `R <= g(X, Y)` for some point of the
 * cross-section inside the slab, where
 *
 *     g(X, Y) = Y - rt + sqrt(rt^2 - X^2).
 *
 * `g <= Y`, with equality only on the pass ray, which is why the old cylinder
 * bound `max Y` is only an upper bound: it keeps whole air layers. Codex's
 * reproduction (20 mm square, 4 mm ball, A30) began cutting at
 * `Z = 22.642136` while the ball first meets the blank at `Z = 21.856406`.
 *
 * The earlier C2-F2 bound took the largest *radial* distance `r(phi)` over an
 * angular window. That is not where the cutter is either: at a fixed pass
 * angle the cutter spans a slab across the ray, and the material that matters
 * is its extent **along the cutter axis** inside that slab. On a 20 mm blank
 * at `A0` with a 4 mm flat and a 0.1 mm stepdown that bound emitted layers at
 * `Z = 20.1421` and `20.0421` above the `Z = 20` face — pure air.
 *
 * ## The bound
 *
 * The blank cross-section is the square `|u| <= side / 2`, `|v| <= side / 2`.
 * The deepest material the layer can touch is the maximum of the cutter's
 * contact function over the square inside `|X| <= rt` — `Y` for a flat bottom,
 * `g` for a ball. It does **not** depend on `R`: moving the tip only moves the
 * cutter's bottom, not how high the blank reaches inside the slab.
 *
 * ## Computing the maximum exactly
 *
 * The flat maximum is the largest `Y` over the convex square ∩ slab, so it is
 * attained at a vertex of that intersection: a rotated square vertex whose
 * `|X| <= rt`, or a crossing of a square edge with `X = ±rt`. Both are
 * enumerated exactly — no sampling and no angular window.
 *
 * For a ball, `g` is concave on the slab (`Y` is linear and `sqrt(rt^2 - X^2)`
 * is concave) and has no stationary point in the polygon's interior (its `Y`
 * derivative is `1`), so its maximum is on the boundary. The boundary is made
 * of pieces of square edges and pieces of `X = ±rt`:
 *
 * - on a piece of `X = ±rt` the root is zero and `g = Y - rt` is linear, so
 *   its maximum is at an endpoint: a square vertex or an edge crossing;
 * - on a square edge `Y = m X + c`, `dg/dX = m - X / sqrt(rt^2 - X^2) = 0`
 *   gives the interior tangency `X* = m rt / sqrt(1 + m^2)` (the sign follows
 *   the edge slope), evaluated only when it lies on the edge segment. A
 *   vertical edge is covered by its endpoints, since `g` is linear in `Y`
 *   there.
 *
 * The flat path evaluates exactly the C2-F2b candidates, with `heightAt`
 * returning `Y`, so its result is byte for byte unchanged.
 *
 * ## The layer gate
 *
 * The rough emits a layer when `R < S` and skips it when `R >= S`.
 * - If `R >= S`, no blank point in the slab is inside the cutter at that tip,
 *   so the layer would cut nothing and skipping it cannot change what is left.
 * - If `R < S`, the blank point attaining `S` is inside the cutter and cuts
 *   material. The layer above it was skipped (`barMaxRadius` is the "above"
 *   layer for the first one), so `R > S - stepdown`: the first bite at that
 *   angle is less than one stepdown deep. The generator's
 *   `tips < previousRadius` test decides which along positions still need
 *   cutting.
 *
 * `S` is the blank material's upper bound, never the model: an emitted layer
 * may still cut less than the full blank because the model may already stand
 * below it, but a skipped layer can never leave model material behind.
 *
 * Round bars: the maximum over a disc is the bar radius at every angle for the
 * flat cutter, and callers short-circuit them, so their output stays byte for
 * byte identical. The ball short circuit is never reached by the gate (a round
 * bar skips it) and stays the flat bound, which is conservative for a ball.
 */
export function squareRotaryTouchRadius(
  stock: BarStock,
  angleDeg: number,
  toolRadius: number,
  toolType: Tool['type'] = 'flat_endmill',
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
  // The blank height the cutter's lower surface reaches at a candidate point:
  // `Y` for a flat bottom, the ball's exact `g` otherwise (C2-F2c).
  const ball = toolType === 'ball_endmill'
  const heightAt = ball
    ? (x: number, y: number): number => y - reach + Math.sqrt(Math.max(0, reach * reach - x * x))
    : (_x: number, y: number): number => y
  let best = Number.NEGATIVE_INFINITY
  // A vertex inside the slab.
  for (let i = 0; i < CORNERS.length; i++) {
    if (Math.abs(xs[i]) <= reach + tolerance) best = Math.max(best, heightAt(xs[i], ys[i]))
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
      best = Math.max(best, heightAt(boundary, ys[i] + clamped * (ys[j] - ys[i])))
    }
    if (!ball) continue
    // The interior tangency of `g` on this edge, `X* = m rt / sqrt(1 + m^2)`.
    // It is a maximum only when it lies on the edge segment; `g` is linear in
    // `Y` on a vertical edge, which the endpoints already cover.
    const slope = (ys[j] - ys[i]) / dx
    const tangentX = (slope * reach) / Math.sqrt(1 + slope * slope)
    const tangentT = (tangentX - xs[i]) / dx
    if (tangentT < -tolerance || tangentT > 1 + tolerance) continue
    const tangent = Math.min(1, Math.max(0, tangentT))
    best = Math.max(best, heightAt(tangentX, ys[i] + tangent * (ys[j] - ys[i])))
  }
  return best
}
