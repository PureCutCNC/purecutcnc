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
 * Legacy parity for machining setups (issue #944).
 *
 * Every project in the parity corpus predates setups and loads as one Top
 * setup. This replays one case per operation kind twice — once as migrated,
 * once in the shape a pre-setup build held in memory (no `setups`, no
 * `setupId`, no `authoringFace`) — and requires the generated toolpath and
 * the exported program to be identical. A differential check rather than a
 * stored golden, so it keeps meaning when a generator changes on purpose.
 *
 * It fails if a generator or the export pipeline starts reading the setup of
 * a Top operation — for example if the setup turn is applied at 0°.
 *
 * Run with: npx tsx src/engine/toolpaths/setupLegacyParity.test.ts
 */

import type { Project } from '../../types/project'
import { syncProjectSetups } from '../../store/helpers/setups'
import { withoutSetupFields } from '../../test/projectFixtures'
import { setupFace } from '../setupOrientation'
import { computeOperationToolpath } from './generateOperation'
import { buildParityCorpus, parityCoverageKey, postParityCase } from './parityCorpus'
import type { ParityCase } from './parityCorpus'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function main(): void {
  console.log('Testing Top toolpaths and G-code are unchanged by the setup migration...')
  const corpus = buildParityCorpus()
  const byCoverage = new Map<string, ParityCase>()
  for (const parityCase of corpus) {
    // Hand-built corpus cases attach their operation after normalising, so it
    // carries no setup yet; reconciling stamps it exactly as the store would.
    const project = syncProjectSetups(parityCase.project)
    assert(project.setups.length === 1 && setupFace(project.setups[0]) === 'top', `${parityCase.id}: loads as one Top setup`)
    const operation = project.operations.find((entry) => entry.id === parityCase.operationId)
    assert(operation, `${parityCase.id}: operation exists`)
    assert(operation.setupId === project.setups[0].id, `${parityCase.id}: the operation is in the Top setup`)
    // Later corpus entries are the small hand-built ones; letting them win
    // keeps this replay short without dropping any operation kind.
    byCoverage.set(parityCoverageKey(operation), { ...parityCase, project })
  }
  assert(byCoverage.size >= 8, `expected one case per operation kind, got ${byCoverage.size}`)

  for (const [coverage, parityCase] of byCoverage) {
    const migrated = parityCase.project
    const legacy = withoutSetupFields(migrated) as unknown as Project
    // structuredClone would copy the mesh buffers; share them as the store does.
    legacy.modelAssets = migrated.modelAssets
    const operation = migrated.operations.find((entry) => entry.id === parityCase.operationId)
    const legacyOperation = legacy.operations.find((entry) => entry.id === parityCase.operationId)
    assert(operation && legacyOperation, `${coverage}: operation exists in both projects`)
    assert(legacyOperation.setupId === undefined && legacy.setups === undefined, `${coverage}: the legacy shape has no setup fields`)

    const after = computeOperationToolpath(migrated, operation)
    const before = computeOperationToolpath(legacy, legacyOperation)
    assert(after && before, `${coverage}: both projects generate`)
    assert(after.result.moves.length > 0, `${coverage}: the case generates moves`)
    assert(
      JSON.stringify(after.result) === JSON.stringify(before.result),
      `${coverage} (${parityCase.id}): the toolpath changed with the setup migration`,
    )
    assert(
      postParityCase(migrated, operation, after.result) === postParityCase(legacy, legacyOperation, before.result),
      `${coverage} (${parityCase.id}): the exported G-code changed with the setup migration`,
    )
  }
  console.log(`setup legacy parity passed (${byCoverage.size} operation kinds)`)
}

main()
