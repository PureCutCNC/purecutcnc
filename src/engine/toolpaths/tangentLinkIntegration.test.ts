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
 * Integration tests for tangential ring-to-ring link junctions (issue #545).
 * Run with: npx tsx src/engine/toolpaths/tangentLinkIntegration.test.ts
 */

import { readFileSync } from 'node:fs'

import ClipperLib from 'clipper-lib'
import { generateEdgeRouteToolpath, generateVCarveToolpath } from './index'
import { generatePocketToolpath as generatePocket, buildInsetRegions, buildOffsetRegionTree, type OffsetRegionNode } from './pocket'
import { applyContourDirection, normalizeToolForProject } from './geometry'
import { cornerSmoothingRadius, roundContourCorners } from './offsetSmoothing'
import { pocketTangentLinkOptions, tangentSLink, type TangentLinkOptions } from './tangentLink'
import { resolvePocketRegions } from './resolver'
import { normalizeProject } from '../../store/helpers/projectFormat'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  circleProfile,
  defaultTool,
  newProject,
  rectProfile,
  type Operation,
  type Point,
  type Project,
  type SketchFeature,
  type Tool,
} from '../../types/project'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

function makeFlatEndmill(id: string, diameter = 6): Tool {
  return { ...defaultTool('mm', 1), id, name: id, diameter, defaultStepdown: 2, defaultStepover: 0.4 }
}

function makeRect(id: string, x: number, y: number, w: number, h: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(x, y, w, h), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -4,
    visible: true,
    locked: false,
  }
}

function makeCircleIsland(id: string, cx: number, cy: number, radius: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProfile(cx, cy, radius), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'add',
    z_top: 0,
    z_bottom: -4,
    visible: true,
    locked: false,
  }
}

function baseProject(tools: Tool[], features: SketchFeature[]): Project {
  return projectWithFeatures({ ...newProject('test', 'mm'), tools }, features)
}

function makePocketOp(overrides: Partial<Operation> & Pick<Operation, 'kind' | 'target' | 'toolRef'>): Operation {
  const base: Operation = {
    id: 'op1',
    name: 'op',
    kind: overrides.kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: overrides.target,
    toolRef: overrides.toolRef,
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
  return { ...base, ...overrides }
}

function squarePocket(opOverrides: Partial<Operation> = {}): { project: Project; operation: Operation } {
  const tool = makeFlatEndmill('t1', 6)
  const pocket = makeRect('p1', 0, 0, 60, 60)
  const project = baseProject([tool], [pocket])
  const operation = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    finishWalls: false,
    finishFloor: false,
    ...opOverrides,
  })
  return { project, operation }
}

function circlePocket(opOverrides: Partial<Operation> = {}): { project: Project; operation: Operation } {
  const tool = makeFlatEndmill('t1', 6)
  const pocket: SketchFeature = {
    id: 'p1',
    name: 'p1',
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProfile(30, 30, 24), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -4,
    visible: true,
    locked: false,
  }
  const project = baseProject([tool], [pocket])
  const operation = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    finishWalls: false,
    finishFloor: false,
    ...opOverrides,
  })
  return { project, operation }
}

function neckPocket(opOverrides: Partial<Operation> = {}): { project: Project; operation: Operation } {
  const tool = makeFlatEndmill('t1', 6)
  const features = [
    makeRect('a', 0, 0, 20, 20),
    makeRect('b', 26, 0, 20, 20),
    makeRect('neck', 20, 7, 6, 6),
  ]
  const project = baseProject([tool], features)
  const operation = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a', 'b', 'neck'] },
    toolRef: 't1',
    finishWalls: false,
    finishFloor: false,
    ...opOverrides,
  })
  return { project, operation }
}

// ── Junction classification ─────────────────────────────────────────────

type Poly = number[]

