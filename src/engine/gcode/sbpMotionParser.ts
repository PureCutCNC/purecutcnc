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
 * Read-only motion parser for the ShopBot part files `opensbpEmitter.ts`
 * writes (issue #953). It is the `opensbp` counterpart of
 * `gcodeMotionParser.ts`: it reconstructs the motion literally written to the
 * `.sbp` so the exported-motion debug view can check it against the
 * postprocessor's own trace, and it is the round-trip oracle in the emitter's
 * tests.
 *
 * It understands exactly what the emitter produces — jogs (`J2`/`J3`/`JX`/
 * `JY`/`JZ`), moves (`M2`/`M3`/`MX`/`MY`/`MZ`), `CG` arcs given by a centre
 * offset with no plunge, repeat, proportion or option parameters, and the
 * non-motion lines around them. It is not a ShopBot interpreter: anything
 * else (relative mode, variables as coordinates, other cut commands, macros
 * that move the machine, control flow beyond the units guard) is reported as
 * `unsupported`, never guessed at, so a partial parse is never `verified`.
 *
 * Syntax sources are the ones cited in `opensbpEmitter.ts`.
 *
 * Output is in machine coordinates and has the same shape as the G-code
 * parser's, so `motionDebug.ts` treats both dialects alike.
 */

import type { ToolpathPoint } from '../toolpaths/types'
import { arcMoveFromCenter } from './gcodeMotionParser'
import type { GcodeParseStatus, ParsedGcodeMotion, ParsedGcodeMove } from './gcodeMotionParser'

type Axis = 'x' | 'y' | 'z'

/** The axes each jog/move command takes, in parameter order. */
const AXES_BY_SUFFIX: Record<string, readonly Axis[]> = {
  '2': ['x', 'y'],
  '3': ['x', 'y', 'z'],
  X: ['x'],
  Y: ['y'],
  Z: ['z'],
}

/** Lines that are part of an emitted program and do not move the tool. */
const NON_MOTION_COMMANDS = new Set([
  'MS',   // move speeds
  'JS',   // jog speeds
  'SA',   // absolute mode
  'TR',   // spindle RPM
  'C6',   // spindle on
  'C7',   // spindle off
  'C9',   // tool change
])

/** The units guard: `IF %(25)=0 THEN GOTO UNIT_ERROR`. */
const UNITS_GUARD = /^IF\s+%\(\s*25\s*\)\s*=\s*[01]\s+THEN\s+GOTO\s+[A-Z_][A-Z0-9_]*$/i
const LABEL = /^[A-Z_][A-Z0-9_]*:$/i
const VARIABLE_ASSIGNMENT = /^&[A-Z_][A-Z0-9_]*\s*=/i

/** A coordinate parameter: a number, or blank for "leave this axis alone". */
function parseParameter(raw: string | undefined): number | undefined | 'invalid' {
  const text = (raw ?? '').trim()
  if (text.length === 0) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : 'invalid'
}

/**
 * Parse a literal ShopBot part file into a motion sequence.
 *
 * Parsing stops at the program's `END`: the units-error block the emitter
 * writes after it is never reached by a program that runs.
 */
export function parseSbpMotion(program: string): ParsedGcodeMotion {
  const moves: ParsedGcodeMove[] = []
  const warnings: string[] = []
  let status: GcodeParseStatus = 'verified'
  let pos: ToolpathPoint = { x: 0, y: 0, z: 0 }

  const unsupported = (lineNumber: number, message: string) => {
    if (status === 'verified') status = 'unsupported'
    warnings.push(`line ${lineNumber}: ${message}`)
  }

  const lines = program.split(/\r?\n/)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineNumber = lineIndex + 1
    // A comment runs from an apostrophe to the end of the line.
    const commentStart = lines[lineIndex].indexOf("'")
    const line = (commentStart >= 0 ? lines[lineIndex].slice(0, commentStart) : lines[lineIndex]).trim()
    if (line.length === 0) continue

    if (/^END$/i.test(line)) break
    if (LABEL.test(line) || VARIABLE_ASSIGNMENT.test(line) || UNITS_GUARD.test(line)) continue

    const [rawCommand, ...args] = line.split(',')
    const command = rawCommand.trim().toUpperCase()

    if (NON_MOTION_COMMANDS.has(command)) continue

    // Jogs and moves: `J3,x,y,z`, `MZ,z`, …
    const family = command[0]
    const axes = command.length === 2 ? AXES_BY_SUFFIX[command[1]] : undefined
    if ((family === 'J' || family === 'M') && axes) {
      const to: ToolpathPoint = { ...pos }
      let valid = true
      axes.forEach((axis, index) => {
        const value = parseParameter(args[index])
        if (value === 'invalid') valid = false
        else if (value !== undefined) to[axis] = value
      })
      if (!valid || args.length > axes.length) {
        unsupported(lineNumber, `unsupported ${command} parameters`)
        continue
      }
      moves.push({ kind: family === 'J' ? 'rapid' : 'linear', from: pos, to })
      pos = to
      continue
    }

    // Arcs: `CG,diameter,endX,endY,I,J,T,direction` and nothing after it.
    if (command === 'CG') {
      const endX = parseParameter(args[1])
      const endY = parseParameter(args[2])
      const offsetI = parseParameter(args[3])
      const offsetJ = parseParameter(args[4])
      const path = (args[5] ?? '').trim().toUpperCase()
      const direction = parseParameter(args[6])
      // Plunge, repetitions, proportions, tab/pocket/spiral options and the
      // pull-up flags all change the motion; the emitter writes none of them.
      const extras = args.slice(7).some((arg) => arg.trim().length > 0)
      if (
        typeof endX !== 'number' || typeof endY !== 'number'
        || typeof offsetI !== 'number' || typeof offsetJ !== 'number'
        || path !== 'T'
        || (direction !== 1 && direction !== -1)
        || extras
      ) {
        unsupported(lineNumber, 'unsupported CG parameters')
        continue
      }
      const to: ToolpathPoint = { x: endX, y: endY, z: pos.z }
      moves.push(arcMoveFromCenter(
        pos,
        to,
        { x: pos.x + offsetI, y: pos.y + offsetJ },
        Math.hypot(offsetI, offsetJ),
        direction === 1,
      ))
      pos = to
      continue
    }

    unsupported(lineNumber, `unsupported ShopBot statement (${command})`)
  }

  return { moves, status, warnings }
}
