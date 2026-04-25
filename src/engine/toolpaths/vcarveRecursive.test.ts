/**
 * Unit tests for vcarveRecursive geometry helpers and integration.
 * Run with: npx tsx src/engine/toolpaths/vcarveRecursive.test.ts
 */

import type { Operation, Point, Project, SketchFeature, Tool } from '../../types/project'
import { defaultTool, newProject, polygonProfile, rectProfile } from '../../types/project'
import { detectCorners, stepCorners } from './vcarveRecursive'
import { generateVCarveRecursiveToolpath } from './vcarveRecursive'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function squareCCW(cx: number, cy: number, half: number): Point[] {
  return [
    { x: cx - half, y: cy - half },
    { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half },
    { x: cx - half, y: cy + half },
  ]
}

function circlePts(cx: number, cy: number, r: number, n: number): Point[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
}

function semicircleTopCCW(r: number, arcSegments: number): Point[] {
  const pts: Point[] = [
    { x: -r, y: 0 },
    { x: r, y: 0 },
  ]
  for (let i = 1; i < arcSegments; i += 1) {
    const a = (Math.PI * i) / arcSegments
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) })
  }
  return pts
}

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((m) => m.kind === 'cut')
}

// ---------------------------------------------------------------------------
// detectCorners tests
// ---------------------------------------------------------------------------

function testDetectCornersSquare(): void {
  console.log('Testing detectCorners on a square...')

  const square = squareCCW(0, 0, 5)
  const corners = detectCorners(square)
  assert(corners.length === 4, `expected 4 corners on square, got ${corners.length}`)

  // Every returned point must be a vertex of the square.
  for (const c of corners) {
    const onSquare = square.some((v) => approx(v.x, c.x) && approx(v.y, c.y))
    assert(onSquare, `corner (${c.x}, ${c.y}) is not a vertex of the square`)
  }

  console.log('detectCorners square: PASSED')
}

function testDetectCornersCircleApprox(): void {
  console.log('Testing detectCorners on 32-gon circle approximation...')

  // Each vertex has turn angle 360/32 = 11.25° — well below the 15° threshold.
  const pts = circlePts(0, 0, 10, 32)
  const corners = detectCorners(pts)
  assert(corners.length === 0, `expected 0 corners on 32-gon, got ${corners.length}`)

  console.log('detectCorners circle approx: PASSED')
}

function testDetectCornersDegenerate(): void {
  console.log('Testing detectCorners with degenerate inputs...')

  assert(detectCorners([]).length === 0, 'empty → 0 corners')
  assert(detectCorners([{ x: 0, y: 0 }]).length === 0, '1 point → 0 corners')
  assert(detectCorners([{ x: 0, y: 0 }, { x: 1, y: 0 }]).length === 0, '2 points → 0 corners')

  console.log('detectCorners degenerate: PASSED')
}

function testDetectCornersTriangle(): void {
  console.log('Testing detectCorners on a triangle...')

  // Equilateral triangle CCW — all 3 corners have 60° turn angles (> 15°).
  const r = 10
  const pts: Point[] = [0, 1, 2].map((i) => ({
    x: r * Math.cos((2 * Math.PI * i) / 3),
    y: r * Math.sin((2 * Math.PI * i) / 3),
  }))
  const corners = detectCorners(pts)
  assert(corners.length === 3, `expected 3 corners on triangle, got ${corners.length}`)

  console.log('detectCorners triangle: PASSED')
}

