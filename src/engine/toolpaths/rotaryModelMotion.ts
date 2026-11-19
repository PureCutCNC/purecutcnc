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

import { barPivotZ, isSquareStock } from '../../types/barStock'
import { type BarStock, getStockBounds } from '../../types/project'
import type { RotaryFinishParams } from './rotaryModelParams'
import { squareRotaryStubContactFloor } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'

export function boundsOf(moves: readonly ToolpathMove[]): ToolpathResult['bounds'] {
  if (moves.length === 0) return null
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      if (point.x < bounds.minX) bounds.minX = point.x
      if (point.x > bounds.maxX) bounds.maxX = point.x
      if (point.y < bounds.minY) bounds.minY = point.y
      if (point.y > bounds.maxY) bounds.maxY = point.y
      if (point.z < bounds.minZ) bounds.minZ = point.z
      if (point.z > bounds.maxZ) bounds.maxZ = point.z
    }
  }
  return bounds
}

/**
 * One run of a pass: its cut points in traversal order, and whether the run
 * touches the pass's first / last sample. Both generators cut a pass in runs --
 * the rough where material is still standing at a layer, the finish where the
 * model leaves the line over the centreline -- and the shared emitter below is
 * the unit that links two runs or retracts between them.
 *
 * A finish ring that a region cuts to one contiguous arc (#1096 slice D) is
 * marked both `atStart` and `atEnd`: the region-clipped piece *is* the ring the
 * operation cuts there, and its boundary angle is exactly where the reversed
 * next ring's piece begins. `followLink` still decides whether those angles
 * really match and the path stays inside the region, so a ring the region or a
 * model gap splits into several runs keeps the old retract.
 */
export interface RotaryRun {
  readonly points: readonly ToolpathPoint[]
  readonly atStart: boolean
  readonly atEnd: boolean
}

/**
 * One commanded leg of a ring-to-ring link (#1093). The finish's surface-
 * following legs are feeds; the rough's in-air traverse is a rapid, because it
 * is above every material its own earlier layers can leave on the span by the
 * clearance -- the same reason the old travel-height traverse was a rapid.
 */
export interface RotaryLinkStep {
  readonly to: ToolpathPoint
  readonly kind: 'cut' | 'rapid'
}

/** The along-bar coordinate of a point on either bar axis. */
export function alongCoordinate(stock: BarStock, point: { x: number; y: number }): number {
  return stock.axis === 'x' ? point.x : point.y
}

/**
 * Emit one pass's runs, and say where the pass left the tool. A run that starts
 * where the previous pass finished links to it -- a rise to `travelZ`, a turn,
 * and a drop, each its own `cut` move so a merged move can never lose one of the
 * two angles. `travelZ` is the bar's surface plus a clearance (`2R + clearance`,
 * a tip height): nothing -- model or standing stock -- is ever above the bar's
 * surface, so the turn is always in air, and it is far shorter than a retract to
 * `safeZ`. The link used to turn at the higher of the two end tips, which is
 * *inside* the model between the two pass angles: on a square prism of half-width
 * 10 in a 40 mm bar the 34.29 -> 51.43 degree link ran at tip radius 13.598 while
 * the corner at 45 degrees needed 14.141.
 *
 * #1093 added a **forced link** for around mode: when a run ends at its ring's
 * end and the next starts at the next ring's start, the two share one physical
 * angle (rings alternate direction, so A0 and A360 are the same rotation), and
 * `link` supplies the feed path between them -- the finish follows the model at
 * that angle, the rough rises only to what its own earlier layers left. It is
 * emitted before the travel-height rules below, so a link that can stay down
 * never becomes a retract, rapid and plunge; `link` returns null for a split
 * ring, a gap in the reachable surface, an angle change or an over-budget row,
 * and that run falls through to the old motion unchanged.
 *
 * Every other run stays at `travelZ` too: the retract off the run just cut, the
 * traverse to the next run's first point and the plunge's start are all at the
 * bar's surface plus the clearance, never at `safeZ`. Material may still stand
 * above the layer between runs, but nothing stands above the bar, so the
 * traverse is in air; hopping over the bar beats the full retract to
 * `safeRadius` this used to do on every gap (on a 10-layer rough that was
 * hundreds of full retracts). `safeZ` is left for the operation's first
 * positioning move and its final retract.
 *
 * Inside a run two neighbouring samples are joined by one straight move. That
 * move is safe only while the surface between them rises gently: the tool at an
 * intermediate point is at an interpolated height, and its footprint reaches
 * terrain that neither sample's own height accounted for. So a step steeper than
 * 45 degrees (the tips differ by more than the samples are apart) is not one
 * diagonal move. Rising, the tool goes straight up at the first sample to the
 * higher tip and then runs along at that height; falling, it runs along at the
 * first sample's height and then drops at the second. The horizontal leg is safe
 * at the higher of the two heights because the cutter over the span stays inside
 * the union of the two samples' footprints, and each of those is safe at that
 * height or below (exact for a flat end mill; for a ball nose what is left is the
 * ordinary between-sample error, about `s^2 / (8r)` for sample spacing `s` and
 * ball radius `r`). Gentler steps keep the single diagonal move.
 *
 * "The samples are apart" is their distance **along the surface**, which is not
 * always their X/Y distance: in an around pass two neighbouring samples share
 * one along position and differ only in A, so their X/Y spacing is zero and
 * every rise would look steep. Passing `pivot` (the bar's turning centreline in
 * Z) adds the arc the tool tip sweeps, `rMin * |dA| * pi / 180` at the smaller
 * of the two tip radii, to that distance (#1045 slice A). The along pass never
 * passes `pivot`: its `dA` inside a run is zero, and leaving the two-argument
 * `Math.hypot` in place keeps its spacing, and so its output, byte-identical.
 */
