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
const baseline: Readonly<Record<string, string>> = {
  'round x rotary_finish around': '8668ea5303fa53bf4809fa3b925dfb2ac7da4a326a74ee9fab81f2a939ed427f',
  'round x rotary_finish along': 'f063e6118a19ec1412c75f2717e4bd1dced1bd58f1f23102a9ca5157fd075150',
  'round x rotary_rough around': 'feece078ad0864957c0255cc758e0557d7f8cf6da7622d6142cf5025361b57d6',
  'round x rotary_rough along': '5d8a9d5a1d99792f45f9ec715a9ccd5d98970050713baeadbf60e6e63e36d7c1',
  'round y rotary_finish around': 'bba049a2b7cdb8fd0365e083b1664cd32b69ffbb8cef65a0248e86c49b02f9f8',
  'round y rotary_finish along': '13488876228afa952eda133cc92413c5552a87fca5f9cf1c677af2fb1c1a0ba6',
  'round y rotary_rough around': '6d093f5af3eec76dca829040a84ef3c4252f290d0c5d48fcef0619905796b07f',
  'round y rotary_rough along': 'bcef20596e2607e78afb41b8ff1a6335b0559920729dd14c512f336455837551',
  'square x rotary_finish around': '62c5e29a410e30fc1f523acf39ef0e9241a46f0f27ca2f2f5d98a0ff9cd5f3df',
  'square x rotary_finish along': '5e93ce5b7ae14aa09146b80471b3162852ea60753ac982bbcc2caca78e3a1710',
  'square x rotary_rough around': 'fdc9c5cf879e51c16368e6ae4d5010313c89141c6bea97f7b4ab6bc2c5dcb44d',
  'square x rotary_rough along': 'dc1d083a6a7d45c964ab036e840138a8437ad86a2d2231e17fc3bb8060d43138',
  'square y rotary_finish around': 'de8974b9293a97119a90ac92fd4b9682a10ab56b100c52f9691f429cb3393b49',
  'square y rotary_finish along': 'cbee0feefb2765a3ef668a7aef1dfd24c5624f210437d54e38c7d3d09d1218c8',
  'square y rotary_rough around': '50a99d45ef29f607995cc813e443a41f4f15bc370199165d8284414ca7bd308e',
  'square y rotary_rough along': 'a39dd71dfec91f5eaee0fa99b456a0fc87bc7e63327f495513146c401ecd93a3',
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
