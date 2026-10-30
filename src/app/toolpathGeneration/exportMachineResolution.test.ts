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
 * The reported project (`work/thread-on-turn-test-01.camj`) is an **inch**
 * rotary project — round bar along X — holding a custom machine with its own
 * rotary axis, `meta.selectedMachineId` naming it. The report read: the Export
 * dialog's header names a machine, the preview pane says "Select a machine in
 * project settings to generate G-code preview", and nothing exports for any
 * operation even though the move counts are computed.
 *
 * The header and that pane read the **same** `getActiveMachineDefinition` in the
 * same render, so "the header names a machine" and "no machine is selected"
 * cannot both be true. The header name is the project's own embedded copy's
 * name — the dialog has no other source for it — so a name that differs from the
 * bundled template's is the snapshot doing exactly its job, not a bundled lookup.
 * That makes the failure the pane's sentence: one fallback shown for **every**
 * state without a program, so a resolved machine plus any reason not to post read
 * as a missing machine. The refusing reason at the moment of the report cannot be
 * recovered — the file was saved again afterwards, with a Grbl copy selected — so
 * the tests below do the two things that are recoverable and decisive:
 *
 * 1. **The reported machine data, in an inch project.** The snapshots are copied
 *    verbatim from the reporter's files (see the constant comments) rather than
 *    rebuilt from today's bundled templates, and the fixture is a real inch
 *    project (`rotaryOperationFixture(..., 'inch')`), so the program proves the
 *    reported definition was the one read: its own header, its own number
 *    format, its inch units word.
 * 2. **The reported triad, reproduced.** An export selection left empty — the
 *    one no-preview state that reproduces all three reported symptoms with the
 *    machine resolved — is blocked before any generation. The reported project
 *    can be in exactly that state: the export checklist's tick follows the
 *    toolpath display toggle, and four of its six operations are stored with the
 *    display off. The pane must name *that* reason, never the machine sentence.
 *
 * The resolver itself is unchanged from `feat/issue-1112-wave3`; no #1126 slice
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
 * The reported project's own machine snapshot, **verbatim** from
 * `work/thread-on-turn-test-01.camj` (`meta.machineDefinitions[0]`, format 3.3,
 * saved 2026-10-30): the Grbl 1.1 copy Frank created and saved in that project.
 * Untyped on purpose — it is the file's JSON as it was read, and the tests run it
 * through the same `validateMachineDefinition` the loader does.
 */
const REPORTED_GRBL_COPY: unknown = {
  id: 'grbl-1-1-copy',
  name: 'GRBL 1.1 (copy)',
  description: 'GRBL 1.1 \u2014 common hobby CNC controller (Arduino-based)',
  builtin: false,
  fileExtension: 'nc',
  rotary: {
    about: 'x',
    drive: 'own',
    reversed: false,
    inverseTimeFeed: { on: 'G93', off: 'G94' },
  },
  coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
  numberFormat: {
    decimalPlaces: { mm: 3, inch: 4 },
    trailingZeros: true,
    leadingZero: true,
  },
  units: { mmCommand: 'G21', inchCommand: 'G20' },
  program: {
    header: [
      '; {programName}',
      '; Generated by PureCutCNC on {date}',
      'G90',
      'G17',
      '{unitsCommand}',
    ],
    operationHeader: [
      '; Operation {operationIndex}: {operationName}',
      '; Description: {operationDescription}',
      '; Tool {toolNumber}: {toolName}',
    ],
    footer: [],
    commentPrefix: ';',
    commentSuffix: '',
    lineNumbers: false,
    lineNumberIncrement: 10,
  },
  workCoordinates: { selectCommand: null },
  motion: {
    rapidCommand: 'G0',
    linearCommand: 'G1',
    cwArcCommand: 'G2',
    ccwArcCommand: 'G3',
    arcFormat: 'ij',
    modalMotion: true,
    arcInterpolation: true,
    machineSafeZ: 0,
  },
  feedSpeed: {
    feedCommand: 'F',
    rpmCommand: 'S',
    spindleOnCW: 'M3',
    spindleOnCCW: 'M4',
    spindleOff: 'M5',
    inlineWithMotion: true,
    modalFeedSpeed: true,
  },
  toolChange: {
    commands: ['M5', 'M0 ; Tool change: {toolName}'],
    stopSpindleFirst: true,
    pauseAfterChange: false,
    pauseCommand: 'M0',
  },
  cannedCycles: null,
  coolant: null,
  stop: { programEndCommand: 'M30' },
}

