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

import { resolveVerticalOvercut, verticalOvercutCommentText, verticalOvercutWarning } from '../toolpaths/verticalOvercut'
import { edgeRouteOvercutApplies } from '../toolpaths/verticalOvercutTargets'
import type {
  MachineDefinition,
  PostProcessorInput,
  PostProcessorResult,
  OperationMotionTrace,
} from './types'
import { pinRotaryAxis, resolveMachineKind, resolveOutputDialect, rotaryBorrowedAxis, rotaryDirection, rotaryWord, machineCoordinateRapidCommand, machineExportDiagnostics } from './types'
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import { formatGCodeNumber, projectToMachinePoint } from './utils'
import type { ToolpathPoint } from '../toolpaths/types'
import { effectiveFeed } from '../toolpaths/feed'
import { getOperationSafeZ } from '../toolpaths/geometry'
import { setupFrameForOperation, setupToCanonicalPoint } from '../setupOrientation'
import { isBarStock, isSquareStock } from '../../types/barStock'
import { rotaryTravelZ } from '../toolpaths/squareRotaryStock'
import type { OperationTarget } from '../../types/project'
import { resolveEmittedArc } from './arcFitting'
import type { ArcMoveDescriptor, FittedMoveDescriptor } from './arcFitting'
import {
  createArcEmitOptions,
  createEmittedValueFormatter,
  crossAxisHeldByTouchOff,
  lineCarriesAxisWord,
  planDrillCycles,
  planOperationMotion,
  plannedSafeZ,
  plannedStepStart,
  planPlasmaGcodeCut,
  planPlasmaPath,
  planProgramSequence,
  planProgramSetup,
  rotaryInchRefused,
  rotaryInchWarning,
  planRotaryRefusals,
  planStepFeeds,
  plasmaSafeZ,
  plasmaSheetZ,
  rotaryCentreline,
  splitRapid,
} from './motionPipeline'
import type { FeedDirective, OperationSequence } from './motionPipeline'
import { convertLength, exportGeometryTolerance } from '../../utils/units'
import { emitOpenSbpProgram } from './opensbpEmitter'
import { templateLineCode } from './templateRules'

// What the emitter has written so far. Which tool is held and whether the
// spindle and coolant are on are not tracked here: that is the program's
// sequence, decided for every dialect by `planProgramSequence`.
interface ModalState {
  motionCommand: string | null   // last G0/G1/G2/G3
  feedRate: number | null
  /** The last angle written, in the program's own direction, or null when the
   *  program has not turned yet. The rotary word is modal like X/Y/Z: it is
   *  written only when the angle changes from this (issue #393, rule 1). */
  rotaryAngle: number | null
  /** The machine letter the angle is written under (`A`, or a borrowed motor's
   *  letter), or null when the machine has no rotary axis. */
  rotaryWord: 'A' | 'X' | 'Y' | null
  /** True while the controller is in inverse-time feed mode (issue #393,
   *  rule 4): every turning feed move carries its own F on the motion block,
   *  and the mode is left before every block that is not one — a rapid, a
   *  constant-angle feed, an operation header, a tool change, a dwell, a
   *  canned cycle or the program end. */
  inverseTime: boolean
  currentPosition: ToolpathPoint | null
  /** True when the last emitted Z is still known to be where the controller is.
   *  A machine template may move any axis behind the emitter's back, so every
   *  template that can move Z clears this until a motion block writes Z again
   *  (issue #1016 C2 correction M1). */
  zKnown: boolean
  lineNumber: number
}

function operationTargetSummary(target: OperationTarget): string {
  if (target.source === 'stock') {
    return 'Stock'
  }
  return `${target.featureIds.length} feature${target.featureIds.length === 1 ? '' : 's'}`
}

/**
 * The canned-cycle command word for one drill type, or null when the
 * definition has none for it. A null command falls back to the expanded moves
 * the toolpath already carries, exactly as on a machine with canned cycles
 * off.
 */
function cannedCommandFor(
  canned: NonNullable<MachineDefinition['cannedCycles']>,
  drillType: string,
): string | null {
  switch (drillType) {
    case 'simple': return canned.drillCommand
    case 'dwell': return canned.drillWithDwellCommand
    case 'peck': return canned.peckDrillCommand
    case 'chip_breaking': return canned.chipBreakDrillCommand
    default: return null
  }
}

/**
 * Operator-visible text (`operation.name`, a tool name, the project name) made
 * safe for the definition's comment syntax (Codex review of slice F, finding
 * 3). A closing parenthesis ends a `( … )` comment, a semicolon starts a new
 * one in a `;` dialect, and a newline ends the comment line entirely; any of
 * them would turn the rest of the text into program code. Parentheses are
 * removed for every dialect because a `)` is a closing marker wherever it
 * appears, and the rest follows the prefix the definition uses.
 */
function safeCommentText(
  text: string,
  definition?: Pick<MachineDefinition, 'program'>,
): string {
  let safe = text.replace(/[\r\n]+/g, ' ')
  // `)` closes a parenthesised comment and `;` starts a block comment in every
  // bundled dialect; neither may survive inside operator text.
  safe = safe.replace(/[();]/g, ' ')
  const prefix = definition?.program.commentPrefix ?? ''
  if (prefix === "'") safe = safe.replace(/'/g, ' ')
  return safe.replace(/\s+/g, ' ').trim()
}

function safeCommentLines(
  text: string,
  definition?: Pick<MachineDefinition, 'program'>,
): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => safeCommentText(line, definition))
    .filter((line) => line.length > 0)
}

/**
 * Commands a machine template can spell without moving any axis. Every other
 * `G`/`M` command is distrusted: a canned cycle, a macro call, a home, a tool
 * change or a coordinate-system change can move Z without naming it, and the
 * emitter must not keep believing a Z it can no longer prove.
 */
const INERT_TEMPLATE_COMMANDS: ReadonlySet<string> = new Set([
  'G4', 'G17', 'G18', 'G19', 'G20', 'G21',
  'G40', 'G41', 'G42', 'G54', 'G55', 'G56', 'G57', 'G58', 'G59',
  'G61', 'G64', 'G80', 'G90', 'G91', 'G93', 'G94', 'G98', 'G99',
  'M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M8', 'M9', 'M30',
])

/**
 * True when a rendered machine template can move the cutter in Z behind the
 * emitter's back. A Z word is decisive. Without one, a line is treated as
 * moving unless every `G`/`M` command on it is a known inert modal/program
 * command: a macro, home, tool change or canned cycle can move an axis the
 * line never names, and assuming otherwise is how the next A word gets written
 * at a height nobody proved. Comments are stripped first, so prose never
 * counts as a command.
 */
function templateCanMoveZ(line: string, commentPrefix: string): boolean {
  if (lineCarriesAxisWord(line, 'Z', commentPrefix)) return true
  let code = line.replace(/\([^)]*\)/g, ' ')
  if (commentPrefix.length > 0 && commentPrefix !== '(') {
    const at = code.indexOf(commentPrefix)
    if (at >= 0) code = code.slice(0, at)
  }
  for (const match of code.matchAll(/\b([GM])\s*(\d+(?:\.\d+)?)/gi)) {
    const command = `${match[1].toUpperCase()}${Number(match[2])}`
    if (!INERT_TEMPLATE_COMMANDS.has(command)) return true
  }
  return false
}

/**
 * The stop written between two rotary operations when the machine's pause
 * template carries no mandatory stop (#1152 correction round 1, finding 2;
 * round 2, finding 1). Without it the operator is told to zero A with nothing
 * stopping the machine to do it. `M0` is the stop every G-code dialect that
 * can carry a rotary axis understands; the emitter's rotary word is refused for
 * ShopBot part files, so its own stop never has to be invented here.
 */
const MANUAL_PAUSE_COMMAND = 'M0'

/**
 * True when a rendered machine template carries a stop the controller **must**
 * halt on: `M0` (`M00` is the same word). Nothing else counts (#1152
 * correction round 2, finding 1). `M1`/`M01` is an optional stop — with the
 * optional-stop switch off the program runs straight through it — and `M5` only
 * stops the spindle. `M2`/`M30` end the program rather than pause it, so they
 * cannot hand the operator the bar and then resume. Comments are stripped
 * first, so prose never counts as a command.
 */
function templateHasMandatoryStop(content: string, outputDialect: string | undefined): boolean {
  for (const line of content.split(/\r?\n/)) {
    // The dialect's comment forms, not the definition's own prefix: LinuxCNC
    // declares `(` yet still reads `; M0` as a comment (#1103).
    for (const match of templateLineCode(line, outputDialect).matchAll(/\bM\s*(\d+(?:\.\d+)?)/gi)) {
      if (Number(match[1]) === 0) return true
    }
  }
  return false
}

/**
 * Export a program for the machine definition's output dialect.
 *
 * This is the only place a dialect is chosen. Each dialect owns its line
 * syntax and nothing else: what the machine is asked to do comes from the
 * shared `motionPipeline.ts`, so a change to motion planning lands in every
 * dialect and no dialect is special-cased inside another's emitter.
 */
export function runPostProcessor(input: PostProcessorInput): PostProcessorResult {
  const result = runPostProcessorUnchecked(input)
  // Every Edge Route that overcuts into the spoilboard says so in the export,
  // and one whose overcut is refused blocks it (issue #834). This is decided
  // from the operation rows themselves, not from the toolpath's warnings, so
  // a refused value cannot reach a saved file even through a stale path.
  // An overcut with no target cut through to the stock bottom is not applied,
  // so the export says nothing about a spoilboard cut that does not happen.
  const overcutWarnings = input.operations.flatMap(({ operation }) => {
    const status = resolveVerticalOvercut(input.project, operation)
    if (status.kind === 'ok' && !edgeRouteOvercutApplies(input.project, operation)) return []
    const warning = verticalOvercutWarning(input.project, operation, status)
    return warning ? [warning] : []
  })
  return overcutWarnings.length === 0 ? result : withWarnings(result, overcutWarnings)
}