/**
 * Emit one ring-to-ring link (#1093).
 *
 * `steps` excludes `from` and ends at the next ring's first point. A feed leg
 * is split by the same steep-step rule the rings use: a rise larger than the
 * pair's surface distance is a vertical leg plus a leg at the higher tip, so a
 * sharp shoulder cannot be undercut between two safe samples. A pair that
 * shares its along position and angle is the link's own vertical leg (the
 * rough's constant-height plan) and is emitted directly -- the ring loop's
 * split would make it a move plus a zero-length move. A rapid leg is emitted
 * as given: it is the rough's in-air traverse at one height, and the
 * steep-step rule does not apply to a move that already clears the material.
 */
function emitLinkPoints(
  moves: ToolpathMove[],
  from: ToolpathPoint,
  steps: readonly RotaryLinkStep[],
  forceStep?: (from: ToolpathPoint, to: ToolpathPoint) => boolean,
): void {
  let previous = from
  for (const step of steps) {
    const to = step.to
    if (to.x === previous.x && to.y === previous.y && to.z === previous.z && to.a === previous.a) {
      previous = to
      continue
    }
    if (step.kind === 'rapid') {
      moves.push({ kind: 'rapid', from: previous, to })
      previous = to
      continue
    }
    const spacing = Math.hypot(to.x - previous.x, to.y - previous.y)
    const rise = to.z - previous.z
    if (spacing <= 1e-12) {
      moves.push({ kind: 'cut', from: previous, to })
    } else {
      const stepped = Math.abs(rise) > spacing
        || (Math.abs(rise) > 1e-9 && forceStep?.(previous, to) === true)
      if (stepped) {
        if (rise > 0) {
          moves.push({ kind: 'cut', from: previous, to: { ...previous, z: to.z } })
          moves.push({ kind: 'cut', from: { ...previous, z: to.z }, to })
        } else {
          moves.push({ kind: 'cut', from: previous, to: { ...to, z: previous.z } })
          moves.push({ kind: 'cut', from: { ...to, z: previous.z }, to })
        }
      } else {
        moves.push({ kind: 'cut', from: previous, to })
      }
    }
    previous = to
  }
}

