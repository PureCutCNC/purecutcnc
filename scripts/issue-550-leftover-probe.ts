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
 * Leftover probe for issue #550: does a pocket finish pass clear the stock the
 * roughing pass left, especially at sharp corners?
 *
 * The claim under test is geometric, so the measurement is geometric rather
 * than raster: everything is a Clipper boolean at 1e6 counts per project unit.
 *
 *   nominal R      the resolved pocket region of the *finish* operation, which
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
 * Each leftover island is reported with its area and its largest inscribed
 * radius (found by bisection on erosion), plus the nearest boundary vertex and
 * that vertex's interior angle, which is what ties a leftover to a sharp
 * corner rather than to a wall.
 *
 * Usage:
 *   npx tsx scripts/issue-550-leftover-probe.ts <file.camj> [roughOpId] [finishOpId]
 *
 * With no operation ids it pairs the first enabled `pass: 'rough'` pocket with
 * the first enabled `pass: 'finish'` pocket over the same target.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import ClipperLib from 'clipper-lib'

import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import { generatePocketToolpath } from '../src/engine/toolpaths/pocket'
import { resolvePocketRegions } from '../src/engine/toolpaths/resolver'
import type { ResolvedPocketRegion, ToolpathMove } from '../src/engine/toolpaths/types'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import type { Operation, Point, Project } from '../src/types/project'

const SCALE = 1e6
const ARC_TOLERANCE = 0.25 // scaled units, i.e. 0.25e-6 project units

type Path = Array<{ X: number; Y: number }>

const toPath = (points: Point[]): Path =>
  points.map((point) => ({ X: Math.round(point.x * SCALE), Y: Math.round(point.y * SCALE) }))

/** Outers counter-clockwise, holes clockwise, so non-zero filling sees a hole. */
function oriented(points: Point[], counterClockwise: boolean): Path {
  const path = toPath(points)
  const positive = ClipperLib.Clipper.Area(path) >= 0
  return positive === counterClockwise ? path : path.slice().reverse()
}

const fromPath = (path: Path): Point[] =>
  path.map((point) => ({ x: point.X / SCALE, y: point.Y / SCALE }))

function clip(subject: Path[], clipPaths: Path[], op: number): Path[] {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true)
  if (clipPaths.length > 0) clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  const solution: Path[] = []
  clipper.Execute(op, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return solution
}

const union = (paths: Path[]): Path[] => clip(paths, [], ClipperLib.ClipType.ctUnion)
const difference = (a: Path[], b: Path[]): Path[] =>
  b.length === 0 ? union(a) : clip(a, b, ClipperLib.ClipType.ctDifference)

function offsetClosed(paths: Path[], delta: number): Path[] {
  if (paths.length === 0) return []
  const offsetter = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE)
  offsetter.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const solution: Path[] = []
  offsetter.Execute(solution, delta)
  return solution
}

/** Swept envelope of a run of cut moves: the centreline grown by the radius. */
function offsetOpen(lines: Path[], radius: number): Path[] {
  if (lines.length === 0) return []
  const offsetter = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE)
  offsetter.AddPaths(lines, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound)
  const solution: Path[] = []
  offsetter.Execute(solution, radius)
  return union(solution)
}

const area = (paths: Path[]): number =>
  paths.reduce((sum, path) => sum + ClipperLib.Clipper.Area(path), 0) / (SCALE * SCALE)

/** Largest disc that fits inside the shape, by bisection on the erosion. */
function inscribedRadius(paths: Path[], limit: number): number {
  let low = 0
  let high = limit
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2
    if (offsetClosed(paths, -mid * SCALE).length > 0) low = mid
    else high = mid
  }
  return low
}

function centroid(path: Path): Point {
  let x = 0
  let y = 0
  for (const point of path) {
    x += point.X
    y += point.Y
  }
  return { x: x / path.length / SCALE, y: y / path.length / SCALE }
}

interface Vertex {
  point: Point
  /** Interior angle of the material at this vertex, in degrees. */
  angle: number
  loop: string
}

