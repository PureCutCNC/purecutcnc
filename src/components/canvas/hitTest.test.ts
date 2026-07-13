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
 *
 * Run with: npx tsx src/components/canvas/hitTest.test.ts
 */

/**
 * Tests for canvas hit testing through resolved world-space features (slice 03).
 *
 * Verifies that hit testing uses the resolver so features with non-identity
 * transforms are hit at their world position, not their definition-local position.
 */

import { rectProfile } from '../../types/project'
import { newProject, type Matrix2D, type Project, type SketchFeature } from '../../types/project'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { projectWithFeatures } from '../../test/projectFixtures'
import { findHitFeatureId, featureFullyInsideRect } from './hitTest'
import type { ViewTransform } from './viewTransform'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

// Simple view transform: scale=1, no offset → world coords = screen coords.
const vt: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }

// ── Helpers ────────────────────────────────────────────────────────

function makeFeature(
  id: string,
  profile = rectProfile(0, 0, 10, 6),
  overrides: Partial<SketchFeature> = {},
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
    ...overrides,
  }
}

function makeProject(
  features: SketchFeature[],
  transforms?: Map<string, Matrix2D>,
): Project {
  return projectWithFeatures(newProject('hit-test'), features.map((feature) => ({
    ...feature,
    definitionId: feature.id,
    transform: transforms?.get(feature.id),
  })))
}

// ── Tests ──────────────────────────────────────────────────────────

// Identity-migrated feature: hit test uses world-space profile (same as local).
{
  console.log('1. Identity-migrated feature hit testing...')

  const rect = rectProfile(0, 0, 10, 6)
  const feature = makeFeature('f0001', rect)
  const project = makeProject([feature])

  // Point inside the feature (5, 3)
  const hit1 = findHitFeatureId({ x: 5, y: 3 }, resolvedProjectFeatures(project), vt)
  assert(hit1 === 'f0001', 'point inside identity feature should hit')

  // Point outside the feature (50, 50)
  const hit2 = findHitFeatureId({ x: 50, y: 50 }, resolvedProjectFeatures(project), vt)
  assert(hit2 === null, 'point far from identity feature should not hit')

  console.log('   ✓ identity-migrated hit test correct')
}

// Transformed feature: hit test finds feature at its world position.
{
  console.log('2. Transformed feature hit testing...')

  // Definition-local profile at (0,0)-(10,6)
  const definitionProfile = rectProfile(0, 0, 10, 6)
  const feature = makeFeature('f0001', definitionProfile)

  // Transform: translate by (100, 50). World-space profile is at (100,50)-(110,56).
  const translateTransform: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 }
  const project = makeProject([feature], new Map([['f0001', translateTransform]]))

  // Verify the feature has definitionId + transform
  const raw = project.features[0]
  assert(raw.definitionId === 'f0001', 'feature should have definitionId')
  assert(raw.transform?.e === 100 && raw.transform?.f === 50, 'feature should have translate transform')

  // Point at world position (105, 53) — inside the transformed profile.
  const hitWorld = findHitFeatureId({ x: 105, y: 53 }, resolvedProjectFeatures(project), vt)
  assert(hitWorld === 'f0001', 'point inside transformed world profile should hit')

  // Point at definition-local position (5, 3) — should NOT hit because the
  // world-space profile is at (100,50)-(110,56), and (5,3) is outside it.
  const hitLocal = findHitFeatureId({ x: 5, y: 3 }, resolvedProjectFeatures(project), vt)
  assert(hitLocal === null, 'point at definition-local position should NOT hit transformed feature')

  console.log('   ✓ transformed feature hit test correct')
}

// featureFullyInsideRect with resolved features.
{
  console.log('3. featureFullyInsideRect with resolved features...')

  const definitionProfile = rectProfile(0, 0, 10, 6)
  const feature = makeFeature('f0001', definitionProfile)
  const translateTransform: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 }
  const project = makeProject([feature], new Map([['f0001', translateTransform]]))
  const resolvedList = resolvedProjectFeatures(project)

  // The world-space rect is at (100,50)-(110,56).
  // A rect that fully encloses it: (99,49)-(111,57)
  assert(
    featureFullyInsideRect(resolvedList[0], 99, 49, 111, 57),
    'enclosing rect should contain transformed feature',
  )
  // A rect at the definition-local position should NOT contain the world-space feature.
  assert(
    !featureFullyInsideRect(resolvedList[0], 0, 0, 10, 6),
    'definition-local rect should not contain transformed feature',
  )

  console.log('   ✓ featureFullyInsideRect correct')
}

// Missing definition: skipped, no crash.
{
  console.log('4. Missing definition handling in hit test...')

  // Create a feature with an explicit definitionId that doesn't exist.
  const orphanFeature = {
    ...makeFeature('orphan', rectProfile(10, 20, 30, 40)),
    definitionId: 'nonexistent',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  }
  const project = makeProject([orphanFeature as SketchFeature])
  project.features[0] = {
    ...project.features[0],
    definitionId: 'nonexistent',
  }
  delete project.featureDefinitions.orphan

  // resolvedProjectFeatures should skip the orphan (missing definition).
  const resolvedList = resolvedProjectFeatures(project)
  assert(resolvedList.length === 0, 'orphan with missing definition should be skipped')

  // findHitFeatureId should not crash with an empty resolved list.
  const hit = findHitFeatureId({ x: 25, y: 40 }, resolvedList, vt)
  assert(hit === null, 'no hit when all features skipped')

  console.log('   ✓ missing definition handled without crash')
}

// Existing operation target IDs remain instance IDs.
{
  console.log('5. Resolved feature preserves instance ID...')

  const rect = rectProfile(0, 0, 10, 6)
  const feature = makeFeature('f0001', rect)
  const project = makeProject([feature])
  const resolvedList = resolvedProjectFeatures(project)

  assert(resolvedList.length === 1, 'one resolved feature')
  assert(resolvedList[0].id === 'f0001', 'resolved feature id = instance id')
  assert(resolvedList[0].instanceId === 'f0001', 'resolved instanceId = feature id')

  console.log('   ✓ instance IDs preserved')
}

console.log('\nall hitTest.test.ts assertions passed')
