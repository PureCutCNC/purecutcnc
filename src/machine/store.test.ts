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
import { bundledMachines, validateCustomMachine } from './registry'
import {
  CUSTOM_MACHINES_STORAGE_KEY,
  readStoredCustomMachines,
  sanitizeStoredCustomMachines,
} from './storage'
import {
  deleteCustomMachine,
  getMachineLibrarySnapshot,
  initMachineLibrary,
  mergeCustomMachines,
  resetMachineLibraryForTests,
  saveCustomMachine,
  subscribe,
} from './store'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

class FakeStorage {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  raw(key: string): string | null {
    return this.getItem(key)
  }
}

function custom(id: string, name: string, overrides: Partial<MachineDefinition> = {}): MachineDefinition {
  const validated = validateCustomMachine({
    ...structuredClone(bundledMachines()[0]),
    id,
    name,
    ...overrides,
  })
  if (validated.error !== undefined) throw new Error(validated.error)
  return validated.ok
}

// --- initialization ------------------------------------------------------

resetMachineLibraryForTests()
initMachineLibrary(null)
assert(getMachineLibrarySnapshot().customMachines.length === 0, 'no storage yields an empty custom list')
assert(
  getMachineLibrarySnapshot().library.length === bundledMachines().length,
  'the library always exposes the current bundled definitions',
)

// --- save / persist ------------------------------------------------------

const storage = new FakeStorage()
resetMachineLibraryForTests()
initMachineLibrary(storage)

let notifications = 0
const unsubscribe = subscribe(() => { notifications += 1 })

const saved = saveCustomMachine(custom('shop-router', 'Shop Router'))
assert(saved.ok !== undefined, 'a valid custom machine saves')
assert(notifications === 1, 'saving notifies subscribers')
assert(getMachineLibrarySnapshot().customMachines.length === 1, 'the custom list holds the saved machine')
assert(
  getMachineLibrarySnapshot().library.some((definition) => definition.id === 'shop-router'),
  'the combined library includes the saved machine',
)

// A restart re-reads the same list.
resetMachineLibraryForTests()
initMachineLibrary(storage)
assert(
  getMachineLibrarySnapshot().customMachines.map((definition) => definition.id).join() === 'shop-router',
  'custom machines survive a restart',
)

// --- update in place -----------------------------------------------------

saveCustomMachine({ ...custom('shop-router', 'Shop Router'), fileExtension: 'tap' })
assert(getMachineLibrarySnapshot().customMachines.length === 1, 'saving an existing id updates in place')
assert(getMachineLibrarySnapshot().customMachines[0].fileExtension === 'tap', 'the update is stored')

// --- reserved ids and invalid input --------------------------------------

const reserved = saveCustomMachine({ ...structuredClone(bundledMachines()[0]) })
assert(reserved.error !== undefined, 'a bundled id cannot be saved as a custom machine')
assert(getMachineLibrarySnapshot().customMachines.length === 1, 'a rejected save changes nothing')

const invalid = saveCustomMachine({ id: 'broken' } as unknown as MachineDefinition)
assert(invalid.error !== undefined, 'an invalid definition is rejected')

// --- corrupt storage -----------------------------------------------------

const corrupt = new FakeStorage()
corrupt.setItem(CUSTOM_MACHINES_STORAGE_KEY, '{ not json')
resetMachineLibraryForTests()
initMachineLibrary(corrupt)
assert(getMachineLibrarySnapshot().customMachines.length === 0, 'corrupt storage does not break startup')
assert(getMachineLibrarySnapshot().writeBlocked, 'an unreadable envelope blocks library writes')
assert(getMachineLibrarySnapshot().diagnostics.some((entry) => entry.kind === 'machine-library-unreadable'), 'the unreadable envelope is reported')
assert(
  saveCustomMachine(custom('after-corrupt', 'After Corrupt')).error !== undefined,
  'a write is refused while the stored envelope is unreadable',
)
assert(corrupt.raw(CUSTOM_MACHINES_STORAGE_KEY) === '{ not json', 'the unreadable stored bytes are preserved unchanged')

const partial = new FakeStorage()
partial.setItem(
  CUSTOM_MACHINES_STORAGE_KEY,
  JSON.stringify({
    schemaVersion: 1,
    machines: [{ id: 'broken' }, custom('shop-router', 'Shop Router'), { id: 'broken2' }],
  }),
)
resetMachineLibraryForTests()
initMachineLibrary(partial)
assert(
  getMachineLibrarySnapshot().customMachines.length === 1,
  'invalid stored entries are skipped without dropping the valid ones',
)

const future = sanitizeStoredCustomMachines({ schemaVersion: 99, machines: [custom('shop-router', 'Shop Router')] })
assert(future.machines.length === 0 && future.unreadable, 'a future schema version yields an empty, write-blocked library')

const duplicates = sanitizeStoredCustomMachines({
  schemaVersion: 1,
  machines: [custom('shop-router', 'A'), custom('shop-router', 'B')],
})
assert(duplicates.machines.length === 2, 'distinct stored ids are both kept')
assert(duplicates.machines[1].id !== 'shop-router', 'the colliding id is re-keyed')
assert(duplicates.diagnostics.some((entry) => entry.kind === 'machine-rekeyed'), 'the re-keying is reported')

const identical = sanitizeStoredCustomMachines({
  schemaVersion: 1,
  machines: [custom('shop-router', 'Shop Router'), custom('shop-router', 'Shop Router')],
})
assert(identical.machines.length === 1, 'identical stored duplicates are consolidated')
assert(identical.diagnostics.some((entry) => entry.kind === 'machine-consolidated'), 'the consolidation is reported')

