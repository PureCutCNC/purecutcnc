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
 * The no-loss invariant for `project.meta.machineDefinitions` (#1119 slice B3).
 *
 * A sweep over every store action and load/save/restore path that rewrites the
 * project's machine list. Each path starts from a project that already carries
 * two machines (selected + retained) while the machine library is blocked, and
 * the sweep asserts neither machine disappears.
 *
 * Paths covered — add every new caller of `projectWithMachineDefinitions`, or
 * any new direct writer of `meta.machineDefinitions`, to this list:
 *
 *  - cancelSketchEdit (normalizeProject with no rescue seam)
 *  - setProjectMachine: select a replacement, clear the selection
 *  - projectWithMachine (through projectWithProjectType's type change)
 *  - setupOnlyTemplate (New-project template extraction)
 *  - createNewProject(template)
 *  - loadProject
 *  - saveProject
 *  - openProjectFromText
 *  - undo / redo
 *  - decodeProjectFormat with no rescue seam
 *  - normalizeProject with no rescue seam
 *  - a plain project edit (setProjectName), as the negative control
 *
 * Import is not in the list because `mergeCamjFolders` copies
 * `currentProject.meta` wholesale and has no machine write; a new import path
 * that does write the list belongs here.
 */

import { getActiveMachineDefinition } from '../engine/gcode/definitions'
import type { MachineDefinition } from '../engine/gcode/types'
import { bundledMachines, validateCustomMachine } from '../machine/registry'
import { CUSTOM_MACHINES_STORAGE_KEY } from '../machine/storage'
import {
  getMachineLibrarySnapshot,
  initMachineLibrary,
  resetMachineLibraryForTests,
} from '../machine/store'
import { setupOnlyTemplate } from '../components/project/newProjectTemplate'
import { machineMatchesProjectType } from './helpers/projectType'
import { projectWithProjectType } from './helpers/projectTypeApply'
import { decodeProjectFormat, normalizeProject } from './helpers/projectFormat'
import { projectWithMachine } from './slices/machineDefsSlice'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { newProject, type Project } from '../types/project'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function customMachine(id: string, name: string): MachineDefinition {
  const validated = validateCustomMachine({
    ...structuredClone(bundledMachines()[0]),
    id,
    name,
  })
  if (validated.error !== undefined) throw new Error(validated.error)
  return validated.ok
}

/** The library that cannot store anything: the stored envelope is unreadable. */
class BlockedStorage {
  private readonly map = new Map<string, string>()
  constructor() {
    this.map.set(CUSTOM_MACHINES_STORAGE_KEY, '{ not json')
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

function blockLibrary(): void {
  resetMachineLibraryForTests()
  initMachineLibrary(new BlockedStorage())
  assert(getMachineLibrarySnapshot().writeBlocked, 'the sweep runs against a blocked library')
}

const selected = customMachine('sweep-selected', 'Sweep Selected')
const other = customMachine('sweep-other', 'Sweep Other')

function twoMachineProject(): Project {
  const base = newProject('Sweep', 'mm')
  return {
    ...base,
    meta: {
      ...base.meta,
      machineDefinitions: [structuredClone(selected), structuredClone(other)],
      selectedMachineId: selected.id,
    },
  }
}

function resetStore(project: Project = twoMachineProject()): void {
  useProjectStore.setState({
    project,
    history: { past: [], future: [], transactionStart: null },
    machineLoadDiagnostics: [],
  } as unknown as Partial<ProjectStore>)
}

/** Neither retained machine may disappear, whichever one is selected. */
function assertBothMachines(project: Project, label: string): void {
  const ids = project.meta.machineDefinitions.map((definition) => definition.id)
  assert(ids.includes(selected.id), `${label}: the selected machine is still in the project (${ids.join(', ')})`)
  assert(ids.includes(other.id), `${label}: the retained machine is still in the project (${ids.join(', ')})`)
}

function savedProject(): Project {
  return JSON.parse(useProjectStore.getState().saveProject()) as Project
}

// ── blocked library: every store path keeps both machines ──────────────────

blockLibrary()

// cancelSketchEdit restores a snapshot through normalization with no rescue
// seam. This was the path that compacted two machines into one.
{
  resetStore()
  useProjectStore.setState({
    sketchEditSession: {
      entityType: 'feature',
      entityId: 'feature-in-edit',
      snapshot: twoMachineProject(),
      pastLength: 0,
    },
  } as unknown as Partial<ProjectStore>)
  useProjectStore.getState().cancelSketchEdit()
  assertBothMachines(useProjectStore.getState().project, 'cancelSketchEdit')
}

// Selecting a bundled machine must not replace the retained copies.
{
  resetStore()
  const replacement = bundledMachines().find((definition) => definition.id !== selected.id)
  if (!replacement) throw new Error('no bundled machine to select')
  useProjectStore.getState().setProjectMachine(replacement)
  const project = useProjectStore.getState().project
  assertBothMachines(project, 'setProjectMachine(replacement)')
  assert(
    project.meta.selectedMachineId === replacement.id,
    'setProjectMachine(replacement): the new machine is selected',
  )
  assert(
    getActiveMachineDefinition(project)?.id === replacement.id,
    'setProjectMachine(replacement): export resolves the newly selected machine',
  )
}

// Clearing the selection is the explicit user delete: it may remove the
// selected machine, but not the machine that is only waiting for a rescue.
{
  resetStore()
  useProjectStore.getState().setProjectMachine(null)
  const project = useProjectStore.getState().project
  assert(
    !project.meta.machineDefinitions.some((definition) => definition.id === selected.id),
    'setProjectMachine(null): the explicitly cleared machine leaves',
  )
  assert(
    project.meta.machineDefinitions.some((definition) => definition.id === other.id),
    'setProjectMachine(null): the retained machine stays',
  )
  assert(project.meta.selectedMachineId === null, 'setProjectMachine(null): the selection is cleared')
}

// The New-project dialog's type change replaces the machine through
// projectWithMachine; a blocked rescue keeps both old definitions.
{
  const project = projectWithProjectType(twoMachineProject(), 'plasma', bundledMachines())
  assertBothMachines(project, 'projectWithProjectType')
  const plasma = bundledMachines().find((definition) => machineMatchesProjectType(definition, 'plasma'))
  assert(
    plasma !== undefined && project.meta.selectedMachineId === plasma.id,
    'projectWithProjectType: the type-matching machine is selected',
  )
}

// Direct projectWithMachine, used by the New-project dialog and type changes.
{
  const replacement = bundledMachines().find((definition) => definition.id === 'grbl')
  if (!replacement) throw new Error('the grbl fixture is missing')
  assertBothMachines(projectWithMachine(twoMachineProject(), replacement), 'projectWithMachine')
}

// Template extraction and project creation.
{
  const template = setupOnlyTemplate(twoMachineProject())
  assertBothMachines(template.project, 'setupOnlyTemplate')
}
{
  resetStore(newProject('Empty', 'mm'))
  useProjectStore.getState().createNewProject(twoMachineProject())
  assertBothMachines(useProjectStore.getState().project, 'createNewProject(template)')
}

// Load, save and reopen.
{
  resetStore()
  const saved = savedProject()
  assertBothMachines(saved, 'saveProject')
}
{
  resetStore(newProject('Empty', 'mm'))
  useProjectStore.getState().loadProject(twoMachineProject())
  assertBothMachines(useProjectStore.getState().project, 'loadProject')
}
{
  resetStore()
  const text = JSON.stringify(savedProject())
  resetStore(newProject('Empty', 'mm'))
  useProjectStore.getState().openProjectFromText(text, null)
  assertBothMachines(useProjectStore.getState().project, 'openProjectFromText')
}

// History restore (undo and redo both normalize the snapshot).
{
  resetStore(newProject('Empty', 'mm'))
  useProjectStore.setState({
    history: { past: [twoMachineProject()], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  useProjectStore.getState().undo()
  assertBothMachines(useProjectStore.getState().project, 'undo')
}
{
  resetStore(newProject('Empty', 'mm'))
  useProjectStore.setState({
    history: { past: [], future: [twoMachineProject()], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  useProjectStore.getState().redo()
  assertBothMachines(useProjectStore.getState().project, 'redo')
}

// Pure normalization paths with no rescue seam.
{
  assertBothMachines(decodeProjectFormat(JSON.parse(JSON.stringify(twoMachineProject()))).project, 'decodeProjectFormat')
  assertBothMachines(normalizeProject(structuredClone(twoMachineProject())), 'normalizeProject')
}

// Negative control: a project edit that does not touch machines keeps them too.
{
  resetStore()
  useProjectStore.getState().setProjectName('Renamed')
  assertBothMachines(useProjectStore.getState().project, 'setProjectName')
}

// ── no storage at all: still not durable, so still no compaction ───────────

{
  resetMachineLibraryForTests()
  initMachineLibrary(null)
  resetStore()
  const saved = savedProject()
  assertBothMachines(saved, 'saveProject with no storage')
  assert(
    getMachineLibrarySnapshot().customMachines.length === 0,
    'no storage: the library did not pretend to store the machine',
  )

  resetStore(newProject('Empty', 'mm'))
  useProjectStore.getState().loadProject(twoMachineProject())
  assertBothMachines(useProjectStore.getState().project, 'loadProject with no storage')
}

resetMachineLibraryForTests()

console.log('store/machineDefinitionsInvariant.test.ts: all assertions passed')
