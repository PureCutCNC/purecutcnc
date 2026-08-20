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

import type { SketchProfile } from '../types/project'
import { applyFeatureDistributionTransform, measureProfilePath, planFeatureDistribution } from './featureDistribution'

const epsilon = 1e-6

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function close(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < epsilon, `${message}: expected ${expected}, got ${actual}`)
}

function testGridKeepsTheSourceAsOriginAndTapersCreatedCopies() {
  const plan = planFeatureDistribution({
    sourcePivot: { x: 10, y: 20 },
    spec: { mode: 'grid', rows: 2, columns: 3, spacingX: 4, spacingY: 5, startScale: 100, endScale: 60 },
  })
  assert(plan.ok, 'grid plan should be valid')
  assert(plan.placements.length === 5, '2 x 3 grid should create all cells except the source')
  close(plan.placements[0]!.position.x, 14, 'first grid copy x')
  close(plan.placements[3]!.position.y, 25, 'second grid row y')
  close(plan.placements[0]!.scale, 1, 'first scale')
  close(plan.placements[2]!.scale, 0.8, 'middle scale')
  close(plan.placements[4]!.scale, 0.6, 'last scale')
  console.log('grid placement and scale taper: PASSED')
}

function testRadialFullCircleAvoidsDuplicatingTheEndpoint() {
  const plan = planFeatureDistribution({
    sourcePivot: { x: 10, y: 0 },
    spec: {
      mode: 'radial', center: { x: 0, y: 0 }, copyCount: 4,
      startAngleDegrees: 0, sweepDegrees: 360, orientation: 'follow', startScale: 100, endScale: 100,
    },
  })
  assert(plan.ok, 'radial plan should be valid')
  assert(plan.placements.length === 4, 'full circle should produce the requested count')
  close(plan.placements[0]!.position.x, 10, 'radial start x')
  close(plan.placements[1]!.position.y, 10, 'radial quarter turn y')
  close(plan.placements[3]!.position.y, -10, 'radial final copy y')
  close(plan.placements[3]!.rotationRadians, Math.PI * 1.5, 'follow rotation should advance with the radial copy')
  console.log('radial full circle endpoint: PASSED')
}

function testPathSupportsMixedLineAndArcAtEqualArcLength() {
  const guide: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line', to: { x: 10, y: 0 } },
      { type: 'arc', center: { x: 10, y: 10 }, to: { x: 20, y: 10 }, clockwise: false },
    ],
    closed: false,
  }
  const plan = planFeatureDistribution({
    sourcePivot: { x: 0, y: 0 },
    guideProfile: guide,
    spec: { mode: 'path', copyCount: 3, startOffset: 0, endOffset: 10 + Math.PI * 5, orientation: 'follow', startScale: 100, endScale: 100 },
  })
  assert(plan.ok, 'mixed path plan should be valid')
  assert(plan.placements.length === 3, 'path should create requested copies')
  close(plan.placements[0]!.position.x, 0, 'path start x')
  close(plan.placements[2]!.position.x, 20, 'path end x')
  close(plan.placements[2]!.position.y, 10, 'path end y')
  console.log('mixed line and arc path spacing: PASSED')
}

function testBezierPathIsDeterministicAndUsesItsTangent() {
  const guide: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [{ type: 'bezier', control1: { x: 0, y: 20 }, control2: { x: 20, y: 20 }, to: { x: 20, y: 0 } }],
    closed: false,
  }
  const length = measureProfilePath(guide)?.length
  assert(length, 'Bézier guide should have a measurable length')
  const input = {
    sourcePivot: { x: 0, y: 0 },
    guideProfile: guide,
    spec: { mode: 'path' as const, copyCount: 3, startOffset: 0, endOffset: length, orientation: 'follow' as const, startScale: 100, endScale: 100 },
  }
  const first = planFeatureDistribution(input)
  const second = planFeatureDistribution(input)
  assert(first.ok && second.ok, 'Bézier plans should be valid')
  assert(JSON.stringify(first.placements) === JSON.stringify(second.placements), 'Bézier planning should be deterministic')
  assert(first.placements[0]!.rotationRadians > 1.5, 'initial Bézier tangent should face downward in screen coordinates')
  console.log('Bézier path determinism and tangent: PASSED')
}

function testClosedPathUsesTheSeamWithoutDuplicatingIt() {
  const guide: SketchProfile = {
    start: { x: 0, y: 0 },
    segments: [
      { type: 'line', to: { x: 10, y: 0 } },
      { type: 'line', to: { x: 10, y: 10 } },
      { type: 'line', to: { x: 0, y: 10 } },
      { type: 'line', to: { x: 0, y: 0 } },
    ],
    closed: true,
  }
  const plan = planFeatureDistribution({
    sourcePivot: { x: 0, y: 0 },
    guideProfile: guide,
    spec: { mode: 'path', copyCount: 4, startOffset: 0, endOffset: 0, orientation: 'fixed', startScale: 100, endScale: 100 },
  })
  assert(plan.ok, 'closed path plan should be valid')
  assert(plan.placements.length === 4, 'closed path should create requested copies')
  close(plan.placements[0]!.position.x, 0, 'closed path first x')
  close(plan.placements[1]!.position.x, 10, 'closed path second x')
  close(plan.placements[3]!.position.y, 10, 'closed path final copy should precede the seam')
  assert(plan.placements[3]!.position.x === 0 && plan.placements[3]!.position.y !== 0, 'closed path must not duplicate its first point')
  console.log('closed path seam: PASSED')
}

function testPlacementTransformMapsTheGroupPivotToTheTarget() {
  const plan = planFeatureDistribution({
    sourcePivot: { x: 4, y: 6 },
    spec: { mode: 'grid', rows: 1, columns: 2, spacingX: 12, spacingY: 0, startScale: 75, endScale: 75 },
  })
  assert(plan.ok, 'transform plan should be valid')
  const mapped = applyFeatureDistributionTransform(plan.placements[0]!.transform, { x: 4, y: 6 })
  close(mapped.x, 16, 'transform pivot x')
  close(mapped.y, 6, 'transform pivot y')
  console.log('placement pivot mapping: PASSED')
}

testGridKeepsTheSourceAsOriginAndTapersCreatedCopies()
testRadialFullCircleAvoidsDuplicatingTheEndpoint()
testPathSupportsMixedLineAndArcAtEqualArcLength()
testBezierPathIsDeterministicAndUsesItsTangent()
testClosedPathUsesTheSeamWithoutDuplicatingIt()
testPlacementTransformMapsTheGroupPivotToTheTarget()
