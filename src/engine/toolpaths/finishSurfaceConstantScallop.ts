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

import type { Operation, Point, Project, SketchFeature } from '../../types/project'
import type { ToolpathWarning } from './warningCodes'
import type { ClipperPath, NormalizedTool, ToolpathMove, ToolpathPoint } from './types'
import { appendAll } from './appendAll'
import { DEFAULT_CLIPPER_SCALE, applyContourDirectionBySide } from './geometry'
import { buildRegionMask } from './regions'
import { resolveRegionDomainCentre } from './regionDomain'
import {
  buildProtectedFootprintPaths,
  clipperPathsToTupleContours,
  differenceClipperPaths,
} from './modelProtection'
import {
  buildSurfaceSlopeDomain,
  createSurfaceDomainLinkCheck,
  intersectSurfaceSlopeDomain,
} from './finishSurfaceSlope'
import {
  chooseHeightMapCellSize,
  computeXYBounds,
  getCachedHeightMap,
  modelSilhouettePathsForFinishSurface,
  safeToolTipZAt,
  type FinishSurfaceParallelCacheHost,
  type HeightMap,
} from './finishSurfaceParallel'
import { retractToSafe, transitionToCutEntry } from './pocket'
import { finishScallopSpacing } from './scallopHeight'
import {
  buildGeodesicDistanceField,
  extractConstantDistanceContours,
  type ConstantDistanceContour,
  type ConstantScallopGrid,
} from './constantScallopField'

interface PlannedContour {
  level: number
  points: Point[]
  closed: boolean
  boundary: boolean
}

interface LiftedContour {
  points: ToolpathPoint[]
  closed: boolean
}

function rowIntersections(paths: ClipperPath[], y: number): number[] {
  const intersections: number[] = []
  const scaledY = y * DEFAULT_CLIPPER_SCALE
  for (const path of paths) {
    for (let index = 0; index < path.length; index += 1) {
      const a = path[index]
      const b = path[(index + 1) % path.length]
      if (a.Y === b.Y) continue
      const crosses = (a.Y <= scaledY && b.Y > scaledY) || (b.Y <= scaledY && a.Y > scaledY)
      if (!crosses) continue
      const t = (scaledY - a.Y) / (b.Y - a.Y)
      intersections.push((a.X + (b.X - a.X) * t) / DEFAULT_CLIPPER_SCALE)
    }
  }
  return intersections.sort((left, right) => left - right)
}

function markDomainRow(mask: Uint8Array, heightMap: HeightMap, row: number, paths: ClipperPath[]): void {
  const y = heightMap.originY + (row + 0.5) * heightMap.cellSize
  const intersections = rowIntersections(paths, y)
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    const first = Math.max(0, Math.ceil((intersections[index] - heightMap.originX) / heightMap.cellSize - 0.5))
    const last = Math.min(
      heightMap.width - 1,
      Math.floor((intersections[index + 1] - heightMap.originX) / heightMap.cellSize - 0.5),
    )
    for (let col = first; col <= last; col += 1) mask[row * heightMap.width + col] = 1
  }
}

function buildCutterLocationGrid(
  heightMap: HeightMap,
  domain: ClipperPath[],
  tool: NormalizedTool,
  axialLeave: number,
): ConstantScallopGrid | null {
  const cellCount = heightMap.width * heightMap.height
  const valid = new Uint8Array(cellCount)
  for (let row = 0; row < heightMap.height; row += 1) markDomainRow(valid, heightMap, row, domain)
  const cutterLocationZ = new Float64Array(cellCount)
  cutterLocationZ.fill(NaN)
  let validCells = 0
  for (let row = 0; row < heightMap.height; row += 1) {
    for (let col = 0; col < heightMap.width; col += 1) {
      const at = row * heightMap.width + col
      if (valid[at] === 0) continue
      const x = heightMap.originX + (col + 0.5) * heightMap.cellSize
      const y = heightMap.originY + (row + 0.5) * heightMap.cellSize
      const z = safeToolTipZAt(x, y, heightMap, tool)
      if (!Number.isFinite(z)) {
        valid[at] = 0
        continue
      }
      cutterLocationZ[at] = z + axialLeave
      validCells += 1
    }
  }
  if (validCells === 0) return null
  return {
    width: heightMap.width,
    height: heightMap.height,
    originX: heightMap.originX,
    originY: heightMap.originY,
    cellSize: heightMap.cellSize,
    cutterLocationZ,
    valid,
  }
}