function testDetectCornersSmoothsOffsetNoise(): void {
  console.log('Testing detectCorners smoothing suppresses tiny offset kinks...')

  const noisyRect: Point[] = [
    { x: 0, y: 0 },
    { x: 12, y: 0 },
    { x: 12, y: 8 },
    { x: 8, y: 8 },
    { x: 6.0020, y: 8.0000 },
    { x: 6.0015, y: 8.0030 },
    { x: 6.0010, y: 8.0002 },
    { x: 6.0005, y: 8.0028 },
    { x: 6.0000, y: 8.0000 },
    { x: 4, y: 8 },
    { x: 0, y: 8 },
  ]

  const rawCorners = detectCorners(noisyRect)
  const smoothedCorners = detectCorners(noisyRect, 0.01)

  assert(rawCorners.length > 4, `expected noisy contour to expose extra corners, got ${rawCorners.length}`)
  assert(smoothedCorners.length === 4, `expected smoothing to recover 4 rectangle corners, got ${smoothedCorners.length}`)

  console.log('detectCorners smoothing noise: PASSED')
}

// ---------------------------------------------------------------------------
// stepCorners tests
// ---------------------------------------------------------------------------

function testStepCornersConnectsToCorners(): void {
  console.log('Testing stepCorners connects to corners, not smooth vertices...')

  const outer = squareCCW(0, 0, 5)   // corners at (±5, ±5)
  const inner = squareCCW(0, 0, 3)   // corners at (±3, ±3), all detected as corners
  const outerCorners = detectCorners(outer)
  assert(outerCorners.length === 4, 'outer square has 4 corners')

  const stepSize = 2
  const { cuts, nextCorners } = stepCorners(outerCorners, outer, inner, 0, -1, stepSize)

  assert(cuts.length === 4, `expected 4 cuts, got ${cuts.length}`)
  assert(nextCorners.length === 4, `expected 4 nextCorners, got ${nextCorners.length}`)

  // All cut destinations must be corners of the inner square.
  const innerDetected = detectCorners(inner)
  for (const nc of nextCorners) {
    const isCorner = innerDetected.some((c) => approx(c.x, nc.x) && approx(c.y, nc.y))
    assert(isCorner, `nextCorner (${nc.x}, ${nc.y}) should be a detected corner of inner square`)
  }

  console.log('stepCorners connects to corners: PASSED')
}

function testStepCornersFallsBackForSmoothContour(): void {
  console.log('Testing stepCorners fallback to nearest vertex when no next corners...')

  // Active corner at the centre top, next contour is a 32-gon (no corners).
  // The fallback should find the nearest vertex within 1.5× stepSize.
  const activeCorners: Point[] = [{ x: 0, y: 9 }]
  const smooth = circlePts(0, 0, 8, 32)   // radius 8, no detected corners
  assert(detectCorners(smooth).length === 0, 'smooth contour has no corners (precondition)')
  const currentContour: Point[] = [
    { x: -8, y: 0 },
    { x: 0, y: 9 },
    { x: 8, y: 0 },
  ]

  const stepSize = 1
  const { cuts, nextCorners } = stepCorners(activeCorners, currentContour, smooth, 0, -1, stepSize)

  // Nearest vertex on r=8 circle to (0,9) is approximately (0, 8) — distance 1 = stepSize.
  assert(cuts.length === 1, `expected 1 fallback cut, got ${cuts.length}`)
  assert(nextCorners.length === 1, `expected 1 nextCorner, got ${nextCorners.length}`)
  // The cut destination must be the nearest circle vertex to (0, 9).
  const dest = nextCorners[0]
  const dist = Math.hypot(dest.x - 0, dest.y - 9)
  assert(dist <= stepSize * 1.5, `fallback destination too far: ${dist.toFixed(3)} > ${stepSize * 1.5}`)

  console.log('stepCorners fallback smooth: PASSED')
}

