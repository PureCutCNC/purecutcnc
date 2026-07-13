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
 * Run with: npx tsx src/engine/toolpaths/resolverReadPath.test.ts
 */

/**
 * Tests for toolpath operation target resolution through resolved world-space
 * features (slice 03 read-path migration).
 *
 * Verifies that pocket region resolution uses the resolver so features with
 * non-identity transforms contribute world-space geometry.
 */

import { rectProfile } from '../../types/project'
import type {
  Matrix2D,
  Operation,
  Project,
  SketchFeature,
} from '../../types/project'
import { newProject } from '../../types/project'
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'
import { projectWithFeatures } from '../../test/projectFixtures'
import { resolvePocketRegions } from './resolver'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

// ── Helpers ────────────────────────────────────────────────────────

function makeSubtractFeature(
  id: string,
  profile = rectProfile(0, 0, 20, 10),
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
  }
}

function makeProject(features: SketchFeature[], transforms?: Map<string, Matrix2D>): Project {
  return projectWithFeatures(newProject('tp-test'), features.map((feature) => ({
    ...feature,
    definitionId: feature.id,
    transform: transforms?.get(feature.id),
  })))
}

function makePocketOp(id: string, featureIds: string[]): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
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
  }
}

// ── Tests ──────────────────────────────────────────────────────────

// Transformed feature profile resolves to world-space in the resolver.
{
  console.log('1. Resolved feature profile is world-space after transform...')

  const definitionProfile = rectProfile(0, 0, 20, 10)
  const feature = makeSubtractFeature('f0001', definitionProfile)
  const translateTransform: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 50, f: 30 }
  const project = makeProject([feature], new Map([['f0001', translateTransform]]))

  const resolved = resolveFeatureInstance(project, 'f0001')
  assert(resolved !== null, 'resolved feature should not be null')

  const worldStart = resolved!.sketch.profile.start
  assert(approx(worldStart.x, 50) && approx(worldStart.y, 30),
    `world-space start should be (50, 30), got (${worldStart.x.toFixed(4)}, ${worldStart.y.toFixed(4)})`)

  console.log('   ✓ resolved profile is world-space')
}

// Pocket operation with transformed feature: bands use world-space geometry.
{
  console.log('2. Pocket region resolution uses world-space geometry...')

  const definitionProfile = rectProfile(0, 0, 20, 10)
  const feature = makeSubtractFeature('f0001', definitionProfile)
  const translateTransform: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 }
  const project = makeProject([feature], new Map([['f0001', translateTransform]]))
  const op = makePocketOp('op1', ['f0001'])

  const result = resolvePocketRegions(project, op)

  assert(result.bands.length > 0,
    `expected at least one band, got ${result.bands.length} (warnings: ${result.warnings.join('; ')})`)

  const band = result.bands[0]
  assert(band.targetFeatureIds.includes('f0001'), 'target feature ID should be instance ID')

  const region = band.regions.find((r) => r.targetFeatureIds.includes('f0001'))
  assert(region !== undefined, 'should find a region for f0001')

  const outerPoints = region!.outer
  assert(outerPoints.length >= 3, 'outer region should have at least 3 points')

  // At least one point should be near world-space (around x=100, y=50).
  const hasWorldPoint = outerPoints.some(
    (p) => approx(p.x, 100, 1) || approx(p.x, 120, 1) || approx(p.y, 50, 1) || approx(p.y, 60, 1),
  )
  assert(hasWorldPoint,
    `region points should be near world-space, got x:[${outerPoints.map(p => p.x.toFixed(1)).join(',')}] y:[${outerPoints.map(p => p.y.toFixed(1)).join(',')}]`)

  console.log('   ✓ pocket region geometry is world-space')
}

// Identity-migrated feature: pocket resolution equivalent.
{
  console.log('3. Identity-migrated pocket resolution...')

  const profile = rectProfile(10, 10, 30, 20)
  const feature = makeSubtractFeature('f0001', profile)
  const project = makeProject([feature])
  const op = makePocketOp('op1', ['f0001'])

  const result = resolvePocketRegions(project, op)

  assert(result.bands.length > 0, `expected at least one band, got ${result.bands.length}`)

  const band = result.bands[0]
  const region = band.regions.find((r) => r.targetFeatureIds.includes('f0001'))
  assert(region !== undefined, 'should find a region for f0001')

  const outerPoints = region!.outer
  const hasOriginalPoint = outerPoints.some(
    (p) => approx(p.x, 10, 1) || approx(p.x, 40, 1) || approx(p.y, 10, 1) || approx(p.y, 30, 1),
  )
  assert(hasOriginalPoint,
    `identity region should be at original position, got x:[${outerPoints.map(p => p.x.toFixed(1)).join(',')}]`)

  console.log('   ✓ identity-migrated pocket resolution correct')
}

// Operation target IDs are instance IDs.
{
  console.log('4. Operation target IDs remain instance IDs...')

  const profile = rectProfile(0, 0, 20, 10)
  const feature = makeSubtractFeature('instance-1', profile)
  const project = makeProject([feature])
  const op = makePocketOp('op1', ['instance-1'])

  const result = resolvePocketRegions(project, op)

  assert(result.bands.length > 0, 'should have bands')
  assert(result.bands[0].targetFeatureIds.includes('instance-1'),
    'target IDs should use instance IDs')

  console.log('   ✓ target IDs are instance IDs')
}

// Explicit missing definition: skipped, non-crashing.
{
  console.log('5. Explicit missing definition skipped in toolpath resolution...')

  const orphanFeature = {
    ...makeSubtractFeature('orphan', rectProfile(0, 0, 20, 10)),
    definitionId: 'nonexistent',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  }
  const project = makeProject([orphanFeature as SketchFeature])
  project.features[0] = {
    ...project.features[0],
    definitionId: 'nonexistent',
  }
  delete project.featureDefinitions.orphan
  const op = makePocketOp('op1', ['orphan'])

  // Explicit missing definitionId → resolver returns null → Slice 02 contract
  // says skip (no raw-geometry fallback).  The feature contributes empty
  // Clipper paths, so the pocket resolver produces no bands.
  const result = resolvePocketRegions(project, op)
  assert(result.bands.length === 0,
    `explicit missing definition should produce 0 bands, got ${result.bands.length}`)
  assert(result.warnings.length > 0,
    'should produce a warning about empty geometry')
  console.log(`   result: ${result.bands.length} bands, warnings: ${result.warnings.join('; ') || 'none'}`)

  console.log('   ✓ explicit missing definition skipped, no crash')
}

// Strict current row without its definition is skipped; there is no raw fallback.
{
  console.log('6. Current row without definition has no fallback geometry...')

  const feature = makeSubtractFeature('transitional', rectProfile(10, 10, 30, 20))
  const project = makeProject([feature])
  delete project.featureDefinitions['transitional']

  const op = makePocketOp('op1', ['transitional'])

  const result = resolvePocketRegions(project, op)
  assert(result.bands.length === 0,
    `missing definition should resolve no geometry, got ${result.bands.length} bands`)
  console.log(`   result: ${result.bands.length} bands, warnings: ${result.warnings.join('; ') || 'none'}`)

  console.log('   ✓ missing definition has no fallback')
}

console.log('\nall resolverReadPath.test.ts assertions passed')
