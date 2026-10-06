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
import { BUNDLED_DEFINITIONS } from '../engine/gcode/definitions'
import { MachineDefinitionSchema, resolveMachineKind, validateMachineDefinition } from '../engine/gcode/types'
import { CORPUS, renderCase } from '../../scripts/gcode-conformance/corpus'
import { DEFAULT_TOUCH_OFF, mergeFormData, toFormData, validateDef } from '../components/machine/machineDefinitionForm'
import { duplicateMachineAsCustom, parseMachineImport, serializeMachineExport } from './registry'
import grblRaw from '../engine/gcode/definitions/grbl.json'
import qtplasmacRaw from '../engine/gcode/definitions/qtplasmac.json'

const raw = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl-plasma')
assert.ok(raw, 'Grbl plasma is discoverable in the bundled library')
const plasma = validateMachineDefinition(raw)
assert.equal(plasma.name, 'Grbl plasma (OpenBuilds CONTROL) (experimental)')
assert.equal(resolveMachineKind(plasma), 'plasma')
assert.equal(plasma.fileExtension, 'gcode')
assert.deepEqual(plasma.plasma, {
  torchOnCommand: 'M3 S1000', torchOffCommand: 'M5', pierceMode: 'gcode',
  touchOff: { probeCommand: 'G38.2', probeDepth: 30, probeFeed: 100, setZeroCommand: 'G10 L20 P0', switchOffset: 0 },
})
assert.deepEqual(plasma.plasma?.touchOff, DEFAULT_TOUCH_OFF, 'the editor default is the bundled touch-off')

// The plasma copy shares GRBL 1.1's word syntax, so GRBL's parser verdicts hold for it.
const grbl = validateMachineDefinition(grblRaw)
for (const key of ['coordinateSystem', 'numberFormat', 'units', 'motion'] as const) {
  assert.deepEqual(plasma[key], grbl[key], `${key} matches grbl.json`)
}
for (const key of ['commentPrefix', 'commentSuffix', 'lineNumbers', 'lineNumberIncrement'] as const) {
  assert.equal(plasma.program[key], grbl.program[key], `program.${key} matches grbl.json`)
}

// Controller-owned definitions parse exactly as before this change.
assert.deepEqual(validateMachineDefinition(qtplasmacRaw).plasma, qtplasmacRaw.plasma, 'QtPlasmaC block is byte-stable')
assert.deepEqual(Object.keys(validateMachineDefinition(qtplasmacRaw).plasma!), [
  'torchOnCommand', 'torchOffCommand', 'materialSelectCommand', 'materialWaitCommand', 'materialFeedCommand', 'pierceMode', 'thcOnCommand', 'thcOffCommand',
], 'and keeps the schema key order it had before touch-off')

const block = plasma.plasma!
const touchOff = block.touchOff!
const qtBlock = validateMachineDefinition(qtplasmacRaw).plasma!
for (const patch of [
  { plasma: { ...block, touchOff: undefined } },
  { plasma: { ...block, materialSelectCommand: 'M190 P{materialNumber}' } },
  { plasma: { ...block, materialWaitCommand: 'M66 P3 L3 Q1' } },
  { plasma: { ...qtBlock, touchOff } },
  { plasma: { ...block, touchOff: { ...touchOff, probeCommand: '  ' } } },
  { plasma: { ...block, touchOff: { ...touchOff, setZeroCommand: '' } } },
  ...(['probeDepth', 'probeFeed'] as const).flatMap((key) => [0, -1, Number.NaN, '30', undefined].map((value) => ({ plasma: { ...block, touchOff: { ...touchOff, [key]: value } } }))),
  ...[-0.5, Number.NaN, Number.POSITIVE_INFINITY, undefined].map((switchOffset) => ({ plasma: { ...block, touchOff: { ...touchOff, switchOffset } } })),
]) {
  assert.equal(MachineDefinitionSchema.safeParse({ ...plasma, ...patch }).success, false, JSON.stringify(patch))
}
const blankMaterial = validateMachineDefinition({ ...plasma, plasma: { ...block, materialSelectCommand: '  ' } })
assert.ok(!('materialSelectCommand' in blankMaterial.plasma!), 'a blank material command is absent, as for THC')
assert.equal(validateMachineDefinition({ ...plasma, plasma: { ...block, touchOff: { ...touchOff, switchOffset: 1.5 } } }).plasma?.touchOff?.switchOffset, 1.5)

const duplicate = duplicateMachineAsCustom(plasma, [])
const imported = parseMachineImport(serializeMachineExport(duplicate), [])
assert.deepEqual(imported.ok?.plasma, block, 'export/import keeps touch-off')

// Focused editor: round trip, edits, and switching between pierce modes.
const form = toFormData(duplicate)
assert.equal(form.pierceMode, 'gcode')
assert.deepEqual(mergeFormData(duplicate, form), duplicate)
const edited = validateDef(mergeFormData(duplicate, { ...form, switchOffset: '1.5', probeDepth: '40', probeFeed: '150', probeCommand: 'G38.3' }))
assert.deepEqual(edited.ok?.plasma?.touchOff, { ...touchOff, switchOffset: 1.5, probeDepth: 40, probeFeed: 150, probeCommand: 'G38.3' })
for (const bad of [{ probeDepth: '' }, { probeFeed: 'abc' }, { switchOffset: '-1' }, { switchOffset: '' }]) {
  assert.equal(validateDef(mergeFormData(duplicate, { ...form, ...bad })).ok, undefined, JSON.stringify(bad))
}
const qt = duplicateMachineAsCustom(validateMachineDefinition(qtplasmacRaw), [])
const qtForm = toFormData(qt)
assert.equal(qtForm.probeCommand, 'G38.2', 'touch-off is prefilled for a controller machine')
const toGcode = validateDef(mergeFormData(qt, { ...qtForm, pierceMode: 'gcode' })).ok
assert.deepEqual(toGcode?.plasma?.touchOff, DEFAULT_TOUCH_OFF)
assert.ok(!('materialSelectCommand' in toGcode!.plasma!), 'switching to G-code piercing drops the material sequence')
const back = validateDef(mergeFormData(toGcode!, { ...toFormData(toGcode!), pierceMode: 'controller' }))
assert.equal(back.ok, undefined, 'switching back needs the material sequence typed again')
const restored = validateDef(mergeFormData(qt, qtForm)).ok
assert.deepEqual(restored, qt, 'an unedited controller machine gains no touch-off')

// Metadata only: the export still writes no torch, probe or zeroing words.
const fixture = CORPUS.find((entry) => entry.name === 'sbp-mm-tool-change')
assert.ok(fixture)
const rendered = renderCase({ ...fixture, machineId: 'grbl-plasma' })
assert.equal(rendered.warnings.filter((warning) => warning.includes('postPlasmaOutputPending')).length, 1)
assert.ok(/G[01] /.test(rendered.gcode), 'fixture actually exports motion')
assert.ok(!/\b(?:M[345]|G38\.\d|G10)\b/.test(rendered.gcode), 'no torch or touch-off sequence is emitted yet')
assert.ok(rendered.gcode.includes('; Experimental plasma output: not verified on a real plasma table'))
console.log('grblPlasmaMachine.test.ts: Grbl plasma schema, parity, form and no-torch assertions passed')