function runPostProcessorUnchecked(input: PostProcessorInput): PostProcessorResult {
  // A machine that still breaks a template rule produces no program at all
  // (#1119). The refusal is decided from the definition alone, before either
  // dialect emitter runs and before the operation plan is built, so turning
  // off tool changes or coolant, or selecting fewer operations, cannot make a
  // refused machine post something. The definition itself is kept and shown
  // with its diagnostics; only the program is withheld.
  const machineDiagnostics = machineExportDiagnostics(input.definition)
  if (machineDiagnostics.length > 0) {
    return {
      gcode: '',
      warnings: [{
        code: 'exportMachineTemplateInvalid',
        params: { machine: input.definition.name },
      }],
      stats: { lineCount: 0, operationCount: 0, moveCount: 0 },
    }
  }
  // A rotary operation this machine cannot run is dropped before any emitter
  // sees it (issue #393, rule 5), exactly as a plasma cut is on a non-plasma
  // machine. An operation with no angle anywhere is untouched.
  const rotary = planRotaryRefusals(input)
  const filtered: PostProcessorInput = rotary.warnings.length === 0
    ? input
    : { ...input, operations: rotary.operations }
  // A plasma cut belongs to a plasma table. On any other machine the ordinary
  // emitters would run it as a spindle path above the stock, so it never
  // reaches them: the program is the one its remaining operations ask for
  // (issue #960). The mirror case, a milling operation on a plasma table, is
  // decided in `planPlasmaSequence`.
  const skipped = resolveMachineKind(input.definition) === 'plasma'
    ? []
    : filtered.operations.filter((entry) => entry.operation.kind === 'plasma_profile')
  const skippedWarnings = skipped.map(({ operation }) => ({
    code: 'postPlasmaCutSkipped' as const,
    params: { operation: operation.name },
  }))
  if (skippedWarnings.length === 0) {
    return rotary.warnings.length === 0
      ? emitProgramForDialect(input)
      : withWarnings(emitProgramForDialect(filtered), rotary.warnings)
  }
  return withWarnings(emitProgramForDialect({
    ...filtered,
    operations: filtered.operations.filter((entry) => entry.operation.kind !== 'plasma_profile'),
  }), [...rotary.warnings, ...skippedWarnings])
}

/** Put warnings the planner raised ahead of whatever the emitter raised. */
function withWarnings(result: PostProcessorResult, warnings: ToolpathWarning[]): PostProcessorResult {
  return { ...result, warnings: [...warnings, ...result.warnings] }
}

/**
 * The dialect emitter alone, without the refusal planning `runPostProcessor`
 * runs first. Export always goes through `runPostProcessor`; this exists so a
 * test can prove the emitter's own backstops (#1153) hold for an operation the
 * planner would have dropped.
 */
export function emitProgramWithoutPlanning(input: PostProcessorInput): PostProcessorResult {
  return emitProgramForDialect(input)
}

function emitProgramForDialect(input: PostProcessorInput): PostProcessorResult {
  switch (resolveOutputDialect(input.definition)) {
    case 'opensbp':
      return emitOpenSbpProgram(input)
    case 'gcode':
      return emitGcodeProgram(input)
  }
}

/**
 * The modal baseline every program this emitter writes assumes: absolute
 * coordinates, constant feed mode, on the XY plane. The header templates
 * declare it rather than configure it, and the restart block after a tool
 * change restates it, because a tool-change template is free to leave the
 * controller in any other state (`G91`, `G93`, `G18`).
 */
const MODAL_DISTANCE_COMMAND = 'G90'
const MODAL_FEED_COMMAND = 'G94'
const MODAL_PLANE_COMMAND = 'G17'

/** One whole turn of the rotary, in degrees (#1103 slice ca-h). */
const ROTARY_TURN = 360
/**
 * How close an angle must be to a whole turn to count as one. A generated
 * pose lands on a multiple of 360 exactly, so the slack only absorbs the
 * repeated additions; it is far below the emitted precision.
 */
const WHOLE_TURN_EPSILON = 1e-6

/**
 * The next whole turn at or ahead of `angle` — `360 * ceil(angle / 360)`,
 * with a slack so an angle that is a whole turn within float noise is left
 * alone instead of being given another full turn.
 */
function nextWholeTurn(angle: number): number {
  return ROTARY_TURN * Math.ceil((angle - WHOLE_TURN_EPSILON) / ROTARY_TURN)
}

/**
 * The last angle an operation's planned steps command, in the program's own
 * direction, or null when it commands none. Read from the plan rather than the
 * toolpath so the number is exactly what the emitter wrote; a fitted arc is
 * never a turning move (rule 2), so only linear steps carry one.
 */
function lastPlannedAngle(steps: readonly FittedMoveDescriptor[]): number | null {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]
    const angle = step.kind === 'arc' ? step.endPoint.a : step.point.a
    if (angle !== undefined) return angle
  }
  return null
}

