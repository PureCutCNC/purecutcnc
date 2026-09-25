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
 * Keep-improving search (issue #862). The first step is the one-shot answer,
 * the best never gets worse, a seed always gives the same run, every improved
 * layout is valid, and order alone can fit a part the one-shot order leaves out.
 *
 * Run with: npx tsx src/engine/nesting/improve.test.ts
 */

import { expandByHalfGap, largestFirst, shrinkByHalfGap } from './defaults'
import { improveNest, isBetterNest, MAX_GENE_ANGLES, type ImproveOptions, type ImproveStep } from './improve'
import { createNester, nest } from './packer'
import { assert, assertValidLayout, rect } from './testLayout'
import type { NestRequest } from './types'

/**
 * Largest-first places the two 30×25 plates before the 10×35 strip, and then
 * no gap left is 35 tall; placed earlier, the strip fits.
 */
function orderMatters(): NestRequest {
  const part = (id: string, w: number, h: number, quantity: number) => ({ id, footprint: [rect(0, 0, w, h)], quantity, rotations: [0] })
  return {
    sheet: rect(0, 0, 100, 60),
    obstacles: [],
    minimumGap: 2,
    expandFootprint: expandByHalfGap,
    shrinkHoles: shrinkByHalfGap,
    orderParts: largestFirst,
    parts: [part('p0', 25, 30, 1), part('p1', 10, 35, 1), part('p2', 10, 30, 1), part('p3', 30, 25, 2)],
  }
}

/** A frame with a hole plus loose squares, so improved layouts cover holes too. */
function mixed(): NestRequest {
  return {
    sheet: rect(0, 0, 120, 80),
    obstacles: [rect(100, 0, 20, 20)],
    minimumGap: 3,
    expandFootprint: expandByHalfGap,
    shrinkHoles: shrinkByHalfGap,
    orderParts: largestFirst,
    parts: [
      { id: 'frame', footprint: [rect(0, 0, 50, 40)], holes: [rect(8, 8, 34, 24)], quantity: 2, rotations: [0, 90] },
      { id: 'bar', footprint: [rect(0, 0, 30, 8)], quantity: 4, rotations: [0, 90] },
      { id: 'sq', footprint: [rect(0, 0, 9, 9)], quantity: 6, rotations: [0] },
    ],
  }
}

function testRanking(): void {
  const result = (unplacedArea: number, usedArea: number) => ({ placements: [], unplaced: [], unplacedArea, usedArea })
  assert(isBetterNest(result(0, 5000), result(350, 3000)), 'fitting more parts beats a smaller layout')
  assert(!isBetterNest(result(350, 3000), result(0, 5000)), 'and not the other way round')
  assert(isBetterNest(result(0, 2999), result(0, 3000)), 'with the same parts fitted, the smaller layout wins')
  assert(!isBetterNest(result(0, 3000 * (1 - 1e-12)), result(0, 3000)), 'float noise is not an improvement')
  console.log('ranking: PASSED')
}

/**
 * Six copies on a 65×52 sheet. Whatever the order, the placer's greedy angle
 * per copy leaves two out; pinning some copies to the other angle leaves one
 * (#875). Found by a random search over small rectangle sets.
 */
function rotationMatters(): NestRequest {
  const part = (id: string, w: number, h: number, quantity: number) => ({ id, footprint: [rect(0, 0, w, h)], quantity, rotations: [0, 90] })
  return {
    sheet: rect(0, 0, 65, 52),
    obstacles: [],
    minimumGap: 2,
    expandFootprint: expandByHalfGap,
    shrinkHoles: shrinkByHalfGap,
    orderParts: largestFirst,
    parts: [part('p0', 37, 30, 2), part('p1', 25, 27, 1), part('p2', 17, 22, 2), part('p3', 12, 22, 1)],
  }
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))
}

function run(request: NestRequest, steps: number, seed = 1, options: ImproveOptions = {}): ImproveStep[] {
  const out: ImproveStep[] = []
  for (const step of improveNest(request, { seed, ...options })) {
    out.push(step)
    if (out.length >= steps) break
  }
  return out
}

function testFirstStepIsTheOneShotAnswer(): void {
  for (const request of [orderMatters(), mixed()]) {
    const [first] = run(request, 1)
    assert(first.evaluated === 1 && !first.improved, 'the first step is one layout, not an improvement')
    assert(JSON.stringify(first.best) === JSON.stringify(nest(request)), 'the first step is the one-shot answer')
  }
  const nester = createNester(mixed())
  assert(nester.initialSequence.join() === 'frame,frame,bar,bar,bar,bar,sq,sq,sq,sq,sq,sq', 'initial sequence is largest-first, copy by copy')
  console.log('the first step is the one-shot answer: PASSED')
}

function testOrderCanFitAPartTheOneShotLeftOut(): void {
  const steps = run(orderMatters(), 60)
  assert(steps[0].best.unplaced.length === 1 && steps[0].best.unplacedArea === 350, 'one-shot leaves the strip out')
  const best = steps.at(-1)!.best
  assert(best.unplacedArea === 0, `the search fits every part, left out ${best.unplacedArea}`)
  assertValidLayout(orderMatters(), best, 'order matters')
  console.log('order can fit a part the one-shot order left out: PASSED')
}

