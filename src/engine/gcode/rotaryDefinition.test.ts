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
 * Slice A of #393: the optional `rotary` block in the machine definition and
 * the three helpers later slices code against.
 *
 * The block describes a round bar the machine can turn, either on its own
 * fourth axis (`drive: 'own'`, program word `A`) or on the motor of the other
 * horizontal axis (`drive: 'borrowed'`, program word that axis's letter, whose
 * linear travel is gone). This slice emits nothing: it only adds the
 * description plus helpers, and proves a definition without the block is
 * exactly what it was before.
 *
 * Test 1 compares each bundled definition against a frozen, pre-#393 list of
 * its top-level keys (the approach the handoff allows) rather than re-deriving
 * a rotary-less schema: `MachineDefinitionSchema` is a `superRefine` effect, so
 * `.omit()` is unavailable, and the frozen key order plus the explicit
 * "no rotary key" assertion is the same guarantee.
 */

import assert from 'node:assert/strict'
import { BUNDLED_DEFINITIONS, getActiveMachineDefinition } from './definitions'
import {
  MachineDefinitionSchema,
  rotaryBorrowedAxis,
  rotaryDirection,
  rotaryWord,
  validateMachineDefinition,
  type MachineDefinition,
  type RotaryDefinition,
} from './types'
import { newProject, type Project } from '../../types/project'
import { decodeProjectFormat } from '../../store/helpers/projectFormat'
import { useProjectStore } from '../../store/projectStore'
import type { ProjectStore } from '../../store/types'
import {
  duplicateMachineAsCustom,
  machineFieldDifferences,
  machineSnapshotStatus,
  parseMachineImport,
  serializeMachineExport,
  validateCustomMachine,
} from '../../machine/registry'
import { CUSTOM_MACHINES_SCHEMA_VERSION, sanitizeStoredCustomMachines } from '../../machine/storage'
import {
  getMachineLibrarySnapshot,
  initMachineLibrary,
  resetMachineLibraryForTests,
  saveCustomMachine,
} from '../../machine/store'

const byId = (id: string): MachineDefinition => {
  const raw = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(raw, `bundled definition ${id} exists`)
  return validateMachineDefinition(raw)
}

// A router G-code definition and the two non-router dialect cases.
const ROUTER = byId('generic')
const SHOPBOT = byId('shopbot')
const PLASMA = byId('qtplasmac')

/** Validate a base definition with a rotary block (throws on invalid input). */
function withRotary(
  base: MachineDefinition,
  rotary: unknown,
  coordinateSystem: MachineDefinition['coordinateSystem'] = base.coordinateSystem,
): MachineDefinition {
  return validateMachineDefinition({ ...structuredClone(base), rotary, coordinateSystem })
}

/** Validation issue paths and messages, for asserting exactly what failed. */
function issues(data: unknown): Array<{ path: string; message: string }> {
  const result = MachineDefinitionSchema.safeParse(data)
  if (result.success) {
    throw new Error('Assertion failed: expected validation to fail')
  }
  return result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}

const ROTARY_BORROWED: RotaryDefinition = {
  about: 'x',
  drive: 'borrowed',
  reversed: false,
  inverseTimeFeed: { on: 'G93', off: 'G94' },
}
const ROTARY_BORROWED_REVERSED: RotaryDefinition = { ...ROTARY_BORROWED, reversed: true }

// ── 1. bundled definitions are untouched ───────────────────────────────────

