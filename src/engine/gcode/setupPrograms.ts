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
 * A project with a single setup is not split, named or annotated: it exports
 * exactly what it did before setups existed, under the same file name. That
 * is the legacy-parity rule, and it is why every decision below is keyed on
 * the project having more than one setup.
 *
 * The header is plain text lines. Each output dialect writes them as comments
 * in its own syntax (`planProgramSetup` in `motionPipeline.ts` hands them to
 * the emitters), so a Bottom program reads the same in G-code and in SBP.
 * The words are English and upper-case where they are ours, like the rest of
 * a program's comments; names and notes are the user's and are left as typed.
 */

import { getStockBounds } from '../../types/project'
import type { MachiningSetup, Project, RegistrationReference, SetupFace } from '../../types/project'
import { setupFace, setupForOperation } from '../setupOrientation'

/** True when the project's exports are split, named and annotated per setup. */
export function projectExportsPerSetup(project: Pick<Project, 'setups'>): boolean {
  return (project.setups?.length ?? 0) > 1
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
 */
export function describeTouchOff(project: Pick<Project, 'origin' | 'stock' | 'meta'>, face: SetupFace): string {
  const bounds = getStockBounds(project.stock)
  const { origin } = project
  const units = project.meta.units
  const tolerance = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1) * POSITION_TOLERANCE
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= tolerance
  const faceName = face === 'top' ? 'TOP' : 'BOTTOM'

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

/** How the stock is turned for a setup, in words. */
export function describeSetupTurn(setup: Pick<MachiningSetup, 'orientation'>): string {
  return setupFace(setup) === 'top'
    ? 'TOP FACE UP'
    : `BOTTOM FACE UP - FLIP STOCK ABOUT ${setup.orientation.axis.toUpperCase()}`
}

/**
 * The lines written at the top of a setup's program: which setup it is and
 * how the stock is turned, what locates the part, where to touch off, and the
 * operator's own notes. Plain text; a dialect makes comments of them.
 */
export function setupHeaderLines(project: Project, setup: MachiningSetup): string[] {
  const number = formatProgramNumber(setupProgramNumber(project, setup.id))
  const lines = [
    `SETUP ${number}: ${setup.name} - ${describeSetupTurn(setup)}`,
    `REGISTRATION: ${describeRegistration(project, setup)}`,
    `TOUCH OFF: ${describeTouchOff(project, setupFace(setup))}`,
  ]
  for (const note of setup.notes.split(/\r?\n/)) {
    const text = note.replace(/\s+/g, ' ').trim()
    if (text.length > 0) lines.push(`NOTE: ${text}`)
  }
  return lines
}

/** True when a setup is not the project's first and declares no registration. */
export function setupLacksRegistration(project: Pick<Project, 'setups'>, setup: MachiningSetup): boolean {
  return setupProgramNumber(project, setup.id) > 1 && setup.registration.length === 0
}
