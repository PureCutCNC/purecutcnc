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

import assert from 'node:assert/strict'
import { createNodeRotaryAngleWorkerSource } from '../../app/toolpathGeneration/rotaryAngleNodeTransport'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { rotaryMultiModelFixture, rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { rotaryOutputDigest } from '../../test/rotaryOutputDigest'
import { squareStock } from '../../types/barStock'
import type { Operation, Project } from '../../types/project'
import { computeOperationToolpath, computeOperationToolpathAsync } from './generateOperation'
import { createRotaryAnglePool, type RotaryAnglePool } from './rotaryAnglePool'

// Captured before the extraction on main at f3582eb7104464bf53565cf70c72f93136d80e83.
// A shared regression can change both drivers together, so compare to the fixed output.
// #1190 re-recorded all eight square rows: an around pass reads, bounds and overruns
// a square blank as it does a round bar, and an along pass overruns its owned ends
// too. Every round row is unchanged.
// #1237 re-recorded the eight around rows: the helix is off unless the operation
// asks for it, so each band is cut as rings, and a finish link between a ball's
// exactly read rings is read exactly too. Every along row is unchanged.
const baseline: Readonly<Record<string, string>> = {
  'round x rotary_finish around': '9287470663d9e7956ac141d4aebf0815413064c9b8f8b35576be856c68955848',
  'round x rotary_finish along': 'f063e6118a19ec1412c75f2717e4bd1dced1bd58f1f23102a9ca5157fd075150',
  'round x rotary_rough around': 'e305dd015065cd03b586be25336c33de3f435c40eaf9fbc724771b0b9feea3bb',
  'round x rotary_rough along': '5d8a9d5a1d99792f45f9ec715a9ccd5d98970050713baeadbf60e6e63e36d7c1',
  'round y rotary_finish around': '3d0c31fda9f1813f4e1bb91c4968d4795ef43c2d2f06bc67a0fc503635f37961',
  'round y rotary_finish along': '13488876228afa952eda133cc92413c5552a87fca5f9cf1c677af2fb1c1a0ba6',
  'round y rotary_rough around': '49afb08eb92dd019adf11c79431a7a64f32fc1c955aafe1564716fd3cfbfb790',
  'round y rotary_rough along': 'bcef20596e2607e78afb41b8ff1a6335b0559920729dd14c512f336455837551',
  'square x rotary_finish around': '6fa4e4394e6c8efd743038f030f9e6668bb8f190034e23bb933ea749c55739ec',
  'square x rotary_finish along': '9befa7527347dead8b765ce63fdf7d4ac39e3b97c8bde4931f7573998c1c5e5a',
  'square x rotary_rough around': 'a0df941e758e105fa1831b110c5e178669d7e3bde01c30aeff3d17a8543bff46',
  'square x rotary_rough along': '3458370b5776018d8722e3a64d2582656d8d7fcacd2563430019bfd9f33d6bbc',
  'square y rotary_finish around': 'dd09c49f92a029b5b785d66ac92a85254ec9750be732532828da09b8220d45d5',
  'square y rotary_finish along': '5438c2e0b4f273847a186fb061e69296b55c7ded578f14af673b3699956b5d1e',
  'square y rotary_rough around': 'f2e9ca4e4d7d1a4592427a15940e075789ec9c87d60b9145813630844b23d7ef',
  'square y rotary_rough along': '92146a27dba86977d0e460212ed914b480eb6d72d29286572e5ce7d618061663',
  'round x region rough around': '546c11444e1c79c0377e9d2d1b0c14eb9ed80d64f6d96517bb23dfefbbce4fbf',
}

const cases: { label: string; project: Project; operation: Operation; worker?: boolean }[] = []
for (const shape of ['round', 'square'] as const) {
  for (const axis of ['x', 'y'] as const) {
    for (const kind of ['rotary_finish', 'rotary_rough'] as const) {
      for (const direction of ['around', 'along'] as const) {
        const project = rotaryOperationFixture(axis, kind)
        if (shape === 'square') {
          const stock = squareStock(12, 30, axis)
          project.stock = stock
          project.clamps = [{
            ...defaultRoundWorkholding('chuck', stock, project.meta.units),
            id: 'chuck', name: 'Chuck', visible: true,
          }]
        }
        const operation = { ...project.operations[0], rotaryPassDirection: direction }
        cases.push({ label: [shape, axis, kind, direction].join(' '), project, operation,
          worker: axis === 'x' && direction === 'around' })
      }
    }
  }
}
const regionProject = rotaryMultiModelFixture('x', 'rotary_rough')
const regionRough: Operation = {
  ...regionProject.operations[0],
  rotaryPassDirection: 'around',
  target: { source: 'features', featureIds: ['model', 'region'] },
}
cases.push({ label: 'round x region rough around', project: regionProject, operation: regionRough })

const workerSource = createNodeRotaryAngleWorkerSource({ availableParallelism: 4 })
for (const { label, project, operation, worker } of cases) {
  const sync = computeOperationToolpath(project, operation)
  assert.ok(sync, label + ': operation generates')
  assert.ok(sync.result.moves.some((move) => move.kind === 'cut'), label + ': cutting moves')
  if (operation === regionRough) {
    const unrestricted = computeOperationToolpath(project, {
      ...operation, target: { source: 'features', featureIds: ['model'] },
    })
    assert.ok(unrestricted)
    assert.ok(unrestricted.result.moves.some((move) => move.kind === 'cut'))
    assert.notDeepEqual(sync.result.moves, unrestricted.result.moves, 'the region changes motion')
  }

  const pools: RotaryAnglePool[] = []
  try {
    const asyncResult = await computeOperationToolpathAsync(project, operation, worker ? {
      rotaryRunBatch: (prep) => {
        const pool = createRotaryAnglePool(prep, workerSource, { maxWorkers: 2 })
        pools.push(pool)
        return pool.batches
      },
    } : {})
    assert.deepEqual(asyncResult?.result, sync.result, label + ': asynchronous result')
    if (worker) {
      assert.ok(pools.some((pool) => {
        const stats = pool.stats()
        return stats.mode === 'parallel' && stats.batches > 0
      }), label + ': worker threads computed the samples')
    }
  } finally {
    await Promise.all(pools.map((pool) => pool.dispose()))
  }
  assert.equal(rotaryOutputDigest(project, operation, sync.result), baseline[label], label + ': fixed output')
}

console.log('Rotary target planning: all baseline and driver comparisons passed.')
