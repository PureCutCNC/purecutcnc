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
 * Corner-smoothing probe for issue #546.
 *
 * One-off diagnostic, not a quality gate. It answers the questions a green
 * suite cannot, on whatever pocket you point it at:
 *
 *  1. Corners     — what radius each interior ring's transitions actually
 *                   reach, and how many needed the broad full-radius arc.
 *  2. Junctions   — the cut-to-cut angle census. Note this is nearly blind to
 *                   the defect the slice fixes: a 0.006in fillet tessellated at
 *                   5 degrees looks perfectly smooth here, which is why the
 *                   curvature block below exists.
 *  3. Curvature   — minimum radius actually held, path length spent below half
 *                   the request, and the micro-move count. This is where a
 *                   starved corner shows up.
 *  4. Feed        — the engagement feed-scale profile by distance and by time,
 *                   overall and per concentric ring band. Bands are attributed
 *                   by distance from the nearest wall or island boundary,
 *                   because the ring tree is built by successive insets.
 *  5. Time        — commanded feed, and a GRBL planner (junction deviation plus
 *                   a forward/backward acceleration pass) with the physical
 *                   curvature limit v <= sqrt(a*R) layered on, which junction
 *                   deviation misses on finely tessellated arcs.
 *  6. Clearance   — rasterises the material to be removed and tests every cell
 *                   against the swept envelope of the emitted cuts. Run this
 *                   after any change that removes cleanup motion.
 *
 * Usage:
 *   npx tsx scripts/issue-546-corner-probe.ts <file.camj> ['{"cleanWallCorners":true}']
 *   npx tsx scripts/issue-546-corner-probe.ts shapes
 *
 * `shapes` skips the fixture and runs a built-in matrix instead, reporting
 * which shapes the feature touches at all — a sharp-cornered pocket has no
 * starved corners, so its stream must come back byte-identical.
 */

import { readFileSync } from 'node:fs'

import ClipperLib from 'clipper-lib'

import { effectiveFeed } from '../src/engine/toolpaths/feed'
import { applyContourDirection, normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import { cornerSmoothingRadius, planContourSmoothing } from '../src/engine/toolpaths/offsetSmoothing'
import {
  buildInsetRegions,
  buildOffsetRegionTree,
  cutOffsetRegionRecursive,
  generatePocketToolpath,
  type OffsetRegionNode,
} from '../src/engine/toolpaths/pocket'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver'
import { buildSweptCoverage } from '../src/engine/toolpaths/sweptCoverage'
import type { ResolvedPocketRegion, ToolpathMove } from '../src/engine/toolpaths/types'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import type { Operation, Point, Project } from '../src/types/project'

const IN_PER_MM = 1 / 25.4

function segmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 1e-18) return Math.hypot(point.x - from.x, point.y - from.y)
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t))
}

function moveLength(move: ToolpathMove): number {
  return Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
}

function livingCuts(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'cut' && moveLength(move) > 1e-9)
}

/** Deflection at each junction where two consecutive cuts actually meet. */
function junctionAngles(cuts: ToolpathMove[]): number[] {
  const angles: number[] = []
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const a = cuts[index]
    const b = cuts[index + 1]
    if (Math.abs(a.to.x - b.from.x) > 1e-6 || Math.abs(a.to.y - b.from.y) > 1e-6) continue
    const inX = a.to.x - a.from.x
    const inY = a.to.y - a.from.y
    const outX = b.to.x - b.from.x
    const outY = b.to.y - b.from.y
    const cosine = Math.max(-1, Math.min(1,
      (inX * outX + inY * outY) / (Math.hypot(inX, inY) * Math.hypot(outX, outY))))
    angles.push((Math.acos(cosine) * 180) / Math.PI)
  }
  return angles.sort((a, b) => a - b)
}

/** Circumradius through three consecutive points: the curvature actually held. */
function localRadius(a: Point, b: Point, c: Point): number {
  const ab = Math.hypot(b.x - a.x, b.y - a.y)
  const bc = Math.hypot(c.x - b.x, c.y - b.y)
  const ca = Math.hypot(c.x - a.x, c.y - a.y)
  const twiceArea = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
  if (twiceArea <= 1e-14 || ab <= 1e-12 || bc <= 1e-12) return Infinity
  return (ab * bc * ca) / (2 * twiceArea)
}

interface Planner {
  length: number
  nominal: number
  ux: number
  uy: number
  connected: boolean
  from: Point
  to: Point
}

/**
 * GRBL's planner: a junction-deviation speed cap per corner, optionally also
 * the physical centripetal cap, then a backward and forward acceleration pass.
 * Returns seconds. `accel` is in project units per second squared.
 */
