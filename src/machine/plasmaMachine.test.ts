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
import { BUNDLED_DEFINITIONS, getActiveMachineDefinition } from '../engine/gcode/definitions'
import { MachineDefinitionSchema, resolveMachineKind, validateMachineDefinition } from '../engine/gcode/types'
import { CORPUS, renderCase } from '../../scripts/gcode-conformance/corpus'
import { mergeFormData, toFormData, validateDef } from '../components/machine/machineDefinitionForm'
import { newProject } from '../types/project'
import { decodeProjectFormat } from '../store/helpers/projectFormat'
import { duplicateMachineAsCustom, parseMachineImport, serializeMachineExport, validateCustomMachine, machineFieldDifferences, machineSnapshotStatus, bundledMachines } from './registry'
import { CUSTOM_MACHINES_SCHEMA_VERSION, sanitizeStoredCustomMachines } from './storage'

const raw = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'qtplasmac')
assert.ok(raw, 'QtPlasmaC is discoverable in the bundled library')
const plasma = validateMachineDefinition(raw)
assert.equal(plasma.name, 'QtPlasmaC (experimental)')
assert.equal(resolveMachineKind(plasma), 'plasma')
assert.deepEqual(plasma.plasma, {
  torchOnCommand: 'M3 $0 S1', torchOffCommand: 'M5 $0',
  materialSelectCommand: 'M190 P{materialNumber}',
  materialWaitCommand: 'M66 P3 L3 Q1', materialFeedCommand: 'F#<_hal[plasmac.cut-feed-rate]>',
  thcOnCommand: 'M63 P2', thcOffCommand: 'M62 P2', pierceMode: 'controller',
})
const { plasma: block, ...missingBlock } = plasma
assert.ok(block)
assert.equal(MachineDefinitionSchema.safeParse(missingBlock).success, false, 'plasma kind requires a block')
assert.equal(validateDef(missingBlock).ok, undefined, 'editor shares the validation boundary')
assert.equal(validateCustomMachine({ ...missingBlock, id: 'invalid-plasma' }).ok, undefined)
assert.equal(parseMachineImport(JSON.stringify(missingBlock), []).ok, undefined)
for (const patch of [
  { plasma: null }, { machineKind: 'laser' },
  { machineKind: undefined }, { machineKind: 'router' }, { outputDialect: 'opensbp' },
  { plasma: { ...block, pierceMode: 'gcode' } },
  { plasma: { ...block, pierceMode: 'unknown' } },
  ...['torchOnCommand', 'torchOffCommand', 'materialSelectCommand', 'materialWaitCommand', 'materialFeedCommand'].flatMap((key) => [
    { plasma: { ...block, [key]: undefined } }, { plasma: { ...block, [key]: '  ' } },
  ]),
  { plasma: { ...block, thcOnCommand: 123 } },
]) {
  assert.equal(MachineDefinitionSchema.safeParse({ ...plasma, ...patch }).success, false, JSON.stringify(patch))
}
const { thcOnCommand: _on, thcOffCommand: _off, ...requiredBlock } = block
assert.equal(MachineDefinitionSchema.safeParse({ ...plasma, plasma: requiredBlock }).success, true, 'THC overrides are optional')

// Invalid raw/imported combinations must fail at every persisted boundary.
for (const invalid of [{ ...plasma, machineKind: undefined }, { ...plasma, machineKind: 'router' }, { ...plasma, outputDialect: 'opensbp' }]) {
  assert.equal(validateDef(invalid).ok, undefined)
  assert.equal(validateCustomMachine(invalid).ok, undefined)
  assert.equal(parseMachineImport(JSON.stringify(invalid), []).ok, undefined)
  assert.deepEqual(sanitizeStoredCustomMachines({ schemaVersion: CUSTOM_MACHINES_SCHEMA_VERSION, machines: [{ ...invalid, id: 'orphan' }] }), [])
}
const padded = validateMachineDefinition({ ...plasma, plasma: { ...block, torchOnCommand: '  M3 $0 S1  ', materialWaitCommand: '  M66 P3 L3 Q2  ', thcOnCommand: '  ', thcOffCommand: '\t' } })
assert.equal(padded.plasma?.torchOnCommand, '  M3 $0 S1  ', 'validation does not rewrite command text')
assert.equal(padded.plasma?.materialWaitCommand, '  M66 P3 L3 Q2  ')
assert.ok(!('thcOnCommand' in padded.plasma!))
assert.ok(!('thcOffCommand' in padded.plasma!))

