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
 * One program per machining setup (issue #946).
 *
 * The operator turns the part by hand between setups, so an export is split
 * here into one program per setup — never one program across the turn — and
 * each program is given a name that says which setup it is and a header that
 * tells the operator how the part must sit before it runs.
 *
 * A project with a single setup is not split, named or annotated by default:
 * it exports exactly what it did before setups existed, under the same file
 * name. That is the legacy-parity rule, and it is why the per-setup decisions
 * below are keyed on the project having more than one setup.
 *
 * The exceptions are the faces that need an operator instruction even on
 * their own (#1054 slices 2 and 2b): an Around setup (#395) and, in a rotary
 * project on a bar, a Top or Bottom setup. Slices 2 and 2b split on the
 * machine: without a rotary axis the header tells the operator which A to set
 * by hand and to retract before turning it; with one, the header says the
 * program turns the bar itself after retracting, and the emitter writes those
 * two rapids (`manualIndexAngle` in `motionPipeline.ts`). Those headers are
 * added without changing the single-setup file name.
 *
 * The header is plain text lines. Each output dialect writes them as comments
 * in its own syntax (`planProgramSetup` in `motionPipeline.ts` hands them to
 * the emitters), so a Bottom program reads the same in G-code and in SBP.
 * The words are English and upper-case where they are ours, like the rest of
 * a program's comments; names and notes are the user's and are left as typed.
 */

import { getStockBounds, isAroundSetup } from '../../types/project'
import type { MachiningSetup, Project, RegistrationReference, SetupFace } from '../../types/project'
import { setupFace, setupForOperation } from '../setupOrientation'
import { manualIndexingApplies } from '../../store/helpers/projectType'
import { rotaryWord } from './types'
import type { MachineDefinition } from './types'

/**
 * True when the project's exports are split, named and annotated per setup.
 *
 * An Around setup is one of those even when it is the project's only one
 * (issue #395): the bar runs on a rotary axis on this router, not on a lathe,
 * so its program must say how the bar is turned and zeroed. The flat
 * single-setup legacy program is untouched by that.
 */
export function projectExportsPerSetup(project: Pick<Project, 'setups'>): boolean {
  const setups = project.setups ?? []
  return setups.length > 1 || setups.some(isAroundSetup)
}

/** 1-based position of a setup in the project: its program number. */
export function setupProgramNumber(project: Pick<Project, 'setups'>, setupId: string): number {
  const index = project.setups?.findIndex((setup) => setup.id === setupId) ?? -1
  return index + 1
}

/** `01`, `02`, … — the number as it appears in file names and headers. */
export function formatProgramNumber(programNumber: number): string {
  return String(programNumber).padStart(2, '0')
}

// ── Splitting an export ───────────────────────────────────────

/** The operations of one setup that an export will write as one program. */
export interface SetupProgram {
  /** The setup the program is for; null only for a project without setups. */
  setup: MachiningSetup | null
  /** 1-based program number; 1 for a project without setups. */
  programNumber: number
  face: SetupFace
  /** The program's operations, in project order — the order they are cut in. */
  operationIds: string[]
  /** Suggested file name, without the extension. */
  fileStem: string
}

/** Whitespace to underscores — the rule file names have always used. */
function fileNameStem(text: string): string {
  return text.replace(/\s+/g, '_')
}

/** The part of a file name that names a setup: its own name, lower-case. */
function setupFileSlug(setup: MachiningSetup): string {
  const slug = setup.name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '')
  return slug || setupFace(setup)
}

/**
 * Split the operations of an export into one program per setup.
 *
 * `operationIds` are the operations to export. Programs come back in setup
 * order, each holding its operations in project order; a setup with none of
 * the selected operations gets no program.
 *
 * File names: a project with one setup keeps the name it always had — the
 * project name, plus the operation's when exactly one is exported. With more
 * than one setup each file is `<project>_<NN>_<setup>`, so `pin-plate`
 * exports `pin-plate_01_top` and `pin-plate_02_bottom`.
 */
export function planSetupPrograms(project: Project, operationIds: readonly string[]): SetupProgram[] {
  const selected = new Set(operationIds)
  const operations = project.operations.filter((operation) => selected.has(operation.id))
  if (operations.length === 0) return []

  const singleOperationName = operations.length === 1 ? operations[0].name : null
  const projectStem = fileNameStem(project.meta.name)

  if (!projectExportsPerSetup(project)) {
    const setup = project.setups?.[0] ?? null
    return [{
      setup,
      programNumber: 1,
      face: setup ? setupFace(setup) : 'top',
      operationIds: operations.map((operation) => operation.id),
      // Exactly today's name: see `suggestGcodeFileName`.
      fileStem: fileNameStem(singleOperationName === null ? project.meta.name : `${project.meta.name} ${singleOperationName}`),
    }]
  }

  // `setupForOperation` refuses an operation whose setup does not exist, so
  // none can fall between the programs and be left out of every file. One
  // without a setup at all reads as Top and joins the first setup.
  const setupOf = new Map(operations.map((operation) => [
    operation.id,
    setupForOperation(project, operation) ?? project.setups[0],
  ]))

  const programs: SetupProgram[] = []
  for (const setup of project.setups) {
    const members = operations.filter((operation) => setupOf.get(operation.id) === setup)
    if (members.length === 0) continue
    const programNumber = setupProgramNumber(project, setup.id)
    const stem = `${projectStem}_${formatProgramNumber(programNumber)}_${setupFileSlug(setup)}`
    programs.push({
      setup,
      programNumber,
      face: setupFace(setup),
      operationIds: members.map((operation) => operation.id),
      fileStem: singleOperationName === null ? stem : `${stem}_${fileNameStem(singleOperationName)}`,
    })
  }
  return programs
}

// ── The setup header ──────────────────────────────────────────

/** How close two positions must be to read as the same place, as a fraction of the stock's size. */
const POSITION_TOLERANCE = 1e-6

function formatLength(value: number, units: Project['meta']['units']): string {
  // Enough digits to locate a touch-off point; trailing zeros add nothing.
  const text = value.toFixed(units === 'inch' ? 4 : 3).replace(/\.?0+$/, '')
  return text === '-0' ? '0' : text
}

/**
 * Where the machine origin sits on the face that is up, in words. The origin
 * is one placement shared by every setup and read in the setup's own frame,
 * so this is the same sentence for Top and Bottom — on a different corner of
 * the part once it is turned.
 *
 * Project Y runs toward the operator: the stock's largest Y is its front edge.
 *
 * An Around setup (issue #395) reads the same placement as Top — the sheet is
 * never turned, only wrapped — and its Z zero is the top of the bar, which is
 * `stock.thickness`: the bar's diameter.
 */
export function describeTouchOff(project: Pick<Project, 'origin' | 'stock' | 'meta'>, face: SetupFace): string {
  const bounds = getStockBounds(project.stock)
  const { origin } = project
  const units = project.meta.units
  const tolerance = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1) * POSITION_TOLERANCE
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= tolerance

  const column = near(origin.x, bounds.minX) ? 'LEFT'
    : near(origin.x, bounds.maxX) ? 'RIGHT'
      : near(origin.x, (bounds.minX + bounds.maxX) / 2) ? 'CENTRE' : null
  const row = near(origin.y, bounds.maxY) ? 'FRONT'
    : near(origin.y, bounds.minY) ? 'BACK'
      : near(origin.y, (bounds.minY + bounds.maxY) / 2) ? 'CENTRE' : null

  let place: string
  if (row !== null && column !== null) {
    place = row === 'CENTRE' && column === 'CENTRE'
      ? 'CENTRE'
      : row === 'CENTRE'
        ? `CENTRE OF THE ${column} EDGE`
        : column === 'CENTRE'
          ? `CENTRE OF THE ${row} EDGE`
          : `${row}-${column} CORNER`
  } else {
    // Measured from the front-left corner, in machine directions: +X right, +Y away from the operator.
    const dx = formatLength(origin.x - bounds.minX, units)
    const dy = formatLength(bounds.maxY - origin.y, units)
    place = `X${dx} Y${dy} ${units === 'inch' ? 'IN' : 'MM'} FROM THE FRONT-LEFT CORNER`
  }

  const dz = origin.z - project.stock.thickness
  if (face === 'around') {
    // The bar's top is its highest surface, so Z0 on it is said of the bar
    // itself rather than of a "face as mounted".
    const height = Math.abs(dz) <= tolerance
      ? 'Z0 ON TOP OF THE BAR'
      : `Z0 ${formatLength(Math.abs(dz), units)} ${units === 'inch' ? 'IN' : 'MM'} ${dz < 0 ? 'BELOW' : 'ABOVE'} THE BAR SEEN FROM ABOVE`
    return `${place} OF THE BAR SEEN FROM ABOVE, ${height}`
  }

  const faceName = face === 'top' ? 'TOP' : 'BOTTOM'
  const height = Math.abs(dz) <= tolerance
    ? 'Z0 ON THAT FACE'
    : `Z0 ${formatLength(Math.abs(dz), units)} ${units === 'inch' ? 'IN' : 'MM'} ${dz < 0 ? 'BELOW' : 'ABOVE'} THAT FACE`
  return `${place} OF THE ${faceName} FACE AS MOUNTED, ${height}`
}

