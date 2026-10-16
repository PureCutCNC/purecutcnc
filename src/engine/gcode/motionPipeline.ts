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
import { isRotaryOperationKind } from '../../types/project'
import { barCentre, barPivotZ, isBarStock, isSquareStock } from '../../types/barStock'
import type { DrillCycle, NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import { convertLength, exportGeometryTolerance, MM_PER_INCH } from '../../utils/units'
import { applyEmittedArcFallback, fitArcsInMachineMoves } from './arcFitting'
import type { ArcMoveDescriptor, EmittedArcOptions, FittedMoveDescriptor } from './arcFitting'
import type { MachineDefinition, OperationMotionTrace, PlasmaTouchOff, PostProcessorInput } from './types'
import { rotaryBorrowedAxis, rotaryDirection, rotaryWord } from './types'
import { isSelectableQtPlasmacMaterialNumber } from '../../toolPolicy'
import { setupForOperation, setupFrameForOperation } from '../setupOrientation'
import { setupGenerationBlock, squareRotaryWorkAdmitted } from '../setupTargets'
import { squareRotaryCutterRefusal } from '../squareRotarySafety'
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
  input: Pick<PostProcessorInput, 'project' | 'operations' | 'definition'>,
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
  return { headerComments: setupHeaderLines(project, setup, input.definition), warnings }
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

/**
 * The centreline of the project's bar — round or square — or null when the
 * stock is a block (#1016 C2-S4).
 *
 * A square blank turns about the same physical axis as a round bar of the same
 * box: the true pivot `side / 2` at the stock rectangle's centreline. The
 * corner radius is never the pivot; moving it there would turn the blank about
 * a point it does not rotate around. Every number here is identical to the
 * round bar's for a round stock, so an existing program's arithmetic is
 * unchanged.
 */
export function rotaryCentreline(stock: Project['stock']): RotaryCentreline | null {
  if (!isBarStock(stock)) return null
  const centre = barCentre(stock)
  return {
    axis: stock.axis,
    // The bar's axis sits at Z = thickness / 2 (issue #392); across the bar it
    // is the stock rectangle's centreline. The along-bar coordinate is unused.
    point: {
      x: stock.axis === 'x' ? 0 : centre,
      y: stock.axis === 'x' ? centre : 0,
      z: barPivotZ(stock),
    },
  }
}

/**
 * The two coordinates of `point` across and above the bar's centreline, in the
 * plane the bar turns in (issue #393). `point` and `centre` must be in the same
 * frame; both quantities are invariant under the project → machine transform —
 * a signed axis permutation plus translation — so either frame gives the same
 * number.
 */
function centrelineFrame(point: ToolpathPoint, centre: RotaryCentreline): { across: number; up: number } {
  return centre.axis === 'x'
    ? { across: point.y - centre.point.y, up: point.z - centre.point.z }
    : { across: point.x - centre.point.x, up: point.z - centre.point.z }
}

/** The coordinate of `point` along the bar, which no turn moves. */
function alongBar(point: ToolpathPoint, centre: RotaryCentreline): number {
  return centre.axis === 'x' ? point.x : point.y
}

/**
 * The 16 positive nodes and weights of a 32-point Gauss-Legendre rule on
 * `[−1, 1]`, used by {@link stockFramePathLength} when the closed form would
 * cancel. Symmetric, so the negative nodes are the positives negated.
 */
const GAUSS_LEGENDRE_NODES: readonly number[] = [
  0.048307665687738310378, 0.14447196158279648759, 0.23928736225213706468,
  0.33186860228212766710, 0.42135127613063533270, 0.50689990893222935942,
  0.58771575724076230429, 0.66304426693021523143, 0.73218211874028971131,
  0.79448379596794238555, 0.84936761373256997043, 0.89632115576605209117,
  0.93490607593773966677, 0.96476225558750638989, 0.98561151154526838170,
  0.99726386184948156988,
]
const GAUSS_LEGENDRE_WEIGHTS: readonly number[] = [
  0.096540088514727853686, 0.095638720079274847086, 0.093844399080804538626,
  0.091173878695763904689, 0.087652093004403741627, 0.083311924226946720839,
  0.078193895787070435976, 0.072345794108848615611, 0.065822222776361946628,
  0.058684093478535578892, 0.050998059262376153888, 0.042835898022226703841,
  0.034273862913021410637, 0.025392065309262138589, 0.016274394730905708539,
  0.0070186100094701362601,
]

/**
 * The length of the path the cutter tip draws **in the stock's own frame** for
 * one turning move (issue #393, rule 4).
 *
 * The tool travels in a straight line while the stock turns linearly, so at
 * parameter `t` the tip is at `lerp(from, to, t)` and the point of the unturned
 * stock under it is `stockSpacePoint(lerp(from, to, t))` (`rotaryFrame.ts`).
 * Writing `A` and `U` for the across and up offsets of that lerp and `ω` for
 * the sweep in radians, the squared speed in stock space is
 *
 *   `along'² + (A' + ω·U(t))² + (U' − ω·A(t))²`,
 *
 * a quadratic in `t`; the length is its square root integrated over [0, 1].
 * The mean of the two end radii is *not* this length: a move that plunges while
 * it turns traces a longer spiral than either end's arc suggests, and a move
 * at a constant radius reduces to the ordinary `sqrt(along'² + (R·ω)²)`.
 *
 * The quadratic is a sum of squares, so completing it gives an exact closed
 * form rather than a quadrature. With `t* = −beta / (2·alpha)` (where it is
 * smallest) and `m = gamma − beta² / (4·alpha)` — never negative, up to
 * floating-point noise — the integrand is `sqrt(alpha·u² + m)` in `u = t − t*`,
 * whose antiderivative is
 *
 *   `F(u) = (u/2)·sqrt(alpha·u² + m) + (m / (2·sqrt(alpha)))·asinh(u·sqrt(alpha / m))`,
 *
 * and the length is `F(1 − t*) − F(−t*)`. That closed form is exact while the
 * quadratic's minimum sits on or near the move, where it also carries the
 * corner a tip speed touching zero puts in the integrand (a 32-point rule
 * alone is off by ~8e-4 there, a 90° turn at a bar centreline crossing). When
 * the minimum lies far outside `[−1, 2]` the two antiderivative values are
 * large and nearly equal, and subtracting them loses most of the significant
 * digits: a move with 1e-14 across/up deltas planned 18.000 mm for a true
 * 18.6870947749. There the integrand is smooth on `[0, 1]`, so a fixed 32-point
 * Gauss-Legendre rule is accurate to machine precision instead.
 */
function stockFramePathLength(from: ToolpathPoint, to: ToolpathPoint, centre: RotaryCentreline): number {
  const start = centrelineFrame(from, centre)
  const end = centrelineFrame(to, centre)
  const dAcross = end.across - start.across
  const dUp = end.up - start.up
  const dAlong = alongBar(to, centre) - alongBar(from, centre)
  const sweep = (((to.a ?? 0) - (from.a ?? 0)) * Math.PI) / 180
  const c1 = dAcross + sweep * start.up
  const c2 = dUp - sweep * start.across
  const alpha = sweep * sweep * (dUp * dUp + dAcross * dAcross)
  const beta = 2 * sweep * (c1 * dUp - c2 * dAcross)
  const gamma = c1 * c1 + c2 * c2 + dAlong * dAlong
  // A move at a constant radius — a pure turn, a turn travelling along the bar,
  // or an ordinary straight move — has a constant tip speed. Returning it
  // directly keeps the exact word those moves write today; the closed form
  // below needs a division by `alpha` and would agree only to a few ulps.
  if (alpha === 0 && beta === 0) return Math.sqrt(Math.max(gamma, 0))
  const tStar = -beta / (2 * alpha)
  // The minimum of the quadratic lies on or near the move: the closed form is
  // exact there, and it is the only branch that resolves the corner a tip
  // speed touching zero puts in the integrand.
  if (tStar >= -1 && tStar <= 2) {
    const root = Math.sqrt(alpha)
    // The quadratic is a sum of squares, so this is zero at worst: a negative
    // value is floating-point noise at a move whose tip speed really does touch
    // zero.
    const m = Math.max(gamma - (beta * beta) / (4 * alpha), 0)
    const antiderivative = (u: number): number => {
      // `m → 0`: the square root is `sqrt(alpha)·|u|` and its integral is
      // `sqrt(alpha)·u·|u| / 2`. The `asinh` form is indeterminate there, and
      // overflows for a denormal `m`, so take the limit whenever the argument is
      // not finite — `m` is negligible against `alpha·u²` by then.
      const asinhArgument = m === 0 ? Infinity : u * Math.sqrt(alpha / m)
      if (!Number.isFinite(asinhArgument)) return 0.5 * root * u * Math.abs(u)
      return 0.5 * u * Math.sqrt(alpha * u * u + m)
        + (m / (2 * root)) * Math.asinh(asinhArgument)
    }
    return antiderivative(1 - tStar) - antiderivative(-tStar)
  }
  // The minimum is far outside the move, so the antiderivative terms above are
  // large and nearly equal and subtracting them loses the length. The integrand
  // is smooth on [0, 1] here; the 32-point rule is accurate to machine
  // precision. It needs no division by `alpha`, so it also covers the
  // degenerate `alpha === 0, beta ≠ 0` that a rounding could in principle make.
  let total = 0
  for (let index = 0; index < GAUSS_LEGENDRE_NODES.length; index++) {
    const node = GAUSS_LEGENDRE_NODES[index]
    const weight = GAUSS_LEGENDRE_WEIGHTS[index]
    for (const sign of [1, -1]) {
      const t = 0.5 + 0.5 * sign * node
      total += weight * Math.sqrt(Math.max(alpha * t * t + beta * t + gamma, 0))
    }
  }
  return 0.5 * total
}

/**
 * True when a move's two ends disagree on carrying an angle at all. A rapid may
 * do that — a rapid to a point with an angle is how the program first turns the
 * bar. A **feed move or arc must carry `a` on both ends or on neither**
 * (issue #393, rule 2); `feedAngleIsSplit` is that rule, and the single place
 * tracking, "does this move turn" and the path length all judge it.
 */
function oneEndAngled(from: ToolpathPoint, to: ToolpathPoint): boolean {
  return (from.a === undefined) !== (to.a === undefined)
}

/** The rule above for a whole move: only a feed move or arc can break it. */
function feedAngleIsSplit(move: ToolpathMove): boolean {
  return move.kind !== 'rapid' && oneEndAngled(move.from, move.to)
}

/**
 * The inverse-time feed word for one turning feed move: `feed / length` in
 * 1/min, where `length` is the true path length at the cutter tip in the
 * stock's own frame ({@link stockFramePathLength}).
 *
 * Exported alone so the arithmetic can be tested without an export. The length
 * is never taken below `tolerance`, so a move that neither travels nor turns
 * yields a finite word rather than an infinity.
 *
 * Refuses a move that carries an angle on one end only: `stockFramePathLength`
 * would read the absent angle as zero and plan a turn the emitter never writes.
 * The operation is refused before export; this keeps the arithmetic from ever
 * being handed such a move.
 */
export function inverseTimeFeedValue(
  from: ToolpathPoint,
  to: ToolpathPoint,
  feed: number,
  centre: RotaryCentreline,
  tolerance: number,
): number {
  if (oneEndAngled(from, to)) {
    throw new Error('inverseTimeFeedValue: a feed move must carry its rotary angle on both ends or on neither')
  }
  const length = Math.max(stockFramePathLength(from, to, centre), tolerance)
  // `Math.max` floors the divisor at the tolerance: a zero-length move would
  // otherwise divide by zero and write `FInfinity`.
  return feed / length
}

/** Absent means no rotary component, so it matches only another absent one. */
function sameAngle(a: number | undefined, b: number | undefined): boolean {
  return a === b
}

/** True when a move changes the stock's angle over its span (rule 2). A move
 *  that breaks the two-ends rule is not a turn: it is refused before planning. */
function turns(move: ToolpathMove): boolean {
  return !feedAngleIsSplit(move) && !sameAngle(move.from.a, move.to.a)
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

/**
 * The range of the borrowed motor's project coordinate a toolpath touches: its
 * moves and — because canned-cycle positioning writes that letter as a linear
 * coordinate — its drill holes too (issue #393, rule 3).
 */
function borrowedAxisRange(
  toolpath: ToolpathResult,
  axis: 'x' | 'y',
): { min: number; max: number } | null {
  let min = Infinity
  let max = -Infinity
  const consider = (value: number) => {
    if (value < min) min = value
    if (value > max) max = value
  }
  for (const move of toolpath.moves) {
    consider(axis === 'x' ? move.from.x : move.from.y)
    consider(axis === 'x' ? move.to.x : move.to.y)
  }
  for (const cycle of toolpath.drillCycles ?? []) {
    consider(axis === 'x' ? cycle.x : cycle.y)
  }
  return min === Infinity ? null : { min, max }
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
 * The angle the program is at after an operation, in the program's own
 * direction, or `established: false` when a feed move starts before the
 * controller has been turned to that move's angle (issue #393, rule 2).
 *
 * A rapid establishes the angle; a feed move or arc may only begin at the
 * angle the controller is already at, and unknown at program start counts as
 * not established. A move with no angle anywhere leaves the bar where it is.
 */
function trackOperationAngle(
  moves: readonly ToolpathMove[],
  direction: 1 | -1,
  tracked: number | null,
): { established: boolean; trackedAngle: number | null } {
  let current = tracked
  for (const move of moves) {
    const carriesAngle = move.from.a !== undefined || move.to.a !== undefined
    if (!carriesAngle) continue
    // A feed move with an angle on one end only is broken, not trackable: say
    // the angle is not established so the operation is refused.
    if (feedAngleIsSplit(move)) return { established: false, trackedAngle: current }
    const start = move.from.a === undefined ? undefined : move.from.a * direction
    const end = move.to.a === undefined ? undefined : move.to.a * direction
    if (move.kind === 'rapid') {
      if (end !== undefined) current = end
      continue
    }
    if (current === null || start !== current) {
      return { established: false, trackedAngle: current }
    }
    if (end !== undefined) current = end
  }
  return { established: true, trackedAngle: current }
}

function borrowedAxisTravelWarning(operationName: string, axis: 'x' | 'y'): ToolpathWarning {
  return {
    code: 'postRotaryBorrowedAxisTravel',
    params: { operation: operationName, axis: axis.toUpperCase() },
  }
}

/**
 * Why an operation cannot run on this machine's rotary axis (issue #393), or
 * the angle and borrowed coordinate the program is at once it has run. Every
 * reason is a refusal rather than an approximation: a program that guesses at
 * the angle cuts the part wrong.
 */
function inspectRotaryOperation(args: {
  definition: MachineDefinition
  project: Project
  operation: Operation
  toolpath: ToolpathResult
  operationName: string
  /** The radius of the normalized cutter the emitter will actually write. */
  emittedRadius: number
  trackedAngle: number | null
  borrowedCoordinate: number | null
}): { refused: ToolpathWarning } | {
  refused: null
  trackedAngle: number | null
  borrowedCoordinate: number | null
} {
  const { definition, project, operation, toolpath, operationName, emittedRadius, trackedAngle, borrowedCoordinate } = args
  const tolerance = exportGeometryTolerance(project.meta.units)
  const hasAngle = toolpath.moves.some((move) => move.from.a !== undefined || move.to.a !== undefined)
  // The bar and the machine must agree (issue #395, rule 3): a stored angle is
  // a turn about the bar's own axis, so a machine set up about the other
  // horizontal axis would turn the stock the wrong way. Checked before the
  // borrowed-axis arithmetic below, which would otherwise read the bar's own
  // travel as travel on the borrowed motor — the same axis, on that machine.
  // A square blank's axis is read the same way (#1016 C2-S4).
  if (hasAngle && definition.rotary && isBarStock(project.stock)
    && project.stock.axis !== definition.rotary.about) {
    return {
      refused: {
        code: 'postRotaryAxisMismatch',
        params: {
          operation: operationName,
          machineAxis: definition.rotary.about.toUpperCase(),
          stockAxis: project.stock.axis.toUpperCase(),
        },
      },
    }
  }
  // Rule 3 applies to every operation on a borrowed-motor machine, turning or
  // not: the borrowed project axis has no linear travel at all, so an operation
  // that moves along it — or whose drill holes sit at another value of it —
  // cannot run here. Checked before the angle gate so a flat operation is
  // refused too.
  const borrowed = rotaryBorrowedAxis(definition)
  let nextBorrowed = borrowedCoordinate
  if (borrowed !== null) {
    const range = borrowedAxisRange(toolpath, borrowed)
    if (range !== null) {
      if (range.max - range.min > tolerance) {
        return { refused: borrowedAxisTravelWarning(operationName, borrowed) }
      }
      // The borrowed coordinate is one value for the whole program: the first
      // exported operation fixes it (rule 3a).
      if (borrowedCoordinate !== null
        && (range.min < borrowedCoordinate - tolerance || range.max > borrowedCoordinate + tolerance)) {
        return { refused: borrowedAxisTravelWarning(operationName, borrowed) }
      }
      if (nextBorrowed === null) nextBorrowed = range.min
    }
    // Canned cycles are never written on a borrowed-motor machine (rule 3b),
    // so an operation that has drill holes but no expanded moves would be
    // silently dropped.
    if (toolpath.moves.length === 0 && (toolpath.drillCycles?.length ?? 0) > 0) {
      return { refused: { code: 'postRotaryDrillNotExpanded', params: { operation: operationName } } }
    }
  }
  // Square semantic validation runs before the angle early-return (#1016
  // C2-S4). A square blank carries only a legitimate rotary rough/finish
  // against a real model on a matching Around setup: that is exactly the
  // generation guard, asked again here so a stale manually supplied
  // `ToolpathResult` cannot post motion the engine would never have generated.
  //
  // Every angle-bearing square path must be that operation, whatever face the
  // operation claims — a Top/Bottom or wrapped 2D operation carrying synthetic
  // `A` motion is refused rather than posted. The emitted cutter must also be
  // the project's own referenced row: a stale entry whose tool was removed, or
  // that carries a different (larger) cutter, must not let the physical guard
  // prove one tool clear while the emitter writes another. A wholly-angle-free
  // rotary path is stale too: an actual square turning pass always carries
  // `A`, so its absence is refused rather than passed through as a flat path.
  if (isSquareStock(project.stock)) {
    if (setupGenerationBlock(project, operation)) {
      return { refused: { code: 'postSetupOperationRefused', params: { operation: operationName } } }
    }
    if (hasAngle
      && (!squareRotaryWorkAdmitted(project, operation)
        || squareRotaryCutterRefusal(project, operation, emittedRadius))) {
      return { refused: { code: 'postSetupOperationRefused', params: { operation: operationName } } }
    }
    if (isRotaryOperationKind(operation.kind) && toolpath.moves.length > 0 && !hasAngle) {
      return { refused: { code: 'postRotaryAngleNotEstablished', params: { operation: operationName } } }
    }
  }
  if (!hasAngle) {
    return { refused: null, trackedAngle, borrowedCoordinate: nextBorrowed }
  }
  const rotary = definition.rotary
  if (!rotary || rotaryWord(definition) === null) {
    return { refused: { code: 'postRotaryNoAxis', params: { operation: operationName } } }
  }
  // Rule 2: a feed move or arc must carry `a` on both ends or on neither. With
  // it on one end only, feed planning would read the absent angle as zero and
  // the emitter would write no angle word: the bar stays where it is and the
  // cut runs at the wrong speed. Refused before any feed is planned.
  if (toolpath.moves.some(feedAngleIsSplit)) {
    return { refused: { code: 'postRotaryAngleNotEstablished', params: { operation: operationName } } }
  }
  if (rotary.inverseTimeFeed === null
    && toolpath.moves.some((move) => turns(move) && move.kind !== 'rapid')) {
    return { refused: { code: 'postRotaryNoInverseTime', params: { operation: operationName } } }
  }
  if (!isBarStock(project.stock)) {
    return { refused: { code: 'postRotaryNeedsRoundStock', params: { operation: operationName } } }
  }
  // Rule 2: cut only at an angle the program has actually turned to. The
  // tracked angle spans the whole program and is unknown at its start.
  const tracked = trackOperationAngle(toolpath.moves, rotaryDirection(definition), trackedAngle)
  if (!tracked.established) {
    return { refused: { code: 'postRotaryAngleNotEstablished', params: { operation: operationName } } }
  }
  return { refused: null, trackedAngle: tracked.trackedAngle, borrowedCoordinate: nextBorrowed }
}

/**
 * The operations a rotary program cannot contain, each with the warning that
 * says why (issue #393). An operation with no angle anywhere in it is never
 * refused for a rotary reason, so a machine with a rotary axis exports a
 * program that does not use it byte-identically.
 *
 * A machine whose own templates write the rotary word is refused by the
 * emitter (rule 3c), which is the only place that knows which lines the
 * program actually writes; see `lineCarriesAxisWord` in `postprocessor.ts`.
 */
export function planRotaryRefusals(
  input: Pick<PostProcessorInput, 'project' | 'definition' | 'operations'>,
): { operations: PostProcessorInput['operations']; warnings: ToolpathWarning[] } {
  const { project, definition, operations } = input
  const warnings: ToolpathWarning[] = []
  const kept: PostProcessorInput['operations'] = []
  // Rule 2 and rule 3a both span the program: the angle the controller is at
  // and the borrowed coordinate carry from one operation to the next.
  let trackedAngle: number | null = null
  let borrowedCoordinate: number | null = null
  for (const entry of operations) {
    const verdict = inspectRotaryOperation({
      definition,
      project,
      operation: entry.operation,
      toolpath: entry.toolpath,
      operationName: entry.operation.name,
      emittedRadius: entry.tool.radius,
      trackedAngle,
      borrowedCoordinate,
    })
    if (verdict.refused !== null) {
      warnings.push(verdict.refused)
      continue
    }
    trackedAngle = verdict.trackedAngle
    borrowedCoordinate = verdict.borrowedCoordinate
    kept.push(entry)
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