const duplicate = duplicateMachineAsCustom(plasma, [])
assert.equal(duplicate.machineKind, 'plasma')
assert.deepEqual(duplicate.plasma, block)
const imported = parseMachineImport(serializeMachineExport(duplicate), [])
assert.ok(imported.ok)
assert.deepEqual(imported.ok.plasma, block)
const stored = sanitizeStoredCustomMachines({ schemaVersion: CUSTOM_MACHINES_SCHEMA_VERSION, machines: [duplicate, { ...missingBlock, id: 'bad' }] })
assert.deepEqual(stored, [duplicate], 'storage keeps plasma metadata and drops invalid entries individually')
assert.equal(machineSnapshotStatus(plasma, bundledMachines()).kind, 'in-sync')
const edited = { ...duplicate, plasma: { ...block, torchOffCommand: 'M5 $-1' } }
assert.deepEqual(machineFieldDifferences(duplicate, edited), ['plasma'])
assert.equal(machineSnapshotStatus(duplicate, [edited]).kind, 'update-available')

const project = newProject('Plasma snapshot', 'mm')
assert.equal(project.version, '3.3')
project.meta.machineDefinitions = [duplicate]
project.meta.selectedMachineId = duplicate.id
const decoded = decodeProjectFormat(JSON.parse(JSON.stringify(project)))
assert.equal(decoded.project.version, '3.3')
assert.deepEqual(getActiveMachineDefinition(decoded.project), duplicate, '3.3 save/open preserves the embedded plasma snapshot')
const router = validateMachineDefinition(BUNDLED_DEFINITIONS[0])
project.meta.machineDefinitions = [router]
project.meta.selectedMachineId = router.id
const legacy = decodeProjectFormat(JSON.parse(JSON.stringify(project)))
assert.ok(!('machineKind' in legacy.project.meta.machineDefinitions[0]), 'missing fields remain absent even in a 3.3 project')

const form = toFormData(duplicate)
assert.equal(form.machineKind, 'plasma')
assert.equal(form.pierceMode, 'controller')
assert.deepEqual(mergeFormData(duplicate, form), duplicate)
const changed = mergeFormData(duplicate, { ...form, torchOffCommand: 'M5 $-1', thcOnCommand: '  ', thcOffCommand: '\t', materialWaitCommand: 'M66 P3 L3 Q2', materialFeedCommand: 'F#<_hal[plasmac.cut-feed-rate]> (loaded)', materialSelectCommand: 'M190 P{materialNumber} (material)' })
assert.equal(changed.plasma?.torchOffCommand, 'M5 $-1')
assert.equal(changed.plasma?.materialWaitCommand, 'M66 P3 L3 Q2')
assert.equal(changed.plasma?.materialFeedCommand, 'F#<_hal[plasmac.cut-feed-rate]> (loaded)')
assert.equal(changed.plasma?.materialSelectCommand, 'M190 P{materialNumber} (material)')
assert.ok(!('thcOnCommand' in changed.plasma!))
assert.ok(!('thcOffCommand' in changed.plasma!))
const converted = mergeFormData(duplicate, { ...form, machineKind: 'router' })
assert.equal(converted.machineKind, 'router')
assert.ok(!('plasma' in converted))
assert.ok(!('machineKind' in mergeFormData(router, toFormData(router))), 'editing a legacy router adds no kind')
const newPlasma = mergeFormData(router, { ...form, name: 'New plasma' })
assert.equal(validateDef(newPlasma).ok?.machineKind, 'plasma', 'focused form can create a plasma definition')

// Even with tool changes requested, this metadata PR cannot turn on a torch
// through a legacy spindle word or through new template substitution.
const fixture = CORPUS.find((entry) => entry.name === 'sbp-mm-tool-change')
assert.ok(fixture)
const rendered = renderCase({ ...fixture, machineId: 'qtplasmac' })
const output = rendered.gcode
assert.equal(rendered.warnings.filter((warning) => warning.includes('postPlasmaOutputPending')).length, 1, 'all plasma exports disclose the absent torch path once')
assert.equal(rendered.warnings.filter((warning) => warning.includes('postNoToolChangeCommands')).length, 1, 'an unexecuted real tool change is disclosed')
for (const word of ['G92.1', 'G97', 'M52 P1']) assert.ok(output.includes(word), 'QtPlasmaC preamble includes ' + word)
assert.ok(/G[01] /.test(output), 'fixture actually exports motion')
assert.ok(!/\bM(?:3|4|5|190|62|63|64|65|66)\b/.test(output), 'no torch/material/THC sequence is emitted by metadata')
console.log('plasmaMachine.test.ts: schema, library, storage, snapshot, form and no-torch assertions passed')
