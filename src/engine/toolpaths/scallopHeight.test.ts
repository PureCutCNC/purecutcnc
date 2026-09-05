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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_WATERLINE_STEEP_SLOPE_DEGREES,
  finishScallopWaterlineStepdown,
  scallopHeightToSpacing,
  spacingToScallopHeight,
} from './scallopHeight'
import type { Operation } from '../../types/project'
import { defaultTool, newProject } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'

test('scallop height and spacing round-trip across the usable ball radius', () => {
  const radius = 3
  for (const height of [0.0001, 0.01, 0.25, 1, 2.999]) {
    const spacing = scallopHeightToSpacing(radius, height)
    assert.notEqual(spacing, null)
    const roundTrip = spacingToScallopHeight(radius, spacing as number)
    assert.notEqual(roundTrip, null)
    assert(Math.abs((roundTrip as number) - height) <= 1e-12)
  }
})

test('invalid conversion domains return null instead of NaN', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 3]) {
    assert.equal(scallopHeightToSpacing(3, value), null)
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 6]) {
    assert.equal(spacingToScallopHeight(3, value), null)
  }
})

test('a stored scallop height is inactive for a flat endmill', () => {
  const operation = { finishScallopHeight: 0.1 } as Operation
  const flatTool = { type: 'flat_endmill' as const, diameter: 4 }
  assert.equal(finishScallopWaterlineStepdown(operation, flatTool), null)
})

test('waterline derives its coarse Z increment from the steep threshold', () => {
  const radius = 2
  const spacing = 1
  const height = spacingToScallopHeight(radius, spacing)
  assert.notEqual(height, null)
  const operation = {
    finishScallopHeight: height,
  } as Operation
  const tool = { type: 'ball_endmill' as const, diameter: radius * 2 }
  const defaultStep = finishScallopWaterlineStepdown(operation, tool)
  assert.notEqual(defaultStep, null)
  assert(Math.abs((defaultStep as number) - spacing * Math.sin(DEFAULT_WATERLINE_STEEP_SLOPE_DEGREES * Math.PI / 180)) <= 1e-12)

  operation.finishSlopeMin = 45
  const filteredStep = finishScallopWaterlineStepdown(operation, tool)
  assert.notEqual(filteredStep, null)
  assert(Math.abs((filteredStep as number) - spacing * Math.sin(Math.PI / 4)) <= 1e-12)
})

test('new ball-endmill finish operations preserve the tool default spacing as a cusp', () => {
  const tool = {
    ...defaultTool('mm', 1),
    type: 'ball_endmill' as const,
    diameter: 4,
    defaultStepover: 0.25,
  }
  const project = { ...newProject('scallop-default', 'mm'), tools: [tool] }
  const operation = defaultOperationForTarget(
    project,
    'finish_surface',
    'finish',
    { source: 'features', featureIds: ['model'] },
    0,
  )
  const expected = spacingToScallopHeight(2, 1)
  assert.notEqual(expected, null)
  assert(Math.abs((operation.finishScallopHeight ?? 0) - (expected as number)) <= 1e-12)
})