/** Boundary vertices of the region with the interior angle of the metal. */
function regionVertices(region: ResolvedPocketRegion, label: string): Vertex[] {
  const vertices: Vertex[] = []
  const collect = (loop: Point[], name: string, isIsland: boolean): void => {
    const signedArea = ClipperLib.Clipper.Area(toPath(loop))
    for (let index = 0; index < loop.length; index += 1) {
      const previous = loop[(index - 1 + loop.length) % loop.length]
      const current = loop[index]
      const next = loop[(index + 1) % loop.length]
      const inX = current.x - previous.x
      const inY = current.y - previous.y
      const outX = next.x - current.x
      const outY = next.y - current.y
      if (Math.hypot(inX, inY) < 1e-9 || Math.hypot(outX, outY) < 1e-9) continue
      const cross = inX * outY - inY * outX
      const dot = inX * outX + inY * outY
      // Turn is positive for a left turn; the material sits on the left of the
      // travel direction when the loop is counter-clockwise.
      const turn = Math.atan2(cross, dot)
      const orientation = signedArea >= 0 ? 1 : -1
      const enclosed = 180 - (orientation * turn * 180) / Math.PI
      // On an island the metal is on the other side of the loop, so the angle
      // the cutter has to enter is the explement of the loop's own corner.
      vertices.push({ point: current, angle: isIsland ? 360 - enclosed : enclosed, loop: name })
    }
  }
  collect(region.outer, `${label}:outer`, false)
  region.islands.forEach((island, index) => collect(island, `${label}:island${index}`, true))
  return vertices
}

function nearestVertex(point: Point, vertices: Vertex[]): { vertex: Vertex; distance: number } | null {
  let best: { vertex: Vertex; distance: number } | null = null
  for (const vertex of vertices) {
    const distance = Math.hypot(vertex.point.x - point.x, vertex.point.y - point.y)
    if (!best || distance < best.distance) best = { vertex, distance }
  }
  return best
}

const cutMoves = (moves: ToolpathMove[]): ToolpathMove[] =>
  moves.filter((move) => move.kind === 'cut'
    && Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) > 1e-9)

