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
 * Unit tests for gearProfile — external spur gear outline generation.
 *
 * Run with: npx tsx src/sketch/gearProfile.test.ts
 */

import type { Point, SketchProfile } from '../types/project'
import {
  buildGearProfile,
  defaultGearCreationParams,
  gearRootRadius,
  maxGearCrestRadius,
  maxGearRootFilletRadius,
  validateGearProfileParams,
  type GearProfileParams,
} from './gearProfile'

const epsilon = 1e-6
const TAU = Math.PI * 2

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function profilePoints(profile: SketchProfile): Point[] {
  return [profile.start, ...profile.segments.slice(0, -1).map((segment) => segment.to)]
}

function radius(point: Point, center: Point): number {
  return Math.hypot(point.x - center.x, point.y - center.y)
}

function normalizedAngle(point: Point, center: Point): number {
  const angle = Math.atan2(point.y - center.y, point.x - center.x)
  return angle < 0 ? angle + TAU : angle
}

function radiiInAngleWindow(profile: SketchProfile, center: Point, fromAngle: number, toAngle: number): number[] {
  return profilePoints(profile)
    .filter((point) => {
      const angle = normalizedAngle(point, center)
      return angle >= fromAngle - epsilon && angle <= toAngle + epsilon
    })
    .map((point) => radius(point, center))
}

function baseParams(overrides: Partial<GearProfileParams> = {}): GearProfileParams {
  const center = { x: 3, y: -2 }
  const outsideRadius = 20
  return {
    center,
    outsideRadius,
    ...defaultGearCreationParams(outsideRadius),
    ...overrides,
  }
}

function testDefaultProfileIsClosed() {
  const params = baseParams({ teeth: 24 })
  const profile = buildGearProfile(params)
  assert(profile.closed === true, 'gear profile should be closed')
  assert(profile.segments.length > params.teeth * 6, `expected sampled tooth outline, got ${profile.segments.length} segments`)
  const last = profile.segments.at(-1)
  assert(last !== undefined, 'profile should have a closing segment')
  assert(last.to.x === profile.start.x && last.to.y === profile.start.y, 'last segment should return to start')
  console.log('default profile closure: PASSED')
}

function testProfileRadiiStayInsideOutsideDiameter() {
  const params = baseParams({ teeth: 18 })
  const profile = buildGearProfile(params)
  const points = profilePoints(profile)
  const radii = points.map((point) => radius(point, params.center))
  const maxRadius = Math.max(...radii)
  const minRadius = Math.min(...radii)
  const expectedRootRadius = gearRootRadius(params)

  assert(maxRadius <= params.outsideRadius + epsilon, `max radius ${maxRadius} should not exceed outside radius ${params.outsideRadius}`)
  assert(maxRadius >= params.outsideRadius - epsilon, `max radius ${maxRadius} should reach outside radius ${params.outsideRadius}`)
  assert(minRadius >= expectedRootRadius - epsilon, `min radius ${minRadius} should not undercut root radius ${expectedRootRadius}`)
  assert(minRadius <= expectedRootRadius + epsilon, `min radius ${minRadius} should reach root radius ${expectedRootRadius}`)
  console.log('profile radii: PASSED')
}

function testStraightFlankProfileBuildsTrapezoidalTeeth() {
  const params = baseParams({ teeth: 12, flankProfile: 'straight', crestForm: 'rounded', rootForm: 'flat' })
  const profile = buildGearProfile(params)
  assert(profile.closed === true, 'straight-flank profile should be closed')
  assert(profile.segments.length >= params.teeth * 4, `expected at least four segments per tooth, got ${profile.segments.length}`)
  console.log('straight flank profile: PASSED')
}

function testSharpRootCreatesApexBelowShoulders() {
  const params = baseParams({ teeth: 12, flankProfile: 'straight', rootForm: 'sharp', crestForm: 'flat' })
  const profile = buildGearProfile(params)
  const rootRadius = gearRootRadius(params)
  const expectedShoulderRadius = rootRadius + maxGearRootFilletRadius(params)
  const pitch = TAU / params.teeth
  const rootRadii = radiiInAngleWindow(profile, params.center, pitch * 0.31, pitch * 0.69)

  assert(rootRadii.some((candidate) => Math.abs(candidate - rootRadius) < epsilon), 'sharp root should include a root-circle apex')
  assert(Math.max(...rootRadii) >= expectedShoulderRadius - epsilon, 'sharp root shoulders should sit above the apex')
  console.log('sharp root apex: PASSED')
}

