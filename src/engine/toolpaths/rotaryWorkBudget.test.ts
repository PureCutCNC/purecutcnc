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
 * Mutations: remove MAX_ROTARY_EMISSION_WORK checks -> bounded child fails;
 * remove layer cancellation -> cancellation assertion fails.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { squareStock, barPivotZ, barCentre } from '../../types/barStock'
import { generateRotaryFinish, generateRotaryRough } from './rotaryModel'
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
  const generate = process.env.ROTARY_WORK_BUDGET_CHILD === 'finish' ? generateRotaryFinish : generateRotaryRough
  const result = generate('budget', mesh, stock, tool, base, {})
  assert.deepEqual(result.moves, [], 'a valid minimum stepdown whose layers exceed the work budget refuses before emission')
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['operationStepoverRatioRange'])
} else {
  for (const kind of ['rough', 'finish']) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
      env: { ...process.env, ROTARY_WORK_BUDGET_CHILD: kind }, encoding: 'utf8', timeout: 10_000,
      maxBuffer: 100_000,
    })
    assert.equal(child.error, undefined, `${kind}: generation must refuse excessive work, never hang (${child.error?.message})`)
    assert.equal(child.status, 0, `${kind}: ${child.stdout} ${child.stderr}`)
  }
  for (const generate of [generateRotaryFinish, generateRotaryRough]) {
    for (const stepdown of [Number.MIN_VALUE, 0.009, 0, -1, NaN, Infinity]) {
      let sampled = 0
      const result = generate('minimum', mesh, stock, tool, { ...base, stepdown }, { onAngle: () => { sampled++ } })
      assert.deepEqual(result.moves, [])
      assert.equal(result.warnings.length, 1)
      assert.equal(sampled, 0, `invalid stepdown ${stepdown} is rejected before sampling`)
    }
    // The minimum is physical: 0.009 mm expressed in inches also refuses.
    const result = generate('inch-minimum', mesh, stock, { ...tool, units: 'inch' },
      { ...base, stepdown: 0.009 / 25.4 }, {})
    assert.deepEqual(result.moves, [])
    assert.equal(result.warnings.length, 1)
    // Sampling is independent of stepdown. Compare a one-layer job with a
    // many-layer job to prove emission itself polls cancellation (the around
    // sampler's refinement polls too). Cancel at the second layer, after the
    // first has emitted, and require all partial motion to be discarded.
    let oneLayerChecks = 0
    generate('one-layer', mesh, stock, tool, { ...base, stepdown: 30 }, {
      shouldStop: () => { oneLayerChecks++; return false },
    })
    let manyLayerChecks = 0
    generate('many-layers', mesh, stock, tool, { ...base, stepdown: 1 }, {
      shouldStop: () => { manyLayerChecks++; return false },
    })
    assert.ok(manyLayerChecks > oneLayerChecks, 'layer loops poll cancellation beyond sampling')
    let checks = 0
    const stopped = generate('cancel-layer', mesh, stock, tool, { ...base, stepdown: 1 }, {
      shouldStop: () => ++checks === oneLayerChecks + 1,
    })
    assert.equal(checks, oneLayerChecks + 1)
    assert.deepEqual(stopped, { operationId: 'cancel-layer', moves: [], warnings: [], bounds: null })
    const accepted = generate('above-minimum', mesh, stock, tool,
      { ...base, stepdown: 0.01, stepover: 10, sampleSpacing: 5 }, {})
    assert.ok(accepted.moves.length > 0, 'the exact minimum remains usable inside the work budget')
    assert.deepEqual(accepted.warnings, [])
  }
  console.log('rotaryWorkBudget.test.ts: all assertions passed')
}