// The top-level key order each bundled definition produced before #393 added
// the optional field. Frozen so a future edit that inserts or moves a key
// (which would reorder a saved snapshot) fails here.
const PRE_393_KEY_ORDER: Record<string, string[]> = {
  generic: ['id', 'name', 'description', 'builtin', 'fileExtension', 'coordinateSystem', 'numberFormat', 'units', 'program', 'workCoordinates', 'motion', 'feedSpeed', 'toolChange', 'cannedCycles', 'coolant', 'stop'],
  grbl: ['id', 'name', 'description', 'builtin', 'fileExtension', 'coordinateSystem', 'numberFormat', 'units', 'program', 'workCoordinates', 'motion', 'feedSpeed', 'toolChange', 'cannedCycles', 'coolant', 'stop'],
  grblhal: ['id', 'name', 'description', 'builtin', 'fileExtension', 'coordinateSystem', 'numberFormat', 'units', 'program', 'workCoordinates', 'motion', 'feedSpeed', 'toolChange', 'cannedCycles', 'coolant', 'stop'],
  mach3: ['id', 'name', 'description', 'builtin', 'fileExtension', 'coordinateSystem', 'numberFormat', 'units', 'program', 'workCoordinates', 'motion', 'feedSpeed', 'toolChange', 'cannedCycles', 'coolant', 'stop'],
  uccnc: ['id', 'name', 'description', 'builtin', 'fileExtension', 'coordinateSystem', 'numberFormat', 'units', 'program', 'workCoordinates', 'motion', 'feedSpeed', 'toolChange', 'cannedCycles', 'coolant', 'stop'],
  linuxcnc: ['id', 'name', 'description', 'builtin', 'fileExtension', 'coordinateSystem', 'numberFormat', 'units', 'program', 'workCoordinates', 'motion', 'feedSpeed', 'toolChange', 'cannedCycles', 'coolant', 'stop'],
  shopbot: ['id', 'name', 'description', 'vendor', 'builtin', 'fileExtension', 'outputDialect', 'coordinateSystem', 'numberFormat', 'units', 'program', 'workCoordinates', 'motion', 'feedSpeed', 'toolChange', 'cannedCycles', 'coolant', 'stop'],
  qtplasmac: ['id', 'name', 'description', 'vendor', 'builtin', 'fileExtension', 'machineKind', 'plasma', 'coordinateSystem', 'numberFormat', 'units', 'program', 'workCoordinates', 'motion', 'feedSpeed', 'toolChange', 'cannedCycles', 'coolant', 'stop'],
  'grbl-plasma': ['id', 'name', 'description', 'vendor', 'builtin', 'fileExtension', 'machineKind', 'plasma', 'coordinateSystem', 'numberFormat', 'units', 'program', 'workCoordinates', 'motion', 'feedSpeed', 'toolChange', 'cannedCycles', 'coolant', 'stop'],
}

for (const raw of BUNDLED_DEFINITIONS) {
  const validated = validateMachineDefinition(raw)
  assert.ok(!('rotary' in validated), `${validated.id} validates without a rotary key`)
  const expected = PRE_393_KEY_ORDER[validated.id]
  assert.ok(expected, `${validated.id} has a frozen pre-#393 key-order baseline`)
  assert.deepEqual(Object.keys(validated), expected, `${validated.id} keeps its pre-#393 key order`)
}
assert.equal(
  Object.keys(PRE_393_KEY_ORDER).length,
  BUNDLED_DEFINITIONS.length,
  'every bundled definition has a frozen baseline — none was added without updating it',
)

// ── 2. the block round-trips, with its defaults ────────────────────────────

for (const about of ['x', 'y'] as const) {
  for (const drive of ['own', 'borrowed'] as const) {
    const parsed = withRotary(ROUTER, { about, drive })
    assert.deepEqual(parsed.rotary, { about, drive, reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } }, `${about}/${drive}: defaults are filled`)
    const again = validateMachineDefinition(JSON.parse(JSON.stringify(parsed)))
    assert.deepEqual(again.rotary, parsed.rotary, `${about}/${drive}: the block round-trips through validation`)
  }
}

const explicitNull = withRotary(ROUTER, { about: 'x', drive: 'own', inverseTimeFeed: null })
assert.equal(explicitNull.rotary?.inverseTimeFeed, null, 'an explicit null stays null')

const explicitFeed = withRotary(ROUTER, {
  about: 'x',
  drive: 'own',
  reversed: true,
  inverseTimeFeed: { on: 'G93.1', off: 'G94.1' },
})
assert.deepEqual(
  explicitFeed.rotary,
  { about: 'x', drive: 'own', reversed: true, inverseTimeFeed: { on: 'G93.1', off: 'G94.1' } },
  'explicit commands and reversed round-trip',
)

for (const feed of [{ on: '  ', off: 'G94' }, { on: 'G93', off: '\t' }, { on: '', off: 'G94' }]) {
  assert.equal(
    MachineDefinitionSchema.safeParse({ ...ROUTER, rotary: { about: 'x', drive: 'own', inverseTimeFeed: feed } }).success,
    false,
    `a blank inverse-time command is refused: ${JSON.stringify(feed)}`,
  )
}

// ── 3. rotaryWord ──────────────────────────────────────────────────────────

