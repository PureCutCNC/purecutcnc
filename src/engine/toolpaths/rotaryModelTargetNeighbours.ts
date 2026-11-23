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

import { barCentre, barInscribedRadius, barPivotZ } from '../../types/barStock'
import { type BarStock, getStockBounds } from '../../types/project'
import { minRenderHeight } from '../csg'
import { appendAll } from './appendAll'
import type { RotaryFinishParams } from './rotaryModelParams'
import {
  KEEP_BAND_ENDS,
  type RotaryBandEnds,
  rotarySampledMesh,
  targetBandOverrun,
} from './rotaryModelTargetGeometry'
import { rotaryConservativeSampling } from './rotaryModelTargetSampling'
import {
  alongExtremes,
  createRotarySamplingPrep,
  type RotaryModelMesh,
  type RotarySamplingPrep,
} from './rotarySampling'
import type { NormalizedTool } from './types'

/**
 * True when a neighbour's surface stands more than the surface tolerance above
 * the target's over the along window on one side of `face` (#1155 rn-e).
 *
 * This is `rotaryWallFeet`'s own step test, lifted out so a band end can ask it
 * about the target's end: `direction +1` is a neighbour whose material lies at
 * `along <= face` (a wall the band meets from its +x side), `-1` the mirror.
 * Both surfaces are read per angle, so a polygon target's flats are compared
 * with their own apothem.
 */
function neighbourRisesAcross(
  neighbours: readonly RotaryModelMesh[] | undefined,
  mesh: RotaryModelMesh,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  face: number,
  direction: 1 | -1,
): boolean {
  if (neighbours === undefined || neighbours.length === 0) return false
  const tolerance = minRenderHeight(tool.units)
  const window = tool.radius + Math.max(0, params.stockToLeave)
  const neighbourSide = direction > 0 ? [face - window, face] : [face, face + window]
  const bandSide = direction > 0 ? [face, face + window] : [face - window, face]
  const targetTops = meshSurfaceTops(mesh, stock, bandSide[0], bandSide[1])
  for (const neighbour of neighbours) {
    const neighbourTops = meshSurfaceTops(neighbour, stock, neighbourSide[0], neighbourSide[1])
    for (let bin = 0; bin < WALL_ANGLE_BINS; bin++) {
      if (!Number.isFinite(neighbourTops[bin]) || !Number.isFinite(targetTops[bin])) continue
      if (neighbourTops[bin] > targetTops[bin] + tolerance) return true
    }
  }
  return false
}

/**
 * The band ends for one operation (#1155 rn-e): `targetBandOverrun` decides
 * which ends the target itself owns, and the band gives up the stub and the
 * centre pull there, on either blank and in either pass direction (#1190).
 */
export function rotaryBandEnds(
  mesh: RotaryModelMesh,
  neighbours: readonly RotaryModelMesh[] | undefined,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
): RotaryBandEnds {
  const overrun = targetBandOverrun(mesh, stock, params)
  if (!overrun.start && !overrun.end) return KEEP_BAND_ENDS
  const along = alongExtremes(mesh.positions, stock)
  // #1155 rn-e: another model still stops the tool at the target's end. Its
  // material is what the body must not enter, so the one-radius pull stays and
  // the stub goes: with the neighbour in the sampled mesh the wall's foot is
  // read from the neighbour itself, and a retained cylinder of the bar's own
  // radius on top of it only adds a height-map cell of over-lift (#1155 rn-e's
  // second case).
  const wallStart = overrun.start
    && neighbourRisesAcross(neighbours, mesh, stock, tool, params, along.min, 1)
  const wallEnd = overrun.end
    && neighbourRisesAcross(neighbours, mesh, stock, tool, params, along.max, -1)
  return {
    stubStart: !overrun.start,
    stubEnd: !overrun.end,
    pullStart: !(overrun.start && !wallStart),
    pullEnd: !(overrun.end && !wallEnd),
  }
}

