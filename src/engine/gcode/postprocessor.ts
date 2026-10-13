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

import type {
  MachineDefinition,
  PostProcessorInput,
  PostProcessorResult,
  OperationMotionTrace,
} from './types'
import { resolveMachineKind, resolveOutputDialect, rotaryBorrowedAxis, rotaryDirection, rotaryWord } from './types'
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import { formatGCodeNumber } from './utils'
import type { ToolpathPoint } from '../toolpaths/types'
import { effectiveFeed } from '../toolpaths/feed'
import type { OperationTarget } from '../../types/project'
import { resolveEmittedArc } from './arcFitting'
import type { ArcMoveDescriptor } from './arcFitting'
import {
  createArcEmitOptions,
  createEmittedValueFormatter,
  planDrillCycles,
  planOperationMotion,
  planPlasmaGcodeCut,
  planPlasmaPath,
  planProgramSequence,
  planProgramSetup,
  planRotaryRefusals,
  planStepFeeds,
  plasmaSafeZ,
  plasmaSheetZ,
  rotaryCentreline,
  splitRapid,
} from './motionPipeline'
import type { FeedDirective, OperationSequence } from './motionPipeline'
import { exportGeometryTolerance } from '../../utils/units'
import { emitOpenSbpProgram } from './opensbpEmitter'

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
  lineNumber: number
}

function operationTargetSummary(target: OperationTarget): string {
  if (target.source === 'stock') {
    return 'Stock'
  }
  return `${target.featureIds.length} feature${target.featureIds.length === 1 ? '' : 's'}`
}

function safeCommentText(text: string): string {
  return text
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeCommentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => safeCommentText(line))
    .filter((line) => line.length > 0)
}

/**
 * True when a rendered machine-template line carries `letter` as an axis word
 * (issue #393, rule 3c). A word is a letter followed by a value — `Y0`,
 * `Y-5.0`, `Y 0`, `Y#1` — with or without whitespace between them, so
 * `G53 G0 Y0`, `G92 Y0` and the compact `X0Y0` all match while prose does not.
 *
 * Comments are prose and are removed before the scan: an embedded or leading
 * `( … )` comment, and everything from the definition's own line-comment
 * prefix to the end of the line. Code after a parenthesised comment is still
 * code, which is why a line is never skipped just because it starts with one.
 */