function pointOnPolys(x: number, y: number, polys: Poly[]): boolean {
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i += 2) {
      const next = (i + 2) % poly.length
      const ax = poly[i]
      const ay = poly[i + 1]
      const bx = poly[next]
      const by = poly[next + 1]
      const dx = bx - ax
      const dy = by - ay
      const lenSq = dx * dx + dy * dy
      if (lenSq <= 1e-18) continue
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq))
      const qx = ax + dx * t - x
      const qy = ay + dy * t - y
      if (qx * qx + qy * qy <= 1e-12) return true
    }
  }
  return false
}

function pointInPoly(x: number, y: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x
    const yi = polygon[i].y
    const xj = polygon[j].x
    const yj = polygon[j].y
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Ring polylines built with the same construction generation uses. */
function ringPolylines(project: Project, operation: Operation): Poly[] {
  const polys: Poly[] = []
  const toolRecord = project.tools.find((tool) => tool.id === operation.toolRef)
  if (!toolRecord) return polys
  const tool = normalizeToolForProject(toolRecord, project)
  const toolRadius = tool.diameter / 2
  const stepoverDistance = tool.diameter * operation.stepover
  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const direction = operation.cutDirection ?? 'conventional'
  const islandJoinType = operation.roundOutsideCorners ? ClipperLib.JoinType.jtRound : ClipperLib.JoinType.jtMiter
  const smoothRadius = cornerSmoothingRadius(operation.roundOutsideCorners, toolRadius, stepoverDistance)
  const resolved = resolvePocketRegions(project, operation)
  const visit = (node: OffsetRegionNode, depth: number): void => {
    const outer = node.region.outer.length >= 3 ? node.region.outer : null
    const smoothedOuter = outer
      ? (smoothRadius !== undefined && depth > 0 ? roundContourCorners(outer, smoothRadius) : outer)
      : null
    const contours: Point[][] = []
    if (smoothedOuter) contours.push(smoothedOuter)
    for (const island of node.region.islands) {
      if (island.length >= 3) contours.push(island)
    }
    for (const contour of applyContourDirection(contours, direction)) {
      const poly: number[] = []
      for (const p of contour) poly.push(p.x, p.y)
      polys.push(poly)
    }
    for (const child of node.children) visit(child, depth + 1)
  }
  for (const band of resolved.bands) {
    for (const region of band.regions) {
      const trees = buildInsetRegions(region, toolRadius + radialLeave, ClipperLib.JoinType.jtMiter, islandJoinType)
        .map((tree) => buildOffsetRegionTree(tree, stepoverDistance, islandJoinType))
      for (const tree of trees) visit(tree, 0)
    }
  }
  return polys
}

interface JunctionCensus {
  exitSharp: number
  entrySharp: number
  cornerSharp: number
}

/** Count cut-to-cut junctions with turn ≥ thresholdDeg, bucketed by class. */
function junctionCensus(moves: ToolpathMove[], polys: Poly[], thresholdDeg = 60): JunctionCensus {
  const cuts = moves.filter((move) => move.kind === 'cut')
  const cls = cuts.map((move) =>
    pointOnPolys((move.from.x + move.to.x) / 2, (move.from.y + move.to.y) / 2, polys) ? 'ring' as const : 'link' as const,
  )
  let exitSharp = 0
  let entrySharp = 0
  let cornerSharp = 0
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const a = cuts[index]
    const b = cuts[index + 1]
    if (!approx(a.to.x, b.from.x) || !approx(a.to.y, b.from.y)) continue
    const inX = a.to.x - a.from.x
    const inY = a.to.y - a.from.y
    const outX = b.to.x - b.from.x
    const outY = b.to.y - b.from.y
    const inLen = Math.hypot(inX, inY)
    const outLen = Math.hypot(outX, outY)
    if (inLen < 1e-9 || outLen < 1e-9) continue
    const cos = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLen * outLen)))
    const turn = (Math.acos(cos) * 180) / Math.PI
    if (turn < thresholdDeg) continue
    if (cls[index] === 'ring' && cls[index + 1] === 'link') exitSharp += 1
    else if (cls[index] === 'link' && cls[index + 1] === 'ring') entrySharp += 1
    else if (cls[index] === 'ring' && cls[index + 1] === 'ring') cornerSharp += 1
  }
  return { exitSharp, entrySharp, cornerSharp }
}

