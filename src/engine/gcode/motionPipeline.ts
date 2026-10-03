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
 *   during export,
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
import type { EmittedArcOptions, FittedMoveDescriptor } from './arcFitting'
import type { MachineDefinition, OperationMotionTrace, PostProcessorInput } from './types'
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
}

/** What the sequence needs to know about the machine a dialect writes for. */
export interface SequenceCapabilities {
  /** The dialect has coolant commands to write for this machine. */
  coolant: boolean
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
  let currentToolId: string | null = null
  let spindleOn = false
  let spindleSpeed: number | null = null
  let coolantOn = false

  return operations.map(({ operation, tool }, opIndex) => {
    const warnings: ToolpathWarning[] = []
    const toolIndex = project.tools.findIndex((candidate) => candidate.id === tool.id) + 1
    const rpm = operation.rpm || tool.defaultRpm

    // Tool change
    const toolChanged = currentToolId !== tool.id
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

/** Transform an operation's drill cycles into machine coordinates. */
export function planDrillCycles(
  project: Project,
  definition: MachineDefinition,
  cycles: readonly DrillCycle[],
): MachineDrillCycle[] {
  const toMachine = (cycle: DrillCycle, z: number): ToolpathPoint =>
    projectToMachinePoint({ x: cycle.x, y: cycle.y, z }, project.origin, definition)
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

  // Transform every move into machine coordinates once.
  const transformMoves = (): ToolpathMove[] =>
    toolpath.moves.map((move) => ({
      ...move,
      from: projectToMachinePoint(move.from, project.origin, definition),
      to: projectToMachinePoint(move.to, project.origin, definition),
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
      point: projectToMachinePoint(move.to, project.origin, definition),
      moveKind: move.kind,
      source: move.source,
      feedScale: move.feedScale,
    }))
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
