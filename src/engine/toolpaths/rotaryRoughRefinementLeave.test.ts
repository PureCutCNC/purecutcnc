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
 * #1185 slice R2: an around **rough** refines to a quarter of its stock to
 * leave; a finish keeps the 0.005 mm surface bound (Frank's decision,
 * 2026-11-09).
 *
 * A rough's samples already stand the whole leave above the model, so holding
 * its chords to 0.005 mm between samples bought nothing a finish does not take
 * off again, and cost most of the rough's generation time: the rect-stock
 * bust's rough went from 10.8 s to 4.7 s through the pool, with half the moves.
 *
 * Block 1 is the rule itself (`rotaryRefinementToleranceFloor`). Block 2 sweeps
 * the **real** cutter along the refined chords of two sections and measures the
 * stock it leaves against the section itself, on grids from 4 to 24 degrees.
 * Block 3 shows a floor at or below the surface bound changes nothing. Block 4
 * is the helix, held to the same floor. Block 5 runs the generator and checks
 * that a rough's refinement samples exactly the angles the rule asks for.
 *
 * What block 2 can and cannot promise. The refinement tests a chord's
 * midpoint, so the floor bounds the midpoint. A corner that sits off the
 * middle of its segment can stand up to twice as far above the chord, so on a
 * coarse grid a rough may leave as little as **half** its stock at such a
 * corner (0.305 mm of 0.5 on the hexagon at 24 degrees). On a grid of 12
 * degrees or finer three quarters stays, and a real rough's grid is finer
 * than that: its base step is capped by the 0.005 mm sagitta rule.
 *
 * Mutations these blocks catch (each was applied and seen to fail):
 *  - the whole leave as the floor instead of a quarter: block 1, and block 2's
 *    stock, whose bounds are this file's own quarter;
 *  - a finish taking the rough's floor, or a rough's floor going below the
 *    surface bound: block 1;
 *  - the refinement ignoring the floor on exact rows, or on the conservative
 *    read's ball allowance: block 2 saves no angles;
 *  - the arc floor staying at the surface bound while the tolerance moves:
 *    `rotaryRefinementArcFloor.test.ts` block 3, which has the stepped walls
 *    that case needs;
 *  - the helix ignoring its floor: block 4's point count;
 *  - the generator not handing the rough its floor: block 5.
 */

import assert from 'node:assert/strict'
import { barCentre, barPivotZ } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import { buildContinuousHelix } from './rotaryContinuous'
import { ROUGH_REFINEMENT_LEAVE_SHARE, rotaryRefinementToleranceFloor } from './rotaryModel'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import type { Operation } from '../../types/project'
import { computeOperationToolpathAsync } from './generateOperation'
import {
  createRotarySamplingPrep,
  refineAroundSampling,
  refineAroundSamplingAsync,
  sampleAnglesWithPrep,
  serialRotaryBatches,
} from './rotarySampling'
import type { RotaryModelMesh, RotarySamplingPrep } from './rotarySampling'
import type { NormalizedTool } from './types'

const SURFACE = 0.005
const LEAVE = 0.5
/** The outline is sampled every 0.002 mm and swept at a finite angle step. */
const OUTLINE_SLACK = 0.004

function toolOf(type: 'ball_endmill' | 'flat_endmill', radius: number, units: 'mm' | 'inch' = 'mm'): NormalizedTool {
  return {
    id: 't1', name: 't1', sourceUnits: units, units, type,
    diameter: radius * 2, radius, vBitAngle: null, flutes: 2, material: 'carbide',
    defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0,
    defaultStepover: 0, maxCutDepth: 0,
  }
}

type Section = Array<[number, number]>

function prism(stock: BarStock, section: Section): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  const count = section.length
  for (const along of [8, 32]) {
    for (const [across, up] of section) positions.push(along, centre + across, pivot + up)
  }
  for (let j = 0; j < count; j++) {
    const next = (j + 1) % count
    index.push(j, next, count + next, j, count + next, count + j)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

function outlinePoints(section: Section, spacing: number): Section {
  const points: Section = []
  for (let j = 0; j < section.length; j++) {
    const [ax, ay] = section[j]
    const [bx, by] = section[(j + 1) % section.length]
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / spacing))
    for (let s = 0; s < steps; s++) points.push([ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps])
  }
  return points
}