function clipperBoundaryContours(paths: ClipperPath[]): PlannedContour[] {
  return clipperPathsToTupleContours(paths)
    .filter((points) => points.length >= 3)
    .map((points) => ({
      level: 0,
      points: points.map(([x, y]) => ({ x, y })),
      closed: true,
      boundary: true,
    }))
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index]
    const b = polygon[previous]
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

function containmentRoles(contours: Point[][]): boolean[] {
  return contours.map((contour, index) => {
    const point = contour[0]
    let depth = 0
    for (let other = 0; other < contours.length; other += 1) {
      if (other !== index && pointInPolygon(point, contours[other])) depth += 1
    }
    return depth % 2 === 0
  })
}

function orientContourBatch(contours: PlannedContour[], direction: Operation['cutDirection']): PlannedContour[] {
  const points = contours.map((contour) => contour.points)
  const closed = contours.map((contour) => contour.closed)
  const roles = containmentRoles(points)
  const oriented = applyContourDirectionBySide(points, direction, 'tool-inside', closed, undefined, roles)
  return contours.map((contour, index) => ({ ...contour, points: oriented[index] }))
}

function plannedSort(left: PlannedContour, right: PlannedContour): number {
  if (left.level !== right.level) return left.level - right.level
  const leftPoint = left.points.reduce((best, point) => point.y < best.y || (point.y === best.y && point.x < best.x) ? point : best)
  const rightPoint = right.points.reduce((best, point) => point.y < best.y || (point.y === best.y && point.x < best.x) ? point : best)
  return leftPoint.y - rightPoint.y || leftPoint.x - rightPoint.x || left.points.length - right.points.length
}

function planContours(domain: ClipperPath[], distanceContours: ConstantDistanceContour[]): PlannedContour[] {
  const byLevel = new Map<number, PlannedContour[]>()
  const append = (contour: PlannedContour): void => {
    const entries = byLevel.get(contour.level) ?? []
    entries.push(contour)
    byLevel.set(contour.level, entries)
  }
  clipperBoundaryContours(domain).forEach(append)
  distanceContours.forEach((contour) => append({ ...contour, boundary: false }))
  const planned: PlannedContour[] = []
  for (const entries of byLevel.values()) appendAll(planned, orientContourBatch(entries, 'conventional'))
  return planned.sort(plannedSort)
}

function applyDirection(contours: PlannedContour[], direction: Operation['cutDirection']): PlannedContour[] {
  if (direction === 'conventional') return contours
  const byLevel = new Map<number, PlannedContour[]>()
  for (const contour of contours) {
    const entries = byLevel.get(contour.level) ?? []
    entries.push(contour)
    byLevel.set(contour.level, entries)
  }
  const directed: PlannedContour[] = []
  for (const entries of byLevel.values()) appendAll(directed, orientContourBatch(entries, direction))
  return directed.sort(plannedSort)
}

function densify(points: Point[], closed: boolean, maximumStep: number): Point[] {
  const dense: Point[] = []
  const segmentCount = closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const from = points[index]
    const to = points[(index + 1) % points.length]
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / maximumStep))
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps
      dense.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  if (!closed) dense.push(points[points.length - 1])
  return dense
}

