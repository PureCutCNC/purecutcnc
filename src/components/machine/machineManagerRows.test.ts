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
 * The machine manager's row model (#1119). Run with:
 *   npx tsx src/components/machine/machineManagerRows.test.ts
 *
 * The case that matters is a project copy that still breaks a template rule
 * while the library has an entry with the *same id*: the manager must offer a
 * row for the project's copy, or there is nothing to repair.
 */

import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import type { MachineDefinition } from '../../engine/gcode/types'
import {
  buildMachineManagerRows,
  defaultMachineManagerKey,
  machineManagerRowKey,
} from './machineManagerRows'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const grbl = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')
assert(grbl !== undefined, 'the build ships GRBL')
const library = [structuredClone(grbl)]

function withHeader(definition: MachineDefinition, header: string[]): MachineDefinition {
  const copy = structuredClone(definition)
  copy.program.header = header
  return copy
}

// --- an identical project copy needs no extra row ------------------------

{
  const rows = buildMachineManagerRows(library, structuredClone(grbl))
  assert(rows.length === 1, 'an identical project copy adds no row')
  assert(rows[0].key === 'library:grbl', 'the library row keeps its prefixed key')
  assert(rows[0].diagnostics.length === 0, 'a valid machine has no diagnostics')
}

// --- a valid project-only copy is listed -------------------------------

{
  const custom = { ...structuredClone(grbl), id: 'shop-router', name: 'Shop Router', builtin: false }
  const rows = buildMachineManagerRows(library, custom)
  assert(rows.length === 2, 'a project-only machine gets its own row')
  assert(rows[1].key === 'project:shop-router', 'the project row is keyed separately')
  assert(rows[1].projectCopy, 'the row says it is the project copy')
  assert(rows[1].diagnostics.length === 0, 'a valid project-only machine has no diagnostics')
}

// --- a library entry that is itself invalid carries its diagnostics ------

{
  const invalidLibrary = withHeader(
    { ...structuredClone(grbl), id: 'shop-router', name: 'Shop Router', builtin: false },
    ['G90.1'],
  )
  const rows = buildMachineManagerRows([invalidLibrary], null)
  assert(rows.length === 1, 'the library entry is listed')
  assert(
    rows[0].diagnostics.some((entry) => entry.word === 'G90.1'),
    'an invalid library machine carries its diagnostics too',
  )
}

// --- the same id with an invalid project copy gets a repair row ----------

{
  const invalid = withHeader({ ...structuredClone(grbl), builtin: true }, ['G90', 'G90.1'])
  const rows = buildMachineManagerRows(library, invalid)
  assert(rows.length === 2, 'the invalid project copy is listed beside the library entry')
  assert(rows[0].key === 'library:grbl', 'the library entry is still first')
  assert(rows[1].key === 'project:grbl', 'the project row is keyed by its own prefix')
  assert(rows[1].projectCopy, 'the second row is the project copy')
  assert(
    rows[1].diagnostics.some((entry) => entry.word === 'G90.1' && entry.line === 2),
    `the project row carries the line-level diagnostic: ${JSON.stringify(rows[1].diagnostics)}`,
  )
  assert(
    machineManagerRowKey(invalid, true) !== machineManagerRowKey(grbl, false),
    'the two rows sharing an id still have different keys',
  )
  assert(
    new Set(rows.map((row) => row.key)).size === rows.length,
    'every row key is unique',
  )
}

// --- default selection prefers the project row, focus prefers the library --

{
  const invalid = withHeader(structuredClone(grbl), ['G90.1'])
  const rows = buildMachineManagerRows(library, invalid)
  assert(
    defaultMachineManagerKey(rows, null) === 'project:grbl',
    'the manager opens on the invalid project copy so it is visible',
  )
  assert(
    defaultMachineManagerKey(rows, 'grbl') === 'library:grbl',
    'the update notice focuses the library copy',
  )
  assert(
    defaultMachineManagerKey(buildMachineManagerRows(library, null), null) === 'library:grbl',
    'with no project machine the first library row is selected',
  )
}

console.log('machine manager row model tests passed')