function lineCarriesAxisWord(line: string, letter: string, commentPrefix: string): boolean {
  let code = line.replace(/\([^)]*\)/g, ' ')
  // `(` is the parenthesised-comment marker, already removed above; slicing at
  // it would throw away the code that follows.
  if (commentPrefix.length > 0 && commentPrefix !== '(') {
    const at = code.indexOf(commentPrefix)
    if (at >= 0) code = code.slice(0, at)
  }
  for (const match of code.matchAll(/([A-Za-z])\s*[-+]?(?=[0-9.#[])/g)) {
    if (match[1].toUpperCase() === letter) return true
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

function emitProgramForDialect(input: PostProcessorInput): PostProcessorResult {
  switch (resolveOutputDialect(input.definition)) {
    case 'opensbp':
      return emitOpenSbpProgram(input)
    case 'gcode':
      return emitGcodeProgram(input)
  }
}

function emitGcodeProgram(input: PostProcessorInput): PostProcessorResult {
  const { project, operations, definition, options } = input
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
  const emitTemplateLine = (content: string) => {
    templateLines.push(content)
    emitLine(content)
  }

  const substituteTemplates = (text: string, context: Record<string, string | number>): string => {
    return text.replace(/{(\w+)}/g, (_, key) => context[key] !== undefined ? context[key].toString() : `{${key}}`)
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

    if (axes.x !== undefined) {
      lineSegments.push(`X${formatGCodeNumber(axes.x, definition, outputUnits)}`)
    }
    if (axes.y !== undefined) {
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

    emittedPosition = {
      x: axes.x !== undefined ? formatValue(axes.x) : emittedPosition?.x ?? 0,
      y: axes.y !== undefined ? formatValue(axes.y) : emittedPosition?.y ?? 0,
    }
  }

  /**
   * Emit a straight move from a planned step, applying its own feed directive
   * (issue #393, rule 4): a turning feed move enters inverse-time mode first —
   * once, since it is modal — and then carries its own `F` in 1/min whatever
   * `modalFeedSpeed` says. A move at a constant angle follows the ordinary
   * modal-feed rules exactly as before.
   */
  const emitPlannedMove = (point: ToolpathPoint, directive: FeedDirective) => {
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
  const setupPlan = planProgramSetup(input)
  warnings.push(...setupPlan.warnings)
  for (const comment of setupPlan.headerComments) {
    emitLine(`${definition.program.commentPrefix} ${safeCommentText(comment)}${definition.program.commentSuffix}`)
  }

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
    emitLine(`${definition.program.commentPrefix} ${safeCommentText(text)}${suffix ? ` ${suffix}` : ''}`)
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
      emitLine(substituteTemplates(block.materialSelectCommand ?? '', { materialNumber: sequence.materialNumber }))
      emitLine(block.materialWaitCommand ?? '')
      emitLine(block.materialFeedCommand ?? '')
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
          emitLine(probe)
          // G38.2 leaves the controller in its own motion mode: the pierce
          // rapid must spell G0 rather than continue the modal one.
          state.motionCommand = null
          // The probe's own F word becomes the controller's modal feed, behind
          // the emitter's back. Invalidate the tracked feed rather than copy the
          // probe feed into it: the drop below must spell its configured plunge
          // F even when that feed equals the probe feed (issue #983).
          state.feedRate = null
          emitLine(setZero)
          plasmaZeroOnSheet = true
          emitMotionLine(definition.motion.rapidCommand, { z: heights.pierceHeight })
          emitLine(block.torchOnCommand)
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
          emitLine(block.torchOffCommand)
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
        emitLine(block.torchOnCommand)
        for (const move of item.moves) {
          if (move.kind === 'linear') {
            emitMotionLine(definition.motion.linearCommand, { x: move.point.x, y: move.point.y })
          } else {
            emitArcLine(move)
          }
        }
        emitLine(block.torchOffCommand)
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
      operationName: safeCommentText(operation.name),
      operationDescription: safeCommentText(operation.description ?? ''),
      operationKind: operation.kind,
      operationPass: operation.pass,
      operationTarget: operationTargetSummary(operation.target),
      toolNumber: step.toolNumber,
      toolName: safeCommentText(tool.name),
      feed: formatGCodeNumber(step.cutFeed, definition, outputUnits),
      plungeFeed: formatGCodeNumber(step.plungeFeed, definition, outputUnits),
      rpm: formatGCodeNumber(rpm, definition, outputUnits),
    }
    const descriptionLines = safeCommentLines(operation.description ?? '')

    // An operation header is a template: it may carry a dwell or a positioning
    // move, neither of which may run in inverse-time mode (issue #393, rule 4).
    leaveInverseTime()
    if (definition.program.operationHeader.length > 0) {
      emitTemplateLines(definition.program.operationHeader, operationContext, descriptionLines)
    } else {
      emitLine(`${definition.program.commentPrefix} Operation: ${operationContext.operationName}${definition.program.commentSuffix}`)
    }

    if (step.plasma && plasma) {
      emitPlasmaOperation(operation, tool, toolpath, step, plasma)
      return
    }

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

    // Spindle On
    if (step.startSpindle) {
      emitTemplateLine(`${definition.feedSpeed.spindleOnCW} ${definition.feedSpeed.rpmCommand}${formatGCodeNumber(rpm, definition, outputUnits)}`)
    }

    // Coolant
    if (step.startCoolant && definition.coolant) {
      emitTemplateLine(definition.coolant.floodOnCommand)
    }

    // Moves — emit canned cycles for drilling when supported, else expanded G0/G1
    let emittedCanned = false

    // Canned cycles write the borrowed motor's letter as a linear coordinate,
    // and a cycle's positioning is not a turning feed move (issue #393, rule
    // 3b). They are written only on a machine that borrows no motor and for a
    // toolpath that carries no angle anywhere; otherwise the expanded moves are
    // used, exactly as on a machine with canned cycles off.
    const toolpathCarriesAngle = toolpath.moves.some(
      (move) => move.from.a !== undefined || move.to.a !== undefined,
    )

    if (
      operation.kind === 'drilling'
      && toolpath.drillCycles
      && toolpath.drillCycles.length > 0
      && definition.cannedCycles
      && rotaryBorrowedAxis(definition) === null
      && !toolpathCarriesAngle
    ) {
      // A canned cycle is not a turning move and must not run in inverse-time
      // mode (rule 4).
      leaveInverseTime()
      const cycles = planDrillCycles(project, definition, toolpath.drillCycles, operation)
      const cannedDef = definition.cannedCycles

      // Resolve the command word for the operation's drill type
      const drillTypeCommandMap: Record<string, string | null> = {
        simple: cannedDef.drillCommand,
        dwell: cannedDef.drillWithDwellCommand,
        peck: cannedDef.peckDrillCommand,
        chip_breaking: cannedDef.chipBreakDrillCommand,
      }
      const cycleDrillType = cycles[0].cycle.drillType
      const cannedCmd = drillTypeCommandMap[cycleDrillType]

      if (cannedCmd) {
        emittedCanned = true

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
          emitLine(cannedDef.retractMode)
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

          emitLine(segs.join(' '))
        }

        // Cancel canned cycle
        emitLine(cannedDef.cancelCommand)

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

    if (!emittedCanned) {
      // Emit a single rapid (G0) with per-axis splitting. `splitRapid` decides
      // which block carries the angle — never a block with Z (issue #393).
      const emitRapid = (pt: ToolpathPoint) => {
        for (const axes of splitRapid(state.currentPosition, pt)) {
          emitMotionLine(definition.motion.rapidCommand, axes)
        }
      }

      // ── Motion plan (shared by every dialect) ──
      // Machine-coordinate transform, arc fitting, the emitted-arc fallback and
      // the feed each move is written with; this emitter only spells the result
      // as G-code words.
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

  // The program never ends in inverse-time mode (rule 4).
  leaveInverseTime()

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
    const operationTurns = operations.some(({ toolpath }) => toolpath.moves.some(
      (move) => move.from.a !== undefined || move.to.a !== undefined,
    ))
    if (templateDrivesRotary && (rotaryBorrowedAxis(definition) !== null || operationTurns)) {
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
