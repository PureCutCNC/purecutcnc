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
  PostProcessorInput,
  PostProcessorResult,
} from './types'
import { projectToMachinePoint, formatGCodeNumber } from './utils'
import type { ToolpathPoint } from '../toolpaths/types'

interface ModalState {
  motionCommand: string | null   // last G0/G1/G2/G3
  feedRate: number | null
  spindleSpeed: number | null
  spindleOn: boolean
  coolantOn: boolean
  currentToolId: string | null
  currentPosition: ToolpathPoint | null
  lineNumber: number
}

export function runPostProcessor(input: PostProcessorInput): PostProcessorResult {
  const { project, operations, definition, options } = input
  const lines: string[] = []
  const warnings: string[] = []
  const outputUnits = project.meta.units
  
  const state: ModalState = {
    motionCommand: null,
    feedRate: null,
    spindleSpeed: null,
    spindleOn: false,
    coolantOn: false,
    currentToolId: null,
    currentPosition: null,
    lineNumber: definition.program.lineNumbers ? definition.program.lineNumberIncrement : 0
  }

  let moveCount = 0

  const emitLine = (content: string) => {
    if (definition.program.lineNumbers) {
      lines.push(`N${state.lineNumber} ${content}`)
      state.lineNumber += definition.program.lineNumberIncrement
    } else {
      lines.push(content)
    }
  }

  const substituteTemplates = (text: string, context: Record<string, string | number>): string => {
    return text.replace(/{(\w+)}/g, (_, key) => context[key] !== undefined ? context[key].toString() : `{${key}}`)
  }

  const emitMotionLine = (
    motionCmd: string,
    axes: Partial<ToolpathPoint>,
    feed?: number,
  ) => {
    const lineSegments: string[] = []

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
    }

    state.currentPosition = {
      x: axes.x ?? state.currentPosition?.x ?? 0,
      y: axes.y ?? state.currentPosition?.y ?? 0,
      z: axes.z ?? state.currentPosition?.z ?? 0,
    }
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
    emitLine(substituteTemplates(line, commonContext))
  })

  // 2. Units (if not already in header)
  const headerContainsUnits = definition.program.header.some(l => l.includes('{unitsCommand}'))
  if (unitsCommand && !headerContainsUnits) {
    emitLine(unitsCommand)
  }

  // 3. WCS (if not already in header)
  const headerContainsWCS = definition.program.header.some(l => l.includes('{wcsCommand}'))
  if (wcsCommand && !headerContainsWCS) {
    emitLine(wcsCommand)
  } else if (headerContainsWCS && !definition.workCoordinates.selectCommand) {
    warnings.push('Machine definition requests {wcsCommand} in header but selectCommand is null.')
  }

  // 4. Operations
  operations.forEach(({ operation, tool, toolpath }, opIndex) => {
    // Operation comment
    emitLine(`${definition.program.commentPrefix} Operation: ${operation.name}${definition.program.commentSuffix}`)

    // Tool change
    const toolChanged = state.currentToolId !== tool.id
    if (toolChanged && options.emitToolChanges) {
      if (definition.toolChange.stopSpindleFirst && state.spindleOn) {
        emitLine(definition.feedSpeed.spindleOff)
        state.spindleOn = false
      }

      // Find tool number in original project tools list
      const toolNumber = project.tools.findIndex(t => t.id === tool.id) + 1
      const toolContext = {
        ...commonContext,
        toolNumber: toolNumber > 0 ? toolNumber : 1,
        toolName: tool.name
      }

      definition.toolChange.commands.forEach(cmd => {
        emitLine(substituteTemplates(cmd, toolContext))
      })

      if (definition.toolChange.pauseAfterChange) {
        emitLine(definition.toolChange.pauseCommand)
      }

      state.currentToolId = tool.id
    } else if (toolChanged && !options.emitToolChanges && opIndex > 0) {
      warnings.push(`Operation "${operation.name}" uses a different tool ("${tool.name}") than previous, but tool changes are disabled.`)
    }

    // Spindle On
    const rpm = operation.rpm || tool.defaultRpm
    if (!state.spindleOn || state.spindleSpeed !== rpm) {
      emitLine(`${definition.feedSpeed.spindleOnCW} ${definition.feedSpeed.rpmCommand}${formatGCodeNumber(rpm, definition, outputUnits)}`)
      state.spindleOn = true
      state.spindleSpeed = rpm
    }

    // Coolant
    if (options.emitCoolant) {
      if (definition.coolant) {
        if (!state.coolantOn) {
          emitLine(definition.coolant.floodOnCommand)
          state.coolantOn = true
        }
      } else {
        warnings.push('Coolant emission requested but machine definition has no coolant commands.')
      }
    }

    // Moves
    toolpath.moves.forEach(move => {
      moveCount++
      const mPoint = projectToMachinePoint(move.to, project.origin, definition)

      const feed = (move.kind === 'plunge')
        ? (operation.plungeFeed || tool.defaultPlungeFeed)
        : (operation.feed || tool.defaultFeed)

      if (move.kind === 'rapid') {
        const current = state.currentPosition
        const hasXYChange =
          current === null
          || current.x !== mPoint.x
          || current.y !== mPoint.y
        const hasZChange =
          current === null
          || current.z !== mPoint.z

        if (hasZChange) {
          emitMotionLine(definition.motion.rapidCommand, { z: mPoint.z })
        }
        if (hasXYChange) {
          emitMotionLine(definition.motion.rapidCommand, { x: mPoint.x, y: mPoint.y })
        }
        return
      }

      emitMotionLine(definition.motion.linearCommand, mPoint, feed)
    })

    // Spindle off after last move of operation if tool change follows or it's the last op
    const nextOp = operations[opIndex + 1]
    const toolWillChange = nextOp && nextOp.tool.id !== tool.id
    
    // Only turn off if it's the absolute end OR we are about to do a tool change that we are actually emitting
    if (!nextOp || (toolWillChange && options.emitToolChanges)) {
       emitLine(definition.feedSpeed.spindleOff)
       state.spindleOn = false
    }
  })

  // 5. Footer
  definition.program.footer.forEach(line => {
    emitLine(substituteTemplates(line, commonContext))
  })

  // 6. Program end
  emitLine(definition.stop.programEndCommand)

  return {
    gcode: lines.join('\n'),
    warnings,
    stats: {
      lineCount: lines.length,
      operationCount: operations.length,
      moveCount
    }
  }
}
