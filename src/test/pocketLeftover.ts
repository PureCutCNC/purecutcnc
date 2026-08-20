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
 * Leftover measurement for a pocket finish pass (issue #550): how much of the
 * reachable pocket does the emitted finish pass fail to cut at its deepest
 * level?
 *
 * The claim under test is geometric, so the measurement is geometric rather
 * than raster: everything is a Clipper boolean at 1e6 counts per project unit.
 *
 *   nominal R      the resolved pocket region of the finish operation, which
 *                  carries zero stock to leave, so R is the finished wall.
 *   reachable O    R eroded by the finish tool radius and dilated back with
 *                  round joins — the morphological opening. Everything in
 *                  R \ O is a corner no round cutter of that size can enter,
 *                  and is reported separately so it never counts as a defect.
 *   cleared U      the swept envelope of the emitted cut moves: each cut
 *                  centreline offset by its own tool radius.
 *   leftover       O \ U, per Z slice. A flat cutter at Zp clears every slice
 *                  at or above Zp, so the deepest slice is the binding one.
 *
 * This module is test/diagnostic infrastructure only; production code does not
 * import it. The companion CLI report is scripts/issue-550-leftover-probe.ts.
 */

import ClipperLib from 'clipper-lib'

import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import { generatePocketToolpath } from '../engine/toolpaths/pocket'
import { resolvePocketRegions } from '../engine/toolpaths/resolver'
import type { ToolpathMove } from '../engine/toolpaths/types'
import type { Operation, Point, Project } from '../types/project'

const SCALE = 1e6
const ARC_TOLERANCE = 0.25 // scaled units, i.e. 0.25e-6 project units

/**
 * Anything thinner than this is Clipper's own arc/rounding residue, not stock:
 * the offsets are built to 0.25e-6 units and the emitted path is tessellated,
 * so hairlines a few counts wide appear along every swept edge.
 */
export const LEFTOVER_NOISE_RADIUS = 2e-4

export type ClipperPath = Array<{ X: number; Y: number }>

export const toPath = (points: Point[]): ClipperPath =>
  points.map((point) => ({ X: Math.round(point.x * SCALE), Y: Math.round(point.y * SCALE) }))

export const fromPath = (path: ClipperPath): Point[] =>
  path.map((point) => ({ x: point.X / SCALE, y: point.Y / SCALE }))

export function clip(subject: ClipperPath[], clipPaths: ClipperPath[], op: number): ClipperPath[] {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true)
  if (clipPaths.length > 0) clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  const solution: ClipperPath[] = []
  clipper.Execute(op, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return solution
}

export const unionPaths = (paths: ClipperPath[]): ClipperPath[] =>
  clip(paths, [], ClipperLib.ClipType.ctUnion)

export const differencePaths = (a: ClipperPath[], b: ClipperPath[]): ClipperPath[] =>
  b.length === 0 ? unionPaths(a) : clip(a, b, ClipperLib.ClipType.ctDifference)

export function offsetClosed(paths: ClipperPath[], delta: number): ClipperPath[] {
  if (paths.length === 0) return []
  const offsetter = new ClipperLib.ClipperOffset()
  offsetter.ArcTolerance = ARC_TOLERANCE
  offsetter.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const solution: ClipperPath[] = []
  offsetter.Execute(solution, delta)
  return solution
}

/** Swept envelope of a run of cut centrelines: grown by the radius. */
export function offsetOpen(lines: ClipperPath[], radius: number): ClipperPath[] {
  if (lines.length === 0) return []
  const offsetter = new ClipperLib.ClipperOffset()
  offsetter.ArcTolerance = ARC_TOLERANCE
  offsetter.AddPaths(
    lines,
    ClipperLib.JoinType.jtRound,
    (ClipperLib.EndType as unknown as { etOpenRound: number }).etOpenRound,
  )
  const solution: ClipperPath[] = []
  offsetter.Execute(solution, radius)
  return unionPaths(solution)
}

/** Access PointInPolygon (available at runtime, not in the .d.ts). */
function clipperPointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number {
  return (ClipperLib.Clipper as unknown as {
    PointInPolygon(point: { X: number; Y: number }, path: ClipperPath): number
  }).PointInPolygon(point, path)
}

export function pathsArea(paths: ClipperPath[]): number {
  return paths.reduce((sum, path) => sum + ClipperLib.Clipper.Area(path), 0) / (SCALE * SCALE)
}

/** Largest disc that fits inside the shape, by bisection on the erosion. */
export function inscribedRadius(paths: ClipperPath[], limit: number): number {
  let low = 0
  let high = limit
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2
    if (offsetClosed(paths, -mid * SCALE).length > 0) low = mid
    else high = mid
  }
  return low
}

export function pathCentroid(path: ClipperPath): Point {
  let x = 0
  let y = 0
  for (const point of path) {
    x += point.X
    y += point.Y
  }
  return { x: x / path.length / SCALE, y: y / path.length / SCALE }
}

export const cutMoves = (moves: ToolpathMove[]): ToolpathMove[] =>
  moves.filter((move) => move.kind === 'cut'
    && Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) > 1e-9)

/** Consecutive cuts that meet end-to-end become one polyline. */
export function polylines(moves: ToolpathMove[]): ClipperPath[] {
  const lines: ClipperPath[] = []
  let current: Point[] = []
  for (const move of moves) {
    if (current.length === 0) {
      current = [move.from, move.to]
      continue
    }
    const tail = current[current.length - 1]
    if (Math.hypot(tail.x - move.from.x, tail.y - move.from.y) <= 1e-9) current.push(move.to)
    else {
      lines.push(toPath(current))
      current = [move.from, move.to]
    }
  }
  if (current.length >= 2) lines.push(toPath(current))
  return lines
}

