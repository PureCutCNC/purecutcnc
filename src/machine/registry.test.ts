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

import type { MachineDefinition } from '../engine/gcode/types'
import {
  allocateMachineId,
  bundledMachines,
  combineMachineLibrary,
  duplicateMachineAsCustom,
  duplicateMachineName,
  isBundledMachineId,
  machineFingerprint,
  machineSnapshotStatus,
  machinesFunctionallyEqual,
  mergeCustomMachineList,
  parseMachineImport,
  serializeMachineExport,
  validateCustomMachine,
  withCollisionSafeId,
} from './registry'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function customFrom(overrides: Partial<MachineDefinition>): MachineDefinition {
  const base = bundledMachines()[0]
  const validated = validateCustomMachine({
    ...structuredClone(base),
    id: 'shop-router',
    name: 'Shop Router',
    ...overrides,
  })
  if (validated.error !== undefined) throw new Error(validated.error)
  return validated.ok
}

// --- bundled definitions -------------------------------------------------

const bundled = bundledMachines()
assert(bundled.length > 0, 'the build ships bundled machine definitions')
assert(bundled.every((definition) => definition.builtin), 'bundled definitions are marked builtin')
assert(isBundledMachineId(bundled[0].id), 'a bundled id is recognized as reserved')
assert(!isBundledMachineId('shop-router'), 'an unrelated id is not reserved')

// Mutating a returned bundled copy must not affect the next read.
bundled[0].name = 'mutated'
assert(bundledMachines()[0].name !== 'mutated', 'bundledMachines() returns fresh copies')

// --- validation ----------------------------------------------------------

assert(validateCustomMachine(null).error !== undefined, 'null is rejected')
assert(validateCustomMachine([]).error !== undefined, 'an array is rejected')
assert(validateCustomMachine({ id: 'x' }).error !== undefined, 'an incomplete definition is rejected')

const reserved = validateCustomMachine({ ...structuredClone(bundledMachines()[0]) })
assert(reserved.error !== undefined, 'a custom definition may not claim a bundled id')

const forcedBuiltin = validateCustomMachine({
  ...structuredClone(bundledMachines()[0]),
  id: 'shop-router',
  name: 'Shop Router',
  builtin: true,
})
assert(forcedBuiltin.ok !== undefined, 'a renamed bundled definition validates as custom')
assert(forcedBuiltin.ok?.builtin === false, 'builtin is forced to false regardless of input')

const longName = validateCustomMachine({
  ...structuredClone(bundledMachines()[0]),
  id: 'shop-router',
  name: 'x'.repeat(200),
})
assert(longName.error !== undefined, 'an over-long name is rejected')

// --- fingerprint / comparison -------------------------------------------

const machineA = customFrom({})
const machineB = { ...structuredClone(machineA), builtin: true } as MachineDefinition
assert(machinesFunctionallyEqual(machineA, machineB), 'the builtin flag is not a functional difference')

const machineC = { ...structuredClone(machineA), fileExtension: 'tap' }
assert(!machinesFunctionallyEqual(machineA, machineC), 'a functional field difference is detected')
assert(machineFingerprint(machineA) === machineFingerprint(machineA), 'fingerprints are stable')

// --- id allocation -------------------------------------------------------

assert(
  allocateMachineId('Shop Router', new Set()) === 'shop-router',
  'a name slugifies into an id',
)
assert(
  allocateMachineId('Shop Router', new Set(['shop-router'])) === 'shop-router-2',
  'a taken id gets a numeric suffix',
)
assert(
  allocateMachineId(bundledMachines()[0].name, new Set()) !== bundledMachines()[0].id
    || !isBundledMachineId(allocateMachineId(bundledMachines()[0].name, new Set())),
  'allocation never returns a reserved bundled id',
)
assert(allocateMachineId('!!!', new Set()) === 'custom-machine', 'an unslugifiable name falls back')

// --- duplication ---------------------------------------------------------

