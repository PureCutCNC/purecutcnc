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
 * Tolerance-bounded flattening (issue #846): every point of the true curve is
 * within the tolerance of the polygon, for arcs, full circles and béziers.
 *
 * Run with: npx tsx src/engine/nesting/flatten.test.ts
 */

import { bezierPoint, circleProfile, type Point, type SketchProfile } from '../../types/project'
import { flattenProfileWithin } from './flatten'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function distanceToPolygon(p: Point, ring: Point[]): number {
  let best = Infinity
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)))
  }
  return best
}

function testCircle(): void {
  for (const [radius, tolerance] of [[30, 0.01], [2, 0.01], [500, 0.001]]) {
    const ring = flattenProfileWithin(circleProfile(0, 0, radius), tolerance)
    for (let step = 0; step < 3600; step += 1) {
      const angle = (step / 3600) * Math.PI * 2
      const d = distanceToPolygon({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }, ring)
      assert(d <= tolerance + 1e-12, `r${radius} tol ${tolerance}: deviation ${d}`)
    }
    // Not wastefully fine either: within 2× the minimal chord count.
    const minimal = Math.ceil(Math.PI / Math.acos(1 - tolerance / radius))
    assert(ring.length <= 2 * minimal + 2, `r${radius}: ${ring.length} points for a minimum of ${minimal}`)
  }
}

function testArcAndBezier(): void {
  const profile: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'arc', to: { x: 20, y: 0 }, center: { x: 10, y: 0 }, clockwise: true },
      { type: 'bezier', to: { x: 0, y: 0 }, control1: { x: 25, y: 30 }, control2: { x: -5, y: 30 } },
    ],
    closed: true,
  }
  const tolerance = 0.005
  const ring = flattenProfileWithin(profile, tolerance)
  for (let step = 0; step <= 1000; step += 1) {
    const t = step / 1000
    const onArc = { x: 10 - Math.cos(Math.PI * t) * 10, y: Math.sin(Math.PI * t) * 10 }
    assert(distanceToPolygon(onArc, ring) <= tolerance + 1e-12, `arc point ${t} off by more than the tolerance`)
    const onCurve = bezierPoint({ x: 20, y: 0 }, { x: 25, y: 30 }, { x: -5, y: 30 }, { x: 0, y: 0 }, t)
    assert(distanceToPolygon(onCurve, ring) <= tolerance + 1e-12, `bezier point ${t} off by more than the tolerance`)
  }
}

testCircle()
testArcAndBezier()
console.log('All nesting flatten tests passed')
