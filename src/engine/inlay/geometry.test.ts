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
 * WP1 tests for the inlay geometry core. Pure math: no store, no toolpaths.
 *
 * Run with: npx tsx src/engine/inlay/geometry.test.ts
 */

import { circleProfile, getProfileBounds, rectProfile } from '../../types/project'
import { flattenProfile } from '../toolpaths/geometry'
import { computeInlayGeometry, INLAY_FRAME_MARGIN } from './geometry'
import type { SketchFeature, SketchProfile } from '../../types/project'
import type { InlayGeometryInput, InlayParams } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approxEq(actual: number, expected: number, eps: number, label: string): void {
  assert(
    Math.abs(actual - expected) <= eps,
    `${label}: expected ${expected}, got ${actual}`,
  )
}

function makeFeature(id: string, profile: SketchProfile, operation: 'subtract' | 'add'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'composite',
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation,
    z_top: 0,
    z_bottom: -1,
    visible: true,
    locked: false,
  }
}

const REFERENCE_PARAMS: InlayParams = {
  vBitAngle: 60,
  vBitDiameter: 6.35,
  pocketDepth: 2,
  surfaceGap: 0.2,
  fitAdjustment: 0.05,
  stockThickness: 18,
  plugBaseThickness: 3,
  wallStep: 0.25,
  mirror: true,
}

function input(
  shapes: InlayGeometryInput['shapes'],
  params: InlayParams = REFERENCE_PARAMS,
): InlayGeometryInput {
  return { shapes, params, units: 'mm', plugOrigin: { x: 200, y: 0 } }
}

function rectShape(id: string, x: number, y: number, w: number, h: number, operation: 'subtract' | 'add') {
  return { profile: rectProfile(x, y, w, h), operation, sourceFeature: makeFeature(id, rectProfile(x, y, w, h), operation) }
}

function signedArea(profile: SketchProfile): number {
  const points = flattenProfile(profile).points
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    sum += current.x * next.y - next.x * current.y
  }
  return sum / 2
}

// 1. Reference numbers from the plan (§4.5).
{
  const result = computeInlayGeometry(input([rectShape('plate', 0, 0, 100, 100, 'subtract')]))
  approxEq(result.derived.slope, Math.tan(Math.PI / 6), 1e-12, 'slope')
  approxEq(result.derived.plugDepth, 2.2, 1e-12, 'plugDepth')
  approxEq(result.derived.floorInset, 1.1047, 1e-4, 'floorInset')
  approxEq(result.derived.ridgeInset, 1.32017, 1e-5, 'ridgeInset')
  approxEq(result.derived.shoulderInset, 0.05, 1e-12, 'shoulderInset')
  approxEq(result.derived.stepover, 0.144337, 1e-6, 'stepover')
  approxEq(result.derived.grooveWidth, 2.54034, 1e-5, 'grooveWidth')
  assert(result.problems.length === 0, `clean reference has no problems, got ${JSON.stringify(result.problems)}`)
  assert(result.pocketFloor.length === 1 && result.plugRidge.length === 1 && result.plugShoulder.length === 1, 'one shape per role')
  console.log('ok 1 - reference math')
}

// 2. Mirror about the vertical plug axis: x flips, y and frame follow.
{
  const result = computeInlayGeometry(input([rectShape('plate', 0, 0, 100, 100, 'subtract')]))
  const ridge = getProfileBounds(result.plugRidge[0].profile)
  approxEq(ridge.minX, 200 + 200 - 100 + 1.32017, 1e-3, 'mirrored ridge minX')
  approxEq(ridge.maxX, 200 + 200 - 1.32017, 1e-3, 'mirrored ridge maxX')
  approxEq(ridge.minY, 1.32017, 1e-3, 'ridge keeps y')
  approxEq(ridge.maxY, 98.67983, 1e-3, 'ridge keeps y max')
  const frame = getProfileBounds(result.frame)
  approxEq(frame.minX, 300 - INLAY_FRAME_MARGIN, 1e-6, 'frame minX')
  approxEq(frame.maxX, 400 + INLAY_FRAME_MARGIN, 1e-6, 'frame maxX')
  approxEq(frame.minY, -INLAY_FRAME_MARGIN, 1e-6, 'frame minY')
  approxEq(frame.maxY, 100 + INLAY_FRAME_MARGIN, 1e-6, 'frame maxY')
  assert(result.plugRidge[0].operation === 'add', 'plug boundary of a subtract source is an island')
  console.log('ok 2 - mirror and frame')
}

