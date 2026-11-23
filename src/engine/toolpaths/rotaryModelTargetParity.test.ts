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
const baseline: Readonly<Record<string, string>> = {
  'round x rotary_finish around': '8668ea5303fa53bf4809fa3b925dfb2ac7da4a326a74ee9fab81f2a939ed427f',
  'round x rotary_finish along': 'f063e6118a19ec1412c75f2717e4bd1dced1bd58f1f23102a9ca5157fd075150',
  'round x rotary_rough around': 'feece078ad0864957c0255cc758e0557d7f8cf6da7622d6142cf5025361b57d6',
  'round x rotary_rough along': '5d8a9d5a1d99792f45f9ec715a9ccd5d98970050713baeadbf60e6e63e36d7c1',
  'round y rotary_finish around': 'bba049a2b7cdb8fd0365e083b1664cd32b69ffbb8cef65a0248e86c49b02f9f8',
  'round y rotary_finish along': '13488876228afa952eda133cc92413c5552a87fca5f9cf1c677af2fb1c1a0ba6',
  'round y rotary_rough around': '6d093f5af3eec76dca829040a84ef3c4252f290d0c5d48fcef0619905796b07f',
  'round y rotary_rough along': 'bcef20596e2607e78afb41b8ff1a6335b0559920729dd14c512f336455837551',
  'square x rotary_finish around': '7b3585bdf4bba7bf5e0f81b37ac398ffc5515027f86a1ce7c8b92deb23409239',
  'square x rotary_finish along': '9befa7527347dead8b765ce63fdf7d4ac39e3b97c8bde4931f7573998c1c5e5a',
  'square x rotary_rough around': 'b8fe8ef74d7eff769e8e3c63dc0d85bdd416f47bd64ff2bf31c500818d91b526',
  'square x rotary_rough along': '3458370b5776018d8722e3a64d2582656d8d7fcacd2563430019bfd9f33d6bbc',
  'square y rotary_finish around': '56873bbf3d2c57a42ec14e14a871aa1e83bead3d162be8420eb9c3a308a33645',
  'square y rotary_finish along': '5438c2e0b4f273847a186fb061e69296b55c7ded578f14af673b3699956b5d1e',
  'square y rotary_rough around': 'ad913cf04ea9926156146b57a28e257fd42e375a967de41e1752a1bf0513d2a2',
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