/**
 * The band faces a shoulder-cleanup ring is needed at (#1177).
 *
 * `rotaryBandEnds` pulls the cutter's centre one radius inside an end a
 * neighbour's wall stands at, so the first ring's **rim** is the only part of it
 * that reaches the band face -- and where that neighbour's flat runs *across*
 * the face, the material above the flat inside the overlap is left as a wedge
 * tapering off along the rim: the ledge #1177 is about.
 *
 * A face qualifies when the band end is pulled by a neighbour's rising wall
 * (`overrun.start && wallStart`, which is exactly `pullStart && !stubStart`) and
 * a neighbour's span **strictly contains** the face, so the flat the ring has to
 * clear runs across it. A neighbour that merely *ends* at the face is the
 * #1155 rn-e case: there is no flat beyond the face to sweep, and no ring is
 * added.
 *
 * Each face gets **two** rings, on the quarters of the overlap rather than one
 * on its middle (#1177 correction 2). A flat disc reaches only radii up to
 * `sqrt(r^2 - d^2) / sin(delta)` at angular offset `delta` from its own pose, and
 * the pose that clears the flat's corner is the one at that limit -- so the along
 * distance `d` to the nearest ring bounds what the sweep can reach. Halving the
 * overlap's largest distance from `0.025 in` to `0.0125 in` takes the worst
 * residual from 0.080 mm (the correction's single middle ring) to 0.062 mm; the
 * second improvement, the three spring passes, is in `cleanupRuns`.
 *
 * The rings' own tips are not read here: the positions are merged into the along
 * grid before `rotaryNeighbourColumns`, so they are neighbour-reach columns and
 * take the exact footprint read on the mesh *with* the neighbours. That is the
 * protection -- the cutter's body never goes below the neighbour's surface -- and
 * it is why the cleanup needs no new sampling code.
 */
export function shoulderCleanFaces(
  neighbours: readonly RotaryModelMesh[] | undefined,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  ends: RotaryBandEnds,
): number[] {
  if (params.passDirection !== 'around') return []
  if (neighbours === undefined || neighbours.length === 0) return []
  const tolerance = minRenderHeight(tool.units)
  const extents = neighbours
    .map((neighbour) => alongExtremes(neighbour.positions, stock))
    .filter((extent) => Number.isFinite(extent.min) && Number.isFinite(extent.max))
  const crossing = (face: number): typeof extents => extents.filter((extent) =>
    extent.min < face - tolerance && extent.max > face + tolerance)
  // The two rings sit on the overlap's quarters, so the whole overlap is within
  // a quarter of its width of one of them. A ring on the band face itself would
  // leave the far half that far away, and the handoff's X=31.496 mm spot would
  // keep its ledge.
  const centred = (face: number, fromStart: boolean): number[] => {
    const near = crossing(face)
    if (near.length === 0) return []
    const edge = fromStart
      ? Math.min(...near.map((extent) => extent.max))
      : Math.max(...near.map((extent) => extent.min))
    const width = edge - face
    return [0.25, 0.75]
      .map((fraction) => face + width * fraction)
      .filter((position) => (position > face) === fromStart)
  }
  const faces: number[] = []
  if (ends.pullStart && !ends.stubStart) appendAll(faces, centred(params.alongStart, true))
  if (ends.pullEnd && !ends.stubEnd) appendAll(faces, centred(params.alongEnd, false))
  return faces
}

/**
 * `base` extended with extra along positions, sorted, within
 * `WALL_FOOT_EPSILON` (the grid's own spacing tolerance). A position already on
 * the grid keeps its one column.
 */
export function mergeAlongPositions(base: readonly number[], extra: readonly number[]): number[] {
  if (extra.length === 0) return [...base]
  const merged: number[] = []
  for (const x of [...base, ...extra].sort((a, b) => a - b)) {
    if (merged.length === 0 || x - merged[merged.length - 1] > WALL_FOOT_EPSILON) merged.push(x)
  }
  return merged
}

/** Two along positions closer than this are the same ring (#1155 rn-d). */
export const WALL_FOOT_EPSILON = 1e-9