/**
 * The `mach3-copy` snapshot the handoff describes, **verbatim** from the
 * reporter's preserved inch rotary project
 * `work/rotary-thread-01.camj` (`meta.machineDefinitions[0]`): id `mach3-copy`,
 * `builtin: false`, rotary about X with its own drive. That file dates from the
 * same rotary work; the report names the same copy "Mach3 (w/rotary)", and the
 * only difference kept in this archived file is its display name.
 *
 * It is two fields older than the current build — no `motion.machineSafeZ`, and
 * the pre-#1054 Mach3 program body — which is exactly what a project saved
 * before the wave carries, and why it must still load and export.
 */
const REPORTED_MACH3_COPY: unknown = {
  id: 'mach3-copy',
  name: 'Mach3 (copy)',
  description: 'Mach3 \u2014 Windows-based CNC controller',
  builtin: false,
  fileExtension: 'tap',
  rotary: {
    about: 'x',
    drive: 'own',
    reversed: false,
    inverseTimeFeed: { on: 'G93', off: 'G94' },
  },
  coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
  numberFormat: {
    decimalPlaces: { mm: 3, inch: 4 },
    trailingZeros: true,
    leadingZero: true,
  },
  units: { mmCommand: 'G21', inchCommand: 'G20' },
  program: {
    header: [
      '%',
      'O0001 ({programName})',
      'G90 G94 G17 G40 G49 G80',
      '{unitsCommand}',
      '{wcsCommand}',
    ],
    operationHeader: [
      '( Operation {operationIndex}: {operationName} )',
      '( Description: {operationDescription} )',
      '( Tool {toolNumber}: {toolName} )',
    ],
    footer: [],
    commentPrefix: '(',
    commentSuffix: ')',
    lineNumbers: true,
    lineNumberIncrement: 10,
  },
  workCoordinates: { selectCommand: 'G54' },
  motion: {
    rapidCommand: 'G0',
    linearCommand: 'G1',
    cwArcCommand: 'G2',
    ccwArcCommand: 'G3',
    arcFormat: 'ij',
    modalMotion: true,
    arcInterpolation: true,
  },
  feedSpeed: {
    feedCommand: 'F',
    rpmCommand: 'S',
    spindleOnCW: 'M3',
    spindleOnCCW: 'M4',
    spindleOff: 'M5',
    inlineWithMotion: true,
    modalFeedSpeed: true,
  },
  toolChange: {
    commands: ['M5', 'M6 T{toolNumber}', 'G43 H{toolNumber}'],
    stopSpindleFirst: true,
    pauseAfterChange: false,
    pauseCommand: 'M1',
  },
  cannedCycles: {
    drillCommand: 'G81',
    drillWithDwellCommand: 'G82',
    peckDrillCommand: 'G83',
    chipBreakDrillCommand: 'G73',
    peckStepWord: 'Q',
    retractMode: 'G98',
    cancelCommand: 'G80',
  },
  coolant: {
    floodOnCommand: 'M8',
    mistOnCommand: 'M7',
    coolantOffCommand: 'M9',
  },
  stop: { programEndCommand: 'M30' },
}

function reportedGrblCopy(): MachineDefinition {
  return validateMachineDefinition(REPORTED_GRBL_COPY)
}