export function emitRotaryRuns(
  moves: ToolpathMove[],
  here: ToolpathPoint | undefined,
  runs: readonly RotaryRun[],
  safeZ: number,
  travelZ: number,
  previousEndedAtEnd: boolean,
  forceStep?: (from: ToolpathPoint, to: ToolpathPoint) => boolean,
  pivot?: number,
  link?: (from: ToolpathPoint, to: ToolpathPoint) => readonly RotaryLinkStep[] | null,
  /**
   * Attempt the link from whatever point the previous ring left, not only from
   * a run that reached its ring's end (#1093). A square rough's rings cut only
   * short arcs around the corners, so their runs start and end at the touch
   * gate's boundaries rather than at A0/A360; two neighbouring rings still
   * share those boundary angles. The caller enables this only for a ring after
   * the first in its layer, so a layer boundary keeps the travel-height
   * retract. The finish leaves it off: a split ring retracts, as the issue
   * requires. The finish instead marks a region-clipped single run as its own
   * pass start and end (#1096 slice D), so the exact-angle check in `link` still
   * decides whether it links.
   */
  linkPartial?: boolean,
): { here: ToolpathPoint | undefined; endedAtEnd: boolean } {
  let current = here
  let endedAtEnd = false
  for (const run of runs) {
    const first = run.points[0]
    // #1093: a ring-to-ring link that can stay down is a feed, not a
    // retract/rapid/plunge. `link` is supplied only for around mode; it returns
    // the points to feed through (excluding `current`, ending at `first`), or
    // null when the link cannot stay down -- a gap in the reachable surface, an
    // angle change or the work budget -- in which case the old behaviour below
    // applies unchanged. A split ring never reaches this call: the finish
    // reports it as not ended at the ring's end.
    const linkPoints = current !== undefined && (linkPartial === true || (previousEndedAtEnd && run.atStart))
      ? link?.(current, first) ?? null
      : null
    // The travel-height link is the same-along turn: a square rough's corner
    // arcs are separated by an A move at one along position. `linkPartial`
    // (the rough) may use it from any run, not only from a ring end; on a
    // square blank it turns at the corner envelope, which is the existing
    // rule. The finish keeps the old gate, so a split ring still retracts.
    const canLink = current !== undefined && current.x === first.x && current.y === first.y
      && (previousEndedAtEnd && run.atStart
        || (linkPartial === true && current.a !== first.a))
    if (linkPoints && current) {
      emitLinkPoints(moves, current, linkPoints, forceStep)
      current = linkPoints[linkPoints.length - 1].to
    } else if (canLink && current) {
      const high = travelZ
      if (high > current.z) moves.push({ kind: 'cut', from: current, to: { ...current, z: high } })
      moves.push({ kind: 'cut', from: { ...current, z: high }, to: { ...first, z: high } })
      if (high > first.z) moves.push({ kind: 'cut', from: { ...first, z: high }, to: first })
    } else if (current) {
      moves.push({ kind: 'rapid', from: current, to: { ...current, z: travelZ } })
      moves.push({ kind: 'rapid', from: { ...current, z: travelZ }, to: { ...first, z: travelZ } })
      moves.push({ kind: 'plunge', from: { ...first, z: travelZ }, to: first })
    } else {
      // The operation's first positioning move: from and to the same point at
      // `safeZ`, the way `pushRapidAndPlunge` opens -- the tool is placed at
      // safe height rather than ever read as starting buried at the cutting tip
      // -- and only then plunges to the first cut. Every later gap is at
      // `travelZ` above.
      moves.push({ kind: 'rapid', from: { ...first, z: safeZ }, to: { ...first, z: safeZ } })
      moves.push({ kind: 'plunge', from: { ...first, z: safeZ }, to: first })
    }
    for (let i = 1; i < run.points.length; i++) {
      const from = run.points[i - 1]
      const to = run.points[i]
      // The distance along the surface between the two samples. Along the bar
      // that is their X/Y spacing (`pivot` is absent, exactly as before); in an
      // around pass they share an along position and differ only in A, so the
      // distance is the arc at the smaller tip radius from the pivot.
      const spacing = pivot === undefined
        ? Math.hypot(to.x - from.x, to.y - from.y)
        : Math.hypot(
            to.x - from.x,
            to.y - from.y,
            Math.max(0, Math.min(from.z, to.z) - pivot) * Math.abs((to.a ?? 0) - (from.a ?? 0)) * Math.PI / 180,
          )
      const rise = to.z - from.z
      // A square blank's retained-stub zone forces the step regardless of the
      // 45-degree rule: the exact contact chord can sag below the floor over a
      // shallower-looking drop. A horizontal move is already safe and is left
      // alone, so a forced segment only splits when it actually changes height.
      const stepped = Math.abs(rise) > spacing
        || (Math.abs(rise) > 1e-9 && forceStep?.(from, to) === true)
      if (stepped) {
        if (rise > 0) {
          // Rising: straight up at the first (lower) sample, then along at the
          // higher tip.
          moves.push({ kind: 'cut', from, to: { ...from, z: to.z } })
          moves.push({ kind: 'cut', from: { ...from, z: to.z }, to })
        } else {
          // Falling: along at the first (higher) sample's height, then straight
          // down at the second sample.
          moves.push({ kind: 'cut', from, to: { ...to, z: from.z } })
          moves.push({ kind: 'cut', from: { ...to, z: from.z }, to })
        }
      } else {
        moves.push({ kind: 'cut', from, to })
      }
    }
    current = run.points[run.points.length - 1]
    endedAtEnd = run.atEnd
  }
  return { here: current, endedAtEnd }
}