/**
 * A neighbour's wall rising out of the band, and the cutter-centre position its
 * foot is cut from (#1155 slice rn-d).
 *
 * The finish's band starts one cutter radius inside its along range, so its
 * first ring sits beside a neighbour's end face and **rides** that neighbour's
 * surface: at Frank's bolt the Hex's far face at 1.25 is 0.05 in inside the
 * Turn's 1.2 range cut, so the ring at 1.325 spans 1.200..1.450 and reads the
 * Hex. The tool can first follow the Turn's own surface at centre 1.375, one
 * cutter radius past that face, and from there the helix advances about one
 * stepover per turn -- so each angle crosses 1.375 on a different turn and the
 * material between the face and that crossing is left standing, a stair-step
 * ledge up to one stepover wide. The rough has the same wall but starts its
 * layers' full rings a grid position past the reach, which leaves the same
 * defect smaller.
 *
 * The fix is one ring at the wall's foot. A ring at `face + leave + radius`
 * reaches exactly to the face -- the cutter's body is **tangent** to it, never
 * inside it -- so it may read the target's own surface there instead of the
 * neighbour-lifted one, and it clears the material above the target from
 * `face + leave` on. `direction` says which side the neighbour's material is
 * on: `+1` for material at `along <= face` (the wall rises towards -x, so the
 * band is on the face's +x side and the foot is at `face + leave + radius`),
 * `-1` for the mirror (a neighbour rising at the band's far end).
 */
export interface RotaryWallFoot {
  /** The neighbour's end face, in along coordinates. */
  readonly face: number
  /** The cutter-centre position whose body just clears the face by the leave. */
  readonly foot: number
  /** `+1` when the neighbour's material lies at `along <= face`, `-1` when at `along >= face`. */
  readonly direction: 1 | -1
}

/**
 * The angular resolution of the wall test (#1155 rn-d correction 1): one degree,
 * the same resolution the leftover sweep reads the part at.
 */
const WALL_ANGLE_BINS = 360

/**
 * The largest radius of a straight section `(x, s)` over the part of it inside
 * the along window `[from, to]` and on the positive-radius (material) side.
 * `s` is affine in `x`, so the maximum is at a clamped endpoint.
 */
function sectionTopRadius(
  x0: number, s0: number, x1: number, s1: number, from: number, to: number,
): number {
  if (x0 > x1) {
    const x = x0
    const s = s0
    x0 = x1
    s0 = s1
    x1 = x
    s1 = s
  }
  if (s0 < 0 && s1 < 0) return Number.NEGATIVE_INFINITY
  let lo = x0
  let hi = x1
  if (s0 < 0 || s1 < 0) {
    const zero = x0 + (x1 - x0) * (s0 / (s0 - s1))
    if (s0 < 0) lo = Math.max(lo, zero)
    else hi = Math.min(hi, zero)
  }
  const a = Math.max(lo, from)
  const b = Math.min(hi, to)
  if (b < a) return Number.NEGATIVE_INFINITY
  if (x1 - x0 < 1e-12) return Math.max(s0, s1)
  const at = (x: number): number => s0 + ((s1 - s0) * (x - x0)) / (x1 - x0)
  return Math.max(at(a), at(b))
}

/**
 * The surface radius of `mesh` beside an end face, per one-degree angle bin
 * (#1155 rn-d): the largest radius the mesh carries at that angle over the along
 * window `[from, to]`, or `-Infinity` where it has no surface.
 *
 * The triangle is intersected with the half-plane through the bar's axis at the
 * bin's angle, so a facet's own radius is read rather than its corners': a
 * polygon target shows its flats at their apothem and its corners at their own
 * radius, and a neighbour rising out of the **flats** is visible even when the
 * target's corners stand above it. Comparing the two meshes' largest radii over
 * all angles (the first rn-d cut) could not see that, and missed a required
 * wall-foot ring on every angle whose neighbour stood only above the flats:
 * flats 0.75, corners 0.866, neighbour 0.8 read as "no step" although the
 * neighbour is 0.05 in above the flats.
 *
 * A triangle whose cross-section spans more than half a turn is a cap (a disc
 * through the axis) and reports its largest radius at every angle; a bar's
 * surface triangles never span that far.
 */