function splitByDomain(
  contour: PlannedContour,
  linkInside: (from: Point, to: Point) => boolean,
): Array<{ points: Point[]; closed: boolean }> {
  if (contour.boundary) return [{ points: contour.points, closed: true }]
  const points = contour.points
  const edgeCount = contour.closed ? points.length : points.length - 1
  const fragments: Array<{ points: Point[]; closed: boolean }> = []
  let current: Point[] = []
  let allInside = true
  const flush = (): void => {
    if (current.length >= 2) fragments.push({ points: current, closed: false })
    current = []
  }
  for (let index = 0; index < edgeCount; index += 1) {
    const from = points[index]
    const to = points[(index + 1) % points.length]
    if (!linkInside(from, to)) {
      allInside = false
      flush()
      continue
    }
    if (current.length === 0) current.push(from)
    current.push(to)
  }
  if (allInside && contour.closed) return [{ points, closed: true }]
  flush()
  return fragments
}

function liftFragment(
  fragment: { points: Point[]; closed: boolean },
  heightMap: HeightMap,
  tool: NormalizedTool,
  axialLeave: number,
  minCutZAtPoint: (point: Point) => number,
  hasMachinableSurface: (point: Point, liftedSurfaceZ: number) => boolean,
): LiftedContour[] {
  const lifted: LiftedContour[] = []
  let current: ToolpathPoint[] = []
  let previousFloor: number | null = null
  const flush = (closed = false): void => {
    if (current.length >= (closed ? 3 : 2)) lifted.push({ points: current, closed })
    current = []
    previousFloor = null
  }
  for (const point of fragment.points) {
    const surfaceZ = safeToolTipZAt(point.x, point.y, heightMap, tool)
    if (!Number.isFinite(surfaceZ)) {
      flush()
      continue
    }
    // Nothing to cut here — the surface is below a floor another operation
    // owns (issue #711). Break the pass exactly as a missing sample does,
    // rather than clamping up and cutting air along the limit.
    if (!hasMachinableSurface(point, surfaceZ + axialLeave)) {
      flush()
      continue
    }
    const floor = minCutZAtPoint(point)
    if (previousFloor !== null && Math.abs(previousFloor - floor) > 1e-9) flush()
    current.push({ x: point.x, y: point.y, z: Math.max(surfaceZ + axialLeave, floor) })
    previousFloor = floor
  }
  flush(fragment.closed && lifted.length === 0)
  return lifted
}

/**
 * Turn a lifted contour so it begins nearest the cutter (issue #716).
 *
 * This is the lever that keep-down linking actually needs, and it is specific
 * to this strategy: a **closed** level set has no natural start, so it may begin
 * anywhere on the loop, and starting it next to where the previous pass ended
 * turns a full retract into a link one spacing long. Without it the contour
 * order alone decides nothing — measured on the domed test fixture, every one of
 * 21 passes retracted despite all of them being nested rings a single spacing
 * apart, because `joinSegments` had started each loop wherever its first
 * marching-squares segment happened to fall.
 *
 * Open fragments keep their two ends and are merely reversed when the far end is
 * nearer, which is what `finishSurfaceParallel.ts` does with its scanlines.
 */
function presentToCutter(contour: LiftedContour, position: ToolpathPoint | null): LiftedContour {
  if (!position || contour.points.length < 2) return contour
  const distanceTo = (point: ToolpathPoint): number =>
    (point.x - position.x) ** 2 + (point.y - position.y) ** 2 + (point.z - position.z) ** 2
  if (!contour.closed) {
    const first = distanceTo(contour.points[0])
    const last = distanceTo(contour.points[contour.points.length - 1])
    return last < first ? { ...contour, points: [...contour.points].reverse() } : contour
  }
  let bestAt = 0
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < contour.points.length; index += 1) {
    const candidate = distanceTo(contour.points[index])
    if (candidate < best) { best = candidate; bestAt = index }
  }
  if (bestAt === 0) return contour
  return { ...contour, points: [...contour.points.slice(bestAt), ...contour.points.slice(0, bestAt)] }
}

function toCutMoves(contour: LiftedContour): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  const edgeCount = contour.closed ? contour.points.length : contour.points.length - 1
  for (let index = 0; index < edgeCount; index += 1) {
    moves.push({ kind: 'cut', from: contour.points[index], to: contour.points[(index + 1) % contour.points.length] })
  }
  return moves
}

