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
import { bundledMachines, machinesFunctionallyEqual, validateCustomMachine } from '../machine/registry'
import { CUSTOM_MACHINES_STORAGE_KEY } from '../machine/storage'
import {
  getMachineLibrarySnapshot,
  initMachineLibrary,
  rescueMachinesToLibrary,
  resetMachineLibraryForTests,
} from '../machine/store'
import { setupOnlyTemplate } from '../components/project/newProjectTemplate'
import { machineMatchesProjectType } from './helpers/projectType'
import { projectWithProjectType } from './helpers/projectTypeApply'
import { decodeProjectFormat, normalizeProject, type ProjectMigrationInfo } from './helpers/projectFormat'
import type { MachineRescuer } from './helpers/normalize'
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

/** A library that stores normally: the healthy counterpart of BlockedStorage. */
class HealthyStorage {
  private readonly map = new Map<string, string>()
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

function startHealthyLibrary(): void {
  resetMachineLibraryForTests()
  initMachineLibrary(new HealthyStorage())
  assert(!getMachineLibrarySnapshot().writeBlocked, 'the healthy sweep case uses a writable library')
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

/**
 * Machine content is what must survive, not the id: a collision can keep the
 * same definition under a re-keyed id, and an id-only assertion would miss the
 * content the original id no longer carries.
 */
function hasContent(definition: MachineDefinition, expected: MachineDefinition): boolean {
  return machinesFunctionallyEqual({ ...definition, id: expected.id }, expected)
}

/** Neither retained machine's content may disappear, whichever one is selected. */
function assertBothMachines(project: Project, label: string): void {
  const definitions = project.meta.machineDefinitions
  assert(
    definitions.some((definition) => hasContent(definition, selected)),
    `${label}: the selected machine's content is still in the project (${definitions.map((definition) => definition.id).join(', ')})`,
  )
  assert(
    definitions.some((definition) => hasContent(definition, other)),
    `${label}: the retained machine's content is still in the project (${definitions.map((definition) => definition.id).join(', ')})`,
  )
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

// Selecting a changed copy of the *retained* machine is not an authorized
// in-place update: the original content must survive, under a re-keyed id if
// necessary. This was the path that silently discarded the retained copy.
{
  resetStore()
  const changedOther = { ...structuredClone(other), fileExtension: 'tap' }
  useProjectStore.getState().setProjectMachine(changedOther)
  const project = useProjectStore.getState().project
  assertBothMachines(project, 'setProjectMachine(changed retained copy)')
  assert(
    project.meta.selectedMachineId === other.id,
    'setProjectMachine(changed retained copy): the changed copy is selected',
  )
  assert(
    project.meta.machineDefinitions.some(
      (definition) => definition.id === other.id && definition.fileExtension === 'tap',
    ),
    'setProjectMachine(changed retained copy): the changed copy keeps its id',
  )
}

// Updating the *selected* copy is the authorized in-place replacement: its
// content may leave without a rescue, but the retained machine still stays.
{
  resetStore()
  const changedSelected = { ...structuredClone(selected), fileExtension: 'tap' }
  useProjectStore.getState().setProjectMachine(changedSelected)
  const project = useProjectStore.getState().project
  assert(
    !project.meta.machineDefinitions.some((definition) => hasContent(definition, selected)),
    'setProjectMachine(changed selected copy): the replaced content leaves',
  )
  assert(
    project.meta.machineDefinitions.some(
      (definition) => definition.id === selected.id && definition.fileExtension === 'tap',
    ),
    'setProjectMachine(changed selected copy): the update is applied',
  )
  assert(
    project.meta.machineDefinitions.some((definition) => hasContent(definition, other)),
    'setProjectMachine(changed selected copy): the retained machine survives',
  )
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

// A changed copy of a retained machine through projectWithMachine carries the
// same no-loss rule: the retained content stays, the newcomer is selected.
{
  const changedOther = { ...structuredClone(other), fileExtension: 'tap' }
  const project = projectWithMachine(twoMachineProject(), changedOther)
  assertBothMachines(project, 'projectWithMachine(changed retained copy)')
  assert(
    project.meta.selectedMachineId === other.id,
    'projectWithMachine(changed retained copy): the changed copy is selected',
  )
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

// ── healthy library: rescue once, then compact ─────────────────────────────
//
// The retained machine is moved to My Machines exactly once. An edited bundled
// copy is re-keyed on the way, and after a durable rescue it must not stay
// embedded under its original bundled id as well. Decoding must report the
// compaction and keep the normalization diagnostics that explain it.
{
  startHealthyLibrary()
  const bundled = bundledMachines()[0]
  const editedBundled = { ...structuredClone(bundled), fileExtension: 'tap' }
  const base = newProject('Healthy rescue', 'mm')
  const file = JSON.parse(JSON.stringify({
    ...base,
    meta: {
      ...base.meta,
      machineDefinitions: [structuredClone(selected), editedBundled],
      selectedMachineId: selected.id,
    },
  })) as unknown

  let rescues = 0
  let rescuedIds: string[] = []
  const rescue: MachineRescuer = (definitions) => {
    rescues += 1
    rescuedIds = definitions.map((definition) => definition.id)
    return rescueMachinesToLibrary(definitions)
  }
  const decoded = decodeProjectFormat(file, rescue)
  const definitions = decoded.project.meta.machineDefinitions

  assert(rescues === 1, `normalization rescues exactly once (${rescues} calls)`)
  assert(
    !rescuedIds.includes(editedBundled.id),
    'normalization hands the rescue the re-keyed bundled copy, not the bundled id',
  )
  assert(
    !definitions.some((definition) => definition.id === editedBundled.id),
    'the rescued bundled copy is not embedded under its original id too',
  )
  assert(definitions.length === 1, 'a durable rescue compacts to the selected snapshot')
  assert(definitions[0]?.id === selected.id, 'the selected machine is the snapshot')
  assert(decoded.project.meta.selectedMachineId === selected.id, 'the selection is unchanged')
  assert(decoded.machineMigration.compacted, 'the compaction is reported')

  const rescuedCopy = getMachineLibrarySnapshot().customMachines.find(
    (definition) => definition.fileExtension === 'tap',
  )
  assert(
    rescuedCopy !== undefined && rescuedCopy.id !== editedBundled.id,
    'the edited bundled copy reached My Machines under a new id',
  )
  assert(
    decoded.machineMigration.diagnostics.some((entry) => entry.kind === 'machine-rekeyed'),
    'decode keeps the re-key diagnostic',
  )
  assert(
    decoded.machineMigration.diagnostics.some((entry) => entry.kind === 'machine-moved-to-library'),
    'decode keeps the move diagnostic',
  )

  // The normalization reports are what the save/open surfaces show; they must
  // still carry the move rather than being dropped on the way out.
  const info: ProjectMigrationInfo = {
    retractHeightsReexpressed: 0,
    edgeEntryStrategiesReset: 0,
    machineDiagnostics: [],
    rescuedMachineDefinitions: [],
    rescueMachineDefinitions: rescue,
  }
  normalizeProject(structuredClone(file as Project), info)
  assert(
    info.machineDiagnostics.some((entry) => entry.kind === 'machine-rekeyed'),
    'normalizeProject keeps the machine diagnostics it produced',
  )
}

resetMachineLibraryForTests()

console.log('store/machineDefinitionsInvariant.test.ts: all assertions passed')
