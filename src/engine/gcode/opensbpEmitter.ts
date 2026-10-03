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
 * ShopBot part-file (`.sbp`) emitter (issue #953) — the `opensbp` output
 * dialect. `runPostProcessor` delegates here; this file spells motion that
 * `motionPipeline.ts` has already planned and decides nothing about it.
 *
 * Where the syntax comes from
 * ---------------------------
 * - ShopBot Programming Handbook, which ShopBot placed in the public domain
 *   together with the part-file syntax: https://www.opensbp.com/
 *   (`files/ProgHand.pdf`). Source for comments (`'`), labels, `IF … THEN
 *   GOTO`, `MSGBOX(body, button type, title)`, `END`, `&` user variables and
 *   the `%(25)` units system variable.
 * - ShopBot's FabMo-Engine (Apache-2.0),
 *   https://github.com/FabMo/FabMo-Engine — `runtime/opensbp/sb3_commands.json`
 *   for the parameter order of `M3`/`J2`/`J3`/`JZ`/`MS`/`CG`/`TR`, and
 *   `profiles/default/macros/` for what `C6`, `C7` and `C9` do. Read as a
 *   reference only: no code is copied from it.
 *
 * Deliberately not consulted: Autodesk's `shopbot.cps` (all rights reserved)
 * and FreeCAD's `opensbp_post.py` (LGPL-2.1+). Nothing here derives from
 * either.
 *
 * "OpenSBP" is a registered trademark of ShopBot Tools, Inc. The dialect id
 * names the language this file writes; the machine is presented to users as
 * "ShopBot (SBP)" and no OpenSBP compliance is claimed.
 *
 * What a program looks like
 * -------------------------
 * - Header: a comment block, the units guard, then `SA` (absolute mode).
 * - Units guard: `%(25)` is 0 when the control software is set to inches and
 *   1 for millimetres. A program jumps to `UNIT_ERROR` — a message box and
 *   `END`, placed after the program's own `END` — rather than run in the
 *   wrong units.
 * - Speeds are modal and in units per **second**: `MS,xy,z`, written only
 *   when a value changes.
 * - Rapids are jogs (`JZ`, `J2`, `J3`), cuts are `M3,x,y,z`, and fitted arcs
 *   are `CG,,endX,endY,I,J,T,dir` with `dir` 1 for clockwise and -1 for
 *   counter-clockwise.
 * - Spindle: `TR,rpm` then `C6` to start, and the same pair again when the
 *   speed changes between operations; `C7` to stop. Tool change: `&Tool=N`
 *   then `C9`, after which speeds and position are treated as unknown.
 * - No canned cycles (drilling is written as its expanded moves), no coolant
 *   (output wiring differs per machine) and no line numbers.
 */

import type { PostProcessorInput, PostProcessorResult, OperationMotionTrace } from './types'
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import type { ToolpathPoint } from '../toolpaths/types'
import { effectiveFeed } from '../toolpaths/feed'
import { resolveEmittedArc } from './arcFitting'
import type { ArcMoveDescriptor } from './arcFitting'
import {
  createArcEmitOptions,
  createEmittedValueFormatter,
  planOperationMotion,
  planProgramSequence,
  splitRapid,
} from './motionPipeline'
import { formatGCodeNumber } from './utils'

/**
 * ShopBot's control software runs on Windows and reads a part file line by
 * line, so lines end in CRLF — including the last one.
 */
export const SBP_LINE_ENDING = '\r\n'

/** Label the units guard jumps to; the block sits after the program's `END`. */
export const SBP_UNIT_ERROR_LABEL = 'UNIT_ERROR'

/** Our feeds are per minute; ShopBot move speeds are per second. */
const SECONDS_PER_MINUTE = 60

/** `MSGBOX` button type for a critical message with a single OK button. */
const MSGBOX_CRITICAL = 16

/** A comment runs to the end of its line, so it must stay on one line. */
function commentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function commentLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => commentText(line))
    .filter((line) => line.length > 0)
}

