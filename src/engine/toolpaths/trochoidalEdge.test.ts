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

import type { Point } from '../../types/project'
import { buildTrochoidalContour } from './trochoidalEdge'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon
}

const rectangle: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]

function testClosedPeriodicPath(): void {
  const result = buildTrochoidalContour(rectangle, {
    orbitRadius: 2,
    advance: 1,
    toolDiameter: 4,
    angularDirection: 1,
  })
  assert(result.error === undefined, `unexpected error ${result.error}`)
  assert(result.loopCount === 40, `expected 40 loops, got ${result.loopCount}`)
  assert(approx(result.actualAdvance, 1), `expected 1 mm actual advance, got ${result.actualAdvance}`)
  assert(result.entryCenter !== null, 'expected entry center')
  assert(result.points.length > result.loopCount * 36, 'expected entry orbit plus moving loops')

  const first = result.points[0]
  const last = result.points.at(-1)!
  assert(approx(first.x, last.x) && approx(first.y, last.y), 'closed path must meet exactly at its seam')
  assert(result.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)), 'all points must be finite')
}

function testOrbitRadiusAndDirection(): void {
  for (const angularDirection of [1, -1] as const) {
    const result = buildTrochoidalContour(rectangle, {
      orbitRadius: 2,
      advance: 2,
      toolDiameter: 4,
      angularDirection,
    })
    assert(result.entryCenter !== null, 'expected entry center')
    const first = result.points[0]
    const second = result.points[1]
    const firstRadius = { x: first.x - result.entryCenter.x, y: first.y - result.entryCenter.y }
    const secondRadius = { x: second.x - result.entryCenter.x, y: second.y - result.entryCenter.y }
    assert(approx(Math.hypot(firstRadius.x, firstRadius.y), 2), 'first point must use requested orbit radius')
    assert(approx(Math.hypot(secondRadius.x, secondRadius.y), 2), 'entry orbit must preserve requested radius')
    const cross = firstRadius.x * secondRadius.y - firstRadius.y * secondRadius.x
    assert(Math.sign(cross) === angularDirection, `expected angular direction ${angularDirection}, got cross ${cross}`)
  }
}

function testDeterminismAndSeam(): void {
  const options = { orbitRadius: 1.5, advance: 0.75, toolDiameter: 3, angularDirection: 1 as const }
  const first = buildTrochoidalContour(rectangle, options)
  const second = buildTrochoidalContour(rectangle, options)
  assert(JSON.stringify(first) === JSON.stringify(second), 'same guide and settings must produce identical output')

  const circle = Array.from({ length: 96 }, (_, index) => {
    const angle = 2 * Math.PI * index / 96
    return { x: 15 * Math.cos(angle), y: 15 * Math.sin(angle) }
  })
  const circular = buildTrochoidalContour(circle, { ...options, angularDirection: -1, advance: 0.7 })
  assert(circular.error === undefined, `unexpected circular-guide error ${circular.error}`)
  assert(approx(circular.points[0].x, circular.points.at(-1)!.x) && approx(circular.points[0].y, circular.points.at(-1)!.y), 'circular guide must close exactly')
  assert(circular.actualAdvance <= 0.7 + 1e-9, 'integer loop adjustment must not exceed requested advance')
}

function testInvalidInputsAndBudget(): void {
  const invalid = buildTrochoidalContour([{ x: 0, y: 0 }, { x: 1, y: 0 }], {
    orbitRadius: 1,
    advance: 1,
    toolDiameter: 2,
    angularDirection: 1,
  })
  assert(invalid.error === 'invalid-guide', `expected invalid-guide, got ${invalid.error}`)

  const duplicateVertex = buildTrochoidalContour([...rectangle, rectangle[0]], {
    orbitRadius: 1,
    advance: 1,
    toolDiameter: 2,
    angularDirection: 1,
  })
  assert(duplicateVertex.error === undefined, 'repeated closing vertex must normalize')

  const budget = buildTrochoidalContour(rectangle, {
    orbitRadius: 2,
    advance: 0.0001,
    toolDiameter: 4,
    angularDirection: 1,
  })
  assert(budget.error === 'move-budget', `expected move-budget, got ${budget.error}`)
  assert(budget.points.length === 0, 'budget failure must not emit partial output')
}

function testOpenGuideCompletesExitOrbit(): void {
  const result = buildTrochoidalContour([{ x: 0, y: 0 }, { x: 20, y: 0 }], {
    orbitRadius: 1,
    advance: 2,
    toolDiameter: 4,
    angularDirection: 1,
    closed: false,
  })
  assert(result.error === undefined, `unexpected open-guide error ${result.error}`)
  assert(approx(result.entryCenter?.x ?? -1, 0), 'open guide entry must stay at its first endpoint')
  assert(approx(result.points[0].x, 1), 'open guide must start on the entry orbit')
  assert(approx(result.points.at(-1)!.x, 21), 'open guide must finish on the exit orbit')
  assert(!approx(result.points[0].x, result.points.at(-1)!.x), 'open guide must not close across its gap')
}

testClosedPeriodicPath()
testOrbitRadiusAndDirection()
testDeterminismAndSeam()
testInvalidInputsAndBudget()
testOpenGuideCompletesExitOrbit()

console.log('trochoidal edge tests passed.')