const reservedStored = sanitizeStoredCustomMachines({
  schemaVersion: 1,
  machines: [structuredClone(bundledMachines()[0])],
})
assert(reservedStored.machines.length === 1, 'a stored entry claiming a bundled id is kept, not dropped')
assert(reservedStored.machines[0].id !== bundledMachines()[0].id, 'the bundled id is re-keyed for a custom machine')
assert(reservedStored.diagnostics.some((entry) => entry.kind === 'machine-rekeyed'), 'the bundled-id rescue is reported')
assert(readStoredCustomMachines(null).machines.length === 0, 'a missing storage reads as empty')

// A machine that still breaks a #1057 template rule is structurally valid and
// must survive storage instead of being dropped (#1119).
const templateInvalid = {
  ...structuredClone(bundledMachines()[0]),
  id: 'avid-mach4',
  name: 'Avid Mach4',
  program: {
    ...structuredClone(bundledMachines()[0].program),
    header: [...bundledMachines()[0].program.header, 'G90.1'],
  },
}
const invalidValidated = validateCustomMachine(templateInvalid)
assert(invalidValidated.error === undefined, 'a template-invalid machine is accepted structurally')
const persistedInvalid = sanitizeStoredCustomMachines({ schemaVersion: 1, machines: [templateInvalid] })
assert(persistedInvalid.machines.length === 1, 'a template-invalid stored machine is kept')
assert(persistedInvalid.machines[0].program.header.at(-1) === 'G90.1', 'its template is kept unchanged')

// --- delete --------------------------------------------------------------

resetMachineLibraryForTests()
const deleteStorage = new FakeStorage()
initMachineLibrary(deleteStorage)
saveCustomMachine(custom('shop-router', 'Shop Router'))
saveCustomMachine(custom('big-red', 'Big Red'))
const deleted = deleteCustomMachine('shop-router')
assert(deleted.ok && deleted.removed, 'delete reports the removal')
assert(
  getMachineLibrarySnapshot().customMachines.map((definition) => definition.id).join() === 'big-red',
  'delete removes only the named machine',
)
const missing = deleteCustomMachine('does-not-exist')
assert(missing.ok && !missing.removed, 'deleting an unknown id is a successful no-op')
assert(getMachineLibrarySnapshot().customMachines.length === 1, 'deleting an unknown id changes nothing')
resetMachineLibraryForTests()
initMachineLibrary(deleteStorage)
assert(getMachineLibrarySnapshot().customMachines.length === 1, 'deletion is persisted')

// A blocked library must not report a delete it did not perform (#1119).
const blockedStorage = new FakeStorage()
blockedStorage.setItem(CUSTOM_MACHINES_STORAGE_KEY, '{ not json')
resetMachineLibraryForTests()
initMachineLibrary(blockedStorage)
assert(getMachineLibrarySnapshot().writeBlocked, 'the delete fixture library is write-blocked')
const blockedDelete = deleteCustomMachine('big-red')
assert(!blockedDelete.ok && !blockedDelete.removed, 'a write-blocked library refuses the delete')
assert(blockedDelete.error !== undefined, 'the refusal carries a displayable reason')
assert(getMachineLibrarySnapshot().customMachines.length === 0, 'the blocked delete left the library alone')

// A storage write failure is also a refused delete, not a silent success.
const seeded = new FakeStorage()
seeded.setItem(CUSTOM_MACHINES_STORAGE_KEY, JSON.stringify({
  schemaVersion: 1,
  machines: [custom('shop-router', 'Shop Router')],
}))
const failing = {
  getItem: (key: string): string | null => seeded.getItem(key),
  setItem: (): void => { throw new Error('QuotaExceededError') },
}
resetMachineLibraryForTests()
initMachineLibrary(failing)
assert(getMachineLibrarySnapshot().customMachines.length === 1, 'the write-failing storage reads its one machine')
const failedDelete = deleteCustomMachine('shop-router')
assert(!failedDelete.ok && !failedDelete.removed, 'a failed storage write refuses the delete')
assert(failedDelete.error !== undefined, 'the failed delete carries a reason')
assert(getMachineLibrarySnapshot().customMachines.length === 1, 'the failed delete left the in-memory library alone')

// --- legacy merge --------------------------------------------------------

resetMachineLibraryForTests()
initMachineLibrary(new FakeStorage())
const legacy = custom('shop-router', 'Shop Router')
assert(mergeCustomMachines([legacy]).added.length === 1, 'a legacy custom machine is merged in')
assert(mergeCustomMachines([structuredClone(legacy)]).added.length === 0, 'merging the same project twice adds nothing')
assert(
  mergeCustomMachines([{ ...structuredClone(legacy), fileExtension: 'tap' }]).added.length === 1,
  'a differing legacy machine with a colliding id is still kept',
)
assert(getMachineLibrarySnapshot().customMachines.length === 2, 'the re-keyed machine joins the library')
assert(mergeCustomMachines([]).added.length === 0, 'merging nothing is a no-op')
assert(
  mergeCustomMachines([structuredClone(bundledMachines()[0])]).added.length === 0,
  'a bundled definition from a legacy project library is never merged',
)

// A structurally unreadable candidate is reported by the merge, not skipped.
const badMerge = mergeCustomMachines([{ id: 'broken' } as unknown as MachineDefinition])
assert(badMerge.added.length === 0, 'an unreadable candidate is not merged')
assert(badMerge.diagnostics.some((entry) => entry.kind === 'machine-structural-error'), 'the merge reports the candidate it refused')

unsubscribe()
resetMachineLibraryForTests()

console.log('machine/store.test.ts: all assertions passed')