export function emitOpenSbpProgram(input: PostProcessorInput): PostProcessorResult {
  const { project, operations, definition, options } = input
  const outputUnits = project.meta.units
  const lines: string[] = []
  const warnings: ToolpathWarning[] = []

  // Counts motion lines as emitted (jogs, moves and arcs), not `MS` lines and
  // not the input toolpath moves: arc fitting reduces those and the safe-Z
  // split of a rapid adds to them.
  let moveCount = 0
  const captureTrace = options.captureMotionTrace === true
  const motionTraces: OperationMotionTrace[] = []

  const formatNumber = (value: number): string => formatGCodeNumber(value, definition, outputUnits)
  const formatValue = createEmittedValueFormatter(definition, outputUnits)
  // `CG` takes its centre as an offset from the start point, like I/J.
  const arcEmitOptions = createArcEmitOptions(definition, outputUnits, 'ij')

  let currentPosition: ToolpathPoint | null = null
  // Where the control software believes the tool is: every emitted coordinate
  // after number formatting. Arc centre offsets are measured from this, not
  // from the un-rounded position (the defect behind issue #447).
  let emittedPosition: { x: number; y: number } | null = null
  // The `MS` values last written, as written. Null until the first `MS`, and
  // again after a tool change, whose macro is free to change speeds.
  let emittedSpeeds: { xy: string; z: string } | null = null

  const emit = (line: string) => {
    lines.push(line)
  }
  const emitComment = (text: string) => {
    emit(text.length > 0 ? `' ${text}` : `'`)
  }

  const trackPosition = (axes: Partial<ToolpathPoint>) => {
    currentPosition = {
      x: axes.x ?? currentPosition?.x ?? 0,
      y: axes.y ?? currentPosition?.y ?? 0,
      z: axes.z ?? currentPosition?.z ?? 0,
    }
    emittedPosition = {
      x: axes.x !== undefined ? formatValue(axes.x) : emittedPosition?.x ?? 0,
      y: axes.y !== undefined ? formatValue(axes.y) : emittedPosition?.y ?? 0,
    }
  }

  /** One jog block: `J3` for all three axes, `J2` for XY, `JZ` for Z alone. */
  const emitJog = (axes: Partial<ToolpathPoint>) => {
    if (axes.x !== undefined && axes.y !== undefined && axes.z !== undefined) {
      emit(`J3,${formatNumber(axes.x)},${formatNumber(axes.y)},${formatNumber(axes.z)}`)
    } else if (axes.x !== undefined && axes.y !== undefined) {
      emit(`J2,${formatNumber(axes.x)},${formatNumber(axes.y)}`)
    } else if (axes.z !== undefined) {
      emit(`JZ,${formatNumber(axes.z)}`)
    } else {
      return
    }
    moveCount += 1
    trackPosition(axes)
  }

  // ── Header ──
  emitComment(commentText(options.programName ?? project.meta.name))
  emitComment(`Generated by PureCutCNC on ${new Date().toISOString().split('T')[0]}`)
  emitComment(`ShopBot part file, units: ${outputUnits}`)
  // The guard names the setting this program must NOT run under.
  emit(`IF %(25)=${outputUnits === 'mm' ? 0 : 1} THEN GOTO ${SBP_UNIT_ERROR_LABEL}`)
  emit('SA')

  // ── Operations ──
  // When the tool changes and when the spindle starts, is restated and stops
  // is the same decision for every dialect. A part file has no coolant
  // command (output wiring differs per machine), so a request for coolant
  // comes back from the sequence as a warning rather than a line to write.
  const sequence = planProgramSequence(input, { coolant: false })
  operations.forEach(({ operation, tool, toolpath }, opIndex) => {
    const step = sequence[opIndex]
    const { toolNumber, cutFeed, plungeFeed } = step
    warnings.push(...step.warnings)

    emitComment('')
    emitComment(`Operation ${opIndex + 1}: ${commentText(operation.name)}`)
    for (const descriptionLine of commentLines(operation.description ?? '')) {
      emitComment(`Description: ${descriptionLine}`)
    }
    emitComment(`Tool ${toolNumber}: ${commentText(tool.name)}`)

    // Tool change. C9 is a macro: it moves the machine and may set speeds of
    // its own, so neither is assumed afterwards. The next rapid restates Z
    // before it travels and the next fed move restates `MS`.
    if (step.changeTool) {
      if (step.spindleRunningAtToolChange) {
        emit('C7')
      }
      emit(`&Tool=${toolNumber}`)
      emit('C9')
      emittedSpeeds = null
      currentPosition = null
      emittedPosition = null
    }

    // Spindle on at this operation's speed: when it is stopped, and again
    // when the speed changes between two operations that share a tool. Both
    // cases write the pair, as the G-code path restates `M3 S…`.
    if (step.startSpindle) {
      emit(`TR,${Math.round(step.rpm)}`)
      emit('C6')
    }

    // ── Speeds ──
    // ShopBot keeps a separate XY and Z move speed. The XY speed follows the
    // feed of the move being cut and the Z speed follows the plunge feed, so a
    // move is never asked to go faster on either axis than its G-code feed
    // would have allowed. A move that does not travel on an axis leaves that
    // axis's speed alone, which is what keeps a plunge between two cuts from
    // rewriting the XY speed twice.
    let wantedXY = cutFeed
    let wantedZ = plungeFeed
    const emitSpeedsFor = (target: ToolpathPoint, feed: number) => {
      const from = currentPosition
      if (from === null || from.x !== target.x || from.y !== target.y) {
        wantedXY = feed
      }
      if (from === null || from.z !== target.z) {
        wantedZ = Math.min(feed, plungeFeed)
      }
      const xy = formatNumber(wantedXY / SECONDS_PER_MINUTE)
      const z = formatNumber(wantedZ / SECONDS_PER_MINUTE)
      if (emittedSpeeds === null || emittedSpeeds.xy !== xy || emittedSpeeds.z !== z) {
        emit(`MS,${xy},${z}`)
        emittedSpeeds = { xy, z }
      }
    }

    const emitMove = (target: ToolpathPoint, feed: number) => {
      emitSpeedsFor(target, feed)
      emit(`M3,${formatNumber(target.x)},${formatNumber(target.y)},${formatNumber(target.z)}`)
      moveCount += 1
      trackPosition(target)
    }

    const emitArc = (arc: ArcMoveDescriptor, feed: number) => {
      // The centre offsets are measured from where the control software
      // actually is — the formatted end of the preceding line — not from the
      // arc's declared start.
      const start = emittedPosition ?? {
        x: formatValue(arc.startPoint.x),
        y: formatValue(arc.startPoint.y),
      }
      const emitted = resolveEmittedArc(arc, start, arcEmitOptions)
      // The fitter only makes planar arcs, so the target keeps the current Z.
      emitSpeedsFor({ x: arc.endPoint.x, y: arc.endPoint.y, z: currentPosition?.z ?? arc.endPoint.z }, feed)
      // CG, diameter (unused with a centre), end X, end Y, centre I, centre J,
      // T = cut on the line with no tool-radius offset, direction.
      emit([
        'CG',
        '',
        formatNumber(arc.endPoint.x),
        formatNumber(arc.endPoint.y),
        formatNumber(emitted.i),
        formatNumber(emitted.j),
        'T',
        arc.clockwise ? '1' : '-1',
      ].join(','))
      moveCount += 1
      trackPosition({ x: arc.endPoint.x, y: arc.endPoint.y })
    }

    // ── Motion plan (shared by every dialect) ──
    // Drilling takes this path too: there are no canned cycles to emit, so a
    // drill cycle is written as the expanded moves the toolpath already holds.
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

    for (const step of plan.steps) {
      if (step.kind === 'arc') {
        emitArc(step, effectiveFeed('cut', step.feedScale, cutFeed, plungeFeed))
      } else if (step.moveKind === 'rapid') {
        for (const axes of splitRapid(currentPosition, step.point)) {
          emitJog(axes)
        }
      } else {
        emitMove(step.point, effectiveFeed(step.moveKind, step.feedScale, cutFeed, plungeFeed))
      }
    }

    if (plan.trace) {
      motionTraces.push(plan.trace)
    }

    // Spindle off after the last operation, or before a tool change that is
    // actually going to be written.
    if (step.stopSpindleAfter) {
      emit('C7')
    }
  })

  // ── Footer ──
  emit('END')
  // Reached only through the units guard: nothing has moved when it runs.
  emitComment('')
  emit(`${SBP_UNIT_ERROR_LABEL}:`)
  const programUnits = outputUnits === 'mm' ? 'mm' : 'inches'
  const softwareUnits = outputUnits === 'mm' ? 'inches' : 'mm'
  // The body text of a message box may not contain a comma.
  emit(
    `MSGBOX(This part file is in ${programUnits} but the control software is set to ${softwareUnits}. Nothing was cut.,${MSGBOX_CRITICAL},Wrong units)`,
  )
  emit('END')

  return {
    gcode: lines.join(SBP_LINE_ENDING) + SBP_LINE_ENDING,
    warnings,
    stats: {
      lineCount: lines.length,
      operationCount: operations.length,
      moveCount,
    },
    ...(captureTrace ? { motionTraces } : null),
  }
}
