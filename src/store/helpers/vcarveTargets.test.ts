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
 * Tests for the shared V-carve target eligibility helper.
 *
 * Run with: npx tsx src/store/helpers/vcarveTargets.test.ts
 */

import { isVCarveCompatibleFeature } from './vcarveTargets'
import type { FeatureOperation, Point, SketchFeature } from '../../types/project'
import { rectProfile } from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function openProfile(from: Point, to: Point) {
  return {
    start: from,
    segments: [{ type: 'line' as const, to }],
    closed: false,
  }
}

function makeFeature(
  id: string,
  operation: FeatureOperation,
  closed: boolean,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: closed
        ? rectProfile(0, 0, 10, 10)
        : openProfile({ x: 0, y: 0 }, { x: 10, y: 10 }),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

// ── Valid targets ──────────────────────────────────────────────────

function testClosedSubtractIsValid(): void {
  const feature = makeFeature('s1', 'subtract', true)
  assert(isVCarveCompatibleFeature(feature), 'closed subtract should be valid')
}

function testClosedLineIsValid(): void {
  const feature = makeFeature('l1', 'line', true)
  assert(isVCarveCompatibleFeature(feature), 'closed line should be valid')
}

// ── Invalid targets ────────────────────────────────────────────────

function testOpenSubtractIsInvalid(): void {
  const feature = makeFeature('s1', 'subtract', false)
  assert(!isVCarveCompatibleFeature(feature), 'open subtract should be invalid')
}

function testOpenLineIsInvalid(): void {
  const feature = makeFeature('l1', 'line', false)
  assert(!isVCarveCompatibleFeature(feature), 'open line should be invalid')
}

function testAddIsInvalid(): void {
  const feature = makeFeature('a1', 'add', true)
  assert(!isVCarveCompatibleFeature(feature), 'add should be invalid')
}

function testModelIsInvalid(): void {
  const feature = makeFeature('m1', 'model', true)
  assert(!isVCarveCompatibleFeature(feature), 'model should be invalid')
}

function testRegionIsInvalid(): void {
  const feature = makeFeature('r1', 'region', true)
  assert(!isVCarveCompatibleFeature(feature), 'region should be invalid')
}

function testConstructionIsInvalid(): void {
  const feature = makeFeature('c1', 'construction', true)
  assert(!isVCarveCompatibleFeature(feature), 'construction should be invalid')
}

// ── Run ────────────────────────────────────────────────────────────

testClosedSubtractIsValid()
testClosedLineIsValid()
testOpenSubtractIsInvalid()
testOpenLineIsInvalid()
testAddIsInvalid()
testModelIsInvalid()
testRegionIsInvalid()
testConstructionIsInvalid()

console.log('vcarveTargets tests passed')