/**
 * How far a keep-down link may reach, in pass spacings (issue #716).
 *
 * Adjacent level sets are one spacing apart by construction, so the natural
 * scale is a small multiple of it, and the safety of a link is decided by
 * `buildLinkCheck` rather than by distance. Measured gaps between consecutive
 * contours run to about 3x the spacing on `Oldman-splash-final.camj` and 1.5x
 * on `Makera_Model.camj`, so a bound at the median leaves most retracts in
 * place. Swept, as non-cutting share of the whole operation:
 *
 *   reach   guitar   Makera   Oldman
 *   none      3.3 %   13.3 %   35.6 %
 *      2x     1.9 %    3.6 %   27.3 %
 *      6x     1.4 %    1.1 %   21.9 %
 *     12x     1.0 %    0.7 %   19.4 %
 *     24x     0.6 %    0.5 %   19.0 %
 *     48x     0.4 %    0.5 %   18.6 %
 *
 * 12 is where it flattens. Past it Oldman gives up only 0.8 points across a
 * fourfold reach, because its remaining retracts are refused by the link check
 * and not by distance — 38.9 % of that model's surface sits below its pocket
 * floor, so the machinable area is genuinely several islands.
 *
 * The bound also has to stay under the point where keeping down costs more than
 * lifting: a link travels at cutting feed, so it is cheaper than a retract only
 * while `length / feed` beats the climb and descent at plunge feed. That
 * break-even is about 1.8 in on Oldman and 55 mm on the guitar, against links of
 * 0.26 in and 8.3 mm at this reach — an order of magnitude of headroom.
 */
const LINK_REACH_IN_SPACINGS = 12

/**
 * May the cutter travel from `from` to `to` without lifting to safe Z?
 *
 * Unlike waterline, no constant-scallop contour is at constant Z, so a link
 * between two of them descends or climbs along its length. The check therefore
 * interpolates Z across the candidate link and requires it to stay above the
 * cutter-location surface at every sample — the same test
 * `finishSurfaceParallel.ts` applies to its own Z-varying scanline links — and
 * additionally requires the link to stay inside the composed domain, so it can
 * never cut across a region the slope filter, an ordered region or model
 * protection removed.
 */
function buildLinkCheck(
  heightMap: HeightMap,
  tool: NormalizedTool,
  axialLeave: number,
  linkInside: (from: Point, to: Point) => boolean,
): (from: ToolpathPoint, to: ToolpathPoint) => boolean {
  const sampleSpacing = Math.max(heightMap.cellSize, tool.radius * 0.5)
  const cushion = Math.max(heightMap.cellSize * 0.5, 1e-3)
  return (from: ToolpathPoint, to: ToolpathPoint): boolean => {
    if (!linkInside(from, to)) return false
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / sampleSpacing))
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps
      const required = safeToolTipZAt(from.x + dx * t, from.y + dy * t, heightMap, tool)
      if (!Number.isFinite(required)) continue
      if (from.z + dz * t + cushion < required + axialLeave) return false
    }
    return true
  }
}

/**
 * Visit the lifted passes nearest-first (issue #716).
 *
 * `plannedSort` orders by (level, minY, minX). The level part is meaningful; the
 * bounding-box part has no relation to where the cutter is, and on a model whose
 * machinable area is several islands it scatters the path badly —
 * `Oldman-splash-final.camj` opened with jumps of 1.60, 1.57, 1.61, 1.64 and
 * 1.65 in across a 4 x 3 in part, crossing it and coming back.
 *
 * **This has to order the lifted pieces, not the planned contours**, which is
 * the part that took a wrong turn twice. A single level set is split by the
 * composed domain into however many fragments survive, and those were emitted in
 * their order *along the contour*: ordering the contours left the cutter jumping
 * between one contour's own fragments, so the opening was byte-identical to the
 * static sort even with a greedy in place. Instrumenting it showed the greedy
 * picking correctly at 0.013-0.025 in each time while the cutter position it was
 * measuring from had already been thrown across the part.
 *
 * Two orderings that do not work here, both tried and measured:
 *   - *Greedy within each level.* A no-op — most levels hold a single contour.
 *   - *Waterline's bounding-box IoU column clustering.* Waterline's rings sit
 *     above one another on a vertical wall so their boxes coincide; constant
 *     scallop's are insets that shrink at every level, so IoU > 0.5 clusters 36
 *     runs into 28 groups, mostly singletons.
 *
 * Level order is therefore not preserved, and for a finishing pass it need not
 * be: every pass cuts the same geometry whatever the order, the engagement is a
 * scallop ridge either way, and it is the link check rather than the ordering
 * that keeps a move safe.
 *
 * Nearest *point*, not nearest endpoint, because `presentToCutter` may enter a
 * closed loop anywhere. Deterministic: it starts from the first piece in the
 * planned order and ties break on that same position.
 */
