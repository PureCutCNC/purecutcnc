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

import { getStockBounds, roundStockCentre } from '../../types/project'
import type { Clamp, RoundStock } from '../../types/project'
import { convertLength } from '../../utils/units'
import { toolSpacePoint } from '../rotaryFrame'
import { chooseHeightMapCellSize, computeXYBounds, getCachedHeightMap, safeToolTipZAt } from './finishSurfaceParallel'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
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

export interface RotaryFinishParams {
  /** Distance between passes, measured round the bar's surface. */
  readonly stepover: number
  /** Distance between samples along a pass. */
  readonly sampleSpacing: number
  /** Material left on the model, measured normal to its surface. */
  readonly stockToLeave: number
  /** The along range the passes cover; the caller (a later slice) derives it from the model and the end supports. */
  readonly alongStart: number
  readonly alongEnd: number
  /** Tool-tip radius from the centreline for rapids and links in air; must be above the bar's surface. */
  readonly safeRadius: number
  /** Requested height-map cell size, passed to the sampler. */
  readonly requestedCellSize: number
}

/** Perpendicular distance of `point` from the line through `a` and `b`. */
function distanceFromLine(
  point: { x: number; y: number; z: number },
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const apx = point.x - a.x
  const apy = point.y - a.y
  const apz = point.z - a.z
  const lengthSq = abx * abx + aby * aby + abz * abz
  if (lengthSq <= 1e-18) return Math.hypot(apx, apy, apz)
  const crossX = apy * abz - apz * aby
  const crossY = apz * abx - apx * abz
  const crossZ = apx * aby - apy * abx
  return Math.hypot(crossX, crossY, crossZ) / Math.sqrt(lengthSq)
}

/**
 * Drop the collinear interior points of every run of `cut` moves that share one
 * pass, keeping the run's first and last point. A run never crosses a move that
 * turns the stock -- the same rule `linearMoveOptimization` follows (issue
 * #393): the merged move would keep only one endpoint's angle, and every angle
 * this toolpath emits is a command the machine must reach. Runs also stop where
 * the tool reverses along the bar, so a merge can never join two passes that
 * happen to line up in X through the link between them.
 */
function mergeCollinearCuts(moves: readonly ToolpathMove[], tolerance: number): { moves: ToolpathMove[]; dropped: number } {
  const merged: ToolpathMove[] = []
  let index = 0
  while (index < moves.length) {
    const first = moves[index]
    if (first.kind !== 'cut' || first.from.a !== first.to.a) {
      merged.push(first)
      index++
      continue
    }
    const direction = Math.sign((first.to.x - first.from.x) + (first.to.y - first.from.y))
    let end = index
    while (
      end + 1 < moves.length
      && moves[end + 1].kind === 'cut'
      && moves[end + 1].from.a === moves[end + 1].to.a
      && moves[end + 1].from.a === first.from.a
      && moves[end + 1].from.x === moves[end].to.x
      && moves[end + 1].from.y === moves[end].to.y
      && Math.sign((moves[end + 1].to.x - moves[end + 1].from.x) + (moves[end + 1].to.y - moves[end + 1].from.y)) === direction
    ) end++
    const points: ToolpathPoint[] = [moves[index].from]
    for (let i = index; i <= end; i++) points.push(moves[i].to)
    const kept: ToolpathPoint[] = [points[0]]
    for (let i = 1; i < points.length - 1; i++) {
      if (distanceFromLine(points[i], kept[kept.length - 1], points[i + 1]) > tolerance) kept.push(points[i])
    }
    kept.push(points[points.length - 1])
    for (let i = 0; i + 1 < kept.length; i++) {
      merged.push({ kind: 'cut', from: kept[i], to: kept[i + 1] })
    }
    index = end + 1
  }
  return { moves: merged, dropped: moves.length - merged.length }
}

