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

import { barCentre, barInscribedRadius, barPivotZ, isSquareStock } from '../../types/barStock'
import { type BarStock, getStockBounds, type RoundStock } from '../../types/project'
import type { Units } from '../../utils/units'
import { minRenderHeight } from '../csg'
import type { RotaryFinishParams } from './rotaryModelParams'
import { alongExtremes, type RotaryModelMesh } from './rotarySampling'
import { squareBlankRetainedStub, squareBlankSectionExit } from './squareRotaryStock'
import type { NormalizedTool } from './types'

/**
 * True when any vertex of the target mesh lies outside the bar: past one of
 * the bar's ends, or outside its physical cross-section. For a round bar that
 * is farther from the axis than the radius; for a square blank (#1016 C2-S3)
 * it is outside the **box** `|across − centre| ≤ side / 2`, `|up − pivot| ≤
 * side / 2` — the actual blank, not the inscribed circle. The sampler only
 * sees the bar's own surface there, so those parts are machined as air.
 * `tolerance` is the 3D view's minimum render height, so a vertex the view
 * already draws on the surface is on it, not outside it.
 */
export function modelOutsideBar(mesh: RotaryModelMesh, stock: BarStock, tolerance: number): boolean {
  const bounds = getStockBounds(stock)
  const radius = barInscribedRadius(stock)
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const square = isSquareStock(stock)
  const minAlong = stock.axis === 'x' ? bounds.minX : bounds.minY
  const maxAlong = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const along = stock.axis === 'x' ? mesh.positions[i] : mesh.positions[i + 1]
    const across = stock.axis === 'x' ? mesh.positions[i + 1] : mesh.positions[i]
    const up = mesh.positions[i + 2]
    if (along < minAlong - tolerance || along > maxAlong + tolerance) return true
    if (square
      ? squareBlankSectionExit(stock, across, up, tolerance)
      : Math.hypot(across - centre, up - pivot) > radius + tolerance) return true
  }
  return false
}

/**
 * The material the blank keeps beyond the cut range, as a mesh the sampler
 * also reads: a closed cylinder of the round bar's own radius, or — for a
 * square blank (#1016 C2-S3) — the closed square prism of the blank's physical
 * cross-section, both coaxial with the turning pivot. A cylinder standing in
 * for a square blank would leave its corners unsupported and let a finite
 * cutter enter them. `null` for an empty span.
 */
function retainedBarStub(
  stock: BarStock,
  units: Units,
  alongFrom: number,
  alongTo: number,
  inset = 0,
): RotaryModelMesh | null {
  // #1095: erode the stub by `inset` in every direction — its own radius / half
  // side, and both along ends. The sampler's tool is enlarged by the same
  // amount, and a ball against an `s`-eroded solid is the real ball against the
  // real solid, so the retained wall keeps exactly the clearance the real cutter
  // needs instead of the stock to leave. A zero inset adds/subtracts exactly
  // zero, so the stock-to-leave-zero output is untouched.
  const from = alongFrom + inset
  const to = alongTo - inset
  return isSquareStock(stock)
    ? squareBlankRetainedStub(stock, from, to, inset)
    : retainedRoundStub(stock, units, from, to, inset)
}

/**
 * A closed solid cylinder of the bar's own radius, coaxial with it, spanning
 * `alongFrom` to `alongTo`. `segments` is the smallest count whose facet
 * sagitta `R (1 - cos(pi / segments))` stays within `minRenderHeight` of the
 * true surface, so the height map never reads the stub below the bar by more
 * than the 3D view's own minimum height (100 segments for a 40 mm bar at
 * 0.01 mm). `inset` erodes the cylinder by that distance (#1095): its radius and
 * both along ends move in, so a sampling tool enlarged by the same amount meets
 * the real wall exactly where the real cutter does. Returns `null` for an empty
 * span.
 */