// 3. Counter loops keep their role: hole in the pocket becomes a hole in the plug.
{
  const outer = rectShape('outer', 0, 0, 100, 100, 'subtract')
  const hole = rectShape('hole', 40, 40, 20, 20, 'add')
  const result = computeInlayGeometry(input([outer, hole]))
  assert(result.pocketFloor.length === 2, 'pocket keeps both loops')
  const pocketOuter = result.pocketFloor.find((shape) => shape.sourceFeatureId === 'outer')
  const pocketHole = result.pocketFloor.find((shape) => shape.sourceFeatureId === 'hole')
  assert(!!pocketOuter && pocketOuter.operation === 'subtract', 'pocket outer stays subtract')
  if (!pocketHole) throw new Error('Assertion failed: pocket keeps the hole loop')
  assert(pocketHole.operation === 'add', 'pocket hole stays add')
  const holeBounds = getProfileBounds(pocketHole.profile)
  approxEq(holeBounds.minX, 38.8953, 1e-3, 'pocket hole grows inward by floorInset')

  const plugHole = result.plugRidge.find((shape) => shape.sourceFeatureId === 'hole')
  if (!plugHole) throw new Error('Assertion failed: plug keeps the hole loop')
  assert(plugHole.operation === 'subtract', 'plug hole becomes subtract')
  const plugHoleBounds = getProfileBounds(plugHole.profile)
  approxEq(plugHoleBounds.minX, 200 + 200 - 60 - 1.32017, 1e-3, 'plug hole expands by the ridge inset after mirror')
  console.log('ok 3 - counter loops keep their role')
}

// 4. A strip thinner than the floor inset is refused, not silently offset to nothing.
{
  const result = computeInlayGeometry(input([rectShape('strip', 0, 0, 10, 0.5, 'subtract')]))
  assert(
    result.problems.some((problem) => problem.code === 'tooThin'),
    `thin strip reports tooThin, got ${JSON.stringify(result.problems)}`,
  )
  console.log('ok 4 - too thin')
}

// 5. Hardware and stock refusals.
{
  const shallow = computeInlayGeometry(input(
    [rectShape('plate', 0, 0, 100, 100, 'subtract')],
    { ...REFERENCE_PARAMS, vBitDiameter: 2 },
  ))
  assert(shallow.problems.some((problem) => problem.code === 'grooveWiderThanBit'), 'groove wider than bit')

  const thinBase = computeInlayGeometry(input(
    [rectShape('plate', 0, 0, 100, 100, 'subtract')],
    { ...REFERENCE_PARAMS, stockThickness: 4 },
  ))
  assert(thinBase.problems.some((problem) => problem.code === 'baseTooThin'), 'base too thin')

  const through = computeInlayGeometry(input(
    [rectShape('plate', 0, 0, 100, 100, 'subtract')],
    { ...REFERENCE_PARAMS, stockThickness: 2 },
  ))
  assert(through.problems.some((problem) => problem.code === 'depthTooDeep'), 'depth through stock')
  console.log('ok 5 - refusals')
}

// 6. Mirroring a curved profile flips its winding and keeps every point on the same row.
{
  const source = circleProfile(50, 50, 20)
  const shape = { profile: source, operation: 'subtract' as const, sourceFeature: makeFeature('disc', source, 'subtract') }
  const mirrored = computeInlayGeometry(input([shape]))
  const ridge = getProfileBounds(mirrored.plugRidge[0].profile)
  approxEq((ridge.minX + ridge.maxX) / 2, 350, 1e-3, 'mirrored circle centre x')
  approxEq((ridge.minY + ridge.maxY) / 2, 50, 1e-3, 'mirrored circle centre y')
  assert(
    Math.sign(signedArea(source)) !== Math.sign(signedArea(mirrored.plugRidge[0].profile)),
    'mutation: mirrored profile winds the other way',
  )
  console.log('ok 6 - curved mirror')
}

// 7. Invalid parameters fail loudly instead of producing a plausible wrong path.
{
  let threw = false
  try {
    computeInlayGeometry(input(
      [rectShape('plate', 0, 0, 100, 100, 'subtract')],
      { ...REFERENCE_PARAMS, vBitAngle: 180 },
    ))
  } catch {
    threw = true
  }
  assert(threw, 'angle 180 is rejected')
  console.log('ok 7 - validation')
}

console.log('inlay geometry: all tests passed')