function describeRegistrationReference(
  project: Pick<Project, 'features' | 'meta'>,
  reference: RegistrationReference,
): string {
  const kind = reference.kind.toUpperCase()
  const units = project.meta.units
  const point = (x: number, y: number): string => `X${formatLength(x, units)} Y${formatLength(y, units)}`
  const { target } = reference
  if (target.type === 'feature') {
    const feature = project.features.find((entry) => entry.id === target.featureId)
    return `${kind} ${feature?.name ?? target.featureId}`
  }
  if (target.type === 'point') return `${kind} AT ${point(target.point.x, target.point.y)}`
  return `${kind} FROM ${point(target.start.x, target.start.y)} TO ${point(target.end.x, target.end.y)}`
}

/** A setup's registration references in words, or the plain statement that there are none. */
export function describeRegistration(
  project: Pick<Project, 'features' | 'meta'>,
  setup: Pick<MachiningSetup, 'registration'>,
): string {
  return setup.registration.length === 0
    ? 'NONE DECLARED'
    : setup.registration.map((reference) => describeRegistrationReference(project, reference)).join(', ')
}

/**
 * How the stock is turned for a setup, in words. An Around setup (issue #395)
 * is not turned at all — the bar sits in the chuck and the program wraps
 * around it — so it never reads as a flip.
 */