const duplicate = duplicateMachineAsCustom(bundledMachines()[0], [])
assert(duplicate.builtin === false, 'a duplicated bundled definition is custom')
assert(!isBundledMachineId(duplicate.id), 'a duplicate never keeps the bundled id')
assert(duplicate.name.includes('(copy)'), 'a duplicate is named as a copy')

const duplicateAgain = duplicateMachineAsCustom(bundledMachines()[0], [duplicate])
assert(duplicateAgain.id !== duplicate.id, 'a second duplicate gets a distinct id')
assert(
  duplicateMachineName('Shop Router', ['Shop Router (copy)']) === 'Shop Router (copy) 2',
  'duplicate names disambiguate',
)

// --- collision-safe ids --------------------------------------------------

const keptId = withCollisionSafeId(machineA, [])
assert(keptId.id === machineA.id, 'a free id is kept as-is')
const rekeyed = withCollisionSafeId(machineA, [machineA])
assert(rekeyed.id !== machineA.id, 'a colliding id is re-keyed')

// --- import / export -----------------------------------------------------

const exported = serializeMachineExport(bundledMachines()[0])
assert(!('builtin' in (JSON.parse(exported) as Record<string, unknown>)), 'export omits the builtin flag')

const imported = parseMachineImport(exported, [])
assert(imported.ok !== undefined, 'an exported bundled definition imports as a custom machine')
assert(imported.ok?.builtin === false, 'an imported machine is custom')
assert(!isBundledMachineId(imported.ok?.id ?? ''), 'an imported machine never claims a bundled id')

const importedCollision = parseMachineImport(serializeMachineExport(machineA), [machineA])
assert(importedCollision.ok !== undefined, 'a colliding import still succeeds')
assert(importedCollision.ok?.id !== machineA.id, 'a colliding import is re-keyed')

assert(parseMachineImport('not json', []).error !== undefined, 'malformed JSON is rejected')
assert(parseMachineImport('[]', []).error !== undefined, 'a JSON array is rejected')
assert(parseMachineImport('{"id":"x"}', []).error !== undefined, 'an incomplete import is rejected')

// --- combined library ----------------------------------------------------

const library = combineMachineLibrary([machineA])
assert(library.length === bundledMachines().length + 1, 'the library is bundled + custom')
assert(library[library.length - 1].id === machineA.id, 'custom machines follow bundled ones')

// --- snapshot status -----------------------------------------------------

assert(machineSnapshotStatus(null, library).kind === 'none', 'no embedded machine reports none')
assert(
  machineSnapshotStatus(bundledMachines()[0], library).kind === 'in-sync',
  'a matching bundled snapshot is in sync',
)
assert(
  machineSnapshotStatus({ ...bundledMachines()[0], fileExtension: 'tap' }, library).kind === 'update-available',
  'a differing snapshot reports an available update',
)
assert(
  machineSnapshotStatus(machineA, bundledMachines()).kind === 'not-in-library',
  'a snapshot absent from the library is reported as such',
)

// --- merge ---------------------------------------------------------------

const identicalMerge = mergeCustomMachineList([machineA], [structuredClone(machineA)])
assert(identicalMerge.added.length === 0, 'a semantically identical candidate is skipped')

const differingMerge = mergeCustomMachineList([machineA], [{ ...structuredClone(machineA), fileExtension: 'tap' }])
assert(differingMerge.added.length === 1, 'a differing candidate is added')
assert(differingMerge.added[0].id !== machineA.id, 'a differing candidate with a colliding id is re-keyed')

const bundledCandidateMerge = mergeCustomMachineList([], [bundledMachines()[0]])
assert(bundledCandidateMerge.added.length === 0, 'a bundled-id candidate is never merged into My Machines')

const invalidMerge = mergeCustomMachineList([], [{ id: 'broken' } as unknown as MachineDefinition])
assert(invalidMerge.added.length === 0, 'an invalid candidate is skipped')

console.log('machine/registry.test.ts: all assertions passed')