function boundsOf(moves: readonly ToolpathMove[]): ToolpathResult['bounds'] {
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

/** Sampling and normal stock offset shared by finishing and every rough layer. */
function rotaryTargets(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: RoundStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
  warnings: ToolpathWarning[],
): { angles: number[]; along: number[]; tips: number[][]; stopped: boolean } {
  const radius = stock.thickness / 2
  const stockToLeave = params.stockToLeave
  // A ball's centre is where the tool's radius meets the model, so enlarging the
  // radius by the stock is the only way to move the whole contact outward
  // normal to the surface; adding the radius back at the tip is what turns the
  // enlarged centre into the real ball's tip.
  const samplingTool: NormalizedTool = stockToLeave === 0 ? tool : {
    ...tool,
    radius: tool.radius + stockToLeave,
    diameter: tool.diameter + 2 * stockToLeave,
  }
  const passes = Math.max(1, Math.ceil((2 * Math.PI * radius) / Math.max(params.stepover, 1e-9)))
  const angleStep = 360 / passes
  const angles = Array.from({ length: passes }, (_, k) => k * angleStep)
  const span = Math.abs(params.alongEnd - params.alongStart)
  const intervals = span <= 0 ? 1 : Math.max(1, Math.ceil(span / Math.max(params.sampleSpacing, 1e-9)))
  const along = Array.from({ length: intervals + 1 }, (_, i) => params.alongStart + (params.alongEnd - params.alongStart) * i / intervals)
  const sampling = sampleRotaryModel(mesh, stock, samplingTool, {
    anglesDeg: angles,
    along,
    requestedCellSize: params.requestedCellSize,
    ...hooks,
  }, warnings)
  if (sampling.stopped) return { angles, along, tips: [], stopped: true }
  // The first sample below the centreline is the only place the warning names
  // (one warning per operation, however many places need it). The value that
  // decides it carries the stock offset, so leaving stock does not hide a model
  // that needs a cut below the centreline. `tipRadius[k][i]` is the height at
  // along[i], whichever direction the pass runs.
  outer: for (let k = 0; k < passes; k++) {
    for (let i = 0; i < along.length; i++) {
      if (sampling.tipRadius[k][i] + stockToLeave < 0) {
        warnings.push({
          code: 'rotaryBelowCentreline',
          params: {
            operation: operationId,
            along: Math.round(along[i] * 100) / 100,
            angle: Math.round(angles[k] * 100) / 100,
          },
        })
        break outer
      }
    }
  }
  const tips = sampling.tipRadius.map((row) => Array.from(row, (raw) =>
    Number.isFinite(raw) ? Math.min(Math.max(raw + stockToLeave, 0), radius) : 0))
  return { angles, along, tips, stopped: false }
}

/**
 * Rotary finishing (issue #1015 slice B): passes run along the bar and step
 * round it, so a ball nose leaves its best surface along a long part.
 *
 * The height sampler is the only thing that knows the model. Its cells hold the
 * raw model height, so stock to leave is applied by sampling with the tool's
 * radius enlarged by `s` and then adding `s` back at the tip. For a ball nose
 * that composition is the offset the surface actually gets: the centre of the
 * enlarged ball is the real ball's centre moved outward along the surface normal
 * by exactly `s`, so the enlarged ball's tip plus `s` is the real ball's tip
 * offset by `s` normal to the surface. On a convex contact -- where the ball
 * touches at a single high point -- that normal is vertical, so the result is
 * also a plain vertical `s`; in a valley it is not, and the enlarged ball sits
 * higher on the walls than the plain ball plus a vertical `s` would. A flat end
 * mill has no ball centre to move, so this is the enlargement's approximation
 * for it. A call with zero stock is bit-identical to the sampler's own value,
 * which is the contract every caller of the sampler relies on.
 */
export function generateRotaryFinish(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: RoundStock,
  tool: NormalizedTool,
  params: RotaryFinishParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
): ToolpathResult {
  const warnings: ToolpathWarning[] = []
  if (tool.type !== 'ball_endmill' && tool.type !== 'flat_endmill') {
    return {
      operationId,
      moves: [],
      warnings: [{ code: 'rotaryToolUnsupported', params: { operation: operationId } }],
      bounds: null,
    }
  }
  const radius = stock.thickness / 2
  const centre = roundStockCentre(stock)
  if (params.alongEnd <= params.alongStart) {
    return { operationId, moves: [], warnings: [{ code: 'rotaryNoRoom', params: { operation: operationId } }], bounds: null }
  }
  const sampling = rotaryTargets(operationId, mesh, stock, tool, params, hooks, warnings)
  if (sampling.stopped) return { operationId, moves: [], warnings: [], bounds: null }
  const { angles, along } = sampling
  const passes = angles.length
  const tolerance = convertLength(0.001, 'mm', tool.units)
  // Sample `i` of a pass sits at `along[rowIndexAt(k, i)]`: even passes run from
  // alongStart to alongEnd, odd ones back, so the row index of position `i` is
  // mirrored on a return pass. Everything that reads a height must use the same
  // index the position uses -- reading `tipRadius[k][i]` on a return pass gives
  // each position the height of its mirror, which only a model symmetric along
  // the bar hides.
  const rowIndexAt = (pass: number, positionIndex: number): number =>
    pass % 2 === 0 ? positionIndex : along.length - 1 - positionIndex
  const tipAt = (pass: number, positionIndex: number): number => sampling.tips[pass][rowIndexAt(pass, positionIndex)]
  const point = (alongPosition: number, tip: number, angle: number): ToolpathPoint => stock.axis === 'x'
    ? { x: alongPosition, y: centre, z: radius + tip, a: angle }
    : { x: centre, y: alongPosition, z: radius + tip, a: angle }
  const alongAt = (pass: number, positionIndex: number): number => along[rowIndexAt(pass, positionIndex)]
  const moves: ToolpathMove[] = []
  const firstTip = tipAt(0, 0)
  const firstAlong = alongAt(0, 0)
  // Rule 7: position the tool over the first sample at safeRadius, then plunge
  // to the first tip. The opening positioning move goes from and to the same
  // point -- the way `pushRapidAndPlunge` opens when there is no previous
  // position, so the tool is placed at safe height rather than ever read as
  // starting buried at the cutting tip. The retract at the end is its mirror.
  moves.push({
    kind: 'rapid',
    from: point(firstAlong, params.safeRadius, angles[0]),
    to: point(firstAlong, params.safeRadius, angles[0]),
  })
  moves.push({
    kind: 'plunge',
    from: point(firstAlong, params.safeRadius, angles[0]),
    to: point(firstAlong, firstTip, angles[0]),
  })
  for (let k = 0; k < passes; k++) {
    // Where this pass starts: right after the previous link, or the entry.
    let here = k === 0 ? firstTip : tipAt(k, 0)
    if (k > 0) {
      // The link is emitted before the pass so both passes keep their own
      // angle: a merged move that turned would lose one of them. Its height is
      // the higher of the two tips at this end, reached by a rise, a turn, and
      // a drop -- whichever of the three is non-zero.
      const previousAngle = angles[k - 1]
      const angle = angles[k]
      const previousTip = tipAt(k - 1, along.length - 1)
      const currentTip = tipAt(k, 0)
      const endAlong = alongAt(k - 1, along.length - 1)
      const high = Math.max(previousTip, currentTip)
      if (high > previousTip) moves.push({ kind: 'cut', from: point(endAlong, previousTip, previousAngle), to: point(endAlong, high, previousAngle) })
      moves.push({ kind: 'cut', from: point(endAlong, high, previousAngle), to: point(endAlong, high, angle) })
      if (high > currentTip) moves.push({ kind: 'cut', from: point(endAlong, high, angle), to: point(endAlong, currentTip, angle) })
      here = currentTip
    }
    for (let i = 0; i + 1 < along.length; i++) {
      const next = tipAt(k, i + 1)
      moves.push({ kind: 'cut', from: point(alongAt(k, i), here, angles[k]), to: point(alongAt(k, i + 1), next, angles[k]) })
      here = next
    }
  }
  const lastAngle = angles[passes - 1]
  const lastAlong = alongAt(passes - 1, along.length - 1)
  const lastTip = tipAt(passes - 1, along.length - 1)
  moves.push({
    kind: 'rapid',
    from: point(lastAlong, lastTip, lastAngle),
    to: point(lastAlong, params.safeRadius, lastAngle),
  })
  const merged = mergeCollinearCuts(moves, tolerance)
  return { operationId, moves: merged.moves, warnings, bounds: boundsOf(merged.moves) }
}

export interface RotarySupports {
  /** Bar length kept uncut at the chuck end, measured from that end of the bar. */
  readonly chuckEnd: number
  /** Bar length kept uncut at the tail end. */
  readonly tailEnd: number
}

export function rotaryAlongRange(
  stock: RoundStock,
  clamps: readonly Clamp[],
  modelAlong: { readonly min: number; readonly max: number },
  tool: NormalizedTool,
  supports: RotarySupports,
): { start: number; end: number } | null {
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  const clampEnds = (clamp: Clamp): { min: number; max: number } => {
    const min = stock.axis === 'x' ? clamp.x : clamp.y
    return { min, max: min + (stock.axis === 'x' ? clamp.w : clamp.h) }
  }
  const chuck = clamps.find((clamp) => clamp.type === 'chuck')
  const chuckBounds = chuck && clampEnds(chuck)
  const chuckLower = !chuckBounds || (chuckBounds.min + chuckBounds.max) / 2 <= (lower + upper) / 2
  let start = lower + (chuckLower ? supports.chuckEnd : supports.tailEnd)
  let end = upper - (chuckLower ? supports.tailEnd : supports.chuckEnd)
  for (const clamp of clamps) {
    if (clamp.type !== 'chuck' && clamp.type !== 'tailstock') continue
    const edge = clampEnds(clamp)
    if ((edge.min + edge.max) / 2 <= (lower + upper) / 2) start = Math.max(start, edge.max + tool.radius)
    else end = Math.min(end, edge.min - tool.radius)
  }
  // Beyond the model there is nothing under the tool: a pass would cut down
  // to the centreline and part the work. Keep that bar at full radius so the
  // model stays attached to its end supports.
  start = Math.max(start, modelAlong.min)
  end = Math.min(end, modelAlong.max)
  return start < end ? { start, end } : null
}

export interface RotaryRoughParams extends RotaryFinishParams {
  /** Radial depth of each layer. */
  readonly stepdown: number
}

/** Sample once, then remove only the material still standing at each layer. */
export function generateRotaryRough(
  operationId: string,
  mesh: RotaryModelMesh,
  stock: RoundStock,
  tool: NormalizedTool,
  params: RotaryRoughParams,
  hooks: Pick<RotarySampleOptions, 'onAngle' | 'shouldStop'>,
): ToolpathResult {
  if (tool.type !== 'ball_endmill' && tool.type !== 'flat_endmill') {
    return { operationId, moves: [], warnings: [{ code: 'rotaryToolUnsupported', params: { operation: operationId } }], bounds: null }
  }
  if (params.alongEnd <= params.alongStart) {
    return { operationId, moves: [], warnings: [{ code: 'rotaryNoRoom', params: { operation: operationId } }], bounds: null }
  }
  if (!Number.isFinite(params.stepdown) || params.stepdown <= 0) {
    return { operationId, moves: [], warnings: [{ code: 'stepdownPositive', params: { operation: operationId } }], bounds: null }
  }
  const warnings: ToolpathWarning[] = []
  const sampling = rotaryTargets(operationId, mesh, stock, tool, params, hooks, warnings)
  if (sampling.stopped) return { operationId, moves: [], warnings: [], bounds: null }
  const { angles, along, tips } = sampling
  const radius = stock.thickness / 2
  const centre = roundStockCentre(stock)
  let lowest = radius
  for (const row of tips) for (const tip of row) lowest = Math.min(lowest, tip)
  const layers = Math.ceil((radius - lowest) / params.stepdown)
  const moves: ToolpathMove[] = []
  let here: ToolpathPoint | undefined
  const point = (position: number, tip: number, angle: number): ToolpathPoint => stock.axis === 'x'
    ? { x: position, y: centre, z: radius + tip, a: angle }
    : { x: centre, y: position, z: radius + tip, a: angle }
  const moveTo = (kind: ToolpathMove['kind'], to: ToolpathPoint): void => {
    moves.push({ kind, from: here ?? to, to })
    here = to
  }
  for (let layer = 1; layer <= layers; layer++) {
    const previousRadius = radius - (layer - 1) * params.stepdown
    const layerRadius = Math.max(lowest, radius - layer * params.stepdown)
    let previousPass = -2
    let previousEndedAtEnd = false
    for (let pass = 0; pass < angles.length; pass++) {
      const angle = angles[pass] + (layer - 1) * 360
      const indexAt = (i: number): number => pass % 2 === 0 ? i : along.length - 1 - i
      const needsCut = (i: number): boolean => tips[pass][indexAt(i)] < previousRadius
      const at = (i: number): ToolpathPoint => {
        const index = indexAt(i)
        return point(along[index], Math.max(tips[pass][index], layerRadius), angle)
      }
      let i = 0
      while (i < along.length) {
        if (!needsCut(i)) { i++; continue }
        const start = i
        while (i + 1 < along.length && needsCut(i + 1)) i++
        const end = i
        const first = at(start)
        const canLink = here && previousPass === pass - 1 && previousEndedAtEnd && start === 0
          && here.x === first.x && here.y === first.y
        if (canLink && here) {
          const high = Math.max(here.z, first.z)
          if (high > here.z) moveTo('cut', { ...here, z: high })
          moveTo('cut', { ...first, z: high })
          if (high > first.z) moveTo('cut', first)
        } else {
          if (here) moveTo('rapid', { ...here, z: radius + params.safeRadius })
          moveTo('rapid', { ...first, z: radius + params.safeRadius })
          moveTo('plunge', first)
        }
        for (let j = start + 1; j <= end; j++) moveTo('cut', at(j))
        previousPass = pass
        previousEndedAtEnd = end === along.length - 1
        i++
      }
    }
  }
  if (here) moveTo('rapid', { ...here, z: radius + params.safeRadius })
  const merged = mergeCollinearCuts(moves, convertLength(0.001, 'mm', tool.units))
  return { operationId, moves: merged.moves, warnings, bounds: boundsOf(merged.moves) }
}
