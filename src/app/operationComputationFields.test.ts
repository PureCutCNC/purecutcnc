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
 * Every field of `Operation` is classified and probed against
 * `operationComputationEquals`.
 *
 * That function is a hand-maintained allowlist, and a field missing from it
 * fails silently in the worst way: the user changes the setting, the cache
 * reports a hit, and the toolpath never regenerates. Nothing looks broken.
 * `roundLinkCorners` (issue #545) and `cleanWallCorners` (issue #546) both
 * shipped that way, and the comment telling authors to update the list did not
 * stop either of them.
 *
 * `Record<keyof Required<Operation>, ...>` cannot be constructed without naming
 * every field, so adding one to `Operation` now fails to typecheck until it is
 * classified here — and once classified it is probed for real, by mutating it
 * and asserting the comparison reacts. The table replaces discipline with a
 * compiler error.
 *
 * Run with: npx tsx src/app/operationComputationFields.test.ts
 */

import type { Operation } from '../types/project'
import { operationComputationEquals } from './useToolpathGeneration'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/**
 * `computation` changes the emitted geometry and must invalidate the cache.
 * `display` is presentation only and must not. `identity` is neither compared
 * nor a user-facing toggle.
 */
type FieldRole = 'computation' | 'display' | 'identity'

interface FieldProbe {
  role: FieldRole
  /** A value differing from the base operation's, to mutate the field with. */
  change: Partial<Operation>
}

const BASE: Operation = {
  id: 'op-1',
  name: 'Pocket',
  description: '',
  kind: 'pocket',
  pass: 'rough',
  enabled: true,
  showToolpath: true,
  debugToolpath: false,
  target: { source: 'features', featureIds: ['feature-1'] },
  toolRef: 'tool-1',
  stepdown: 2,
  stepover: 0.4,
  feed: 800,
  plungeFeed: 300,
  rpm: 18000,
  pocketPattern: 'offset',
  pocketAngle: 0,
  stockToLeaveRadial: 0,
  stockToLeaveAxial: 0,
  finishWalls: true,
  finishFloor: true,
  carveDepth: 1,
  maxCarveDepth: 2,
}

const OPERATION_FIELDS: Record<keyof Required<Operation>, FieldProbe> = {
  id: { role: 'identity', change: { id: 'op-2' } },
  name: { role: 'display', change: { name: 'Renamed' } },
  description: { role: 'display', change: { description: 'note' } },
  enabled: { role: 'display', change: { enabled: false } },
  showToolpath: { role: 'display', change: { showToolpath: false } },
  arcFittingEnabled: { role: 'display', change: { arcFittingEnabled: false } },
  kind: { role: 'computation', change: { kind: 'drilling' } },
  pass: { role: 'computation', change: { pass: 'finish' } },
  debugToolpath: { role: 'computation', change: { debugToolpath: true } },
  debugShowRejectedCorners: { role: 'computation', change: { debugShowRejectedCorners: true } },
  target: { role: 'computation', change: { target: { source: 'features', featureIds: ['feature-1'] } } },
  toolRef: { role: 'computation', change: { toolRef: 'tool-2' } },
  stepdown: { role: 'computation', change: { stepdown: 3 } },
  stepover: { role: 'computation', change: { stepover: 0.5 } },
  feed: { role: 'computation', change: { feed: 900 } },
  plungeFeed: { role: 'computation', change: { plungeFeed: 350 } },
  rpm: { role: 'computation', change: { rpm: 19000 } },
  pocketPattern: { role: 'computation', change: { pocketPattern: 'parallel' } },
  pocketAngle: { role: 'computation', change: { pocketAngle: 45 } },
  edgeStrategy: { role: 'computation', change: { edgeStrategy: 'trochoidal' } },
  carveStrategy: { role: 'computation', change: { carveStrategy: 'trochoidal' } },
  trochoidalCutWidth: { role: 'computation', change: { trochoidalCutWidth: 2 } },
  trochoidalAdvance: { role: 'computation', change: { trochoidalAdvance: 1 } },
  entryStrategy: { role: 'computation', change: { entryStrategy: 'helix' } },
  entryRampAngle: { role: 'computation', change: { entryRampAngle: 5 } },
  entryHelixDiameterPercent: { role: 'computation', change: { entryHelixDiameterPercent: 80 } },
  pocketSlotFeedPercent: { role: 'computation', change: { pocketSlotFeedPercent: 55 } },
  pocketFeedReduction: { role: 'computation', change: { pocketFeedReduction: 'engagement' } },
  roundOutsideCorners: { role: 'computation', change: { roundOutsideCorners: true } },
  roundLinkCorners: { role: 'computation', change: { roundLinkCorners: true } },
  cleanWallCorners: { role: 'computation', change: { cleanWallCorners: true } },
  cornerRelief: { role: 'computation', change: { cornerRelief: 'dogbone' } },
  stockToLeaveRadial: { role: 'computation', change: { stockToLeaveRadial: 0.2 } },
  stockToLeaveAxial: { role: 'computation', change: { stockToLeaveAxial: 0.2 } },
  finishWalls: { role: 'computation', change: { finishWalls: false } },
  finishFloor: { role: 'computation', change: { finishFloor: false } },
  carveDepth: { role: 'computation', change: { carveDepth: 1.5 } },
  maxCarveDepth: { role: 'computation', change: { maxCarveDepth: 3 } },
  cutDirection: { role: 'computation', change: { cutDirection: 'climb' } },
  machiningOrder: { role: 'computation', change: { machiningOrder: 'feature_first' } },
  drillType: { role: 'computation', change: { drillType: 'peck' } },
  peckDepth: { role: 'computation', change: { peckDepth: 1 } },
  dwellTime: { role: 'computation', change: { dwellTime: 1 } },
  countersinkDiameter: { role: 'computation', change: { countersinkDiameter: 6 } },
  retractHeight: { role: 'computation', change: { retractHeight: 5 } },
  finishSlopeMin: { role: 'computation', change: { finishSlopeMin: 10 } },
  finishSlopeMax: { role: 'computation', change: { finishSlopeMax: 30 } },
  waterlineAdaptiveRefinement: { role: 'computation', change: { waterlineAdaptiveRefinement: false } },
  waterlineMicroStepover: { role: 'computation', change: { waterlineMicroStepover: 0.1 } },
  waterlineRefinementThreshold: { role: 'computation', change: { waterlineRefinementThreshold: 1 } },
  waterlineMaxRingsPerBand: { role: 'computation', change: { waterlineMaxRingsPerBand: 4 } },
  waterlineTipStepdown: { role: 'computation', change: { waterlineTipStepdown: 0.5 } },
}

function testEveryFieldIsProbed(): void {
  console.log('Testing every Operation field against operationComputationEquals...')
  assert(operationComputationEquals(BASE, { ...BASE }), 'an unchanged copy compares equal')

  for (const [field, probe] of Object.entries(OPERATION_FIELDS)) {
    const key = field as keyof Operation
    const mutated = { ...BASE, ...probe.change }
    // A probe that does not actually change the value would pass vacuously for
    // every display field and prove nothing, so check the mutation first.
    assert(JSON.stringify(mutated[key]) !== JSON.stringify(BASE[key])
      || mutated[key] !== BASE[key],
    `${field}: the probe must change the field's value`)

    const equal = operationComputationEquals(BASE, mutated)
    if (probe.role === 'computation') {
      assert(!equal, `${field} affects the toolpath, so changing it must invalidate the cache`)
    } else {
      assert(equal, `${field} is ${probe.role} only, so changing it must not invalidate the cache`)
    }
  }
  console.log(`every Operation field is probed (${Object.keys(OPERATION_FIELDS).length} fields): PASSED`)
}

try {
  testEveryFieldIsProbed()
  console.log('\nAll operationComputationFields tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
