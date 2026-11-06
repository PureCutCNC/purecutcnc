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
 * The programs issue #1156 is decided on, shared by the test that holds the
 * rule and the freeze that recorded their output before it existed.
 *
 * Every program runs on the bundled grbl definition plus an own-drive rotary
 * axis (`rotary: { about, drive: 'own' }`, the default inverse-time commands):
 * the machine this issue is about. Two families:
 *
 * - **Around programs** a real rotary operation generates — a model-in-a-bar
 *   rough and finish, in millimetres and inches, a square blank, and a bar
 *   lying along Y whose program runs along it. Their bar project default origin
 *   puts the machine frame's cross coordinate on the centreline, which is what
 *   makes them eligible for the cross-axis rule at all.
 * - **Control programs**, each one deliberate change away from the rule: a
 *   tool-change template that names the cross axis, an origin moved off the
 *   centreline, and a Top setup, whose program is a manual-index one. Their
 *   whole point is that the rule does NOT apply, so their bytes must stay
 *   exactly what the base commit wrote.
 *
 * The smoke program is hand-built (a rapid, a plunge and two turning cuts, the
 * shape the conformance corpus already uses for an own-axis rotary) so a
 * control costs a handful of lines rather than a few hundred.
 *
 * This module holds data, builders and one renderer; it asserts nothing. The
 * rule's tests live in `src/engine/gcode/crossAxisHeldByTouchOff.test.ts`.
 */

import { convertLength } from '../utils/units'
import { defaultOrigin, defaultTool, newProject, roundStock } from '../types/project'
import type { BarStock, MachiningSetup, Operation, Project, Tool } from '../types/project'
import { isBarStock, squareStock } from '../types/barStock'
import type { ToolpathMove, ToolpathResult } from '../engine/toolpaths/types'
import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../store/helpers/roundWorkholding'
import { rotaryOperationFixture } from './rotaryOperationFixture'
import { BUNDLED_DEFINITIONS } from '../engine/gcode/definitions'
import { runPostProcessor } from '../engine/gcode/postprocessor'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition, PostProcessorInput, PostProcessorResult, RotaryDefinition } from '../engine/gcode/types'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'

/** One program the #1156 rule is judged on, ready for the postprocessor. */
export interface CrossAxisProgram {
  name: string
  project: Project
  definition: MachineDefinition
  operations: PostProcessorInput['operations']
  /** True when the cross axis must be held by touch-off (no cross word at all),
   *  false for a control, whose bytes must stay what the base commit wrote. */
  holdsCrossAxis: boolean
}

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  if (!found) throw new Error(`no bundled definition "${id}"`)
  return validateMachineDefinition(structuredClone(found))
}

const GRBL = bundled('grbl')

/**
 * The bundled grbl definition plus an own-drive rotary axis, exactly the
 * machine the issue reports: `A` carries the angle and no motor is borrowed.
 */
export function ownAMachine(about: 'x' | 'y' = 'x'): MachineDefinition {
  const rotary: RotaryDefinition = {
    about,
    drive: 'own',
    reversed: false,
    inverseTimeFeed: { on: 'G93', off: 'G94' },
  }
  return validateMachineDefinition({ ...structuredClone(GRBL), id: `grbl-own-a-${about}`, rotary })
}

/** The same machine with a tool-change template that names the cross axis. */
export function machineWithCrossAxisToolChange(about: 'x' | 'y' = 'x'): MachineDefinition {
  const base = ownAMachine(about)
  return validateMachineDefinition({
    ...base,
    toolChange: { ...base.toolChange, commands: ['G53 G0 Y-10', ...base.toolChange.commands] },
  })
}

/**
 * A real model-in-a-bar program: the fixture's own prism, its own generators,
 * and the default origin a bar project gets — X at the bar's start, Y on the
 * centreline, Z on top of the bar, so the machine frame's cross coordinate is 0
 * on every point the operation plans.
 *
 * The inch programs take a coarse stepover: the inch sampler is far denser than
 * the millimetre one (the 25.4 problem #1153 owns). What this fixture proves is
 * the cross-word removal, not a realistic pass count.
 */