function testStepCornersFallsBackWhenLocalCornerDisappears(): void {
  console.log('Testing stepCorners fallback when the local corner disappears but other corners remain...')

  const activeCorners: Point[] = [{ x: 0, y: 4 }]
  const nextContour = semicircleTopCCW(3, 16)
  const detected = detectCorners(nextContour)
  assert(detected.length === 2, `expected 2 retained corners on semicircle-top contour, got ${detected.length}`)
  const currentContour: Point[] = [
    { x: -3, y: 0 },
    { x: 0, y: 4 },
    { x: 3, y: 0 },
  ]

  const stepSize = 1
  const { cuts, nextCorners, rejected } = stepCorners(activeCorners, currentContour, nextContour, 0, -1, stepSize)

  assert(cuts.length === 1, `expected 1 fallback cut, got ${cuts.length}`)
  assert(nextCorners.length === 1, `expected 1 nextCorner, got ${nextCorners.length}`)
  assert(rejected.length === 0, `expected 0 rejected corners, got ${rejected.length}`)
  assert(approx(nextCorners[0].x, 0) && approx(nextCorners[0].y, 3), `expected fallback target (0, 3), got (${nextCorners[0].x}, ${nextCorners[0].y})`)
  assert(!detected.some((c) => approx(c.x, nextCorners[0].x) && approx(c.y, nextCorners[0].y)), 'fallback should use a smooth vertex, not a detected corner')

  console.log('stepCorners fallback mixed contour: PASSED')
}

function testStepCornersAcceptsAcuteTipJump(): void {
  console.log('Testing stepCorners allows longer corner jumps for acute tips...')

  const outer: Point[] = [
    { x: -2, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: 8 },
  ]
  const inner: Point[] = [
    { x: -1.1, y: 1 },
    { x: 1.1, y: 1 },
    { x: 0, y: 3.9 },
  ]
  const outerCorners = detectCorners(outer)
  assert(outerCorners.length === 3, `expected 3 triangle corners, got ${outerCorners.length}`)

  const stepSize = 1
  const { cuts, nextCorners, rejected } = stepCorners(outerCorners, outer, inner, 0, -1, stepSize)

  assert(cuts.length === 3, `expected 3 corner cuts, got ${cuts.length}`)
  assert(nextCorners.length === 3, `expected 3 nextCorners, got ${nextCorners.length}`)
  assert(rejected.length === 0, `expected 0 rejected corners, got ${rejected.length}`)
  assert(nextCorners.some((point) => approx(point.x, 0) && approx(point.y, 3.9)), 'acute tip should connect to the inset tip corner')

  console.log('stepCorners acute tip jump: PASSED')
}

function testStepCornersDistanceGuardPreventsJump(): void {
  console.log('Testing stepCorners distance guard blocks far jumps...')

  // Active corner at origin, inner square is 100 units away — should produce no cuts.
  const activeCorners: Point[] = [{ x: 0, y: 0 }]
  const farSquare = squareCCW(100, 100, 5)
  const currentContour = squareCCW(0, 0, 5)
  const stepSize = 2   // maxJump = 6 for corner targets, < 94 min-distance

  const { cuts } = stepCorners(activeCorners, currentContour, farSquare, 0, -1, stepSize)
  assert(cuts.length === 0, `expected 0 cuts for far target, got ${cuts.length}`)

  console.log('stepCorners distance guard: PASSED')
}