assert.equal(rotaryWord(ROUTER), null, 'no block means no rotary word')
assert.equal(rotaryWord(withRotary(ROUTER, { about: 'x', drive: 'own' })), 'A', 'its own axis uses A')
assert.equal(rotaryWord(withRotary(ROUTER, { about: 'y', drive: 'own' })), 'A', 'its own axis uses A whatever the bar lies along')
assert.equal(rotaryWord(withRotary(ROUTER, { about: 'x', drive: 'borrowed' })), 'Y', 'a bar along project X borrows the project Y output')
assert.equal(rotaryWord(withRotary(ROUTER, { about: 'y', drive: 'borrowed' })), 'X', 'a bar along project Y borrows the project X output')
assert.equal(
  rotaryWord(withRotary(ROUTER, { about: 'x', drive: 'borrowed' }, { ...ROUTER.coordinateSystem, yAxis: '-X' })),
  'X',
  'a non-identity coordinate system is followed and its sign stripped',
)

// ── 4. rotaryBorrowedAxis and rotaryDirection ──────────────────────────────

assert.equal(rotaryBorrowedAxis(ROUTER), null, 'no block borrows no axis')
assert.equal(rotaryBorrowedAxis(withRotary(ROUTER, { about: 'x', drive: 'own' })), null, 'its own axis borrows no linear travel')
assert.equal(rotaryBorrowedAxis(withRotary(ROUTER, { about: 'x', drive: 'borrowed' })), 'y', 'a bar along X borrows project Y')
assert.equal(rotaryBorrowedAxis(withRotary(ROUTER, { about: 'y', drive: 'borrowed' })), 'x', 'a bar along Y borrows project X')

assert.equal(rotaryDirection(ROUTER), 1, 'no block has no direction')
assert.equal(rotaryDirection(withRotary(ROUTER, { about: 'x', drive: 'own' })), 1)
assert.equal(rotaryDirection(withRotary(ROUTER, { about: 'x', drive: 'own', reversed: true })), -1, 'reversed flips its own axis')
assert.equal(
  rotaryDirection(withRotary(ROUTER, { about: 'x', drive: 'own', reversed: true }, { ...ROUTER.coordinateSystem, yAxis: '-Y' })),
  -1,
  'its own axis ignores the coordinate-system sign',
)
assert.equal(rotaryDirection(withRotary(ROUTER, { about: 'x', drive: 'borrowed' })), 1)
assert.equal(
  rotaryDirection(withRotary(ROUTER, { about: 'x', drive: 'borrowed' }, { ...ROUTER.coordinateSystem, yAxis: '-Y' })),
  -1,
  'a negative borrowed output reverses the rotation',
)
assert.equal(
  rotaryDirection(withRotary(ROUTER, { about: 'x', drive: 'borrowed', reversed: true }, { ...ROUTER.coordinateSystem, yAxis: '-Y' })),
  1,
  'reversed on a negative output is a double negative',
)
assert.equal(
  rotaryDirection(withRotary(ROUTER, { about: 'y', drive: 'borrowed' }, { ...ROUTER.coordinateSystem, xAxis: '-X' })),
  -1,
  'the bar-along-Y case reads the X output',
)

// ── 5. the three refusals, and a plain router accepted ─────────────────────

assert.deepEqual(
  issues({ ...SHOPBOT, rotary: { about: 'x', drive: 'own' } }),
  [{ path: 'rotary', message: 'A rotary axis requires the G-code output dialect.' }],
  'an opensbp machine cannot have a rotary block',
)
assert.deepEqual(
  issues({ ...PLASMA, rotary: { about: 'x', drive: 'own' } }),
  [{ path: 'rotary', message: 'A plasma machine cannot have a rotary axis.' }],
  'a plasma machine cannot have a rotary block',
)
assert.deepEqual(
  issues({ ...ROUTER, rotary: { about: 'x', drive: 'borrowed' }, coordinateSystem: { ...ROUTER.coordinateSystem, yAxis: 'Z' } }),
  [{ path: 'rotary.drive', message: 'The rotary cannot borrow the Z motor.' }],
  'a borrowed Z motor is refused',
)
assert.deepEqual(
  issues({ ...ROUTER, rotary: { about: 'y', drive: 'borrowed' }, coordinateSystem: { ...ROUTER.coordinateSystem, xAxis: '-Z' } }),
  [{ path: 'rotary.drive', message: 'The rotary cannot borrow the Z motor.' }],
  'a borrowed -Z motor is refused',
)
assert.equal(
  MachineDefinitionSchema.safeParse({ ...ROUTER, rotary: { about: 'x', drive: 'borrowed' } }).success,
  true,
  'a router G-code machine accepts a rotary block',
)