function orderForTravel(
  pieces: LiftedContour[],
  currentPosition: () => ToolpathPoint | null,
): Iterable<LiftedContour> {
  return {
    *[Symbol.iterator](): Iterator<LiftedContour> {
      const used = new Uint8Array(pieces.length)
      for (let emitted = 0; emitted < pieces.length; emitted += 1) {
        const from = currentPosition()
        let best = -1
        let bestDistance = Number.POSITIVE_INFINITY
        for (let candidate = 0; candidate < pieces.length; candidate += 1) {
          if (used[candidate] === 1) continue
          if (from === null) { best = candidate; break }
          for (const point of pieces[candidate].points) {
            const distance = (point.x - from.x) ** 2 + (point.y - from.y) ** 2 + (point.z - from.z) ** 2
            if (distance < bestDistance) { bestDistance = distance; best = candidate }
          }
        }
        if (best < 0) break
        used[best] = 1
        yield pieces[best]
      }
    },
  }
}

function emitContours(
  contours: PlannedContour[],
  domain: ClipperPath[],
  heightMap: HeightMap,
  tool: NormalizedTool,
  operation: Operation,
  safeZ: number,
  spacing: number,
  minCutZAtPoint: (point: Point) => number,
  hasMachinableSurface: (point: Point, liftedSurfaceZ: number) => boolean,
): { moves: ToolpathMove[]; stepLevels: Set<number> } {
  const moves: ToolpathMove[] = []
  const stepLevels = new Set<number>()
  const linkInside = createSurfaceDomainLinkCheck(domain)
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  const safeLinkCheck = buildLinkCheck(heightMap, tool, axialLeave, linkInside)
  const linkMaxDistance = spacing * LINK_REACH_IN_SPACINGS
  // Every pass is lifted before any is emitted, because the travel order is
  // over the lifted pieces and a contour does not know how many it will produce.
  const pieces: LiftedContour[] = []
  for (const contour of applyDirection(contours, operation.cutDirection)) {
    const dense = { ...contour, points: densify(contour.points, contour.closed, heightMap.cellSize) }
    for (const fragment of splitByDomain(dense, linkInside)) {
      appendAll(pieces, liftFragment(
        fragment,
        heightMap,
        tool,
        axialLeave,
        minCutZAtPoint,
        hasMachinableSurface,
      ))
    }
  }

  let position: ToolpathPoint | null = null
  for (const lifted of orderForTravel(pieces, () => position)) {
    const presented = presentToCutter(lifted, position)
    const entry = presented.points[0]
    // `transitionToCutEntry`'s same-XY shortcut bypasses its own link
    // check, so an unsafe link from a position still down in the cut has to
    // be retracted here first — the same guard the parallel strategy uses.
    if (position && position.z < safeZ && !safeLinkCheck(position, entry)) {
      position = retractToSafe(moves, position, safeZ)
    }
    position = transitionToCutEntry(moves, position, entry, safeZ, linkMaxDistance, safeLinkCheck)
    appendAll(moves, toCutMoves(presented))
    for (const point of presented.points) stepLevels.add(point.z)
    // Deliberately no retract: the cutter stays down and the next
    // transition decides. `generateFinishSurfaceToolpath` retracts once at
    // the end of the operation. A closed loop ends where it started, so the
    // position left behind is its entry point.
    position = presented.closed
      ? presented.points[0]
      : presented.points[presented.points.length - 1]
  }
  return { moves, stepLevels }
}

