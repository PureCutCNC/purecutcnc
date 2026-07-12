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
 * Tests for the join-connectivity predicates in clipping.ts (issue #271):
 * features sharing a positive-length boundary segment are joinable, while
 * corner-only contact and disjoint features remain unjoinable.
 *
 * Run with: npx tsx src/store/helpers/clipping.test.ts
 */

import {
  polygonProfile,
  rectProfile,
  type SketchFeature,
  type SketchProfile,
} from '../../types/project'
import {
  featuresFormConnectedOverlapGroup,
  featuresOverlap,
  largestConnectedOverlapGroup,
} from './clipping'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function featureFromProfile(id: string, profile: SketchProfile): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect' as const,
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add' as const,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  } as SketchFeature
}

function rectFeature(id: string, x: number, y: number, w: number, h: number): SketchFeature {
  return featureFromProfile(id, rectProfile(x, y, w, h))
}

// ────────────────────────────────────────────────────────────────────

console.log('\nClipping — join connectivity (featuresOverlap)')

test('full shared edge connects two rects', () => {
  const a = rectFeature('a', 0, 0, 10, 10)
  const b = rectFeature('b', 10, 0, 10, 10)
  assert(featuresOverlap(a, b), 'rects sharing a full edge must overlap for join')
  assert(featuresOverlap(b, a), 'predicate must be symmetric')
})

test('partial shared edge connects two rects', () => {
  const a = rectFeature('a', 0, 0, 10, 10)
  const b = rectFeature('b', 10, 4, 10, 10)
  assert(featuresOverlap(a, b), 'rects sharing a partial edge must overlap for join')
})

test('corner-only contact does not connect', () => {
  const a = rectFeature('a', 0, 0, 10, 10)
  const b = rectFeature('b', 10, 10, 10, 10)
  assert(!featuresOverlap(a, b), 'corner-touching rects must not count as joinable')
})

test('disjoint rects do not connect', () => {
  const a = rectFeature('a', 0, 0, 10, 10)
  const b = rectFeature('b', 30, 0, 10, 10)
  assert(!featuresOverlap(a, b), 'disjoint rects must not overlap')
})

test('area overlap still connects (regression)', () => {
  const a = rectFeature('a', 0, 0, 10, 10)
  const b = rectFeature('b', 5, 0, 10, 10)
  assert(featuresOverlap(a, b), 'area-overlapping rects must keep overlapping')
})

test('open profile never connects', () => {
  const a = rectFeature('a', 0, 0, 10, 10)
  const openProfile = { ...rectProfile(10, 0, 10, 10), closed: false }
  const b = featureFromProfile('b', openProfile)
  assert(!featuresOverlap(a, b), 'open profiles are not joinable')
})

test('shared edges forming an enclosed hole still connect', () => {
  // U-shape opening upward; the bar caps it across the top, sharing the
  // tops of both prongs. Their union is an outer contour plus a hole, so
  // the predicate must not assume a single-path union result.
  const u = featureFromProfile('u', polygonProfile([
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 30 },
    { x: 20, y: 30 },
    { x: 20, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: 30 },
    { x: 0, y: 30 },
  ]))
  const bar = rectFeature('bar', 0, 30, 30, 10)
  assert(featuresOverlap(u, bar), 'hole-forming shared-edge union must connect')
})

console.log('\nClipping — connectivity grouping')

test('largestConnectedOverlapGroup chains shared edges', () => {
  const a = rectFeature('a', 0, 0, 10, 10)
  const b = rectFeature('b', 10, 0, 10, 10)
  const c = rectFeature('c', 20, 0, 10, 10)
  const d = rectFeature('d', 50, 50, 10, 10)
  const group = largestConnectedOverlapGroup([a, b, c, d])
  const ids = group.map((feature) => feature.id).sort()
  assert(ids.join(',') === 'a,b,c', `expected a,b,c got ${ids.join(',')}`)
})

test('largestConnectedOverlapGroup excludes corner-touching feature', () => {
  const a = rectFeature('a', 0, 0, 10, 10)
  const b = rectFeature('b', 10, 0, 10, 10)
  const corner = rectFeature('corner', 20, 10, 10, 10)
  const group = largestConnectedOverlapGroup([a, b, corner])
  const ids = group.map((feature) => feature.id).sort()
  assert(ids.join(',') === 'a,b', `expected a,b got ${ids.join(',')}`)
})

test('featuresFormConnectedOverlapGroup accepts shared-edge pair', () => {
  const a = rectFeature('a', 0, 0, 10, 10)
  const b = rectFeature('b', 10, 0, 10, 10)
  assert(featuresFormConnectedOverlapGroup([a, b]), 'shared-edge pair must form a group')
})

test('featuresFormConnectedOverlapGroup rejects corner-touching pair', () => {
  const a = rectFeature('a', 0, 0, 10, 10)
  const b = rectFeature('b', 10, 10, 10, 10)
  assert(!featuresFormConnectedOverlapGroup([a, b]), 'corner-touching pair must not form a group')
})

// ── Results ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed${failed > 0 ? ' ❌' : ' ✓'}\n`)

if (failed > 0) throw new Error(`${failed} test(s) failed`)
