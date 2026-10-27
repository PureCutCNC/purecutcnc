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
 * Gear generator tests (issue #1112 slice E).
 *
 * The load-bearing property: the canned gear generates the outline the old
 * one-shot command (`buildGearProfile`) generated, for several parameter sets,
 * and its bore is the same circle the separate feature made. An operation on a
 * canned gear therefore cuts what it cut before.
 *
 * Run with: npx tsx src/cannedShapes/generators/gear.test.ts
 */

import { circleProfile, type Matrix2D } from '../../types/project'
import { buildGearProfile, type GearCreationParams } from '../../sketch/gearProfile'
import {
  GEAR_CANNED_KIND,
  gearCannedShape,
  normalizeGearCannedParams,
} from './gear'
import { resolveCannedShapeShapes } from '../index'

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

const base = (overrides: Partial<GearCreationParams & { outsideRadius: number }> = {}) => ({
  teeth: 24,
  outsideRadius: 20,
  wholeDepth: 4.5,
  flankProfile: 'involute' as const,
  pressureAngleDeg: 20,
  rootForm: 'rounded' as const,
  rootFilletRadius: 0.4,
  crestForm: 'flat' as const,
  crestRadius: 0,
  boreDiameter: 0,
  ...overrides,
})

function normalized(overrides: Partial<GearCreationParams & { outsideRadius: number }> = {}) {
  const params = normalizeGearCannedParams(base(overrides))
  assert(params, `parameters should normalize: ${JSON.stringify(overrides)}`)
  return params
}

test('kind and label are the shape contract', () => {
  assertEqual(gearCannedShape.kind, GEAR_CANNED_KIND, 'registry kind')
  assertEqual(gearCannedShape.labelKey, 'canned.gear.name', 'label key')
})

test('the generated outline equals the old command output', () => {
  const cases = [
    base(),
    base({ teeth: 12, outsideRadius: 18, wholeDepth: 4, rootFilletRadius: 0.3 }),
    base({ teeth: 40, outsideRadius: 32, wholeDepth: 6.5, crestForm: 'rounded', crestRadius: 0.5 }),
    base({ teeth: 18, outsideRadius: 16, wholeDepth: 3.5, flankProfile: 'straight' }),
    base({ teeth: 6, outsideRadius: 12, wholeDepth: 2.6, pressureAngleDeg: 14.5 }),
  ]

  for (const raw of cases) {
    const params = normalized(raw)
    const shapes = gearCannedShape.generate(params)
    assertEqual(shapes.length, 1, `${params.teeth} teeth: one outline without a bore`)
    assertEqual(
      shapes[0].profile,
      buildGearProfile({ ...params, center: { x: 0, y: 0 } }),
      `${params.teeth} teeth: generator outline is the old command's`,
    )
  }
})

test('the bore is the circle the old separate feature made', () => {
  const params = normalized({ boreDiameter: 6 })
  const shapes = gearCannedShape.generate(params)
  assertEqual(shapes.length, 2, 'gear and bore')
  assertEqual(shapes[1].profile, circleProfile(0, 0, 3), 'bore is the old circle profile')
})

test('a placed canned gear resolves to the old world-space output', () => {
  const center = { x: 3, y: -2 }
  const params = normalized({ teeth: 18, outsideRadius: 20, boreDiameter: 5 })
  const transform: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: center.x, f: center.y }
  const shapes = resolveCannedShapeShapes({
    operation: 'add',
    canned: { kind: GEAR_CANNED_KIND, params },
    transform,
  })

  assertEqual(
    shapes[0].profile,
    buildGearProfile({ ...params, center }),
    'outer outline is placed exactly as the old command built it',
  )
  assertEqual(shapes[1].profile, circleProfile(center.x, center.y, 2.5), 'bore follows the placement')
  assertEqual(shapes.map((shape) => shape.operation), ['add', 'subtract'], 'Add gear, Subtract bore')
})

test('subtract nesting turns the bore into an add island', () => {
  const params = normalized({ boreDiameter: 5 })
  const shapes = resolveCannedShapeShapes({
    operation: 'subtract',
    canned: { kind: GEAR_CANNED_KIND, params },
  })
  assertEqual(shapes.map((shape) => shape.depth), [0, 1], 'bore nests')
  assertEqual(shapes.map((shape) => shape.operation), ['subtract', 'add'], 'Subtract gear, Add island')
})

test('invalid parameters are refused, not guessed', () => {
  assertEqual(normalizeGearCannedParams(base({ boreDiameter: 40 })), null, 'bore at the root diameter is refused')
  assertEqual(
    normalizeGearCannedParams({ ...base(), flankProfile: 'wobbly' }),
    null,
    'an unknown flank profile is refused',
  )
  assertEqual(normalizeGearCannedParams({ ...base(), outsideRadius: 0 }), null, 'zero size is refused')
})

test('unit conversion converts lengths but not counts or angles', () => {
  const params = normalized({ boreDiameter: 6, rootFilletRadius: 0.4, crestRadius: 0.2 })
  const converted = gearCannedShape.convertParams?.(params, (value) => value * 25.4)
  assert(converted, 'the generator converts lengths')
  assertEqual(converted.teeth, 24, 'tooth count is unitless')
  assertEqual(converted.pressureAngleDeg, 20, 'angle is unitless')
  assertEqual(converted.outsideRadius, 20 * 25.4, 'size converts')
  assertEqual(converted.wholeDepth, 4.5 * 25.4, 'depth converts')
  assertEqual(converted.boreDiameter, 6 * 25.4, 'bore converts')
})

test('the summary names the teeth and the module', () => {
  const summary = gearCannedShape.summary(normalized({ teeth: 24, outsideRadius: 39 }))
  assertEqual(summary.key, 'canned.gear.summary', 'summary key')
  assertEqual(summary.values, { teeth: 24, module: 3 }, 'module is derived from size and teeth')
})

if (failCount > 0) {
  console.error(`\n${failCount} test(s) failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\nAll ${passCount} gear generator tests passed`)