function meshSurfaceTops(
  mesh: RotaryModelMesh,
  stock: BarStock,
  from: number,
  to: number,
): Float64Array {
  const tops = new Float64Array(WALL_ANGLE_BINS)
  tops.fill(Number.NEGATIVE_INFINITY)
  const positions = mesh.positions
  const index = mesh.index
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const xAxis = stock.axis === 'x'
  const triangles = Math.floor(index.length / 3)
  const along = [0, 0, 0]
  const across = [0, 0, 0]
  const up = [0, 0, 0]
  const angle = [0, 0, 0]
  const radii = [0, 0, 0]
  const pointX: number[] = []
  const pointS: number[] = []
  const sorted = [0, 0, 0]
  const gaps = [0, 0, 0]
  const distance = [0, 0, 0]
  for (let t = 0; t < triangles; t++) {
    let alongMin = Number.POSITIVE_INFINITY
    let alongMax = Number.NEGATIVE_INFINITY
    for (let corner = 0; corner < 3; corner++) {
      const vertex = index[t * 3 + corner] * 3
      const px = positions[vertex]
      const py = positions[vertex + 1]
      along[corner] = xAxis ? px : py
      across[corner] = (xAxis ? py : px) - centre
      up[corner] = positions[vertex + 2] - pivot
      radii[corner] = Math.hypot(across[corner], up[corner])
      angle[corner] = (((Math.atan2(across[corner], up[corner]) * 180) / Math.PI) + 360) % 360
      if (along[corner] < alongMin) alongMin = along[corner]
      if (along[corner] > alongMax) alongMax = along[corner]
    }
    // A triangle counts when its own along span overlaps the window, so a coarse
    // mesh -- a canned cylinder whose only vertices are at its two ends -- still
    // reports the surface it carries across the window.
    if (alongMax < from || alongMin > to) continue
    // The arc the triangle's cross-section covers: everything but its largest
    // angular gap.
    sorted[0] = angle[0]
    sorted[1] = angle[1]
    sorted[2] = angle[2]
    let swap = 0
    if (sorted[0] > sorted[1]) { swap = sorted[0]; sorted[0] = sorted[1]; sorted[1] = swap }
    if (sorted[1] > sorted[2]) { swap = sorted[1]; sorted[1] = sorted[2]; sorted[2] = swap }
    if (sorted[0] > sorted[1]) { swap = sorted[0]; sorted[0] = sorted[1]; sorted[1] = swap }
    gaps[0] = sorted[1] - sorted[0]
    gaps[1] = sorted[2] - sorted[1]
    gaps[2] = sorted[0] + 360 - sorted[2]
    let widest = 0
    for (let g = 1; g < 3; g++) if (gaps[g] > gaps[widest]) widest = g
    const span = 360 - gaps[widest]
    if (span > 180) {
      // A cap through the axis: its own radius stands at every angle.
      const radius = Math.max(radii[0], radii[1], radii[2])
      for (let bin = 0; bin < WALL_ANGLE_BINS; bin++) if (radius > tops[bin]) tops[bin] = radius
      continue
    }
    const start = sorted[(widest + 1) % 3]
    const first = Math.floor((start * WALL_ANGLE_BINS) / 360) - 1
    const last = Math.ceil(((start + span) * WALL_ANGLE_BINS) / 360) + 1
    for (let step = first; step <= last; step++) {
      const bin = ((step % WALL_ANGLE_BINS) + WALL_ANGLE_BINS) % WALL_ANGLE_BINS
      const alpha = (bin * 2 * Math.PI) / WALL_ANGLE_BINS
      const sin = Math.sin(alpha)
      const cos = Math.cos(alpha)
      pointX.length = 0
      pointS.length = 0
      distance[0] = across[0] * cos - up[0] * sin
      distance[1] = across[1] * cos - up[1] * sin
      distance[2] = across[2] * cos - up[2] * sin
      for (let edge = 0; edge < 3; edge++) {
        const next = (edge + 1) % 3
        if (Math.abs(distance[edge]) <= 1e-12) {
          pointX.push(along[edge])
          pointS.push(across[edge] * sin + up[edge] * cos)
        }
        const d0 = distance[edge]
        const d1 = distance[next]
        if ((d0 < 0 && d1 > 0) || (d0 > 0 && d1 < 0)) {
          const u = d0 / (d0 - d1)
          const x = along[edge] + (along[next] - along[edge]) * u
          const a = across[edge] + (across[next] - across[edge]) * u
          const b = up[edge] + (up[next] - up[edge]) * u
          pointX.push(x)
          pointS.push(a * sin + b * cos)
        }
      }
      if (pointX.length === 0) continue
      let top = Number.NEGATIVE_INFINITY
      for (let i = 0; i < pointX.length; i++) {
        for (let j = i + 1; j < pointX.length; j++) {
          const candidate = sectionTopRadius(pointX[i], pointS[i], pointX[j], pointS[j], from, to)
          if (candidate > top) top = candidate
        }
      }
      // A single vertex on the plane is a zero-length section.
      if (pointX.length === 1 && pointX[0] >= from && pointX[0] <= to
        && pointS[0] >= 0 && pointS[0] > top) {
        top = pointS[0]
      }
      if (top > tops[bin]) tops[bin] = top
    }
  }
  return tops
}

