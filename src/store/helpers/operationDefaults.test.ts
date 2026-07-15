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
 * Focused tests for V-carve Line-target eligibility in operationDefaults
 * (issue #270 S2).
 *
 * Run with: npx tsx src/store/helpers/operationDefaults.test.ts
 */

import type { FeatureOperation, OperationTarget, Project, SketchFeature } from '../../types/project'
import { newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { isOperationTargetValid, fallbackOperationTarget } from './operationDefaults'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function makeFeature(
  id: string,
  operation: FeatureOperation,
  closed = true,
): SketchFeature {
  const openProfile = {
    start: { x: 0, y: 0 },
    segments: [{ type: 'line' as const, to: { x: 10, y: 10 } }],
    closed: false,
  }
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: closed ? rectProfile(0, 0, 10, 10) : openProfile,
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

function makeTarget(featureIds: string[]): OperationTarget {
  return { source: 'features', featureIds }
}

function projectWith(features: SketchFeature[]): Project {
  return projectWithFeatures(newProject(), features)
}

// ── isOperationTargetValid: V-carve + closed Line ──────────────────

function testClosedLineValidTargetForVCarve(): void {
  const project = projectWith([makeFeature('l1', 'line')])
  assert(
    isOperationTargetValid(project, 'v_carve', makeTarget(['l1'])),
    'closed line should be valid target for v_carve',
  )
  assert(
    isOperationTargetValid(project, 'v_carve_medial', makeTarget(['l1'])),
    'closed line should be valid target for v_carve_medial',
  )
}

function testClosedSubtractValidTargetForVCarve(): void {
  const project = projectWith([makeFeature('s1', 'subtract')])
  assert(
    isOperationTargetValid(project, 'v_carve', makeTarget(['s1'])),
    'closed subtract should remain valid for v_carve',
  )
}

function testOpenLineInvalidTargetForVCarve(): void {
  const project = projectWith([makeFeature('openL', 'line', false)])
  assert(
    !isOperationTargetValid(project, 'v_carve', makeTarget(['openL'])),
    'open line should be invalid for v_carve',
  )
}

function testOpenLineValidForFollowLine(): void {
  const project = projectWith([makeFeature('openL', 'line', false)])
  assert(
    isOperationTargetValid(project, 'follow_line', makeTarget(['openL'])),
    'open line should remain valid for follow_line',
  )
}

function testLineInvalidForPocket(): void {
  const project = projectWith([makeFeature('l1', 'line')])
  assert(
    !isOperationTargetValid(project, 'pocket', makeTarget(['l1'])),
    'line should be invalid for pocket',
  )
}

function testAddInvalidTargetForVCarve(): void {
  const project = projectWith([makeFeature('a1', 'add')])
  assert(
    !isOperationTargetValid(project, 'v_carve', makeTarget(['a1'])),
    'add should be invalid for v_carve',
  )
}

function testMixedSubtractAndLineValidForVCarve(): void {
  const project = projectWith([
    makeFeature('s1', 'subtract'),
    makeFeature('l1', 'line'),
  ])
  assert(
    isOperationTargetValid(project, 'v_carve', makeTarget(['s1', 'l1'])),
    'mixed subtract + closed line should be valid for v_carve',
  )
}

function testConstructionRejectedForVCarve(): void {
  const project = projectWith([makeFeature('c1', 'construction')])
  assert(
    !isOperationTargetValid(project, 'v_carve', makeTarget(['c1'])),
    'construction should be rejected for v_carve',
  )
}

// ── fallbackOperationTarget: V-carve picks first compatible ────────

function testFallbackVCarvePrefersSubtractBeforeLine(): void {
  const project = projectWith([
    makeFeature('s1', 'subtract'),
    makeFeature('l1', 'line'),
  ])
  const target = fallbackOperationTarget(project, 'v_carve')
  assert(target.source === 'features', 'fallback should use features source')
  assert(
    target.featureIds[0] === 's1',
    `fallback should pick first compatible feature (subtract), got ${target.featureIds[0]}`,
  )
}

function testFallbackVCarvePicksLineWhenNoSubtract(): void {
  const project = projectWith([
    makeFeature('add1', 'add'),
    makeFeature('l1', 'line'),
  ])
  const target = fallbackOperationTarget(project, 'v_carve')
  assert(target.source === 'features', 'fallback should use features source')
  assert(
    target.featureIds[0] === 'l1',
    `fallback should pick the line when no subtract exists, got ${target.featureIds[0]}`,
  )
}

function testFallbackVCarveSkipsOpenLine(): void {
  const project = projectWith([
    makeFeature('openL', 'line', false),
    makeFeature('s1', 'subtract'),
  ])
  const target = fallbackOperationTarget(project, 'v_carve')
  assert(target.source === 'features', 'fallback should use features source')
  assert(
    target.featureIds[0] === 's1',
    `fallback should skip open line, got ${target.featureIds[0]}`,
  )
}

function testFallbackVCarveStockWhenNoCompatible(): void {
  const project = projectWith([makeFeature('add1', 'add')])
  const target = fallbackOperationTarget(project, 'v_carve')
  assert(target.source === 'stock', 'fallback should return stock when no compatible feature exists')
}

function testFallbackPocketRemainsSubtractOnly(): void {
  const project = projectWith([
    makeFeature('l1', 'line'),
    makeFeature('s1', 'subtract'),
  ])
  const target = fallbackOperationTarget(project, 'pocket')
  assert(target.source === 'features', 'fallback should use features source')
  assert(
    target.featureIds[0] === 's1',
    'pocket fallback should still prefer subtract, not line',
  )
}

// ── Run ────────────────────────────────────────────────────────────

testClosedLineValidTargetForVCarve()
testClosedSubtractValidTargetForVCarve()
testOpenLineInvalidTargetForVCarve()
testOpenLineValidForFollowLine()
testLineInvalidForPocket()
testAddInvalidTargetForVCarve()
testMixedSubtractAndLineValidForVCarve()
testConstructionRejectedForVCarve()
testFallbackVCarvePrefersSubtractBeforeLine()
testFallbackVCarvePicksLineWhenNoSubtract()
testFallbackVCarveSkipsOpenLine()
testFallbackVCarveStockWhenNoCompatible()
testFallbackPocketRemainsSubtractOnly()

console.log('operationDefaults V-carve Line-target tests passed')