// ── 6. an embedded machine survives project save/load ──────────────────────

const machineResult = validateCustomMachine({
  ...structuredClone(ROUTER),
  id: 'rotary-router',
  name: 'Rotary Router',
  rotary: ROTARY_BORROWED_REVERSED,
})
assert.equal(machineResult.error, undefined, 'the test machine validates')
const machine = machineResult.ok

// The decode path the #956 plasma tests use.
const embeddedProject = newProject('Rotary snapshot', 'mm')
embeddedProject.meta.machineDefinitions = [machine]
embeddedProject.meta.selectedMachineId = machine.id
const decoded = decodeProjectFormat(JSON.parse(JSON.stringify(embeddedProject)))
// Compared with the literal so that a format bump on both sides cannot pass:
// the decoded project must be exactly the version this build writes.
assert.equal(decoded.project.version, '3.3', 'the project format stays 3.3')
assert.deepEqual(
  getActiveMachineDefinition(decoded.project)?.rotary,
  ROTARY_BORROWED_REVERSED,
  'open preserves the embedded rotary block',
)

// The store save/load path the machine-snapshot tests use.
resetMachineLibraryForTests()
initMachineLibrary(null)
useProjectStore.setState({
  project: newProject('Rotary round trip', 'mm'),
  history: { past: [], future: [], transactionStart: null },
} as unknown as Partial<ProjectStore>)
useProjectStore.getState().setProjectMachine(machine)
const saved = JSON.parse(useProjectStore.getState().saveProject()) as Project
assert.equal(saved.meta.machineDefinitions.length, 1, 'the saved file stores exactly one definition')
assert.deepEqual(saved.meta.machineDefinitions[0].rotary, ROTARY_BORROWED_REVERSED, 'the saved snapshot keeps the block')
const reopened = decodeProjectFormat(saved)
assert.deepEqual(reopened.project.meta.machineDefinitions[0].rotary, ROTARY_BORROWED_REVERSED, 'the reopened project keeps the block')

// ── 7. the machine library path keeps the block ────────────────────────────

const saveResult = saveCustomMachine(machine)
assert.equal(saveResult.error, undefined, 'the library accepts a machine with a rotary block')
assert.deepEqual(getMachineLibrarySnapshot().customMachines[0].rotary, ROTARY_BORROWED_REVERSED, 'My Machines keeps the block')

const stored = sanitizeStoredCustomMachines({ schemaVersion: CUSTOM_MACHINES_SCHEMA_VERSION, machines: [machine] })
assert.deepEqual(stored[0]?.rotary, ROTARY_BORROWED_REVERSED, 'persisted custom machines keep the block')

const imported = parseMachineImport(serializeMachineExport(machine), [])
assert.equal(imported.error, undefined, 'an exported machine imports back')
assert.deepEqual(imported.ok.rotary, ROTARY_BORROWED_REVERSED, 'machine export/import keeps the block')

const duplicate = duplicateMachineAsCustom(machine, [machine])
assert.deepEqual(duplicate.rotary, ROTARY_BORROWED_REVERSED, 'duplicate keeps the block')

// The embedded-versus-library comparison sees the block.
const twin = validateMachineDefinition({ ...structuredClone(machine), builtin: false })
assert.equal(machineSnapshotStatus(machine, [twin]).kind, 'in-sync', 'an identical rotary block is in sync')
const edited = validateMachineDefinition({ ...structuredClone(machine), rotary: { ...ROTARY_BORROWED_REVERSED, reversed: false } })
assert.equal(machineSnapshotStatus(machine, [edited]).kind, 'update-available', 'a changed rotary block is an available update')
assert.deepEqual(machineFieldDifferences(machine, edited), ['rotary'], 'the rotary block is reported as the changed field')

// Test seam: leave the module-level library as the next suite expects it.
resetMachineLibraryForTests()

console.log('engine/gcode/rotaryDefinition.test.ts: all assertions passed')