export function describeSetupTurn(setup: Pick<MachiningSetup, 'orientation' | 'kind'>): string {
  if (isAroundSetup(setup)) return `AROUND THE BAR, BAR ALONG ${setup.orientation.axis.toUpperCase()}`
  return setupFace(setup) === 'top'
    ? 'TOP FACE UP'
    : `BOTTOM FACE UP - FLIP STOCK ABOUT ${setup.orientation.axis.toUpperCase()}`
}

/** The line that turns the bar to the program's start line, in place of registration. */
const ROTARY_ZERO_LINE = 'ROTARY ZERO: TURN THE BAR SO THE START LINE IS UP, THEN ZERO THE ROTARY'

/**
 * The manual A angle a Top program expects (#1054 slice 2): the bar's own
 * zero, which the operator sets by hand when the machine has no rotary axis.
 */
const MANUAL_INDEX_TOP_LINE = 'ROTARY: SET A TO 0° BEFORE RUNNING'

/**
 * The same for a Bottom program: the bar turned half way round, which is
 * A180 about the bar's own axis — not about the other horizontal one.
 */
const MANUAL_INDEX_BOTTOM_LINE = 'ROTARY: SET A TO 180° - TURN THE BAR ABOUT ITS AXIS - BEFORE RUNNING'

/** Turning A with the cutter down would drag it through the bar. */
const RETRACT_BEFORE_TURNING_LINE = 'ROTARY: RETRACT THE SPINDLE CLEAR OF THE BAR BEFORE TURNING A'

/**
 * The operator line of a program that turns the bar itself (#1054 slice 2b).
 * The retract and the turn are in the motion that follows, so the comment says
 * what they are and what the operator still has to check. The letter is the
 * program's own rotary word: on a borrowed motor it is the axis the program
 * writes, not always A.
 *
 * Without tool-length compensation the retract is in machine coordinates, so
 * the line names its target and the assumption behind it: the machine is homed
 * with Z at the top of travel, which `motion.machineSafeZ` defaults to 0
 * (#1054 fix 3). With compensation active the retract is the work-coordinate
 * travel height and the line stays the neutral statement (#1054 fix 2).
 */