function reportedMach3Copy(): MachineDefinition {
  return validateMachineDefinition(REPORTED_MACH3_COPY)
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

const OPTIONS: ExportPostOptions = {
  emitToolChanges: false,
  emitCoolant: false,
  programName: 'around',
  captureMotionTrace: false,
}

/**
 * The rotary fixture as an **inch** project — the units of the reported project
 * — with `machine` as the project's own snapshot. `selection` is what
 * `meta.selectedMachineId` says, so a project whose selection names nothing can
 * be built too.
 */
function reportedRotaryProject(
  machine: MachineDefinition | null,
  selection: string | null = machine?.id ?? null,
): Project {
  const bar = rotaryOperationFixture('x', 'rotary_rough', 'inch')
  return {
    ...bar,
    meta: {
      ...bar.meta,
      projectType: 'rotary',
      machineDefinitions: machine ? [machine] : [],
      selectedMachineId: selection,
    },
  }
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

/**
 * The export exactly as the dialog runs it: the definition comes from
 * `getActiveMachineDefinition(project)` — the same call behind the header — and
 * is handed to `prepareExport`. Resolving it here, rather than the test handing
 * one in, is what makes a resolver mutation an export failure and not only a
 * failed assertion about a variable.
 */
async function exportProgram(project: Project) {
  const definition = getActiveMachineDefinition(project)
  assert.ok(definition, 'the project resolves a machine to export with')
  const h = realService(project)
  const token = createExportToken(1, h.context(), project.operations.map((operation) => operation.id), definition, OPTIONS)
  return prepareExport(h.service, h.context(), token, definition, OPTIONS)
}

async function main(): Promise<void> {
  console.log('Issue #1112 item 35 — export resolves the project\'s own machine')

  await test('the reported Grbl copy survives the load path and exports an inch rotary program', async () => {
    // The loader validates each stored definition and **drops** one it cannot
    // read, which would leave the project with no machine at all. The reported
    // snapshot must come through byte-for-byte, not be repaired into something
    // else.
    const parsed = reportedGrblCopy()
    assert.deepEqual(parsed, REPORTED_GRBL_COPY, 'validation adds and removes nothing from the reported snapshot')

    const machine = parsed
    const project = reportedRotaryProject(machine)

    // One resolver, and it is the project's snapshot: not the library, not the
    // bundled registry, not a fresh copy of the definition. This is the name
    // the dialog header shows, so it is the name the report said was wrong.
    const resolved = getActiveMachineDefinition(project)
    assert.equal(resolved?.id, 'grbl-1-1-copy', 'the project\'s selected machine resolves')
    assert.equal(resolved?.name, 'GRBL 1.1 (copy)', 'and the header names the project\'s own copy')
    assert.equal(resolved, project.meta.machineDefinitions[0], 'the embedded snapshot, by reference')
    assert.equal(projectMachineMismatch(project), null, 'a rotary machine suits a rotary project')

    const prepared = await exportProgram(project)
    assert.equal(prepared.status, 'ready', 'the export prepares a program')
    if (prepared.status !== 'ready') return
    assert.equal(exportHasError(prepared.programs), false, 'and nothing refuses the save')
    const gcode = prepared.programs[0].result.gcode
    assert.match(gcode, /^; around$/m, 'the program uses the project copy\'s own header, not the bundled Grbl one')
    assert.match(gcode, /^G20$/m, 'the reported project is inch, so the program is written in inches')
    assert.doesNotMatch(gcode, /^G21$/m, 'and never in millimetres')
    assert.match(gcode, /^X-?\d+\.\d{4}\b/m, 'with the reported snapshot\'s own inch number format (four decimals)')
    assert.match(gcode, /\bA-?\d/, 'the rotary axis is written, so this is a real rotary program')
  })

  await test('the reported Mach3 copy survives the load path and exports an inch rotary program', async () => {
    // The reported machine is the Mach3 copy. Its stored body predates
    // `motion.machineSafeZ`, and the schema default is the migration the loader
    // applies — never a refusal that would silently drop the machine.
    const parsed = reportedMach3Copy()
    assert.equal(parsed.motion.machineSafeZ, 0, 'an older snapshot gains the top-of-travel default, it is not rejected')

    const bar = rotaryOperationFixture('x', 'rotary_rough', 'inch')
    const snapshotProject: Project = {
      ...bar,
      meta: {
        ...bar.meta,
        projectType: 'rotary',
        machineDefinitions: [REPORTED_MACH3_COPY as MachineDefinition],
        selectedMachineId: 'mach3-copy',
      },
    }
    const loaded = normalizeMachineDefinitions(snapshotProject)
    assert.equal(loaded.machineDefinitions.length, 1, 'the load path keeps the reported machine')
    assert.equal(loaded.selectedMachineId, 'mach3-copy', 'and keeps it selected')
    assert.equal(loaded.unresolvedSelectionId, null, 'so the project does not load as having no machine')

    const machine = parsed
    const project = reportedRotaryProject(machine)
    assert.equal(getActiveMachineDefinition(project)?.id, 'mach3-copy', 'the Mach3 copy resolves')

    const prepared = await exportProgram(project)
    assert.equal(prepared.status, 'ready', 'the export prepares a program')
    if (prepared.status !== 'ready') return
    assert.equal(exportHasError(prepared.programs), false, 'and nothing refuses the save')
    const gcode = prepared.programs[0].result.gcode
    assert.match(gcode, /\bO0001 \(around\)/, 'the project copy\'s own program number and name, not the bundled Mach3 template')
    assert.match(gcode, /^N\d+ G20$/m, 'inch units from the reported snapshot, with its line numbering')
    assert.match(gcode, /\bA-?\d/, 'the rotary axis is written')
  })

  await test('the reported triad reproduces as an empty export selection, and the pane names it', async () => {
    // The report: the header names the machine, the pane says "select a machine
    // in project settings", and nothing exports. Header and pane read the same
    // resolution, so the sentence was false; what they were in was a no-preview
    // state. The one that reproduces all three symptoms is an empty export
    // selection: it blocks before any generation, Export stays disabled, and the
    // machine is resolved throughout. The reported project is exposed to it
    // because the checklist's default tick follows the toolpath display toggle,
    // and four of its six operations are stored with the display off — hiding the
    // rest (or having hidden them at the time) leaves nothing ticked.
    const machine = reportedGrblCopy()
    const resolvedBar = reportedRotaryProject(machine)
    const project: Project = {
      ...resolvedBar,
      operations: resolvedBar.operations.map((operation) => ({ ...operation, showToolpath: false })),
    }

    const options = listExportOperationOptions(project)
    assert.equal(options.length, 1, 'the rotary operation is listed')
    assert.equal(options[0].defaultSelected, false, 'and is not ticked by default while its toolpath is hidden')
    const selectedIds = options.filter((option) => option.exportable && option.defaultSelected).map((option) => option.operation.id)
    assert.deepEqual(selectedIds, [], 'so the dialog opens with an empty selection')

    assert.equal(getActiveMachineDefinition(project)?.id, 'grbl-1-1-copy', 'the machine is resolved in the header all along')
    const h = realService(project)
    const token = createExportToken(1, h.context(), selectedIds, machine, OPTIONS)
    const prepared = await prepareExport(h.service, h.context(), token, machine, OPTIONS)
    assert.equal(prepared.status, 'blocked', 'the export cannot run')
    if (prepared.status !== 'blocked') return
    assert.equal(prepared.reason.kind, 'no-operations', 'and the reason is the selection, not the machine')
    assert.equal(h.calls(), 0, 'nothing was generated or even asked for')

    assert.equal(
      exportPreviewMessageKey({ hasPreview: false, machine: 'resolved', blockReason: prepared.reason.kind }),
      'dialogs.export.previewNoOperations',
      'the pane names the empty selection',
    )
    assert.notEqual(
      exportPreviewMessageKey({ hasPreview: false, machine: 'resolved', blockReason: prepared.reason.kind }),
      'dialogs.export.previewPlaceholder',
      'and never tells a resolved machine to select a machine',
    )

    // The proof that the machine was never the problem: tick the operation and
    // the same project posts the same program.
    const ticked = await exportProgram(project)
    assert.equal(ticked.status, 'ready', 'the operation exports once it is selected')
    if (ticked.status !== 'ready') return
    assert.equal(exportHasError(ticked.programs), false, 'with nothing refusing it')
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
    // A ready preparation with a refusing program is *not* the no-machine
    // state: the dialog shows the program and the refusal beside it, so the
    // "select a machine" sentence is never reached (exportPreviewText.test.ts
    // covers the pane's wording).
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