function retainedRoundStub(
  stock: RoundStock,
  units: Units,
  alongFrom: number,
  alongTo: number,
  inset = 0,
): RotaryModelMesh | null {
  const radius = barInscribedRadius(stock) - inset
  if (!(alongTo - alongFrom > 0) || !(radius > 0)) return null
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const sagitta = minRenderHeight(units)
  const segments = Math.max(3, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - sagitta / radius))))
  const positions: number[] = []
  const index: number[] = []
  for (const along of [alongFrom, alongTo]) {
    for (let i = 0; i < segments; i++) {
      const t = 2 * Math.PI * i / segments
      const across = centre + radius * Math.cos(t)
      const up = pivot + radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    index.push(i, j, segments + j, i, segments + j, segments + i)
  }
  // Close both ends. The caps matter to any other consumer of the mesh; the
  // height map skips their vertical faces (`buildHeightMap`'s zero-denominator
  // test), which is why the side alone already covers it.
  for (let i = 1; i < segments - 1; i++) {
    index.push(0, i + 1, i)
    index.push(segments, segments + i, segments + i + 1)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/**
 * Add the bar beyond the cut range to the mesh that is sampled. It is stock to
 * keep: it holds the part to the end supports, and the tool's side must never
 * enter it. `rotaryAlongRange` keeps the tool *centre* inside the model's
 * extent, so at the model's end the cutter's side reaches a tool radius past it
 * -- on an off-axis prism (across 8..12, up 8..12, along 10..30) the rough
 * plunges to the centreline at along 10 and the cutter takes the bar at 9.5.
 *
 * With the two stubs in the mesh the existing tool-shape sampling does the work
 * by itself: a query within a tool radius of the retained bar is lifted to the
 * bar's surface, so the cutter's side cannot enter it. The stubs run from each
 * bar end to the cut range, which is the model's own end when the end supports
 * do not bind and the support keep-out when they do. The outside-bar check
 * (`modelOutsideBar`) still looks at the model alone, not at these.
 *
 * `includeSquareStubs` is false for a **square blank in around mode** (#1045
 * slice G). `rotaryCutterSpan` already keeps the ring's centre one cutter
 * radius inside a stub face, so the cutter is tangent to the face and the exact
 * `squareRotaryStubContactFloor` is the net that catches any real overlap. The
 * square stub inside the sampling mesh is then *not* a contact: the tool's rim
 * merely touches the face, while the height map reads the whole retained square
 * across the footprint and lifts the tip to the blank's corner. On a 20 x
 * 1,000 blank with 100 mm retained ends that raised the ring's tip above its
 * layer radius, which both multiplied the emitted moves (the refinement chased
 * the raised samples) and left a corner the next layer then took more than
 * `stepdown` out of -- the overcut the export guard found. The along pass keeps
 * the stub in its mesh byte for byte.
 *
 * `stubStart`/`stubEnd` are false at an end the target itself ends at (#1155
 * rn-e), and then that retained cylinder is simply not added: the plain bar
 * beyond the model is material the operation may cut into, and a wall standing
 * there is what left the one-tool-radius ridge at each of the target's ends.
 * A square blank never passes false (`rotarySampledMesh`), because its retained
 * corners are what holds the part rather than a turnable surface.
 *
 * `wallInset` erodes both stubs by that distance (#1095). `rotaryTargets`
 * passes the stock to leave here for a rough and a finish alike, because the
 * sampler is about to enlarge its tool by the same amount:
 * `(wall ⊖ s) ⊕ (R + s) = wall ⊕ R`, so the retained wall is met by the real
 * cutter instead of one thickened by the leave. Zero adds and subtracts exactly
 * zero, so stock-to-leave-zero output is untouched.
 */
function withRetainedBar(
  mesh: RotaryModelMesh,
  stock: BarStock,
  units: Units,
  alongStart: number,
  alongEnd: number,
  includeSquareStubs = true,
  wallInset = 0,
  stubStart = true,
  stubEnd = true,
): RotaryModelMesh {
  if (isSquareStock(stock) && !includeSquareStubs) return mesh
  const stubs = retainedBarStubs(stock, units, alongStart, alongEnd, wallInset, stubStart, stubEnd)
  if (stubs.length === 0) return mesh
  const positions = new Float32Array(mesh.positions.length + stubs.reduce((total, stub) => total + stub.positions.length, 0))
  positions.set(mesh.positions)
  const index = new Uint32Array(mesh.index.length + stubs.reduce((total, stub) => total + stub.index.length, 0))
  index.set(mesh.index)
  let positionOffset = mesh.positions.length
  let indexOffset = mesh.index.length
  let vertexOffset = mesh.positions.length / 3
  for (const stub of stubs) {
    positions.set(stub.positions, positionOffset)
    for (let i = 0; i < stub.index.length; i++) index[indexOffset + i] = stub.index[i] + vertexOffset
    positionOffset += stub.positions.length
    indexOffset += stub.index.length
    vertexOffset += stub.positions.length / 3
  }
  // #1095 slice D: the stubs are appended after the model, so every triangle
  // from this one on is retained-wall geometry. The sampler uses the boundary to
  // tell a wall cell from a model cell; without it a pass tangent to the wall's
  // face reads the wall's top and lifts off the model.
  return { positions, index, retainedTriangleStart: mesh.index.length / 3 }
}

/**
 * The two retained stubs an operation's cut range leaves at the bar's ends,
 * each already closed, with no model attached. `wallInset` is `withRetainedBar`'s
 * erosion (#1095). `withRetainedBar` concatenates these with the model; the
 * un-eroded set is also what the height-map grid is widened back to, so the
 * erosion cannot move the grid origin.
 *
 * `stubStart`/`stubEnd` are false at a band end the **target itself** ends at
 * (#1155 rn-e): the plain bar beyond the model is material the approved rule
 * lets the operation cut into, so the retained wall must not stand there. A
 * square blank gives up the stub there too (#1190).
 */
export function retainedBarStubs(
  stock: BarStock,
  units: Units,
  alongStart: number,
  alongEnd: number,
  wallInset = 0,
  stubStart = true,
  stubEnd = true,
): RotaryModelMesh[] {
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  return [
    stubStart ? retainedBarStub(stock, units, lower, alongStart, wallInset) : null,
    stubEnd ? retainedBarStub(stock, units, alongEnd, upper, wallInset) : null,
  ].filter((stub): stub is RotaryModelMesh => stub !== null)
}

/** Concatenate meshes into one; the stubs are a few hundred vertices each. */
export function concatRotaryMeshes(meshes: readonly RotaryModelMesh[]): RotaryModelMesh {
  const positions = new Float32Array(meshes.reduce((total, mesh) => total + mesh.positions.length, 0))
  const index = new Uint32Array(meshes.reduce((total, mesh) => total + mesh.index.length, 0))
  let positionOffset = 0
  let indexOffset = 0
  let vertexOffset = 0
  for (const mesh of meshes) {
    positions.set(mesh.positions, positionOffset)
    for (let i = 0; i < mesh.index.length; i++) index[indexOffset + i] = mesh.index[i] + vertexOffset
    positionOffset += mesh.positions.length
    indexOffset += mesh.index.length
    vertexOffset += mesh.positions.length / 3
  }
  return { positions, index }
}

/**
 * Whether an operation keeps the square blank's own rules (#1190).
 *
 * An **around** pass reads, bounds and cleans a square blank exactly as it does
 * a round bar: the exact read for a ball (#1177), the shoulder cleanup ring, the
 * exact layer floor (#1173) and the band-end overrun (#1155 rn-e). The approved
 * rule (Frank, 2026-11-20) is that the same model gives the same result on
 * either blank. The square blank's rules there were never about the read: in
 * around mode its stubs are not in the sampled mesh, and every square rule
 * (the stub floors, the forced step, the corner material gate) is closed-form
 * and applied after sampling. An **along** pass keeps the conservative read and
 * its square rules; the band-end overrun applies to both directions (Frank,
 * 2026-11-22), so it is not gated here.
 */
export function usesSquareBlankRules(
  stock: BarStock,
  params: Pick<RotaryFinishParams, 'passDirection'>,
): boolean {
  return isSquareStock(stock) && params.passDirection !== 'around'
}

/** Two along positions closer than this are the same coordinate (#1155 rn-e). */
const BAND_END_EPSILON = 1e-9

/**
 * Which ends of a cut band are the **target's own** ends (#1155 rn-e).
 *
 * The approved rule (Frank, 2026-11-06) is that the plain bar beyond a model's
 * end is material the operation **may cut into**: a rough or a finish runs the
 * cutter to the edge of its target's surface, a ball's or flat's centre may go
 * up to the model's end, and only another model, an end support, a chuck or
 * tailstock keep-out or the bar's outside may stop it.
 *
 * The range itself (`rotaryAlongRange`) clamps to the model's extent before any
 * support or keep-out can widen it, so a range end that equals the model's own
 * end is exactly the case where no support or keep-out binds there. Anything
 * shorter -- an end support or a keep-out inside the model -- stays a bound and
 * keeps every rule it had. `alongExtremes` reads the target mesh the range was
 * derived from, so the two agree by construction.
 */
export function targetBandOverrun(
  mesh: RotaryModelMesh,
  stock: BarStock,
  params: Pick<RotaryFinishParams, 'alongStart' | 'alongEnd'>,
): { start: boolean; end: boolean } {
  const along = alongExtremes(mesh.positions, stock)
  if (!Number.isFinite(along.min) || !Number.isFinite(along.max)) {
    return { start: false, end: false }
  }
  // **Equality**, not "inside": `rotaryAlongRange` clamps a saved operation's
  // range to the model's extent, so an end the model owns sits exactly on it.
  // A direct generator call may hand over a range wider than the model (the
  // sampling suites do), and that band must stay the band it was.
  const at = (band: number, model: number): boolean => Math.abs(band - model) <= BAND_END_EPSILON * Math.max(1, Math.abs(model))
  return {
    start: at(params.alongStart, along.min),
    end: at(params.alongEnd, along.max),
  }
}

/**
 * How one operation's cut band is bounded at each end (#1155 rn-e).
 *
 * `stub` is the retained-bar wall that keeps the plain bar beyond the band
 * uncut; `pull` is the one-radius pull of the cutter centre inside a stubbed
 * end (`rotaryCutterSpan`).
 *
 * - An end a **support or keep-out** bounds keeps both, exactly as before, so
 *   every project whose band already ends against a support is byte-identical.
 * - An end the **target itself** ends at loses the stub: the retained bar beyond
 *   the model no longer blocks the tool. Its centre may also reach the end
 *   (`pull` false) **unless a neighbour's wall stands there** -- another model
 *   still stops the tool, exactly as #1155 rn-a..rn-d require, and the wall-foot
 *   ring `rotaryWallFeet` puts at that wall's foot is where the tool first
 *   follows the target's own surface.
 * - A **square blank** takes the same rule in both pass directions (#1190), and
 *   its closed-form stub floors skip an overrun end (`squareRetainedStubs`).
 */
export interface RotaryBandEnds {
  readonly stubStart: boolean
  readonly stubEnd: boolean
  readonly pullStart: boolean
  readonly pullEnd: boolean
}

export const KEEP_BAND_ENDS: RotaryBandEnds = {
  stubStart: true, stubEnd: true, pullStart: true, pullEnd: true,
}

/**
 * The span the cutter's **centre** may travel inside a cut range (#1016 C2-F7).
 *
 * A square blank keeps the bar beyond the cut range as retained stock, so a cut
 * range that ends inside the bar ends on a stub face. `rotaryAlongRange` limits
 * the centre to the model's extent, which puts it exactly on that face, and the
 * cutter then reaches a full radius into the retained square. Pulling the centre
 * one cutter radius inside each stubbed end makes the cutter's rim tangent to
 * the face: the cutter stays wholly inside the band, every sample is at or
 * beyond the F6 floor's reach (so that exact floor is a net that no longer
 * binds), and the pass starts and ends with the emitter's own plunge and
 * retract. The price, approved for this slice, is that the band within one
 * cutter radius of a stub face keeps the shoulder fillet the cutter's side
 * leaves there.
 *
 * The pull is rounded **outward** (#1016 C2-F7b): each end is placed a tiny
 * relative margin (`1e-12` of the coordinate) beyond `face +/- radius`, and the
 * computed gap is verified to be at least the radius, so `start - alongStart >=
 * radius` and `alongEnd - end >= radius` hold. `face + radius` can round one ulp
 * below `radius`, and the along grid's last sample can round a few ulps past the
 * span end; the F6 floor's strict `gap < reach` test would then lift that
 * first/last sample to the blank's height -- a shoulder tick on every pass. The
 * margin is thousands of ulps and about `1e-10 mm` on a 100 mm bar: far below
 * any real overlap, and enough that neither rounding can cross the tangency. The
 * floor stays strict; this span is what keeps every real sample at or beyond it.
 *
 * The end of a range that meets the bar's own end has no stub and is unchanged.
 * The pull is **not** square-only (#1045 slice D): a round bar keeps its own
 * retained cylinder beyond the cut range (`retainedRoundStub`), and the cutter
 * body reaches the same one-radius distance into it. On Codex's repro (Ø40 x 60
 * bar, band X18..42, Ø6 flat, 2.7 stepover, 0.75 sample spacing) the round
 * ring at X20.6667 overlapped the retained end by 0.3333 mm and still cut at
 * Z24.97 against the stub's Z40 surface -- the overlap was thinner than the
 * height-map cell, so the sampler's discrete footprint missed the sliver
 * entirely. Both around and along mode gouged at that along position (the
 * along pass at sample spacing 2.9 and at 0.5 measured the same 0.3333 mm
 * overlap below the stub). Pulling the centre in on a round bar too removes the
 * overlap exactly, and the price is the square's: the band within one cutter
 * radius of a stubbed end keeps the shoulder fillet the cutter's side leaves
 * there. Every round fixture whose band meets the bar's ends is untouched, and
 * every saved along path whose band does not loses that last radius at each
 * stubbed end -- a safety fix, so byte-identity yields.
 *
 * `null` when the two pulls cross: the caller refuses with the existing
 * `rotaryNoRoom`, exactly as for an already-empty range.
 *
 * #1155 rn-e: `ends` says which ends still need the pull. An end the **target**
 * itself ends at, with no neighbour's wall standing there, is pulled **not at
 * all**: the approved rule (2026-11-06) is that the plain bar beyond a model's
 * end is material the operation may cut into, so the centre reaches the model's
 * end and a ball's or flat's body reaches the edge. The retained stub goes with
 * it (`rotarySampledMesh`), because a wall standing at the end is exactly what
 * leaves the ridge this slice removes. A support, a keep-out or a neighbour's
 * wall keeps the old pull byte for byte.
 */
export function rotaryCutterSpan(
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  ends: RotaryBandEnds = KEEP_BAND_ENDS,
): { start: number; end: number } | null {
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  // Both bar shapes keep stock beyond the cut range, so both need the pull;
  // only an end that meets the bar's own end has no stub to stay out of.
  const radius = tool.radius
  // `Math.nextUp`/`Math.nextDown` are only proposals, so step the raw bits: one
  // unit in the last place. The verification loops below rarely need it.
  const ulpStep = (value: number, direction: 1 | -1): number => {
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, value)
    view.setBigUint64(0, view.getBigUint64(0) + BigInt(value >= 0 ? direction : -direction))
    return view.getFloat64(0)
  }
  let start = params.alongStart
  if (radius > 0 && params.alongStart > lower && ends.pullStart) {
    // The exact sum can round below the radius, and the along grid's last
    // sample (`start + (end - start) * i / intervals` in `rotaryAlongPositions`)
    // can round a few ulps past the span end, so a one-ulp pull is not enough
    // (#1016 C2-F7b). A nudge of `1e-12` of the coordinate is thousands of ulps
    // -- about `1e-10 mm` on a 100 mm bar -- and orders of magnitude below any
    // real overlap, so the strict F6 floor sees a tangency at every sampled end.
    const margin = Math.max(Math.abs(params.alongStart), radius) * 1e-12
    start = params.alongStart + radius + margin
    for (let i = 0; i < 8 && start - params.alongStart < radius; i++) start = ulpStep(start, 1)
  }
  let end = params.alongEnd
  if (radius > 0 && upper > params.alongEnd && ends.pullEnd) {
    const margin = Math.max(Math.abs(params.alongEnd), radius) * 1e-12
    end = params.alongEnd - radius - margin
    for (let i = 0; i < 8 && params.alongEnd - end < radius; i++) end = ulpStep(end, -1)
  }
  return start < end ? { start, end } : null
}

/**
 * The mesh a rotary operation samples: the **target**, then the operation's
 * **neighbours**, then the retained bar stubs (#1155).
 *
 * The order is the contract. The neighbours come before the stubs so
 * `retainedTriangleStart` still marks only wall triangles: the sampler treats a
 * wall as stock to keep and not as a surface to follow (#1095 slice D), while a
 * neighbour is exactly a surface to follow. A neighbour appended after a stub
 * would be read as retained stock and a pass beside it lifted off it.
 *
 * Joining a mesh moves more than its cells. The around sampler reads its
 * conservative margin from the **rasterised triangles** -- `trackCellRise` in
 * `rotaryRaster.ts` takes the largest `(|dz/dx| + |dz/dy|) * cell / 2` over the
 * triangles that cover the angle's window, `runRotaryAngleJob` reports it as
 * `lift`, and `assembleRotarySampling` adds it to every finite sample of that
 * angle. A neighbour below the target can therefore raise an angle's margin
 * without changing a single cell value (its triangles are steeper than the
 * target's), which is the one accepted drift of #1155: it is upward-only, it is
 * capped at one height-map cell, and it can never put an emitted point deeper
 * than the target-only run (#1155 acceptance 2, pinned by the drift checks in
 * `rotaryNeighbours.test.ts`).
 */
export function rotarySampledMesh(
  mesh: RotaryModelMesh,
  neighbours: readonly RotaryModelMesh[] | undefined,
  stock: BarStock,
  units: Units,
  params: Pick<RotaryFinishParams, 'alongStart' | 'alongEnd' | 'passDirection' | 'stockToLeave'>,
): RotaryModelMesh {
  const sampledMesh = neighbours !== undefined && neighbours.length > 0
    ? concatRotaryMeshes([mesh, ...neighbours])
    : mesh
  // A square blank's around rings are protected from the retained stub by the
  // cutter-centre span pull and the exact stub floor, not by the height map;
  // including the stub here lifted every ring's tip near an end to the blank's
  // corner (#1045 slice G). Along mode keeps the stub in the mesh byte for byte.
  // Neighbours still go in on a square blank in around mode: they are material,
  // not retained stock (#1155).
  const includeSquareStubs = !(isSquareStock(stock) && params.passDirection === 'around')
  // #1155 rn-e: no retained wall stands at an end the target itself ends at, so
  // the body may cut the plain bar beyond it. `mesh` is the **target** here (the
  // neighbours are concatenated above), so the test reads exactly the extent the
  // cut range was clamped to. #1190: a square blank takes the same rule in both
  // pass directions, so a rough and the finish after it agree about the ends.
  const overrun = targetBandOverrun(mesh, stock, params)
  return withRetainedBar(
    sampledMesh,
    stock,
    units,
    params.alongStart,
    params.alongEnd,
    includeSquareStubs,
    params.stockToLeave,
    !overrun.start,
    !overrun.end,
  )
}