function plannedSeconds(segments: Planner[], accel: number, curvature: boolean): number {
  const deviation = 0.01 * IN_PER_MM
  const count = segments.length
  const entry = new Float64Array(count + 1)
  for (let index = 1; index < count; index += 1) {
    if (!segments[index].connected) continue
    const previous = segments[index - 1]
    const next = segments[index]
    const dot = Math.max(-1, Math.min(1, previous.ux * next.ux + previous.uy * next.uy))
    const cosHalf = Math.sqrt(Math.max(0, 0.5 * (1 + dot)))
    let cap = cosHalf >= 1 - 1e-12
      ? Infinity
      : (cosHalf <= 1e-12 ? 0 : (accel * deviation * cosHalf) / (1 - cosHalf))
    cap = Math.min(cap, previous.nominal ** 2, next.nominal ** 2)
    if (curvature) {
      cap = Math.min(cap, accel * localRadius(previous.from, next.from, next.to))
    }
    entry[index] = cap
  }
  for (let index = count - 1; index >= 0; index -= 1) {
    entry[index] = Math.min(entry[index], entry[index + 1] + 2 * accel * segments[index].length)
  }
  let total = 0
  for (let index = 0; index < count; index += 1) {
    const segment = segments[index]
    entry[index + 1] = Math.min(entry[index + 1], entry[index] + 2 * accel * segment.length)
    const vIn = Math.sqrt(Math.max(0, entry[index]))
    const vOut = Math.sqrt(Math.max(0, entry[index + 1]))
    const peak = Math.min(segment.nominal,
      Math.sqrt(Math.max(0, (entry[index] + entry[index + 1]) / 2 + accel * segment.length)))
    const rampUp = Math.max(0, (peak * peak - vIn * vIn) / (2 * accel))
    const rampDown = Math.max(0, (peak * peak - vOut * vOut) / (2 * accel))
    const cruise = Math.max(0, segment.length - rampUp - rampDown)
    total += (peak - vIn) / accel + (peak - vOut) / accel + cruise / Math.max(peak, 1e-9)
  }
  return total
}

