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
import { isRoundStock, roundStockCentre } from '../../types/project'
import type { DrillCycle, NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import { convertLength, exportGeometryTolerance, MM_PER_INCH } from '../../utils/units'
import { applyEmittedArcFallback, fitArcsInMachineMoves } from './arcFitting'
import type { ArcMoveDescriptor, EmittedArcOptions, FittedMoveDescriptor } from './arcFitting'
import type { MachineDefinition, OperationMotionTrace, PlasmaTouchOff, PostProcessorInput } from './types'
import { rotaryBorrowedAxis, rotaryWord } from './types'
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
  /** A plasma table whose torch path the controller owns (QtPlasmaC, #959). */
  plasmaTorch?: boolean
  /** A plasma table whose torch path the program owns (G-code piercing, #983). */
  plasmaGcode?: boolean
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
  if (capabilities.plasmaTorch || capabilities.plasmaGcode) {
    return planPlasmaSequence(input, capabilities)
  }
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
 * The plasma half of `planProgramSequence` (issues #959, #983). A torch is not a
 * spindle: nothing is started, restated or stopped around an operation, and no
 * tool-change or coolant word is written. The torch goes on and off per cut
 * (`planPlasmaPath`). Controller piercing changes the material between
 * operations; G-code piercing owns the heights itself and has no material
 * table, so the tool's QtPlasmaC material number is ignored.
 */
function planPlasmaSequence(
  input: Pick<PostProcessorInput, 'project' | 'operations' | 'options'>,
  capabilities: SequenceCapabilities,
): OperationSequence[] {
  const { project, operations, options } = input
  const controllerPiercing = capabilities.plasmaTorch === true
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
    // reported exactly like an absent number, so the export blocks. Only
    // controller piercing reads the field; a G-code pierce machine has no
    // material table to select on (#983).
    const material = tool.qtplasmacMaterialNumber
    const materialNumber = controllerPiercing && isSelectableQtPlasmacMaterialNumber(material) ? material : null
    if (controllerPiercing && materialNumber === null) {
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

// ── G-code-owned piercing (#983) ──────────────────────────────

/** The heights and touch-off of one G-code-pierced plasma cut, in output units. */
export interface PlasmaGcodeCut {
  /** Safe height from the toolpath, in the operator's own zero (machine Z).
   *  Valid only until the program's first touch-off. */
  safeZ: number
  /** The same safe height measured from the sheet surface: what every safe
   *  rapid and retract is written as once a touch-off has put Z zero there. */
  sheetSafeZ: number
  /** Pierce height above the sheet surface, from the tool. */
  pierceHeight: number
  /** Cut height above the sheet surface, from the tool. */
  cutHeight: number
  /** Seconds to dwell after the torch fires. */
  pierceDelay: number
  /** Probe distance below the current Z zero. */
  probeDepth: number
  /** Probe feed. */
  probeFeed: number
  /** Travel of a floating head before its switch trips; 0 when the definition
   *  leaves the optional offset out. */
  switchOffset: number
}

/**
 * The machine-coordinate safe Z a plasma operation retracts to.
 *
 * Every rapid in the #957 toolpath ends at safe height — the retract after a
 * contour and the travel to the next pierce alike — so any rapid's Z is it.
 * The first contour has no travel rapid before its plunge, which is why this
 * reads the fitted steps rather than the travel items `planPlasmaPath` builds.
 */
export function plasmaSafeZ(steps: readonly FittedMoveDescriptor[]): number | null {
  for (const step of steps) {
    if (step.kind === 'linear' && step.moveKind === 'rapid') return step.point.z
  }
  return null
}

/**
 * The machine-coordinate Z of the sheet surface for a plasma operation: the
 * stock top the #957 toolpath measures its heights from, mapped exactly as the
 * operation's moves are (setup, origin and axis mapping). It is 0 only when
 * the operator's Z zero is on the sheet top.
 */
export function plasmaSheetZ(project: Project, definition: MachineDefinition, operation: Operation): number {
  const setup = setupFrameForOperation(project, operation)
  return projectToMachinePoint({ x: 0, y: 0, z: project.stock.thickness }, project.origin, definition, setup).z
}

/**
 * Resolve one G-code-pierced plasma cut into the numbers the emitter writes
 * (#983).
 *
 * Heights come from the tool, not the toolpath: the probe sets Z zero on the
 * sheet, so pierce and cut heights are measured from the sheet surface and are
 * emitted as configured — even when pierce height is the lower of the two. The
 * safe height comes from the toolpath and is resolved in both frames: the
 * operator's zero for the rapid before the program's first touch-off, and the
 * sheet surface (`safeZ - sheetZ`) for everything after one, because the
 * touch-off moved Z zero and the operator's number no longer means the same
 * height. The touch-off fields are stored in millimetres and millimetres per
 * minute whatever the project units, so they are converted here, once, and an
 * absent switch offset is 0.
 */
export function planPlasmaGcodeCut(args: {
  tool: NormalizedTool
  touchOff: PlasmaTouchOff
  units: 'mm' | 'inch'
  safeZ: number
  /** Machine Z of the sheet surface (`plasmaSheetZ`). */
  sheetZ: number
}): PlasmaGcodeCut {
  const { tool, touchOff, units, safeZ, sheetZ } = args
  return {
    safeZ,
    sheetSafeZ: safeZ - sheetZ,
    pierceHeight: tool.pierceHeight ?? 0,
    cutHeight: tool.cutHeight ?? 0,
    pierceDelay: tool.pierceDelay ?? 0,
    probeDepth: convertLength(touchOff.probeDepth, 'mm', units),
    probeFeed: convertLength(touchOff.probeFeed, 'mm', units),
    switchOffset: convertLength(touchOff.switchOffset ?? 0, 'mm', units),
  }
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
 * Center format only. In radius format LinuxCNC makes an arc whose end is its
 * current point an error, so folding there would produce a block the
 * controller rejects. The caller leaves an R-format machine the ≤ 90° sub-arcs
 * the emitted-arc fallback already validated: folding runs after that
 * validation, so the representation it creates is never itself checked.
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
// ── Rotary axis (#393) ────────────────────────────────────────

/** What the emitter writes for one move's feed (issue #393, rule 4). */
export type FeedDirective =
  /** An ordinary feed word, in project units per minute. */
  | { mode: 'normal'; feed: number }
  /** Inverse-time feed: the word carries `1/min` and every such move repeats
   *  it, whatever the definition's `modalFeedSpeed` says. */
  | { mode: 'inverse'; feed: number }
  /** A rapid, or no feed at all: no feed word is written. */
  | { mode: 'none' }

/** The bar's centreline and the project axis it lies along, in project space. */
export interface RotaryCentreline {
  /** The PROJECT axis the bar lies along and turns about. */
  axis: 'x' | 'y'
  /** A point on the centreline. Only the axes across the bar and its height are
   *  read, so the coordinate along the bar is irrelevant. */
  point: ToolpathPoint
}

/** The centreline of the project's round bar, or null when the stock is a block. */
export function rotaryCentreline(stock: Project['stock']): RotaryCentreline | null {
  if (!isRoundStock(stock)) return null
  return {
    axis: stock.axis,
    // The bar's axis sits at Z = thickness / 2 (issue #392); across the bar it
    // is the stock rectangle's centreline. The along-bar coordinate is unused.
    point: {
      x: stock.axis === 'x' ? 0 : roundStockCentre(stock),
      y: stock.axis === 'x' ? roundStockCentre(stock) : 0,
      z: stock.thickness / 2,
    },
  }
}

/**
 * How far the cutter tip at `point` is from the bar's centreline, in the plane
 * across the bar (issue #393). Both the offset across the bar and the height
 * above the centreline count: a shallow cut on the side of the bar and a deep
 * one on top turn through arcs of different length, which is why a turning
 * move's feed cannot be the ordinary one.
 *
 * `point` and `centre` must be in the same frame. The distance is invariant
 * under the project → machine transform — a signed axis permutation plus
 * translation — so either frame gives the same number.
 */
function turningRadius(point: ToolpathPoint, centre: RotaryCentreline): number {
  return centre.axis === 'x'
    ? Math.hypot(point.y - centre.point.y, point.z - centre.point.z)
    : Math.hypot(point.x - centre.point.x, point.z - centre.point.z)
}

/**
 * The inverse-time feed word for one turning feed move: `feed / length` in
 * 1/min, where `length` is the true path length at the cutter tip,
 * `sqrt(linear² + (r × Δθ)²)`. `linear` is the straight-line distance over the
 * linear axes that move; `Δθ` is the angle the stock turns through, in radians;
 * `r` is the mean of the move's two ends' distance from the bar's centreline.
 *
 * Exported alone so the arithmetic can be tested without an export. The length
 * is never taken below `tolerance`, so a move that neither travels nor turns
 * yields a finite word rather than an infinity.
 */
export function inverseTimeFeedValue(
  from: ToolpathPoint,
  to: ToolpathPoint,
  feed: number,
  centre: RotaryCentreline,
  tolerance: number,
): number {
  const linear = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const sweep = (Math.abs((to.a ?? 0) - (from.a ?? 0)) * Math.PI) / 180
  const radius = (turningRadius(from, centre) + turningRadius(to, centre)) / 2
  // `Math.max` floors the divisor at the tolerance: a zero-length move would
  // otherwise divide by zero and write `FInfinity`.
  const length = Math.max(Math.hypot(linear, radius * sweep), tolerance)
  return feed / length
}

/** Absent means no rotary component, so it matches only another absent one. */
function sameAngle(a: number | undefined, b: number | undefined): boolean {
  return a === b
}

/** True when a move changes the stock's angle over its span (rule 2). */
function turns(move: ToolpathMove): boolean {
  return !sameAngle(move.from.a, move.to.a)
}

/**
 * The angle a project move ends at in the program's own direction, or
 * `undefined` when it has none. `projectToMachinePoint` already multiplied the
 * step's point by `rotaryDirection`, so a step's angle is compared against this
 * rather than the raw `move.to.a`.
 */
function machineEndAngle(move: ToolpathMove, direction: 1 | -1): number | undefined {
  return move.to.a === undefined ? undefined : move.to.a * direction
}

/**
 * Plan the feed word of every move of one operation (issue #393, rule 4).
 *
 * `steps` is the emitted sequence and `projectMoves` the operation's own moves,
 * in the same order, one entry per emitted block: a linear descriptor covers
 * exactly one source move, and an arc run covers exactly the source moves in its
 * `runFallback`. The two are therefore consumed together, recovering the
 * project-space endpoints the rotary arithmetic needs without matching machine
 * coordinates back to source points (a synthesised sub-arc endpoint matches no
 * source point, which is what makes matching unreliable).
 *
 * `centre` is null for a block of stock: there is no centreline and no turning
 * move can exist, so every feed is the ordinary one. `effectiveFeed` reuses the
 * caller's own feed (kind and `feedScale` included), so a turning move is not
 * given a different base feed from the one it would have had.
 *
 * The pairing is by position, so a drift between the two sequences would
 * silently give a turning move the ordinary feed, or measure its path from
 * another move's endpoints. Every linear step is therefore checked against the
 * move it was paired with before that move's numbers are used (issue #393): a
 * missing move, or a step whose angle disagrees with the move's end angle, is
 * an error rather than a wrong program. `operationName` names the operation in
 * that error. `direction` is `rotaryDirection(definition)`, the factor the
 * step's point already carries.
 */
export function planStepFeeds(args: {
  projectMoves: readonly ToolpathMove[]
  steps: readonly FittedMoveDescriptor[]
  centre: RotaryCentreline | null
  tolerance: number
  effectiveFeed: (step: FittedMoveDescriptor) => number
  operationName: string
  direction: 1 | -1
}): FeedDirective[] {
  const { projectMoves, steps, centre, tolerance, effectiveFeed, operationName, direction } = args
  const directives: FeedDirective[] = []
  let moveIndex = 0
  let arcRunId: number | null = null

  for (const step of steps) {
    if (step.kind === 'arc') {
      // Every sub-arc of a run shares `runFallback`; the run's source moves are
      // consumed once, when its first sub-arc is seen.
      if (step.runId !== arcRunId) {
        moveIndex += step.runFallback.length
        arcRunId = step.runId
      }
      directives.push({ mode: 'normal', feed: effectiveFeed(step) })
      continue
    }

    const move = projectMoves[moveIndex]
    moveIndex += 1

    if (move === undefined || !sameAngle(step.point.a, machineEndAngle(move, direction))) {
      throw new Error(
        `Export plan for "${operationName}" is inconsistent with its toolpath: emitted move ${moveIndex} `
        + `does not match the toolpath move it was paired with`,
      )
    }

    if (step.moveKind === 'rapid') {
      directives.push({ mode: 'none' })
      continue
    }
    if (centre === null || sameAngle(move.from.a, move.to.a)) {
      directives.push({ mode: 'normal', feed: effectiveFeed(step) })
      continue
    }
    directives.push({
      mode: 'inverse',
      feed: inverseTimeFeedValue(move.from, move.to, effectiveFeed(step), centre, tolerance),
    })
  }
  return directives
}

/** Whether the operation's moves leave the borrowed motor's project axis alone. */
function withinBorrowedAxisTravel(
  moves: readonly ToolpathMove[],
  axis: 'x' | 'y',
  tolerance: number,
): boolean {
  const coordinate = (point: ToolpathPoint): number => axis === 'x' ? point.x : point.y
  let min = Infinity
  let max = -Infinity
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      const value = coordinate(point)
      if (value < min) min = value
      if (value > max) max = value
    }
  }
  return min === Infinity || max - min <= tolerance
}

/** Drop the borrowed motor's coordinate: that letter carries the angle instead. */
function suppressBorrowedAxis(point: ToolpathPoint, axis: 'x' | 'y'): ToolpathPoint {
  const { x, y, z, ...rest } = point
  return { ...rest, x, y, z, [axis]: undefined } as unknown as ToolpathPoint
}

/**
 * Remove the borrowed motor's linear coordinate from a planned sequence. The
 * angle still reaches the program under that same machine letter (`rotaryWord`),
 * so a linear value there would be read as a second, contradictory angle.
 */
export function suppressBorrowedAxisInSteps(
  steps: readonly FittedMoveDescriptor[],
  axis: 'x' | 'y',
): FittedMoveDescriptor[] {
  return steps.map((step) => step.kind === 'linear'
    ? { ...step, point: suppressBorrowedAxis(step.point, axis) }
    : {
      ...step,
      startPoint: suppressBorrowedAxis(step.startPoint, axis),
      endPoint: suppressBorrowedAxis(step.endPoint, axis),
      runFallback: step.runFallback.map((fallback) => ({
        ...fallback,
        point: suppressBorrowedAxis(fallback.point, axis),
      })),
    })
}

/**
 * Why an operation cannot run on this machine's rotary axis, or null when it
 * can (issue #393, rule 5). Every reason is a refusal rather than an
 * approximation: a program that guesses at the angle cuts the part wrong.
 */
function rotaryRefusal(args: {
  definition: MachineDefinition
  project: Project
  toolpath: ToolpathResult
}): ToolpathWarning['code'] | null {
  const { definition, project, toolpath } = args
  // Rule 3 applies to every operation on a borrowed-motor machine, turning or
  // not: the borrowed project axis has no linear travel at all, so an operation
  // that moves along it cannot run here. Checked before the angle gate so a
  // flat operation is refused too.
  const borrowed = rotaryBorrowedAxis(definition)
  if (borrowed !== null
    && !withinBorrowedAxisTravel(toolpath.moves, borrowed, exportGeometryTolerance(project.meta.units))) {
    return 'postRotaryBorrowedAxisTravel'
  }
  const hasAngle = toolpath.moves.some((move) => move.from.a !== undefined || move.to.a !== undefined)
  if (!hasAngle) return null
  const rotary = definition.rotary
  if (!rotary || rotaryWord(definition) === null) return 'postRotaryNoAxis'
  if (rotary.inverseTimeFeed === null
    && toolpath.moves.some((move) => turns(move) && move.kind !== 'rapid')) {
    return 'postRotaryNoInverseTime'
  }
  if (!isRoundStock(project.stock)) return 'postRotaryNeedsRoundStock'
  return null
}

/**
 * The operations a rotary program cannot contain, each with the warning that
 * says why (issue #393, rule 5). An operation with no angle anywhere in it is
 * never refused for a rotary reason, so a machine with a rotary axis exports a
 * program that does not use it byte-identically.
 */
export function planRotaryRefusals(
  input: Pick<PostProcessorInput, 'project' | 'definition' | 'operations'>,
): { operations: PostProcessorInput['operations']; warnings: ToolpathWarning[] } {
  const { project, definition, operations } = input
  const warnings: ToolpathWarning[] = []
  const kept: PostProcessorInput['operations'] = []
  for (const entry of operations) {
    const code = rotaryRefusal({ definition, project, toolpath: entry.toolpath })
    if (code === null) {
      kept.push(entry)
      continue
    }
    warnings.push({
      code,
      params: {
        operation: entry.operation.name,
        ...(code === 'postRotaryBorrowedAxisTravel'
          ? { axis: (rotaryBorrowedAxis(definition) ?? '').toUpperCase() }
          : null),
      },
    })
  }
  return { operations: kept, warnings }
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
  const {
    project, definition, operation, toolpath, arcEmitOptions,
    startPosition, captureTrace,
  } = args
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
  // `foldFullCircleArcs`). Folding runs after the emitted-arc fallback, so it
  // is limited to center format: an R-format full circle is a LinuxCNC error,
  // and only the sub-arcs the fallback validated may be emitted there. Done
  // before the trace is captured so the exported motion the debug view
  // compares is the motion that was emitted.
  if (definition.plasma?.pierceMode === 'controller' && arcEmitOptions.arcFormat === 'ij') {
    steps = foldFullCircleArcs(steps)
  }

  // Rotary output (issue #393). The borrowed motor's letter carries the angle
  // on this machine, so its linear coordinate must never be emitted (rule 3).
  // The refusal planning has already rejected any operation that moves along
  // it. The emitter plans each move's feed from the operation's *project*
  // moves, so dropping the coordinate here cannot hide a move's linear travel
  // from the path length.
  const borrowedWord = rotaryWord(definition)
  if (rotaryBorrowedAxis(definition) !== null && (borrowedWord === 'X' || borrowedWord === 'Y')) {
    steps = suppressBorrowedAxisInSteps(steps, borrowedWord.toLowerCase() as 'x' | 'y')
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
 * Split one rapid into the blocks that are emitted for it.
 *
 * A rapid that does not turn keeps the split it has always had: Z first, then
 * XY, dropping an axis group that does not move, and emitting both from an
 * unknown position. The angle word is never written on a block that also
 * carries Z (issue #393): turning the bar while Z moves turns it while the tool
 * is still near the work, so a turning rapid turns at the *higher* of its two Z
 * values. When Z rises that is the ordinary order, with the angle on the XY
 * block; when Z falls or stays, the block carrying the angle is written first
 * and the Z block after it. A rotation-only rapid — every linear coordinate
 * unchanged — emits a single block carrying only the angle, so a move that
 * turns the stock is never silently dropped (rule 1).
 */
export function splitRapid(
  current: ToolpathPoint | null,
  target: ToolpathPoint,
): Array<Partial<ToolpathPoint>> {
  const angle = target.a
  // Only a real angle change is written; a rapid that keeps the angle produces
  // the pre-rotary blocks unchanged.
  const turning = angle !== undefined && angle !== current?.a

  const zChanges = current === null || current.z !== target.z
  const xyChanges = current === null
    || (target.x !== undefined && current.x !== target.x)
    || (target.y !== undefined && current.y !== target.y)

  const blocks: Array<Partial<ToolpathPoint>> = []
  // A rapid that does not turn keeps the split it has always had: Z first, then
  // XY. A rapid that turns may not turn the bar while Z moves, so the turn
  // happens at the higher of its two Z values (issue #393): Z rising is the
  // ordinary order with the angle on the XY block, and Z falling or unchanged
  // turns across first and drops afterwards.
  const zFirst = !turning || current === null || target.z >= current.z
  if (zFirst) {
    if (zChanges) blocks.push({ z: target.z })
    // The angle rides the XY block when there is one and otherwise a block of
    // its own — never the Z block, in either order (issue #393). Attaching it
    // to the last block written would put it on the Z block whenever Z rose
    // with no XY change.
    if (xyChanges) {
      blocks.push(turning ? { x: target.x, y: target.y, a: angle } : { x: target.x, y: target.y })
    } else if (turning) {
      blocks.push({ a: angle })
    }
    return blocks
  }

  // Z falls while turning: the angle rides the XY block when it moves, or a
  // block of its own otherwise, so the Z block is written last and never
  // carries it.
  if (xyChanges) blocks.push({ x: target.x, y: target.y, ...(angle !== undefined ? { a: angle } : null) })
  else blocks.push({ a: angle })
  if (zChanges) blocks.push({ z: target.z })
  return blocks
}
