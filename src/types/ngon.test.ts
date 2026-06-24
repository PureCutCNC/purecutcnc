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
 * Unit tests for ngonProfile — the regular polygon profile constructor.
 *
 * Run with: npx tsx src/types/ngon.test.ts
 */

import type { Point } from './project'
import { ngonProfile } from './project'

const ε = 1e-10

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function polygonArea(vertices: Point[]): number {
  // Shoelace formula
  let area = 0
  const n = vertices.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += vertices[i].x * vertices[j].y
    area -= vertices[j].x * vertices[i].y
  }
  return Math.abs(area) / 2
}

const cx = 0
const cy = 0
const circumradius = 10
const firstVertexAngle = 0

function testSegmentCount() {
  for (const n of [3, 6, 12]) {
    const profile = ngonProfile(cx, cy, n, circumradius, firstVertexAngle)
    assert(profile.segments.length === n, `expected ${n} segments, got ${profile.segments.length}`)
    assert(profile.segments.every((s) => s.type === 'line'), 'all segments should be lines')
  }
  console.log('segment count: PASSED')
}

function testEquilateral() {
  for (const n of [3, 6, 12]) {
    const profile = ngonProfile(cx, cy, n, circumradius, firstVertexAngle)
    const vertices: Point[] = [profile.start, ...profile.segments.map((s) => s.to)]
    const firstLen = dist(vertices[0], vertices[1])
    for (let i = 1; i < n; i++) {
      const len = dist(vertices[i], vertices[(i + 1) % n])
      assert(Math.abs(len - firstLen) < ε, `edge ${i} length ${len} ≠ ${firstLen} for n=${n}`)
    }
  }
  console.log('equilateral: PASSED')
}

function testCircumradius() {
  for (const n of [3, 6, 8]) {
    const profile = ngonProfile(cx, cy, n, circumradius, firstVertexAngle)
    const vertices: Point[] = [profile.start, ...profile.segments.map((s) => s.to)]
    const center: Point = { x: cx, y: cy }
    for (let i = 0; i < n; i++) {
      const d = dist(vertices[i], center)
      assert(Math.abs(d - circumradius) < ε, `vertex ${i} distance ${d} ≠ ${circumradius} for n=${n}`)
    }
  }
  console.log('circumradius: PASSED')
}

function testFirstVertexAngle() {
  const θ = Math.PI / 3 // 60 degrees
  const profile = ngonProfile(cx, cy, 6, circumradius, θ)
  const expectedX = cx + circumradius * Math.cos(θ)
  const expectedY = cy + circumradius * Math.sin(θ)
  assert(Math.abs(profile.start.x - expectedX) < ε, `start.x ${profile.start.x} ≠ ${expectedX}`)
  assert(Math.abs(profile.start.y - expectedY) < ε, `start.y ${profile.start.y} ≠ ${expectedY}`)
  console.log('first vertex angle: PASSED')
}

function testClosure() {
  for (const n of [3, 5, 8]) {
    const profile = ngonProfile(cx, cy, n, circumradius, firstVertexAngle)
    const lastTo = profile.segments[profile.segments.length - 1].to
    assert(Math.abs(lastTo.x - profile.start.x) < ε, `n=${n}: lastTo.x ${lastTo.x} ≠ start.x ${profile.start.x}`)
    assert(Math.abs(lastTo.y - profile.start.y) < ε, `n=${n}: lastTo.y ${lastTo.y} ≠ start.y ${profile.start.y}`)
    assert(profile.closed === true, `n=${n}: closed should be true`)
  }
  console.log('closure: PASSED')
}

function testTriangleArea() {
  const profile = ngonProfile(cx, cy, 3, circumradius, firstVertexAngle)
  const vertices: Point[] = [profile.start, ...profile.segments.map((s) => s.to)]
  const area = polygonArea(vertices)
  // Area of equilateral triangle with circumradius r: (3√3/4) * r²
  const expected = (3 * Math.sqrt(3) / 4) * circumradius * circumradius
  assert(Math.abs(area - expected) < ε * 100, `triangle area ${area} ≠ ${expected}`)
  console.log('triangle area: PASSED')
}

function testHexagonArea() {
  const profile = ngonProfile(cx, cy, 6, circumradius, firstVertexAngle)
  const vertices: Point[] = [profile.start, ...profile.segments.map((s) => s.to)]
  const area = polygonArea(vertices)
  // Area of regular hexagon with circumradius r: (3√3/2) * r²
  const expected = (3 * Math.sqrt(3) / 2) * circumradius * circumradius
  assert(Math.abs(area - expected) < ε * 100, `hexagon area ${area} ≠ ${expected}`)
  console.log('hexagon area: PASSED')
}

try {
  testSegmentCount()
  testEquilateral()
  testCircumradius()
  testFirstVertexAngle()
  testClosure()
  testTriangleArea()
  testHexagonArea()
  console.log('\nAll ngonProfile tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
