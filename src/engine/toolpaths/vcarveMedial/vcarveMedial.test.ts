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
 * Unit tests for the medial-axis V-carve generator.
 * Run with: npx tsx src/engine/toolpaths/vcarveMedial/vcarveMedial.test.ts
 */

import type { Operation, Point, Project, SketchFeature, Tool } from '../../../types/project'
import { defaultTool, newProject, polygonProfile, rectProfile } from '../../../types/project'
import { getTextFontOptions } from '../../../text'
import { projectWithFeatures } from '../../../test/projectFixtures'
import type { ToolpathMove } from '../types'
import {
  computeMedialAxis,
  emitMedialToolpath,
  generateVCarveMedialToolpath,
  pointInRegionLoops,
  regionConvexCorners,
} from './index'
import type { MedialGraph } from './medialAxis'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

function rectLoop(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

function regularPolygon(cx: number, cy: number, radius: number, sides: number): Point[] {
  return Array.from({ length: sides }, (_, i) => {
    const angle = (2 * Math.PI * i) / sides
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
  })
}

function distanceToLoopSegments(x: number, y: number, loops: Point[][]): number {
  let best = Infinity
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i += 1) {
      const a = loop[i]
      const b = loop[(i + 1) % loop.length]
      const abx = b.x - a.x
      const aby = b.y - a.y
      const lenSq = abx * abx + aby * aby
      const t = lenSq > 1e-18
        ? Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / lenSq))
        : 0
      best = Math.min(best, Math.hypot(x - (a.x + abx * t), y - (a.y + aby * t)))
    }
  }
  return best
}

function componentCount(graph: MedialGraph): number {
  const seen = new Array<boolean>(graph.nodes.length).fill(false)
  let components = 0
  for (let start = 0; start < graph.nodes.length; start += 1) {
    if (seen[start]) continue
    components += 1
    const queue = [start]
    seen[start] = true
    while (queue.length > 0) {
      const node = queue.pop() as number
      for (const neighbor of graph.adjacency[node]) {
        if (!seen[neighbor]) {
          seen[neighbor] = true
          queue.push(neighbor)
        }
      }
    }
  }
  return components
}

function edgeCount(graph: MedialGraph): number {
  return graph.adjacency.reduce((sum, neighbors) => sum + neighbors.length, 0) / 2
}

function zeroClearanceNodesNear(graph: MedialGraph, point: Point, radius: number): number {
  return graph.nodes.filter(
    (node) => node.clearance < 1e-9 && Math.hypot(node.x - point.x, node.y - point.y) <= radius,
  ).length
}

// ---------------------------------------------------------------------------
// Medial axis geometry tests
// ---------------------------------------------------------------------------

function testRectangleSpineAndCorners(): void {
  console.log('Testing 40×10 rectangle: spine, exact clearances, corner tips...')
  const outer = rectLoop(0, 0, 40, 10)
  const graph = computeMedialAxis({ outer, islands: [] }, { resolution: 0.5 })

  assert(graph.nodes.length > 0, 'expected medial nodes for rectangle')
  assert(componentCount(graph) === 1, `expected 1 connected component, got ${componentCount(graph)}`)

  for (const node of graph.nodes) {
    const exact = distanceToLoopSegments(node.x, node.y, [outer])
    assert(
      approx(node.clearance, exact, 1e-6),
      `clearance ${node.clearance} != exact boundary distance ${exact} at (${node.x}, ${node.y})`,
    )
  }

  const spineNode = graph.nodes.find((n) => Math.abs(n.x - 20) < 3 && Math.abs(n.y - 5) < 0.05)
  assert(spineNode !== undefined, 'expected a spine node near (20, 5)')
  assert(approx(spineNode!.clearance, 5, 0.02), `spine clearance ${spineNode!.clearance} != 5`)

  for (const corner of outer) {
    assert(
      zeroClearanceNodesNear(graph, corner, 1e-6) === 1,
      `expected zero-clearance tip exactly at corner (${corner.x}, ${corner.y})`,
    )
  }
  console.log(`rectangle medial axis: ${graph.nodes.length} nodes PASSED`)
}