/**
 * The least distance from the model's outline to the cutter's body with its tip
 * `tip` above the axis and the bar turned to `angleDeg`: the stock the cutter
 * leaves at that pose. Negative when the body is inside the model.
 */
function clearance(outline: Section, angleDeg: number, tip: number, tool: NormalizedTool): number {
  const turn = angleDeg * Math.PI / 180
  const cos = Math.cos(turn)
  const sin = Math.sin(turn)
  const r = tool.radius
  let least = Infinity
  for (const [a, u] of outline) {
    const across = Math.abs(a * cos - u * sin)
    const up = a * sin + u * cos
    let distance: number
    if (tool.type === 'ball_endmill') {
      const centre = tip + r
      distance = up >= centre ? across - r : Math.hypot(across, up - centre) - r
    } else if (up >= tip) {
      distance = across - r
    } else {
      distance = across <= r ? tip - up : Math.hypot(across - r, tip - up)
    }
    if (distance < least) least = distance
  }
  return least
}

const STOCK = roundStock(24, 40, 'x')

const hexagon: Section = Array.from({ length: 6 }, (_, k) => {
  const t = (15 + 60 * k) * Math.PI / 180
  return [7 * Math.cos(t), 7 * Math.sin(t)] as [number, number]
})
const lobes: Section = Array.from({ length: 360 }, (_, k) => {
  const t = k * Math.PI / 180
  const radius = 6 + 0.9 * Math.cos(5 * t)
  return [radius * Math.cos(t), radius * Math.sin(t)] as [number, number]
})

// ── block 1: who gets which floor ───────────────────────────────────────────
{
  const rough = (stockToLeave: number): { stockToLeave: number; stepdown: number } => ({ stockToLeave, stepdown: 1 })
  assert.equal(ROUGH_REFINEMENT_LEAVE_SHARE, 0.25, 'the decided share is a quarter')
  assert.equal(rotaryRefinementToleranceFloor(rough(0.5), 'mm'), 0.125, 'a rough leaving 0.5 mm refines to 0.125 mm')
  assert.equal(rotaryRefinementToleranceFloor(rough(0), 'mm'), SURFACE, 'a rough with no leave keeps the surface bound')
  assert.equal(rotaryRefinementToleranceFloor(rough(0.012), 'mm'), SURFACE, 'a quarter of the leave never goes below the surface bound')
  assert.equal(rotaryRefinementToleranceFloor(rough(Number.NaN), 'mm'), SURFACE, 'a leave that is not a number buys nothing')
  assert.equal(rotaryRefinementToleranceFloor(rough(-1), 'mm'), SURFACE, 'a negative leave buys nothing')
  assert.equal(rotaryRefinementToleranceFloor({ stockToLeave: 0.5 }, 'mm'), SURFACE, 'a finish keeps the surface bound whatever it leaves')
  assert.equal(rotaryRefinementToleranceFloor({ stockToLeave: 0 }, 'mm'), SURFACE, 'a finish with no leave keeps the surface bound')
  const inch = rotaryRefinementToleranceFloor(rough(0.02), 'inch')
  assert.equal(inch, 0.005, 'a rough leaving 0.020 in refines to 0.005 in')
  assert.ok(Math.abs(rotaryRefinementToleranceFloor(rough(0), 'inch') - SURFACE / 25.4) < 1e-12, 'the surface bound is converted to inches')
  console.log('  floor: rough = max(0.005 mm, leave / 4), finish = 0.005 mm, in mm and inch')
}

// ── block 2: the ring refinement leaves the stock it promises ───────────────
interface RingResult { angles: number[]; tips: Float32Array[]; least: number; strictAngles: number }