function testStepCornersDeduplicatesConvergingChains(): void {
  console.log('Testing stepCorners deduplicates chains that converge to same corner...')

  // Diamond CCW: corners at (0,5), (-5,0), (0,-5), (5,0).
  const diamond: Point[] = [
    { x: 0, y: 5 },
    { x: -5, y: 0 },
    { x: 0, y: -5 },
    { x: 5, y: 0 },
  ]
  const diamondCorners = detectCorners(diamond)
  assert(diamondCorners.length === 4, `diamond has 4 corners, got ${diamondCorners.length}`)

  // Two active corners very close together, both mapping to (5, 0).
  const activeCorners: Point[] = [{ x: 4.9, y: 0 }, { x: 5.1, y: 0 }]
  const currentContour = diamond
  const stepSize = 1   // maxJump = 3; both corners are 0.1 from (5,0) ✓

  const { cuts, nextCorners } = stepCorners(activeCorners, currentContour, diamond, 0, -1, stepSize)

  // Two cuts emitted (from different starting points) but both target (5, 0).
  assert(cuts.length === 2, `expected 2 cuts, got ${cuts.length}`)
  // After dedup with 1e-9 threshold, identical destinations collapse to 1.
  assert(nextCorners.length === 1, `expected 1 deduped nextCorner, got ${nextCorners.length}`)
  assert(approx(nextCorners[0].x, 5) && approx(nextCorners[0].y, 0), 'deduped target should be (5, 0)')

  console.log('stepCorners convergence dedup: PASSED')
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

function makeVBit(): Tool {
  return { ...defaultTool('mm', 1), id: 't1', type: 'v_bit', vBitAngle: 60, diameter: 6 }
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

function makeVCarveRecursiveOp(featureIds: string[], stepover = 0.4): Operation {
  return {
    id: 'op1',
    name: 'op',
    kind: 'v_carve_recursive',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 't1',
    stepdown: 2,
    stepover,
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
  }
}

function baseProject(tools: Tool[], features: SketchFeature[]): Project {
  return { ...newProject('test', 'mm'), tools, features }
}

function testVCarveRecursiveProducesCutsForSquare(): void {
  console.log('Testing generateVCarveRecursiveToolpath on a 20×20 square...')

  const proj = baseProject([makeVBit()], [makeRectFeature('f1', 0, 0, 20, 20, -5)])
  const op = makeVCarveRecursiveOp(['f1'])
  const result = generateVCarveRecursiveToolpath(proj, op)

  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, `expected cut moves, got 0 (warnings: ${result.warnings.join(', ')})`)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)

  console.log(`generateVCarveRecursiveToolpath square: ${cuts.length} cuts PASSED`)
}

function testVCarveRecursiveCutsStayInsideShape(): void {
  console.log('Testing cuts stay inside narrow 30×5 rectangle (C-tip analogue)...')

  // A narrow rectangle simulates the tapered tip where the fan-of-connections bug appeared.
  const proj = baseProject([makeVBit()], [makeRectFeature('f1', 0, 0, 30, 5, -5)])
  const op = makeVCarveRecursiveOp(['f1'])
  const result = generateVCarveRecursiveToolpath(proj, op)

  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'expected cut moves on narrow rectangle')

  const MARGIN = 0.5
  for (const move of cuts) {
    for (const pt of [move.from, move.to]) {
      assert(pt.x >= -MARGIN && pt.x <= 30 + MARGIN, `cut x=${pt.x.toFixed(3)} outside [0, 30]`)
      assert(pt.y >= -MARGIN && pt.y <= 5 + MARGIN, `cut y=${pt.y.toFixed(3)} outside [0, 5]`)
    }
  }

  console.log(`generateVCarveRecursiveToolpath narrow rect: ${cuts.length} cuts, all within bounds PASSED`)
}

function testVCarveRecursiveDeepNarrowChannelReachesInnerOffsets(): void {
  console.log('Testing chain reaches inner offsets in narrow channel (bug 1 regression)...')

  // A narrow rectangle 10×2 mm, step 0.2 mm. With 5 inset levels before collapse,
  // the chain should produce cuts at multiple Z depths — not just at the surface.
  const proj = baseProject([makeVBit()], [makeRectFeature('f1', 0, 0, 10, 2, -5)])
  const op = makeVCarveRecursiveOp(['f1'], 0.2)
  const result = generateVCarveRecursiveToolpath(proj, op)

  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'expected cuts on narrow channel')

  // Collect unique Z values rounded to 2 decimal places.
  const zValues = new Set(cuts.map((m) => Math.round(m.to.z * 100) / 100))
  // With a 2mm wide channel and 0.2mm step, there should be ≥ 3 distinct Z levels
  // before max depth clamps it. If the chain died after 1 step, we'd see only 1 Z.
  assert(zValues.size >= 3, `expected ≥ 3 distinct Z levels, got ${zValues.size}: [${[...zValues].join(', ')}]`)

  console.log(`generateVCarveRecursiveToolpath narrow channel: ${zValues.size} Z levels PASSED`)
}