function testSquareCenterJunction(): void {
  console.log('Testing 20×20 square: diagonals meet at center...')
  const outer = rectLoop(0, 0, 20, 20)
  const graph = computeMedialAxis({ outer, islands: [] }, { resolution: 0.5 })

  const center = graph.nodes.reduce((best, n) => (n.clearance > best.clearance ? n : best))
  assert(Math.hypot(center.x - 10, center.y - 10) < 0.3, `deepest node (${center.x}, ${center.y}) not at center`)
  assert(approx(center.clearance, 10, 0.05), `center clearance ${center.clearance} != 10`)
  assert(componentCount(graph) === 1, 'square medial axis should be connected')
  for (const corner of outer) {
    assert(zeroClearanceNodesNear(graph, corner, 1e-6) === 1, 'square corner tip missing')
  }
  console.log(`square medial axis: ${graph.nodes.length} nodes PASSED`)
}

function testCircleCollapsesToCenter(): void {
  console.log('Testing 64-gon "circle": flattening spokes filtered, axis collapses to center...')
  const outer = regularPolygon(10, 10, 8, 64)
  const graph = computeMedialAxis({ outer, islands: [] }, { resolution: 0.4 })

  assert(graph.nodes.length > 0, 'expected at least one node for circle')
  for (const node of graph.nodes) {
    const offCenter = Math.hypot(node.x - 10, node.y - 10)
    assert(offCenter < 1, `circle node (${node.x}, ${node.y}) is ${offCenter} from center — spoke not filtered`)
    assert(node.clearance > 6, `circle node clearance ${node.clearance} suspiciously small`)
  }
  const apothem = 8 * Math.cos(Math.PI / 64)
  const deepest = Math.max(...graph.nodes.map((n) => n.clearance))
  assert(approx(deepest, apothem, 0.05), `deepest clearance ${deepest} != apothem ${apothem}`)
  console.log(`circle medial axis: ${graph.nodes.length} node(s) PASSED`)
}

function testRingWithIsland(): void {
  console.log('Testing square ring (40 outer, 20 island): loop + outer corner tips only...')
  const outer = rectLoop(0, 0, 40, 40)
  const island = rectLoop(10, 10, 20, 20)
  const loops = [outer, island]
  const graph = computeMedialAxis({ outer, islands: [island] }, { resolution: 0.5 })

  assert(graph.nodes.length > 0, 'expected nodes for ring')
  assert(componentCount(graph) === 1, 'ring medial axis should be connected')
  assert(edgeCount(graph) >= graph.nodes.length, 'ring medial axis should contain a cycle')

  // Straight corridors allow clearance 5; the corner pockets allow a larger
  // disk touching both outer walls and the island corner: 10·(2−√2) ≈ 5.858.
  const cornerPocketMax = 10 * (2 - Math.SQRT2)
  for (const node of graph.nodes) {
    const exact = distanceToLoopSegments(node.x, node.y, loops)
    assert(approx(node.clearance, exact, 1e-6), `ring clearance mismatch at (${node.x}, ${node.y})`)
    assert(node.clearance <= cornerPocketMax + 1e-6, `ring clearance ${node.clearance} exceeds corner-pocket max`)
  }
  const corridorNode = graph.nodes.find((n) => Math.abs(n.x - 20) < 2 && Math.abs(n.y - 5) < 0.05)
  assert(corridorNode !== undefined, 'expected a corridor node near (20, 5)')
  assert(approx(corridorNode!.clearance, 5, 0.02), `corridor clearance ${corridorNode!.clearance} != 5`)

  for (const corner of outer) {
    assert(zeroClearanceNodesNear(graph, corner, 1e-6) === 1, 'outer ring corner tip missing')
  }
  for (const corner of island) {
    assert(
      zeroClearanceNodesNear(graph, corner, 0.5) === 0,
      `unexpected zero-clearance tip at island corner (${corner.x}, ${corner.y})`,
    )
  }

  // Every edge must stay inside the carveable ring material.
  graph.adjacency.forEach((neighbors, i) => {
    for (const j of neighbors) {
      if (j < i) continue
      const mx = (graph.nodes[i].x + graph.nodes[j].x) / 2
      const my = (graph.nodes[i].y + graph.nodes[j].y) / 2
      assert(
        pointInRegionLoops(mx, my, loops),
        `edge midpoint (${mx}, ${my}) escapes the ring region`,
      )
    }
  })
  console.log(`ring medial axis: ${graph.nodes.length} nodes, ${edgeCount(graph)} edges PASSED`)
}