export function movesAtOrBelow(moves: ToolpathMove[], z: number): ToolpathMove[] {
  return cutMoves(moves).filter((move) => move.to.z <= z + 1e-9 && move.from.z <= z + 1e-9)
}

export interface LeftoverIslandInfo {
  area: number
  largestInscribedRadius: number
  at: Point
}

export interface LeftoverRegionReport {
  bandIndex: number
  regionIndex: number
  bandTopZ: number
  bandBottomZ: number
  reachableArea: number
  /** Share of the nominal region no round cutter of the finish size can enter. */
  unreachableArea: number
  /** Reachable area not covered by the finish sweep at the deepest cut Z. */
  leftoverArea: number
  leftoverIslands: LeftoverIslandInfo[]
  /** Slivers under LEFTOVER_NOISE_RADIUS — Clipper residue, not stock. */
  hairlineIslands: number
  hairlineArea: number
}

export interface PocketLeftoverReport {
  units: 'mm' | 'inch'
  finishToolRadius: number
  roughToolRadius: number
  finishCutMoves: number
  roughCutMoves: number
  finishZLevels: number[]
  roughZLevels: number[]
  regions: LeftoverRegionReport[]
}

function describeLeftovers(leftovers: ClipperPath[], toolRadius: number): {
  islands: LeftoverIslandInfo[]
  hairlineIslands: number
  hairlineArea: number
} {
  const outers = leftovers.filter((path) => ClipperLib.Clipper.Area(path) > 0)
  const total = pathsArea(leftovers)
  const ranked = outers
    .map((path) => {
      const holes = leftovers.filter((candidate) => ClipperLib.Clipper.Area(candidate) < 0
        && clipperPointInPolygon(candidate[0], path) !== 0)
      const piece = [path, ...holes]
      return {
        piece,
        area: pathsArea(piece),
        radius: inscribedRadius(piece, toolRadius * 4),
        at: pathCentroid(path),
      }
    })
    .sort((a, b) => b.radius - a.radius)
  const islands = ranked
    .filter((island) => island.radius > LEFTOVER_NOISE_RADIUS)
    .map((island) => ({
      area: island.area,
      largestInscribedRadius: island.radius,
      at: island.at,
    }))
  return {
    islands,
    hairlineIslands: outers.length - islands.length,
    hairlineArea: total - islands.reduce((sum, island) => sum + island.area, 0),
  }
}

/**
 * Measure how much reachable pocket the emitted finish pass fails to cut at
 * its deepest level. `rough` is optional: when given, the report also carries
 * its cut-move and Z-level counts for the probe's cross-checks.
 */
export function measurePocketLeftover(
  project: Project,
  finish: Operation,
  rough?: Operation,
): PocketLeftoverReport {
  const finishTool = project.tools.find((candidate) => candidate.id === finish.toolRef)
  if (!finishTool) throw new Error(`operation ${finish.id} has no tool`)
  const finishToolRadius = normalizeToolForProject(finishTool, project).diameter / 2
  const roughTool = rough ? project.tools.find((candidate) => candidate.id === rough.toolRef) : undefined
  if (rough && !roughTool) throw new Error(`operation ${rough.id} has no tool`)
  const roughToolRadius = rough && roughTool
    ? normalizeToolForProject(roughTool, project).diameter / 2
    : 0

  const finishMoves = generatePocketToolpath(project, finish).moves
  const roughMoves = rough ? generatePocketToolpath(project, rough).moves : []

  const levelList = (moves: ToolpathMove[]): number[] => {
    const counts = new Map<number, number>()
    for (const move of cutMoves(moves)) {
      const z = Math.round(Math.min(move.to.z, move.from.z) * 1e6) / 1e6
      counts.set(z, (counts.get(z) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([z]) => z)
  }

  const regions: LeftoverRegionReport[] = []
  const { bands } = resolvePocketRegions(project, finish)
  const deepest = Math.min(...cutMoves(finishMoves).map((move) => move.to.z))
  const finishFloorSweep = offsetOpen(
    polylines(movesAtOrBelow(finishMoves, deepest + 1e-9)),
    finishToolRadius * SCALE,
  )

  for (const [bandIndex, band] of bands.entries()) {
    for (const [regionIndex, region] of band.regions.entries()) {
      const nominal = unionPaths([
        toPath(region.outer),
        ...region.islands.map((island) => toPath(island)),
      ])
      const centres = offsetClosed(nominal, -finishToolRadius * SCALE)
      const reachable = offsetClosed(centres, finishToolRadius * SCALE)
      const leftovers = differencePaths(reachable, finishFloorSweep)
      const described = describeLeftovers(leftovers, finishToolRadius)
      regions.push({
        bandIndex,
        regionIndex,
        bandTopZ: band.topZ,
        bandBottomZ: band.bottomZ,
        reachableArea: pathsArea(reachable),
        unreachableArea: pathsArea(nominal) - pathsArea(reachable),
        leftoverArea: described.islands.reduce((sum, island) => sum + island.area, 0),
        leftoverIslands: described.islands,
        hairlineIslands: described.hairlineIslands,
        hairlineArea: described.hairlineArea,
      })
    }
  }

  return {
    units: project.meta.units,
    finishToolRadius: finishToolRadius,
    roughToolRadius,
    finishCutMoves: cutMoves(finishMoves).length,
    roughCutMoves: rough ? cutMoves(roughMoves).length : 0,
    finishZLevels: levelList(finishMoves),
    roughZLevels: rough ? levelList(roughMoves) : [],
    regions,
  }
}