function movesEqual(a: ToolpathMove[], b: ToolpathMove[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ── Tests ────────────────────────────────────────────────────────────────

/** Production gate options, built with the same construction the generator
 *  uses (band regions inset to the tool-centre wall path). */
function productionGateOptions(project: Project, operation: Operation): TangentLinkOptions | undefined {
  const toolRecord = project.tools.find((tool) => tool.id === operation.toolRef)
  if (!toolRecord) return undefined
  const tool = normalizeToolForProject(toolRecord, project)
  const toolRadius = tool.diameter / 2
  const stepoverDistance = tool.diameter * operation.stepover
  const resolved = resolvePocketRegions(project, operation)
  const regionTrees = resolved.bands
    .flatMap((band) => band.regions.flatMap((region) => buildInsetRegions(region, toolRadius)))
    .map((region) => buildOffsetRegionTree(region, stepoverDistance))
  return pocketTangentLinkOptions(true, tool.diameter, regionTrees.map((tree) => tree.region))
}

/** Ring vertices of the arrival ring in travel order. */
function ringVerticesOf(poly: Poly): Point[] {
  const points: Point[] = []
  for (let index = 0; index + 1 < poly.length; index += 2) {
    points.push({ x: poly[index], y: poly[index + 1] })
  }
  return points
}

/** Every remaining sharp link junction in an enabled stream must be one the
 *  production gate legitimately rejected: re-running the S solver without the
 *  domain check must either also reject it (geometry/budget limited) or the
 *  domain check must be what rejected it. */
function assertSharpLinkJunctionsAreGateRejections(
  moves: ToolpathMove[],
  polys: Poly[],
  options: TangentLinkOptions,
): void {
  const cuts = moves.filter((move) => move.kind === 'cut')
  const cls = cuts.map((move) =>
    pointOnPolys((move.from.x + move.to.x) / 2, (move.from.y + move.to.y) / 2, polys) ? 'ring' as const : 'link' as const,
  )
  let sharpLinks = 0
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const a = cuts[index]
    const b = cuts[index + 1]
    if (!approx(a.to.x, b.from.x) || !approx(a.to.y, b.from.y)) continue
    const inLen = Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y)
    const outLen = Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y)
    if (inLen < 1e-9 || outLen < 1e-9) continue
    const cos = Math.max(-1, Math.min(1, ((a.to.x - a.from.x) * (b.to.x - b.from.x) + (a.to.y - a.from.y) * (b.to.y - b.from.y)) / (inLen * outLen)))
    if (Math.acos(cos) * 180 / Math.PI < 60) continue
    const linkSide = (cls[index] === 'ring' && cls[index + 1] === 'link')
      || (cls[index] === 'link' && cls[index + 1] === 'ring')
    if (!linkSide) continue
    sharpLinks += 1
    // Rebuild the production call: exit = the link run's start, t0 = the
    // preceding ring cut's direction, arrival ring = the ring polyline the
    // following ring cut lies on. Find the link run bounds first.
    let runStart = index
    let runEnd = index
    while (runStart > 0 && cls[runStart - 1] === 'link'
      && Math.hypot(cuts[runStart].from.x - cuts[runStart - 1].to.x, cuts[runStart].from.y - cuts[runStart - 1].to.y) < 1e-6) runStart -= 1
    while (runEnd + 1 < cuts.length && cls[runEnd + 1] === 'link'
      && Math.hypot(cuts[runEnd].to.x - cuts[runEnd + 1].from.x, cuts[runEnd].to.y - cuts[runEnd + 1].from.y) < 1e-6) runEnd += 1
    const exit = cuts[runStart].from
    const prevCut = runStart > 0 && cls[runStart - 1] === 'ring'
      && Math.hypot(cuts[runStart - 1].to.x - exit.x, cuts[runStart - 1].to.y - exit.y) < 1e-6 ? cuts[runStart - 1] : null
    const nextCut = runEnd + 1 < cuts.length && cls[runEnd + 1] === 'ring'
      && Math.hypot(cuts[runEnd].to.x - cuts[runEnd + 1].from.x, cuts[runEnd].to.y - cuts[runEnd + 1].from.y) < 1e-6 ? cuts[runEnd + 1] : null
    const arrivalPoly = nextCut !== null
      ? polys.find((poly) => pointOnPolys((nextCut.from.x + nextCut.to.x) / 2, (nextCut.from.y + nextCut.to.y) / 2, [poly]))
      : undefined
    if (prevCut === null || arrivalPoly === undefined) continue
    const t0 = { x: (exit.x - prevCut.from.x) / Math.hypot(exit.x - prevCut.from.x, exit.y - prevCut.from.y), y: (exit.y - prevCut.from.y) / Math.hypot(exit.x - prevCut.from.x, exit.y - prevCut.from.y) }
    const gateCall = (domain: (x: number, y: number) => boolean) =>
      tangentSLink(exit, t0, ringVerticesOf(arrivalPoly), { ...options, isInsideDomain: domain })
    const unconstrained = gateCall(() => true)
    const gated = gateCall(options.isInsideDomain)
    const gateRejected = unconstrained !== null && gated === null
    const geometryRejected = unconstrained === null
    assert(gateRejected || geometryRejected,
      'sharp link junction at (' + exit.x.toFixed(2) + ', ' + exit.y.toFixed(2) + ') would admit an S but the emitted stream left it sharp')
  }
  assert(sharpLinks > 0, 'fixture must contain sharp link junctions to make this assertion meaningful')
}