/**
 * Split one around-mode ring into the runs of contiguous samples that cut.
 * `samples` is already in the order the ring is traversed (forward or reversed),
 * so `atStart`/`atEnd` speak about that traversal: the emitter links two runs
 * only where one ends at a ring end and the next begins there. A `null` sample
 * is not cut -- the finish's "no model under the tool", or the rough's "no
 * material standing at this layer" (#1045 slice A).
 */
export function ringRuns(samples: readonly (ToolpathPoint | null)[]): RotaryRun[] {
  const runs: RotaryRun[] = []
  let i = 0
  while (i < samples.length) {
    if (samples[i] === null) {
      i++
      continue
    }
    const start = i
    while (i + 1 < samples.length && samples[i + 1] !== null) i++
    const points: ToolpathPoint[] = []
    for (let j = start; j <= i; j++) {
      const sample = samples[j]
      if (sample) points.push(sample)
    }
    runs.push({ points, atStart: start === 0, atEnd: i === samples.length - 1 })
    i++
  }
  return runs
}

/**
 * The between-sample safety net for a square blank's exact retained-stub floor
 * (#1016 C2-F6): a predicate that forces the emitter's stepped move on a
 * segment whose straight chord would sag below the stub contact.
 *
 * `rotaryTargets` floors each sample at its own exact stub contact, but two
 * neighbouring samples are joined by a straight move. The contact height falls
 * away steeply just outside a square corner, so the chord between the exact
 * values can dip below the floor in between -- on Codex's 25 mm case a 0.7 mm
 * drop over the 0.733 mm sample spacing sagged 0.12 mm into the stub. The
 * emitter's existing stepped move (run along at the higher tip, then drop
 * straight down) removes that sag, but it only fires when the rise exceeds the
 * spacing, which is a 45-degree test, not the stub's own geometry.
 *
 * The exact test is one comparison per segment. The contact floor is
 * non-increasing with distance from the stub, so the largest material height
 * anywhere on a segment is at the endpoint **nearer** the stub. Call that
 * floor `F` and the farther endpoint's tip `far`. The chord's lowest point is
 * `min(tipNear, far)`, and the near endpoint was floored, so `tipNear >= F`:
 * the chord clears the whole interval exactly when `far >= F`. When `far < F`
 * the near endpoint is also the higher tip and the stepped move's horizontal
 * leg runs at `tipNear >= F` over the whole segment, while its vertical leg
 * ends on the (also floored) far sample -- so the step is safe and no other
 * segment needs one. A horizontal segment is already safe and is not split.
 *
 * `undefined` on a round bar and when an end has no retained stub, so their
 * motion is untouched. A stub's floor is `-Infinity` beyond its cutter radius,
 * so the predicate is false everywhere the stub cannot reach.
 */
