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

/**
 * The program language a machine definition exports (issue #953).
 *
 * - `gcode` — RS-274 word syntax, driven by the definition's command words
 *   and templates. This is every definition that predates the field.
 * - `opensbp` — ShopBot part files (`.sbp`), written by `opensbpEmitter.ts`.
 *   The definition's G-code command words and templates are not read; only
 *   the dialect-neutral fields are (`coordinateSystem`, `numberFormat`,
 *   `fileExtension`, `motion.arcInterpolation`).
 */
export const OUTPUT_DIALECTS = ['gcode', 'opensbp'] as const
export type OutputDialect = (typeof OUTPUT_DIALECTS)[number]

/** Machine kind is optional: legacy snapshots retain their original keys. */
export const MACHINE_KINDS = ['router', 'plasma'] as const
export type MachineKind = (typeof MACHINE_KINDS)[number]

const PlasmaDefinitionSchema = z.object({
  torchOnCommand: z.string().trim().min(1),
  torchOffCommand: z.string().trim().min(1),
  materialSelectCommand: z.string().trim().min(1),
  thcOnCommand: z.string().trim().min(1).optional(),
  thcOffCommand: z.string().trim().min(1).optional(),
  // Reserve the mode name, but refuse unsupported controller-independent
  // piercing rather than silently treating it as controller-owned in 0.6.0.
  pierceMode: z.enum(['controller', 'gcode']).superRefine((mode, context) => {
    if (mode === 'gcode') context.addIssue({ code: 'custom', message: 'G-code-owned piercing is not supported in 0.6.0.' })
  }),
})

export const MachineDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  vendor: z.string().optional(),
  builtin: z.boolean().default(false),
  fileExtension: z.string(),
  // Optional rather than defaulted: an absent key means G-code, so parsing an
  // existing definition adds nothing to it and a saved project's embedded
  // snapshot stays byte-for-byte what it was. Read it through
  // `resolveOutputDialect`, never directly.
  outputDialect: z.enum(OUTPUT_DIALECTS).optional(),
  machineKind: z.enum(MACHINE_KINDS).optional(),
  plasma: PlasmaDefinitionSchema.optional(),
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
}).superRefine((definition, context) => {
  if (definition.machineKind === 'plasma' && !definition.plasma) {
    context.addIssue({ code: 'custom', path: ['plasma'], message: 'A plasma machine requires a plasma block.' })
  }
})

export type MachineDefinition = z.infer<typeof MachineDefinitionSchema>

export function validateMachineDefinition(data: unknown): MachineDefinition {
  return MachineDefinitionSchema.parse(data)
}

/** An absent kind means router without adding a field to old snapshots. */
export function resolveMachineKind(definition: Pick<MachineDefinition, 'machineKind'>): MachineKind {
  return definition.machineKind ?? 'router'
}

/** The dialect a definition exports; a definition without the field is G-code. */
export function resolveOutputDialect(definition: Pick<MachineDefinition, 'outputDialect'>): OutputDialect {
  return definition.outputDialect ?? 'gcode'
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
   *  motion trace (see OperationMotionTrace) alongside the program text. Debug-only
   *  (issue #356); defaults to false so the normal export path pays no cost. */
  captureMotionTrace?: boolean
}

export interface PostProcessorResult {
  /** The program text in the definition's output dialect. The name predates
   *  dialects (issue #953): for a ShopBot definition this holds SBP, not G-code. */
  gcode: string
  warnings: ToolpathWarning[]
  stats: {
    /** Physical program lines, including setup, comments, and footer. */
    lineCount: number
    operationCount: number
    /** Motion blocks actually emitted into the program after export fitting. */
    moveCount: number
  }
  /** Present only when `options.captureMotionTrace` was set. One entry per
   *  operation, in input order. */
  motionTraces?: OperationMotionTrace[]
}