function ringCase(section: Section, tool: NormalizedTool, baseStep: number): RingResult {
  // The generators sample with the cutter enlarged by the leave and add the
  // leave back at the tip (`prepareRotaryTargets`); the same here, read exactly
  // so no margin of the sampler's stands in for stock.
  const samplingTool: NormalizedTool = { ...tool, radius: tool.radius + LEAVE, diameter: tool.diameter + 2 * LEAVE }
  const prep = createRotarySamplingPrep(prism(STOCK, section), STOCK, samplingTool, {
    along: [20], requestedCellSize: 0.1, conservativeCellBounds: true, exactTipRows: true,
  })
  const baseAngles = Array.from({ length: Math.round(360 / baseStep) + 1 }, (_, k) => baseStep * k)
  const base = sampleAnglesWithPrep(prep, baseAngles, [])
  assert.ok(base.valid, 'the base grid samples')
  const run = (toleranceFloor: number | undefined) => {
    const refined = refineAroundSampling({
      prep, stock: STOCK, tool, warnings: [], angles: base.anglesDeg, tips: base.tipRadius,
      ...(toleranceFloor !== undefined ? { toleranceFloor } : {}),
    })
    assert.ok(refined !== null && !refined.stopped, 'the refinement completes')
    return refined
  }
  const strict = run(undefined)
  const rough = run(rotaryRefinementToleranceFloor({ stockToLeave: LEAVE, stepdown: 1 }, 'mm'))
  const outline = outlinePoints(section, 0.002)
  let least = Infinity
  for (let k = 0; k + 1 < rough.angles.length; k++) {
    for (let step = 0; step <= 32; step++) {
      const f = step / 32
      const a = rough.tips[k][0]
      const b = rough.tips[k + 1][0]
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      const angle = rough.angles[k] + (rough.angles[k + 1] - rough.angles[k]) * f
      least = Math.min(least, clearance(outline, angle, a + (b - a) * f + LEAVE, tool))
    }
  }
  return { angles: rough.angles, tips: rough.tips, least, strictAngles: strict.angles.length }
}

/** The decided share, as a number of this file's own: the bounds below must not move with the rule they check. */
const FLOOR = LEAVE / 4
let usedSomewhere = 0
for (const [name, section] of [['hexagon', hexagon], ['five lobes', lobes]] as const) {
  for (const tool of [toolOf('ball_endmill', 1.5), toolOf('flat_endmill', 1.5)]) {
    for (const baseStep of [24, 12, 4]) {
      const label = `${name}, 1.5 mm ${tool.type === 'ball_endmill' ? 'ball' : 'flat'}, ${baseStep} degree grid`
      const result = ringCase(section, tool, baseStep)
      // The midpoint test holds a chord's **midpoint** to the floor. A corner
      // that sits off the middle of its segment can stand up to twice as far
      // above the chord as the midpoint does, so twice the floor -- half the
      // leave -- is what the test can promise at any grid.
      assert.ok(result.least >= LEAVE - 2 * FLOOR - OUTLINE_SLACK,
        `${label}: ${result.least.toFixed(4)} mm of the ${LEAVE} mm leave is left; never less than half of it`)
      // On a grid no coarser than 12 degrees the corners are close enough to a
      // sample that the floor itself holds: three quarters of the leave stays.
      // (A real rough's grid is finer still: its base step is capped by the
      // 0.005 mm sagitta rule, about 2 degrees on a 25 mm bar.)
      if (baseStep <= 12) {
        assert.ok(result.least >= LEAVE - FLOOR - OUTLINE_SLACK,
          `${label}: ${result.least.toFixed(4)} mm of the ${LEAVE} mm leave is left; three quarters of it on a grid this fine`)
      }
      assert.ok(result.angles.length <= result.strictAngles,
        `${label}: the rough's floor never asks for more angles than the surface bound (${result.angles.length} against ${result.strictAngles})`)
      if (result.angles.length < result.strictAngles && result.least < LEAVE - 4 * SURFACE) usedSomewhere++
      console.log(`  ${label}: ${result.angles.length} angles (${result.strictAngles} at the surface bound), least stock ${result.least.toFixed(4)} mm`)
    }
  }
}
// The floor has to have decided something, or the bounds above test nothing.
assert.ok(usedSomewhere >= 6, `the rough's floor saved angles and spent leave on ${usedSomewhere} of 12 cases`)

