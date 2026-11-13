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
 * Issue #1112 item 35: "export finds no machine" on a rotary project.
 *
 * The reported project is an **inch** rotary project — round bar along X,
 * `meta.selectedMachineId` naming the custom machine the operator had saved to
 * My Machines (a Mach3 copy with its own rotary axis, `mach3-copy`,
 * "Mach3 (w/rotary)"). The report read: the Export dialog's header names that
 * machine, the preview pane says "Select a machine in project settings to
 * generate G-code preview", and nothing exports for any operation even though
 * the move counts are computed.
 *
 * ## Why the report's sentence did not mean what it said
 *
 * The artifact was saved again after the report, and it does not reproduce the
 * report: as it stands it selects its own Grbl copy, and running it through the
 * real export path (real service, the dialog's own default selection) posts a
 * program on `feat/issue-1112-wave4` and on this branch alike. The handoff's
 * description of the file does not match the saved file either — so the report's
 * *refusing reason* is not recoverable from the artifact.
 *
 * What is decisive is that it never was a machine-resolution answer. The Export
 * dialog's machine row and the export both read `getActiveMachineDefinition`,
 * so a dialog that *named* a machine is proof the resolver returned a
 * definition: no function returned "no machine". The sentence came from the
 * pane's single fallback, which was rendered for every state without a program
 * — the 300 ms debounce and the whole of generation on open, and every blocked
 * preparation after it. `exportDialogMachinePreview.test.ts` pins that: the
 * real dialog, opened on the reporter's machine data, must never show the
 * "select a machine" sentence while its header names one.
 *
 * ## What is held here
 *
 * 1. **The reported machine data, in an inch project, with operations
 *    selected.** Both definitions are copied verbatim from the reporter's
 *    machine library and project (see `src/test/reportedRotaryMachines.ts`)
 *    rather than rebuilt from today's bundled templates, the fixture is a real
 *    inch project, and the default selection has the same two displayed
 *    operations the saved project has. That fails if export resolves the
 *    bundled registry instead of the project's snapshot, or drops the selected
 *    id.
 * 2. **The permanent state the pane used to lie about.** Hiding every toolpath
 *    empties the default selection (the tick follows the display toggle), so
 *    the preparation blocks on `no-operations` while the header names the
 *    machine — the report's pair of observations, one toggle away in the saved
 *    file, where four of its six operations have the display off. The pane must
 *    name the selection. The transient form of the same lie is the dialog's
 *    first frame, and the component suite holds that.
 *
 * The resolver itself is unchanged from `feat/issue-1112-wave3`: no #1126 slice
 * changed how a project's machine is resolved. What was wrong was the sentence
 * that reported the state, and that is what these tests hold.
 *
 * Run with: npx tsx src/app/toolpathGeneration/exportMachineResolution.test.ts
 */

import assert from 'node:assert/strict'
import { validateMachineDefinition, type MachineDefinition } from '../../engine/gcode/types'
import { BUNDLED_DEFINITIONS, getActiveMachineDefinition } from '../../engine/gcode/definitions'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import {
  REPORTED_GRBL_COPY,
  reportedGrblCopy,
  reportedMach3Copy,
  reportedRotaryProject,
} from '../../test/reportedRotaryMachines'
import { projectMachineMismatch } from '../../store/helpers/projectType'
import { normalizeMachineDefinitions } from '../../store/helpers/normalize'
import type { Project } from '../../types/project'
import { exportPreviewMessageKey } from '../../components/export/exportPreviewText'
import { listExportOperationOptions } from '../../components/export/exportOperationSelection'
import {
  createExportToken,
  exportHasError,
  prepareExport,
  type ExportPostOptions,
} from './exportPreparation'
import { makeCountingService } from './testSupport'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(fn).then(
    () => { passed += 1; console.log(`   \u2713 ${name}`) },
    (error: unknown) => {
      failed += 1
      console.log(`   \u2717 ${name}: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(found, `bundled definition ${id} exists`)
  return validateMachineDefinition(structuredClone(found))
}

/**
 * The reported Mach3 copy as a project saved it before `motion.machineSafeZ`
 * existed: the same body with the key absent, which the schema's default has to
 * migrate rather than reject (a definition the loader cannot read is dropped,
 * and the project would open with no machine at all).
 */
function mach3CopyBeforeSafeZ(): MachineDefinition {
  const reported = reportedMach3Copy()
  const { machineSafeZ: _machineSafeZ, ...motion } = reported.motion
  return validateMachineDefinition({ ...reported, motion })
}

/**
 * The reported Grbl copy under a bundled id, with an edited header: a program
 * that carries it can only have been written with *this* definition, which is
 * what proves the export read the project's snapshot rather than the bundled
 * machine of the same id.
 */
function editedGrblUnderBundledId(): MachineDefinition {
  const reported = reportedGrblCopy()
  return validateMachineDefinition({
    ...reported,
    id: 'grbl',
    builtin: false,
    program: {
      ...reported.program,
      header: reported.program.header.map((line) => line.replace('{programName}', 'project copy of {programName}')),
    },
  })
}

const PLAIN_ROUTER = validateMachineDefinition({ ...bundled('generic'), id: 'plain-router', name: 'Plain router' })

/** A rotary machine whose axis lies along Y, on a bar that lies along X. */
const OPPOSITE_AXIS_ROTARY = validateMachineDefinition({
  ...bundled('grbl'),
  id: 'rotary-y',
  name: 'Rotary Y',
  rotary: { about: 'y', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
})

const OPTIONS: ExportPostOptions = {
  emitToolChanges: false,
  emitCoolant: false,
  programName: 'around',
  captureMotionTrace: false,
}

function realService(project: Project): ReturnType<typeof makeCountingService> {
  return makeCountingService({ project, documentKey: 1 }, (operationId) => {
    const operation = project.operations.find((candidate) => candidate.id === operationId)
    assert.ok(operation, `operation ${operationId} exists`)
    const envelope = computeOperationToolpath(project, operation)
    assert.ok(envelope, `operation ${operationId} generates`)
    return envelope.result
  })
}

/** The operations the dialog opens with ticked — its own default set. */
function defaultSelection(project: Project): string[] {
  return listExportOperationOptions(project)
    .filter((option) => option.exportable && option.defaultSelected)
    .map((option) => option.operation.id)
}

/**
 * The export exactly as the dialog runs it: the definition comes from
 * `getActiveMachineDefinition(project)` — the same call behind the header — and
 * the operation set is the dialog's own default selection. Resolving it here,
 * rather than the test handing one in, is what makes a resolver mutation an
 * export failure and not only a failed assertion about a variable.
 */
async function exportProgram(
  project: Project,
  service: ReturnType<typeof makeCountingService> = realService(project),
  operationIds: readonly string[] = defaultSelection(project),
) {
  const definition = getActiveMachineDefinition(project)
  assert.ok(definition, 'the project resolves a machine to export with')
  const token = createExportToken(1, service.context(), operationIds, definition, OPTIONS)
  return prepareExport(service.service, service.context(), token, definition, OPTIONS)
}

async function main(): Promise<void> {
  console.log('Issue #1112 item 35 — export resolves the project\'s own machine')

  await test('the reported Mach3 copy is the machine the dialog names, and it exports the project\'s two displayed operations', async () => {
    const machine = reportedMach3Copy()
    const project = reportedRotaryProject(machine, machine.id, 2)

    // One resolver, and it is the project's snapshot: not the library, not the
    // bundled registry, not a fresh copy of the definition. This is the name
    // the dialog header shows, so it is the name the report said was wrong.
    const resolved = getActiveMachineDefinition(project)
    assert.equal(resolved?.id, 'mach3-copy', 'the project\'s selected machine resolves')
    assert.equal(resolved?.name, 'Mach3 (w/rotary)', 'and the header names the reporter\'s own copy')
    assert.equal(resolved, project.meta.machineDefinitions[0], 'the embedded snapshot, by reference')
    assert.equal(projectMachineMismatch(project), null, 'a rotary machine suits a rotary project')

    // The dialog opens with the operations whose toolpaths are displayed — the
    // same two the saved project has — so the export runs with a selection.
    assert.deepEqual(
      defaultSelection(project),
      ['op1', 'op-second'],
      'both displayed operations are ticked on open',
    )

    const prepared = await exportProgram(project)
    assert.equal(prepared.status, 'ready', 'the export prepares a program')
    if (prepared.status !== 'ready') return
    assert.equal(exportHasError(prepared.programs), false, 'and nothing refuses the save')
    assert.equal(prepared.programs.length, 1, 'one program for the Around setup')
    assert.deepEqual(
      prepared.programs[0].operations.map((row) => row.operation.id),
      ['op1', 'op-second'],
      'the program carries both selected operations',
    )
    const gcode = prepared.programs[0].result.gcode
    assert.match(gcode, /\bO0001 \(around\)/, 'the project copy\'s own program number, not the bundled Mach3 template')
    assert.match(gcode, /^N\d+ G20$/m, 'inch units from the reported snapshot, with its line numbering')
    assert.match(gcode, /\bA-?\d/, 'the rotary axis is written, so this is a real rotary program')
    assert.equal(exportPreviewMessageKey({ hasPreview: true, machine: 'resolved', blockReason: null }), null, 'the pane shows the program')
  })

  await test('the reported Grbl copy survives the load path and exports an inch rotary program', async () => {
    // The loader validates each stored definition and **drops** one it cannot
    // read, which would leave the project with no machine at all. The reported
    // snapshot must come through byte-for-byte, not be repaired into something
    // else.
    const parsed = reportedGrblCopy()
    assert.deepEqual(parsed, REPORTED_GRBL_COPY, 'validation adds and removes nothing from the reported snapshot')

    const project = reportedRotaryProject(parsed)
    const resolved = getActiveMachineDefinition(project)
    assert.equal(resolved?.id, 'grbl-1-1-copy', 'the project\'s selected machine resolves')
    assert.equal(resolved?.name, 'GRBL 1.1 (copy)', 'and the header names the project\'s own copy')
    assert.equal(resolved, project.meta.machineDefinitions[0], 'the embedded snapshot, by reference')

    const prepared = await exportProgram(project)
    assert.equal(prepared.status, 'ready', 'the export prepares a program')
    if (prepared.status !== 'ready') return
    assert.equal(exportHasError(prepared.programs), false, 'and nothing refuses the save')
    const gcode = prepared.programs[0].result.gcode
    assert.match(gcode, /^; around$/m, 'the program uses the project copy\'s own header, not the bundled Grbl one')
    assert.match(gcode, /^G20$/m, 'the reported project is inch, so the program is written in inches')
    assert.doesNotMatch(gcode, /^G21$/m, 'and never in millimetres')
    assert.match(gcode, /^X-?\d+\.\d{4}\b/m, 'with the reported snapshot\'s own inch number format (four decimals)')
    assert.match(gcode, /\bA-?\d/, 'the rotary axis is written')
  })

  await test('a snapshot saved before machineSafeZ existed gains the default instead of being dropped', async () => {
    const machine = mach3CopyBeforeSafeZ()
    assert.equal(machine.motion.machineSafeZ, 0, 'the schema default is the migration, not a refusal')

    const project = reportedRotaryProject(machine)
    const loaded = normalizeMachineDefinitions(project)
    assert.equal(loaded.machineDefinitions.length, 1, 'the load path keeps the reported machine')
    assert.equal(loaded.selectedMachineId, 'mach3-copy', 'and keeps it selected')
    assert.equal(loaded.unresolvedSelectionId, null, 'so the project does not load as having no machine')

    const prepared = await exportProgram(project)
    assert.equal(prepared.status, 'ready', 'the older snapshot still exports')
  })

  await test('the embedded snapshot wins over a bundled machine of the same id', async () => {
    const machine = editedGrblUnderBundledId()
    const project = reportedRotaryProject(machine)

    assert.equal(getActiveMachineDefinition(project), project.meta.machineDefinitions[0], 'the snapshot, not the registry')
    const prepared = await exportProgram(project)
    assert.equal(prepared.status, 'ready', 'the export prepares a program')
    if (prepared.status !== 'ready') return
    assert.match(
      prepared.programs[0].result.gcode,
      /^; project copy of around$/m,
      'the program is the project copy\'s, so an app upgrade cannot change what a saved project exports',
    )
  })

  await test('a project holding more than one definition exports the selected one', async () => {
    // A legacy `.camj` carried a whole machine library before the snapshot rule
    // (format 3.3 keeps one), and `getActiveMachineDefinition` is the boundary
    // that has to read the *selected* id out of whatever the file holds.
    const mach3 = reportedMach3Copy()
    const grbl = reportedGrblCopy()
    const bar = rotaryOperationFixture('x', 'rotary_rough', 'inch')
    const project: Project = {
      ...bar,
      meta: {
        ...bar.meta,
        projectType: 'rotary',
        machineDefinitions: [mach3, grbl],
        selectedMachineId: grbl.id,
      },
    }

    assert.equal(getActiveMachineDefinition(project), grbl, 'the selected definition, not the first one')
    const prepared = await exportProgram(project)
    assert.equal(prepared.status, 'ready', 'the export prepares a program')
    if (prepared.status !== 'ready') return
    assert.match(
      prepared.programs[0].result.gcode,
      /^; around$/m,
      'the program is the selected machine\'s',
    )
  })

  await test('a router with no rotary axis is refused for the missing axis, not for having no machine', async () => {
    const project = reportedRotaryProject(PLAIN_ROUTER)

    assert.equal(getActiveMachineDefinition(project)?.id, 'plain-router', 'the router is the machine it resolved')
    assert.deepEqual(
      projectMachineMismatch(project),
      { reason: 'missing-rotary', expected: 'rotary', machineName: PLAIN_ROUTER.name },
      'the machine is the right family and short its rotary axis',
    )

    const prepared = await exportProgram(project)
    assert.equal(prepared.status, 'ready', 'the program prepares, so the operator sees the reason')
    if (prepared.status !== 'ready') return
    assert.equal(exportHasError(prepared.programs), true, 'and the save is refused')
    const warnings = prepared.programs.flatMap((program) => program.result.warnings)
    assert.ok(
      warnings.some((warning) => warning.code === 'exportMachineMissingRotaryAxis'),
      `expected exportMachineMissingRotaryAxis, got ${warnings.map((warning) => warning.code).join(', ')}`,
    )
    assert.equal(
      warnings.some((warning) => warning.code === 'exportMachineTypeMismatch'),
      false,
      'not the generic type mismatch',
    )
  })

  await test('an opposite-axis rotary machine posts the program but names the axis it cannot turn about', async () => {
    // The third refusal the handoff names: the machine *has* a rotary, on the
    // wrong axis for this bar. The program is built so the reason is visible
    // beside it, and the refusal is a real error warning — never the machine
    // sentence.
    const project = reportedRotaryProject(OPPOSITE_AXIS_ROTARY)

    const prepared = await exportProgram(project)
    assert.equal(prepared.status, 'ready', 'the export still prepares a program')
    if (prepared.status !== 'ready') return
    const warnings = prepared.programs.flatMap((program) => program.result.warnings)
    assert.ok(
      warnings.some((warning) => warning.code === 'postRotaryAxisMismatch'),
      `expected postRotaryAxisMismatch, got ${warnings.map((warning) => warning.code).join(', ')}`,
    )
    assert.equal(exportHasError(prepared.programs), true, 'and the save is refused')
    assert.equal(
      exportPreviewMessageKey({ hasPreview: true, machine: 'resolved', blockReason: null }),
      null,
      'a program is on screen, so the pane never claims a missing machine',
    )
  })

  await test('an empty default checklist is the state the pane used to call "no machine"', async () => {
    // Hiding every toolpath empties the default export set (the tick follows
    // the display toggle), and the preparation then blocks on `no-operations`
    // while the header still names the machine. That is the report's pair of
    // observations made permanent — and it is one toggle away in the saved
    // file, where four of the six operations have the display off.
    const machine = reportedMach3Copy()
    const displayedProject = reportedRotaryProject(machine, machine.id, 2)
    const project: Project = {
      ...displayedProject,
      operations: displayedProject.operations.map((operation) => ({ ...operation, showToolpath: false })),
    }

    const options = listExportOperationOptions(project)
    assert.equal(options.length, 2, 'both operations are listed')
    assert.deepEqual(defaultSelection(project), [], 'and none is ticked while its toolpath is hidden')

    const prepared = await exportProgram(project, realService(project), [])
    assert.equal(prepared.status, 'blocked', 'the export cannot run')
    if (prepared.status !== 'blocked') return
    assert.equal(prepared.reason.kind, 'no-operations', 'the reason is the selection, not the machine')
    assert.equal(
      exportPreviewMessageKey({ hasPreview: false, machine: 'resolved', blockReason: prepared.reason.kind }),
      'dialogs.export.previewNoOperations',
      'the pane names the empty selection',
    )

    // The proof that the machine was never the problem: tick them and the same
    // project posts the program.
    const ticked = await exportProgram(project, realService(project), ['op1', 'op-second'])
    assert.equal(ticked.status, 'ready', 'the operations export once they are selected')
  })

  await test('a project that names no machine blocks with no-machine, before any generation', async () => {
    const project = reportedRotaryProject(null)
    const h = realService(project)
    const definition = getActiveMachineDefinition(project)
    assert.equal(definition, null, 'a blank project resolves no machine')
    const token = createExportToken(1, h.context(), project.operations.map((operation) => operation.id), PLAIN_ROUTER, OPTIONS)
    const prepared = await prepareExport(h.service, h.context(), token, definition, OPTIONS)
    assert.equal(prepared.status, 'blocked', 'a missing machine blocks the export')
    if (prepared.status !== 'blocked') return
    assert.equal(prepared.reason.kind, 'no-machine', 'and says exactly that')
    assert.equal(h.calls(), 0, 'no generation is started for a refused export')
    assert.equal(
      exportPreviewMessageKey({ hasPreview: false, machine: 'none', blockReason: 'no-machine' }),
      'dialogs.export.previewPlaceholder',
      'this is the one state the "select a machine" sentence is true for',
    )
  })

  await test('a selection the snapshot cannot resolve is reported as missing, not as "select one"', async () => {
    // What a file written by another build, or a definition this build could
    // not read, leaves behind: the id is there, the definition is not.
    const project = reportedRotaryProject(null, 'mach3-copy')
    assert.equal(getActiveMachineDefinition(project), null, 'nothing resolves')
    assert.equal(
      exportPreviewMessageKey({ hasPreview: false, machine: 'missing', blockReason: 'no-machine' }),
      'dialogs.export.previewMachineMissing',
      'and the pane says the selected machine is gone instead of asking for one',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

await main()
