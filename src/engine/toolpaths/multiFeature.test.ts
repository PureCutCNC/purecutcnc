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
 * Unit tests for isFeatureFirst target-splitting policy.
 *
 * Run with: npx tsx src/engine/toolpaths/multiFeature.test.ts
 *
 * The V-carve special case (issue #340): a v-carve/v-carve-medial operation
 * whose targets include a closed *line* must be resolved together so the
 * line-line even-odd fill survives — splitting it per feature destroys the
 * hole topology. This must NOT disable per-feature splitting for v-carve
 * operations that have no line targets (e.g. multiple disjoint subtracts),
 * which still split as before.
 */

import type { Operation, OperationKind, SketchFeature } from '../../types/project'
import { newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { isFeatureFirst } from './multiFeature'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function makeFeature(id: string, operation: 'subtract' | 'line' | 'add' | 'region'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 10, 10),
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

function makeOp(kind: OperationKind, featureIds: string[], machiningOrder: 'level_first' | 'feature_first'): Operation {
  return {
    id: 'op1',
    name: 'op1',
    kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: null,
    stepdown: 2,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
    machiningOrder,
  }
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

// ── V-carve: split unless a line target is present (issue #340) ─────────

test('v_carve with multiple non-line (subtract) targets still splits per feature', () => {
  const project = projectWithFeatures(newProject(), [makeFeature('a', 'subtract'), makeFeature('b', 'subtract')])
  const op = makeOp('v_carve', ['a', 'b'], 'feature_first')
  assert(isFeatureFirst(op, project) === true,
    'v_carve of disjoint subtracts in feature_first must still split per feature')
})

test('v_carve_medial with multiple non-line targets still splits per feature', () => {
  const project = projectWithFeatures(newProject(), [makeFeature('a', 'subtract'), makeFeature('b', 'subtract')])
  const op = makeOp('v_carve_medial', ['a', 'b'], 'feature_first')
  assert(isFeatureFirst(op, project) === true,
    'v_carve_medial of disjoint subtracts in feature_first must still split per feature')
})

test('v_carve with a line target does NOT split (even-odd fill preserved)', () => {
  const project = projectWithFeatures(newProject(), [makeFeature('outer', 'line'), makeFeature('inner', 'line')])
  const op = makeOp('v_carve', ['outer', 'inner'], 'feature_first')
  assert(isFeatureFirst(op, project) === false,
    'v_carve including a line target must be resolved together, not split')
})

test('v_carve with a mixed line + subtract target does NOT split', () => {
  const project = projectWithFeatures(newProject(), [makeFeature('l', 'line'), makeFeature('s', 'subtract')])
  const op = makeOp('v_carve', ['l', 's'], 'feature_first')
  assert(isFeatureFirst(op, project) === false,
    'a single line target anywhere in a v_carve must suppress splitting')
})

test('v_carve without a project is conservative and does not split', () => {
  const op = makeOp('v_carve', ['a', 'b'], 'feature_first')
  assert(isFeatureFirst(op) === false,
    'without a project we cannot check for line targets — must not split')
})

// ── Non-v-carve kinds are unaffected by the line rule ───────────────────

test('non-v-carve (pocket) with multiple targets splits regardless of feature operation', () => {
  const project = projectWithFeatures(newProject(), [makeFeature('a', 'subtract'), makeFeature('b', 'subtract')])
  const op = makeOp('pocket', ['a', 'b'], 'feature_first')
  assert(isFeatureFirst(op, project) === true,
    'pocket feature_first with multiple targets must split as before')
})

// ── Baseline gates ──────────────────────────────────────────────────────

test('level_first is never feature-first', () => {
  const project = projectWithFeatures(newProject(), [makeFeature('a', 'subtract'), makeFeature('b', 'subtract')])
  const op = makeOp('v_carve', ['a', 'b'], 'level_first')
  assert(isFeatureFirst(op, project) === false, 'level_first must never be feature-first')
})

test('single target is never feature-first', () => {
  const project = projectWithFeatures(newProject(), [makeFeature('a', 'subtract')])
  const op = makeOp('v_carve', ['a'], 'feature_first')
  assert(isFeatureFirst(op, project) === false, 'a single target must never split')
})

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
