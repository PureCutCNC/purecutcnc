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

assert(
  sanitizeStoredCustomMachines({ schemaVersion: 99, machines: [custom('shop-router', 'Shop Router')] }).length === 0,
  'a future schema version yields an empty library',
)
assert(
  sanitizeStoredCustomMachines({
    schemaVersion: 1,
    machines: [custom('shop-router', 'A'), custom('shop-router', 'B')],
  }).length === 1,
  'duplicate stored ids are dropped',
)
assert(
  sanitizeStoredCustomMachines({ schemaVersion: 1, machines: [structuredClone(bundledMachines()[0])] }).length === 0,
  'a stored entry claiming a bundled id is dropped',
)
assert(readStoredCustomMachines(null).length === 0, 'a missing storage reads as empty')

// --- delete --------------------------------------------------------------

resetMachineLibraryForTests()
const deleteStorage = new FakeStorage()
initMachineLibrary(deleteStorage)
saveCustomMachine(custom('shop-router', 'Shop Router'))
saveCustomMachine(custom('big-red', 'Big Red'))
deleteCustomMachine('shop-router')
assert(
  getMachineLibrarySnapshot().customMachines.map((definition) => definition.id).join() === 'big-red',
  'delete removes only the named machine',
)
deleteCustomMachine('does-not-exist')
assert(getMachineLibrarySnapshot().customMachines.length === 1, 'deleting an unknown id is a no-op')
resetMachineLibraryForTests()
initMachineLibrary(deleteStorage)
assert(getMachineLibrarySnapshot().customMachines.length === 1, 'deletion is persisted')

// --- legacy merge --------------------------------------------------------

resetMachineLibraryForTests()
initMachineLibrary(new FakeStorage())
const legacy = custom('shop-router', 'Shop Router')
assert(mergeCustomMachines([legacy]).length === 1, 'a legacy custom machine is merged in')
assert(mergeCustomMachines([structuredClone(legacy)]).length === 0, 'merging the same project twice adds nothing')
assert(
  mergeCustomMachines([{ ...structuredClone(legacy), fileExtension: 'tap' }]).length === 1,
  'a differing legacy machine with a colliding id is still kept',
)
assert(getMachineLibrarySnapshot().customMachines.length === 2, 'the re-keyed machine joins the library')
assert(mergeCustomMachines([]).length === 0, 'merging nothing is a no-op')
assert(
  mergeCustomMachines([structuredClone(bundledMachines()[0])]).length === 0,
  'a bundled definition from a legacy project library is never merged',
)

unsubscribe()
resetMachineLibraryForTests()

console.log('machine/store.test.ts: all assertions passed')