/**
 * Every neighbour wall that rises out of this operation's band (#1155 rn-d), in
 * along order, with the cutter-centre position its foot is cut from.
 *
 * A neighbour's end face is a wall when it stands **inside** the cutter-centre
 * span -- a face the band already clears needs no ring, and one the whole band
 * stands on has no foot to step out of -- and when the neighbour's own surface
 * beside that face stands more than the surface tolerance above the target's
 * surface on the band's side of it, which is what "the surface the tool follows
 * steps up" means. Both surfaces are read **per angle** (`meshSurfaceTops`), so
 * the step is the one the tool follows along the radial line it cuts: a polygon
 * target's flats are compared with their own apothem, not with the corner that
 * happens to stand above the neighbour, and a neighbour rising only out of the
 * flats still gets its ring. The position comes from the neighbour's **mesh**,
 * never from where the conservative height-map read happens to drop: the read
 * reaches a whole cell past its sample, so a position taken from it is pushed
 * out by up to a cell, and the wall's foot would miss by that much.
 *
 * Around mode only. The ring and helix placement this fixes is around mode's;
 * along mode's passes are at fixed angles and keep their output byte for byte.
 */
export function rotaryWallFeet(
  mesh: RotaryModelMesh,
  neighbours: readonly RotaryModelMesh[] | undefined,
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  span: { readonly start: number; readonly end: number },
): RotaryWallFoot[] {
  if (params.passDirection !== 'around') return []
  const tolerance = minRenderHeight(tool.units)
  const leave = Math.max(0, params.stockToLeave)
  // One cutter radius along the bar, the window the handoff's "within one tool
  // radius along the bar" names: the surface beside the face on each side.
  const window = tool.radius + leave
  const feet: RotaryWallFoot[] = []
  for (const neighbour of neighbours ?? []) {
    const extremes = alongExtremes(neighbour.positions, stock)
    if (!Number.isFinite(extremes.min) || !Number.isFinite(extremes.max)) continue
    for (const direction of [1, -1] as const) {
      const face = direction > 0 ? extremes.max : extremes.min
      const foot = face + direction * (leave + tool.radius)
      if (!(foot >= span.start - WALL_FOOT_EPSILON && foot <= span.end + WALL_FOOT_EPSILON)) continue
      const neighbourSide = direction > 0 ? [face - window, face] : [face, face + window]
      const bandSide = direction > 0 ? [face, face + window] : [face - window, face]
      const neighbourTops = meshSurfaceTops(neighbour, stock, neighbourSide[0], neighbourSide[1])
      const targetTops = meshSurfaceTops(mesh, stock, bandSide[0], bandSide[1])
      let rises = false
      for (let bin = 0; bin < WALL_ANGLE_BINS; bin++) {
        if (!Number.isFinite(neighbourTops[bin]) || !Number.isFinite(targetTops[bin])) continue
        if (neighbourTops[bin] > targetTops[bin] + tolerance) {
          rises = true
          break
        }
      }
      if (!rises) continue
      feet.push({ face, foot, direction })
    }
  }
  // #1177: the **stock** is a wall too -- uncut bar, or the bar towards the
  // chuck. Frank's report is exactly this case: the same edge the cleanup fixes
  // beside a neighbour feature was left as a ridge where the next material is
  // the plain bar, because only a neighbour ever produced a foot ring.
  //
  // An end qualifies when the target **owns** it (`targetBandOverrun`: the cut
  // range reaches the model's own extent), the bar still stands beyond it inside
  // the blank, nothing else has taken that material away (no neighbour covers the
  // far side -- a turned-down shank beside the target is the "material beyond is
  // already lower" case, which needs no ring), and the bar's radius stands above
  // the target's surface on the band side, read per angle like a neighbour's.
  //
  // The foot is the **face itself**, not one radius past it: an overrun end
  // gives up the centre pull (`rotaryBandEnds`), so the cutter's tip is the
  // point that reaches the wall's foot, and the ring that follows the target's
  // surface there is the band's own end column. When an end is pulled instead
  // (a neighbour wall stands at it) this foot falls outside `span` and the
  // neighbour's own ring is the one that runs -- the same test every neighbour
  // foot takes.
  const overrun = targetBandOverrun(mesh, stock, params)
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  const barRadius = barInscribedRadius(stock)
  const extents = (neighbours ?? [])
    .map((neighbour) => alongExtremes(neighbour.positions, stock))
    .filter((extent) => Number.isFinite(extent.min) && Number.isFinite(extent.max))
  for (const direction of [1, -1] as const) {
    const owns = direction > 0 ? overrun.start : overrun.end
    if (!owns) continue
    const face = direction > 0 ? params.alongStart : params.alongEnd
    const foot = face
    if (!(foot >= span.start - WALL_FOOT_EPSILON && foot <= span.end + WALL_FOOT_EPSILON)) continue
    // The bar has to exist on the far side: an end at the blank's own end has
    // nothing standing beyond it.
    if (direction > 0 ? !(face - lower > WALL_FOOT_EPSILON) : !(upper - face > WALL_FOOT_EPSILON)) continue
    const farFrom = direction > 0 ? face - window : face
    const farTo = direction > 0 ? face : face + window
    if (extents.some((extent) => extent.min < farTo - WALL_FOOT_EPSILON
      && extent.max > farFrom + WALL_FOOT_EPSILON)) continue
    const bandSide = direction > 0 ? [face, face + window] : [face - window, face]
    const targetTops = meshSurfaceTops(mesh, stock, bandSide[0], bandSide[1])
    let rises = false
    for (let bin = 0; bin < WALL_ANGLE_BINS; bin++) {
      const top = targetTops[bin]
      if (!Number.isFinite(top)) continue
      if (barRadius > top + tolerance) {
        rises = true
        break
      }
    }
    if (rises) feet.push({ face, foot, direction })
  }
  return feet.sort((a, b) => a.foot - b.foot)
}

