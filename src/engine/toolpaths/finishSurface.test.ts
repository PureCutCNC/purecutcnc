/**
 * Integration tests for finish surface toolpath generation.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurface.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { normalizeProject } from '../../store/projectStore'
import { generateFinishSurfaceToolpath, maxContourGap } from './finishSurface'
import { generateRoughSurfaceToolpath } from './roughSurface'
import { toClipperPath, normalizeWinding, DEFAULT_CLIPPER_SCALE } from './geometry'
import type { ClipperPath, ToolpathMove } from './types'
import { simulateReplayItemsHeightfield } from '../simulation/replay'
import type { SimulationGrid, SimulationReplayItem } from '../simulation/types'
import { applyTabsToEdgeRoute } from './tabs'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function addBoxFaces(
  lines: string[],
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  const vertices = {
    b0: [minX, minY, minZ],
    b1: [maxX, minY, minZ],
    b2: [maxX, maxY, minZ],
    b3: [minX, maxY, minZ],
    t0: [minX, minY, maxZ],
    t1: [maxX, minY, maxZ],
    t2: [maxX, maxY, maxZ],
    t3: [minX, maxY, maxZ],
  } as const

  const faces: Array<[keyof typeof vertices, keyof typeof vertices, keyof typeof vertices]> = [
    ['b0', 'b2', 'b1'], ['b0', 'b3', 'b2'],
    ['t0', 't1', 't2'], ['t0', 't2', 't3'],
    ['b0', 'b1', 't1'], ['b0', 't1', 't0'],
    ['b1', 'b2', 't2'], ['b1', 't2', 't1'],
    ['b2', 'b3', 't3'], ['b2', 't3', 't2'],
    ['b3', 'b0', 't0'], ['b3', 't0', 't3'],
  ]

  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const key of face) {
      lines.push(`      vertex ${vertices[key].join(' ')}`)
    }
    lines.push('    endloop')
    lines.push('  endfacet')
  }
}

function addQuad(
  lines: string[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): void {
  lines.push('  facet normal 0 0 0')
  lines.push('    outer loop')
  lines.push(`      vertex ${a.join(' ')}`)
  lines.push(`      vertex ${b.join(' ')}`)
  lines.push(`      vertex ${c.join(' ')}`)
  lines.push('    endloop')
  lines.push('  endfacet')

  lines.push('  facet normal 0 0 0')
  lines.push('    outer loop')
  lines.push(`      vertex ${a.join(' ')}`)
  lines.push(`      vertex ${c.join(' ')}`)
  lines.push(`      vertex ${d.join(' ')}`)
  lines.push('    endloop')
  lines.push('  endfacet')
}

function makeSteppedStlDataUrl(): string {
  const lines = ['solid stepped']
  addBoxFaces(lines, 0, 0, 0, 20, 10, 1)
  addBoxFaces(lines, 8, 3, 1, 12, 7, 4)
  lines.push('endsolid stepped')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makeTaperedStlDataUrl(): string {
  const lines = ['solid tapered']
  const vertices = {
    b0: [0, 0, 0],
    b1: [20, 0, 0],
    b2: [20, 10, 0],
    b3: [0, 10, 0],
    t0: [8, 3, 4],
    t1: [12, 3, 4],
    t2: [12, 7, 4],
    t3: [8, 7, 4],
  } as const
  const faces: Array<[keyof typeof vertices, keyof typeof vertices, keyof typeof vertices]> = [
    ['b0', 'b2', 'b1'], ['b0', 'b3', 'b2'],
    ['t0', 't1', 't2'], ['t0', 't2', 't3'],
    ['b0', 'b1', 't1'], ['b0', 't1', 't0'],
    ['b1', 'b2', 't2'], ['b1', 't2', 't1'],
    ['b2', 'b3', 't3'], ['b2', 't3', 't2'],
    ['b3', 'b0', 't0'], ['b3', 't0', 't3'],
  ]

  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const key of face) {
      lines.push(`      vertex ${vertices[key].join(' ')}`)
    }
    lines.push('    endloop')
    lines.push('  endfacet')
  }

  lines.push('endsolid tapered')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makePocketBlockStlDataUrl(): string {
  const lines = ['solid pocket_block']
  const minX = 0, minY = 0, minZ = 0
  const maxX = 20, maxY = 10, maxZ = 4
  const pocketMinX = 6, pocketMinY = 3, pocketMaxX = 14, pocketMaxY = 7, pocketFloorZ = 2

  // Bottom face
  addQuad(lines,
    [minX, minY, minZ], [maxX, minY, minZ], [maxX, maxY, minZ], [minX, maxY, minZ],
  )

  // Outer walls
  addQuad(lines,
    [minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ],
  )
  addQuad(lines,
    [maxX, minY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ], [maxX, minY, maxZ],
  )
  addQuad(lines,
    [maxX, maxY, minZ], [minX, maxY, minZ], [minX, maxY, maxZ], [maxX, maxY, maxZ],
  )
  addQuad(lines,
    [minX, maxY, minZ], [minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, maxZ],
  )

  // Top frame around pocket opening (no top over the pocket area)
  addQuad(lines,
    [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, pocketMinY, maxZ], [minX, pocketMinY, maxZ],
  )
  addQuad(lines,
    [minX, pocketMaxY, maxZ], [maxX, pocketMaxY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
  )
  addQuad(lines,
    [minX, pocketMinY, maxZ], [pocketMinX, pocketMinY, maxZ], [pocketMinX, pocketMaxY, maxZ], [minX, pocketMaxY, maxZ],
  )
  addQuad(lines,
    [pocketMaxX, pocketMinY, maxZ], [maxX, pocketMinY, maxZ], [maxX, pocketMaxY, maxZ], [pocketMaxX, pocketMaxY, maxZ],
  )

  // Pocket floor
  addQuad(lines,
    [pocketMinX, pocketMinY, pocketFloorZ], [pocketMaxX, pocketMinY, pocketFloorZ],
    [pocketMaxX, pocketMaxY, pocketFloorZ], [pocketMinX, pocketMaxY, pocketFloorZ],
  )

  // Pocket walls
  addQuad(lines,
    [pocketMinX, pocketMinY, maxZ], [pocketMaxX, pocketMinY, maxZ], [pocketMaxX, pocketMinY, pocketFloorZ], [pocketMinX, pocketMinY, pocketFloorZ],
  )
  addQuad(lines,
    [pocketMaxX, pocketMinY, maxZ], [pocketMaxX, pocketMaxY, maxZ], [pocketMaxX, pocketMaxY, pocketFloorZ], [pocketMaxX, pocketMinY, pocketFloorZ],
  )
  addQuad(lines,
    [pocketMaxX, pocketMaxY, maxZ], [pocketMinX, pocketMaxY, maxZ], [pocketMinX, pocketMaxY, pocketFloorZ], [pocketMaxX, pocketMaxY, pocketFloorZ],
  )
  addQuad(lines,
    [pocketMinX, pocketMaxY, maxZ], [pocketMinX, pocketMinY, maxZ], [pocketMinX, pocketMinY, pocketFloorZ], [pocketMinX, pocketMaxY, pocketFloorZ],
  )

  lines.push('endsolid pocket_block')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'tool1',
    name: '1 mm ball endmill',
    type: 'ball_endmill',
    diameter: 1,
    defaultStepdown: 1,
    defaultStepover: 1,
    maxCutDepth: 10,
  }
}

function makeModelFeature(): SketchFeature {
  return {
    id: 'model1',
    name: 'Stepped STL',
    kind: 'stl',
    stl: {
      format: 'stl',
      fileData: makeSteppedStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ]],
    },
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 20, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeTaperedModelFeature(): SketchFeature {
  return {
    ...makeModelFeature(),
    id: 'model1',
    name: 'Tapered STL',
    stl: {
      format: 'stl',
      fileData: makeTaperedStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ]],
    },
  }
}

function makePocketBlockModelFeature(): SketchFeature {
  return {
    ...makeModelFeature(),
    id: 'model1',
    name: 'Pocket Block STL',
    stl: {
      format: 'stl',
      fileData: makePocketBlockStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ]],
    },
  }
}

function makeOperation(): Operation {
  return {
    id: 'finish1',
    name: 'Finish Surface',
    kind: 'finish_surface',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['model1'] },
    toolRef: 'tool1',
    stepdown: 1,
    stepover: 1,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'parallel',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'feature_first',
  }
}

function makeRoughSurfaceOperation(): Operation {
  return {
    ...makeOperation(),
    id: 'rough1',
    name: 'Rough Surface',
    kind: 'rough_surface',
    pass: 'rough',
    pocketPattern: 'offset',
  }
}

function makeProject(): { project: Project; operation: Operation } {
  const project = {
    ...newProject('finish-surface-test', 'mm'),
    tools: [makeTool()],
    features: [makeModelFeature()],
  }
  return { project: normalizeProject(project), operation: makeOperation() }
}

function normalizeProjectFeatures(project: Project): void {
  project.features = normalizeProject(project).features
}

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'cut')
}

function indexFor(grid: SimulationGrid, col: number, row: number): number {
  return row * grid.cols + col
}

function edgeJumpMetric(
  grid: SimulationGrid,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): number {
  let totalJump = 0
  let samples = 0
  const cutThreshold = grid.stockTopZ - 1e-6

  for (let row = 0; row < grid.rows - 1; row += 1) {
    const y = grid.originY + (row + 0.5) * grid.cellSize
    if (y < bounds.minY || y > bounds.maxY) continue
    for (let col = 0; col < grid.cols - 1; col += 1) {
      const x = grid.originX + (col + 0.5) * grid.cellSize
      if (x < bounds.minX || x > bounds.maxX) continue

      const z = grid.topZ[indexFor(grid, col, row)]
      const zRight = grid.topZ[indexFor(grid, col + 1, row)]
      const zDown = grid.topZ[indexFor(grid, col, row + 1)]

      if (z < cutThreshold && zRight < cutThreshold) {
        totalJump += Math.abs(z - zRight)
        samples += 1
      }
      if (z < cutThreshold && zDown < cutThreshold) {
        totalJump += Math.abs(z - zDown)
        samples += 1
      }
    }
  }

  return samples > 0 ? totalJump / samples : 0
}

function hasReducibleAdjacentCutPair(moves: ToolpathMove[]): boolean {
  const epsilon = 1e-6
  for (let i = 0; i + 1 < moves.length; i += 1) {
    const a = moves[i]
    const b = moves[i + 1]
    if (a.kind !== 'cut' || b.kind !== 'cut') continue

    const contiguous = Math.hypot(a.to.x - b.from.x, a.to.y - b.from.y, a.to.z - b.from.z) <= epsilon
    if (!contiguous) continue

    const ax = a.to.x - a.from.x
    const ay = a.to.y - a.from.y
    const az = a.to.z - a.from.z
    const bx = b.to.x - b.from.x
    const by = b.to.y - b.from.y
    const bz = b.to.z - b.from.z
    const aLen = Math.hypot(ax, ay, az)
    const bLen = Math.hypot(bx, by, bz)
    if (aLen <= epsilon || bLen <= epsilon) return true

    const crossX = ay * bz - az * by
    const crossY = az * bx - ax * bz
    const crossZ = ax * by - ay * bx
    const crossLenNorm = Math.hypot(crossX, crossY, crossZ) / (aLen * bLen)
    const dot = ax * bx + ay * by + az * bz
    if (crossLenNorm <= 1e-4 && dot >= -epsilon) return true
  }
  return false
}

function makeProtectedAddFeature(): SketchFeature {
  return {
    id: 'boss1',
    name: 'Protected boss',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(2, 2, 4, 6),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeRegionFeatureRect(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): SketchFeature {
  return {
    id,
    name: `Region ${id}`,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'region',
    z_top: 0,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeContainingSubtractFeature(): SketchFeature {
  return {
    id: 'pocket1',
    name: 'Containing pocket',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(-1, -1, 22, 12),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 4,
    z_bottom: 2,
    visible: true,
    locked: false,
  }
}

function makeRightHalfSubtractFeature(): SketchFeature {
  return {
    id: 'pocket2',
    name: 'Deeper right pocket',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, -1, 11, 12),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 4,
    z_bottom: 1,
    visible: true,
    locked: false,
  }
}

function pointInsideProtectedBoss(point: { x: number; y: number }): boolean {
  return point.x > 1.55 && point.x < 6.45 && point.y > 1.55 && point.y < 8.45
}

function pointInsideRect(point: { x: number; y: number }, rect: { x: number; y: number; w: number; h: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h
}

function orientation(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y)
}

function onSegment(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): boolean {
  return b.x <= Math.max(a.x, c.x) + 1e-9 && b.x + 1e-9 >= Math.min(a.x, c.x)
    && b.y <= Math.max(a.y, c.y) + 1e-9 && b.y + 1e-9 >= Math.min(a.y, c.y)
}

function segmentsIntersect2D(
  p1: { x: number; y: number },
  q1: { x: number; y: number },
  p2: { x: number; y: number },
  q2: { x: number; y: number },
): boolean {
  const o1 = orientation(p1, q1, p2)
  const o2 = orientation(p1, q1, q2)
  const o3 = orientation(p2, q2, p1)
  const o4 = orientation(p2, q2, q1)

  if ((o1 > 0 && o2 < 0 || o1 < 0 && o2 > 0) && (o3 > 0 && o4 < 0 || o3 < 0 && o4 > 0)) {
    return true
  }

  if (Math.abs(o1) <= 1e-9 && onSegment(p1, p2, q1)) return true
  if (Math.abs(o2) <= 1e-9 && onSegment(p1, q2, q1)) return true
  if (Math.abs(o3) <= 1e-9 && onSegment(p2, p1, q2)) return true
  if (Math.abs(o4) <= 1e-9 && onSegment(p2, q1, q2)) return true
  return false
}

function segmentIntersectsRect2D(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  if (pointInsideRect(a, rect) || pointInsideRect(b, rect)) return true

  const r0 = { x: rect.x, y: rect.y }
  const r1 = { x: rect.x + rect.w, y: rect.y }
  const r2 = { x: rect.x + rect.w, y: rect.y + rect.h }
  const r3 = { x: rect.x, y: rect.y + rect.h }

  return segmentsIntersect2D(a, b, r0, r1)
    || segmentsIntersect2D(a, b, r1, r2)
    || segmentsIntersect2D(a, b, r2, r3)
    || segmentsIntersect2D(a, b, r3, r0)
}

function testFinishSurfaceCoversLowerTopPlateau(): void {
  console.log('Testing finish_surface covers lower top plateau...')
  const { project, operation } = makeProject()
  const result = generateFinishSurfaceToolpath(project, operation)
  const lowPlateauCuts = cutMoves(result.moves).filter((move) => {
    const point = move.to
    return point.x > 1 && point.x < 7 && point.y > 1 && point.y < 9 && point.z <= 1.5
  })

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected finish surface cut moves')
  assert(lowPlateauCuts.length > 0, 'expected finish cuts on lower top plateau outside the high boss')
}

function testFinishSurfaceRepeatGenerationIsStable(): void {
  console.log('Testing finish_surface repeat generation is stable...')
  const { project, operation } = makeProject()
  const first = generateFinishSurfaceToolpath(project, operation)
  const second = generateFinishSurfaceToolpath(project, operation)

  assert(first.warnings.length === 0, `unexpected first warnings: ${first.warnings.join(', ')}`)
  assert(second.warnings.length === 0, `unexpected second warnings: ${second.warnings.join(', ')}`)
  assert(first.moves.length === second.moves.length, `expected repeat move count ${first.moves.length}, got ${second.moves.length}`)
  assert(cutMoves(second.moves).length > 0, 'expected repeated finish surface cut moves')
}

function testFinishSurfaceAvoidsSurroundingAddFeature(): void {
  console.log('Testing finish_surface avoids surrounding add feature footprints...')
  const { project, operation } = makeProject()
  project.features = [...project.features, makeProtectedAddFeature()]
  const result = generateFinishSurfaceToolpath(project, operation)
  const protectedCuts = cutMoves(result.moves).filter((move) => (
    pointInsideProtectedBoss(move.from) || pointInsideProtectedBoss(move.to)
  ))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected finish surface cut moves')
  assert(protectedCuts.length === 0, `expected no finish cuts inside protected add feature, got ${protectedCuts.length}`)
}

function testFinishSurfaceRespectsContainingPocketDepth(): void {
  console.log('Testing finish_surface respects containing subtract pocket depth...')
  const { project, operation } = makeProject()
  project.features = [makeContainingSubtractFeature(), ...project.features]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const minCutZ = Math.min(...cuts.map((move) => move.to.z))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected finish surface cut moves above containing pocket bottom')
  assert(minCutZ >= 2 - 1e-9, `expected no finish cuts below containing pocket bottom, got min Z ${minCutZ}`)
}

function testFinishSurfaceRespectsSplitPocketDepths(): void {
  console.log('Testing finish_surface respects split subtract pocket depths...')
  const { project, operation } = makeProject()
  project.features = [makeContainingSubtractFeature(), makeRightHalfSubtractFeature(), ...project.features]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const leftCutsBelowShallow = cuts.filter((move) => (
    (move.from.x < 10 - 1e-9 || move.to.x < 10 - 1e-9) &&
    (move.from.z < 2 - 1e-9 || move.to.z < 2 - 1e-9)
  ))
  const rightCutsBelowShallow = cuts.filter((move) => (
    move.from.x > 10 + 1e-9 && move.to.x > 10 + 1e-9 &&
    (move.from.z < 2 - 1e-9 || move.to.z < 2 - 1e-9)
  ))
  const minCutZ = Math.min(...cuts.map((move) => move.to.z))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected finish surface cut moves')
  assert(minCutZ >= 1 - 1e-9, `expected no finish cuts below deeper pocket bottom, got min Z ${minCutZ}`)
  assert(rightCutsBelowShallow.length > 0, 'expected finish cuts below shallow pocket bottom in deeper right pocket')
  assert(leftCutsBelowShallow.length === 0, `expected no finish cuts below shallow pocket bottom on left side, got ${leftCutsBelowShallow.length}`)
}

// ── Waterline tests ──────────────────────────────────────────────────────

function makeSquareContour(cx: number, cy: number, halfSize: number): ClipperPath {
  const points = [
    { x: cx - halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy + halfSize },
    { x: cx - halfSize, y: cy + halfSize },
  ]
  return toClipperPath(normalizeWinding(points, false), DEFAULT_CLIPPER_SCALE)
}

function testMaxContourGapIdenticalContours(): void {
  console.log('Testing maxContourGap with identical contours...')
  const contour = makeSquareContour(10, 10, 5)
  const gap = maxContourGap([contour], [contour])
  assert(gap < 0.01, `expected near-zero gap for identical contours, got ${gap}`)
}

function testMaxContourGapDifferentContours(): void {
  console.log('Testing maxContourGap with offset contours...')
  const contourA = makeSquareContour(10, 10, 5)
  const contourB = makeSquareContour(10, 10, 3)
  const gap = maxContourGap([contourA], [contourB])
  assert(gap > 1, `expected significant gap for different-size contours, got ${gap}`)
}

function testMaxContourGapEmptyReturnsThickness(): void {
  console.log('Testing maxContourGap with one empty path set...')
  const contour = makeSquareContour(10, 10, 5)
  const gap = maxContourGap([], [contour])
  // area = 10*10=100, perimeter = 40. gap = 2*100/40 = 5.
  assert(Math.abs(gap - 5) < 0.1, `expected thickness (~5) for one empty path, got ${gap}`)
}

function testWaterlineCumulativeShadowProtectsUpperLevels(): void {
  console.log('Testing waterline cumulative shadow protects upper levels...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)

  assert(cuts.length > 0, 'expected waterline cut moves')

  for (const move of cuts) {
    const minX = Math.min(move.from.x, move.to.x)
    const maxX = Math.max(move.from.x, move.to.x)
    const minY = Math.min(move.from.y, move.to.y)
    const maxY = Math.max(move.from.y, move.to.y)
    const z = move.to.z

    if (z < 1 - 1e-9) {
      const insideHighBoss = minX > 7.5 && maxX < 12.5 && minY > 2.5 && maxY < 7.5
      assert(!insideHighBoss,
        `waterline at z=${z.toFixed(3)} cuts inside the high boss area — cumulative shadow should prevent this`)
    }
  }
}

function makeWaterlineOperation(): Operation {
  return {
    ...makeOperation(),
    pocketPattern: 'waterline',
    stepover: 0.5,
  }
}

function testWaterlineGeneratesContourMoves(): void {
  console.log('Testing waterline generates contour cut moves...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected waterline contour cut moves')
}

function testWaterlineStepLevelsDescend(): void {
  console.log('Testing waterline step levels are descending...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  assert(result.stepLevels.length > 0, 'expected step levels')
  for (let i = 1; i < result.stepLevels.length; i += 1) {
    assert(result.stepLevels[i] <= result.stepLevels[i - 1],
      `expected descending step levels, got ${result.stepLevels[i - 1]} -> ${result.stepLevels[i]}`)
  }
}

function testWaterlineRepeatIsStable(): void {
  console.log('Testing waterline repeat generation is stable...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const first = generateFinishSurfaceToolpath(project, operation)
  const second = generateFinishSurfaceToolpath(project, operation)
  assert(first.moves.length === second.moves.length,
    `expected stable move count, first=${first.moves.length}, second=${second.moves.length}`)
}

function testWaterlineRespectsContainingPocketDepth(): void {
  console.log('Testing waterline respects containing subtract pocket depth...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.features = [makeContainingSubtractFeature(), ...project.features]
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const minCutZ = Math.min(...cuts.map((move) => Math.min(move.from.z, move.to.z)))
  assert(cuts.length > 0, 'expected waterline cut moves')
  assert(minCutZ >= 2 - 1e-9, `expected waterline no lower than containing pocket bottom, got min Z ${minCutZ}`)
}

function testWaterlineRegionActsAsFilterNotBoundaryContour(): void {
  console.log('Testing waterline region is a filter (no boundary contour cuts)...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature(), makeRegionFeatureRect('region1', 9, 0, 4, 10)]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    target: { source: 'features', featureIds: ['model1', 'region1'] },
  }
  project.operations = [operation]

  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'expected waterline cut moves')

  const boundaryXs = [9, 13]
  const onBoundary = (x: number): boolean => boundaryXs.some((bx) => Math.abs(x - bx) <= 1e-6)
  const boundaryRuns = cuts.filter((move) => {
    if (!onBoundary(move.from.x) || !onBoundary(move.to.x)) return false
    return Math.abs(move.to.y - move.from.y) > 0.05
  })

  assert(boundaryRuns.length === 0,
    `expected no region-boundary contour runs, got ${boundaryRuns.length}`)
}

function testWaterlineUsesCoarseZLevelsOnly(): void {
  console.log('Testing waterline uses coarse constant-Z levels only...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.3,
    debugToolpath: true,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const expectedLevelCount = 5 // top + 3 stepdowns + bottom
  assert(result.stepLevels.length === expectedLevelCount,
    `expected ${expectedLevelCount} constant-Z waterline levels, got ${result.stepLevels.length} — debug: ${result.warnings.join('; ')}`)
}

function testWaterlineLevelsAreConstantBands(): void {
  console.log('Testing waterline levels are constant Z bands...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const expected = [4, 3, 2, 1, 0]
  for (const z of expected) {
    const has = result.stepLevels.some((level) => Math.abs(level - z) < 1e-6)
    assert(has, `expected constant waterline level near Z=${z}, got ${result.stepLevels.join(', ')}`)
  }
}

function testWaterlineEmitsBandBoundaryLevels(): void {
  console.log('Testing waterline emits current band boundary levels...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.3,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const hasBandBoundaryNear4 = result.stepLevels.some((z) => z < 4.01 && z > 3.99)
  const hasBandBoundaryNear3 = result.stepLevels.some((z) => z < 3.01 && z > 2.99)
  const hasBandBoundaryNear2 = result.stepLevels.some((z) => z < 2.01 && z > 1.99)

  assert(hasBandBoundaryNear4, `expected current-band boundary near Z=4 in ${result.stepLevels.join(', ')}`)
  assert(hasBandBoundaryNear3, `expected current-band boundary near Z=3 in ${result.stepLevels.join(', ')}`)
  assert(hasBandBoundaryNear2, `expected current-band boundary near Z=2 in ${result.stepLevels.join(', ')}`)
}

function testWaterlineBallEndmillUsesSideContactZ(): void {
  console.log('Testing waterline ball-endmill stays on constant slice Z levels...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const stepLevels = result.stepLevels
  const maxCutZ = Math.max(...stepLevels)
  const hasBand3 = stepLevels.some((z) => Math.abs(z - 3) < 1e-6)

  assert(cuts.length > 0, 'expected waterline cut moves')
  assert(Math.abs(maxCutZ - 4) < 1e-6, `expected top waterline at Z=4, got ${maxCutZ}`)
  assert(hasBand3, `expected band level near Z=3, got ${stepLevels.join(', ')}`)
}

function testWaterlineReachesModelTop(): void {
  console.log('Testing waterline reaches model top...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  operation.stepdown = 1
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const maxZ = Math.max(...result.stepLevels)
  const topZ = 4

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(maxZ >= topZ - 1e-6, `expected waterline to reach top ${topZ}, got ${maxZ}`)
}

function testWaterlineBlendsWithRoughInCombinedSimulation(): void {
  console.log('Testing rough + waterline combined replay remains stable...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  project.stock = {
    ...project.stock,
    profile: rectProfile(0, 0, 20, 10),
    thickness: 4,
  }

  const rough = makeRoughSurfaceOperation()
  rough.target = { source: 'features', featureIds: ['model1'] }
  rough.stepdown = 1
  rough.stepover = 0.5

  const finish = makeWaterlineOperation()
  finish.target = { source: 'features', featureIds: ['model1'] }
  finish.stepdown = 1
  finish.stepover = 0.3

  const roughPath = generateRoughSurfaceToolpath(project, rough)
  const finishPath = generateFinishSurfaceToolpath(project, finish)
  assert(roughPath.warnings.length === 0, `unexpected rough warnings: ${roughPath.warnings.join(', ')}`)
  assert(finishPath.warnings.length === 0, `unexpected finish warnings: ${finishPath.warnings.join(', ')}`)

  const tool = project.tools[0]
  const replayRough: SimulationReplayItem = {
    operationId: rough.id,
    operationName: rough.name,
    toolRef: tool.id,
    toolType: tool.type,
    toolRadius: tool.diameter / 2,
    vBitAngle: null,
    toolpath: roughPath,
  }
  const replayFinish: SimulationReplayItem = {
    operationId: finish.id,
    operationName: finish.name,
    toolRef: tool.id,
    toolType: tool.type,
    toolRadius: tool.diameter / 2,
    vBitAngle: null,
    toolpath: finishPath,
  }

  const roughOnly = simulateReplayItemsHeightfield(project, [replayRough], { targetLongAxisCells: 140 })
  const combined = simulateReplayItemsHeightfield(project, [replayRough, replayFinish], { targetLongAxisCells: 140 })

  const roi = { minX: 1, maxX: 19, minY: 1, maxY: 9 }
  const roughJump = edgeJumpMetric(roughOnly.grid, roi)
  const combinedJump = edgeJumpMetric(combined.grid, roi)

  assert(Number.isFinite(roughJump) && Number.isFinite(combinedJump),
    `expected finite terracing metrics, rough=${roughJump}, combined=${combinedJump}`)
  assert(combinedJump <= roughJump * 1.5,
    `expected waterline finish not to regress terracing catastrophically, rough=${roughJump}, combined=${combinedJump}`)
}

function testWaterlinePocketBlockSimplification(): void {
  console.log('Testing waterline simplification on steep pocket block...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 0.5,
    stepover: 0.5,
  }
  project.operations = [operation]

  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected waterline cut moves on pocket block')
  assert(!hasReducibleAdjacentCutPair(result.moves),
    'expected simplifier to remove adjacent reducible collinear cut segments')
}

function testWaterlineRespectsTabZRange(): void {
  console.log('Testing waterline respects tab Z range...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const tabRect = { x: 0, y: 0, w: 3, h: 3 }
  project.tabs = [{
    id: 'tab1',
    name: 'Top tab',
    ...tabRect,
    z_top: 4,
    z_bottom: 3.2,
    visible: true,
  }]

  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 1,
    stepover: 0.5,
  }
  project.operations = [operation]
  const withTabRaw = generateFinishSurfaceToolpath(project, operation)
  const withTab = applyTabsToEdgeRoute(project, operation, withTabRaw)
  const withTabCuts = cutMoves(withTab.moves)

  const baselineProject = {
    ...project,
    tabs: [],
  }
  const withoutTab = generateFinishSurfaceToolpath(baselineProject, operation)
  const withoutTabCuts = cutMoves(withoutTab.moves)

  const topCutsInTab = withTabCuts.filter((move) => (
    move.to.z < 3.2 &&
    segmentIntersectsRect2D(move.from, move.to, tabRect)
  ))
  const lowerCutsInTabWithTab = withTabCuts.filter((move) => (
    move.to.z <= 2.6 &&
    segmentIntersectsRect2D(move.from, move.to, tabRect)
  ))
  const lowerCutsInTabWithoutTab = withoutTabCuts.filter((move) => (
    move.to.z <= 2.6 &&
    segmentIntersectsRect2D(move.from, move.to, tabRect)
  ))

  assert(withTabRaw.warnings.length === 0, `unexpected raw warnings: ${withTabRaw.warnings.join(', ')}`)
  assert(withTab.warnings.length === 0, `unexpected tab-aware warnings: ${withTab.warnings.join(', ')}`)
  assert(withoutTab.warnings.length === 0, `unexpected baseline warnings: ${withoutTab.warnings.join(', ')}`)
  assert(topCutsInTab.length === 0, `expected no below-tab cuts through tab area, got ${topCutsInTab.length}`)
  assert(lowerCutsInTabWithTab.length === lowerCutsInTabWithoutTab.length,
    `expected lower-level tab area cuts to match baseline when tab is inactive, withTab=${lowerCutsInTabWithTab.length}, baseline=${lowerCutsInTabWithoutTab.length}`)
}

function testWaterlineRespectsClampFootprint(): void {
  console.log('Testing waterline respects clamp footprint...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const clampRect = { x: 0, y: 0, w: 3, h: 3 }
  project.clamps = [{
    id: 'clamp1',
    name: 'Corner clamp',
    type: 'step_clamp',
    ...clampRect,
    height: 10,
    visible: true,
  }]

  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 1,
    stepover: 0.5,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const cutsInClamp = cuts.filter((move) => (
    segmentIntersectsRect2D(move.from, move.to, clampRect)
  ))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutsInClamp.length === 0, `expected no cuts in clamp footprint, got ${cutsInClamp.length}`)
}

// ── Run all tests ────────────────────────────────────────────────────────

testFinishSurfaceCoversLowerTopPlateau()
testFinishSurfaceRepeatGenerationIsStable()
testFinishSurfaceAvoidsSurroundingAddFeature()
testFinishSurfaceRespectsContainingPocketDepth()
testFinishSurfaceRespectsSplitPocketDepths()

testMaxContourGapIdenticalContours()
testMaxContourGapDifferentContours()
testMaxContourGapEmptyReturnsThickness()
testWaterlineCumulativeShadowProtectsUpperLevels()

testWaterlineGeneratesContourMoves()
testWaterlineStepLevelsDescend()
testWaterlineRepeatIsStable()
testWaterlineRespectsContainingPocketDepth()
testWaterlineRegionActsAsFilterNotBoundaryContour()
testWaterlineUsesCoarseZLevelsOnly()
testWaterlineLevelsAreConstantBands()
testWaterlineEmitsBandBoundaryLevels()
testWaterlineBallEndmillUsesSideContactZ()
testWaterlineReachesModelTop()
testWaterlineBlendsWithRoughInCombinedSimulation()
testWaterlinePocketBlockSimplification()
testWaterlineRespectsTabZRange()
testWaterlineRespectsClampFootprint()

console.log('finishSurface tests passed')