// ── block 3: a floor at or below the surface bound changes nothing ──────────
{
  const tool = toolOf('ball_endmill', 1.5)
  const prep = createRotarySamplingPrep(prism(STOCK, hexagon), STOCK, tool, {
    along: [20], requestedCellSize: 0.1, conservativeCellBounds: true,
  })
  const baseAngles = Array.from({ length: 91 }, (_, k) => 4 * k)
  const base = sampleAnglesWithPrep(prep, baseAngles, [])
  const run = (toleranceFloor: number | undefined) => refineAroundSampling({
    prep, stock: STOCK, tool, warnings: [], angles: base.anglesDeg, tips: base.tipRadius,
    ...(toleranceFloor !== undefined ? { toleranceFloor } : {}),
  })
  const plain = run(undefined)
  assert.ok(plain !== null && plain.angles.length > baseAngles.length, 'the hexagon needs refining at the surface bound')
  for (const floor of [
    rotaryRefinementToleranceFloor({ stockToLeave: 0, stepdown: 1 }, 'mm'),
    rotaryRefinementToleranceFloor({ stockToLeave: LEAVE }, 'mm'),
    0.001, 0, Number.NaN,
  ]) {
    const again = run(floor)
    assert.ok(again !== null)
    assert.deepEqual(again.angles, plain.angles, `a floor of ${floor} refines to the same angles as no floor`)
    assert.deepEqual(again.tips, plain.tips, `a floor of ${floor} refines to the same rows as no floor`)
  }
  console.log(`  a rough with no leave, a finish with one, and a floor below the bound: ${plain.angles.length} angles, identical`)
}

// ── block 4: the helix is held to the same floor ────────────────────────────
{
  const tool = toolOf('ball_endmill', 1.5)
  const samplingTool: NormalizedTool = { ...tool, radius: tool.radius + LEAVE, diameter: tool.diameter + 2 * LEAVE }
  const outline = outlinePoints(hexagon, 0.002)
  const pivot = barPivotZ(STOCK)
  const helixWith = (toleranceFloor: number | undefined) => {
    const prep = createRotarySamplingPrep(prism(STOCK, hexagon), STOCK, samplingTool, {
      along: [12], requestedCellSize: 0.1, conservativeCellBounds: true,
    })
    const helix = buildContinuousHelix({
      prep, tool, band: { start: 12, end: 28 }, stepover: 2, sampleSpacing: 3, stockToLeave: LEAVE,
      readExactRows: true, warnings: [],
      ...(toleranceFloor !== undefined ? { toleranceFloor } : {}),
    })
    assert.ok(helix !== null && helix.points.length > 1, 'the band is cut as a helix')
    return helix
  }
  const plain = helixWith(undefined)
  const surface = helixWith(SURFACE)
  const rough = helixWith(rotaryRefinementToleranceFloor({ stockToLeave: LEAVE, stepdown: 1 }, 'mm'))
  assert.deepEqual(surface.points, plain.points, 'a helix given the surface bound is the helix given none')
  assert.ok(rough.points.length < plain.points.length,
    `the rough's helix needs fewer points (${rough.points.length} against ${plain.points.length})`)
  let least = Infinity
  for (let k = 0; k + 1 < rough.points.length; k++) {
    const from = rough.points[k]
    const to = rough.points[k + 1]
    for (let step = 0; step <= 16; step++) {
      const f = step / 16
      const angle = (from.a ?? 0) + ((to.a ?? 0) - (from.a ?? 0)) * f
      least = Math.min(least, clearance(outline, angle, from.z + (to.z - from.z) * f - pivot, tool))
    }
  }
  assert.ok(least >= LEAVE - 2 * FLOOR - OUTLINE_SLACK,
    `the rough's helix leaves ${least.toFixed(4)} mm of the ${LEAVE} mm leave; never less than half of it`)
  assert.ok(least < LEAVE - 2 * SURFACE,
    `the rough's helix spends some of its leave between samples (${least.toFixed(4)} mm left)`)
  console.log(`  helix: ${rough.points.length} points against ${plain.points.length} at the surface bound, least stock ${least.toFixed(4)} mm`)
}