function report(file: string, overrides: Partial<Operation>): void {
  const project = normalizeProject(JSON.parse(readFileSync(file, 'utf8')) as Project)
  const pockets = project.operations.filter((candidate) =>
    candidate.kind === 'pocket' && candidate.enabled !== false)
  if (pockets.length === 0) {
    console.log(`${file}: no enabled pocket operation`)
    return
  }
  console.log(`\n=== ${file} ===`)
  for (const base of pockets) {
    const operation = { ...base, ...overrides }
    const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
    if (!tool) continue
    const normalized = normalizeToolForProject(tool, project)
    const toolRadius = normalized.diameter / 2
    const stepover = Math.max(normalized.diameter * operation.stepover, normalized.diameter * 0.05)
    const request = cornerSmoothingRadius(operation.roundOutsideCorners, toolRadius, stepover) ?? 0
    console.log(`operation ${operation.id}  tool d${normalized.diameter}  stepover ${stepover.toFixed(4)}`
      + `  smoothing radius ${request.toFixed(4)}`)

    // ── 1. corners ──
    if (request > 0) {
      const resolved = resolvePocketRegions(project, operation)
      const trees = resolved.bands.flatMap((band) => band.regions
        .flatMap((region) => buildInsetRegions(region, toolRadius, ClipperLib.JoinType.jtMiter, ClipperLib.JoinType.jtRound))
        .map((region) => buildOffsetRegionTree(region, stepover, ClipperLib.JoinType.jtRound)))
      let transitions = 0
      let broad = 0
      let starved = 0
      const visit = (node: OffsetRegionNode, depth: number): void => {
        const directed = applyContourDirection([node.region.outer], operation.cutDirection ?? 'conventional')[0]
        if (directed && directed.length >= 3 && depth > 0) {
          const plan = planContourSmoothing(directed, request, { broadCorners: true })
          for (const transition of plan.transitions) {
            transitions += 1
            if (transition.cutsAcrossSource) broad += 1
            else if (transition.effectiveRadius < request * 0.5) starved += 1
          }
        }
        node.children.forEach((child) => visit(child, depth + 1))
      }
      trees.forEach((tree) => visit(tree, 0))
      console.log(`  corners   ${transitions} interior transitions, ${broad} cut with a full-radius arc,`
        + ` ${starved} still under half the request`)
    }

    const result = generatePocketToolpath(project, operation)
    const cuts = livingCuts(result.moves)
    if (cuts.length === 0) continue

    // ── 2. junctions ──
    const angles = junctionAngles(cuts)
    const quantile = (p: number): number => angles[Math.min(angles.length - 1, Math.floor(p * angles.length))] ?? 0
    console.log(`  junctions ${angles.length}  median ${quantile(0.5).toFixed(1)}  p95 ${quantile(0.95).toFixed(1)}`
      + `  max ${(angles[angles.length - 1] ?? 0).toFixed(1)}`
      + `  >=20deg ${angles.filter((angle) => angle >= 20).length}`)

    // ── 3. curvature ──
    let minRadius = Infinity
    let tightLength = 0
    for (let index = 0; index + 1 < cuts.length; index += 1) {
      const a = cuts[index]
      const b = cuts[index + 1]
      if (Math.abs(a.to.x - b.from.x) > 1e-6 || Math.abs(a.to.y - b.from.y) > 1e-6) continue
      const radius = localRadius(a.from, a.to, b.to)
      minRadius = Math.min(minRadius, radius)
      if (request > 0 && radius < request / 2) tightLength += (moveLength(a) + moveLength(b)) / 2
    }
    const micro = cuts.filter((move) => moveLength(move) < request / 40).length
    console.log(`  curvature min radius ${minRadius.toFixed(5)}  length below half the request ${tightLength.toFixed(4)}`
      + `  moves under r/40 ${micro}`)

    // ── 4. feed, overall and per band ──
    const boundaries: Point[][] = []
    for (const band of resolvePocketRegions(project, operation).bands) {
      for (const region of band.regions) {
        boundaries.push(region.outer)
        boundaries.push(...region.islands)
      }
    }
    const toBoundary = (point: Point): number => {
      let best = Infinity
      for (const polygon of boundaries) {
        for (let index = 0; index < polygon.length; index += 1) {
          best = Math.min(best, segmentDistance(point, polygon[index], polygon[(index + 1) % polygon.length]))
        }
      }
      return best
    }
    const byScale = new Map<number, { length: number; seconds: number }>()
    const byBand = new Map<number, { length: number; seconds: number }>()
    let totalLength = 0
    let totalSeconds = 0
    for (const move of cuts) {
      const length = moveLength(move)
      const seconds = length / (effectiveFeed('cut', move.feedScale, operation.feed, operation.plungeFeed) / 60)
      totalLength += length
      totalSeconds += seconds
      const scale = Number((move.feedScale ?? 1).toFixed(2))
      const scaleRow = byScale.get(scale) ?? { length: 0, seconds: 0 }
      byScale.set(scale, { length: scaleRow.length + length, seconds: scaleRow.seconds + seconds })
      const mid = { x: (move.from.x + move.to.x) / 2, y: (move.from.y + move.to.y) / 2 }
      const depth = Math.max(0, Math.round((toBoundary(mid) - toolRadius) / stepover))
      const bandRow = byBand.get(depth) ?? { length: 0, seconds: 0 }
      byBand.set(depth, { length: bandRow.length + length, seconds: bandRow.seconds + seconds })
    }
    console.log('  feed scale   ' + [...byScale.entries()].sort((a, b) => b[0] - a[0])
      .map(([scale, row]) => `${(scale * 100).toFixed(0)}%: ${(100 * row.length / totalLength).toFixed(1)}%`)
      .join('  '))
    console.log('  ring band    ' + [...byBand.entries()].sort((a, b) => a[0] - b[0])
      .map(([depth, row]) => `${depth === 0 ? 'wall' : `d${depth}`}: ${row.seconds.toFixed(1)}s`
        + `@${(100 * row.length / (row.seconds * operation.feed / 60)).toFixed(0)}%`)
      .join('  '))

    // ── 5. time ──
    const planner: Planner[] = []
    for (let index = 0; index < result.moves.length; index += 1) {
      const move = result.moves[index]
      const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y, move.to.z - move.from.z)
      if (length <= 1e-12) continue
      const feed = move.kind === 'rapid'
        ? 200
        : effectiveFeed(move.kind, move.feedScale, operation.feed, operation.plungeFeed)
      const previous = planner[planner.length - 1]
      planner.push({
        length,
        nominal: feed / 60,
        ux: (move.to.x - move.from.x) / length,
        uy: (move.to.y - move.from.y) / length,
        from: move.from,
        to: move.to,
        connected: previous !== undefined
          && Math.hypot(previous.to.x - move.from.x, previous.to.y - move.from.y) <= 1e-9,
      })
    }
    const accel = 200 * IN_PER_MM
    console.log(`  time      cut ${totalLength.toFixed(3)} at commanded feed ${totalSeconds.toFixed(2)}s`
      + `  |  planner a=200mm/s2 ${plannedSeconds(planner, accel, false).toFixed(2)}s`
      + `  with curvature limit ${plannedSeconds(planner, accel, true).toFixed(2)}s`)

    // ── 6. clearance ──
    const z = Math.min(...cuts.map((move) => move.to.z))
    const planar = cuts.filter((move) =>
      Math.abs(move.to.z - z) < 1e-9 && Math.abs(move.from.z - z) < 1e-9)
    const coverage = buildSweptCoverage(
      planar.map((move) => [{ x: move.from.x, y: move.from.y }, { x: move.to.x, y: move.to.y }]),
      toolRadius,
    )
    const cell = toolRadius / 30
    let material = 0
    let unreached = 0
    let deepest = 0
    const inside = (x: number, y: number, polygon: Point[]): boolean => {
      let hit = false
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i]
        const b = polygon[j]
        if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit
      }
      return hit
    }
    for (const band of resolvePocketRegions(project, operation).bands) {
      for (const region of band.regions) {
        const xs = region.outer.map((point) => point.x)
        const ys = region.outer.map((point) => point.y)
        for (let x = Math.min(...xs); x <= Math.max(...xs); x += cell) {
          for (let y = Math.min(...ys); y <= Math.max(...ys); y += cell) {
            if (!inside(x, y, region.outer)) continue
            if (region.islands.some((island) => inside(x, y, island))) continue
            material += 1
            if (coverage.covers(x, y)) continue
            let nearest = Infinity
            for (const move of planar) {
              nearest = Math.min(nearest, segmentDistance({ x, y }, move.from, move.to))
            }
            const beyond = nearest - toolRadius
            if (beyond <= cell) continue
            unreached += 1
            deepest = Math.max(deepest, beyond)
          }
        }
      }
    }
    console.log(`  clearance ${unreached} of ${material} cells unreached`
      + ` (${(100 * unreached / Math.max(material, 1)).toFixed(3)}%),`
      + ` deepest ${deepest.toFixed(4)} beyond the cutter`
      + ' — expect the sharp wall and island vertices no round tool can enter')
  }
}