function testLShapeJunctionAndReflexCorner(): void {
  console.log('Testing L-shape: junction degree, reflex corner has no surface tip...')
  const outer: Point[] = [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: 30 },
    { x: 0, y: 30 },
  ]
  const graph = computeMedialAxis({ outer, islands: [] }, { resolution: 0.5 })

  assert(componentCount(graph) === 1, 'L medial axis should be connected')
  const maxDegree = Math.max(...graph.adjacency.map((n) => n.length))
  assert(maxDegree >= 3, `expected a junction (degree>=3), max degree ${maxDegree}`)

  const convex = outer.filter((p) => !(p.x === 10 && p.y === 10))
  for (const corner of convex) {
    assert(zeroClearanceNodesNear(graph, corner, 1e-6) === 1, `L convex corner tip missing at (${corner.x}, ${corner.y})`)
  }
  assert(
    zeroClearanceNodesNear(graph, { x: 10, y: 10 }, 0.5) === 0,
    'reflex corner must not receive a zero-clearance tip',
  )
  console.log(`L-shape medial axis: ${graph.nodes.length} nodes PASSED`)
}

function testRegionConvexCorners(): void {
  console.log('Testing regionConvexCorners classification...')
  const lShape: Point[] = [
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: 30 },
    { x: 0, y: 30 },
  ]
  assert(regionConvexCorners({ outer: lShape, islands: [] }).length === 5, 'L-shape should have 5 convex corners')

  const ring = { outer: rectLoop(0, 0, 40, 40), islands: [rectLoop(10, 10, 20, 20)] }
  assert(regionConvexCorners(ring).length === 4, 'ring should expose only the 4 outer corners')

  const circle = { outer: regularPolygon(0, 0, 8, 64), islands: [] }
  assert(regionConvexCorners(circle).length === 0, '64-gon vertices must not count as corners')

  // Notch cut into the island: the island's concave vertex is a region corner.
  const notchedIsland: Point[] = [
    { x: 10, y: 10 },
    { x: 30, y: 10 },
    { x: 30, y: 30 },
    { x: 21, y: 30 },
    { x: 20, y: 20 },
    { x: 19, y: 30 },
    { x: 10, y: 30 },
  ]
  const notched = { outer: rectLoop(0, 0, 40, 40), islands: [notchedIsland] }
  const notchCorners = regionConvexCorners(notched)
  assert(
    notchCorners.some((c) => approx(c.point.x, 20, 1e-9) && approx(c.point.y, 20, 1e-9)),
    'island notch apex should be a region convex corner',
  )
  console.log('regionConvexCorners PASSED')
}

// ---------------------------------------------------------------------------
// Generator integration tests
// ---------------------------------------------------------------------------

function makeVBit(angle = 60): Tool {
  return { ...defaultTool('mm', 1), id: 't1', type: 'v_bit', vBitAngle: angle, diameter: 6 }
}

function makeRectFeature(id: string, x: number, y: number, w: number, h: number, zBottom: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 0,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makePolygonFeature(id: string, points: Point[], zBottom: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: polygonProfile(points),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 0,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeVCarveMedialOp(featureIds: string[], overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op1',
    name: 'op',
    kind: 'v_carve_medial',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    ...overrides,
  }
}

function baseProject(tools: Tool[], features: SketchFeature[]): Project {
  return projectWithFeatures({ ...newProject('test', 'mm'), tools }, features)
}

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((m) => m.kind === 'cut')
}

function assertContinuity(moves: ToolpathMove[]): void {
  for (let i = 1; i < moves.length; i += 1) {
    const prev = moves[i - 1].to
    const curr = moves[i].from
    assert(
      approx(prev.x, curr.x, 1e-9) && approx(prev.y, curr.y, 1e-9) && approx(prev.z, curr.z, 1e-9),
      `discontinuity between move ${i - 1} and ${i}: (${prev.x},${prev.y},${prev.z}) -> (${curr.x},${curr.y},${curr.z})`,
    )
  }
}