function testSharpLinkJunctionsDisappear() {
  console.log('Testing sharp link junctions disappear when enabled...')
  // Concentric circle rings make canonical radial links: the seam sits on the
  // ring tangent and the link runs radially, so both junctions turn ~90
  // degrees. (The square pocket degenerates into 45-degree corner-to-corner
  // diagonals, which is the wrong fixture for this assertion.)
  const { project, operation } = circlePocket()
  const off = generatePocket(project, operation).moves
  const on = generatePocket(project, { ...operation, roundLinkCorners: true }).moves
  const polys = ringPolylines(project, operation)

  const offCensus = junctionCensus(off, polys)
  const onCensus = junctionCensus(on, polys)

  // 8 rings x 2 levels: 7 ring-to-ring links per level.
  assert(offCensus.exitSharp >= 8, 'legacy output has sharp exit junctions, got ' + offCensus.exitSharp)
  assert(offCensus.entrySharp >= 8, 'legacy output has sharp entry junctions, got ' + offCensus.entrySharp)
  assert(onCensus.exitSharp + onCensus.entrySharp < offCensus.exitSharp + offCensus.entrySharp,
    'enabled output must reduce sharp link junctions')
  // Every remaining sharp link junction must be one the production gate
  // legitimately rejected (segment/geometry limited, or domain-limited at the
  // wall-adjacent ring). The dense circle tessellation and the wall-adjacent
  // exits supply both rejection classes on this fixture.
  const gateOptions = productionGateOptions(project, operation)
  assert(gateOptions !== undefined, 'gate options resolve')
  assertSharpLinkJunctionsAreGateRejections(on, polys, gateOptions as TangentLinkOptions)
  // Ring corners are untouched by the link feature.
  assert(onCensus.cornerSharp === offCensus.cornerSharp, 'ring corner junction count unchanged')
  console.log('sharp link junctions: PASSED (off ' + offCensus.exitSharp + '/' + offCensus.entrySharp
    + ', on ' + onCensus.exitSharp + '/' + onCensus.entrySharp + ', corners ' + onCensus.cornerSharp + ')')
}


