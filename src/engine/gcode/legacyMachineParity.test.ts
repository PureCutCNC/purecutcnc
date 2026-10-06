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

// Frozen against integration/0.6.0 @ dad88a9c before #956 production edits.
// Only the wall-clock date is normalized; every other output byte is compared.
import assert from 'node:assert/strict'
import { mergeFormData, toFormData } from '../../components/machine/machineDefinitionForm'
import golden from './legacyMachineParity.json'
import { BUNDLED_DEFINITIONS } from './definitions'
import { resolveMachineKind, validateMachineDefinition } from './types'
import { CORPUS, renderCase } from '../../../scripts/gcode-conformance/corpus'

export const LEGACY_MACHINE_IDS = ['generic', 'grbl', 'grblhal', 'mach3', 'uccnc', 'linuxcnc', 'shopbot'] as const

function legacyMachineOutputs(editRoundTrip = false): Record<string, ReturnType<typeof renderCase>> {
  const outputs: Record<string, ReturnType<typeof renderCase>> = {}
  for (const machineId of LEGACY_MACHINE_IDS) {
    for (const units of ['mm', 'inch'] as const) {
      for (const name of ['full-circle', `sbp-${units}-tool-change`, `sbp-${units}-drilling`]) {
        const fixture = CORPUS.find((entry) => entry.name === name)
        if (!fixture) throw new Error(`Missing parity fixture ${name}`)
        const key = `${machineId}/${units}/${name}`
        const rendered = renderCase({ ...fixture, machineId, units,
          ...(editRoundTrip ? { definitionOverrides: (base) => {
            const definition = validateMachineDefinition(base)
            return mergeFormData(definition, toFormData(definition))
          } } : {}),
        })
        outputs[key] = { ...rendered, gcode: rendered.gcode.replace(/\d{4}-\d{2}-\d{2}/g, '2000-01-01') }
      }
    }
  }
  return outputs
}

assert.equal(Object.keys(golden).length, 42, 'frozen corpus covers seven machines, two units, three workflows')
assert.deepEqual(legacyMachineOutputs(), golden, 'existing machine output is byte-identical to dad88a9c (clock pinned)')
assert.deepEqual(legacyMachineOutputs(true), golden, 'no-op focused editing preserves all existing output bytes')
for (const id of LEGACY_MACHINE_IDS) {
  const machine = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(machine, `bundled legacy machine ${id}`)
  const parsed = validateMachineDefinition(machine)
  assert.equal(resolveMachineKind(parsed), 'router')
  assert.ok(!('machineKind' in parsed), `${id} keeps kind absent`)
  assert.ok(!('plasma' in parsed), `${id} keeps plasma absent`)
  assert.deepEqual(parsed, machine, `${id} parsing leaves the embedded snapshot unchanged`)
  assert.deepEqual(validateMachineDefinition({ ...machine, machineKind: 'router' }), { ...parsed, machineKind: 'router' })
}
console.log('legacyMachineParity.test.ts: 42 frozen output cases passed')