function testGeneratorSquare(): void {
  console.log('Testing generateVCarveMedialToolpath on a 20×20 square...')
  const proj = baseProject([makeVBit()], [makeRectFeature('f1', 0, 0, 20, 20, -5)])
  const result = generateVCarveMedialToolpath(proj, makeVCarveMedialOp(['f1']))

  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, `expected cut moves, got 0 (warnings: ${result.warnings.join(', ')})`)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assertContinuity(result.moves)

  const MARGIN = 1e-6
  let minZ = Infinity
  let maxZ = -Infinity
  for (const move of cuts) {
    for (const pt of [move.from, move.to]) {
      assert(pt.x >= -MARGIN && pt.x <= 20 + MARGIN, `cut x=${pt.x} outside square`)
      assert(pt.y >= -MARGIN && pt.y <= 20 + MARGIN, `cut y=${pt.y} outside square`)
      minZ = Math.min(minZ, pt.z)
      maxZ = Math.max(maxZ, pt.z)
    }
  }
  // Center clearance 10 → unclamped depth 10/tan(30°) ≈ 17.3, clamps at 2.
  assert(approx(minZ, -2, 1e-6), `expected clamped depth -2, got ${minZ}`)
  // Corner tips surface at z=0.
  assert(maxZ > -1e-6, `expected corner tips to reach the surface, max cut z ${maxZ}`)
  console.log(`generator square: ${cuts.length} cuts, z ∈ [${minZ.toFixed(3)}, ${maxZ.toFixed(3)}] PASSED`)
}

function testGeneratorDepthMatchesVBitGeometry(): void {
  console.log('Testing V-bit depth math on a 30×5 bar (60° and 90° bits)...')
  const proj60 = baseProject([makeVBit(60)], [makeRectFeature('f1', 0, 0, 30, 5, -20)])
  const result60 = generateVCarveMedialToolpath(proj60, makeVCarveMedialOp(['f1'], { maxCarveDepth: 10 }))
  const minZ60 = Math.min(...cutMoves(result60.moves).flatMap((m) => [m.from.z, m.to.z]))
  const expected60 = -2.5 / Math.tan(Math.PI / 6)
  assert(approx(minZ60, expected60, 0.02), `60° bit: deepest ${minZ60} != ${expected60}`)

  const proj90 = baseProject([makeVBit(90)], [makeRectFeature('f1', 0, 0, 30, 5, -20)])
  const result90 = generateVCarveMedialToolpath(proj90, makeVCarveMedialOp(['f1'], { maxCarveDepth: 10 }))
  const minZ90 = Math.min(...cutMoves(result90.moves).flatMap((m) => [m.from.z, m.to.z]))
  assert(approx(minZ90, -2.5, 0.02), `90° bit: deepest ${minZ90} != -2.5`)
  console.log(`depth math: 60° → ${minZ60.toFixed(4)}, 90° → ${minZ90.toFixed(4)} PASSED`)
}

function testGeneratorRequiresVBit(): void {
  console.log('Testing non-V-bit tool rejection...')
  const flat: Tool = { ...defaultTool('mm', 1), id: 't1', type: 'flat_endmill' }
  const proj = baseProject([flat], [makeRectFeature('f1', 0, 0, 20, 20, -5)])
  const result = generateVCarveMedialToolpath(proj, makeVCarveMedialOp(['f1']))
  assert(result.moves.length === 0, 'expected no moves with a flat tool')
  assert(
    result.warnings.some((w) => w.includes('V-bit')),
    `expected V-bit warning, got: ${result.warnings.join(', ')}`,
  )
  console.log('non-V-bit rejection PASSED')
}

function testGeneratorDeterminism(): void {
  console.log('Testing determinism...')
  const proj = baseProject([makeVBit()], [makeRectFeature('f1', 0, 0, 30, 5, -5)])
  const op = makeVCarveMedialOp(['f1'])
  const a = generateVCarveMedialToolpath(proj, op)
  const b = generateVCarveMedialToolpath(proj, op)
  assert(JSON.stringify(a.moves) === JSON.stringify(b.moves), 'two runs produced different toolpaths')
  console.log(`determinism: ${a.moves.length} moves PASSED`)
}