/**
 * `base` extended with the wall feet, sorted, plus the index each foot landed on
 * (#1155 rn-d). A foot that coincides with a grid position keeps its column and
 * only marks it; the grid position before a foot is otherwise untouched, so an
 * operation with neighbours but no wall foot is byte for byte what it was.
 */
export function mergeWallFootPositions(
  base: readonly number[],
  feet: readonly RotaryWallFoot[],
): { along: number[]; footReads: Array<{ index: number; foot: RotaryWallFoot }> } {
  const along: number[] = []
  const footReads: Array<{ index: number; foot: RotaryWallFoot }> = []
  const push = (x: number): number => {
    if (along.length === 0 || x - along[along.length - 1] > WALL_FOOT_EPSILON) along.push(x)
    return along.length - 1
  }
  let b = 0
  let f = 0
  while (b < base.length || f < feet.length) {
    const baseX = b < base.length ? base[b] : Number.POSITIVE_INFINITY
    const footX = f < feet.length ? feet[f].foot : Number.POSITIVE_INFINITY
    if (baseX <= footX + WALL_FOOT_EPSILON) {
      const index = push(baseX)
      b++
      while (f < feet.length && Math.abs(feet[f].foot - baseX) <= WALL_FOOT_EPSILON) {
        footReads.push({ index, foot: feet[f] })
        f++
      }
      continue
    }
    const index = push(footX)
    while (f < feet.length && Math.abs(feet[f].foot - footX) <= WALL_FOOT_EPSILON) {
      footReads.push({ index, foot: feet[f] })
      f++
    }
  }
  return { along, footReads }
}

