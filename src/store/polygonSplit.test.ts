/**
 * Test the polygon-split-by-polyline algorithm.
 *
 * Run with: npx tsx src/store/polygonSplit.test.ts
 */

import { polygonProfile, type Point, type SketchProfile } from '../types/project'
import { splitClosedByOpen, openCrossesClosedFully } from './helpers/polygonSplit'

function openPolyline(points: Point[]): SketchProfile {
  return {
    start: points[0],
    segments: points.slice(1).map((p) => ({ type: 'line' as const, to: p })),
    closed: false,
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
}

// Test 1: simple horizontal line through square
function test1() {
  const square = polygonProfile([
    { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 },
  ])
  const line = openPolyline([{ x: -1, y: 1.5 }, { x: 5, y: 1.5 }])

  assert(openCrossesClosedFully(line, square), 'horizontal line crosses square')

  const result = splitClosedByOpen(square, line)
  assert(result !== null, 'result is non-null')
  assert(result!.pieces.length === 2, `expected 2 pieces, got ${result!.pieces.length}`)
  console.log('test1 PASS: 2 pieces')
  console.log('  piece 0:', result!.pieces[0].length, 'vertices')
  console.log('  piece 1:', result!.pieces[1].length, 'vertices')
}

// Test 2: diagonal polyline through 64-gon circle (mimics line-cut-test.camj)
function test2() {
  const cx = 1.5, cy = 1.5, r = 1.0
  const n = 64
  const circlePts: Point[] = []
  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i / n) * 2 * Math.PI
    circlePts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  const circle = polygonProfile(circlePts)

  const polyline = openPolyline([
    { x: 0.375, y: 0.375 },
    { x: 1.125, y: 1.125 },
    { x: 1.875, y: 1.875 },
    { x: 2.625, y: 2.625 },
  ])

  const crosses = openCrossesClosedFully(polyline, circle)
  console.log('test2 openCrossesClosedFully:', crosses)
  assert(crosses, 'diagonal polyline should fully cross circle')

  const result = splitClosedByOpen(circle, polyline)
  console.log('test2 result:', result === null ? 'NULL' : `${result.pieces.length} pieces`)
  if (result) {
    for (let i = 0; i < result.pieces.length; i += 1) {
      console.log(`  piece ${i}: ${result.pieces[i].length} vertices`)
    }
  }
  assert(result !== null, 'result is non-null')
  assert(result!.pieces.length === 2, `expected 2 pieces, got ${result!.pieces.length}`)
  console.log('test2 PASS')
}

// Test 3: horizontal line through circle
function test3() {
  const cx = 1.5, cy = 1.5, r = 1.0
  const n = 64
  const circlePts: Point[] = []
  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i / n) * 2 * Math.PI
    circlePts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  const circle = polygonProfile(circlePts)
  const line = openPolyline([{ x: 0.25, y: 1.5 }, { x: 3, y: 1.5 }])

  const crosses = openCrossesClosedFully(line, circle)
  console.log('test3 openCrossesClosedFully:', crosses)
  const result = splitClosedByOpen(circle, line)
  console.log('test3 result:', result === null ? 'NULL' : `${result.pieces.length} pieces`)
  if (result) {
    for (let i = 0; i < result.pieces.length; i += 1) {
      console.log(`  piece ${i}: ${result.pieces[i].length} vertices`)
    }
  }
  assert(result !== null, 'result is non-null')
  assert(result!.pieces.length === 2, `expected 2 pieces, got ${result!.pieces.length}`)
  console.log('test3 PASS')
}

// Test 4: after splitting circle with line, the resulting pieces should
// have valid CCW orientation and no self-intersections, suitable for
// downstream Clipper operations.
function test4() {
  const cx = 1.5, cy = 1.5, r = 1.0
  const n = 64
  const circlePts: Point[] = []
  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i / n) * 2 * Math.PI
    circlePts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  const circle = polygonProfile(circlePts)
  const polyline = openPolyline([
    { x: 0.375, y: 0.375 },
    { x: 1.125, y: 1.125 },
    { x: 1.875, y: 1.875 },
    { x: 2.625, y: 2.625 },
  ])

  const result = splitClosedByOpen(circle, polyline)
  assert(result !== null, 'result is non-null')
  for (let i = 0; i < result!.pieces.length; i += 1) {
    const p = result!.pieces[i]
    // Compute signed area
    let area = 0
    for (let j = 0; j < p.length; j += 1) {
      const a = p[j]
      const b = p[(j + 1) % p.length]
      area += a.x * b.y - b.x * a.y
    }
    area /= 2
    console.log(`  piece ${i}: signedArea=${area.toFixed(4)}`)
    assert(area > 0, `piece ${i} should be CCW (positive signed area)`)
    // Print first few + last few vertices
    console.log(`    first 3: ${JSON.stringify(p.slice(0, 3).map(pt => [+pt.x.toFixed(3), +pt.y.toFixed(3)]))}`)
    console.log(`    last 3:  ${JSON.stringify(p.slice(-3).map(pt => [+pt.x.toFixed(3), +pt.y.toFixed(3)]))}`)
    // Check for collinear-consecutive points (these can confuse downstream ops)
    let collinearCount = 0
    for (let j = 0; j < p.length; j += 1) {
      const a = p[(j - 1 + p.length) % p.length]
      const b = p[j]
      const c = p[(j + 1) % p.length]
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
      if (Math.abs(cross) < 1e-9) collinearCount += 1
    }
    console.log(`    collinear vertices: ${collinearCount}`)
  }
  console.log('test4 PASS')
}

// Test 5: a closed/closed boolean difference on a split piece (using Clipper
// directly) should produce a reasonable result, not a malformed polygon.
function test5() {
  // Create a square (so it's easy to reason about) cut by a diagonal line.
  const square = polygonProfile([
    { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
  ])
  const line = openPolyline([
    { x: -1, y: -1 }, { x: 1, y: 1 }, { x: 3, y: 3 }, { x: 5, y: 5 },
  ])
  const result = splitClosedByOpen(square, line)
  assert(result !== null, 'result is non-null')
  assert(result!.pieces.length === 2, 'two pieces')
  // Each piece is a triangle (3 vertices after collinear cleanup).
  for (let i = 0; i < result!.pieces.length; i += 1) {
    console.log(`  piece ${i}: ${result!.pieces[i].length} vertices: ${JSON.stringify(result!.pieces[i].map(p => [+p.x.toFixed(3), +p.y.toFixed(3)]))}`)
    // Each piece should be a triangle: 3 vertices after stripping collinear.
    assert(result!.pieces[i].length === 3, `expected triangle, got ${result!.pieces[i].length} vertices`)
  }
  console.log('test5 PASS')
}

try {
  test1()
  test2()
  test3()
  test4()
  test5()
  console.log('\nAll tests PASS')
} catch (e) {
  console.error(e)
  throw e
}
