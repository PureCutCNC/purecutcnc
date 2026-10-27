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
 * Test-only canned shapes (issue #1112, slice A).
 *
 * Slice A ships the canned model without converting a real shape, so these two
 * generators are the proof that the model works end to end:
 *
 * - `test-plate` is closed and has a hole — it exercises the nesting rule
 *   (Add plate → Subtract bore, Subtract plate → Add bore) and expansion.
 * - `test-open-line` is an open polyline — it exercises the open-line branch
 *   (the feature's operation must survive; no invert).
 *
 * They are deliberately *not* imported by `src/cannedShapes/generators`, so
 * they never reach the app bundle. Tests call {@link registerTestCannedShapes}.
 */

import {
  circleProfile,
  rectProfile,
  type CannedShapeData,
  type CannedShapeParams,
  type SketchProfile,
} from '../types/project'
import { defineCannedShape, registerCannedShapeGenerator } from '../cannedShapes'

/** A rectangle with a round hole through it. */
export const TEST_PLATE_KIND = 'test-plate'

export type TestPlateParams = CannedShapeParams & {
  width: number
  height: number
  holeRadius: number
}

function isTestPlateParams(value: CannedShapeParams): value is TestPlateParams {
  return typeof value.width === 'number' && value.width > 0
    && typeof value.height === 'number' && value.height > 0
    && typeof value.holeRadius === 'number' && value.holeRadius > 0
    && value.holeRadius < Math.min(value.width, value.height) / 2
}

const testPlate = defineCannedShape<TestPlateParams>({
  kind: TEST_PLATE_KIND,
  labelKey: 'canned.test.plate.name',
  generate: (params) => [
    { profile: rectProfile(0, 0, params.width, params.height), name: 'Plate' },
    {
      profile: circleProfile(params.width / 2, params.height / 2, params.holeRadius),
      name: 'Plate hole',
    },
  ],
  normalizeParams: (raw) => (isTestPlateParams(raw) ? raw : null),
  convertParams: (params, convertLength) => ({
    ...params,
    width: convertLength(params.width),
    height: convertLength(params.height),
    holeRadius: convertLength(params.holeRadius),
  }),
  summary: (params) => ({
    key: 'canned.test.plate.summary',
    values: { width: params.width, height: params.height, holeRadius: params.holeRadius },
  }),
})

/** A single open polyline (a shallow zigzag). */
export const TEST_OPEN_LINE_KIND = 'test-open-line'

export type TestOpenLineParams = CannedShapeParams & {
  length: number
  amplitude: number
}

function isTestOpenLineParams(value: CannedShapeParams): value is TestOpenLineParams {
  return typeof value.length === 'number' && value.length > 0
    && typeof value.amplitude === 'number' && value.amplitude > 0
}

function openLineProfile(length: number, amplitude: number): SketchProfile {
  return {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line', to: { x: length / 3, y: amplitude } },
      { type: 'line', to: { x: (length * 2) / 3, y: -amplitude } },
      { type: 'line', to: { x: length, y: 0 } },
    ],
    closed: false,
  }
}

const testOpenLine = defineCannedShape<TestOpenLineParams>({
  kind: TEST_OPEN_LINE_KIND,
  labelKey: 'canned.test.openLine.name',
  generate: (params) => [{ profile: openLineProfile(params.length, params.amplitude), name: 'Line' }],
  normalizeParams: (raw) => (isTestOpenLineParams(raw) ? raw : null),
  convertParams: (params, convertLength) => ({
    ...params,
    length: convertLength(params.length),
    amplitude: convertLength(params.amplitude),
  }),
  summary: (params) => ({
    key: 'canned.test.openLine.summary',
    values: { length: params.length, amplitude: params.amplitude },
  }),
})

/** Register the two test-only generators for the calling test file. */
export function registerTestCannedShapes(): void {
  registerCannedShapeGenerator(testPlate)
  registerCannedShapeGenerator(testOpenLine)
}

/** A closed plate with a hole, in definition-local space. */
export function testPlateCanned(width = 100, height = 60, holeRadius = 12): CannedShapeData {
  return {
    kind: TEST_PLATE_KIND,
    params: { width, height, holeRadius },
  }
}

/** An open polyline, in definition-local space. */
export function testOpenLineCanned(length = 60, amplitude = 8): CannedShapeData {
  return {
    kind: TEST_OPEN_LINE_KIND,
    params: { length, amplitude },
  }
}