/**
 * One wall-foot ring's own read (#1155 rn-d): the prep that samples the target's
 * surface at the ring, the column it belongs to in the operation's grid, and its
 * position within that prep's (foot-only) along list.
 */
export interface RotaryWallFootRead {
  /** The column in the operation's `along` grid this ring sits at. */
  readonly index: number
  /** The prep the ring's own row is read from, shared by the feet it covers. */
  readonly prep: RotarySamplingPrep
  /** This ring's position within `prep.along`. */
  readonly position: number
}

/**
 * The preps that read the wall-foot rings on the target's own surface (#1155
 * rn-d), one per distinct set of neighbours the cutter can reach at its feet.
 *
 * Almost always there is one: every foot is tangent to the neighbour that owns
 * it, so that neighbour drops out of the mesh and the ring reads the target
 * exactly as a no-neighbour run would. A neighbour that **does** reach the
 * cutter at some other foot stays in, so no ring is read below material the
 * body would enter. The prep is the operation's own -- same enlarged tool, same
 * cell size, same grid envelope, same retained stubs -- built over the foot
 * positions only, so it costs one angle row per angle and never a second pass
 * over the band.
 *
 * The read itself is `exactTipRows` (#1155 rn-d correction 3): the exact maximum
 * of the projected surface over the cutter's lateral footprint, not the
 * conservative cell bounds. The conservative read needs a margin to be an upper
 * bound, and that margin cut the foot 0.00915 in above a smooth target's surface
 * while taking it back off cut 0.0078 in into a polygon target's corner; the
 * exact maximum is what the ring is for.
 */
export function wallFootPreps(
  footReads: readonly { readonly index: number; readonly foot: RotaryWallFoot }[],
  mesh: RotaryModelMesh,
  neighbours: readonly RotaryModelMesh[] | undefined,
  stock: BarStock,
  samplingTool: NormalizedTool,
  params: RotaryFinishParams,
  along: readonly number[],
  gridExtra: RotaryModelMesh | undefined,
): RotaryWallFootRead[] {
  if (footReads.length === 0) return []
  // The cutter's own axial reach at the ring: the sampling tool carries the
  // stock to leave as radius, and the leave is what keeps the body off the face.
  const reach = samplingTool.radius
  // #1177: a **stock** wall's foot has no neighbour to drop from the mesh, so
  // the list is empty and every neighbour the body reaches stays in.
  const kept = neighbours ?? []
  const extents = kept.map((neighbour) => alongExtremes(neighbour.positions, stock))
  const groups = new Map<string, {
    readonly kept: RotaryModelMesh[]
    readonly members: Array<{ readonly index: number; readonly foot: RotaryWallFoot }>
  }>()
  for (const member of footReads) {
    const groupKept: RotaryModelMesh[] = []
    const key: number[] = []
    kept.forEach((neighbour, i) => {
      const extent = extents[i]
      if (!Number.isFinite(extent.min) || !Number.isFinite(extent.max)) return
      if (extent.min < member.foot.foot + reach - WALL_FOOT_EPSILON
        && extent.max > member.foot.foot - reach + WALL_FOOT_EPSILON) {
        groupKept.push(neighbour)
        key.push(i)
      }
    })
    const id = key.join(',')
    const group = groups.get(id) ?? { kept: groupKept, members: [] }
    group.members.push(member)
    groups.set(id, group)
  }
  const reads: RotaryWallFootRead[] = []
  for (const group of groups.values()) {
    const footMesh = rotarySampledMesh(mesh, group.kept, stock, samplingTool.units, params)
    const prep = createRotarySamplingPrep(footMesh, stock, samplingTool, {
      along: group.members.map((member) => along[member.index]),
      requestedCellSize: params.requestedCellSize,
      exactTipRows: true,
      ...(rotaryConservativeSampling(params) ? { conservativeCellBounds: true } : {}),
      ...((gridExtra !== undefined) ? { gridExtra } : {}),
      ...(footMesh.retainedTriangleStart !== undefined
        ? { wallTriangleStart: footMesh.retainedTriangleStart }
        : {}),
    })
    group.members.forEach((member, position) => {
      reads.push({ index: member.index, prep, position })
    })
  }
  return reads
}