function manualIndexTurnLine(
  word: 'A' | 'X' | 'Y',
  angleDeg: 0 | 180,
  machineCoordinateRetract: boolean,
): string {
  return machineCoordinateRetract
    ? `ROTARY: RETRACTS TO MACHINE Z TOP WITH G53 BEFORE TURNING ${word} TO ${angleDeg}° - CHECK THE BAR IS CLAMPED`
    : `ROTARY: THE PROGRAM TURNS ${word} TO ${angleDeg}° AFTER RETRACTING - CHECK THE BAR IS CLAMPED`
}

/**
 * The angle a manual-index program turns to before its first operation
 * (#1054 slice 2b): the bar's own zero for Top, half a turn for Bottom. When
 * the machine has a rotary axis this is posted as motion; without one the
 * slice 2 comments above say it and nothing turns.
 */
export function manualIndexAngle(setup: Pick<MachiningSetup, 'kind' | 'orientation'>): 0 | 180 {
  return setupFace(setup) === 'bottom' ? 180 : 0
}

/**
 * True when a Top or Bottom program must say which A the operator sets by
 * hand, even when it is the project's only setup (#1054 slice 2): a rotary
 * project on a bar. An Around program has its own rotary-zeroing line and is
 * deliberately not given these.
 */
export function setupStatesManualIndexing(
  project: Pick<Project, 'meta' | 'stock'>,
  setup: Pick<MachiningSetup, 'kind'>,
): boolean {
  return manualIndexingApplies(project) && !isAroundSetup(setup)
}

/**
 * The lines written at the top of a setup's program: which setup it is and
 * how the stock is turned, what locates the part, where to touch off, and the
 * operator's own notes. Plain text; a dialect makes comments of them.
 *
 * A Top or Bottom setup of a rotary bar project adds the manual A angle and
 * the retract before turning, because the operator does the indexing (#1054
 * slice 2). An Around setup (issue #395) is not located by a registration
 * reference — flip registration means nothing in a chuck — so its line is the
 * rotary zeroing instruction instead. `definition` is the program's machine: a
 * borrowed rotary replaces one horizontal motor, which the operator must
 * compensate for by hand. `machineCoordinateRetract` says whether the
 * manual-index retract is the machine-coordinate one, so the operator line
 * describes what the program actually writes (#1054 fix 3).
 */
export function setupHeaderLines(
  project: Project,
  setup: MachiningSetup,
  definition: MachineDefinition,
  machineCoordinateRetract = true,
): string[] {
  const number = formatProgramNumber(setupProgramNumber(project, setup.id))
  const around = isAroundSetup(setup)
  const lines = [
    `SETUP ${number}: ${setup.name} - ${describeSetupTurn(setup)}`,
    around ? ROTARY_ZERO_LINE : `REGISTRATION: ${describeRegistration(project, setup)}`,
    `TOUCH OFF: ${describeTouchOff(project, setupFace(setup))}`,
  ]
  if (setupStatesManualIndexing(project, setup)) {
    const word = rotaryWord(definition)
    if (word === null) {
      // No rotary axis: the operator turns the bar by hand and the header is
      // slice 2's unchanged instruction (#1054 slice 2).
      lines.push(setupFace(setup) === 'bottom' ? MANUAL_INDEX_BOTTOM_LINE : MANUAL_INDEX_TOP_LINE)
      lines.push(RETRACT_BEFORE_TURNING_LINE)
    } else {
      // The program turns the word itself after retracting (#1054 slice 2b).
      lines.push(manualIndexTurnLine(word, manualIndexAngle(setup), machineCoordinateRetract))
    }
  }
  if (around && definition.rotary?.drive === 'borrowed') {
    lines.push(`THE ${rotaryWord(definition)} MOTOR DRIVES THE ROTARY: SET THE TOOL OVER THE BAR'S CENTRELINE BY HAND`)
  }
  for (const note of setup.notes.split(/\r?\n/)) {
    const text = note.replace(/\s+/g, ' ').trim()
    if (text.length > 0) lines.push(`NOTE: ${text}`)
  }
  return lines
}

/** True when a setup is not the project's first and declares no registration. */
export function setupLacksRegistration(project: Pick<Project, 'setups'>, setup: MachiningSetup): boolean {
  // An Around setup has no registration to declare: a chuck locates the bar,
  // and its header line is the rotary zeroing instruction (issue #395).
  if (isAroundSetup(setup)) return false
  return setupProgramNumber(project, setup.id) > 1 && setup.registration.length === 0
}
