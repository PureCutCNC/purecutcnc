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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Point } from '../../types/project'
import {
  boxedLoopEdgesScanned,
  boxLoop,
  pointInBoxedLoop,
  pointOnBoxedLoopEdge,
  resetBoxedLoopEdgesScanned,
} from './boxedLoop'
import { buildOffsetDomainCheck } from './tangentLink'

// The full walks as they stood before #923, kept verbatim as the reference.
function walkPointInPolygon(x: number, y: number, polygon: Point[]): boolean {
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

function walkPointOnPolygonEdge(x: number, y: number, polygon: Point[]): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const ax = polygon[i].x
    const ay = polygon[i].y
    const bx = polygon[j].x
    const by = polygon[j].y
    const dx = bx - ax
    const dy = by - ay
    const lenSq = dx * dx + dy * dy
    if (lenSq <= 1e-18) continue
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq))
    const qx = ax + dx * t - x
    const qy = ay + dy * t - y
    if (qx * qx + qy * qy <= 1e-12) return true
  }
  return false
}

/** Deterministic PRNG so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Points that probe every rule: vertices, points on edges, points a hair
 *  either side of the 1e-6 edge tolerance, vertex rows, and plain random ones. */
function probes(next: () => number, loop: Point[], span: number, offset: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    const t = next()
    const onEdge = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    out.push(a, onEdge)
    for (const nudge of [0.5e-6, 0.99e-6, 1.01e-6, 1.5e-6, 3e-6]) {
      out.push({ x: onEdge.x, y: onEdge.y + nudge }, { x: onEdge.x, y: onEdge.y - nudge })
      out.push({ x: onEdge.x + nudge, y: onEdge.y }, { x: a.x, y: a.y - nudge })
    }
    out.push({ x: offset + next() * span, y: a.y })
  }
  for (let k = 0; k < 400; k += 1) out.push({ x: offset + next() * span, y: offset + next() * span })
  return out
}

function assertMatchesWalk(loop: Point[], points: Point[], label: string): { inside: number; onEdge: number } {
  const boxed = boxLoop(loop)
  let inside = 0
  let onEdge = 0
  for (const p of points) {
    const expectedIn = walkPointInPolygon(p.x, p.y, loop)
    const expectedOn = walkPointOnPolygonEdge(p.x, p.y, loop)
    assert.equal(pointInBoxedLoop(boxed, p.x, p.y), expectedIn, `${label}: inside at (${p.x}, ${p.y})`)
    assert.equal(pointOnBoxedLoopEdge(boxed, p.x, p.y), expectedOn, `${label}: on edge at (${p.x}, ${p.y})`)
    if (expectedIn) inside += 1
    if (expectedOn) onEdge += 1
  }
  return { inside, onEdge }
}

test('indexed loop tests answer exactly as the full walks on random and grid-snapped loops', () => {
  const next = random(923)
  let inside = 0
  let onEdge = 0
  for (let trial = 0; trial < 80; trial += 1) {
    const count = 3 + Math.floor(next() * 60)
    // Half the loops snap to a coarse grid: shared rows, horizontal and
    // vertical edges, repeated vertices and self-intersections.
    const snap = trial % 2 === 0
    const loop = Array.from({ length: count }, () => snap
      ? { x: Math.floor(next() * 12) * 0.5, y: Math.floor(next() * 12) * 0.5 }
      : { x: next() * 6, y: next() * 6 })
    const counts = assertMatchesWalk(loop, probes(next, loop, 7, -0.5), `trial ${trial}`)
    inside += counts.inside
    onEdge += counts.onEdge
  }
  assert(inside > 1000 && onEdge > 1000, 'the probes must exercise both the interior and the boundary')
})

test('indexed loop tests match the walks at large coordinates and on degenerate loops', () => {
  const next = random(17)
  const far = Array.from({ length: 300 }, (_, i) => {
    const angle = (i / 300) * Math.PI * 2
    return { x: 1500 + 400 * Math.cos(angle) + next() * 3, y: -800 + 400 * Math.sin(angle) + next() * 3 }
  })
  assertMatchesWalk(far, probes(next, far, 900, 1000), 'far ring')
  assertMatchesWalk(far, probes(next, far, 900, -1300).map((p) => ({ x: p.x + 2400, y: p.y })), 'far ring, shifted probes')
  for (const loop of [[], [{ x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 2, y: 2 }], [{ x: 0, y: 1 }, { x: 3, y: 1 }, { x: 1, y: 1 }]]) {
    assertMatchesWalk(loop, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1.0000005 }, { x: 5, y: 5 }], `degenerate ${loop.length}`)
  }
})

// Measured 2026-09-29 on this fixture: 8.1 edges scanned per domain check with
// the index. The full walks read 4,000 to 8,000 per check here (the containment
// walk over the 4,000-vertex outer, then the edge walk when that says outside).
// The bound leaves room for a bucket-size change, not for a return to the walk.
const MAX_EDGES_PER_DOMAIN_CHECK = 20

test('a domain check on a dense outline reads a handful of edges, not the outline', () => {
  const outer = Array.from({ length: 4000 }, (_, i) => {
    const angle = (i / 4000) * Math.PI * 2
    const r = 5 + 0.6 * Math.sin(11 * angle)
    return { x: r * Math.cos(angle), y: r * Math.sin(angle) }
  })
  const check = buildOffsetDomainCheck([{ outer, islands: [] }])
  const next = random(3)
  resetBoxedLoopEdgesScanned()
  for (let query = 0; query < 2000; query += 1) check(next() * 10 - 5, next() * 10 - 5)
  const perCheck = boxedLoopEdgesScanned() / 2000
  assert(perCheck <= MAX_EDGES_PER_DOMAIN_CHECK, `${perCheck} edges scanned per domain check`)
})