function testBestNeverGetsWorseAndEveryImprovementIsValid(): void {
  const request = mixed()
  const steps = run(request, 80)
  let improvements = 0
  for (let index = 1; index < steps.length; index += 1) {
    const [previous, current] = [steps[index - 1].best, steps[index].best]
    assert(!isBetterNest(previous, current), `step ${index + 1} is worse than step ${index}`)
    assert(current.placements.length > 0, 'layouts place parts')
    if (steps[index].improved) {
      improvements += 1
      assert(isBetterNest(current, previous), `step ${index + 1} is flagged improved but is not better`)
      assertValidLayout(request, current, `improvement at step ${index + 1}`)
    } else {
      assert(current === previous, `step ${index + 1} changed the best without improving`)
    }
  }
  assert(improvements > 0, 'the search improves the mixed layout at least once')
  console.log(`the best never gets worse and every improvement is valid (${improvements} improvements): PASSED`)
}

function testRotationCanFitWhatNoOrderDoes(): void {
  const request = rotationMatters()
  const nester = createNester(request)
  const missing = (result: { unplaced: { count: number }[] }) => result.unplaced.reduce((sum, entry) => sum + entry.count, 0)
  const orders = permutations(nester.initialSequence)
  const fewest = Math.min(...orders.map((order) => missing(nester.place(order))))
  assert(orders.length === 720 && fewest === 2, `every order with greedy angles leaves two out, got ${fewest}`)
  const best = run(request, 300).at(-1)!.best
  assert(missing(best) === 1, `pinned angles leave one out, got ${missing(best)}`)
  assertValidLayout(request, best, 'rotation matters')
  console.log('rotation can fit what no order does: PASSED')
}

function testSingleAngleSearchesAsBefore(): void {
  // Parts with one angle draw nothing from the RNG for rotation, so the
  // "No rotation" preset searches exactly as it did before #875: this trace
  // was recorded from that search (seed 3, 120 layouts).
  const steps = run(orderMatters(), 120, 3)
  const improvedAt = steps.filter((step) => step.improved).map((step) => step.evaluated)
  const usedArea = steps.at(-1)!.best.usedArea
  assert(improvedAt.join() === '4,17', `improvements at the recorded layouts, got ${improvedAt.join()}`)
  assert(Math.abs(usedArea - 3933.10980072) < 1e-6, `the recorded best area, got ${usedArea}`)
  console.log('a single-angle search runs as before: PASSED')
}

function testFineStepsKeepTheGreedyAngle(): void {
  // A 15° step allows 24 angles, past MAX_GENE_ANGLES: no copy gets a gene,
  // so the rotation rate changes nothing. This search improves twice in 40
  // layouts, so a gene drawn from the RNG would shift when it does.
  const fine = Array.from({ length: 24 }, (_, index) => index * 15)
  const request = { ...orderMatters(), parts: orderMatters().parts.map((part) => ({ ...part, rotations: fine })) }
  assert(fine.length > MAX_GENE_ANGLES, 'the step allows more angles than genes take')
  const trace = (rotationRate: number) => run(request, 40, 1, { rotationRate })
    .map((step) => `${step.evaluated}:${step.improved}:${step.best.usedArea}`).join()
  const order = trace(0)
  assert(order.includes('true'), 'the search improves the layout')
  assert(order === trace(0.5), 'a fine step searches order only')
  console.log('fine steps keep the greedy angle: PASSED')
}

function testSeedReproducesTheRun(): void {
  const trace = (seed: number) => run(mixed(), 40, seed).map((step) => `${step.evaluated}:${step.improved}:${step.best.usedArea}`).join()
  assert(trace(7) === trace(7), 'the same seed gives the same run')
  console.log('a seed reproduces the run: PASSED')
}

function testStopsOnItsOwnWhenStalled(): void {
  let count = 0
  // Longer than the first population of 10, so the stall ends a later generation.
  for (const step of improveNest(orderMatters(), { stallLimit: 15 })) {
    count = step.evaluated
    assert(count < 500, 'the search stops without being asked')
  }
  assert(count > 15, `it ran past the first stall window, got ${count}`)
  const single = [...improveNest({ ...orderMatters(), parts: [orderMatters().parts[0]] })]
  assert(single.length === 1, 'one copy has nothing to reorder')
  console.log('stops on its own when stalled: PASSED')
}

testRanking()
testFirstStepIsTheOneShotAnswer()
testOrderCanFitAPartTheOneShotLeftOut()
testBestNeverGetsWorseAndEveryImprovementIsValid()
testRotationCanFitWhatNoOrderDoes()
testSingleAngleSearchesAsBefore()
testFineStepsKeepTheGreedyAngle()
testSeedReproducesTheRun()
testStopsOnItsOwnWhenStalled()
console.log('All nesting improve tests passed')
