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
 * Canned Flutes generator (issue #1112 slice F).
 *
 * The load-bearing property: the canned generator draws exactly the lines the
 * pre-canned `buildRotaryPatternLines` command drew, including a signed twist
 * (positive right-hand, negative left-hand). The stored `twist` is the
 * physical hand; the dialog's Direction control signs it.
 *
 * Run with: npx tsx src/cannedShapes/generators/flutes.test.ts
 */

import { newProject, roundStock } from '../../types/project'
import type { CannedShapeParams } from '../../types/project'
import { buildRotaryPatternLines, rotaryPatternFrame, rotarySheetPoint } from '../../engine/rotaryPatterns'
import type { RotaryPatternFrame } from '../../engine/rotaryPatterns'
import {
  flutesCannedShape,
  normalizeFlutesCannedParams,
  type FlutesCannedParams,
} from './flutes'
import { FLUTES_CANNED_KIND } from './kinds'

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

function frame(axis: 'x' | 'y' = 'x') {
  const project = newProject('Flutes', 'mm')
  project.meta.projectType = 'rotary'
  project.stock = roundStock(40, 200, axis, { x: 10, y: 30 })
  const value = rotaryPatternFrame(project)
  assert(value, 'the fixture is a bar')
  return value
}

const base = (overrides: Record<string, unknown> = {}): CannedShapeParams => ({
  start: 20,
  length: 50,
  count: 4,
  twist: 1.5,
  depth: 0.8,
  frame: frame(),
  ...overrides,
} as unknown as CannedShapeParams)

function normalized(overrides: Record<string, unknown> = {}): FlutesCannedParams {
  const params = normalizeFlutesCannedParams(base(overrides))
  assert(params, `parameters should normalize: ${JSON.stringify(overrides)}`)
  return params
}

function expectedProfiles(params: FlutesCannedParams) {
  const built = buildRotaryPatternLines(params.frame, {
    kind: 'flutes',
    start: params.start,
    length: params.length,
    count: params.count,
    twist: params.twist,
    depth: params.depth,
  })
  assert(built.ok, 'the old command builds the same lines')
  return built.lines.map((line) => ({
    start: rotarySheetPoint(params.frame, line.alongStart, line.acrossStart),
    segments: [{
      type: 'line' as const,
      to: rotarySheetPoint(params.frame, line.alongEnd, line.acrossEnd),
    }],
    closed: false,
  }))
}

test('kind and label are the shape contract', () => {
  assertEqual(flutesCannedShape.kind, FLUTES_CANNED_KIND, 'registry kind')
  assertEqual(flutesCannedShape.labelKey, 'canned.flutes.name', 'label key')
  assertEqual(flutesCannedShape.capabilities, undefined, 'a sketch shape is expandable by default')
})

test('the generated lines equal the old command, for several parameter sets', () => {
  const cases: CannedShapeParams[] = [
    {},
    { twist: 0 },
    { start: 0, length: 30, count: 2, twist: -1 },
    { start: 12, length: 40, count: 6, twist: 2.25, depth: 0.5 },
    { count: 1, twist: -0.75 },
    { count: 1, twist: 0 },
  ]
  for (const overrides of cases) {
    const params = normalized(overrides)
    const generated = flutesCannedShape.generate(params)
    assertEqual(generated.length, params.count, `${params.count} flutes: one outline each`)
    assertEqual(
      generated.map((outline) => outline.profile),
      expectedProfiles(params),
      `${JSON.stringify(overrides)}: generated lines are the old command's`,
    )
    for (const outline of generated) {
      assertEqual(outline.profile.closed, false, 'every outline is open')
      assertEqual(outline.profile.segments.length, 1, 'each outline is one line')
    }
  }
})

test('a positive twist is right-hand and a negative one left-hand', () => {
  const right = normalized({ twist: 1.5 })
  const left = normalized({ twist: -1.5 })
  const rightProfiles = flutesCannedShape.generate(right).map((outline) => outline.profile)
  const leftProfiles = flutesCannedShape.generate(left).map((outline) => outline.profile)
  rightProfiles.forEach((profile, index) => {
    const end = profile.segments[0].type === 'line' ? profile.segments[0].to : profile.start
    const otherEnd = leftProfiles[index].segments[0].type === 'line'
      ? leftProfiles[index].segments[0].to
      : leftProfiles[index].start
    assert(end.y - profile.start.y > 0, `${index}: positive twist slopes one way`)
    assert(otherEnd.y - leftProfiles[index].start.y < 0, `${index}: negative twist slopes the other way`)
    assert(
      Math.abs(
        Math.abs(end.y - profile.start.y)
        - Math.abs(otherEnd.y - leftProfiles[index].start.y),
      ) < 1e-9,
      `${index}: the magnitude is the same`,
    )
  })
})

test('generation is deterministic', () => {
  const params = normalized()
  assertEqual(
    JSON.stringify(flutesCannedShape.generate(params)),
    JSON.stringify(flutesCannedShape.generate(params)),
    'same parameters, same lines',
  )
})

test('normalize refuses a corrupt or unusable parameter set', () => {
  assertEqual(normalizeFlutesCannedParams(base({ start: -1 })), null, 'negative start')
  assertEqual(normalizeFlutesCannedParams(base({ length: 0 })), null, 'zero length')
  assertEqual(normalizeFlutesCannedParams(base({ count: 2.5 })), null, 'fractional count')
  assertEqual(normalizeFlutesCannedParams(base({ count: 0 })), null, 'zero count')
  assertEqual(normalizeFlutesCannedParams(base({ twist: NaN })), null, 'nonfinite twist')
  assertEqual(normalizeFlutesCannedParams(base({ depth: 0 })), null, 'zero depth')
  assertEqual(normalizeFlutesCannedParams(base({ frame: null })), null, 'missing frame')
  assertEqual(
    normalizeFlutesCannedParams(base({ depth: frame().radius })),
    null,
    'depth at the centreline',
  )
})

test('unit conversion converts lengths only', () => {
  const params = normalized()
  const mmToInch = (value: number): number => value / 25.4
  const converted = flutesCannedShape.convertParams!(params, mmToInch)
  const convertedFrame = converted.frame as unknown as RotaryPatternFrame
  assertEqual(converted.start, params.start / 25.4, 'start is a length')
  assertEqual(converted.length, params.length / 25.4, 'length is a length')
  assertEqual(converted.depth, params.depth / 25.4, 'depth is a length')
  assertEqual(converted.count, params.count, 'count is unitless')
  assertEqual(converted.twist, params.twist, 'twist is unitless')
  assertEqual(convertedFrame.zero, params.frame.zero / 25.4, 'frame zero is a length')
  assertEqual(convertedFrame.circumference, params.frame.circumference / 25.4, 'circumference is a length')
  assertEqual(convertedFrame.radius, params.frame.radius / 25.4, 'radius is a length')
  assertEqual(convertedFrame.alongOrigin, params.frame.alongOrigin / 25.4, 'along origin is a length')
  assertEqual(convertedFrame.alongDirection, params.frame.alongDirection, 'axis/direction is unitless')
})

test('the summary names the stored flutes', () => {
  const params = normalized({ count: 3, twist: -2, length: 30 })
  const summary = flutesCannedShape.summary(params)
  assertEqual(summary.key, 'canned.flutes.summary', 'summary key')
  assertEqual(summary.values, { count: 3, twist: 2, length: 30 }, 'summary values use the magnitude')
})

console.log(`\n${passCount} passed, ${failCount} failed.`)
if (failCount > 0) process.exitCode = 1