// ── block 5: the generator hands its rough that floor, and its finish none ──
{
  /** Every angle the operation's ring grid asked a batch for, and the prep it asked with. */
  const generate = async (kind: 'rotary_rough' | 'rotary_finish'): Promise<{ prep: RotarySamplingPrep; batches: number[][] }> => {
    const fixture = rotaryOperationFixture('x', kind)
    const operation: Operation = { ...fixture.operations[0], rotaryPassDirection: 'around' }
    let captured: RotarySamplingPrep | null = null
    const batches: number[][] = []
    const result = await computeOperationToolpathAsync(fixture, operation, {
      rotaryRunBatch: (prep) => {
        captured ??= prep
        const run = serialRotaryBatches(prep)
        const first = captured === prep
        return async (jobs) => {
          if (first) batches.push(jobs.map((job) => job.angle))
          return run(jobs)
        }
      },
    })
    assert.ok(result && result.result.moves.length > 0, `the ${kind} fixture generates`)
    assert.ok(captured !== null && batches.length > 1, `the ${kind} fixture's ring grid was sampled and refined`)
    return { prep: captured as RotarySamplingPrep, batches }
  }
  /** The same grid refined here, with a floor of this test's choosing. */
  const refineHere = async (prep: RotarySamplingPrep, base: number[], leave: number, toleranceFloor: number | undefined): Promise<number[][]> => {
    // The generator's cutter is the sampling cutter less the leave it carries.
    const tool: NormalizedTool = { ...prep.tool, radius: prep.tool.radius - leave, diameter: prep.tool.diameter - 2 * leave }
    const batches: number[][] = []
    const run = serialRotaryBatches(prep)
    const sampled = sampleAnglesWithPrep(prep, base, [])
    const refined = await refineAroundSamplingAsync({
      prep, stock: prep.stock, tool, warnings: [], angles: sampled.anglesDeg, tips: sampled.tipRadius,
      ...(toleranceFloor !== undefined ? { toleranceFloor } : {}),
    }, async (jobs) => {
      batches.push(jobs.map((job) => job.angle))
      return run(jobs)
    })
    assert.ok(refined !== null, 'the reference refinement completes')
    return batches
  }
  // The fixture leaves 0.4 mm: a rough's floor is 0.1 mm, a finish's 0.005 mm.
  const leave = 0.4
  const rough = await generate('rotary_rough')
  const roughWithFloor = await refineHere(rough.prep, rough.batches[0], leave, leave * ROUGH_REFINEMENT_LEAVE_SHARE)
  const roughWithout = await refineHere(rough.prep, rough.batches[0], leave, undefined)
  assert.notDeepEqual(roughWithFloor, roughWithout, 'the floor changes what this fixture samples, so the comparison means something')
  assert.deepEqual(rough.batches.slice(1), roughWithFloor,
    "the rough's refinement sampled exactly the angles a quarter of its leave asks for")
  const finish = await generate('rotary_finish')
  const finishWithout = await refineHere(finish.prep, finish.batches[0], leave, undefined)
  assert.deepEqual(finish.batches.slice(1), finishWithout,
    "the finish's refinement sampled exactly the angles the surface bound asks for, whatever it leaves")
  const count = (batches: number[][]): number => batches.reduce((n, batch) => n + batch.length, 0)
  console.log(`  generator: the rough refined with ${count(rough.batches.slice(1))} rows (${count(roughWithout)} at the surface bound),`
    + ` the finish with ${count(finish.batches.slice(1))}, as the surface bound asks`)
}

console.log('engine/toolpaths/rotaryRoughRefinementLeave.test.ts: all assertions passed')
