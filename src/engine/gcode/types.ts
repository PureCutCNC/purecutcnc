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

import { z } from 'zod'
import type { ToolpathWarning } from '../toolpaths/warningCodes'
import type { Project, Operation } from '../../types/project'
import type { ToolpathResult, NormalizedTool, ToolpathMove } from '../toolpaths/types'
import type { FittedMoveDescriptor } from './arcFitting'

/**
 * Per-operation machine-coordinate motion trace captured by the postprocessor
 * when `PostProcessorOptions.captureMotionTrace` is set. `machineMoves` are the
 * project→machine-transformed moves (before arc fitting); `descriptors` are the
 * arc/linear descriptors actually emitted when arc fitting ran (`tryFit`),
 * otherwise empty. Used by the exported-motion debug view (issue #356) as the
 * reference to validate the literal G-code parse against.
 */
export interface OperationMotionTrace {
  operationId: string
  machineMoves: ToolpathMove[]
  descriptors: FittedMoveDescriptor[]
  tryFit: boolean
}

const DecimalPlacesSchema = z.union([
  z.number(),
  z.object({
    mm: z.number(),
    inch: z.number(),
  }),
]).transform((value) => (
  typeof value === 'number'
    ? { mm: value, inch: value }
    : value
))

export const MachineDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  vendor: z.string().optional(),
  builtin: z.boolean().default(false),
  fileExtension: z.string(),
  coordinateSystem: z.object({
    xAxis: z.enum(['X', 'Y', 'Z', '-X', '-Y', '-Z']),
    yAxis: z.enum(['X', 'Y', 'Z', '-X', '-Y', '-Z']),
    zAxis: z.enum(['X', 'Y', 'Z', '-X', '-Y', '-Z']),
  }),
  numberFormat: z.object({
    decimalPlaces: DecimalPlacesSchema,
    trailingZeros: z.boolean(),
    leadingZero: z.boolean(),
  }),
  units: z.object({
    mmCommand: z.string().nullable(),
    inchCommand: z.string().nullable(),
  }),
  program: z.object({
    header: z.array(z.string()),
    operationHeader: z.array(z.string()).default([]),
    footer: z.array(z.string()),
    commentPrefix: z.string(),
    commentSuffix: z.string(),
    lineNumbers: z.boolean(),
    lineNumberIncrement: z.number(),
  }),
  workCoordinates: z.object({
    selectCommand: z.string().nullable(),
  }),
  motion: z.object({
    rapidCommand: z.string(),
    linearCommand: z.string(),
    cwArcCommand: z.string(),
    ccwArcCommand: z.string(),
    arcFormat: z.enum(['ij', 'r']),
    modalMotion: z.boolean(),
    arcInterpolation: z.boolean().default(false),
  }),
  feedSpeed: z.object({
    feedCommand: z.string(),
    rpmCommand: z.string(),
    spindleOnCW: z.string(),
    spindleOnCCW: z.string(),
    spindleOff: z.string(),
    inlineWithMotion: z.boolean(),
    modalFeedSpeed: z.boolean(),
  }),
  toolChange: z.object({
    commands: z.array(z.string()),
    stopSpindleFirst: z.boolean(),
    pauseAfterChange: z.boolean(),
    pauseCommand: z.string(),
  }),
  cannedCycles: z.object({
    drillCommand: z.string().nullable(),
    drillWithDwellCommand: z.string().nullable(),
    peckDrillCommand: z.string().nullable(),
    chipBreakDrillCommand: z.string().nullable().default(null),
    peckStepWord: z.string(),
    retractMode: z.enum(['G98', 'G99']).nullable(),
    cancelCommand: z.string().default('G80'),
  }).nullable(),
  coolant: z.object({
    floodOnCommand: z.string(),
    mistOnCommand: z.string(),
    coolantOffCommand: z.string(),
  }).nullable(),
  stop: z.object({
    programEndCommand: z.string(),
  }),
})

export type MachineDefinition = z.infer<typeof MachineDefinitionSchema>

export function validateMachineDefinition(data: unknown): MachineDefinition {
  return MachineDefinitionSchema.parse(data)
}

export interface PostProcessorInput {
  project: Project
  // Ordered list of operations to emit, in execution order.
  // Caller is responsible for ordering and filtering (enabled/disabled).
  operations: Array<{
    operation: Operation
    tool: NormalizedTool
    toolpath: ToolpathResult
  }>
  definition: MachineDefinition
  options: PostProcessorOptions
}

export interface PostProcessorOptions {
  emitToolChanges: boolean   // emit tool change commands between operations
  emitCoolant: boolean       // emit coolant commands if definition supports them
  programName?: string       // overrides project.meta.name in header
  /** When true, the postprocessor also returns a per-operation machine-coordinate
   *  motion trace (see OperationMotionTrace) alongside the G-code text. Debug-only
   *  (issue #356); defaults to false so the normal export path pays no cost. */
  captureMotionTrace?: boolean
}

export interface PostProcessorResult {
  gcode: string
  warnings: ToolpathWarning[]
  stats: {
    /** Physical G-code lines, including setup, comments, and footer. */
    lineCount: number
    operationCount: number
    /** Motion blocks actually emitted into the G-code after export fitting. */
    moveCount: number
  }
  /** Present only when `options.captureMotionTrace` was set. One entry per
   *  operation, in input order. */
  motionTraces?: OperationMotionTrace[]
}
