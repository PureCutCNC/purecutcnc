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
 * Canned-shape model tests (issue #1112, slice A).
 *
 * Run with: npx tsx src/cannedShapes/cannedShapes.test.ts
 *
 * Slice A ships no real shape, so these tests register the two test-only
 * generators from `src/test/cannedShapeFixture.ts`:
 * - the closed plate with a hole proves the nesting rule in both directions;
 * - the open polyline proves an open outline keeps the feature's operation.
 */

import {
  cannedShapeFrame,
  cannedShapeLabelKey,
  cannedShapeSummary,
  defineCannedShape,
  getCannedShapeEditor,
  getCannedShapeGenerator,
  isCannedFeature,
  registerCannedShapeEditor,
  registerCannedShapeGenerator,
  resolveCannedShapeProfiles,
  resolveCannedShapeShapes,
} from './index'
import {
  registerTestCannedShapes,
  testOpenLineCanned,
  testPlateCanned,
  TEST_OPEN_LINE_KIND,
  TEST_PLATE_KIND,
} from '../test/cannedShapeFixture'
import { getProfileBounds, type CannedShapeData, type Matrix2D } from '../types/project'

registerTestCannedShapes()

let passCount = 0
let failCount = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`✓ ${name}`)
    passCount += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).message}`)
    failCount += 1
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`)
  }
}

function feature(canned: CannedShapeData, operation: 'add' | 'subtract' | 'line', transform?: Matrix2D) {
  return { operation, canned, transform }
}

test('plain features are not canned', () => {
  assert(!isCannedFeature({ canned: null }), 'null canned is plain')
  assert(!isCannedFeature({}), 'absent canned is plain')
  assert(isCannedFeature({ canned: testPlateCanned() }), 'stored data is canned')
})

test('an Add plate is an outer Add and a Subtract hole', () => {
  const shapes = resolveCannedShapeShapes(feature(testPlateCanned(), 'add'))
  assertEqual(shapes.length, 2, 'two outlines')
  assertEqual(shapes.map((shape) => shape.depth), [0, 1], 'nesting depths')
  assertEqual(shapes.map((shape) => shape.operation), ['add', 'subtract'], 'outer add, hole subtract')
  assertEqual(shapes.map((shape) => shape.profile.closed), [true, true], 'both closed')
})

test('a Subtract plate turns its hole into an Add island', () => {
  const shapes = resolveCannedShapeShapes(feature(testPlateCanned(), 'subtract'))
  assertEqual(shapes.map((shape) => shape.operation), ['subtract', 'add'], 'outer subtract, hole add')
})

test('an open-line shape keeps the feature operation', () => {
  const line = resolveCannedShapeShapes(feature(testOpenLineCanned(), 'line'))
  assertEqual(line.length, 1, 'one outline')
  assertEqual(line[0].depth, 0, 'open outline is depth 0')
  assertEqual(line[0].operation, 'line', 'line stays line')
  assert(!line[0].profile.closed, 'profile is open')

  const add = resolveCannedShapeShapes(feature(testOpenLineCanned(), 'add'))
  assertEqual(add[0].operation, 'add', 'an open Add stays Add')
})

test('the instance transform places generated geometry', () => {
  const transform: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 }
  const shapes = resolveCannedShapeShapes(feature(testPlateCanned(100, 60, 12), 'add', transform))
  const bounds = getProfileBounds(shapes[0].profile)
  assertEqual(bounds, { minX: 10, maxX: 110, minY: 20, maxY: 80 }, 'outer bounds are translated')
  const hole = getProfileBounds(shapes[1].profile)
  assertEqual({ x: (hole.minX + hole.maxX) / 2, y: (hole.minY + hole.maxY) / 2 }, { x: 60, y: 50 }, 'hole follows')
})

test('a mirror flips circle winding and keeps the hole a hole', () => {
  const transform: Matrix2D = { a: -1, b: 0, c: 0, d: 1, e: 100, f: 0 }
  const shapes = resolveCannedShapeShapes(feature(testPlateCanned(), 'add', transform))
  const hole = shapes[1].profile
  const circle = hole.segments[0]
  assert(circle.type === 'circle', 'hole is a circle')
  assertEqual(circle.clockwise, false, 'mirror flipped the circle direction')
  assertEqual(shapes.map((shape) => shape.operation), ['add', 'subtract'], 'nesting still wins')
})

test('the placement frame is the outer bounds, not the hole', () => {
  const frame = cannedShapeFrame(testPlateCanned(100, 60, 12))
  assert(frame, 'frame exists')
  assertEqual(getProfileBounds(frame), { minX: 0, maxX: 100, minY: 0, maxY: 60 }, 'frame covers the plate')
})

test('profiles are the generated outlines in order', () => {
  const profiles = resolveCannedShapeProfiles(feature(testPlateCanned(100, 60, 12), 'add'))
  assertEqual(profiles.length, 2, 'both outlines')
  assertEqual(getProfileBounds(profiles[0]), { minX: 0, maxX: 100, minY: 0, maxY: 60 }, 'outer first')
})

test('summary and label come from the registered generator', () => {
  const summary = cannedShapeSummary(testPlateCanned(100, 60, 12))
  assert(summary, 'summary exists')
  assertEqual(summary.key, 'canned.test.plate.summary', 'summary key')
  assertEqual(summary.values, { width: 100, height: 60, holeRadius: 12 }, 'summary values')
  assertEqual(cannedShapeLabelKey(testPlateCanned()), 'canned.test.plate.name', 'label key')
})

test('an unregistered kind is preserved and resolves to nothing', () => {
  const future: CannedShapeData = { kind: 'from-the-future', params: { sides: 7 } }
  assertEqual(resolveCannedShapeShapes(feature(future, 'add')), [], 'no generator, no geometry')
  assertEqual(cannedShapeSummary(future), null, 'no summary')
  assertEqual(cannedShapeFrame(future), null, 'no frame')
})

test('invalid parameters are refused rather than guessed', () => {
  const bad = { kind: TEST_PLATE_KIND, params: { width: 10, height: 10, holeRadius: 50 } }
  assertEqual(resolveCannedShapeShapes(feature(bad, 'add')), [], 'hole larger than the plate is refused')
  assertEqual(cannedShapeSummary(bad), null, 'no summary for invalid params')
})

test('generators and editors are registry entries, not model branches', () => {
  const generator = getCannedShapeGenerator(TEST_OPEN_LINE_KIND)
  assert(generator, 'test open line is registered')
  assertEqual(typeof generator.generate, 'function', 'generate is the extension point')

  let edited: string | null = null
  registerCannedShapeEditor(TEST_OPEN_LINE_KIND, (featureId) => { edited = featureId })
  const editor = getCannedShapeEditor(TEST_OPEN_LINE_KIND)
  assert(editor, 'editor is registered')
  editor('f-42')
  assertEqual(edited, 'f-42', 'editor receives the feature id')
  assertEqual(getCannedShapeEditor('from-the-future'), null, 'no editor for an unknown kind')
})

test('a generator can be registered without touching the model', () => {
  const custom = defineCannedShape({
    kind: 'test-registration',
    labelKey: 'canned.test.registration.name',
    generate: () => [],
    summary: () => ({ key: 'canned.test.registration.summary' }),
  })
  registerCannedShapeGenerator(custom)
  assert(getCannedShapeGenerator('test-registration') === custom, 'registry stores the generator')
})

if (failCount > 0) {
  console.error(`\n${failCount} test(s) failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\nAll ${passCount} canned-shape tests passed`)