/** Consecutive cuts that meet end-to-end become one polyline. */
function polylines(moves: ToolpathMove[]): Path[] {
  const lines: Path[] = []
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

function levels(moves: ToolpathMove[]): string {
  const counts = new Map<number, number>()
  for (const move of cutMoves(moves)) {
    const z = Math.round(Math.min(move.to.z, move.from.z) * 1e6) / 1e6
    counts.set(z, (counts.get(z) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([z, count]) => `${z.toFixed(4)}x${count}`)
    .join(' ')
}

function movesAtOrBelow(moves: ToolpathMove[], z: number): ToolpathMove[] {
  return cutMoves(moves).filter((move) => move.to.z <= z + 1e-9 && move.from.z <= z + 1e-9)
}

/**
 * Anything thinner than this is Clipper's own arc/rounding residue, not stock:
 * the offsets are built to 0.25e-6 units and the emitted path is tessellated,
 * so hairlines a few counts wide appear along every swept edge.
 */
const NOISE_RADIUS = 2e-4

function describe(name: string, leftovers: Path[], vertices: Vertex[], toolRadius: number): void {
  const outers = leftovers.filter((path) => ClipperLib.Clipper.Area(path) > 0)
  const total = area(leftovers)
  if (outers.length === 0 || total <= 0) {
    console.log(`    ${name}: clear`)
    return
  }
  const ranked = outers
    .map((path) => {
      const holes = leftovers.filter((candidate) => ClipperLib.Clipper.Area(candidate) < 0
        && ClipperLib.Clipper.PointInPolygon(candidate[0], path) !== 0)
      const piece = [path, ...holes]
      return {
        piece,
        area: area(piece),
        radius: inscribedRadius(piece, toolRadius * 4),
        at: centroid(path),
      }
    })
    .sort((a, b) => b.radius - a.radius)
  const real = ranked.filter((island) => island.radius > NOISE_RADIUS)
  if (real.length === 0) {
    console.log(`    ${name}: clear`
      + ` (${outers.length} hairline residue island(s) under r${NOISE_RADIUS}, area ${total.toFixed(6)})`)
    return
  }
  console.log(`    ${name}: ${real.length} island(s) over r${NOISE_RADIUS}`
    + ` of ${outers.length}, area ${real.reduce((sum, island) => sum + island.area, 0).toFixed(6)}`
    + ` (all ${total.toFixed(6)})`)
  for (const island of real.slice(0, 8)) {
    const near = nearestVertex(island.at, vertices)
    const where = near
      ? `near ${near.vertex.loop} vertex (${near.vertex.point.x.toFixed(3)}, ${near.vertex.point.y.toFixed(3)})`
        + ` interior ${near.vertex.angle.toFixed(0)}deg at ${near.distance.toFixed(4)}`
      : 'no vertex'
    console.log(`      r=${island.radius.toFixed(5)} area=${island.area.toFixed(6)}`
      + ` at (${island.at.x.toFixed(3)}, ${island.at.y.toFixed(3)})  ${where}`)
  }
  if (real.length > 8) console.log(`      ... ${real.length - 8} more`)
}

/** A plain plan view: the pocket, the cuts that reach it, and what is left. */
function writeSvg(
  path: string,
  nominal: Path[],
  finishLines: Path[],
  roughLines: Path[],
  leftovers: Path[],
  finishRadius: number,
): void {
  const all = nominal.flat()
  const minX = Math.min(...all.map((point) => point.X)) / SCALE
  const maxX = Math.max(...all.map((point) => point.X)) / SCALE
  const minY = Math.min(...all.map((point) => point.Y)) / SCALE
  const maxY = Math.max(...all.map((point) => point.Y)) / SCALE
  const pad = 0.15
  const width = maxX - minX + pad * 2
  const height = maxY - minY + pad * 2
  const px = 1400 / width
  const draw = (paths: Path[], closed: boolean): string => paths
    .map((each) => fromPath(each)
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(4)} ${(-point.y).toFixed(4)}`)
      .join(' ') + (closed ? ' Z' : ''))
    .join(' ')
  const stroke = (value: number): string => (value / px).toFixed(5)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${(width * px).toFixed(0)}"`
    + ` height="${(height * px).toFixed(0)}"`
    + ` viewBox="${(minX - pad).toFixed(4)} ${(-maxY - pad).toFixed(4)} ${width.toFixed(4)} ${height.toFixed(4)}">`
    + '<rect x="-1000" y="-1000" width="2000" height="2000" fill="#12151a"/>'
    + `<path d="${draw(nominal, true)}" fill="#232a33" stroke="#7d8b9c"`
    + ` stroke-width="${stroke(1.2)}" fill-rule="evenodd"/>`
    + `<path d="${draw(roughLines, false)}" fill="none" stroke="#3f5a7a" stroke-width="${stroke(1)}"/>`
    + `<path d="${draw(finishLines, false)}" fill="none" stroke="#4fd6a0" stroke-width="${stroke(1)}"/>`
    + `<path d="${draw(leftovers, true)}" fill="#ff4d4d" fill-rule="evenodd" stroke="#ff8080"`
    + ` stroke-width="${stroke(1.2)}"/>`
    + `<text x="${(minX).toFixed(3)}" y="${(-maxY - 0.03).toFixed(3)}" fill="#c9d3de"`
    + ` font-family="monospace" font-size="${(11 / px).toFixed(4)}">`
    + `green = finish cuts (r${finishRadius}), blue = rough cuts, red = stock left inside the reachable set`
    + '</text></svg>'
  writeFileSync(path, svg)
  console.log(`    wrote ${path}`)
}

function report(
  file: string,
  roughId: string | undefined,
  finishId: string | undefined,
  svgPath?: string,
  finishOverrides: Partial<Operation> = {},
): void {
  const project = normalizeProject(JSON.parse(readFileSync(file, 'utf8')) as Project)
  const pockets = project.operations.filter((operation) =>
    operation.kind === 'pocket' && operation.enabled !== false)
  const pick = (id: string | undefined, pass: string): Operation | undefined =>
    id ? pockets.find((operation) => operation.id === id) : pockets.find((operation) => operation.pass === pass)
  const rough = pick(roughId, 'rough')
  const base = pick(finishId, 'finish')
  const finish = base ? { ...base, ...finishOverrides } : undefined
  if (Object.keys(finishOverrides).length > 0) {
    console.log(`finish overrides ${JSON.stringify(finishOverrides)}`)
  }
  if (!finish) {
    console.log('no finish pocket operation found')
    return
  }

  const toolOf = (operation: Operation): number => {
    const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
    if (!tool) throw new Error(`operation ${operation.id} has no tool`)
    return normalizeToolForProject(tool, project).diameter / 2
  }
  const finishRadius = toolOf(finish)
  const roughRadius = rough ? toolOf(rough) : 0

  console.log(`\n=== ${file} ===`)
  console.log(`units ${project.meta.units}`)
  if (rough) {
    console.log(`rough  ${rough.id} "${rough.name}" tool r${roughRadius}`
      + ` stock ${rough.stockToLeaveRadial}/${rough.stockToLeaveAxial}`
      + ` stepdown ${rough.stepdown} round=${rough.roundOutsideCorners} cleanWalls=${rough.cleanWallCorners ?? false}`)
  }
  console.log(`finish ${finish.id} "${finish.name}" tool r${finishRadius}`
    + ` stock ${finish.stockToLeaveRadial}/${finish.stockToLeaveAxial}`
    + ` stepdown ${finish.stepdown} round=${finish.roundOutsideCorners} cleanWalls=${finish.cleanWallCorners ?? false}`)

  const resolved = resolvePocketRegions(project, finish)
  const roughMoves = rough ? generatePocketToolpath(project, rough).moves : []
  const finishMoves = generatePocketToolpath(project, finish).moves
  console.log(`cuts   rough ${cutMoves(roughMoves).length}  finish ${cutMoves(finishMoves).length}`)
  console.log(`finish Z levels ${levels(finishMoves)}`)
  console.log(`rough  Z levels ${levels(roughMoves)}`)

  for (const band of resolved.bands) {
    for (const [index, region] of band.regions.entries()) {
      const label = `band ${band.topZ.toFixed(3)}..${band.bottomZ.toFixed(3)} region ${index}`
      const nominal = union([
        oriented(region.outer, true),
        ...region.islands.map((island) => oriented(island, false)),
      ])
      const centres = offsetClosed(nominal, -finishRadius * SCALE)
      const reachable = offsetClosed(centres, finishRadius * SCALE)
      const vertices = regionVertices(region, `r${index}`)
      const sharp = vertices.filter((vertex) => vertex.angle < 100)
      console.log(`\n  ${label}`)
      console.log(`    nominal area ${area(nominal).toFixed(6)},`
        + ` reachable ${area(reachable).toFixed(6)},`
        + ` unreachable by r${finishRadius} ${(area(nominal) - area(reachable)).toFixed(6)}`)
      console.log(`    boundary vertices ${vertices.length}, under 100deg interior ${sharp.length}`
        + (sharp.length > 0
          ? ` [${[...new Set(sharp.map((vertex) => vertex.angle.toFixed(0)))].join(' ')}]`
          : ''))

      const deepest = Math.min(...cutMoves(finishMoves).map((move) => move.to.z))
      const finishFloor = offsetOpen(polylines(movesAtOrBelow(finishMoves, deepest + 1e-9)), finishRadius * SCALE)
      const finishAll = offsetOpen(polylines(cutMoves(finishMoves)), finishRadius * SCALE)
      const roughAll = offsetOpen(polylines(cutMoves(roughMoves)), roughRadius * SCALE)

      describe('leftover at the finish floor (finish deepest pass only)',
        difference(reachable, finishFloor), vertices, finishRadius)
      describe('leftover vs every finish cut at any Z',
        difference(reachable, finishAll), vertices, finishRadius)
      describe('leftover vs rough + finish, any Z',
        difference(reachable, union([...finishAll, ...roughAll])), vertices, finishRadius)
      describe('stock the rough pass alone leaves inside the reachable set',
        difference(reachable, roughAll), vertices, finishRadius)

      if (svgPath) {
        writeSvg(
          svgPath,
          nominal,
          polylines(movesAtOrBelow(finishMoves, deepest + 1e-9)),
          polylines(cutMoves(roughMoves)),
          difference(reachable, finishFloor),
          finishRadius,
        )
      }
    }
  }
}

const file = process.argv[2]
if (!file) {
  console.log('usage: npx tsx scripts/issue-550-leftover-probe.ts <file.camj>'
    + ' [roughOpId] [finishOpId] [out.svg] [\'{"roundOutsideCorners":false}\']')
} else {
  report(
    file,
    process.argv[3] || undefined,
    process.argv[4] || undefined,
    process.argv[5] || undefined,
    process.argv[6] ? (JSON.parse(process.argv[6]) as Partial<Operation>) : {},
  )
}
