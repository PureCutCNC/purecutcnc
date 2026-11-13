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
 * Canned Thread generator (issue #1112 slice F).
 *
 * The load-bearing property: the canned generator draws exactly the lines the
 * pre-canned `buildRotaryPatternLines` command drew, for several parameter
 * sets, so a Follow line operation on the feature cuts what the old folder's
 * operation cut. The rest is the canned contract: deterministic generation, a
 * stored frame that round-trips, unit conversion of lengths only, and refusal
 * of a corrupt parameter set.
 *
 * Run with: npx tsx src/cannedShapes/generators/thread.test.ts
 */

import { newProject, roundStock } from '../../types/project'
import type { CannedShapeParams } from '../../types/project'
import { buildRotaryPatternLines, rotaryPatternFrame, rotarySheetPoint } from '../../engine/rotaryPatterns'
import type { RotaryPatternFrame } from '../../engine/rotaryPatterns'
import {
  normalizeThreadCannedParams,
  threadCannedShape,
  type ThreadCannedParams,
} from './thread'
import { THREAD_CANNED_KIND } from './kinds'

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
  const project = newProject('Thread', 'mm')
  project.meta.projectType = 'rotary'
  project.stock = roundStock(40, 200, axis, { x: 10, y: 30 })
  const value = rotaryPatternFrame(project)
  assert(value, 'the fixture is a bar')
  return value
}

const base = (overrides: Record<string, unknown> = {}): CannedShapeParams => ({
  start: 25,
  length: 60,
  pitch: 2,
  starts: 1,
  depth: 1.2,
  hand: 'right',
  frame: frame(),
  ...overrides,
} as unknown as CannedShapeParams)

function normalized(overrides: Record<string, unknown> = {}): ThreadCannedParams {
  const params = normalizeThreadCannedParams(base(overrides))
  assert(params, `parameters should normalize: ${JSON.stringify(overrides)}`)
  return params
}

function expectedProfiles(params: ThreadCannedParams) {
  const built = buildRotaryPatternLines(params.frame, {
    kind: 'thread',
    start: params.start,
    length: params.length,
    pitch: params.pitch,
    starts: params.starts,
    hand: params.hand,
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
  assertEqual(threadCannedShape.kind, THREAD_CANNED_KIND, 'registry kind')
  assertEqual(threadCannedShape.labelKey, 'canned.thread.name', 'label key')
  assertEqual(threadCannedShape.capabilities, undefined, 'a sketch shape is expandable by default')
})

test('the generated lines equal the old command, for several parameter sets', () => {
  const cases: CannedShapeParams[] = [
    {},
    { start: 0, length: 30, pitch: 1.25, starts: 3 },
    { start: 40, length: 18.5, pitch: 0.75, starts: 2, hand: 'left' },
    { start: 195, length: 20, pitch: 2, starts: 1, depth: 1 },
    { length: 12, pitch: 1, starts: 4, depth: 0.5 },
  ]
  for (const overrides of cases) {
    const params = normalized(overrides)
    const generated = threadCannedShape.generate(params)
    assertEqual(generated.length, params.starts, `${params.starts} starts: one outline each`)
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

test('a Y bar keeps the physical hand while drawing low to high', () => {
  const params = normalized({
    start: 10,
    length: 30,
    pitch: 2,
    starts: 2,
    frame: frame('y'),
  })
  const profiles = threadCannedShape.generate(params).map((outline) => outline.profile)
  assertEqual(profiles.length, 2, 'one line per start')
  for (const profile of profiles) {
    const end = profile.segments[0].type === 'line' ? profile.segments[0].to : profile.start
    assert(end.y > profile.start.y, 'the line is drawn in ascending stock coordinates')
  }
  assertEqual(
    profiles.map((profile) => profile.start),
    expectedProfiles(params).map((profile) => profile.start),
    'the band placement is the old command\'s',
  )
})

test('generation is deterministic', () => {
  const params = normalized()
  assertEqual(
    JSON.stringify(threadCannedShape.generate(params)),
    JSON.stringify(threadCannedShape.generate(params)),
    'same parameters, same lines',
  )
})

test('normalize refuses a corrupt or unusable parameter set', () => {
  assertEqual(normalizeThreadCannedParams(base({ start: -1 })), null, 'negative start')
  assertEqual(normalizeThreadCannedParams(base({ length: 0 })), null, 'zero length')
  assertEqual(normalizeThreadCannedParams(base({ pitch: 0 })), null, 'zero pitch')
  assertEqual(normalizeThreadCannedParams(base({ starts: 1.5 })), null, 'fractional starts')
  assertEqual(normalizeThreadCannedParams(base({ starts: 0 })), null, 'zero starts')
  assertEqual(normalizeThreadCannedParams(base({ depth: 0 })), null, 'zero depth')
  assertEqual(normalizeThreadCannedParams(base({ hand: 'up' })), null, 'unknown hand')
  assertEqual(normalizeThreadCannedParams(base({ frame: null })), null, 'missing frame')
  assertEqual(normalizeThreadCannedParams(base({ frame: { ...frame(), radius: 0 } })), null, 'zero-radius frame')
  assertEqual(
    normalizeThreadCannedParams(base({ depth: frame().radius })),
    null,
    'depth at the centreline',
  )
})

test('unit conversion converts lengths only', () => {
  const params = normalized()
  const mmToInch = (value: number): number => value / 25.4
  const converted = threadCannedShape.convertParams!(params, mmToInch)
  const convertedFrame = converted.frame as unknown as RotaryPatternFrame
  assertEqual(converted.start, params.start / 25.4, 'start is a length')
  assertEqual(converted.length, params.length / 25.4, 'length is a length')
  assertEqual(converted.pitch, params.pitch / 25.4, 'pitch is a length')
  assertEqual(converted.depth, params.depth / 25.4, 'depth is a length')
  assertEqual(converted.starts, params.starts, 'starts is a count')
  assertEqual(converted.hand, params.hand, 'hand is unitless')
  assertEqual(convertedFrame.zero, params.frame.zero / 25.4, 'frame zero is a length')
  assertEqual(convertedFrame.circumference, params.frame.circumference / 25.4, 'circumference is a length')
  assertEqual(convertedFrame.radius, params.frame.radius / 25.4, 'radius is a length')
  assertEqual(convertedFrame.alongOrigin, params.frame.alongOrigin / 25.4, 'along origin is a length')
  assertEqual(convertedFrame.alongDirection, params.frame.alongDirection, 'axis/direction is unitless')
})

test('the summary names the stored thread', () => {
  const params = normalized({ pitch: 1.5, starts: 2, length: 30 })
  const summary = threadCannedShape.summary(params)
  assertEqual(summary.key, 'canned.thread.summary', 'summary key')
  assertEqual(summary.values, { pitch: 1.5, starts: 2, length: 30 }, 'summary values')
})

console.log(`\n${passCount} passed, ${failCount} failed.`)
if (failCount > 0) process.exitCode = 1
