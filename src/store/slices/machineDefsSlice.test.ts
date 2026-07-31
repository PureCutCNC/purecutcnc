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

import type { MachineDefinition } from '../../engine/gcode/types'
import { getActiveMachineDefinition } from '../../engine/gcode/definitions'
import { bundledMachines, validateCustomMachine } from '../../machine/registry'
import {
  deleteCustomMachine,
  initMachineLibrary,
  resetMachineLibraryForTests,
  saveCustomMachine,
} from '../../machine/store'
import { newProject } from '../../types/project'
import { useProjectStore } from '../projectStore'
import type { ProjectStore } from '../types'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function customMachine(id: string, name: string, overrides: Partial<MachineDefinition> = {}): MachineDefinition {
  const validated = validateCustomMachine({
    ...structuredClone(bundledMachines()[0]),
    id,
    name,
    ...overrides,
  })
  if (validated.error !== undefined) throw new Error(validated.error)
  return validated.ok
}

function resetStore(): void {
  useProjectStore.setState({
    project: newProject('Machine snapshot test', 'mm'),
    dirty: false,
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
}

// ── a new project embeds no machine ────────────────────────────────────────

{
  resetStore()
  const { project } = useProjectStore.getState()
  assert(project.meta.machineDefinitions.length === 0, 'a new project embeds no machine definition')
  assert(project.meta.selectedMachineId === null, 'a new project has no selected machine')
  assert(getActiveMachineDefinition(project) === null, 'export resolves no machine for a blank project')
}

// ── selecting embeds a complete validated snapshot ─────────────────────────

{
  resetStore()
  const bundled = bundledMachines()[1]
  useProjectStore.getState().setProjectMachine(bundled)

  const { project, dirty } = useProjectStore.getState()
  assert(project.meta.machineDefinitions.length === 1, 'exactly one definition is embedded')
  assert(project.meta.selectedMachineId === bundled.id, 'the selection points at the embedded snapshot')
  assert(
    project.meta.selectedMachineId === (project.meta.machineDefinitions[0]?.id ?? null),
    'the zero-or-one invariant holds',
  )
  assert(
    JSON.stringify(project.meta.machineDefinitions[0]) === JSON.stringify(bundled),
    'the snapshot is a complete copy of the chosen definition',
  )
  assert(dirty, 'selecting a machine dirties the project')
  assert(getActiveMachineDefinition(project)?.id === bundled.id, 'export resolves the embedded snapshot')
}

// ── the snapshot is a copy, not a live reference ───────────────────────────

{
  resetStore()
  const source = customMachine('shop-router', 'Shop Router')
  useProjectStore.getState().setProjectMachine(source)
  source.fileExtension = 'mutated'

  const embedded = useProjectStore.getState().project.meta.machineDefinitions[0]
  assert(embedded.fileExtension !== 'mutated', 'mutating the source cannot reach the embedded snapshot')
}

// ── replacing and clearing ────────────────────────────────────────────────

{
  resetStore()
  const first = bundledMachines()[0]
  const second = bundledMachines()[1]
  useProjectStore.getState().setProjectMachine(first)
  useProjectStore.getState().setProjectMachine(second)

  const { project } = useProjectStore.getState()
  assert(project.meta.machineDefinitions.length === 1, 'replacing keeps exactly one definition')
  assert(project.meta.selectedMachineId === second.id, 'the newest selection wins')

  useProjectStore.getState().setProjectMachine(null)
  const cleared = useProjectStore.getState().project
  assert(cleared.meta.machineDefinitions.length === 0, 'clearing empties the embedded array')
  assert(cleared.meta.selectedMachineId === null, 'clearing clears the selection')
  assert(getActiveMachineDefinition(cleared) === null, 'export is blocked again after clearing')
}

// ── re-selecting the same machine is a no-op ──────────────────────────────

{
  resetStore()
  const bundled = bundledMachines()[0]
  useProjectStore.getState().setProjectMachine(bundled)
  const afterFirst = useProjectStore.getState()
  const historyDepth = afterFirst.history.past.length

  afterFirst.setProjectMachine(structuredClone(bundled))
  assert(
    useProjectStore.getState().history.past.length === historyDepth,
    're-selecting the same definition adds no history step',
  )
  assert(
    useProjectStore.getState().project === afterFirst.project,
    're-selecting the same definition leaves the project untouched',
  )

  resetStore()
  useProjectStore.getState().setProjectMachine(null)
  assert(useProjectStore.getState().history.past.length === 0, 'clearing an empty selection adds no history step')
}

// ── selection is undoable ─────────────────────────────────────────────────

{
  resetStore()
  const bundled = bundledMachines()[0]
  useProjectStore.getState().setProjectMachine(bundled)
  useProjectStore.getState().undo()
  assert(
    useProjectStore.getState().project.meta.selectedMachineId === null,
    'undo restores the previous (empty) selection',
  )
  useProjectStore.getState().redo()
  assert(
    useProjectStore.getState().project.meta.selectedMachineId === bundled.id,
    'redo re-applies the selection',
  )
}

// ── an explicit update to a newer library copy is dirtying and undoable ────

{
  resetStore()
  const older = customMachine('shop-router', 'Shop Router')
  useProjectStore.getState().setProjectMachine(older)
  useProjectStore.setState({ dirty: false } as unknown as Partial<ProjectStore>)

  const newer = { ...structuredClone(older), fileExtension: 'tap' }
  useProjectStore.getState().setProjectMachine(newer)
  assert(useProjectStore.getState().dirty, 'updating the project copy dirties the project')
  assert(
    useProjectStore.getState().project.meta.machineDefinitions[0].fileExtension === 'tap',
    'the project copy is replaced by the newer definition',
  )
  useProjectStore.getState().undo()
  assert(
    useProjectStore.getState().project.meta.machineDefinitions[0].fileExtension === older.fileExtension,
    'undo restores the previous project copy',
  )
}

// ── library edits never touch the project snapshot ────────────────────────

{
  resetStore()
  resetMachineLibraryForTests()
  initMachineLibrary(null)

  const saved = saveCustomMachine(customMachine('shop-router', 'Shop Router'))
  assert(saved.ok !== undefined, 'the fixture machine saves into the library')
  useProjectStore.getState().setProjectMachine(saved.ok!)
  const embeddedBefore = JSON.stringify(useProjectStore.getState().project.meta.machineDefinitions[0])
  useProjectStore.setState({ dirty: false } as unknown as Partial<ProjectStore>)

  saveCustomMachine({ ...saved.ok!, fileExtension: 'tap' })
  assert(
    JSON.stringify(useProjectStore.getState().project.meta.machineDefinitions[0]) === embeddedBefore,
    'editing the library machine leaves the project snapshot alone',
  )

  deleteCustomMachine('shop-router')
  assert(
    JSON.stringify(useProjectStore.getState().project.meta.machineDefinitions[0]) === embeddedBefore,
    'removing the library machine leaves the project snapshot alone',
  )
  assert(!useProjectStore.getState().dirty, 'library changes never dirty the project')
  assert(
    useProjectStore.getState().history.past.length === 1,
    'library changes never add project history steps',
  )
  assert(
    getActiveMachineDefinition(useProjectStore.getState().project)?.id === 'shop-router',
    'a project stays exportable after its machine leaves the library',
  )

  resetMachineLibraryForTests()
}

console.log('store/slices/machineDefsSlice.test.ts: all assertions passed')