/** Maximal contiguous cut runs sharing a feed scale (what arc fitting joins). */
function arcRunCount(moves: ToolpathMove[]): number {
  const cuts = moves.filter((move) => move.kind === 'cut')
  let count = 0
  let current = 0
  let previousScale: number | null | undefined
  let previousTo: { x: number; y: number; z: number } | null = null
  for (const move of cuts) {
    const contiguous = previousTo !== null
      && Math.hypot(move.from.x - previousTo.x, move.from.y - previousTo.y, move.from.z - previousTo.z) < 1e-6
    if (current > 0 && contiguous && (move.feedScale ?? 1) === previousScale) {
      current += 1
    } else {
      if (current > 0) count += 1
      current = 1
    }
    previousScale = move.feedScale ?? 1
    previousTo = move.to
  }
  if (current > 0) count += 1
  return count
}

function testArcRunBudgetOnRealFixture() {
  console.log('Testing the filleted stream keeps arc-run fragmentation bounded...')
  // Each fillet adds a tessellated run but consumes whole ring chords, so the
  // run count may move slightly in either direction. Bound the total on the
  // tracked fixture so the feature cannot silently explode G-code
  // fragmentation. Measured on pocket-feed-reduction (engagement mode):
  // legacy 69 runs, enabled 68 runs.
  const raw = JSON.parse(readFileSync('src/engine/test-fixtures/pocket-feed-reduction.camj', 'utf8')) as Project
  const project = normalizeProject(raw)
  const op = project.operations.find((candidate) => candidate.kind === 'pocket')
  assert(op !== undefined, 'fixture has a pocket operation')
  const legacy = arcRunCount(generatePocket(project, { ...op, roundLinkCorners: undefined }).moves)
  const enabled = arcRunCount(generatePocket(project, op).moves)
  assert(Math.abs(enabled - legacy) <= 5, 'run count stays within 5 of legacy (' + legacy + ' -> ' + enabled + ')')
  assert(enabled <= 90, 'filleted run count bounded (measured 68, legacy ' + legacy + '), got ' + enabled)
  console.log('arc-run budget: PASSED (legacy ' + legacy + ', enabled ' + enabled + ')')
}

function testAbsentEqualsFalse() {
  console.log('Testing absent roundLinkCorners reproduces legacy output byte-for-byte...')
  const { project, operation } = squarePocket()
  const absent = generatePocket(project, { ...operation, roundLinkCorners: undefined }).moves
  const disabled = generatePocket(project, { ...operation, roundLinkCorners: false }).moves
  assert(movesEqual(absent, disabled), 'absent vs false must be identical (legacy output unchanged)')
  console.log('absent equals false: PASSED')
}