function testVCarveRecursiveCollapseConnectsToMicroInset(): void {
  console.log('Testing collapse adds final corner connections into the micro-inset contour...')

  // A 2x2 square with a very large stepover collapses immediately at the
  // normal step, but the micro-inset still survives. The generator should
  // connect the outer corners down to that final contour before emitting it.
  const proj = baseProject([makeVBit()], [makeRectFeature('f1', 0, 0, 2, 2, -5)])
  const op = makeVCarveRecursiveOp(['f1'], 6)
  const result = generateVCarveRecursiveToolpath(proj, op)

  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'expected cut moves on collapse-to-micro-inset case')

  const slopedCuts = cuts.filter((move) => !approx(move.from.z, move.to.z))
  assert(slopedCuts.length >= 4, `expected at least 4 sloped collapse-bridge cuts, got ${slopedCuts.length}`)
  assert(slopedCuts.every((move) => move.to.z < move.from.z), 'collapse-bridge cuts should descend into the micro-inset contour')

  console.log(`generateVCarveRecursiveToolpath collapse bridge: ${slopedCuts.length} sloped cuts PASSED`)
}

function testVCarveRecursiveSplitConnectsAcrossChildren(): void {
  console.log('Testing split bridges parent corners into the nearest child corners before recursion...')

  // Two lobes connected by a very thin waist. The first inset splits the
  // parent region into two children, so the generator must bridge into the
  // child corners at the split depth before recursing further.
  const splitShape: Point[] = [
    { x: -6, y: -4 },
    { x: -2, y: -4 },
    { x: -2, y: -0.4 },
    { x: 2, y: -0.4 },
    { x: 2, y: -4 },
    { x: 6, y: -4 },
    { x: 6, y: 4 },
    { x: 2, y: 4 },
    { x: 2, y: 0.4 },
    { x: -2, y: 0.4 },
    { x: -2, y: 4 },
    { x: -6, y: 4 },
  ]
  const proj = baseProject([makeVBit()], [makePolygonFeature('f1', splitShape, -5)])
  const op = makeVCarveRecursiveOp(['f1'], 0.5)
  const result = generateVCarveRecursiveToolpath(proj, op)

  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'expected cut moves on split-bridge case')

  const firstStepZ = -Math.min(op.maxCarveDepth, op.stepover / Math.tan((60 * Math.PI) / 360))
  const topSlopedCuts = cuts.filter((move) => approx(move.from.z, 0) && approx(move.to.z, firstStepZ))
  assert(topSlopedCuts.length >= 4, `expected at least 4 parent-to-child split bridge cuts, got ${topSlopedCuts.length}`)

  const leftBridgeCount = topSlopedCuts.filter((move) => move.to.x < 0).length
  const rightBridgeCount = topSlopedCuts.filter((move) => move.to.x > 0).length
  assert(leftBridgeCount >= 2, `expected split bridges into left child, got ${leftBridgeCount}`)
  assert(rightBridgeCount >= 2, `expected split bridges into right child, got ${rightBridgeCount}`)

  console.log(`generateVCarveRecursiveToolpath split bridge: ${topSlopedCuts.length} top-depth cuts PASSED`)
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

try {
  testDetectCornersSquare()
  testDetectCornersCircleApprox()
  testDetectCornersDegenerate()
  testDetectCornersTriangle()
  testDetectCornersSmoothsOffsetNoise()
  testStepCornersConnectsToCorners()
  testStepCornersFallsBackForSmoothContour()
  testStepCornersFallsBackWhenLocalCornerDisappears()
  testStepCornersAcceptsAcuteTipJump()
  testStepCornersDistanceGuardPreventsJump()
  testStepCornersDeduplicatesConvergingChains()
  testVCarveRecursiveProducesCutsForSquare()
  testVCarveRecursiveCutsStayInsideShape()
  testVCarveRecursiveDeepNarrowChannelReachesInnerOffsets()
  testVCarveRecursiveCollapseConnectsToMicroInset()
  testVCarveRecursiveSplitConnectsAcrossChildren()
  console.log('\nAll vcarveRecursive tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
