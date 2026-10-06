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

const PlasmaCommandSchema = z.string().refine((value) => value.trim().length > 0, 'Command must not be blank.')
const OptionalPlasmaCommandSchema = z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  PlasmaCommandSchema.optional(),
)

/**
 * Per-cut touch-off for G-code-owned piercing (#983). Lengths are millimetres
 * and feeds millimetres per minute whatever the project units; the exporter
 * converts them. Before each pierce the program probes `probeDepth` below the
 * current Z zero, then sets Z zero at the trigger point plus `switchOffset`
 * (the travel a floating head makes before its switch trips; 0 for ohmic).
 */
const PlasmaTouchOffSchema = z.object({
  probeCommand: PlasmaCommandSchema,
  probeDepth: z.number().finite().positive(),
  probeFeed: z.number().finite().positive(),
  /** Written before ` Z<-switchOffset>`, so it carries no Z word itself. */
  setZeroCommand: PlasmaCommandSchema,
  switchOffset: z.number().finite().min(0),
})
export type PlasmaTouchOff = z.infer<typeof PlasmaTouchOffSchema>

const MATERIAL_COMMAND_KEYS = ['materialSelectCommand', 'materialWaitCommand', 'materialFeedCommand'] as const

// `controller`: the controller's material table owns pierce and height
// (QtPlasmaC), so the material sequence is required and touch-off is absent.
// `gcode`: the program owns pierce and height (Grbl), so touch-off is required
// and the material sequence, which nothing would consume, is absent.
const PlasmaDefinitionSchema = z.object({
  torchOnCommand: PlasmaCommandSchema,
  torchOffCommand: PlasmaCommandSchema,
  materialSelectCommand: OptionalPlasmaCommandSchema,
  materialWaitCommand: OptionalPlasmaCommandSchema,
  materialFeedCommand: OptionalPlasmaCommandSchema,
  thcOnCommand: OptionalPlasmaCommandSchema,
  thcOffCommand: OptionalPlasmaCommandSchema,
  pierceMode: z.enum(['controller', 'gcode']),
  touchOff: PlasmaTouchOffSchema.optional(),
}).superRefine((block, context) => {
  for (const key of MATERIAL_COMMAND_KEYS) {
    if (block.pierceMode === 'controller' && block[key] === undefined) {
      context.addIssue({ code: 'custom', path: [key], message: 'Controller piercing requires the material sequence.' })
    }
    if (block.pierceMode === 'gcode' && block[key] !== undefined) {
      context.addIssue({ code: 'custom', path: [key], message: 'G-code piercing has no material sequence.' })
    }
  }
  if (block.pierceMode === 'gcode' && !block.touchOff) {
    context.addIssue({ code: 'custom', path: ['touchOff'], message: 'G-code piercing requires touch-off settings.' })
  }
  if (block.pierceMode === 'controller' && block.touchOff) {
    context.addIssue({ code: 'custom', path: ['touchOff'], message: 'Controller piercing owns touch-off; remove the touch-off block.' })
  }
}).transform(({ thcOnCommand, thcOffCommand, touchOff, ...block }) => Object.fromEntries(
  // Blank optional commands parse as absent, so the saved block never grows an
  // empty key. THC stays after pierce mode, where #956 wrote it, so existing
  // snapshots serialize byte-for-byte as before.
  Object.entries({ ...block, thcOnCommand, thcOffCommand, touchOff }).filter(([, value]) => value !== undefined),
) as typeof block & { thcOnCommand?: string, thcOffCommand?: string, touchOff?: PlasmaTouchOff })

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
  if (definition.plasma && definition.machineKind !== 'plasma') {
    context.addIssue({ code: 'custom', path: ['machineKind'], message: 'A plasma block requires machineKind: plasma.' })
  }
  if (definition.machineKind === 'plasma' && definition.outputDialect === 'opensbp') {
    context.addIssue({ code: 'custom', path: ['machineKind'], message: 'Plasma machines require the G-code output dialect.' })
  }
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
