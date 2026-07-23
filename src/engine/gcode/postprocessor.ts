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
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import { projectToMachinePoint, formatGCodeNumber } from './utils'
import type { ToolpathPoint, ToolpathMove } from '../toolpaths/types'
import type { OperationTarget } from '../../types/project'
import { fitArcsInMachineMoves } from './arcFitting'
import type { ArcMoveDescriptor } from './arcFitting'

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

export function runPostProcessor(input: PostProcessorInput): PostProcessorResult {
  const { project, operations, definition, options } = input
  const lines: string[] = []
  const warnings: ToolpathWarning[] = []
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
          emitLine(line)
        }
      }
    }
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
    warnings.push({ code: 'postWcsNullSelect' })
  }

  // 4. Operations
  operations.forEach(({ operation, tool, toolpath }, opIndex) => {
    const toolNumber = project.tools.findIndex(t => t.id === tool.id) + 1
    const rpm = operation.rpm || tool.defaultRpm
    const operationContext = {
      ...commonContext,
      operationIndex: opIndex + 1,
      operationName: safeCommentText(operation.name),
      operationDescription: safeCommentText(operation.description ?? ''),
      operationKind: operation.kind,
      operationPass: operation.pass,
      operationTarget: operationTargetSummary(operation.target),
      toolNumber: toolNumber > 0 ? toolNumber : 1,
      toolName: safeCommentText(tool.name),
      feed: formatGCodeNumber(operation.feed || tool.defaultFeed, definition, outputUnits),
      plungeFeed: formatGCodeNumber(operation.plungeFeed || tool.defaultPlungeFeed, definition, outputUnits),
      rpm: formatGCodeNumber(rpm, definition, outputUnits),
    }
    const descriptionLines = safeCommentLines(operation.description ?? '')

    if (definition.program.operationHeader.length > 0) {
      emitTemplateLines(definition.program.operationHeader, operationContext, descriptionLines)
    } else {
      emitLine(`${definition.program.commentPrefix} Operation: ${operationContext.operationName}${definition.program.commentSuffix}`)
    }

    // Tool change
    const toolChanged = state.currentToolId !== tool.id
    if (toolChanged && options.emitToolChanges) {
      if (definition.toolChange.stopSpindleFirst && state.spindleOn) {
        emitLine(definition.feedSpeed.spindleOff)
        state.spindleOn = false
      }

      const toolContext = {
        ...operationContext,
      }

      definition.toolChange.commands.forEach(cmd => {
        emitLine(substituteTemplates(cmd, toolContext))
      })

      if (definition.toolChange.pauseAfterChange) {
        emitLine(definition.toolChange.pauseCommand)
      }

      state.currentToolId = tool.id
    } else if (toolChanged && !options.emitToolChanges && opIndex > 0) {
      warnings.push({ code: 'postToolChangesDisabled', params: { operation: operation.name, tool: tool.name } })
    }

    // Spindle On
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
        warnings.push({ code: 'postNoCoolantCommands' })
      }
    }

    // Moves — emit canned cycles for drilling when supported, else expanded G0/G1
    let emittedCanned = false

    if (
      operation.kind === 'drilling'
      && toolpath.drillCycles
      && toolpath.drillCycles.length > 0
      && definition.cannedCycles
    ) {
      const cycles = toolpath.drillCycles
      const cannedDef = definition.cannedCycles

      // Resolve the command word for the operation's drill type
      const drillTypeCommandMap: Record<string, string | null> = {
        simple: cannedDef.drillCommand,
        dwell: cannedDef.drillWithDwellCommand,
        peck: cannedDef.peckDrillCommand,
        chip_breaking: cannedDef.chipBreakDrillCommand,
      }
      const cycleDrillType = cycles[0].drillType
      const cannedCmd = drillTypeCommandMap[cycleDrillType]

      if (cannedCmd) {
        emittedCanned = true

        const plungeFeed = operation.plungeFeed || tool.defaultPlungeFeed
        const feedWord = definition.feedSpeed.feedCommand
        let feedEmitted = false

        // Rapid to first hole XY at clearZ so the controller has a defined initial plane
        const firstCycle = cycles[0]
        const firstMachineXY = projectToMachinePoint({ x: firstCycle.x, y: firstCycle.y, z: firstCycle.clearZ }, project.origin, definition)
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

        for (const cycle of cycles) {
          moveCount++

          const segs: string[] = []

          // Command word (modal — only when first or when motion state was reset)
          if (state.motionCommand !== cannedCmd) {
            segs.push(cannedCmd)
            state.motionCommand = cannedCmd
          }

          // X / Y
          const machineXY = projectToMachinePoint({ x: cycle.x, y: cycle.y, z: 0 }, project.origin, definition)
          segs.push(`X${formatGCodeNumber(machineXY.x, definition, outputUnits)}`)
          segs.push(`Y${formatGCodeNumber(machineXY.y, definition, outputUnits)}`)

          // Z (bottom)
          const machineBottomZ = projectToMachinePoint({ x: cycle.x, y: cycle.y, z: cycle.bottomZ }, project.origin, definition).z
          const zStr = formatGCodeNumber(machineBottomZ, definition, outputUnits)
          if (zStr !== lastZ) {
            segs.push(`Z${zStr}`)
            lastZ = zStr
          }

          // R (retract plane)
          const machineRetractZ = projectToMachinePoint({ x: cycle.x, y: cycle.y, z: cycle.retractZ }, project.origin, definition).z
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
        const lastCycle = cycles[cycles.length - 1]
        const lastMachinePos = projectToMachinePoint({ x: lastCycle.x, y: lastCycle.y, z: lastCycle.clearZ }, project.origin, definition)
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
      // Resolve effective feed for a descriptor (linear or arc).
      const effectiveFeed = (
        moveKind: ToolpathMove['kind'],
        feedScale?: number,
      ): number =>
        moveKind === 'plunge'
          ? (operation.plungeFeed || tool.defaultPlungeFeed)
          : (operation.feed || tool.defaultFeed) * (feedScale ?? 1)

      // Emit a single rapid (G0) with per-axis splitting.
      const emitRapid = (pt: ToolpathPoint) => {
        const current = state.currentPosition
        const hasXYChange =
          current === null
          || current.x !== pt.x
          || current.y !== pt.y
        const hasZChange =
          current === null
          || current.z !== pt.z
        if (hasZChange) {
          emitMotionLine(definition.motion.rapidCommand, { z: pt.z })
        }
        if (hasXYChange) {
          emitMotionLine(definition.motion.rapidCommand, { x: pt.x, y: pt.y })
        }
      }

      // Emit a single arc (G2/G3) with I/J or R, respecting modal state.
      const emitArcLine = (arc: ArcMoveDescriptor, feed: number) => {
        const lineSegments: string[] = []
        const motionCmd = arc.clockwise
          ? definition.motion.cwArcCommand
          : definition.motion.ccwArcCommand

        if (!definition.motion.modalMotion || state.motionCommand !== motionCmd) {
          lineSegments.push(motionCmd)
          state.motionCommand = motionCmd
        }

        lineSegments.push(`X${formatGCodeNumber(arc.endPoint.x, definition, outputUnits)}`)
        lineSegments.push(`Y${formatGCodeNumber(arc.endPoint.y, definition, outputUnits)}`)

        if (definition.motion.arcFormat === 'ij') {
          lineSegments.push(`I${formatGCodeNumber(arc.centerOffsets.i, definition, outputUnits)}`)
          lineSegments.push(`J${formatGCodeNumber(arc.centerOffsets.j, definition, outputUnits)}`)
        } else {
          const radius = Math.sqrt(
            arc.centerOffsets.i * arc.centerOffsets.i +
            arc.centerOffsets.j * arc.centerOffsets.j,
          )
          lineSegments.push(`R${formatGCodeNumber(radius, definition, outputUnits)}`)
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
          x: arc.endPoint.x,
          y: arc.endPoint.y,
          z: state.currentPosition?.z ?? 0,
        }
      }

      // ── Arc fitting (export-stage) ──

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

      if (tryFit) {
        // Fit arcs and emit the mixed sequence.
        const machineMoves = transformMoves()
        const tolerance =
          project.meta.units === 'mm' ? 0.01 : 0.01 / 25.4
        const descriptors = fitArcsInMachineMoves(machineMoves, tolerance, 90)

        for (const d of descriptors) {
          moveCount++
          if (d.kind === 'linear') {
            const feed = effectiveFeed(d.moveKind, d.feedScale)
            if (d.moveKind === 'rapid') {
              emitRapid(d.point)
              continue
            }
            emitMotionLine(definition.motion.linearCommand, d.point, feed)
          } else {
            const feed = effectiveFeed('cut', d.feedScale)
            emitArcLine(d, feed)
          }
        }
      } else {
        // Original linear emission (with arc-capability warning when
        // fitting is enabled but the machine does not support it).
        if (arcEnabled && !machineHasArcs) {
          // Check whether arcs *would* have been found.
          const machineMoves = transformMoves()
          const tolerance =
            project.meta.units === 'mm' ? 0.01 : 0.01 / 25.4
          const descriptors = fitArcsInMachineMoves(machineMoves, tolerance, 90)
          const foundArcs = descriptors.some((d) => d.kind === 'arc')
          if (foundArcs) {
            warnings.push({
              code: 'postArcNoCapability',
              params: { operation: operation.name },
            })
          }
        }

        toolpath.moves.forEach((move) => {
          moveCount++
          const mPoint = projectToMachinePoint(move.to, project.origin, definition)
          const feed = effectiveFeed(move.kind, move.feedScale)

          if (move.kind === 'rapid') {
            emitRapid(mPoint)
            return
          }

          emitMotionLine(definition.motion.linearCommand, mPoint, feed)
        })
      }
    }

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
