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
 * Project machine-snapshot format behavior: legacy libraries compact to the
 * single selected definition, custom machines migrate into the application
 * library instead of being lost, and export keeps resolving the embedded
 * copy regardless of what the local library holds.
 */

import { getActiveMachineDefinition } from '../engine/gcode/definitions'
import { runPostProcessor } from '../engine/gcode/postprocessor'
import type { MachineDefinition } from '../engine/gcode/types'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import { bundledMachines, validateCustomMachine } from '../machine/registry'
import {
  getMachineLibrarySnapshot,
  initMachineLibrary,
  resetMachineLibraryForTests,
  saveCustomMachine,
} from '../machine/store'
import { LATEST_PROJECT_VERSION, defaultTool, newProject, type Operation, type Project } from '../types/project'
import { decodeProjectFormat } from './helpers/projectFormat'
import { MachineLoadError } from '../machine/diagnostics'
import { inspectCamjString } from '../import/camj'
import { setupOnlyTemplate } from '../components/project/newProjectTemplate'
import { instantiateProjectTemplate } from './helpers/normalize'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertThrows(fn: () => void, message: string): void {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(`Assertion failed: ${message}`)
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

/** A stored 3.0 file that still carries a whole machine library. */
function legacyLibraryFile(
  definitions: MachineDefinition[],
  selectedMachineId: string | null,
): unknown {
  const project = newProject('Legacy library', 'mm')
  return JSON.parse(JSON.stringify({
    ...project,
    meta: { ...project.meta, machineDefinitions: definitions, selectedMachineId },
  }))
}

function freshLibrary(): void {
  resetMachineLibraryForTests()
  initMachineLibrary(null)
}

// ── a stored library compacts to the selected definition ───────────────────

{
  freshLibrary()
  const custom = customMachine('shop-router', 'Shop Router')
  const file = legacyLibraryFile([...bundledMachines(), custom], 'mach3')
  const decoded = decodeProjectFormat(file)

  assert(decoded.project.meta.machineDefinitions.length === 1, 'only one definition survives decode')
  assert(decoded.project.meta.selectedMachineId === 'mach3', 'the selection is preserved')
  assert(decoded.project.meta.machineDefinitions[0].id === 'mach3', 'the embedded snapshot is the selected one')
  assert(decoded.machineMigration.compacted, 'the compaction is reported')
  assert(
    decoded.machineMigration.customDefinitions.map((definition) => definition.id).join() === 'shop-router',
    'only the custom definition is offered to the library — bundled copies are dropped',
  )
  assert(decoded.machineMigration.unresolvedSelectionId === null, 'a resolvable selection reports no problem')
}

// ── the selected definition is preserved verbatim ─────────────────────────

{
  freshLibrary()
  // A project-local edit of a bundled machine must survive untouched, even
  // though the build ships a different definition under the same ID.
  const edited = { ...structuredClone(bundledMachines()[0]), fileExtension: 'tap' }
  const file = legacyLibraryFile([edited, ...bundledMachines().slice(1)], edited.id)
  const decoded = decodeProjectFormat(file)

  assert(
    decoded.project.meta.machineDefinitions[0].fileExtension === 'tap',
    'the stored snapshot is preserved verbatim, not refreshed from the build',
  )
}

// ── legacy custom machines migrate into My Machines ───────────────────────

{
  freshLibrary()
  const custom = customMachine('shop-router', 'Shop Router')
  const other = customMachine('big-red', 'Big Red')
  const file = legacyLibraryFile([...bundledMachines(), custom, other], 'shop-router')

  useProjectStore.getState().openProjectFromText(JSON.stringify(file), null)
  const state = useProjectStore.getState()

  assert(state.project.meta.selectedMachineId === 'shop-router', 'the selected custom machine stays selected')
  assert(state.project.meta.machineDefinitions.length === 1, 'the project keeps a single embedded snapshot')
  assert(
    getMachineLibrarySnapshot().customMachines.map((definition) => definition.id).sort().join() === 'big-red,shop-router',
    'both custom machines migrate into My Machines',
  )
  assert(state.dirty, 'a compacted project is marked dirty so the change is saved deliberately')
  assert(state.loadWarning !== null, 'the compaction is reported to the user')

  // Re-opening the same file must not duplicate the library entries.
  useProjectStore.getState().openProjectFromText(JSON.stringify(file), null)
  assert(
    getMachineLibrarySnapshot().customMachines.length === 2,
    're-opening the same project adds nothing to My Machines',
  )
}

// ── an unresolvable selection is cleared and reported ─────────────────────

{
  freshLibrary()
  const file = legacyLibraryFile([...bundledMachines()], 'no-such-machine')
  useProjectStore.getState().openProjectFromText(JSON.stringify(file), null)
  const state = useProjectStore.getState()

  assert(state.project.meta.selectedMachineId === null, 'an unresolvable selection is cleared')
  assert(state.project.meta.machineDefinitions.length === 0, 'nothing is embedded when the selection is invalid')
  assert(
    (state.loadWarning ?? '').includes('no-such-machine'),
    'the load warning names the machine that could not be resolved',
  )
}

// ── a clean project opens silently ────────────────────────────────────────

{
  freshLibrary()
  const file = legacyLibraryFile([bundledMachines()[0]], bundledMachines()[0].id)
  useProjectStore.getState().openProjectFromText(JSON.stringify(file), null)
  const state = useProjectStore.getState()

  assert(!state.dirty, 'an already-compact project is not dirtied on open')
  assert(state.loadWarning === null, 'an already-compact project produces no warning')
}

// ── pre-3.0 machineId / customMachineDefinition ───────────────────────────

{
  freshLibrary()
  const base = newProject('Legacy meta', 'mm') as Project & { meta: Record<string, unknown> }
  const legacyMeta = JSON.parse(JSON.stringify({
    ...base,
    version: '2.1',
    meta: { ...base.meta, machineDefinitions: undefined, machineId: 'grbl' },
  }))
  const decoded = decodeProjectFormat(legacyMeta)
  assert(decoded.project.meta.selectedMachineId === 'grbl', 'a legacy machineId resolves to the bundled machine')
  assert(
    decoded.project.meta.machineDefinitions[0]?.id === 'grbl',
    'the resolved bundled machine is embedded as the snapshot',
  )

  const custom = customMachine('shop-router', 'Shop Router')
  const legacyCustom = JSON.parse(JSON.stringify({
    ...base,
    version: '2.1',
    meta: { ...base.meta, machineDefinitions: undefined, machineId: 'grbl', customMachineDefinition: custom },
  }))
  const decodedCustom = decodeProjectFormat(legacyCustom)
  assert(
    decodedCustom.project.meta.selectedMachineId === 'shop-router',
    'a legacy inline custom definition wins over machineId',
  )
  assert(
    decodedCustom.machineMigration.customDefinitions.length === 1,
    'the legacy inline custom definition is offered to My Machines',
  )

  const unknownId = JSON.parse(JSON.stringify({
    ...base,
    version: '2.1',
    meta: { ...base.meta, machineDefinitions: undefined, machineId: 'gone' },
  }))
  const decodedUnknown = decodeProjectFormat(unknownId)
  assert(decodedUnknown.project.meta.selectedMachineId === null, 'an unknown legacy machineId clears the selection')
  assert(decodedUnknown.machineMigration.unresolvedSelectionId === 'gone', 'the unknown legacy id is reported')
}

// ── save round trip keeps the zero-or-one invariant ───────────────────────

{
  freshLibrary()
  const custom = customMachine('shop-router', 'Shop Router')
  useProjectStore.setState({
    project: newProject('Round trip', 'mm'),
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  useProjectStore.getState().setProjectMachine(custom)

  const saved = JSON.parse(useProjectStore.getState().saveProject()) as Project
  assert(saved.meta.machineDefinitions.length === 1, 'the saved file stores exactly one definition')
  assert(
    saved.meta.selectedMachineId === (saved.meta.machineDefinitions[0]?.id ?? null),
    'the saved file satisfies the zero-or-one invariant',
  )
  assert(saved.version === LATEST_PROJECT_VERSION, 'the compact snapshot stays on the current format')

  const reopened = decodeProjectFormat(saved)
  assert(
    JSON.stringify(reopened.project.meta.machineDefinitions) === JSON.stringify(saved.meta.machineDefinitions),
    'the snapshot round trips unchanged',
  )
  assert(!reopened.machineMigration.compacted, 'a round-tripped project needs no further compaction')

  useProjectStore.getState().setProjectMachine(null)
  const cleared = JSON.parse(useProjectStore.getState().saveProject()) as Project
  assert(cleared.meta.machineDefinitions.length === 0, 'clearing the selection saves an empty array')
  assert(cleared.meta.selectedMachineId === null, 'clearing the selection saves a null id')
}

// ── templates ────────────────────────────────────────────────────────────

{
  freshLibrary()
  const blank = newProject('Blank', 'mm')
  assert(blank.meta.machineDefinitions.length === 0, 'a blank template embeds no machine')
  assert(blank.meta.selectedMachineId === null, 'a blank template selects no machine')

  useProjectStore.setState({
    project: newProject('Template source', 'mm'),
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  useProjectStore.getState().setProjectMachine(bundledMachines()[1])
  const template = instantiateProjectTemplate(useProjectStore.getState().project, 'From current')
  assert(template.meta.machineDefinitions.length === 1, 'a current-project template carries only its snapshot')
  assert(
    template.meta.selectedMachineId === bundledMachines()[1].id,
    'a current-project template keeps the selected machine',
  )

  const fromBlank = instantiateProjectTemplate(undefined, 'Blank again')
  assert(fromBlank.meta.machineDefinitions.length === 0, 'a template-less new project embeds no machine')
}

// ── export resolves the embedded snapshot, library or not ─────────────────

{
  const gcodeFor = (project: Project): string => {
    const definition = getActiveMachineDefinition(project)
    assert(definition !== null, 'the export fixture has an embedded machine')
    const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }
    const withTool = { ...project, tools: [toolRecord] }
    const operation = {
      id: 'op1',
      name: 'Pocket',
      kind: 'pocket',
      pass: 'rough',
      enabled: true,
      showToolpath: true,
      debugToolpath: false,
      target: { source: 'stock' },
      toolRef: toolRecord.id,
      stepdown: 1,
      stepover: 0.4,
      feed: 600,
      plungeFeed: 180,
      rpm: 12000,
    } as unknown as Operation
    return runPostProcessor({
      project: withTool,
      definition: definition!,
      operations: [{
        operation,
        tool: normalizeToolForProject(toolRecord, withTool),
        toolpath: {
          operationId: operation.id,
          warnings: [],
          bounds: null,
          moves: [
            { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 1, y: 1, z: 5 } },
            { kind: 'cut', from: { x: 1, y: 1, z: 5 }, to: { x: 2, y: 1, z: 0 } },
          ],
        },
      }],
      options: { emitToolChanges: true, emitCoolant: false, programName: 'Export regression' },
    }).gcode
  }

  const custom = customMachine('shop-router', 'Shop Router')

  // Author's machine: the definition is in the local library.
  freshLibrary()
  saveCustomMachine(custom)
  useProjectStore.setState({
    project: newProject('Export regression', 'mm'),
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  useProjectStore.getState().setProjectMachine(custom)
  const authored = useProjectStore.getState().saveProject()
  const authorGcode = gcodeFor(JSON.parse(authored) as Project)

  // Recipient's machine: same file, empty library.
  freshLibrary()
  const received = decodeProjectFormat(JSON.parse(authored))
  assert(
    getMachineLibrarySnapshot().customMachines.length === 0,
    'the recipient does not have the machine in My Machines',
  )
  assert(getActiveMachineDefinition(received.project)?.id === 'shop-router', 'the embedded snapshot still resolves')
  assert(gcodeFor(received.project) === authorGcode, 'the recipient generates byte-identical G-code')
}

// ── a template-invalid snapshot is kept, selected and diagnosed ─────────────

function invalidMachine(id: string, name: string): MachineDefinition {
  const base = customMachine(id, name)
  return {
    ...base,
    program: { ...base.program, header: [...base.program.header, 'G90.1'] },
  }
}

{
  freshLibrary()
  const invalid = invalidMachine('avid-mach4', 'Avid Mach4')
  const file = legacyLibraryFile([invalid], invalid.id)
  const decoded = decodeProjectFormat(file)

  assert(decoded.project.meta.selectedMachineId === 'avid-mach4', 'a template-invalid machine stays selected')
  assert(
    decoded.project.meta.machineDefinitions[0]?.program.header.at(-1) === 'G90.1',
    'its template line is kept unchanged',
  )
  const retained = decoded.machineMigration.diagnostics.find((entry) => entry.kind === 'machine-retained-invalid')
  assert(retained !== undefined, 'the retained-invalid machine is reported')
  assert(
    retained !== undefined && (retained.templateDiagnostics ?? []).some((entry) => entry.word === 'G90.1'),
    'the report carries the line-level template diagnostics',
  )

  useProjectStore.getState().openProjectFromText(JSON.stringify(file), null)
  const state = useProjectStore.getState()
  assert(state.project.meta.selectedMachineId === 'avid-mach4', 'the open project keeps the machine selected')
  assert(
    (state.loadWarning ?? '').includes('Avid Mach4') && (state.loadWarning ?? '').includes('export is blocked'),
    `the load warning names the machine and the export block: ${state.loadWarning}`,
  )
  assert(
    state.machineLoadDiagnostics.some((entry) => entry.kind === 'machine-retained-invalid'),
    'the structured diagnostics are exposed for the UI',
  )
}

// ── unselected machines are rescued, re-keyed and reported ─────────────────

{
  freshLibrary()
  const selected = bundledMachines()[2]
  const invalidCustom = invalidMachine('avid-mach4', 'Avid Mach4')
  const editedBundled = { ...structuredClone(bundledMachines()[0]), fileExtension: 'tap' }
  const file = legacyLibraryFile([selected, invalidCustom, editedBundled], selected.id)
  const decoded = decodeProjectFormat(file)
  const rescued = decoded.machineMigration.customDefinitions

  assert(
    rescued.some((definition) => definition.id === 'avid-mach4'),
    'an unselected template-invalid custom machine is rescued unchanged',
  )
  const edited = rescued.find((definition) => definition.fileExtension === 'tap')
  assert(edited !== undefined, 'an unselected edited bundled copy is rescued')
  assert(edited?.id !== editedBundled.id, 'the rescued bundled copy is re-keyed away from the built-in id')
  assert(
    decoded.machineMigration.diagnostics.some((entry) => entry.kind === 'machine-rekeyed'),
    'the re-keying is reported',
  )

  useProjectStore.getState().openProjectFromText(JSON.stringify(file), null)
  const libraryIds = getMachineLibrarySnapshot().customMachines.map((definition) => definition.id)
  assert(libraryIds.includes('avid-mach4'), 'the invalid custom machine reaches My Machines')
  assert(libraryIds.includes(edited!.id), 'the re-keyed bundled copy reaches My Machines')
}

{
  freshLibrary()
  const selected = bundledMachines()[2]
  const first = customMachine('duplicate-id', 'First')
  const second = { ...customMachine('duplicate-id', 'Second') }
  const file = legacyLibraryFile([selected, first, second], selected.id)
  const decoded = decodeProjectFormat(file)
  const ids = decoded.machineMigration.customDefinitions.map((definition) => definition.id)

  assert(ids.includes('duplicate-id'), 'the first distinct definition keeps its id')
  assert(ids.filter((id) => id !== 'duplicate-id').length === 1, 'the colliding distinct definition is kept under a new id')
  assert(
    decoded.machineMigration.diagnostics.some((entry) => entry.kind === 'machine-rekeyed'),
    'the collision is reported',
  )
}

// ── structural corruption and ambiguity refuse the load atomically ─────────

{
  freshLibrary()
  const broken = legacyLibraryFile(
    [bundledMachines()[0], { id: 'broken' } as unknown as MachineDefinition],
    bundledMachines()[0].id,
  )
  let thrown: unknown
  try {
    decodeProjectFormat(broken)
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof MachineLoadError, 'a structurally unreadable entry refuses the load')
  assert((thrown as MachineLoadError).diagnostics[0].index === 1, 'the diagnostic carries the entry index')

  const before = useProjectStore.getState().project
  assertThrows(
    () => useProjectStore.getState().openProjectFromText(JSON.stringify(broken), null),
    'opening the broken file throws before replacing state',
  )
  assert(useProjectStore.getState().project === before, 'the current project is untouched by the refused load')
}

{
  freshLibrary()
  const first = customMachine('ambiguous', 'Ambiguous A')
  const second = { ...customMachine('ambiguous', 'Ambiguous B'), fileExtension: 'tap' }
  const file = legacyLibraryFile([first, second], 'ambiguous')
  let thrown: unknown
  try {
    decodeProjectFormat(file)
  } catch (error) {
    thrown = error
  }
  assert(thrown instanceof MachineLoadError, 'two different definitions under the selected id refuse the load')
  assert((thrown as MachineLoadError).diagnostics[0].index === 1, 'the ambiguous duplicate is indexed')
}

// ── save normalization, direct load and history keep the rescue ────────────

{
  freshLibrary()
  const selected = customMachine('selected', 'Selected')
  const other = customMachine('other', 'Other')
  const base = newProject('Save rescue', 'mm')
  useProjectStore.setState({
    project: {
      ...base,
      meta: { ...base.meta, machineDefinitions: [selected, other], selectedMachineId: selected.id },
    },
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)

  const saved = JSON.parse(useProjectStore.getState().saveProject()) as Project
  assert(saved.meta.machineDefinitions.length === 1, 'save normalization keeps one snapshot')
  assert(saved.meta.selectedMachineId === 'selected', 'save normalization keeps the selection')
  assert(
    getMachineLibrarySnapshot().customMachines.some((definition) => definition.id === 'other'),
    'save normalization rescues the unselected machine before compacting',
  )
}

{
  freshLibrary()
  const selected = customMachine('load-selected', 'Load Selected')
  const other = customMachine('load-other', 'Load Other')
  const base = newProject('Load rescue', 'mm')
  useProjectStore.getState().loadProject({
    ...base,
    meta: { ...base.meta, machineDefinitions: [selected, other], selectedMachineId: selected.id },
  })

  const state = useProjectStore.getState()
  assert(state.project.meta.selectedMachineId === 'load-selected', 'a direct load keeps its selected snapshot')
  assert(
    getMachineLibrarySnapshot().customMachines.some((definition) => definition.id === 'load-other'),
    'a direct load rescues the unselected machine instead of dropping it',
  )
  assert(
    state.machineLoadDiagnostics.some((entry) => entry.kind === 'machine-moved-to-library'),
    'a direct load exposes the move diagnostics',
  )
}

{
  freshLibrary()
  const invalid = invalidMachine('history-invalid', 'History Invalid')
  useProjectStore.setState({
    project: newProject('History', 'mm'),
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
  useProjectStore.getState().setProjectMachine(invalid)
  useProjectStore.getState().setProjectName('Changed')
  useProjectStore.getState().undo()
  assert(
    useProjectStore.getState().project.meta.selectedMachineId === invalid.id,
    'history restore keeps a template-invalid snapshot instead of dropping it',
  )
  useProjectStore.getState().redo()
  assert(
    useProjectStore.getState().project.meta.selectedMachineId === invalid.id,
    'redo keeps the snapshot too',
  )
}

// ── .camj inspection reports what the decode rescued ───────────────────────

{
  freshLibrary()
  const selected = bundledMachines()[2]
  const custom = customMachine('imported-custom', 'Imported Custom')
  const invalid = invalidMachine('imported-invalid', 'Imported Invalid')
  const inspection = inspectCamjString(JSON.stringify(legacyLibraryFile([selected, custom, invalid], invalid.id)))

  assert(
    inspection.machineCustomDefinitions.some((definition) => definition.id === 'imported-custom'),
    'inspection exposes the custom machines the source carried',
  )
  assert(
    inspection.machineDiagnostics.some((entry) => entry.kind === 'machine-retained-invalid'),
    'inspection exposes the retained-invalid report',
  )
  assert(
    inspection.warnings.some((warning) => warning.includes('Imported Invalid')),
    'inspection warnings name the retained machine',
  )
}

// ── template extraction rescues, never drops ───────────────────────────────

{
  freshLibrary()
  const selected = customMachine('template-selected', 'Template Selected')
  const other = customMachine('template-other', 'Template Other')
  const base = newProject('Template source', 'mm')
  const template = setupOnlyTemplate({
    ...base,
    meta: { ...base.meta, machineDefinitions: [selected, other], selectedMachineId: selected.id },
  })

  assert(template.meta.machineDefinitions.length === 1, 'a template carries one machine snapshot')
  assert(template.meta.selectedMachineId === 'template-selected', 'the template keeps its selected machine')
  assert(
    getMachineLibrarySnapshot().customMachines.some((definition) => definition.id === 'template-other'),
    'template extraction moves the other machine to My Machines instead of dropping it',
  )
}

resetMachineLibraryForTests()

console.log('store/machineSnapshot.test.ts: all assertions passed')