function testWallAndIslandDomainRespected() {
  console.log('Testing the filleted links never leave the tool-centre domain...')
  const tool = makeFlatEndmill('t1', 6)
  const pocket = makeRect('p1', 0, 0, 60, 60)
  const island = makeCircleIsland('i1', 30, 30, 8)
  const project = baseProject([tool], [pocket, island])
  const operation = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1', 'i1'] },
    toolRef: 't1',
    finishWalls: false,
    finishFloor: false,
    roundLinkCorners: true,
  })
  const result = generatePocket(project, operation)

  // The cleared domain: band region inset by tool radius (+ leave), islands
  // expanded by the same — exactly what buildInsetRegions produces.
  const resolved = resolvePocketRegions(project, operation)
  const domainRegions = resolved.bands.flatMap((band) =>
    band.regions.flatMap((region) => buildInsetRegions(region, tool.diameter / 2)),
  )
  assert(domainRegions.length > 0, 'domain regions resolved')
  const pointToPoly = (p: Point[]): number[] => {
    const poly: number[] = []
    for (const q of p) poly.push(q.x, q.y)
    return poly
  }
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    for (const endpoint of [move.from, move.to]) {
      // The wall ring is cut exactly on the domain boundary, so points ON the
      // boundary are legitimate — only a crossing counts as a violation.
      const inside = domainRegions.some((region) =>
        pointInPoly(endpoint.x, endpoint.y, region.outer) || pointOnPolys(endpoint.x, endpoint.y, [pointToPoly(region.outer)]),
      ) && !domainRegions.some((region) => region.islands.some((island) =>
        pointInPoly(endpoint.x, endpoint.y, island) && !pointOnPolys(endpoint.x, endpoint.y, [pointToPoly(island)]),
      ))
      assert(inside, 'every cut endpoint stays inside the cleared domain at (' + endpoint.x.toFixed(3) + ', ' + endpoint.y.toFixed(3) + ')')
    }
  }
  console.log('wall/island domain: PASSED')
}

function testSweptCoverageParity() {
  console.log('Testing the filleted path sweeps the same material as the straight one...')
  const { project, operation } = squarePocket()
  const off = generatePocket(project, operation).moves.filter((move) => move.kind === 'cut')
  const on = generatePocket(project, { ...operation, roundLinkCorners: true }).moves.filter((move) => move.kind === 'cut')
  const toolRadius = 3

  const distToSegments = (x: number, y: number, moves: ToolpathMove[]): number => {
    let best = Number.POSITIVE_INFINITY
    for (const move of moves) {
      const dx = move.to.x - move.from.x
      const dy = move.to.y - move.from.y
      const lenSq = dx * dx + dy * dy
      const t = lenSq > 0
        ? Math.max(0, Math.min(1, ((x - move.from.x) * dx + (y - move.from.y) * dy) / lenSq))
        : 0
      const qx = move.from.x + dx * t - x
      const qy = move.from.y + dy * t - y
      const d = Math.sqrt(qx * qx + qy * qy)
      if (d < best) best = d
    }
    return best
  }
  const sampleMoves = (moves: ToolpathMove[], step: number): { x: number; y: number }[] => {
    const samples: { x: number; y: number }[] = []
    for (const move of moves) {
      const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
      const count = Math.max(1, Math.ceil(length / step))
      for (let index = 0; index <= count; index += 1) {
        const t = index / count
        samples.push({
          x: move.from.x + (move.to.x - move.from.x) * t,
          y: move.from.y + (move.to.y - move.from.y) * t,
        })
      }
    }
    return samples
  }

  // No material left behind: everything the legacy path swept is within the
  // tool radius of the filleted path.
  for (const sample of sampleMoves(off, 0.15)) {
    const d = distToSegments(sample.x, sample.y, on)
    assert(d <= toolRadius + 1e-6, 'legacy swept point at (' + sample.x.toFixed(2) + ', ' + sample.y.toFixed(2) + ') is ' + d.toFixed(3) + ' from the filleted path')
  }
  // No new material touched: every filleted path point was already within the
  // tool radius of the legacy path.
  for (const sample of sampleMoves(on, 0.15)) {
    const d = distToSegments(sample.x, sample.y, off)
    assert(d <= toolRadius + 1e-6, 'filleted path point at (' + sample.x.toFixed(2) + ', ' + sample.y.toFixed(2) + ') is ' + d.toFixed(3) + ' from the legacy path')
  }
  console.log('swept coverage parity: PASSED')
}

