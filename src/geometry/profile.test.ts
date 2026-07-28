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
 * Unit tests for the layer-neutral profile helpers.
 *
 * The `circle` cases are the point of this file: the former private copies in
 * `src/text/index.ts` branched on `'arc'` only, so a circle segment kept an
 * untranslated `center`. See issue #234.
 *
 * Run with: npx tsx src/geometry/profile.test.ts
 */

import { clonePoint, cloneProfile, transformProfile, translatePoint, translateProfile } from './profile'
import type { Point, SketchProfile } from '../types/project'

const ε = 1e-9

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertPoint(actual: Point, expected: Point, message: string) {
  assert(
    Math.abs(actual.x - expected.x) <= ε && Math.abs(actual.y - expected.y) <= ε,
    `${message}: expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`,
  )
}

/** One profile carrying every segment kind that has points beyond `to`. */
function mixedProfile(): SketchProfile {
  return {
    start: { x: 1, y: 2 },
    segments: [
      { type: 'line', to: { x: 3, y: 4 } },
      { type: 'arc', to: { x: 5, y: 6 }, center: { x: 7, y: 8 }, clockwise: false },
      { type: 'circle', to: { x: 9, y: 10 }, center: { x: 11, y: 12 }, clockwise: true },
      {
        type: 'bezier',
        to: { x: 13, y: 14 },
        control1: { x: 15, y: 16 },
        control2: { x: 17, y: 18 },
      },
    ],
    closed: false,
  }
}

// ── Tests ──────────────────────────────────────────────────────────

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

test('clonePoint copies coordinates into a fresh object', () => {
  const point = { x: 3, y: -4 }
  const cloned = clonePoint(point)
  assertPoint(cloned, point, 'clonePoint copies coordinates')
  assert(cloned !== point, 'clonePoint returns a new object')
})

test('translatePoint offsets both axes without mutating its input', () => {
  const point = { x: 3, y: -4 }
  const moved = translatePoint(point, 10, 100)
  assertPoint(moved, { x: 13, y: 96 }, 'translatePoint offsets both axes')
  assertPoint(point, { x: 3, y: -4 }, 'translatePoint leaves the source alone')
})

test('translateProfile moves every segment kind, circle centre included', () => {
  const moved = translateProfile(mixedProfile(), 10, 100)

  assertPoint(moved.start, { x: 11, y: 102 }, 'translateProfile moves start')

  const [line, arc, circle, bezier] = moved.segments
  assertPoint(line.to, { x: 13, y: 104 }, 'translateProfile moves line.to')

  assert(arc.type === 'arc', 'arc segment kind preserved')
  assertPoint(arc.to, { x: 15, y: 106 }, 'translateProfile moves arc.to')
  assertPoint(arc.center, { x: 17, y: 108 }, 'translateProfile moves arc.center')

  // The regression this module exists to prevent.
  assert(circle.type === 'circle', 'circle segment kind preserved')
  assertPoint(circle.to, { x: 19, y: 110 }, 'translateProfile moves circle.to')
  assertPoint(circle.center, { x: 21, y: 112 }, 'translateProfile moves circle.center')
  assert(circle.clockwise === true, 'translateProfile preserves circle.clockwise')

  assert(bezier.type === 'bezier', 'bezier segment kind preserved')
  assertPoint(bezier.to, { x: 23, y: 114 }, 'translateProfile moves bezier.to')
  assertPoint(bezier.control1, { x: 25, y: 116 }, 'translateProfile moves bezier.control1')
  assertPoint(bezier.control2, { x: 27, y: 118 }, 'translateProfile moves bezier.control2')
})

test('translateProfile does not mutate its input', () => {
  const profile = mixedProfile()
  translateProfile(profile, 5, 5)
  assertPoint(profile.start, { x: 1, y: 2 }, 'translateProfile leaves the source start alone')
  const circle = profile.segments[2]
  assert(circle.type === 'circle', 'source circle kind unchanged')
  assertPoint(circle.center, { x: 11, y: 12 }, 'translateProfile leaves the source circle.center alone')
})

