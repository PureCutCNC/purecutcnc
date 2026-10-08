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
 * The dialect-neutral half of export (issue #953). Every output dialect
 * decides *what the machine does* here and only *how a line is spelled* in its
 * own emitter (`postprocessor.ts` for G-code, `opensbpEmitter.ts` for ShopBot):
 *
 * - the sequencing of a program: when the tool changes, when the spindle is
 *   started, restated at a new speed and stopped, when coolant comes on, and
 *   the warnings for what was asked for but cannot be written,
 * - the project → machine coordinate transform, for moves and for drill
 *   cycles alike — nothing outside this file calls `projectToMachinePoint`
 *   during export. That includes the turn of the operation's machining setup
 *   (issue #944): a Bottom operation's stock-space toolpath is turned into
 *   its setup's frame here, once, and no emitter knows a setup exists,
 * - which setup a program is for (issue #946): the header lines that tell the
 *   operator how the part must sit, and the refusal to run one program across
 *   a manual turn of the part,
 * - arc fitting, and the emitted-arc validation that falls a run back to its
 *   original linear moves when the formatted block would be rejected,
 * - the warnings those steps raise,
 * - the motion trace the exported-motion debug view compares against, and
 * - the safe-Z split of a rapid.
 *
 * A dialect that changes any of these changes them for every machine, so new
 * behaviour belongs here and new syntax belongs in an emitter. The cost of
 * getting that wrong is two emitters drifting apart: a spindle-speed change
 * that one dialect restated and the other silently dropped is what moved
 * sequencing in here (issue #953).
 */

import type { Operation, Project } from '../../types/project'
import type { DrillCycle, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import { exportGeometryTolerance, MM_PER_INCH } from '../../utils/units'
import { applyEmittedArcFallback, fitArcsInMachineMoves } from './arcFitting'
import type { ArcMoveDescriptor, EmittedArcOptions, FittedMoveDescriptor } from './arcFitting'
import type { MachineDefinition, OperationMotionTrace, PostProcessorInput } from './types'
import { isSelectableQtPlasmacMaterialNumber } from '../../toolPolicy'
import { setupForOperation, setupFrameForOperation } from '../setupOrientation'
import { setupGenerationBlock } from '../setupTargets'
import { projectExportsPerSetup, setupHeaderLines, setupLacksRegistration } from './setupPrograms'
import { formatGCodeNumber, projectToMachinePoint } from './utils'

/** Largest sweep a single emitted arc may cover, in degrees. */
const MAX_ARC_SWEEP_DEG = 90

/**
 * Formats a value exactly as it will be written, parsed back to a number.
 * Arc validation must judge the numbers the controller reads, not ours.
 */
export function createEmittedValueFormatter(
  definition: MachineDefinition,
  outputUnits: 'mm' | 'inch',
): (value: number) => number {
  return (value) => Number(formatGCodeNumber(value, definition, outputUnits))
}

/**
 * Everything the emitted-arc resolver needs to reproduce, and satisfy, what
 * the controller will compute from the formatted words.
 */
export function createArcEmitOptions(
  definition: MachineDefinition,
  outputUnits: 'mm' | 'inch',
  arcFormat: EmittedArcOptions['arcFormat'],
): EmittedArcOptions {
  return {
    format: createEmittedValueFormatter(definition, outputUnits),
    arcFormat,
    // Controllers convert to millimetres before checking, so an inch program
    // faces the same absolute budget.
    mmPerOutputUnit: outputUnits === 'mm' ? 1 : MM_PER_INCH,
    // The output grid I/J can be snapped onto. `decimalPlaces` is normalised
    // to a per-unit object by the definition schema.
    quantum: Math.pow(10, -definition.numberFormat.decimalPlaces[outputUnits]),
  }
}

// ── Program sequencing ────────────────────────────────────────

/** What a dialect has to write around one operation's moves, and in what order. */
export interface OperationSequence {
  /** 1-based position of the tool in the project's tool list. */
  toolNumber: number
  rpm: number
  /** Cutting feed in project units per minute. */
  cutFeed: number
  /** Plunge feed in project units per minute. */
  plungeFeed: number
  /** Write the tool change before this operation. */
  changeTool: boolean
  /** The spindle is still running when that tool change is reached. The
   *  sequence stops it after the operation before, so this is false today; an
   *  emitter still honours it rather than assume it. */
  spindleRunningAtToolChange: boolean
  /** State "spindle on at `rpm`" before the first move: the spindle is
   *  stopped, or it is running at a different speed. */
  startSpindle: boolean
  /** Turn coolant on before the first move. */
  startCoolant: boolean
  /** Stop the spindle after the last move: the program ends here, or a tool
   *  change that will actually be written comes next. */
  stopSpindleAfter: boolean
  /** Raised for this operation, in order; the caller appends them to its own. */
  warnings: ToolpathWarning[]
  /** Present on a plasma machine whose torch path is written (issue #959).
   *  Every spindle, coolant and tool-change flag above is then false. */
  plasma?: PlasmaOperationSequence
}

/** What a plasma program writes around one operation's cuts (issue #959). */
export interface PlasmaOperationSequence {
  /** Not a plasma operation: leave it out of the program. */
  skip: boolean
  /** The tool's selectable QtPlasmaC material, or null when it has none (an
   *  absent number, 0, or the reserved 1000000+ temporary range). */
  materialNumber: number | null
  /** Write the material handshake before this operation's first torch-on:
   *  it is the first plasma operation, or the material differs from the one
   *  selected before. */
  selectMaterial: boolean
}

/** What the sequence needs to know about the machine a dialect writes for. */
export interface SequenceCapabilities {
  /** The dialect has coolant commands to write for this machine. */
  coolant: boolean
  /** False when this definition cannot execute a requested tool change. */
  toolChange?: boolean
  /** Metadata-only plasma support: the definition describes a plasma table
   *  whose torch path is not written yet (G-code piercing, #983). */
  plasmaOutputPending?: boolean
  /** A plasma table whose torch path is written (issue #959). */
  plasmaTorch?: boolean
}

/**
 * Decide, once for every dialect, what happens between the operations of a
 * program. Returns one entry per operation, in order.
 */
export function planProgramSequence(
  input: Pick<PostProcessorInput, 'project' | 'operations' | 'options'>,
  capabilities: SequenceCapabilities,
): OperationSequence[] {
  const { project, operations, options } = input
  if (capabilities.plasmaTorch) {
    return planPlasmaSequence(input, capabilities)
  }
  let currentToolId: string | null = null
  let spindleOn = false
  let spindleSpeed: number | null = null
  let coolantOn = false

  return operations.map(({ operation, tool }, opIndex) => {
    const warnings: ToolpathWarning[] = []
    if (opIndex === 0 && capabilities.plasmaOutputPending) warnings.push({ code: 'postPlasmaOutputPending' })
    const toolIndex = project.tools.findIndex((candidate) => candidate.id === tool.id) + 1
    const rpm = operation.rpm || tool.defaultRpm

    // Tool change
    const toolChanged = currentToolId !== tool.id
    if (toolChanged && opIndex > 0 && capabilities.toolChange === false) {
      warnings.push({ code: 'postNoToolChangeCommands', params: { operation: operation.name, tool: tool.name } })
    }
    const changeTool = toolChanged && options.emitToolChanges
    const spindleRunningAtToolChange = changeTool && spindleOn
    if (changeTool) {
      // The spindle is started afresh after a change. It is already stopped
      // here — the operation before a written change always stops it — so
      // this only keeps the sequence coherent should that ever stop holding.
      spindleOn = false
    } else if (toolChanged && opIndex > 0) {
      warnings.push({ code: 'postToolChangesDisabled', params: { operation: operation.name, tool: tool.name } })
    }
    // Tracked whether or not the change was written (issue #755). Writing on
    // demand and tracking are different questions: with tool changes off this
    // still has to say which tool the machine is actually holding, or every
    // later operation reads as a change and the same tool is reported as a
    // different one. The warning above is what reports the real, unexecuted
    // change; this keeps that report honest.
    currentToolId = tool.id

    // Spindle: started when stopped, and restated when the speed changes.
    const startSpindle = !spindleOn || spindleSpeed !== rpm
    if (startSpindle) {
      spindleOn = true
      spindleSpeed = rpm
    }

    // Coolant
    let startCoolant = false
    if (options.emitCoolant) {
      if (capabilities.coolant) {
        startCoolant = !coolantOn
        coolantOn = true
      } else {
        warnings.push({ code: 'postNoCoolantCommands' })
      }
    }

    const nextOp = operations[opIndex + 1]
    const toolWillChange = nextOp !== undefined && nextOp.tool.id !== tool.id
    const stopSpindleAfter = nextOp === undefined || (toolWillChange && options.emitToolChanges)
    if (stopSpindleAfter) {
      spindleOn = false
    }

    return {
      toolNumber: toolIndex > 0 ? toolIndex : 1,
      rpm,
      cutFeed: operation.feed || tool.defaultFeed,
      plungeFeed: operation.plungeFeed || tool.defaultPlungeFeed,
      changeTool,
      spindleRunningAtToolChange,
      startSpindle,
      startCoolant,
      stopSpindleAfter,
      warnings,
    }
  })
}

/**
 * The plasma half of `planProgramSequence` (issue #959). A torch is not a
 * spindle: nothing is started, restated or stopped around an operation, and no
 * tool-change or coolant word is written. The torch goes on and off per cut
 * (`planPlasmaPath`), and what changes between operations is the material.
 */
function planPlasmaSequence(
  input: Pick<PostProcessorInput, 'project' | 'operations' | 'options'>,
  capabilities: SequenceCapabilities,
): OperationSequence[] {
  const { project, operations, options } = input
  let currentToolId: string | null = null
  let selectedMaterial: number | null = null
  let coolantWarned = false
  return operations.map(({ operation, tool }) => {
    const warnings: ToolpathWarning[] = []
    const toolIndex = project.tools.findIndex((candidate) => candidate.id === tool.id) + 1
    const base = {
      toolNumber: toolIndex > 0 ? toolIndex : 1,
      rpm: 0,
      cutFeed: operation.feed || tool.defaultFeed,
      plungeFeed: operation.plungeFeed || tool.defaultPlungeFeed,
      changeTool: false,
      spindleRunningAtToolChange: false,
      startSpindle: false,
      startCoolant: false,
      stopSpindleAfter: false,
      warnings,
    }
    if (operation.kind !== 'plasma_profile') {
      warnings.push({ code: 'postPlasmaOperationSkipped', params: { operation: operation.name } })
      return { ...base, plasma: { skip: true, materialNumber: null, selectMaterial: false } }
    }
    if (options.emitCoolant && !capabilities.coolant && !coolantWarned) {
      warnings.push({ code: 'postNoCoolantCommands' })
      coolantWarned = true
    }
    // A different plasma tool is a different consumable set. Nothing in the
    // program pauses for the swap, so say so, as for any unexecuted change.
    if (currentToolId !== null && currentToolId !== tool.id) {
      warnings.push({ code: 'postNoToolChangeCommands', params: { operation: operation.name, tool: tool.name } })
    }
    currentToolId = tool.id
    // A stored number outside the selectable range is not a material: 0 is the
    // simulator's "nothing selected" sentinel and 1000000+ belongs to
    // QtPlasmaC's own temporary materials, which CAM must not emit. Both are
    // reported exactly like an absent number, so the export blocks.
    const material = tool.qtplasmacMaterialNumber
    const materialNumber = isSelectableQtPlasmacMaterialNumber(material) ? material : null
    if (materialNumber === null) {
      warnings.push({ code: 'postPlasmaMaterialMissing', params: { operation: operation.name, tool: tool.name } })
    }
    const selectMaterial = materialNumber !== null && materialNumber !== selectedMaterial
    if (selectMaterial) selectedMaterial = materialNumber
    return { ...base, plasma: { skip: false, materialNumber, selectMaterial } }
  })
}

// ── Plasma cuts ───────────────────────────────────────────────

/** One step of a plasma operation, in machine coordinates (issue #959). */
export type PlasmaPathItem =
  /** Travel with the torch off: only where it ends matters. */
  | { kind: 'travel'; to: ToolpathPoint }
  /** Fire at `pierce`, follow `moves` with the torch on, then turn it off. */
  | { kind: 'cut'; pierce: ToolpathPoint; moves: FittedMoveDescriptor[] }

/**
 * Group an operation's planned moves into torch-off travel and torch-on cuts.
 *
 * The plasma toolpath (`generatePlasmaProfileToolpath`, #957) writes each
 * contour as a rapid to the pierce point, a plunge to cut height, the lead-in,
 * the contour and the lead-out, then a rapid up. A cut therefore starts at a
 * plunge and ends at the next rapid; everything between, arcs included, is
 * cut with the torch on. Arc fitting never joins moves of different kinds, so
 * a fitted arc never spans a cut boundary.
 */
export function planPlasmaPath(steps: readonly FittedMoveDescriptor[]): PlasmaPathItem[] {
  const items: PlasmaPathItem[] = []
  let cut: Extract<PlasmaPathItem, { kind: 'cut' }> | null = null
  let position: ToolpathPoint | null = null
  for (const step of steps) {
    const end: ToolpathPoint = step.kind === 'linear'
      ? step.point
      : { x: step.endPoint.x, y: step.endPoint.y, z: position?.z ?? 0 }
    if (step.kind === 'linear' && step.moveKind === 'rapid') {
      cut = null
      items.push({ kind: 'travel', to: end })
    } else if (step.kind === 'linear' && step.moveKind === 'plunge') {
      cut = { kind: 'cut', pierce: end, moves: [] }
      items.push(cut)
    } else {
      // A cutting move with no plunge before it still needs the torch: it is
      // pierced where the head already is.
      if (!cut) {
        cut = { kind: 'cut', pierce: position ?? end, moves: [] }
        items.push(cut)
      }
      cut.moves.push(step)
    }
    position = end
  }
  return items
}

/** Two machine points on the same spot, within the fitting tolerance. */
function sameMachinePoint(a: ToolpathPoint, b: ToolpathPoint): boolean {
  return Math.abs(a.x - b.x) <= 1e-6 && Math.abs(a.y - b.y) <= 1e-6 && Math.abs(a.z - b.z) <= 1e-6
}

/**
 * Emit a complete counter-clockwise circle as a single arc block.
 *
 * QtPlasmaC's automatic hole handling (`#<holes>`, plan decision 3) only
 * recognises a hole from one G2/G3 block whose end is the point the previous
 * block left the torch at: its load filter reduces the feed when an arc's
 * declared end equals the current position (`check_if_hole` in
 * `qtplasmac_gcode.py`). Arc fitting splits every fitted run into ≤ 90°
 * sub-arcs, so a hole would be four quarter arcs and that reduction would
 * never run even though the header asked for it. Folding the sub-arcs of one
 * complete counter-clockwise circle back into one block makes the controller's
 * own reduction work, and matches the full-circle form the QtPlasmaC manual
 * uses for holes.
 *
 * Clockwise complete circles are deliberately left split. A closed clockwise
 * circle is a hole cut the wrong way round, which the same filter warns about,
 * and an outside contour is legitimately clockwise; folding only
 * counter-clockwise circles therefore cannot introduce that warning.
 *
 * Applied to plasma programs only, and before the motion trace is captured, so
 * the debug view reads the same descriptors the emitter writes.
 */
export function foldFullCircleArcs(moves: readonly FittedMoveDescriptor[]): FittedMoveDescriptor[] {
  const folded: FittedMoveDescriptor[] = []
  let index = 0
  while (index < moves.length) {
    const first = moves[index]
    if (first.kind !== 'arc' || first.clockwise) {
      folded.push(first)
      index += 1
      continue
    }
    let end = index + 1
    while (end < moves.length) {
      const next = moves[end]
      if (next.kind !== 'arc' || next.clockwise || next.runId !== first.runId) break
      end += 1
    }
    const run = moves.slice(index, end) as ArcMoveDescriptor[]
    const last = run[run.length - 1]
    if (run.length > 1 && sameMachinePoint(last.endPoint, first.startPoint)) {
      folded.push({ ...first, endPoint: { ...first.startPoint } })
    } else {
      folded.push(...run)
    }
    index = end
  }
  return folded
}

// ── The program's setup ───────────────────────────────────────

/** What a dialect writes, and reports, about the setup a program is for. */
export interface ProgramSetupPlan {
  /**
   * Lines to write as comments after the program header, in order: which
   * setup this is and how the stock is turned, what locates the part, where
   * to touch off, and the operator's notes. Empty for a project with a single
   * setup, whose program is exactly what it was before setups existed.
   */
  headerComments: string[]
  /** Raised for the program as a whole; the caller appends them to its own. */
  warnings: ToolpathWarning[]
}

/**
 * Decide, once for every dialect, what a program says about its setup.
 *
 * A program belongs to exactly one setup: the operator turns the part by hand
 * between setups, and nothing in a program does it for them. Operations of
 * two setups in one program are therefore reported as an error and the header
 * is left out, rather than a header written for one of them.
 */
export function planProgramSetup(
  input: Pick<PostProcessorInput, 'project' | 'operations'>,
): ProgramSetupPlan {
  const { project, operations } = input
  const warnings: ToolpathWarning[] = []

  // An operation its setup may not cut was generated with no motion. A file
  // that silently lacks that pass must not be saved.
  for (const { operation } of operations) {
    if (setupGenerationBlock(project, operation)) {
      warnings.push({ code: 'postSetupOperationRefused', params: { operation: operation.name } })
    }
  }

  if (!projectExportsPerSetup(project)) return { headerComments: [], warnings }

  const setups = [...new Set(operations.map(({ operation }) => setupForOperation(project, operation)))]
  if (setups.length > 1) {
    warnings.push({
      code: 'postMixedSetups',
      params: { setups: setups.map((setup) => setup?.name ?? 'Top').join(', ') },
    })
    return { headerComments: [], warnings }
  }
  const setup = setups[0]
  if (!setup) return { headerComments: [], warnings }

  if (setupLacksRegistration(project, setup)) {
    warnings.push({ code: 'postSetupNoRegistration', params: { setup: setup.name } })
  }
  return { headerComments: setupHeaderLines(project, setup), warnings }
}

// ── Drill cycles ──────────────────────────────────────────────

/** One drill cycle in machine coordinates, for a dialect with canned cycles. */
export interface MachineDrillCycle {
  /** The source cycle: drill type, peck depth and dwell are not coordinates. */
  cycle: DrillCycle
  /** The hole position. */
  at: { x: number; y: number }
  /** The hole position at the clearance height. */
  clear: ToolpathPoint
  bottomZ: number
  retractZ: number
}

/**
 * Transform an operation's drill cycles into machine coordinates. The
 * operation is required: its setup decides the transform, and a caller that
 * could leave it out would drill a Bottom operation's holes unturned.
 */
export function planDrillCycles(
  project: Project,
  definition: MachineDefinition,
  cycles: readonly DrillCycle[],
  operation: Operation,
): MachineDrillCycle[] {
  // Undefined for a Top operation, which then takes the unturned path.
  const setup = setupFrameForOperation(project, operation)
  const toMachine = (cycle: DrillCycle, z: number): ToolpathPoint =>
    projectToMachinePoint({ x: cycle.x, y: cycle.y, z }, project.origin, definition, setup)
  return cycles.map((cycle) => {
    const at = toMachine(cycle, 0)
    return {
      cycle,
      at: { x: at.x, y: at.y },
      clear: toMachine(cycle, cycle.clearZ),
      bottomZ: toMachine(cycle, cycle.bottomZ).z,
      retractZ: toMachine(cycle, cycle.retractZ).z,
    }
  })
}

// ── Motion ────────────────────────────────────────────────────

export interface OperationMotionPlan {
  /** The moves to emit, in order, in machine coordinates. */
  steps: FittedMoveDescriptor[]
  /** Warnings raised while planning; the caller appends them to its own. */
  warnings: ToolpathWarning[]
  /** Present only when a trace was requested. */
  trace?: OperationMotionTrace
}

export interface PlanOperationMotionArgs {
  project: Project
  definition: MachineDefinition
  operation: Operation
  toolpath: ToolpathResult
  arcEmitOptions: EmittedArcOptions
  /** Where the controller already is when this operation begins — the
   *  emitted position carried over from earlier operations. */
  startPosition: { x: number; y: number } | null
  /** Debug-only (issue #356): also return the machine-coordinate trace. */
  captureTrace: boolean
}

/**
 * Turn one operation's toolpath into the machine-coordinate moves an emitter
 * writes out. Arc fitting runs when the operation asks for it and the machine
 * can interpolate arcs; otherwise every move stays linear.
 */
export function planOperationMotion(args: PlanOperationMotionArgs): OperationMotionPlan {
  const { project, definition, operation, toolpath, arcEmitOptions, startPosition, captureTrace } = args
  const warnings: ToolpathWarning[] = []

  const arcEnabled = operation.arcFittingEnabled ?? true
  const machineHasArcs = definition.motion.arcInterpolation === true
  const tryFit = arcEnabled && machineHasArcs

  // The operation's setup, when it turns the stock; undefined for Top, which
  // then takes the unturned path. Arc direction needs no handling of its own:
  // arcs are fitted to the moves after this transform, so a mirrored plan
  // view yields the mirrored sense.
  const setup = setupFrameForOperation(project, operation)

  // Transform every move into machine coordinates once.
  const transformMoves = (): ToolpathMove[] =>
    toolpath.moves.map((move) => ({
      ...move,
      from: projectToMachinePoint(move.from, project.origin, definition, setup),
      to: projectToMachinePoint(move.to, project.origin, definition, setup),
    }))
  const tolerance = exportGeometryTolerance(project.meta.units)

  let machineMoves: ToolpathMove[] | null = null
  let steps: FittedMoveDescriptor[]

  if (tryFit) {
    // Fit arcs, then drop any run the controller would reject once formatted.
    machineMoves = transformMoves()
    const resolved = applyEmittedArcFallback(
      fitArcsInMachineMoves(machineMoves, tolerance, MAX_ARC_SWEEP_DEG),
      arcEmitOptions,
      startPosition,
    )
    if (resolved.fallbackRuns > 0) {
      warnings.push({
        code: 'postArcFallbackLinear',
        params: { operation: operation.name, count: resolved.fallbackRuns },
      })
    }
    steps = resolved.descriptors
  } else {
    if (arcEnabled && !machineHasArcs) {
      // Fitting was asked for but the machine cannot do it: say so only when
      // arcs *would* have been found.
      machineMoves = transformMoves()
      const foundArcs = fitArcsInMachineMoves(machineMoves, tolerance, MAX_ARC_SWEEP_DEG)
        .some((descriptor) => descriptor.kind === 'arc')
      if (foundArcs) {
        warnings.push({
          code: 'postArcNoCapability',
          params: { operation: operation.name },
        })
      }
    }
    steps = toolpath.moves.map((move) => ({
      kind: 'linear',
      point: projectToMachinePoint(move.to, project.origin, definition, setup),
      moveKind: move.kind,
      source: move.source,
      feedScale: move.feedScale,
    }))
  }

  // QtPlasmaC identifies a hole from a single closed arc block; a plasma
  // program folds one back together so its own feed reduction can run (see
  // `foldFullCircleArcs`). Done before the trace is captured so the exported
  // motion the debug view compares is the motion that was emitted.
  if (definition.plasma?.pierceMode === 'controller') {
    steps = foldFullCircleArcs(steps)
  }

  if (!captureTrace) {
    return { steps, warnings }
  }

  return {
    steps,
    warnings,
    trace: {
      operationId: operation.id,
      machineMoves: machineMoves ?? transformMoves(),
      // Only the descriptors that were actually emitted as arcs or lines by a
      // fitting run: the debug view never draws an arc on a span that fell
      // back to linear moves.
      descriptors: tryFit ? steps : [],
      tryFit,
    },
  }
}

/**
 * Split one rapid into the blocks that are emitted for it: Z on its own
 * first, then XY. An axis group that does not move is dropped, and a rapid
 * from an unknown position emits both.
 */
export function splitRapid(
  current: ToolpathPoint | null,
  target: ToolpathPoint,
): Array<Partial<ToolpathPoint>> {
  const blocks: Array<Partial<ToolpathPoint>> = []
  if (current === null || current.z !== target.z) {
    blocks.push({ z: target.z })
  }
  if (current === null || current.x !== target.x || current.y !== target.y) {
    blocks.push({ x: target.x, y: target.y })
  }
  return blocks
}