function testGeneratorMultipleFeatures(): void {
  console.log('Testing multiple target features (retract between letters)...')
  const proj = baseProject(
    [makeVBit()],
    [
      makeRectFeature('f1', 0, 0, 10, 4, -5),
      makeRectFeature('f2', 20, 0, 10, 4, -5),
    ],
  )
  const result = generateVCarveMedialToolpath(proj, makeVCarveMedialOp(['f1', 'f2']))
  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'expected cuts across both features')
  assertContinuity(result.moves)
  // A cut must never bridge the 10-unit gap between the two bars.
  for (const move of cuts) {
    const inGap = (p: { x: number }): boolean => p.x > 10 + 1e-6 && p.x < 20 - 1e-6
    assert(!inGap(move.from) || !inGap(move.to), 'cut crosses the gap between features')
  }
  console.log(`multi-feature: ${cuts.length} cuts PASSED`)
}

function makeOutlineTextFeature(id: string, text: string, zBottom: number): SketchFeature {
  const font = getTextFontOptions('outline')[0]
  // A text draft that baseProject/projectWithFeatures turns into an
  // authoritative text definition + instance (definitionId + transform),
  // exactly like a saved project. Regression guard: an outline-text target
  // must expand to per-glyph subtract geometry and produce a real toolpath —
  // not flatten to empty paths ("Band ... resolved to empty subject geometry").
  return {
    id,
    name: text,
    kind: 'text',
    text: { text, style: 'outline', fontId: font.id, size: 10 },
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 60, 14),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 0,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function testGeneratorTextFeatureTarget(): void {
  console.log('Testing raw text feature target (authoritative instance model)...')
  const proj = baseProject([makeVBit()], [makeOutlineTextFeature('f-text', 'Rag', -5)])
  const result = generateVCarveMedialToolpath(proj, makeVCarveMedialOp(['f-text'], { stepover: 0.25 }))
  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, `expected cuts for text feature, got 0 (warnings: ${result.warnings.join(', ')})`)
  assert(
    !result.warnings.some((w) => w.includes('empty subject geometry')),
    `text target resolved empty: ${result.warnings.join(', ')}`,
  )
  console.log(`text feature target: ${cuts.length} cuts PASSED`)
}

function testDotRegionCollapsesToSinglePlunge(): void {
  console.log('Testing dot-sized region (i-dot) collapses to one plunge...')
  const outer = regularPolygon(5, 5, 1, 32)
  const graph = computeMedialAxis({ outer, islands: [] }, { resolution: 0.35 })
  assert(graph.nodes.length === 1, `expected 1 node for dot region, got ${graph.nodes.length}`)

  const moves: ToolpathMove[] = []
  emitMedialToolpath(
    graph,
    { topZ: 0, maxDepth: 5, slope: Math.tan(Math.PI / 6), safeZ: 1, simplifyTolerance: 0.0875, enableChainLinks: true, redundancyTolerance: 0 },
    moves,
    null,
  )
  const plunges = moves.filter((m) => m.kind === 'plunge')
  assert(plunges.length === 1, `expected exactly 1 plunge for dot, got ${plunges.length}`)
  assert(cutMoves(moves).length === 0, `expected no cuts for dot, got ${cutMoves(moves).length}`)
  console.log('dot region single plunge PASSED')
}

function testEmissionLinksNearbyChainEnds(): void {
  console.log('Testing tool-down link between nearby chain ends (no retract)...')
  const graph: MedialGraph = {
    nodes: [
      { x: 0, y: 0, clearance: 1 },
      { x: 2, y: 0, clearance: 1 },
      { x: 2.2, y: 0.05, clearance: 1 },
      { x: 4, y: 0, clearance: 1 },
    ],
    adjacency: [[1], [0], [3], [2]],
  }
  // Wide clearance 1 (unclamped): carved radius = 1, link reach = 0.9, so the
  // 0.2 gap between the chain ends is bridged tool-down.
  const moves: ToolpathMove[] = []
  emitMedialToolpath(
    graph,
    { topZ: 0, maxDepth: 5, slope: 1, safeZ: 3, simplifyTolerance: 0, enableChainLinks: true, redundancyTolerance: 0 },
    moves,
    null,
  )
  const plunges = moves.filter((m) => m.kind === 'plunge')
  assert(plunges.length === 1, `expected a single plunge (link, not retract), got ${plunges.length}`)
  assert(cutMoves(moves).length === 3, `expected 2 chain cuts + 1 link cut, got ${cutMoves(moves).length}`)

  // Shallow clearance 0.05: the carved disk is only 0.045 across, smaller than
  // the 0.2 gap, so the tool must retract instead of gouging across raw stock.
  const shallow: MedialGraph = {
    nodes: graph.nodes.map((n) => ({ ...n, clearance: 0.05 })),
    adjacency: graph.adjacency,
  }
  const farMoves: ToolpathMove[] = []
  emitMedialToolpath(
    shallow,
    { topZ: 0, maxDepth: 5, slope: 1, safeZ: 3, simplifyTolerance: 0, enableChainLinks: true, redundancyTolerance: 0 },
    farMoves,
    null,
  )
  assert(
    farMoves.filter((m) => m.kind === 'plunge').length === 2,
    'expected a retract + replunge when the gap exceeds the carved-disk reach',
  )
  console.log('chain-end linking PASSED')
}