test('translateProfile by zero is value-identical to its input', () => {
  const profile = mixedProfile()
  const unmoved = translateProfile(profile, 0, 0)
  assert(
    JSON.stringify(unmoved) === JSON.stringify(profile),
    'translateProfile(0, 0) is value-identical to its input',
  )
})

test('transformProfile applies an arbitrary point map to every point', () => {
  const scaled = transformProfile(mixedProfile(), (p) => ({ x: p.x * 2, y: p.y * -1 }))

  assertPoint(scaled.start, { x: 2, y: -2 }, 'transformProfile maps start')

  const [line, arc, circle, bezier] = scaled.segments
  assertPoint(line.to, { x: 6, y: -4 }, 'transformProfile maps line.to')

  assert(arc.type === 'arc', 'arc segment kind preserved')
  assertPoint(arc.to, { x: 10, y: -6 }, 'transformProfile maps arc.to')
  assertPoint(arc.center, { x: 14, y: -8 }, 'transformProfile maps arc.center')

  assert(circle.type === 'circle', 'circle segment kind preserved')
  assertPoint(circle.to, { x: 18, y: -10 }, 'transformProfile maps circle.to')
  assertPoint(circle.center, { x: 22, y: -12 }, 'transformProfile maps circle.center')

  assert(bezier.type === 'bezier', 'bezier segment kind preserved')
  assertPoint(bezier.to, { x: 26, y: -14 }, 'transformProfile maps bezier.to')
  assertPoint(bezier.control1, { x: 30, y: -16 }, 'transformProfile maps bezier.control1')
  assertPoint(bezier.control2, { x: 34, y: -18 }, 'transformProfile maps bezier.control2')
})

test('transformProfile preserves non-point profile fields', () => {
  const profile: SketchProfile = { ...mixedProfile(), closed: true }
  const mapped = transformProfile(profile, clonePoint)
  assert(mapped.closed === true, 'transformProfile preserves closed')
  assert(mapped.segments.length === profile.segments.length, 'transformProfile preserves segment count')
})

test('cloneProfile copies every point object, sharing none with the source', () => {
  const profile = mixedProfile()
  const cloned = cloneProfile(profile)

  assert(JSON.stringify(cloned) === JSON.stringify(profile), 'cloneProfile is value-identical')
  assert(cloned !== profile, 'cloneProfile returns a new profile')
  assert(cloned.start !== profile.start, 'cloneProfile copies start')

  const clonedLine = cloned.segments[0]
  const sourceLine = profile.segments[0]
  assert(clonedLine.to !== sourceLine.to, 'cloneProfile copies line.to')

  const clonedArc = cloned.segments[1]
  const sourceArc = profile.segments[1]
  assert(clonedArc.type === 'arc' && sourceArc.type === 'arc', 'arc kinds preserved')
  assert(clonedArc.center !== sourceArc.center, 'cloneProfile copies arc.center')
  assert(clonedArc.to !== sourceArc.to, 'cloneProfile copies arc.to')

  const clonedCircle = cloned.segments[2]
  const sourceCircle = profile.segments[2]
  assert(clonedCircle.type === 'circle' && sourceCircle.type === 'circle', 'circle kinds preserved')
  assert(clonedCircle.center !== sourceCircle.center, 'cloneProfile copies circle.center')
  assert(clonedCircle.to !== sourceCircle.to, 'cloneProfile copies circle.to')

  const clonedBezier = cloned.segments[3]
  const sourceBezier = profile.segments[3]
  assert(clonedBezier.type === 'bezier' && sourceBezier.type === 'bezier', 'bezier kinds preserved')
  assert(clonedBezier.to !== sourceBezier.to, 'cloneProfile copies bezier.to')
  assert(clonedBezier.control1 !== sourceBezier.control1, 'cloneProfile copies bezier.control1')
  assert(clonedBezier.control2 !== sourceBezier.control2, 'cloneProfile copies bezier.control2')
})

// ── Summary ────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