/**
 * The columns of an around operation that a neighbour can reach, and the prep
 * that reads them (#1173).
 */
export interface RotaryNeighbourColumns {
  /** Ascending column indices in the operation's `along` grid. */
  readonly indices: readonly number[]
  /** Exact footprint reads on the mesh with the neighbours, over those columns only. */
  readonly prep: RotarySamplingPrep
}

/**
 * The columns of `along` whose cutter a neighbour can reach (#1173): its along
 * extent comes within `reach` of the column. `reach` is the sampling tool's
 * radius plus one cell, the farthest the conservative read looks, so every
 * column outside it reads no neighbour material at all and is sampled exactly
 * on the target and stubs alone. Wall-foot columns keep their own read and are
 * left out.
 */
export function rotaryNeighbourColumns(
  along: readonly number[],
  neighbours: readonly RotaryModelMesh[],
  stock: BarStock,
  reach: number,
  wallFeet: ReadonlySet<number>,
): number[] {
  const extents = neighbours
    .map((neighbour) => alongExtremes(neighbour.positions, stock))
    .filter((extent) => Number.isFinite(extent.min) && Number.isFinite(extent.max))
  const columns: number[] = []
  along.forEach((position, index) => {
    if (wallFeet.has(index)) return
    if (extents.some((extent) => extent.min < position + reach && extent.max > position - reach)) {
      columns.push(index)
    }
  })
  return columns
}

/**
 * Lift both ends of every chord of `tips` (on `angles`) that a refined sample
 * stands above, by the most any refined sample inside it does (#1190). `tips`
 * is changed in place; a chord with a missing end, or a refined sample off the
 * model, is left as it is. A shared end takes the larger of its two chords'
 * lifts, and a lift only ever raises a tip, so no chord is lowered.
 */
export function liftDippingChords(
  angles: readonly number[],
  tips: number[],
  refinedAngles: readonly number[],
  refinedRows: readonly Float32Array[],
  column: number,
): void {
  const lift = new Array<number>(tips.length).fill(0)
  let r = 0
  for (let k = 0; k + 1 < angles.length; k++) {
    const a0 = angles[k]
    const a1 = angles[k + 1]
    const t0 = tips[k]
    const t1 = tips[k + 1]
    while (r < refinedAngles.length && refinedAngles[r] <= a0 + 1e-9) r++
    let excess = 0
    for (; r < refinedAngles.length && refinedAngles[r] < a1 - 1e-9; r++) {
      const sample = refinedRows[r][column]
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || !Number.isFinite(sample)) continue
      const chord = t0 + (t1 - t0) * (refinedAngles[r] - a0) / (a1 - a0)
      excess = Math.max(excess, sample - chord)
    }
    lift[k] = Math.max(lift[k], excess)
    lift[k + 1] = Math.max(lift[k + 1], excess)
  }
  for (let k = 0; k < tips.length; k++) if (lift[k] > 0) tips[k] += lift[k]
}