function testRootFilletRadiusChangesRoundedRoot() {
  const smallParams = baseParams({ teeth: 12, flankProfile: 'straight', rootForm: 'rounded', rootFilletRadius: 0.1, crestForm: 'flat' })
  const largeParams = {
    ...smallParams,
    rootFilletRadius: maxGearRootFilletRadius(smallParams) * 0.8,
  }
  const smallProfile = buildGearProfile(smallParams)
  const largeProfile = buildGearProfile(largeParams)
  const pitch = TAU / smallParams.teeth
  const smallRadii = radiiInAngleWindow(smallProfile, smallParams.center, pitch * 0.31, pitch * 0.69)
  const largeRadii = radiiInAngleWindow(largeProfile, largeParams.center, pitch * 0.31, pitch * 0.69)
  const rootRadius = gearRootRadius(smallParams)

  assert(Math.max(...largeRadii) > Math.max(...smallRadii) + 0.5, 'larger root fillet radius should raise the rounded-root shoulders')
  assert(Math.min(...largeRadii) <= rootRadius + epsilon, 'rounded root should still reach the root radius')
  console.log('root fillet radius geometry: PASSED')
}

function testCrestRadiusChangesRoundedCrest() {
  const smallParams = baseParams({ teeth: 12, flankProfile: 'straight', rootForm: 'flat', crestForm: 'rounded', crestRadius: 0.1 })
  const largeParams = {
    ...smallParams,
    crestRadius: maxGearCrestRadius(smallParams) * 0.9,
  }
  const smallProfile = buildGearProfile(smallParams)
  const largeProfile = buildGearProfile(largeParams)
  const pitch = TAU / smallParams.teeth
  const crestWindowStart = pitch * 0.82
  const crestWindowEnd = pitch * 1.18
  const smallRadii = radiiInAngleWindow(smallProfile, smallParams.center, crestWindowStart, crestWindowEnd)
  const largeRadii = radiiInAngleWindow(largeProfile, largeParams.center, crestWindowStart, crestWindowEnd)

  assert(Math.min(...largeRadii) < Math.min(...smallRadii) - 0.5, 'larger crest radius should lower the rounded-crest shoulders')
  assert(Math.max(...largeRadii) >= largeParams.outsideRadius - epsilon, 'rounded crest should still reach the outside radius')
  console.log('crest radius geometry: PASSED')
}

function testValidationRejectsOversizedBore() {
  const params = baseParams({ boreDiameter: 40 })
  const errors = validateGearProfileParams(params)
  assert(errors.some((error) => error.includes('Bore diameter')), `expected bore validation error, got ${errors.join(', ')}`)
  console.log('bore validation: PASSED')
}

function testValidationRejectsOversizedCrestRadius() {
  const params = baseParams({ crestForm: 'rounded' })
  const errors = validateGearProfileParams({
    ...params,
    crestRadius: maxGearCrestRadius(params) + 0.01,
  })

  assert(errors.some((error) => error.includes('Crest radius')), `expected crest radius validation error, got ${errors.join(', ')}`)
  console.log('crest radius validation: PASSED')
}

function testValidationRejectsCrossedInvoluteCrest() {
  for (const teeth of [6, 8, 12]) {
    const params = baseParams({ teeth, pressureAngleDeg: 35, crestForm: 'flat' })
    const errors = validateGearProfileParams(params)
    assert(errors.some((error) => error.includes('involute flanks would cross')), `expected crossed involute validation error for ${teeth} teeth, got ${errors.join(', ')}`)
    let threw = false
    try {
      buildGearProfile(params)
    } catch {
      threw = true
    }
    assert(threw, `buildGearProfile should reject crossed involute crest for ${teeth} teeth`)
  }
  console.log('crossed involute crest validation: PASSED')
}

testDefaultProfileIsClosed()
testProfileRadiiStayInsideOutsideDiameter()
testStraightFlankProfileBuildsTrapezoidalTeeth()
testSharpRootCreatesApexBelowShoulders()
testRootFilletRadiusChangesRoundedRoot()
testCrestRadiusChangesRoundedCrest()
testValidationRejectsOversizedBore()
testValidationRejectsOversizedCrestRadius()
testValidationRejectsCrossedInvoluteCrest()
