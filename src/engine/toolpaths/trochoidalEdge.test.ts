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
import type { TrochoidalContourResult } from './trochoidalEdge'

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

/**
 * The orbit accuracy contract (issue #660, `planning/TROCHOIDAL_EDGE_DESIGN.md`)
 * is a sagitta: an emitted chord may sit at most this fraction of the cutter
 * diameter inside the true orbit.
 */
const SAGITTA_FRACTION = 0.0022

/**
 * Steps per orbit, recovered from the emitted array purely so the tests below
 * can *locate* chords. Nothing asserts on it, and nothing should: the step
 * count is a derived quantity now, and pinning it would re-freeze the 36-step
 * proxy #660 removed.
 */
function stepsPerLoopOf(result: TrochoidalContourResult, closed: boolean): number {
  const orbits = result.loopCount + (closed ? 1 : 2)
  const steps = (result.points.length - 1) / orbits
  assert(
    Number.isInteger(steps) && steps >= 3,
    `unexpected point layout: ${result.points.length} points over ${orbits} orbits`,
  )
  return steps
}

/**
 * Sagitta of a stationary orbit: its chords are inscribed in a circle whose
 * centre and radius the caller already knows, so the deviation is measured
 * directly off emitted geometry.
 */
function stationaryOrbitSagitta(points: Point[], center: Point, radius: number, steps: number): number {
  let worst = 0
  for (let index = 0; index < steps; index += 1) {
    const from = points[index]
    const to = points[index + 1]
    const midX = (from.x + to.x) / 2
    const midY = (from.y + to.y) / 2
    worst = Math.max(worst, radius - Math.hypot(midX - center.x, midY - center.y))
  }
  return worst
}

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
  // Structural, not numeric: one entry orbit plus one orbit per advancing loop.
  // The old form asserted `points.length > loopCount * 36`, and so quietly
  // depended on the step-count floor #660 replaced.
  assert(
    result.points.length === 1 + stepsPerLoopOf(result, true) * (result.loopCount + 1),
    `expected entry orbit plus moving loops, got ${result.points.length} points`,
  )

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

  // Degeneracy and the ceiling are different failures (issue #662). This advance
  // is 0.000025 x D: the orbit re-cuts the same arc rather than progressing, and
  // the parameter is what is wrong, not the size of the job.
  const degenerate = buildTrochoidalContour(rectangle, {
    orbitRadius: 2,
    advance: 0.0001,
    toolDiameter: 4,
    angularDirection: 1,
  })
  assert(degenerate.error === 'degenerate-advance', `expected degenerate-advance, got ${degenerate.error}`)
  assert(degenerate.points.length === 0, 'a degenerate advance must not emit partial output')

  // Exactly `0.01 x D` is the smallest advance the CAM panel offers, so it is an
  // ordinary setting and must generate. The guide length is deliberately not a
  // whole number of advances (40 mm / 0.03 mm = 1333.33): the first form of this
  // cap compared the ceil'd loop count with that real quotient, so `ceil(m) > m`
  // refused every such guide at the bound — the panel's minimum, refusing
  // ordinary parts.
  const atTheBound = buildTrochoidalContour(rectangle, {
    orbitRadius: 1,
    advance: 0.03,
    toolDiameter: 3,
    angularDirection: 1,
  })
  assert(atTheBound.error === undefined, `an advance of exactly 0.01 x D must generate, got ${atTheBound.error}`)
  assert(atTheBound.points.length > 0, 'the boundary advance must emit a path')
  assert(atTheBound.loopCount === 1334, `the fixture must not divide evenly, got ${atTheBound.loopCount} loops`)

  // A hair below it is degenerate, so the bound discriminates rather than
  // passing everything.
  const belowTheBound = buildTrochoidalContour(rectangle, {
    orbitRadius: 1,
    advance: 0.0299,
    toolDiameter: 3,
    angularDirection: 1,
  })
  assert(belowTheBound.error === 'degenerate-advance', `just under the bound must refuse, got ${belowTheBound.error}`)

  // A guide too short to hold more than one orbit cannot be degenerate however
  // fine the advance is. Without that exemption every sub-millimetre tab
  // fragment would refuse on an otherwise ordinary operation.
  const singleLoop = buildTrochoidalContour([
    { x: 0, y: 0 },
    { x: 0.01, y: 0 },
    { x: 0.01, y: 0.01 },
  ], {
    orbitRadius: 2,
    advance: 0.4,
    toolDiameter: 4,
    angularDirection: 1,
  })
  assert(singleLoop.loopCount === 1, `single-orbit fixture must hold one loop, got ${singleLoop.loopCount}`)
  assert(singleLoop.error === undefined, `a single-orbit guide must generate, got ${singleLoop.error}`)

  // The ceiling still refuses on its own terms: a legal 0.02 x D advance on a
  // 12 m guide is a job too big to hold, not a defective parameter.
  const oversize: Point[] = [
    { x: 0, y: 0 },
    { x: 3000, y: 0 },
    { x: 3000, y: 3000 },
    { x: 0, y: 3000 },
  ]
  const budget = buildTrochoidalContour(oversize, {
    orbitRadius: 2,
    advance: 0.08,
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

/**
 * The sagitta bound, asserted on emitted chords (issue #660).
 *
 * This deliberately does not look at `stepsPerLoop`. The step count is how the
 * bound happens to be reached; the bound is what the `0.01 x D` guide allowance
 * is sized against, and it is the only thing safety depends on. A test that
 * froze the count would pass while defeating its own purpose.
 */
function testStationaryOrbitSagittaBound(): void {
  const guide: Point[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }]
  for (const diameter of [3.175, 6, 12]) {
    for (const widthRatio of [1.15, 1.2, 1.25, 1.5, 1.8, 2, 2.25, 2.5]) {
      const label = `D=${diameter} W/D=${widthRatio}`
      const orbitRadius = (widthRatio * diameter - diameter) / 2
      const result = buildTrochoidalContour(guide, {
        orbitRadius,
        advance: 0.1 * diameter,
        toolDiameter: diameter,
        angularDirection: 1,
      })
      assert(result.error === undefined, `${label}: ${result.error}`)
      assert(result.entryCenter !== null, `${label}: expected entry center`)
      const steps = stepsPerLoopOf(result, true)
      const sagitta = stationaryOrbitSagitta(result.points, result.entryCenter, orbitRadius, steps)
      const bound = SAGITTA_FRACTION * diameter
      assert(sagitta <= bound + 1e-12, `${label}: orbit sagitta ${sagitta} exceeds ${bound}`)
    }
  }
}

/**
 * The same bound on the chords that actually do the cutting.
 *
 * On a straight open guide the centre track is linear and the frame constant,
 * so the intended path is a closed-form trochoid — centre at `L * s /
 * movingSteps` along +X, phase `2 * pi * s / stepsPerLoop` — which this test
 * evaluates *between* emitted points. The deviation measured is therefore the
 * real chord-to-curve error, not a restatement of the circle formula.
 *
 * Analytically the advancing case cannot be the worse one: for a trochoid,
 * `speed^2 * curvature = R(R - c sin t) / sqrt(R^2 - 2cR sin t + c^2) <= R`, so
 * its chord sagitta is bounded by the stationary orbit's. It is measured rather
 * than trusted.
 */
function testAdvancingOrbitSagittaBound(): void {
  const length = 60
  for (const diameter of [3.175, 6, 12]) {
    for (const widthRatio of [1.15, 1.2, 1.25, 1.5, 1.8, 2, 2.25, 2.5]) {
      const label = `D=${diameter} W/D=${widthRatio}`
      const orbitRadius = (widthRatio * diameter - diameter) / 2
      const result = buildTrochoidalContour([{ x: 0, y: 0 }, { x: length, y: 0 }], {
        orbitRadius,
        advance: 0.1 * diameter,
        toolDiameter: diameter,
        angularDirection: 1,
        closed: false,
      })
      assert(result.error === undefined, `${label}: ${result.error}`)
      const steps = stepsPerLoopOf(result, false)
      const movingSteps = result.loopCount * steps
      const curve = (step: number): Point => {
        const phase = 2 * Math.PI * step / steps
        return {
          x: length * step / movingSteps + orbitRadius * Math.cos(phase),
          y: orbitRadius * Math.sin(phase),
        }
      }

      // Self-check: the closed form must reproduce the emitted advancing points
      // exactly, or the sagitta measured between them means nothing.
      let modelError = 0
      for (let step = 0; step <= movingSteps; step += 1) {
        const emitted = result.points[steps + step]
        const expected = curve(step)
        modelError = Math.max(modelError, Math.hypot(emitted.x - expected.x, emitted.y - expected.y))
      }
      assert(modelError < 1e-9, `${label}: advancing points diverge from the trochoid by ${modelError}`)

      let worst = 0
      for (let step = 0; step < movingSteps; step += 1) {
        const from = result.points[steps + step]
        const to = result.points[steps + step + 1]
        const middle = curve(step + 0.5)
        worst = Math.max(worst, Math.hypot((from.x + to.x) / 2 - middle.x, (from.y + to.y) / 2 - middle.y))
      }
      const bound = SAGITTA_FRACTION * diameter
      assert(worst <= bound + 1e-12, `${label}: advancing sagitta ${worst} exceeds ${bound}`)
    }
  }
}

testClosedPeriodicPath()
testOrbitRadiusAndDirection()
testDeterminismAndSeam()
testInvalidInputsAndBudget()
testOpenGuideCompletesExitOrbit()
testStationaryOrbitSagittaBound()
testAdvancingOrbitSagittaBound()

console.log('trochoidal edge tests passed.')