function modelProgram(options: {
  name: string
  axis?: 'x' | 'y'
  units?: 'mm' | 'inch'
  kind: 'rotary_rough' | 'rotary_finish'
  direction: 'around' | 'along'
  shape?: 'round' | 'square'
}): CrossAxisProgram {
  const { name, axis = 'x', units = 'mm', kind, direction, shape = 'round' } = options
  const fixture = rotaryOperationFixture(axis, kind, units)
  const mm = (value: number) => convertLength(value, 'mm', units)
  const stock: BarStock = shape === 'square'
    ? squareStock(mm(12), mm(30), axis, { x: 0, y: 0 })
    : roundStock(mm(12), mm(30), axis, { x: 0, y: 0 })
  const project: Project = {
    ...fixture,
    stock,
    origin: defaultOrigin(stock),
    // A square blank needs its own chuck envelope, or generation warns that the
    // round bar's chuck cannot hold it.
    clamps: [{
      ...defaultRoundWorkholding('chuck', stock, units),
      id: 'chuck',
      name: 'Chuck',
      visible: true,
    }],
    tools: [{ ...fixture.tools[0], diameter: mm(6) }],
    operations: [{
      ...fixture.operations[0],
      stepover: direction === 'around' ? mm(units === 'mm' ? 3 : 40) : mm(2),
      rotaryPassDirection: direction,
    }],
  }
  const operation = project.operations[0]
  return {
    name,
    project,
    definition: ownAMachine(axis),
    operations: [entry(project, operation, generate(project, operation))],
    holdsCrossAxis: true,
  }
}

/**
 * One toolpath through the real generator, refusing anything that warns. A
 * finish on its own is the fixture's design, so its advisory "no rough before
 * this finish" note (#1045) is expected; every other warning still fails.
 */
function generate(project: Project, operation: Operation): ToolpathResult {
  const envelope = computeOperationToolpath(project, operation)
  if (!envelope) throw new Error(`${operation.name} generated no toolpath`)
  const warnings = envelope.result.warnings.filter(
    (warning) => warning.code !== 'rotaryFinishWithoutRough',
  )
  if (warnings.length > 0) {
    throw new Error(`${operation.name} generated warnings: ${JSON.stringify(warnings)}`)
  }
  return envelope.result
}

function entry(
  project: Project,
  operation: Operation,
  toolpath: ToolpathResult,
): PostProcessorInput['operations'][number] {
  const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
  if (!tool) throw new Error(`no tool ${operation.toolRef} for ${operation.name}`)
  return { operation, tool: normalizeToolForProject(tool, project), toolpath }
}

/**
 * The hand-built program every control is one deliberate change away from: a
 * rapid that establishes the angle above the bar, a plunge, and two turning
 * cuts — the shape the conformance corpus already exports for an own-axis
 * rotary. Every point sits on the bar's centreline (project Y = 10, the default
 * origin's cross), so the machine frame's cross coordinate is 0 throughout.
 */
const SMOKE_MOVES: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 10, y: 10, z: 30, a: 0 }, to: { x: 20, y: 10, z: 30, a: 0 } },
  { kind: 'plunge', from: { x: 20, y: 10, z: 30, a: 0 }, to: { x: 20, y: 10, z: 14, a: 0 } },
  { kind: 'cut', from: { x: 20, y: 10, z: 14, a: 0 }, to: { x: 40, y: 10, z: 14, a: 90 } },
  { kind: 'cut', from: { x: 40, y: 10, z: 14, a: 90 }, to: { x: 50, y: 10, z: 14, a: 90 } },
]

function smokeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 't1',
    name: 'Smoke endmill',
    units: 'mm',
    type: 'flat_endmill',
    diameter: 3,
    maxCutDepth: 25,
  }
}

/**
 * The smoke project: a 20 mm round bar along X with the default origin on its
 * centreline, an Around setup holding the operation, and a Top setup alongside
 * so the manual-index control only has to move the operation.
 */