function testLinkRespectsClampedDepth(): void {
  console.log('Testing links use clamped effective clearance (no gouge on shallow wide carve)...')
  // Reviewer scenario: raw clearance 1 would authorise bridging an 0.8 gap,
  // but maxDepth 0.1 (slope 1) means the groove only reaches 0.1 sideways, so
  // an 0.8 link would gouge 0.7 of raw stock. The emitter must retract.
  const graph: MedialGraph = {
    nodes: [
      { x: 0, y: 0, clearance: 1 },
      { x: 2, y: 0, clearance: 1 },
      { x: 2.8, y: 0, clearance: 1 },
      { x: 4, y: 0, clearance: 1 },
    ],
    adjacency: [[1], [0], [3], [2]],
  }
  const moves: ToolpathMove[] = []
  emitMedialToolpath(
    graph,
    { topZ: 0, maxDepth: 0.1, slope: 1, safeZ: 3, simplifyTolerance: 0, enableChainLinks: true, redundancyTolerance: 0 },
    moves,
    null,
  )
  // A gouging link would join the two chains with a single plunge; retracting
  // between them yields two. (Raw-clearance logic would have linked here.)
  assert(
    moves.filter((m) => m.kind === 'plunge').length === 2,
    'clamped depth must force a retract between the two chains, not a gouging link',
  )
  // The only cut moves are the two along-skeleton chain cuts; none bridges the
  // uncarved 0.8 gap between the chains' facing ends (x≈2 to x≈2.8).
  const bridges = cutMoves(moves).some((m) =>
    Math.abs(m.from.x - 2) < 1e-6 && Math.abs(m.to.x - 2.8) < 1e-6)
  assert(!bridges, 'a link cut bridged the uncarved inter-chain gap')
  console.log('clamped-depth link guard PASSED')
}

function testGeneratorTriangle(): void {
  console.log('Testing triangle (3 arms meeting at incenter)...')
  const tri: Point[] = [
    { x: 0, y: 0 },
    { x: 24, y: 0 },
    { x: 12, y: 18 },
  ]
  const proj = baseProject([makeVBit()], [makePolygonFeature('f1', tri, -5)])
  const result = generateVCarveMedialToolpath(proj, makeVCarveMedialOp(['f1'], { maxCarveDepth: 20 }))
  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, `expected triangle cuts (warnings: ${result.warnings.join(', ')})`)
  // All three tips reach the surface.
  const surfaced = cuts.filter((m) => m.to.z > -1e-6 || m.from.z > -1e-6)
  assert(surfaced.length >= 3, `expected >=3 surface touches at triangle corners, got ${surfaced.length}`)
  console.log(`triangle: ${cuts.length} cuts PASSED`)
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

try {
  testRectangleSpineAndCorners()
  testSquareCenterJunction()
  testCircleCollapsesToCenter()
  testRingWithIsland()
  testLShapeJunctionAndReflexCorner()
  testRegionConvexCorners()
  testGeneratorSquare()
  testGeneratorDepthMatchesVBitGeometry()
  testGeneratorRequiresVBit()
  testGeneratorDeterminism()
  testGeneratorMultipleFeatures()
  testGeneratorTextFeatureTarget()
  testDotRegionCollapsesToSinglePlunge()
  testEmissionLinksNearbyChainEnds()
  testLinkRespectsClampedDepth()
  testGeneratorTriangle()
  console.log('\nAll vcarveMedial tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