/** Which shapes the feature touches at all. Sharp corners must not move. */
function shapes(): void {
  const toolRadius = 3
  const stepover = 2
  const rectangle = (x0: number, y0: number, x1: number, y1: number): Point[] =>
    [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
  const round = (cx: number, cy: number, r: number, steps: number): Point[] =>
    Array.from({ length: steps }, (_, index) => {
      const angle = (2 * Math.PI * index) / steps
      return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
    })
  const cases: Array<{ name: string; region: ResolvedPocketRegion }> = [
    { name: 'plain rectangle', region: { outer: rectangle(0, 0, 120, 80), islands: [], targetFeatureIds: [], islandFeatureIds: [] } },
    { name: 'rectangle + square island', region: { outer: rectangle(0, 0, 120, 80), islands: [rectangle(50, 30, 70, 50)], targetFeatureIds: [], islandFeatureIds: [] } },
    { name: 'rectangle + round island', region: { outer: rectangle(0, 0, 120, 80), islands: [round(60, 40, 12, 64)], targetFeatureIds: [], islandFeatureIds: [] } },
    { name: 'narrow slot + round island', region: { outer: rectangle(0, 0, 120, 34), islands: [round(60, 17, 8, 64)], targetFeatureIds: [], islandFeatureIds: [] } },
    { name: 'two round islands', region: { outer: rectangle(0, 0, 160, 80), islands: [round(50, 40, 14, 64), round(112, 40, 14, 64)], targetFeatureIds: [], islandFeatureIds: [] } },
  ]
  const emit = (region: ResolvedPocketRegion, smoothRadius: number | undefined): ToolpathMove[] => {
    const moves: ToolpathMove[] = []
    cutOffsetRegionRecursive(
      moves, region, -1, 5, stepover, 200, null, 'conventional', undefined, 'inner-first',
      smoothRadius, undefined, undefined, undefined, undefined, toolRadius,
    )
    return moves
  }
  console.log('\n=== shape sensitivity (tool d6, stepover 2, radius 2) ===')
  for (const shape of cases) {
    const rounded = livingCuts(emit(shape.region, Math.min(toolRadius, stepover)))
    const sharp = livingCuts(emit(shape.region, undefined))
    const length = rounded.reduce((sum, move) => sum + moveLength(move), 0)
    console.log(`${shape.name.padEnd(28)} cuts ${String(rounded.length).padStart(5)}`
      + ` (unsmoothed ${String(sharp.length).padStart(5)})  length ${length.toFixed(1).padStart(8)}`)
  }
}

const first = process.argv[2]
if (first === 'shapes') {
  shapes()
} else if (first) {
  let overrides: Partial<Operation> = {}
  if (process.argv[3]) overrides = JSON.parse(process.argv[3]) as Partial<Operation>
  report(first, overrides)
} else {
  console.log('usage: npx tsx scripts/issue-546-corner-probe.ts <file.camj> [\'{"cleanWallCorners":true}\']')
  console.log('       npx tsx scripts/issue-546-corner-probe.ts shapes')
}
