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
 * The reported machine data of issue #1112 item 35, shared by the suites that
 * hold the fix (rt4-b, corner III).
 *
 * Both definitions are **verbatim** the stored JSON the report carries — the
 * reporter's My Machines copy (`mach3-copy`, "Mach3 (w/rotary)") and the Grbl
 * copy saved inside the project (`grbl-1-1-copy`, "GRBL 1.1 (copy)", the one the
 * saved `.camj` selects) — so a test that reads them takes the real stored
 * shape, not a definition rebuilt from today's bundled template. The project
 * builder puts them in the reported state: an **inch** rotary project whose two
 * displayed operations are the Export dialog's own default selection.
 *
 * This module holds data and a builder only; it asserts nothing. The rules live
 * in `src/app/toolpathGeneration/exportMachineResolution.test.ts` (the export
 * path) and `src/components/export/exportDialogMachinePreview.test.ts` (the
 * dialog the operator saw), and both read this one copy so they cannot drift.
 */

import { rotaryOperationFixture } from './rotaryOperationFixture'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import type { Project } from '../types/project'

/**
 * The machine the report names, **verbatim** from the reporter's machine
 * library (`purecutcnc.machines.customMachines`, My Machines): id `mach3-copy`,
 * display name "Mach3 (w/rotary)", `builtin: false`, rotary about X with its
 * own drive. It is a copy of the bundled Mach3 with a rotary axis added, and it
 * is the definition the project embedded when the report was written.
 *
 * Untyped on purpose — it is the stored JSON as it was read, and the tests run
 * it through the same `validateMachineDefinition` the loader does.
 */
export const REPORTED_MACH3_COPY: unknown = {
  id: 'mach3-copy',
  name: 'Mach3 (w/rotary)',
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

/**
 * The second machine the report names: the Grbl copy now saved inside the
 * project (`meta.machineDefinitions[0]` of the reported `.camj`, format 3.3),
 * also with a rotary axis of its own. It is what the saved file selects, so a
 * regression here is a regression in the state the operator will open next.
 */
export const REPORTED_GRBL_COPY: unknown = {
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

export function reportedMach3Copy(): MachineDefinition {
  return validateMachineDefinition(REPORTED_MACH3_COPY)
}

export function reportedGrblCopy(): MachineDefinition {
  return validateMachineDefinition(REPORTED_GRBL_COPY)
}

/**
 * The rotary fixture as an **inch** project — the units of the reported project
 * — with `machine` as the project's own snapshot. `selection` is what
 * `meta.selectedMachineId` says, so a project whose selection names nothing can
 * be built too.
 *
 * `displayedOperations` is how many operations the fixture carries, all with
 * the toolpath display on — they are the dialog's default export selection, so
 * a regression can run with operations selected rather than with an empty
 * checklist. The saved project has two; pass 2 for the reported state.
 */
export function reportedRotaryProject(
  machine: MachineDefinition | null,
  selection: string | null = machine?.id ?? null,
  displayedOperations = 1,
): Project {
  const bar = rotaryOperationFixture('x', 'rotary_rough', 'inch')
  const first = bar.operations[0]
  const operations = displayedOperations > 1
    ? [first, { ...first, id: 'op-second', name: 'Rotary rough 2' }]
    : [first]
  return {
    ...bar,
    operations: operations.map((operation) => ({ ...operation, showToolpath: true })),
    meta: {
      ...bar.meta,
      projectType: 'rotary',
      machineDefinitions: machine ? [machine] : [],
      selectedMachineId: selection,
    },
  }
}