function smokeProject(options: { offCentreOrigin?: boolean; topSetup?: boolean } = {}): Project {
  const { offCentreOrigin = false, topSetup = false } = options
  const base = newProject('Cross axis smoke', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  const stock = roundStock(20, 100, 'x')
  base.stock = stock
  base.tools = [smokeTool()]
  // The default origin is on the centreline; the off-centre control puts it on
  // the bar's back edge, where the machine cross coordinate is the bar's radius.
  base.origin = offCentreOrigin
    ? { name: 'Origin', x: 0, y: 0, z: stock.thickness, visible: true }
    : defaultOrigin(stock)
  const top: MachiningSetup = {
    id: 'setup-top',
    name: 'Top',
    orientation: { axis: 'x', angleDeg: 0 },
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  }
  const around: MachiningSetup = { ...top, id: 'around', name: 'Around', kind: 'around' }
  base.setups = [top, around]
  const operation: Operation = {
    ...defaultOperationForTarget({ ...base, stock }, 'pocket', 'rough', { source: 'stock' }, 0),
    id: 'smoke',
    name: 'Smoke',
    setupId: topSetup ? top.id : around.id,
    toolRef: 't1',
  }
  return {
    ...base,
    activeSetupId: topSetup ? top.id : around.id,
    operations: [operation],
  }
}

function smokeCase(options: {
  name: string
  offCentreOrigin?: boolean
  topSetup?: boolean
  toolChangeNamesCrossAxis?: boolean
  holdsCrossAxis: boolean
}): CrossAxisProgram {
  const project = smokeProject(options)
  const operation = project.operations[0]
  const toolpath: ToolpathResult = {
    operationId: operation.id,
    warnings: [],
    bounds: null,
    moves: SMOKE_MOVES,
  }
  return {
    name: options.name,
    project,
    definition: options.toolChangeNamesCrossAxis
      ? machineWithCrossAxisToolChange('x')
      : ownAMachine('x'),
    operations: [entry(project, operation, toolpath)],
    holdsCrossAxis: options.holdsCrossAxis,
  }
}

/**
 * Every program, in golden-file order. The names are the golden's keys and the
 * test's case names; changing one is a re-freeze, not a rename.
 */
export function crossAxisPrograms(): CrossAxisProgram[] {
  return [
    // ── the rule holds: no cross word at all ──
    modelProgram({ name: 'around-rough-mm', kind: 'rotary_rough', direction: 'around' }),
    modelProgram({ name: 'around-finish-mm', kind: 'rotary_finish', direction: 'around' }),
    modelProgram({ name: 'around-rough-inch', units: 'inch', kind: 'rotary_rough', direction: 'around' }),
    modelProgram({ name: 'around-finish-inch', units: 'inch', kind: 'rotary_finish', direction: 'around' }),
    modelProgram({ name: 'square-around-rough-mm', kind: 'rotary_rough', direction: 'around', shape: 'square' }),
    // A bar along Y whose program runs along it: the cross axis is X, which is
    // dropped, and Y — real travel here — is kept. Also the along-the-bar case.
    modelProgram({ name: 'along-bar-y-rough-mm', axis: 'y', kind: 'rotary_rough', direction: 'along' }),

    // ── controls: today's bytes ──
    smokeCase({ name: 'smoke-rule-holds', holdsCrossAxis: true }),
    smokeCase({ name: 'control-tool-change-names-cross-axis', toolChangeNamesCrossAxis: true, holdsCrossAxis: false }),
    smokeCase({ name: 'control-origin-off-centreline', offCentreOrigin: true, holdsCrossAxis: false }),
    smokeCase({ name: 'control-manual-index-top-setup', topSetup: true, holdsCrossAxis: false }),
  ]
}

/**
 * The machine letter a program's cross coordinate is written under: the machine
 * axis this definition maps the bar's across project axis to. Y for a bar along
 * X and X for a bar along Y on every bundled machine, and derived here so an
 * inverted or permuted coordinate system is read the same way the rule reads it.
 */
export function crossAxisLetter(program: CrossAxisProgram): 'X' | 'Y' {
  const { stock } = program.project
  if (!isBarStock(stock)) throw new Error(`${program.name}: not a bar`)
  const mapping = stock.axis === 'x'
    ? program.definition.coordinateSystem.yAxis
    : program.definition.coordinateSystem.xAxis
  const letter = mapping.replace('-', '')
  if (letter !== 'X' && letter !== 'Y') throw new Error(`${program.name}: the cross axis is not horizontal`)
  return letter
}

/** Emit one program exactly as the export path does. Tool changes are on, so
 *  the tool-change control has a block to write. */
export function renderCrossAxisProgram(program: CrossAxisProgram): PostProcessorResult {
  return runPostProcessor({
    project: program.project,
    definition: program.definition,
    operations: program.operations,
    options: { emitToolChanges: true, emitCoolant: false, programName: program.project.meta.name },
  })
}
