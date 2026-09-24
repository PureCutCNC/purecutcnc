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
 * The default packer strategies (issue #844). `expandByHalfGap` must contain
 * the exact offset: every point at distance gap/2 from a footprint lies inside
 * the grown footprint, corners included — the case Clipper's round joins get
 * wrong once their step count is rounded down.
 *
 * Run with: npx tsx src/engine/nesting/defaults.test.ts
 */

import type { Point } from '../../types/project'
import { expandByHalfGap, largestFirst } from './defaults'
import type { NestRing } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function inside(point: Point, rings: NestRing[]): boolean {
  let crossings = 0
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[i]
      const b = ring[j]
      if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
        crossings += 1
      }
    }
  }
  return crossings % 2 === 1
}

function testGrowthContainsExactOffset(): void {
  const shapes: [string, NestRing][] = [
    ['square', [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 25 }, { x: 0, y: 25 }]],
    ['sharp triangle', [{ x: 0, y: 0 }, { x: 40, y: 3 }, { x: 0, y: 6 }]],
    ['hexagon', Array.from({ length: 6 }, (_, i) => ({
      x: Math.cos((i * Math.PI) / 3) * 10,
      y: Math.sin((i * Math.PI) / 3) * 10,
    }))],
  ]
  for (const gap of [0.5, 4, 6, 12.7]) {
    for (const [label, ring] of shapes) {
      const grown = expandByHalfGap([ring], gap)
      // Just inside the exact offset boundary, around every vertex.
      const radius = gap / 2 - 1e-6
      for (const vertex of ring) {
        for (let step = 0; step < 360; step += 1) {
          const angle = (step * Math.PI) / 180
          const probe = { x: vertex.x + Math.cos(angle) * radius, y: vertex.y + Math.sin(angle) * radius }
          assert(inside(probe, grown), `${label}, gap ${gap}: ${JSON.stringify(probe)} is outside the growth`)
        }
      }
    }
  }
}

function wavyDisc(points: number): NestRing {
  // A many-vertex curved outline with concave dips, like a flattened glyph.
  return Array.from({ length: points }, (_, i) => {
    const angle = (i / points) * Math.PI * 2
    const radius = 20 + 3 * Math.sin(angle * 7)
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  })
}

function testSimplifiedGrowthStillContainsExactOffset(): void {
  const shapes: [string, NestRing][] = [
    ['wavy disc', wavyDisc(400)],
    ['square', [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 25, y: 25 }, { x: 0, y: 25 }]],
    ['sharp triangle', [{ x: 0, y: 0 }, { x: 40, y: 3 }, { x: 0, y: 6 }]],
  ]
  for (const tolerance of [0.05, 0.3]) {
    for (const gap of [0, 3, 6]) {
      for (const [label, ring] of shapes) {
        const grown = expandByHalfGap([ring], gap, tolerance)
        const radius = gap / 2 - 1e-6
        const probes = radius > 0 ? 72 : 1
        for (const vertex of ring) {
          for (let step = 0; step < probes; step += 1) {
            const angle = (step / probes) * Math.PI * 2
            const probe = { x: vertex.x + Math.cos(angle) * Math.max(radius, 0), y: vertex.y + Math.sin(angle) * Math.max(radius, 0) }
            assert(inside(probe, grown), `${label}, gap ${gap}, tol ${tolerance}: ${JSON.stringify(probe)} escapes the simplified growth`)
          }
        }
      }
    }
  }
  const plain = expandByHalfGap([wavyDisc(400)], 6)[0].length
  const simplified = expandByHalfGap([wavyDisc(400)], 6, 0.05)[0].length
  assert(simplified < plain / 2, `simplification cuts vertices: ${plain} → ${simplified}`)
}

function testLargestFirst(): void {
  const square = (id: string, size: number) => ({
    id,
    quantity: 1,
    rotations: [0],
    footprint: [[{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }]],
  })
  const order = largestFirst([square('b', 5), square('a', 20), square('c', 5)]).map((part) => part.id)
  assert(order.join() === 'a,b,c', `largest first, ties by id: got ${order.join()}`)
}

testGrowthContainsExactOffset()
testSimplifiedGrowthStillContainsExactOffset()
testLargestFirst()
console.log('All nesting default-strategy tests passed')
