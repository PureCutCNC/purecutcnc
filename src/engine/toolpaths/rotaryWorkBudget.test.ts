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
 * #1045 slice N: bound layer emission before any moves are built. The child
 * timeout is a hang guard, not a performance assertion: removing the budget
 * must fail even when generation cannot return to an in-process assertion.
 *
 * These are **rough** bounds. A finish emits only its model-following passes
 * (2026-10-22 decision), so it has no layer count, no emission budget and no
 * stepdown to validate; the finish side of this file is gone with the clearing
 * it used to bound.
 *
 * #1045 slice O adds three things this file now covers for the rough:
 *  - the emission budget refuses with its own `rotaryWorkBudgetExceeded` text,
 *    and a sub-minimum but finite stepdown with `rotaryStepdownBelowMinimum`,
 *    instead of both borrowing the stepover message;
 *  - (#1045 slice P) both bounds are **around-mode** bounds: along mode keeps
 *    the emission it always had. A saved 0.009 mm along rough that generated
 *    27,804 moves at 9345c132 is accepted again, and the 16M emission cap --
 *    which can refuse an along job that used to run, however slowly -- is not
 *    applied to along mode. A non-finite layer count still refuses, because no
 *    version of this generator ever finished that job;
 *  - cancellation is polled at least once per ring/pass *inside* each layer,
 *    in both `around` and `along` modes (slice N only polled per layer, and this
 *    test only generated around programs, so removing the along-branch poll
 *    survived).
 *
 * Mutations: remove the work-budget check -> the bounded child hangs/fails;
 * remove the per-layer poll -> the layer-difference assertion fails; remove the
 * along-branch or per-ring poll -> the emission-count assertion fails.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { barMaxRadius, barPivotZ, barCentre, squareStock } from '../../types/barStock'
import { generateRotaryRough } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool } from './types'

const stock = squareStock(20, 20, 'x', { x: 0, y: 0 })
const positions: number[] = []
const index: number[] = []
for (const along of [0, 20]) {
  for (let j = 0; j < 32; j++) {
    const angle = j * Math.PI / 16
    positions.push(along, barCentre(stock) + 5 * Math.cos(angle), barPivotZ(stock) + 5 * Math.sin(angle))
  }
}
for (let j = 0; j < 32; j++) {
  const next = (j + 1) % 32
  index.push(j, next, 32 + next, j, 32 + next, 32 + j)
}
const mesh: RotaryModelMesh = { positions: new Float32Array(positions), index: new Uint32Array(index) }
const tool: NormalizedTool = {
  id: 'flat', name: 'flat', type: 'flat_endmill', units: 'mm', sourceUnits: 'mm',
  diameter: 4, radius: 2, vBitAngle: null, flutes: 2, material: 'carbide',
  defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 1,
  defaultStepover: 0, maxCutDepth: 0,
}
const base = {
  alongStart: 0, alongEnd: 20, safeRadius: 30, stockToLeave: 0,
  stepover: 0.25, sampleSpacing: 0.25, requestedCellSize: 0.5,
  stepdown: 0.01, passDirection: 'around' as const,
}