function testParallelAndOtherOperationsByteIdentical() {
  console.log('Testing parallel pockets and non-pocket operations stay byte-identical...')
  const { project, operation } = squarePocket({ pocketPattern: 'parallel' })
  const off = generatePocket(project, operation).moves
  const on = generatePocket(project, { ...operation, roundLinkCorners: true }).moves
  assert(movesEqual(off, on), 'parallel pattern output must not change when the link option is on')

  const tool = makeFlatEndmill('t1', 6)
  const rect = makeRect('e1', 0, 0, 30, 30)
  const edgeProject = baseProject([tool], [rect])
  const edgeOp = makePocketOp({
    kind: 'edge_route_inside',
    target: { source: 'features', featureIds: ['e1'] },
    toolRef: 't1',
  })
  const edgeOff = generateEdgeRouteToolpath(edgeProject, edgeOp).moves
  const edgeOn = generateEdgeRouteToolpath(edgeProject, { ...edgeOp, roundLinkCorners: true }).moves
  assert(movesEqual(edgeOff, edgeOn), 'edge routes ignore the link option')

  const vcarveOff = generateVCarveToolpath(edgeProject, {
    ...edgeOp,
    kind: 'v_carve',
  }).moves
  const vcarveOn = generateVCarveToolpath(edgeProject, {
    ...edgeOp,
    kind: 'v_carve',
    roundLinkCorners: true,
  }).moves
  assert(movesEqual(vcarveOff, vcarveOn), 'v-carve ignores the link option')
  console.log('parallel and other operations: PASSED')
}

function testEntryHandoffUntouched() {
  console.log('Testing the entry handoff (plunge/helix to the first ring) is untouched...')
  const { project, operation } = squarePocket()
  const off = generatePocket(project, operation).moves
  const on = generatePocket(project, { ...operation, roundLinkCorners: true }).moves
  const firstCutIndex = (moves: ToolpathMove[]): number => moves.findIndex((move) => move.kind === 'cut')
  const offFirst = firstCutIndex(off)
  const onFirst = firstCutIndex(on)
  assert(offFirst === onFirst, 'first cut appears at the same stream position')
  assert(movesEqual(off.slice(0, offFirst + 1), on.slice(0, onFirst + 1)), 'entry moves and the first ring segment are identical')
  console.log('entry handoff: PASSED')
}

function testDeterminism() {
  console.log('Testing determinism...')
  const { project, operation } = squarePocket({ roundLinkCorners: true })
  const a = generatePocket(project, operation).moves
  const b = generatePocket(project, operation).moves
  assert(movesEqual(a, b), 'two runs produce identical moves')
  console.log('determinism: PASSED')
}

function testSlotFeedStillStampsSlots() {
  console.log('Testing slot feed still stamps the slots that remain...')
  // The neck fixture has a genuinely slotting link (the crossing between the
  // two pocket lobes) in both streams. The S keeps the stamping: it only
  // reshapes links inside the cleared domain, and the classifier runs on the
  // emitted moves either way.
  const { project, operation } = neckPocket({ pocketSlotFeedPercent: 40, roundLinkCorners: true })
  const on = generatePocket(project, operation).moves
  const legacy = generatePocket(project, { ...operation, roundLinkCorners: undefined }).moves
  const stamped = (moves: ToolpathMove[]): number =>
    moves.filter((move) => move.kind === 'cut' && move.feedScale !== undefined).length
  assert(stamped(legacy) >= 1, 'legacy fixture slots and stamps, got ' + stamped(legacy))
  assert(stamped(on) >= 1, 'S-enabled stream still stamps the slotting link, got ' + stamped(on))

  const engagement = generatePocket(project, { ...operation, pocketFeedReduction: 'engagement' })
  const totalCutLength = (moves: ToolpathMove[]): number =>
    moves.filter((move) => move.kind === 'cut')
      .reduce((sum, move) => sum + Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y), 0)
  assert(engagement.moves.length > 0, 'engagement mode generates with S-links')
  assert(approx(totalCutLength(engagement.moves), totalCutLength(on), 1e-6),
    'engagement mode preserves the S path length (splits moves, never reshapes)')
  console.log('slot feed still stamps slots: PASSED (legacy ' + stamped(legacy) + ', enabled ' + stamped(on) + ')')
}