export function retainedStubStepForced(
  stock: BarStock,
  params: RotaryFinishParams,
  tool: NormalizedTool,
): ((from: ToolpathPoint, to: ToolpathPoint) => boolean) | undefined {
  if (!isSquareStock(stock)) return undefined
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  const lowerStub = params.alongStart > lower
  const upperStub = upper > params.alongEnd
  if (!lowerStub && !upperStub) return undefined
  const pivot = barPivotZ(stock)
  const alongOf = (point: ToolpathPoint): number => stock.axis === 'x' ? point.x : point.y
  const tipOf = (point: ToolpathPoint): number => point.z - pivot
  // The floor at `along` for the stub whose end face is at `face`.
  const floorAt = (angle: number, face: number, along: number): number =>
    squareRotaryStubContactFloor(stock, angle, tool.radius, tool.type, Math.abs(along - face))
  return (fromPoint, toPoint) => {
    const fromAlong = alongOf(fromPoint)
    const toAlong = alongOf(toPoint)
    if (fromAlong === toAlong) return false
    const angle = fromPoint.a ?? toPoint.a ?? 0
    const fromTip = tipOf(fromPoint)
    const toTip = tipOf(toPoint)
    if (lowerStub) {
      const nearAlong = Math.min(fromAlong, toAlong)
      const farTip = fromAlong <= toAlong ? toTip : fromTip
      if (farTip < floorAt(angle, params.alongStart, nearAlong)) return true
    }
    if (upperStub) {
      const nearAlong = Math.max(fromAlong, toAlong)
      const farTip = fromAlong >= toAlong ? toTip : fromTip
      if (farTip < floorAt(angle, params.alongEnd, nearAlong)) return true
    }
    return false
  }
}

/**
 * The square blank's retained-stub contact floor for the continuous helix
 * (#1103 slice ca-j), or `undefined` when there is nothing to lift off.
 *
 * `completeRotaryTargets` floors every ring sample at exactly this closed form
 * (the real cutter's contact height against the retained square stock beyond a
 * cut range's end). The helix samples its own poses -- angles no ring row visits,
 * along positions no ring sits on -- so it asks the same form at each of them
 * instead of reading the ring grid, and a pose can never sit lower than the ring
 * path would allow there. `undefined` on a round bar (`squareRotaryStubContactFloor`
 * answers `-Infinity` for it) and on a square blank with no retained end, so the
 * round path allocates nothing new.
 */
export function continuousHelixStubFloor(
  stock: BarStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
): ((along: number, angleDeg: number) => number) | undefined {
  if (!isSquareStock(stock)) return undefined
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  // No stub exists at an end the cut range already meets; the ring path's own
  // `stubFloor` draws the same line (`completeRotaryTargets`).
  const lowerStub = params.alongStart > lower
  const upperStub = upper > params.alongEnd
  if (!lowerStub && !upperStub) return undefined
  return (along: number, angleDeg: number): number => {
    let floor = Number.NEGATIVE_INFINITY
    if (lowerStub) {
      floor = Math.max(floor, squareRotaryStubContactFloor(
        stock, angleDeg, tool.radius, tool.type, along - params.alongStart))
    }
    if (upperStub) {
      floor = Math.max(floor, squareRotaryStubContactFloor(
        stock, angleDeg, tool.radius, tool.type, params.alongEnd - along))
    }
    return floor
  }
}

/**
 * The continuous helix's stepover for one square blank (#1103 slice ca-j), or
 * the caller's own on a round bar.
 *
 * A square blank's corner shell stands above the cutter tip at every angle that
 * is not its own, so a roughing turn cannot rely on the tip alone: the blank's
 * material between two turns is cleared by the cutter's flank, which reaches one
 * cutter radius either side of its own path. Two roughing turns exactly one
 * **diameter** apart therefore leave every cell on the line halfway between them
 * outside both flanks -- a helical fin of stock at the blank's corner radius.
 * The property suite sees it as a blank-support column 4.79 mm over the
 * finished-surface bound on its 12 mm / Ø1.4 / cone case with the stepover at a
 * full diameter. Overlapping the roughing turns by one tenth of a diameter
 * closes that line; a round bar has no corner shell above the tip, so its pitch
 * stays exactly the requested stepover and its bytes do not move.
 *
 * The **finish** takes the same overlap: a finish-only program has no rough to
 * clear the shell first, so its own turns cover it the same way, and on the
 * busto-rect finish (a band the work budget refuses) the overlap's shorter pitch
 * also makes that refused attempt cheaper -- 22.5 s against 23.7 s at the
 * requested stepover, one process at a time through the pool.
 */
const SQUARE_HELIX_TURN_OVERLAP = 0.9

export function continuousHelixStepover(
  stock: BarStock,
  tool: NormalizedTool,
  stepover: number,
): number {
  if (!isSquareStock(stock)) return stepover
  return Math.min(stepover, tool.radius * 2 * SQUARE_HELIX_TURN_OVERLAP)
}