function emitGcodeProgram(input: PostProcessorInput): PostProcessorResult {
  const { project, operations, options } = input
  // The bar axis is resolved once, against this program's stock (#1153).
  const definition = pinRotaryAxis(input.definition, project.stock)
  const lines: string[] = []
  const warnings: ToolpathWarning[] = []
  const outputUnits = project.meta.units
  
  const state: ModalState = {
    motionCommand: null,
    feedRate: null,
    rotaryAngle: null,
    // `rotaryWord` reads the definition and is constant for the program; an
    // `opensbp` definition can carry no rotary block (slice A validates that),
    // so this path is G-code only.
    rotaryWord: rotaryWord(definition),
    inverseTime: false,
    currentPosition: null,
    zKnown: false,
    lineNumber: definition.program.lineNumbers ? definition.program.lineNumberIncrement : 0
  }
  // Count G-code motion blocks as emitted, not the input toolpath moves. The
  // latter can be reduced by arc fitting or expanded when a rapid is split
  // into safe Z and XY blocks.
  let moveCount = 0
  const captureTrace = options.captureMotionTrace === true
  const motionTraces: OperationMotionTrace[] = []

  const formatValue = createEmittedValueFormatter(definition, outputUnits)
  const arcEmitOptions = createArcEmitOptions(definition, outputUnits, definition.motion.arcFormat)

  // #1016 C2 correction M1 — the square blank's turning clearance, in the
  // emitted machine frame. A square blank turns only at the generators' travel
  // height (`rotaryTravelZ`); the planner refuses a supplied turn below it, but
  // a machine template that moves Z behind the emitter's back writes one
  // outside the planner and needs its own guard. It is repaired by a rapid
  // retract to this height, so no A word is ever written with the cutter below
  // the blank's standing corners. The repair stays square-only. The opening and
  // closing turns of a bar program are protected separately, by the
  // machine-coordinate retract (#1054 fix 2). The height is a project
  // coordinate; map it exactly as the move's own Z is mapped, never with a
  // second copy of the origin arithmetic.
  // The dialect's machine-coordinate rapid, or null when it has none. G-code
  // spells it `G53 <rapid>`; ShopBot part files have no equivalent. A machine
  // definition may override it, or set it null to declare none.
  const machineRapidCommand = machineCoordinateRapidCommand(definition)
  // Every bar turn this emitter writes is preceded by the machine-coordinate
  // retract (#1054 fix 2), whatever compensation a template claims, so the
  // setup header describes that retract. A machine with no machine-coordinate
  // move refuses the turn instead of writing it, and then posts no program.
  const machineCoordinateRetract = machineRapidCommand !== null
  // #1156: a program that never moves its cross axis holds it by touch-off —
  // the operator zeroed it on the bar's centreline — so no motion block writes
  // that word, and the header tells the operator to zero it there. The decision
  // is taken once for the program, inside the setup plan, because it governs
  // every emitted block, the canned-cycle choice below and the header wording;
  // null means the program keeps every word it wrote before this rule existed.
  // The plan asks for it while building the header, once it knows the
  // manual-index angle the decision needs; memoized here so a plan with a header
  // and a plan without one both evaluate it exactly once.
  let decidedCrossAxis: 'x' | 'y' | null = null
  let crossAxisDecided = false
  const decideCrossAxis = (manualIndexAngle: 0 | 180 | null): 'x' | 'y' | null => {
    if (!crossAxisDecided) {
      decidedCrossAxis = crossAxisHeldByTouchOff({
        project,
        definition,
        operations,
        manualIndexAngle,
      })
      crossAxisDecided = true
    }
    return decidedCrossAxis
  }
  // What the program says about its setup, decided once for both the header
  // comments and the manual-index turn that follows them (#1054 slice 2b). It
  // is read here because that turn makes the program one that turns, which the
  // square guard and the template-word check below must both know.
  const setupPlan = planProgramSetup(input, machineCoordinateRetract, decideCrossAxis)
  // A manual-index turn about the bar's own axis on a machine whose rotary is
  // about the other horizontal axis would turn the stock the wrong way. The
  // planner refuses such an operation for the same reason; a program whose only
  // turn is the opening one must be refused the same way, never posted as a
  // comment-only header that silently drops the turn (#1054 fix 1, finding 4).
  if (setupPlan.warnings.some((warning) => warning.code === 'postRotaryAxisMismatch')) {
    return {
      gcode: '',
      warnings: setupPlan.warnings,
      stats: { lineCount: 0, operationCount: 0, moveCount: 0 },
      ...(captureTrace ? { motionTraces: [] } : null),
    }
  }
  const programTurns = setupPlan.manualIndexAngle !== null || operations.some(
    ({ toolpath }) => toolpath.moves.some(
      (move) => move.from.a !== undefined || move.to.a !== undefined,
    ),
  )
  // #1153: on a controller that reads the angle as a length, an inch program
  // that would still turn the bar is refused whole. The planner has already
  // dropped every turning operation with a named warning, so this refuses a
  // manual-index Top/Bottom turn — which no operation carries — and is the
  // backstop for any path that bypassed the planner.
  if (programTurns && rotaryInchRefused(definition, project)) {
    return {
      gcode: '',
      warnings: [rotaryInchWarning(operations[0]?.operation.name ?? 'program', definition)],
      stats: { lineCount: 0, operationCount: 0, moveCount: 0 },
      ...(captureTrace ? { motionTraces: [] } : null),
    }
  }
  // A plan that builds no header never asked above; the motion rule applies to
  // the program regardless of what its header says.
  const heldCrossAxis = decideCrossAxis(setupPlan.manualIndexAngle)
  /** A bar's manual-index program: its own opening turn names the face, so its
   *  retracts are in machine coordinates (#1054 slices 2 and 2b). An Around
   *  program works above the whole bar and needs no such frame. */
  const barSetupProgram = setupPlan.manualIndexAngle !== null
  // #1103 slice ca-h, part 3: the machine's own "Zero A" line, when it has one.
  // A filled line automates the operator's zeroing, so the emitter opens every
  // rotary operation with it and never pauses between rotary operations; an
  // empty one is what makes the pause necessary. The line is validated as a
  // template (`rotary.zeroA` in `templateRules.ts`) to set A zero and move no
  // axis, so it is written as-is and the emitter keeps no Z bookkeeping for it.
  const zeroALines = definition.rotary === undefined
    ? []
    : (definition.rotary.zeroA ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  /** True for every operation whose own toolpath commands A. */
  const commandsAngle = operations.map(({ toolpath }) => toolpath.moves.some(
    (move) => move.from.a !== undefined || move.to.a !== undefined,
  ))
  const projectBarTravelZ = isBarStock(project.stock)
    ? rotaryTravelZ(project.stock, project.meta.units)
    : null
  const barTravelZ = projectBarTravelZ === null
    ? null
    : projectToMachinePoint({
      x: 0,
      y: 0,
      z: projectBarTravelZ,
    }, project.origin, definition).z
  // The machine-coordinate retract height is the machine definition's own
  // (#1054 fix 3), never a project safe height mapped through the origin: G53
  // is the machine's zero, which PureCutCNC cannot derive from a project. The
  // definition stores it in millimetres and the project's units conversion
  // never touches it, so it is converted here, at emission (#1054 fix 4). The
  // default 0 is the top of travel after homing.
  const machineSafeZ = convertLength(definition.motion.machineSafeZ, 'mm', outputUnits)
  // The square blank's mid-program repair (a template that moved Z before an A
  // word) is square-only: a round bar's bytes are unchanged (#1054 fix 1,
  // finding 2). It uses the travel height, never a machine-coordinate retract.
  const squareRetractZ = isSquareStock(project.stock) ? barTravelZ : null
  if (barTravelZ !== null && programTurns && !Number.isFinite(barTravelZ)) {
    // The blank carries no usable turning height (a corrupt or degenerate
    // stock), so the retract cannot be placed. Refuse the program rather than
    // turn it with no proven clearance. Only a program that turns is refused:
    // an angle-free program on the same blank is byte-identical to before.
    return {
      gcode: '',
      warnings: [{
        code: 'postRotarySquareTurnBelowEnvelope',
        params: { operation: operations[0]?.operation.name ?? 'program' },
      }],
      stats: { lineCount: 0, operationCount: 0, moveCount: 0 },
      ...(captureTrace ? { motionTraces: [] } : null),
    }
  }

  // Where the *controller* believes the tool is: every emitted coordinate
  // after number formatting. Arc I/J offsets are relative to this, not to the
  // exporter's un-rounded position (`state.currentPosition`) — conflating the
  // two is the defect behind issue #447.
  let emittedPosition: { x: number; y: number } | null = null

  const emitLine = (content: string) => {
    if (definition.program.lineNumbers) {
      lines.push(`N${state.lineNumber} ${content}`)
      state.lineNumber += definition.program.lineNumberIncrement
    } else {
      lines.push(content)
    }
  }

  // Every line written from a machine template, in the exact rendered form the
  // program carries (issue #393, rule 3c). The check at the end of the program
  // reads these rather than the raw template strings: a template that renders
  // to a real axis word (`G0 Y{feed}`), whitespace between the letter and its
  // value, and a command that is never written at all (`pauseCommand` with
  // `pauseAfterChange` off) are all judged by what was actually emitted.
  const templateLines: string[] = []
  /**
   * Write a machine template line.
   *
   * A template can move the machine behind the emitter's back (`G0 Z-8`, a
   * tool-change macro, a canned cycle), and nothing corrects the emitter's
   * tracked Z when it does. For a square blank that matters: the next A word
   * would be written as if the cutter were still where the emitter left it. So
   * a line that can move Z clears the known Z, and a later motion block
   * re-establishes it; an inert line (`M5`, `G94`, a comment) leaves it
   * provable. Round and non-rotary programs never read the flag, so their
   * bytes do not move.
   *
   * A template may hold several physical lines (`"; note\nG0 Y0"`). The
   * program carries them as one entry, but they are judged one physical line
   * at a time: the axis-word scan drops everything after a line's comment
   * marker, so scanning the joined text would lose the code on every line
   * after the first.
   */
  const emitTemplateLine = (content: string) => {
    const physicalLines = content.split(/\r?\n/)
    templateLines.push(...physicalLines)
    emitLine(content)
    if (physicalLines.some((line) => templateCanMoveZ(line, definition.program.commentPrefix))) {
      state.zKnown = false
    }
  }

  // Operator text is sanitized for this dialect's comments even when a
  // template puts the placeholder in a comment (the schema refuses one in
  // code): a project or tool name may itself contain the closing marker.
  const USER_TEXT_PLACEHOLDERS: ReadonlySet<string> = new Set([
    'programName', 'operationName', 'operationDescription', 'toolName',
  ])
  const substituteTemplates = (text: string, context: Record<string, string | number>): string => {
    return text.replace(/{(\w+)}/g, (_, key) => {
      if (context[key] === undefined) return `{${key}}`
      const value = context[key].toString()
      return USER_TEXT_PLACEHOLDERS.has(key) ? safeCommentText(value, definition) : value
    })
  }

  const emitTemplateLines = (
    templates: string[],
    context: Record<string, string | number>,
    descriptionLines: string[] = [],
  ) => {
    for (const template of templates) {
      const expanded = template.includes('{operationDescription}')
        ? descriptionLines.map((descriptionLine) => (
          substituteTemplates(template, { ...context, operationDescription: descriptionLine })
        )).join('\n')
        : substituteTemplates(template, context)
      for (const line of expanded.split(/\r?\n/)) {
        if (line.trim().length > 0) {
          emitTemplateLine(line)
        }
      }
    }
  }

  /**
   * Write the angle word for `angle` when it differs from the last one written
   * (issue #393, rule 1). The value reaches the program multiplied by
   * `rotaryDirection` — it is already the program's angle, done in the
   * transform — and is never reduced to 0–360, so a move from 350 to 370 writes
   * 370. A machine with no rotary axis writes nothing.
   */
  const emitRotaryAxisWord = (segments: string[], angle: number | undefined) => {
    if (angle === undefined || state.rotaryWord === null) return
    if (state.rotaryAngle === angle) return
    segments.push(`${state.rotaryWord}${formatGCodeNumber(angle, definition, outputUnits)}`)
    state.rotaryAngle = angle
  }

  /** Turn inverse-time feed off, if it is on (issue #393, rule 4). */
  const leaveInverseTime = () => {
    if (!state.inverseTime) return
    const off = definition.rotary?.inverseTimeFeed?.off
    if (off) emitTemplateLine(off)
    state.inverseTime = false
    // The controller's modal F is no longer the feed the emitter tracks (it is
    // a 1/min value, or a command the controller replaced), so the next normal
    // feed move must restate it.
    state.feedRate = null
  }

  const emitMotionLine = (
    motionCmd: string,
    axes: Partial<ToolpathPoint>,
    feed?: number,
    inverseTime = false,
  ) => {
    const lineSegments: string[] = []
    const isRapid = motionCmd === definition.motion.rapidCommand
    const angle = axes.a
    // Inverse-time mode belongs to turning feed moves alone (issue #393, rule
    // 4): every other block — a rapid, a constant-angle feed, a canned cycle,
    // a dwell or a positioning template — leaves the mode first, so a G94 is
    // never left owed behind a move whose F already means something else.
    if (!inverseTime) leaveInverseTime()

    if (!definition.motion.modalMotion || state.motionCommand !== motionCmd) {
      lineSegments.push(motionCmd)
      state.motionCommand = motionCmd
    }

    // A held cross axis (issue #1156) keeps its coordinate everywhere the
    // emitter decides block shape from it — `splitRapid` and the positional
    // tracking below see exactly what they saw before the rule — but the word
    // itself is not written. Omitting the coordinate from the plan instead
    // would also drop a block that exists only because a sub-format cross
    // change (`Y0.0001`) made `splitRapid` repeat its X word.
    if (axes.x !== undefined && heldCrossAxis !== 'x') {
      lineSegments.push(`X${formatGCodeNumber(axes.x, definition, outputUnits)}`)
    }
    if (axes.y !== undefined && heldCrossAxis !== 'y') {
      lineSegments.push(`Y${formatGCodeNumber(axes.y, definition, outputUnits)}`)
    }
    if (axes.z !== undefined) {
      lineSegments.push(`Z${formatGCodeNumber(axes.z, definition, outputUnits)}`)
    }
    emitRotaryAxisWord(lineSegments, angle)

    if (feed !== undefined && !isRapid) {
      const feedChanged = state.feedRate !== feed
      // An inverse-time move carries its own F on the motion block whatever the
      // definition's ordinary feed formatting says (rule 4): LinuxCNC requires
      // the word on every G1 block in G93, so a non-inline definition may not
      // put it on a line of its own.
      if (inverseTime || !definition.feedSpeed.modalFeedSpeed || feedChanged) {
        const fWord = `${definition.feedSpeed.feedCommand}${formatGCodeNumber(feed, definition, outputUnits)}`
        if (inverseTime || definition.feedSpeed.inlineWithMotion) {
          lineSegments.push(fWord)
        } else if (feedChanged) {
          emitLine(fWord)
        }
        state.feedRate = feed
      }
    }

    if (lineSegments.length > 0) {
      emitLine(lineSegments.join(' '))
      moveCount += 1
    }

    state.currentPosition = {
      x: axes.x ?? state.currentPosition?.x ?? 0,
      y: axes.y ?? state.currentPosition?.y ?? 0,
      z: axes.z ?? state.currentPosition?.z ?? 0,
      ...(axes.a !== undefined
        ? { a: axes.a }
        : state.currentPosition?.a !== undefined ? { a: state.currentPosition.a } : null),
    }
    if (axes.z !== undefined) state.zKnown = true

    emittedPosition = {
      x: axes.x !== undefined ? formatValue(axes.x) : emittedPosition?.x ?? 0,
      y: axes.y !== undefined ? formatValue(axes.y) : emittedPosition?.y ?? 0,
    }
  }

  /** Rapid to the square blank's turning height, in the emitted frame. */
  const retractToSquareTravel = () => {
    if (squareRetractZ === null) return
    emitMotionLine(definition.motion.rapidCommand, { z: squareRetractZ })
  }

  /**
   * Clear a recovered unknown Z before an A word: a template may have moved the
   * cutter, so the emitter cannot prove the turn is above the blank. Only an
   * unknown Z is repaired here. A *known* low Z is the planner's turn guard
   * (`postRotarySquareTurnBelowEnvelope`), and repairing it here would post
   * motion the planner had already refused — the guard must stay the decision.
   */
  const retractUnknownSquareZ = () => {
    if (squareRetractZ === null || state.zKnown) return
    retractToSquareTravel()
  }

  /** A turn whose clearance could not be proved, reported once (#1054 fix 2). */
  let turnClearanceRefusal: ToolpathWarning | null = null

  const refuseTurnClearance = () => {
    if (turnClearanceRefusal !== null) return
    turnClearanceRefusal = {
      code: 'postRotaryTurnWithoutClearance',
      params: { operation: operations[0]?.operation.name ?? 'program' },
    }
  }

  /**
   * Retract in machine coordinates, where no work-coordinate offset or
   * tool-length compensation can change the physical height (#1054 fix 2).
   * The height is the machine definition's own `motion.machineSafeZ` (#1054
   * fix 3), stored in millimetres and converted to the program's units here,
   * never derived from a project height mapped through the origin: G53 is
   * measured from the machine's zero, and the definition's default 0 is the
   * top of travel after homing.
   *
   * G53 is non-modal, so it shares the block with the rapid word. Returns false
   * when the dialect has no machine-coordinate move or the height is unusable;
   * the caller then refuses the turn rather than writing it.
   *
   * The machine position is deliberately left unknown afterwards: G53 is not in
   * the work coordinate system, so the emitter cannot carry any of it into the
   * first operation's coordinates.
   */
  const emitMachineCoordinateRetract = (): boolean => {
    if (machineRapidCommand === null || !Number.isFinite(machineSafeZ)) return false
    leaveInverseTime()
    emitLine(`${machineRapidCommand} Z${formatGCodeNumber(machineSafeZ, definition, outputUnits)}`)
    moveCount += 1
    state.motionCommand = null
    state.currentPosition = null
    state.zKnown = false
    emittedPosition = null
    return true
  }

  /**
   * Start a manual-index program by turning the bar itself (#1054 slice 2b):
   * a machine-coordinate retract, then a rapid of the rotary word to the
   * program's angle. The angle goes through `rotaryDirection`, exactly as the
   * Around output's does, so a reversed axis (or a mirrored borrowed motor)
   * turns the same physical way.
   *
   * Both blocks spell their rapid word: the turn must not be read as the
   * continuation of whatever motion mode a template may have left behind, and
   * it must never share a block with a Z word. The turn is a rapid, so it stays
   * in G94 — no inverse-time mode is entered.
   *
   * The turn is written *after* the first operation's tool change (#1054 fix
   * 1, finding 1). The retract that precedes it is always in machine
   * coordinates to the machine definition's own Safe Z
   * (`G53 G0 Z<motion.machineSafeZ>`, default 0 = the top of travel after
   * homing), whatever their `G43`/`G49` lines claim: #1054 fix 2 stopped
   * inferring compensation from template text, and only the machine frame is
   * independent of any work offset or compensation. A machine with no such move
   * refuses the turn rather than writing it.
   *
   * X/Y are deliberately left unknown afterwards: the header moved only Z and
   * the rotary, so the machine may be anywhere in the plane and the first
   * operation must write its own position rather than inherit a 0/0 the
   * emitter would have invented.
   */
  const emitManualIndexTurn = (angleDeg: 0 | 180, afterClearance?: () => void) => {
    if (!isBarStock(project.stock) || state.rotaryWord === null) return
    leaveInverseTime()
    if (!emitMachineCoordinateRetract()) {
      refuseTurnClearance()
      return
    }
    state.motionCommand = null
    // The machine's Zero A line, when it has one, runs after this clearance
    // retract and before the turn (#1103 slice ca-h): it sets the A offset at
    // whatever orientation the bar was left in, which is exactly what the
    // turn below must be measured from.
    afterClearance?.()
    // State the angle even when it equals the last one written: the restart
    // block that follows a tool change may already have stated the operation's
    // start angle, and the turn must still be a turn the controller is told
    // about rather than a bare `G0`.
    state.rotaryAngle = null
    emitMotionLine(definition.motion.rapidCommand, {
      a: angleDeg * rotaryDirection(definition),
    })
    state.currentPosition = null
    emittedPosition = null
  }

  /**
   * The controller's A now reads 0 at the bar's current orientation: either the
   * machine's own Zero A line ran, or the operator was told to zero A and
   * paused. Either way the emitter must stop believing the number it wrote
   * before that (#1152 correction round 1, finding 1): after `M0` the tracking
   * still said A360, so a following operation's own A360 positioning word
   * disappeared and its first cut was commanded from a controller the operator
   * had reset to 0. Nothing about X/Y/Z changes: the zeroing forms move no
   * axis, so the work position and the proven Z are untouched.
   */
  const markRotaryZeroed = () => {
    state.rotaryAngle = 0
    if (state.currentPosition !== null) {
      state.currentPosition = { ...state.currentPosition, a: 0 }
    }
  }

  /**
   * Write the machine's own "Zero A" line (#1103 slice ca-h, part 3).
   *
   * The line sets the controller's A offset at the current orientation, so the
   * bar reads 0 wherever it is; the emitter therefore restarts A's tracking
   * from 0, not from the last number it wrote. It is written with `emitLine`,
   * not `emitTemplateLine`: it is the one place engine text may name the
   * rotary, and the template-word guard that refuses a machine template driving
   * the rotary must not read it as one.
   */
  const emitZeroALine = (lines: readonly string[]) => {
    if (state.rotaryWord === null) return
    for (const line of lines) emitLine(line)
    markRotaryZeroed()
  }

  /**
   * Emit a straight move from a planned step, applying its own feed directive
   * (issue #393, rule 4): a turning feed move enters inverse-time mode first —
   * once, since it is modal — and then carries its own `F` in 1/min whatever
   * `modalFeedSpeed` says. A move at a constant angle follows the ordinary
   * modal-feed rules exactly as before.
   */
  const emitPlannedMove = (point: ToolpathPoint, directive: FeedDirective) => {
    if (point.a !== undefined && state.rotaryWord !== null && state.rotaryAngle !== point.a) {
      retractUnknownSquareZ()
    }
    if (directive.mode === 'inverse') {
      if (!state.inverseTime) {
        const on = definition.rotary?.inverseTimeFeed?.on
        if (on) emitTemplateLine(on)
        state.inverseTime = true
      }
      const axes: Partial<ToolpathPoint> = {
        x: point.x,
        y: point.y,
        z: point.z,
        ...(point.a !== undefined ? { a: point.a } : null),
      }
      // Every inverse-time move carries its own F on the motion block, whatever
      // `modalFeedSpeed` and `inlineWithMotion` say (rule 4): LinuxCNC requires
      // the word on every G1 block in G93. Clearing the tracked feed keeps the
      // word present even when it repeats the previous turning move's.
      state.feedRate = null
      emitMotionLine(definition.motion.linearCommand, axes, directive.feed, true)
      return
    }
    // A feed move that does not turn leaves inverse-time mode and restates the
    // ordinary feed word before it (rule 4).
    leaveInverseTime()
    emitMotionLine(definition.motion.linearCommand, {
      x: point.x,
      y: point.y,
      z: point.z,
      ...(point.a !== undefined ? { a: point.a } : null),
    }, directive.mode === 'normal' ? directive.feed : undefined)
  }

  const unitsCommand = project.meta.units === 'mm' ? (definition.units.mmCommand ?? '') : (definition.units.inchCommand ?? '')
  const wcsCommand = definition.workCoordinates.selectCommand ?? ''

  const commonContext = {
    programName: options.programName ?? project.meta.name,
    date: new Date().toISOString().split('T')[0],
    units: project.meta.units,
    unitsCommand,
    wcsCommand
  }

  // 1. Header
  definition.program.header.forEach(line => {
    emitTemplateLine(substituteTemplates(line, commonContext))
  })

  // 2. Units (if not already in header)
  const headerContainsUnits = definition.program.header.some(l => l.includes('{unitsCommand}'))
  if (unitsCommand && !headerContainsUnits) {
    emitTemplateLine(unitsCommand)
  }

  // 3. WCS (if not already in header)
  const headerContainsWCS = definition.program.header.some(l => l.includes('{wcsCommand}'))
  if (wcsCommand && !headerContainsWCS) {
    emitTemplateLine(wcsCommand)
  } else if (headerContainsWCS && !definition.workCoordinates.selectCommand) {
    warnings.push({ code: 'postWcsNullSelect' })
  }

  // Which setup the program is for, and how the part must sit (issue #946).
  // Nothing is written for a project with a single setup.
  warnings.push(...setupPlan.warnings)
  for (const comment of setupPlan.headerComments) {
    emitLine(`${definition.program.commentPrefix} ${safeCommentText(comment, definition)}${definition.program.commentSuffix}`)
  }

  // The bar is turned by the program itself in a manual-index setup whose
  // machine can turn it (#1054 slice 2b), but not from here: the opening
  // retract and turn are written after the first operation's tool change,
  // immediately before that operation's motion (#1054 fix 1, finding 1), and
  // the retract is machine-coordinate (#1054 fix 2), to the machine
  // definition's own Safe Z (#1054 fix 3). See `emitManualIndexTurn`.
  let pendingManualIndexAngle = setupPlan.manualIndexAngle

  // 4. Operations
  // A plasma table's torch path is written in both pierce modes: controller
  // piercing (QtPlasmaC, #959) and G-code piercing (Grbl, #983). They differ
  // only in who owns pierce height, delay and the touch-off.
  const plasma = resolveMachineKind(definition) === 'plasma' ? definition.plasma : undefined
  const plasmaTorch = plasma?.pierceMode === 'controller'
  const plasmaGcode = plasma?.pierceMode === 'gcode'
  const sequence = planProgramSequence(input, {
    coolant: definition.coolant !== null,
    plasmaTorch,
    plasmaGcode,
    toolChange: [
      ...definition.toolChange.commands,
      ...(definition.toolChange.pauseAfterChange ? [definition.toolChange.pauseCommand] : []),
    ].some((line) => {
      const command = line.trim()
      return command.length > 0 && !command.startsWith(';') && !(definition.program.commentPrefix && command.startsWith(definition.program.commentPrefix))
    }),
  })

  // Emit a single arc (G2/G3) with I/J or R, respecting modal state. A plasma
  // cut passes no feed: it runs at the material's feed word.
  const emitArcLine = (arc: ArcMoveDescriptor, feed?: number) => {
    const lineSegments: string[] = []
    const motionCmd = arc.clockwise
      ? definition.motion.cwArcCommand
      : definition.motion.ccwArcCommand

    // A folded full circle — the only arc that ends where it began — always
    // spells its motion word. QtPlasmaC's hole handling reads the arc command
    // off the block, so leaving it to modal motion would make recognition
    // depend on the controller reconstructing it. Nothing else is affected:
    // such an arc exists only where `foldFullCircleArcs` ran, on the
    // controller-pierced plasma path.
    const foldedCircle = plasmaTorch
      && arc.endPoint.x === arc.startPoint.x
      && arc.endPoint.y === arc.startPoint.y

    if (!definition.motion.modalMotion || state.motionCommand !== motionCmd || foldedCircle) {
      lineSegments.push(motionCmd)
      state.motionCommand = motionCmd
    }

    // I/J are relative to where the controller actually is — the formatted
    // endpoint of the preceding block — not to the arc's declared start.
    const start = emittedPosition ?? {
      x: formatValue(arc.startPoint.x),
      y: formatValue(arc.startPoint.y),
    }
    const emitted = resolveEmittedArc(arc, start, arcEmitOptions)

    lineSegments.push(`X${formatGCodeNumber(arc.endPoint.x, definition, outputUnits)}`)
    lineSegments.push(`Y${formatGCodeNumber(arc.endPoint.y, definition, outputUnits)}`)

    if (definition.motion.arcFormat === 'ij') {
      lineSegments.push(`I${formatGCodeNumber(emitted.i, definition, outputUnits)}`)
      lineSegments.push(`J${formatGCodeNumber(emitted.j, definition, outputUnits)}`)
    } else {
      lineSegments.push(`R${formatGCodeNumber(emitted.radius, definition, outputUnits)}`)
    }

    if (feed !== undefined && motionCmd !== definition.motion.rapidCommand) {
      const feedChanged = state.feedRate !== feed
      if (!definition.feedSpeed.modalFeedSpeed || feedChanged) {
        const fWord = `${definition.feedSpeed.feedCommand}${formatGCodeNumber(feed, definition, outputUnits)}`
        if (definition.feedSpeed.inlineWithMotion) {
          lineSegments.push(fWord)
        } else if (feedChanged) {
          emitLine(fWord)
        }
        state.feedRate = feed
      }
    }

    if (lineSegments.length > 0) {
      emitLine(lineSegments.join(' '))
      moveCount += 1
    }

    state.currentPosition = {
      x: arc.endPoint.x,
      y: arc.endPoint.y,
      z: state.currentPosition?.z ?? 0,
      ...(arc.endPoint.a !== undefined ? { a: arc.endPoint.a } : null),
    }

    emittedPosition = {
      x: formatValue(arc.endPoint.x),
      y: formatValue(arc.endPoint.y),
    }
  }

  const comment = (text: string) => {
    const suffix = definition.program.commentSuffix
    emitLine(`${definition.program.commentPrefix} ${safeCommentText(text, definition)}${suffix ? ` ${suffix}` : ''}`)
  }

  /**
   * The program's fallback safe Z for one operation: the stock top plus the
   * project's operation clearance, the formula every generator uses
   * (`getOperationSafeZ`), mapped into the emitted machine frame exactly as a
   * move's own Z is. It is read only when the operation's own planned rapids
   * give no height to use.
   *
   * The generators work in the setup-local frame (a turned setup's project is
   * turned top-down before generation), and `getOperationSafeZ` is a height
   * above the face that is up. The point handed to `projectToMachinePoint` is
   * therefore carried back into the canonical stock frame first, or a Bottom
   * setup would flip the clearance below the table.
   */
  const generatorSafeZ = (operation: PostProcessorInput['operations'][number]['operation']): number => {
    const setup = setupFrameForOperation(project, operation)
    const local = { x: 0, y: 0, z: getOperationSafeZ(project) }
    const canonical = setup ? setupToCanonicalPoint(local, setup) : local
    return projectToMachinePoint(canonical, project.origin, definition, setup).z
  }

  /**
   * Place the tool at the point the operation's first move starts from:
   * one rapid with X, Y and — when there is an angle to state — the rotary
   * word, then one rapid to its start plane when that first move is a feed or
   * an arc. Nothing here writes Z before the XY plane it belongs to.
   *
   * `stateAngle` forces the setup's own A angle, which a bar Top/Bottom
   * program restates after every tool change (Codex review of slice F, finding
   * 6): the tool-change macro may have turned the bar, and the operation's
   * toolpath does not carry the setup's index angle, so only the program's own
   * setup angle is proof of where the face is.
   */
  const placeAtStart = (
    start: ToolpathPoint,
    startPlane: number | null,
    stateAngle: boolean,
  ): void => {
    const plane: Partial<ToolpathPoint> = { x: start.x, y: start.y }
    if (stateAngle && setupPlan.manualIndexAngle !== null && state.rotaryWord !== null) {
      plane.a = setupPlan.manualIndexAngle * rotaryDirection(definition)
    } else if (start.a !== undefined && state.rotaryWord !== null) {
      plane.a = start.a
    }
    // Force the angle word: a tool-change macro may have moved the bar even
    // when the next move keeps the last angle. The tracked angle is restored
    // when the move carries none.
    const trackedAngle = state.rotaryAngle
    state.rotaryAngle = null
    emitMotionLine(definition.motion.rapidCommand, plane)
    if (plane.a === undefined) {
      state.rotaryAngle = trackedAngle
    }
    if (startPlane !== null) {
      emitMotionLine(definition.motion.rapidCommand, { z: startPlane })
    }
  }

  /**
   * One full restart block after a tool change (#1057 slice F).
   *
   * A tool-change template is the one machine text allowed to do anything:
   * move any axis, index the bar, select incremental coordinates or
   * inverse-time feed, call a macro. Every tracked position and modal mode is
   * therefore stale when it returns, and the program starts over before the
   * operation's own approach:
   *
   * a. `G90 G94 G17` restores the distance, feed and plane modes every
   *    coordinate below depends on, then the units word restates the frame the
   *    numbers are in.
   * b. One rapid to a proven safe Z, always stated. A bar Top/Bottom program
   *    uses the machine-coordinate retract whatever the blank's shape
   *    (finding 7): a square blank's travel height is a work-coordinate height
   *    and a tool change may have changed the work frame, so it is never the
   *    restart retract. A square blank that turns in any *other* program still
   *    uses its travel height (#1016). Any other program — including a round
   *    bar's Around program — uses the operation's own rapid clearance.
   * c. `placeAtStart` states X, Y and the setup angle where there is one.
   * d. `placeAtStart` states the start plane of a feed or an arc.
   *
   * `start` is null when the operation has no motion at all: the block then
   * still restores the modal baseline, and there is nothing to place.
   * `retractFirst: false` writes only that baseline: a manual-index program's
   * own opening turn follows immediately and is itself the machine-coordinate
   * retract plus a stated angle (#1054), so a second retract would be noise.
   * The caller places the start after that turn instead (finding 5).
   *
   * `afterClearance` runs once the retract has proved the height and before
   * the operation's first angle word — the machine's Zero A line (#1103 slice
   * ca-h), which must execute above the work and before any turn.
   */
  const restartAfterToolChange = (
    start: ToolpathPoint | null,
    safeZ: number,
    startPlane: number | null,
    retractFirst: boolean,
    afterClearance?: () => void,
  ): void => {
    emitLine(`${MODAL_DISTANCE_COMMAND} ${MODAL_FEED_COMMAND} ${MODAL_PLANE_COMMAND}`)
    state.inverseTime = false
    state.feedRate = null
    // Every block below is a rapid: the tool-change template may have left the
    // controller in arc or linear mode.
    state.motionCommand = null
    if (unitsCommand) emitLine(unitsCommand)
    if (start === null) return
    // A manual-index program's own opening turn follows this block and is
    // itself a machine-coordinate retract plus a stated angle (#1054), so it
    // places the tool: writing the retract and the plane here as well would
    // retract twice. Only the modal baseline above is written then.
    if (!retractFirst) return
    if (barSetupProgram && barTravelZ !== null && machineRapidCommand !== null && emitMachineCoordinateRetract()) {
      // A manual-index program of a bar retracts in machine coordinates, as its
      // opening turn does (#1054), and it does so whatever the blank's shape
      // (finding 7). That leaves the work frame unknown, so the tracking below
      // is deliberately not trusted as a work height: the next motion restates
      // Z before it cuts, and an A word repairs a square blank's height through
      // `retractUnknownSquareZ`.
      state.zKnown = false
    } else if (programTurns && squareRetractZ !== null) {
      // A square blank turns only at its proven travel height (#1016).
      emitMotionLine(definition.motion.rapidCommand, { z: squareRetractZ })
    } else {
      emitMotionLine(definition.motion.rapidCommand, { z: safeZ })
    }
    afterClearance?.()
    placeAtStart(start, startPlane, barSetupProgram)
  }

  // One plasma operation whose torch path is written. Controller piercing
  // (#959) leaves pierce height, delay and cut height to QtPlasmaC's material
  // table: the program is XY motion, the material handshake and torch on/off,
  // with no Z word (its load filter strips Z motion) and no numeric F on a cut.
  // G-code piercing (#983) owns all of it: per cut the program probes the
  // sheet, sets Z zero on it, then pierces, dwells, drops to cut height and
  // cuts at the cut feed. Until the program's first touch-off, safe Z is the
  // toolpath's own safe height in the operator's zero; every height after one,
  // the retract and later safe rapids included, is measured from the sheet
  // surface the probe found.
  //
  // True once a touch-off has put Z zero on the sheet. It outlives the
  // operation: a later operation in the same program starts in that frame.
  let plasmaZeroOnSheet = false
  const emitPlasmaOperation = (
    operation: PostProcessorInput['operations'][number]['operation'],
    tool: PostProcessorInput['operations'][number]['tool'],
    toolpath: PostProcessorInput['operations'][number]['toolpath'],
    step: OperationSequence,
    block: NonNullable<MachineDefinition['plasma']>,
  ) => {
    const sequence = step.plasma!
    const kerf = `${formatGCodeNumber(tool.diameter, definition, outputUnits)} ${outputUnits}`
    comment(block.pierceMode === 'controller'
      ? `Plasma: kerf ${kerf}${sequence.materialNumber === null ? ', no material number' : `, material ${sequence.materialNumber}`}`
      : `Plasma: kerf ${kerf}`)
    if (block.pierceMode === 'controller' && sequence.selectMaterial && sequence.materialNumber !== null) {
      // Select, wait, then take the feed: the interpreter reads ahead, so a
      // feed word ahead of the wait takes the previous material's feed.
      emitTemplateLine(substituteTemplates(block.materialSelectCommand ?? '', { materialNumber: sequence.materialNumber }))
      emitTemplateLine(block.materialWaitCommand ?? '')
      emitTemplateLine(block.materialFeedCommand ?? '')
      state.feedRate = null
    }
    const plan = planOperationMotion({
      project,
      definition,
      operation,
      toolpath,
      arcEmitOptions,
      startPosition: emittedPosition,
      captureTrace,
    })
    warnings.push(...plan.warnings)
    const travelTo = (point: ToolpathPoint) => {
      const at = state.currentPosition
      if (at === null || at.x !== point.x || at.y !== point.y) {
        emitMotionLine(definition.motion.rapidCommand, { x: point.x, y: point.y })
      }
    }
    if (block.pierceMode === 'gcode') {
      // G-code piercing writes the drop and every cut move as explicit F words.
      // A feed that is missing, non-finite, non-positive, or positive but
      // rounds to zero at the definition's precision would command a move with
      // F0: the torch fires, then the machine does not move. That program must
      // not be saved, so both feeds are raised as errors here, where the
      // effective values and the emitted-precision formatter are both in scope.
      for (const [code, feed] of [
        ['postPlasmaCutFeedMissing', step.cutFeed],
        ['postPlasmaPlungeFeedMissing', step.plungeFeed],
      ] as const) {
        if (!Number.isFinite(feed) || feed <= 0 || formatValue(feed) <= 0) {
          warnings.push({ code, params: { operation: operation.name } })
        }
      }
      // The touch-off block is required for this mode by the schema; the guard
      // covers a definition that reached the emitter without validation.
      const touchOff = block.touchOff
      const safeZ = plasmaSafeZ(plan.steps)
      const path = planPlasmaPath(plan.steps)
      // Cuts with no rapid to read the safe height from cannot be placed, and
      // leaving them out would save a program that quietly lacks the pass.
      if (touchOff && safeZ === null && path.some((item) => item.kind === 'cut')) {
        warnings.push({ code: 'postPlasmaSafeHeightMissing', params: { operation: operation.name } })
      }
      if (touchOff && safeZ !== null) {
        const heights = planPlasmaGcodeCut({
          tool,
          touchOff,
          units: outputUnits,
          safeZ,
          sheetZ: plasmaSheetZ(project, definition, operation),
        })
        const probe = `${touchOff.probeCommand} Z-${formatGCodeNumber(heights.probeDepth, definition, outputUnits)}`
          + ` F${formatGCodeNumber(heights.probeFeed, definition, outputUnits)}`
        // The offset is applied negatively: the sheet surface is that far above
        // where the switch tripped. An absent offset is 0.
        const setZero = `${touchOff.setZeroCommand} Z${formatGCodeNumber(-heights.switchOffset, definition, outputUnits)}`
        const dwell = `G4 P${formatGCodeNumber(heights.pierceDelay, definition, outputUnits)}`
        for (const item of path) {
          // A cut does its own safe-Z and pierce rapids; the travel items exist
          // for the controller path, where the torch fires on XY alone. The
          // safe rapid is in the operator's zero only before the program's
          // first touch-off. After one, Z zero is on the sheet and the head
          // sits at the sheet-relative retract of the previous cut, so the
          // rapid is skipped unless this operation's safe height differs.
          if (item.kind !== 'cut') continue
          const safe = plasmaZeroOnSheet ? heights.sheetSafeZ : heights.safeZ
          if (state.currentPosition?.z !== safe) {
            emitMotionLine(definition.motion.rapidCommand, { z: safe })
          }
          emitMotionLine(definition.motion.rapidCommand, { x: item.pierce.x, y: item.pierce.y })
          emitTemplateLine(probe)
          // G38.2 leaves the controller in its own motion mode: the pierce
          // rapid must spell G0 rather than continue the modal one.
          state.motionCommand = null
          // The probe's own F word becomes the controller's modal feed, behind
          // the emitter's back. Invalidate the tracked feed rather than copy the
          // probe feed into it: the drop below must spell its configured plunge
          // F even when that feed equals the probe feed (issue #983).
          state.feedRate = null
          emitTemplateLine(setZero)
          plasmaZeroOnSheet = true
          emitMotionLine(definition.motion.rapidCommand, { z: heights.pierceHeight })
          emitTemplateLine(block.torchOnCommand)
          // A dwell is not a turning move: never written inside inverse time.
          leaveInverseTime()
          emitLine(dwell)
          emitMotionLine(definition.motion.linearCommand, { z: heights.cutHeight }, step.plungeFeed)
          for (const move of item.moves) {
            if (move.kind === 'linear') {
              emitMotionLine(definition.motion.linearCommand, { x: move.point.x, y: move.point.y }, step.cutFeed)
            } else {
              emitArcLine(move, step.cutFeed)
            }
          }
          emitTemplateLine(block.torchOffCommand)
          // Z zero is on the sheet now: the operator-zero safe height would be
          // a different height, below the sheet when their zero sits above it.
          emitMotionLine(definition.motion.rapidCommand, { z: heights.sheetSafeZ })
        }
      }
    } else {
      for (const item of planPlasmaPath(plan.steps)) {
        if (item.kind === 'travel') {
          travelTo(item.to)
          continue
        }
        travelTo(item.pierce)
        emitTemplateLine(block.torchOnCommand)
        for (const move of item.moves) {
          if (move.kind === 'linear') {
            emitMotionLine(definition.motion.linearCommand, { x: move.point.x, y: move.point.y })
          } else {
            emitArcLine(move)
          }
        }
        emitTemplateLine(block.torchOffCommand)
      }
    }
    if (plan.trace) {
      motionTraces.push(plan.trace)
    }
  }

  operations.forEach(({ operation, tool, toolpath }, opIndex) => {
    const step = sequence[opIndex]
    const { rpm } = step
    warnings.push(...step.warnings)
    if (step.plasma?.skip) return
    const operationContext = {
      ...commonContext,
      operationIndex: opIndex + 1,
      operationName: safeCommentText(operation.name, definition),
      operationDescription: safeCommentText(operation.description ?? '', definition),
      operationKind: operation.kind,
      operationPass: operation.pass,
      operationTarget: operationTargetSummary(operation.target),
      toolNumber: step.toolNumber,
      toolName: safeCommentText(tool.name, definition),
      feed: formatGCodeNumber(step.cutFeed, definition, outputUnits),
      plungeFeed: formatGCodeNumber(step.plungeFeed, definition, outputUnits),
      rpm: formatGCodeNumber(rpm, definition, outputUnits),
    }
    const descriptionLines = safeCommentLines(operation.description ?? '', definition)

    // An operation header is a template: it may carry a dwell or a positioning
    // move, neither of which may run in inverse-time mode (issue #393, rule 4).
    leaveInverseTime()
    if (definition.program.operationHeader.length > 0) {
      emitTemplateLines(definition.program.operationHeader, operationContext, descriptionLines)
    } else {
      emitLine(`${definition.program.commentPrefix} Operation: ${operationContext.operationName}${definition.program.commentSuffix}`)
    }
    // An intentional spoilboard cut is said in the program too, where the
    // operator at the machine reads it (issue #834). No overcut, no line.
    const overcut = resolveVerticalOvercut(project, operation)
    if (overcut.kind === 'ok' && edgeRouteOvercutApplies(project, operation)) {
      emitLine(`${definition.program.commentPrefix} ${safeCommentText(verticalOvercutCommentText(overcut.amount, project.meta.units), definition)}${definition.program.commentSuffix}`)
    }

    if (step.plasma && plasma) {
      emitPlasmaOperation(operation, tool, toolpath, step, plasma)
      return
    }

    // Canned cycles write the borrowed motor's letter as a linear coordinate,
    // and a cycle's positioning is not a turning feed move (issue #393, rule
    // 3b). They are written only on a machine that borrows no motor and for a
    // toolpath that carries no angle anywhere; otherwise the expanded moves are
    // used, exactly as on a machine with canned cycles off.
    const toolpathCarriesAngle = toolpath.moves.some(
      (move) => move.from.a !== undefined || move.to.a !== undefined,
    )
    const cannedCycles = operation.kind === 'drilling'
      && toolpath.drillCycles
      && toolpath.drillCycles.length > 0
      && definition.cannedCycles
      && rotaryBorrowedAxis(definition) === null
      // A canned cycle writes its hole position as X and Y whatever the axis
      // does (issue #1156), so a program that holds its cross axis by touch-off
      // expands the cycles instead.
      && heldCrossAxis === null
      && !toolpathCarriesAngle
      ? planDrillCycles(project, definition, toolpath.drillCycles, operation)
      : null
    const cannedBlock = definition.cannedCycles
    const cannedCmd = cannedCycles !== null && cannedBlock !== null
      ? cannedCommandFor(cannedBlock, cannedCycles[0].cycle.drillType)
      : null
    // The motion plan is made before the tool change: the restart block below
    // states where the operation's first move starts from and the height its
    // own rapids use. Its warnings are appended where they have always been.
    const plan = cannedCmd !== null ? null : planOperationMotion({
      project,
      definition,
      operation,
      toolpath,
      arcEmitOptions,
      startPosition: emittedPosition,
      captureTrace,
    })
    // The height the restart retracts to: the operation's own clearance (the
    // height its rapids travel at), never a cutting point. A canned cycle
    // positions at its first hole's clear plane, which is its safe height.
    const operationSafeZ = plan !== null
      ? plannedSafeZ(plan.steps) ?? generatorSafeZ(operation)
      : cannedCycles![0].clear.z
    const restartStart = plan !== null
      ? plan.steps.length > 0
        ? plannedStepStart(project, definition, operation, toolpath, plan.steps, 0)
        : null
      : cannedCycles![0].clear
    // A feed or an arc that starts the operation states its own plane after
    // the XY reposition; a rapid's own split writes Z first, so it needs none.
    const firstStep = plan?.steps[0]
    const restartStartPlane = firstStep === undefined
      ? null
      : firstStep.kind === 'arc'
        ? firstStep.startPoint.z
        : firstStep.moveKind === 'rapid'
          ? null
          : restartStart!.z

    // #1103 slice ca-h, part 3: a filled Zero A line opens a rotary operation
    // after its clearance retract and before its first turn. Two paths can
    // prove that clearance — the post-tool-change restart and the manual-index
    // turn — and the hook below runs inside whichever one this operation uses.
    // An operation with neither (no tool change is emitted) gets its own
    // machine-coordinate retract before the moves instead.
    const rotaryOpensHere = zeroALines.length > 0 && state.rotaryWord !== null
      && (commandsAngle[opIndex] || pendingManualIndexAngle !== null)
    const zeroAOpening = rotaryOpensHere ? () => emitZeroALine(zeroALines) : undefined
    const zeroAAtOperationStart = zeroAOpening !== undefined && pendingManualIndexAngle === null
      && commandsAngle[opIndex]
      ? zeroAOpening
      : undefined
    const zeroAAtManualIndex = zeroAOpening !== undefined && pendingManualIndexAngle !== null
      ? zeroAOpening
      : undefined

    // Tool change
    if (step.changeTool) {
      // Inverse-time mode is left before the program pauses (rule 4): a tool
      // change is not a turning move, and the controller must not resume in a
      // feed mode whose F means something else.
      leaveInverseTime()
      if (definition.toolChange.stopSpindleFirst && step.spindleRunningAtToolChange) {
        emitTemplateLine(definition.feedSpeed.spindleOff)
      }

      const toolContext = {
        ...operationContext,
      }

      definition.toolChange.commands.forEach(cmd => {
        emitTemplateLine(substituteTemplates(cmd, toolContext))
      })

      if (definition.toolChange.pauseAfterChange) {
        emitTemplateLine(definition.toolChange.pauseCommand)
      }
    }

    // One full restart after every emitted tool change (#1057 slice F),
    // including the first operation's tool load: a tool-change template may
    // have moved any axis, selected incremental coordinates or changed the
    // feed mode, and every coordinate the operation writes depends on it. The
    // block states Z, X, Y and the rotary word again before the operation's
    // own approach.
    if (step.changeTool) {
      restartAfterToolChange(
        restartStart,
        operationSafeZ,
        restartStartPlane,
        pendingManualIndexAngle === null,
        zeroAAtOperationStart,
      )
    }

    // The manual-index retract and turn (#1054 slice 2b): written here, after
    // the first operation's tool change, so the first motion below it is the
    // operation's own. The retract is machine-coordinate whatever the tool
    // change claims (#1054 fix 2). A machine that emits no tool change still
    // gets it here, immediately before its first motion.
    //
    // The turn is not a placement: it states the angle and leaves X/Y (and the
    // work frame) unknown, so the start is stated *after* it, before any feed
    // (Codex review of slice F, finding 5). The tool-change restart above
    // deliberately wrote only its modal baseline.
    if (pendingManualIndexAngle !== null) {
      emitManualIndexTurn(pendingManualIndexAngle, zeroAAtManualIndex)
      pendingManualIndexAngle = null
      if (restartStart !== null) {
        placeAtStart(restartStart, restartStartPlane, false)
      }
    }

    // #1103 slice ca-h, part 3: no tool change was emitted and no manual-index
    // turn follows, so prove the clearance here before the machine's Zero A
    // line. G53 is the only height that is independent of the work offsets a
    // previous operation may have changed; without it the line (and the turn
    // that follows it) would run at a height nobody proved, which is exactly
    // what a filled Zero A line must not do.
    if (rotaryOpensHere && !step.changeTool && zeroAAtManualIndex === undefined) {
      if (emitMachineCoordinateRetract()) {
        emitZeroALine(zeroALines)
      } else {
        refuseTurnClearance()
      }
    }

    // Spindle On
    if (step.startSpindle) {
      emitTemplateLine(`${definition.feedSpeed.spindleOnCW} ${definition.feedSpeed.rpmCommand}${formatGCodeNumber(rpm, definition, outputUnits)}`)
    }

    // Coolant
    if (step.startCoolant && definition.coolant) {
      emitTemplateLine(definition.coolant.floodOnCommand)
    }

    // Moves — emit canned cycles for drilling when supported, else expanded G0/G1
    if (cannedCycles !== null && cannedBlock !== null) {
      // A canned cycle is not a turning move and must not run in inverse-time
      // mode (rule 4).
      leaveInverseTime()
      const cycles = cannedCycles
      const cannedDef = cannedBlock

      const cycleDrillType = cycles[0].cycle.drillType

      if (cannedCmd) {
        const plungeFeed = step.plungeFeed
        const feedWord = definition.feedSpeed.feedCommand
        let feedEmitted = false

        // Rapid to first hole XY at clearZ so the controller has a defined initial plane
        const firstMachineXY = cycles[0].clear
        if (state.currentPosition) {
          const cp = state.currentPosition
          if (cp.z !== firstMachineXY.z) {
            emitMotionLine(definition.motion.rapidCommand, { z: firstMachineXY.z })
          }
          if (cp.x !== firstMachineXY.x || cp.y !== firstMachineXY.y) {
            emitMotionLine(definition.motion.rapidCommand, { x: firstMachineXY.x, y: firstMachineXY.y })
          }
        } else {
          emitMotionLine(definition.motion.rapidCommand, { x: firstMachineXY.x, y: firstMachineXY.y, z: firstMachineXY.z })
        }

        // Retract mode (G98 / G99), once before the first canned line
        if (cannedDef.retractMode) {
          emitTemplateLine(cannedDef.retractMode)
        }

        // Emit modal canned-cycle lines
        let lastZ: string | null = null
        let lastR: string | null = null
        let lastQ: string | null = null
        let lastP: string | null = null

        for (const { cycle, at: machineXY, bottomZ: machineBottomZ, retractZ: machineRetractZ } of cycles) {
          moveCount += 1

          const segs: string[] = []

          // Command word (modal — only when first or when motion state was reset)
          if (state.motionCommand !== cannedCmd) {
            segs.push(cannedCmd)
            state.motionCommand = cannedCmd
          }

          // X / Y
          segs.push(`X${formatGCodeNumber(machineXY.x, definition, outputUnits)}`)
          segs.push(`Y${formatGCodeNumber(machineXY.y, definition, outputUnits)}`)

          // Z (bottom)
          const zStr = formatGCodeNumber(machineBottomZ, definition, outputUnits)
          if (zStr !== lastZ) {
            segs.push(`Z${zStr}`)
            lastZ = zStr
          }

          // R (retract plane)
          const rStr = formatGCodeNumber(machineRetractZ, definition, outputUnits)
          if (rStr !== lastR) {
            segs.push(`R${rStr}`)
            lastR = rStr
          }

          // Q (peck step) — only for peck / chip_breaking with positive peckDepth
          if ((cycleDrillType === 'peck' || cycleDrillType === 'chip_breaking') && cycle.peckDepth && cycle.peckDepth > 0) {
            const qStr = formatGCodeNumber(cycle.peckDepth, definition, outputUnits)
            if (qStr !== lastQ) {
              segs.push(`${cannedDef.peckStepWord}${qStr}`)
              lastQ = qStr
            }
          }

          // P (dwell time) — only for dwell type with positive dwellTime
          if (cycleDrillType === 'dwell' && cycle.dwellTime && cycle.dwellTime > 0) {
            const pStr = formatGCodeNumber(cycle.dwellTime, definition, outputUnits)
            if (pStr !== lastP) {
              segs.push(`P${pStr}`)
              lastP = pStr
            }
          }

          // F (plunge feed) — emit once, inline with motion
          if (!feedEmitted) {
            segs.push(`${feedWord}${formatGCodeNumber(plungeFeed, definition, outputUnits)}`)
            state.feedRate = plungeFeed
            feedEmitted = true
          }

          emitTemplateLine(segs.join(' '))
        }

        // Cancel canned cycle
        emitTemplateLine(cannedDef.cancelCommand)

        // Reset state: canned cancel breaks motion modality
        state.motionCommand = null

        // Track position as last hole's XY at clearZ (machine coords)
        const lastMachinePos = cycles[cycles.length - 1].clear
        state.currentPosition = { x: lastMachinePos.x, y: lastMachinePos.y, z: lastMachinePos.z }
      } else {
        // Command not available for this drill type — fall back to expanded moves
        warnings.push({
          code: 'postCannedCycleUnsupported',
          params: { operation: operation.name, drillType: cycleDrillType, machine: definition.name },
        })
      }
    }

    if (plan !== null) {
      warnings.push(...plan.warnings)
      // Emit a single rapid (G0) with per-axis splitting. `splitRapid` decides
      // which block carries the angle — never a block with Z (issue #393).
      const emitRapid = (pt: ToolpathPoint) => {
        for (const axes of splitRapid(state.currentPosition, pt)) {
          // A rapid that carries a new A word turns the blank. If a template
          // moved Z since the last motion block, the height the split decided
          // from is no longer trustworthy, so retract before writing the angle
          // (the split already keeps the angle off any Z block).
          if (axes.a !== undefined && state.rotaryWord !== null && state.rotaryAngle !== axes.a) {
            retractUnknownSquareZ()
          }
          emitMotionLine(definition.motion.rapidCommand, axes)
        }
      }

      // The feed word of every emitted block (issue #393, rule 4). Planned from
      // the operation's own project moves, so a turning move's path length is
      // measured before a borrowed motor's coordinate is dropped. A block of
      // stock has no centreline, so every feed is the ordinary one.
      const feeds = planStepFeeds({
        projectMoves: toolpath.moves,
        steps: plan.steps,
        centre: rotaryCentreline(project.stock),
        tolerance: exportGeometryTolerance(project.meta.units),
        operationName: operation.name,
        direction: rotaryDirection(definition),
        effectiveFeed: (planned) => planned.kind === 'linear' && planned.moveKind === 'plunge'
          ? effectiveFeed('plunge', planned.feedScale, step.cutFeed, step.plungeFeed)
          : effectiveFeed('cut', planned.feedScale, step.cutFeed, step.plungeFeed),
      })

      plan.steps.forEach((d, index) => {
        const directive = feeds[index] ?? { mode: 'none' as const }
        if (d.kind === 'arc') {
          // A fitted arc is at a constant angle by construction (rule 2 keeps
          // turning moves out of arc runs), so it leaves inverse-time mode and
          // carries no angle word of its own.
          leaveInverseTime()
          const feed = directive.mode === 'normal'
            ? directive.feed
            : effectiveFeed('cut', d.feedScale, step.cutFeed, step.plungeFeed)
          emitArcLine(d, feed)
        } else if (d.moveKind === 'rapid') {
          emitRapid(d.point)
        } else {
          emitPlannedMove(d.point, directive)
        }
      })

      // Debug-only (issue #356): the machine-coordinate motion trace for the
      // exported-motion debug view.
      if (plan.trace) {
        motionTraces.push(plan.trace)
      }
    }

    // #1103 slice ca-h, part 2: an operation that commands A ends facing 0 up.
    // After its own final retract a machine-coordinate retract proves the
    // clearance (#1054), then a forward-only turn goes to the next whole turn —
    // never a rewind, never a modulo-360 wrap. A whole turn is the same
    // physical orientation as A0, so zeroing A (the operator's, or the next
    // operation's Zero A line) restores this operation's own frame and the bar
    // is left in a known orientation when the operator runs the operations
    // separately. A manual-index Top/Bottom program commands its A once, at
    // the program's opening turn, so its turn is written after its last
    // operation only; turning after each one would cut a later operation on
    // the wrong face.
    const manualIndexEndAngle = opIndex === operations.length - 1 && setupPlan.manualIndexAngle !== null
      ? setupPlan.manualIndexAngle * rotaryDirection(definition)
      : null
    const lastAngle = plan !== null && commandsAngle[opIndex]
      ? lastPlannedAngle(plan.steps)
      : manualIndexEndAngle
    if (lastAngle !== null && state.rotaryWord !== null) {
      const endTurn = nextWholeTurn(lastAngle)
      if (endTurn > lastAngle + WHOLE_TURN_EPSILON) {
        if (emitMachineCoordinateRetract()) {
          state.motionCommand = null
          // State the angle even if it happens to equal the last one written:
          // the turn must be a turn the controller is told about.
          state.rotaryAngle = null
          emitMotionLine(definition.motion.rapidCommand, { a: endTurn })
          // G53 left X/Y (and the work frame) unknown; the A-only rapid must
          // not invent a position for them.
          state.currentPosition = null
          emittedPosition = null
        } else {
          refuseTurnClearance()
        }
      }
      // "0 up" is said with a comma rather than the handoff's parentheses: a
      // parenthesised comment dialect (generic, grblHAL, LinuxCNC, Mach3,
      // UCCNC) cannot carry a nested pair — the inner `)` would end the
      // comment and post the rest as code — and `safeCommentText` strips them
      // anyway, which reads as "A is at 720 0 up . Zero A…".
      comment(`A is at ${formatGCodeNumber(endTurn, definition, outputUnits)}, 0 up. Zero A before the next operation.`)
      // Part 3: with no machine Zero A line the operator has to zero A between
      // rotary operations by hand, so the program pauses there. A program whose
      // last rotary operation ends here has nothing to zero for, so it does not
      // pause.
      if (zeroALines.length === 0 && commandsAngle.slice(opIndex + 1).some(Boolean)) {
        comment('Zero A at 0 up, then resume.')
        // The instruction is worthless without a stop the machine must obey
        // (#1152 correction round 1, finding 2; round 2, finding 1). A machine
        // may carry no pause template at all, one that is only a comment, or
        // one whose command does not stop the program — `M1` waits for an
        // optional-stop switch that may be off, `M5` only stops the spindle.
        // Only a template carrying `M0` is used as written; everything else is
        // replaced by `M0`, the mandatory stop every G-code dialect with a
        // rotary axis understands. (A ShopBot cannot carry a rotary axis —
        // validation refuses the block — so its part-file stop is out of this
        // path.)
        const pause = substituteTemplates(definition.toolChange.pauseCommand, operationContext)
        emitTemplateLine(
          templateHasMandatoryStop(pause, definition.outputDialect) ? pause : MANUAL_PAUSE_COMMAND,
        )
        // The operator has just made the bar's current orientation A0, so the
        // controller's A restarts at 0. Keeping the pre-pause number hid the
        // next operation's own positioning word (finding 1).
        markRotaryZeroed()
      }
    }

    // Spindle off after the last move when the program ends here, or a tool
    // change that is actually going to be written comes next. The spindle stop
    // is not a turning move, so inverse-time mode is left *before* it (rule 4):
    // an `M5` written while `G93` is in force stops the spindle under a feed
    // mode whose F means something else.
    if (step.stopSpindleAfter) {
      leaveInverseTime()
      emitTemplateLine(definition.feedSpeed.spindleOff)
    }
  })

  // A turn whose clearance retract could not be placed makes the whole program
  // unsafe to save (#1054 fix 2): the missing text is not a cosmetic omission,
  // it is the difference between turning above the bar and turning through it.
  if (turnClearanceRefusal !== null) {
    return {
      gcode: '',
      warnings: [turnClearanceRefusal],
      stats: { lineCount: 0, operationCount: 0, moveCount: 0 },
      ...(captureTrace ? { motionTraces: [] } : null),
    }
  }

  // The program never ends in inverse-time mode (rule 4).
  leaveInverseTime()

  // The bar does not stay where the last operation left it (#1091's no closing
  // *unwind* is kept): since #1103 slice ca-h every operation that commands A
  // already ended with a forward turn to the next whole turn — 0 up — so the
  // program ends on that turn rather than on the operation's own retract. It is
  // a forward turn, not a rewind, which is what #1091 forbade.

  // 5. Footer
  definition.program.footer.forEach(line => {
    emitTemplateLine(substituteTemplates(line, commonContext))
  })

  // 6. Program end
  emitTemplateLine(definition.stop.programEndCommand)

  // The machine's own templates may not write the word that turns the rotary
  // (issue #393, rule 3c), judged on the lines the program actually wrote. On a
  // machine that borrows a motor any such line refuses the program; on one with
  // its own axis it refuses only a program that turns, because the line is
  // harmless while nothing rotates. A refused program carries no text.
  const rotaryLetter = rotaryWord(definition)
  if (rotaryLetter !== null) {
    const prefix = definition.program.commentPrefix
    const templateDrivesRotary = templateLines.some(
      (line) => lineCarriesAxisWord(line, rotaryLetter, prefix),
    )
    // #1153: a template that writes the rotary word turns the bar whether or
    // not the program's operations do, so on a controller that reads the angle
    // as a length an inch program carrying one is refused outright.
    if (templateDrivesRotary && rotaryInchRefused(definition, project)) {
      return {
        gcode: '',
        warnings: [rotaryInchWarning(operations[0]?.operation.name ?? 'program', definition)],
        stats: { lineCount: 0, operationCount: 0, moveCount: 0 },
        ...(captureTrace ? { motionTraces: [] } : null),
      }
    }
    if (templateDrivesRotary && (rotaryBorrowedAxis(definition) !== null || programTurns)) {
      return {
        gcode: '',
        warnings: [{ code: 'postRotaryTemplateUsesBorrowedAxis', params: { axis: rotaryLetter } }],
        stats: { lineCount: 0, operationCount: 0, moveCount: 0 },
        ...(captureTrace ? { motionTraces: [] } : null),
      }
    }
  }

  return {
    gcode: lines.join('\n'),
    warnings,
    stats: {
      lineCount: lines.length,
      operationCount: operations.length,
      moveCount
    },
    ...(captureTrace ? { motionTraces } : null),
  }
}