function resolveDomain(
  project: Project,
  operation: Operation,
  modelFeature: SketchFeature,
  regionFeatures: SketchFeature[],
  tool: NormalizedTool,
  heightMap: HeightMap,
  warnings: ToolpathWarning[],
): ClipperPath[] {
  const silhouette = modelSilhouettePathsForFinishSurface(modelFeature)
  const regionMask = buildRegionMask(regionFeatures)
  const centreInset = tool.radius + Math.max(0, operation.stockToLeaveRadial ?? 0)
  let domain = resolveRegionDomainCentre(silhouette, regionMask, centreInset)
  const slope = buildSurfaceSlopeDomain(
    operation,
    heightMap,
    (x, y) => safeToolTipZAt(x, y, heightMap, tool),
    warnings,
  )
  if (slope !== null) domain = intersectSurfaceSlopeDomain(domain, slope)
  const protectedPaths = buildProtectedFootprintPaths(project, {
    targetFeatureIds: new Set(operation.target.source === 'features' ? operation.target.featureIds : []),
    featureExpansion: centreInset,
    clampExpansion: tool.radius,
    includeTabs: false,
    machiningEnvelopePaths: silhouette,
  })
  return differenceClipperPaths(domain, protectedPaths)
}

export function generateFinishSurfaceConstantScallop(
  project: Project,
  operation: Operation,
  modelFeature: SketchFeature,
  regionFeatures: SketchFeature[],
  tool: NormalizedTool,
  transformedPos: Float32Array,
  index: Uint32Array,
  cacheHost: FinishSurfaceParallelCacheHost,
  safeZ: number,
  minCutZAtPoint: (point: Point) => number,
  hasMachinableSurface: (point: Point, liftedSurfaceZ: number) => boolean,
  warnings: ToolpathWarning[],
): { moves: ToolpathMove[]; stepLevels: Set<number> } {
  const stepoverRatio = operation.stepover ?? 0.5
  const spacing = finishScallopSpacing(operation, tool) ?? stepoverRatio * tool.diameter
  if (!(spacing > 0) || !Number.isFinite(spacing)) {
    warnings.push({ code: 'stepoverRatioRange' })
    return { moves: [], stepLevels: new Set() }
  }
  const bounds = computeXYBounds(transformedPos)
  const requestedCellSize = Math.max(1e-6, Math.min(tool.radius / 5, spacing))
  const cellSize = chooseHeightMapCellSize(bounds, requestedCellSize, warnings)
  if (cellSize > spacing + 1e-9) {
    warnings.push({
      code: 'constantScallopResolutionTooCoarse',
      params: { spacing: spacing.toFixed(4), cellSize: cellSize.toFixed(4) },
    })
    return { moves: [], stepLevels: new Set() }
  }
  const heightMap = getCachedHeightMap(cacheHost, transformedPos, index, bounds, cellSize)
  const domain = resolveDomain(project, operation, modelFeature, regionFeatures, tool, heightMap, warnings)
  if (domain.length === 0) {
    if (!warnings.some((warning) => warning.code === 'finishSlopeEmpty')) {
      warnings.push({ code: 'constantScallopEmpty' })
    }
    return { moves: [], stepLevels: new Set() }
  }
  const grid = buildCutterLocationGrid(heightMap, domain, tool, Math.max(0, operation.stockToLeaveAxial))
  const field = grid ? buildGeodesicDistanceField(grid) : null
  if (!field) {
    warnings.push({ code: 'constantScallopEmpty' })
    return { moves: [], stepLevels: new Set() }
  }
  const contours = planContours(domain, extractConstantDistanceContours(field, spacing))
  return emitContours(contours, domain, heightMap, tool, operation, safeZ, spacing, minCutZAtPoint, hasMachinableSurface)
}
