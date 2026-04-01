import { z } from 'zod'
import type { Project, Operation } from '../../types/project'
import type { ToolpathResult, NormalizedTool } from '../toolpaths/types'

export const MachineDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  vendor: z.string().optional(),
  fileExtension: z.string(),
  coordinateSystem: z.object({
    xAxis: z.enum(['X', 'Y', 'Z', '-X', '-Y', '-Z']),
    yAxis: z.enum(['X', 'Y', 'Z', '-X', '-Y', '-Z']),
    zAxis: z.enum(['X', 'Y', 'Z', '-X', '-Y', '-Z']),
  }),
  numberFormat: z.object({
    decimalPlaces: z.number(),
    trailingZeros: z.boolean(),
    leadingZero: z.boolean(),
  }),
  units: z.object({
    mmCommand: z.string().nullable(),
    inchCommand: z.string().nullable(),
  }),
  program: z.object({
    header: z.array(z.string()),
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
    peckStepWord: z.string(),
    retractMode: z.enum(['G98', 'G99']).nullable(),
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
}

export interface PostProcessorResult {
  gcode: string
  warnings: string[]
  stats: {
    lineCount: number
    operationCount: number
    moveCount: number
  }
}