if (process.env.ROTARY_WORK_BUDGET_CHILD) {
  const result = generateRotaryRough('budget', mesh, stock, tool, base, {})
  assert.deepEqual(result.moves, [], 'a valid minimum stepdown whose layers exceed the work budget refuses before emission')
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['rotaryWorkBudgetExceeded'])
} else {
  {
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      env: { ...process.env, ROTARY_WORK_BUDGET_CHILD: 'rough' }, encoding: 'utf8', timeout: 10_000,
      maxBuffer: 100_000,
    })
    assert.equal(child.error, undefined, `rough: generation must refuse excessive work, never hang (${child.error?.message})`)
    assert.equal(child.status, 0, `rough: ${child.stdout} ${child.stderr}`)
  }
  // A finite, positive stepdown below the physical minimum is its own refusal
  // in **around** mode: the value is not missing, it is a request for an
  // unbounded layer count.
  for (const stepdown of [Number.MIN_VALUE, 0.009]) {
    let sampled = 0
    const result = generateRotaryRough('minimum', mesh, stock, tool, { ...base, stepdown }, { onAngle: () => { sampled++ } })
    assert.deepEqual(result.moves, [])
    assert.deepEqual(result.warnings.map((warning) => warning.code), ['rotaryStepdownBelowMinimum'],
      `stepdown ${stepdown} is below the minimum and says so`)
    assert.equal(sampled, 0, `invalid stepdown ${stepdown} is rejected before sampling`)
  }
  // The minimum is physical: 0.009 mm expressed in inches also refuses.
  {
    const result = generateRotaryRough('inch-minimum', mesh, stock, { ...tool, units: 'inch' },
      { ...base, stepdown: 0.009 / 25.4 }, {})
    assert.deepEqual(result.moves, [])
    assert.deepEqual(result.warnings.map((warning) => warning.code), ['rotaryStepdownBelowMinimum'])
  }

  // #1045 slice P: along mode is exempt from both around-mode bounds. The
  // review's fixture -- a finite 0.009 mm stepdown that generated 27,804 moves
  // at 9345c132 -- must generate again, not refuse.
  const coarseAlong = { ...base, passDirection: 'along' as const, stepover: 10, sampleSpacing: 5 }
  const alongMinimum = generateRotaryRough('along-minimum', mesh, stock, tool, { ...coarseAlong, stepdown: 0.009 }, {})
  assert.deepEqual(alongMinimum.warnings, [], 'along mode accepts a 0.009 mm stepdown')
  assert.ok(alongMinimum.moves.length > 0, 'and generates motion for it')
  const inchAlong = generateRotaryRough('along-inch-minimum', mesh, stock, { ...tool, units: 'inch' },
    { ...coarseAlong, stepdown: 0.009 / 25.4 }, {})
  assert.deepEqual(inchAlong.warnings, [], 'along mode accepts the same depth in inch units')
  assert.ok(inchAlong.moves.length > 0)
  // The 16M emission cap would otherwise refuse an along job that used to run.
  // This one asks for ~40M layer visits; around refuses before emission, along
  // is allowed to start and is stopped by cancellation instead.
  // A valid (at the floor) stepdown with a fine grid: ~500 layers x ~629 angles
  // x ~201 along positions is about 63M layer visits.
  const huge = { ...base, stepdown: 0.01, stepover: 0.1, sampleSpacing: 0.1 }
  const aroundCap = generateRotaryRough('around-cap', mesh, stock, tool, huge, {})
  assert.deepEqual(aroundCap.moves, [])
  assert.deepEqual(aroundCap.warnings.map((warning) => warning.code), ['rotaryWorkBudgetExceeded'],
    'around mode still refuses a job over the emission cap')
  const alongNoCap = generateRotaryRough('along-cap', mesh, stock, tool,
    { ...coarseAlong, stepdown: 4e-6 }, { shouldStop: () => true })
  assert.deepEqual(alongNoCap, { operationId: 'along-cap', moves: [], warnings: [], bounds: null },
    'along mode is not refused by the emission cap; it starts and honours cancellation')
  // A non-finite layer count is still refused: that job never finished on any
  // version, and the layer loop would never terminate.
  const alongInfinite = generateRotaryRough('along-infinite', mesh, stock, tool,
    { ...coarseAlong, stepdown: Number.MIN_VALUE }, {})
  assert.deepEqual(alongInfinite.moves, [])
  assert.deepEqual(alongInfinite.warnings.map((warning) => warning.code), ['rotaryWorkBudgetExceeded'])

  // The rough's saved depth is a required field, so a value that is not a depth
  // still refuses rather than silently inventing one.
  for (const stepdown of [0, -1, NaN, Number.POSITIVE_INFINITY]) {
    const refused = generateRotaryRough('rough-invalid', mesh, stock, tool, { ...base, stepdown }, {})
    assert.deepEqual(refused.moves, [])
    assert.deepEqual(refused.warnings.map((warning) => warning.code), ['stepdownPositive'])
  }

  // Cancellation is polled once per layer (#1045 slice N) *and* at least once
  // per ring/pass inside each layer (#1045 slice O), in both directions. The
  // count of polls after the last sample is therefore at least the number of
  // rings (around) or passes (along) even for a one-layer job.
  //
  // `onAngle` fires for every initial sample and before any move is emitted, so
  // the poll count at the last sample is the sampling cost. Around mode then
  // bisects the grid once (`refineAroundSampling`, one sample pass over
  // `angles.length - 1` midpoints for this smooth cylinder), which also polls;
  // subtract it so the remaining count is emission only.
  const ringCount = Math.ceil((base.alongEnd - base.alongStart) / base.stepover) + 1
  const passCount = Math.ceil(2 * Math.PI * barMaxRadius(stock) / base.stepover)
  const perLayerPositions = { around: ringCount, along: passCount } as const
  for (const [name, generate] of [['rough', generateRotaryRough]] as const) {
    for (const passDirection of ['around', 'along'] as const) {
      const direction = { ...base, passDirection }
      let sampleTotal = 0
      let sampledChecks = 0
      const oneLayer = (() => {
        let checks = 0
        generate('one-layer', mesh, stock, tool, { ...direction, stepdown: 30 }, {
          onAngle: (count, total) => {
            sampleTotal = total
            if (count === total) sampledChecks = checks
          },
          shouldStop: () => { checks++; return false },
        })
        return checks
      })()
      const refineChecks = passDirection === 'around' ? Math.max(0, sampleTotal - 1) : 0
      const oneLayerEmission = oneLayer - sampledChecks - refineChecks
      assert.ok(oneLayerEmission >= perLayerPositions[passDirection],
        `${name} ${passDirection}: a one-layer program polls ${oneLayerEmission} times after sampling; `
        + `expected at least ${perLayerPositions[passDirection]} (one per ring/pass)`)
      {
        let manyChecks = 0
        generate('many-layers', mesh, stock, tool, { ...direction, stepdown: 1 }, {
          shouldStop: () => { manyChecks++; return false },
        })
        const manyEmission = manyChecks - sampledChecks - refineChecks
        assert.ok(manyEmission > oneLayerEmission,
          `${name} ${passDirection}: more layers poll more than one layer (${manyEmission} > ${oneLayerEmission})`)
        assert.ok(manyEmission - oneLayerEmission >= perLayerPositions[passDirection],
          `${name} ${passDirection}: each extra layer adds at least one poll per ring/pass `
          + `(${manyEmission - oneLayerEmission} >= ${perLayerPositions[passDirection]})`)
      }
      // Returning true on the poll that completes the same one-layer program
      // must discard every move already built.
      let checks = 0
      const stopped = generate('cancel', mesh, stock, tool, { ...direction, stepdown: 30 }, {
        shouldStop: () => ++checks === oneLayer,
      })
      assert.equal(checks, oneLayer, `${name} ${passDirection}: cancellation polled once per ring/pass`)
      assert.deepEqual(stopped, { operationId: 'cancel', moves: [], warnings: [], bounds: null })
    }
  }
  const accepted = generateRotaryRough('above-minimum', mesh, stock, tool,
    { ...base, stepdown: 0.01, stepover: 10, sampleSpacing: 5 }, {})
  assert.ok(accepted.moves.length > 0, 'the exact minimum remains usable inside the work budget')
  assert.deepEqual(accepted.warnings, [])
  console.log('rotaryWorkBudget.test.ts: all assertions passed')
}