function testComposesWithRoundOutsideCorners() {
  console.log('Testing composition with roundOutsideCorners...')
  // The circle supplies 90-degree radial links on tessellated (5-degree
  // chord) rings — exactly the composition the run-length splice exists for.
  // The square degenerates to 45-degree diagonal links, all below the
  // min-radius floor by design, so it cannot serve as this fixture.
  const { project, operation } = circlePocket({ roundOutsideCorners: true, roundLinkCorners: true })
  const on = generatePocket(project, operation)
  const linkOnly = generatePocket(project, { ...operation, roundLinkCorners: false })
  assert(on.warnings.length === 0 && linkOnly.warnings.length === 0, 'no warnings in either configuration')
  const polys = ringPolylines(project, operation)
  const onCensus = junctionCensus(on.moves, polys)
  const linkOnlyCensus = junctionCensus(linkOnly.moves, polys)
  assert(onCensus.exitSharp + onCensus.entrySharp < linkOnlyCensus.exitSharp + linkOnlyCensus.entrySharp,
    'link fillets apply alongside smoothed rings')
  const gateOptions = productionGateOptions(project, operation)
  assert(gateOptions !== undefined, 'gate options resolve')
  assertSharpLinkJunctionsAreGateRejections(on.moves, polys, gateOptions as TangentLinkOptions)
  console.log('composition with roundOutsideCorners: PASSED')
}

function testRealFixtureBackfillPath() {
  console.log('Testing the load-time backfill path on a real fixture...')
  const raw = JSON.parse(readFileSync('src/engine/test-fixtures/pocket-feed-reduction.camj', 'utf8')) as Project
  const normalized = normalizeProject(raw)
  const pocketOps = normalized.operations.filter((op) => op.kind === 'pocket')
  assert(pocketOps.length > 0, 'fixture has pocket operations')
  assert(pocketOps.every((op) => op.roundLinkCorners === true), 'normalisation backfills roundLinkCorners on')

  const results = pocketOps.map((op) => {
    const stripped = { ...op, roundLinkCorners: undefined }
    return {
      legacy: generatePocket(normalized, stripped).moves,
      explicitOff: generatePocket(normalized, { ...op, roundLinkCorners: false }).moves,
      enabled: generatePocket(normalized, op).moves,
    }
  })
  for (const result of results) {
    assert(movesEqual(result.legacy, result.explicitOff), 'absent field generates byte-identical legacy output')
    assert(!movesEqual(result.legacy, result.enabled), 'backfilled-on fixture generates different (filleted) output')
  }
  // The enabled output on the tracked fixture must reduce sharp link junctions.
  const op = pocketOps[0]
  const polys = ringPolylines(normalized, { ...op, roundLinkCorners: undefined })
  const before = junctionCensus(generatePocket(normalized, { ...op, roundLinkCorners: undefined }).moves, polys)
  const after = junctionCensus(generatePocket(normalized, op).moves, polys)
  assert(after.exitSharp + after.entrySharp < before.exitSharp + before.entrySharp, 'real fixture shows fewer sharp link junctions when enabled')
  console.log('real fixture backfill: PASSED (sharp links ' + (before.exitSharp + before.entrySharp) + ' -> ' + (after.exitSharp + after.entrySharp) + ')')
}

try {
  testSharpLinkJunctionsDisappear()
  testAbsentEqualsFalse()
  testWallAndIslandDomainRespected()
  testSweptCoverageParity()
  testParallelAndOtherOperationsByteIdentical()
  testEntryHandoffUntouched()
  testDeterminism()
  testSlotFeedStillStampsSlots()
  testArcRunBudgetOnRealFixture()
  testComposesWithRoundOutsideCorners()
  testRealFixtureBackfillPath()
  console.log('\nAll tangentLinkIntegration tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
