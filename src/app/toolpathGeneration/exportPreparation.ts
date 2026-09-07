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
 * Assembling a G-code export from asynchronous generation (issue #675).
 *
 * Framework-free on purpose: these are the rules that decide whether a program
 * may be written to a file, and they are worth testing without a renderer in
 * the way.
 *
 * ## The rule
 *
 * **A program is all of its operations or it is nothing.** The synchronous
 * implementation this replaces mapped over the selected operations and dropped
 * any that came back empty — which, the moment generation could fail or be
 * cancelled, would quietly write a file missing a pass. A part machined from
 * that program is wrong in a way the operator cannot see until the cut. So a
 * member that failed, was cancelled, was superseded, or has no tool blocks the
 * whole export and says which one; nothing is ever filtered out to make the
 * remainder postable.
 *
 * ## The token
 *
 * A prepared program is bound to the inputs it was built from. Generation is
 * asynchronous and the save dialog is asynchronous, so between "preview looks
 * right" and "bytes hit the disk" the project, machine, selection or options
 * can all change. The token is what makes that detectable rather than
 * plausible: it is revalidated against the live context before the dialog
 * opens, and the bytes are frozen once it does.
 */

import { runPostProcessor } from '../../engine/gcode/postprocessor'
import type { MachineDefinition, PostProcessorResult } from '../../engine/gcode/types'
import { normalizeToolForProject, type NormalizedTool } from '../../engine/toolpaths'
import type { ToolpathResult } from '../../engine/toolpaths'
import type { Operation, Project } from '../../types/project'
import type { GenerationContext, ToolpathGenerationService } from './service'

export interface ExportPostOptions {
  emitToolChanges: boolean
  emitCoolant: boolean
  programName: string
  captureMotionTrace: boolean
}

/** One operation, its normalized tool, and its generated path — the postprocessor's input row. */
export interface PreparedOperation {
  operation: Operation
  tool: NormalizedTool
  toolpath: ToolpathResult
}

/**
 * The inputs a prepared program was built from. Comparing this against the live
 * context is how a preview is proven still exportable.
 */
export interface ExportPreparationToken {
  /** Monotonic per dialog; distinguishes two preparations with identical inputs. */
  id: number
  documentKey: number
  /** Reference identity, not a copy: an edit produces a new project object. */
  project: Project
  operationIds: readonly string[]
  definitionId: string
  optionsKey: string
}

export type ExportBlockReason =
  | { kind: 'no-machine' }
  | { kind: 'no-operations' }
  | { kind: 'generation-failed'; operationId: string; message: string }
  | { kind: 'generation-cancelled'; operationId: string }
  | { kind: 'generation-superseded'; operationId: string }
  | { kind: 'missing-tool'; operationId: string }
  | { kind: 'stale' }

export type ExportPreparation =
  | { status: 'preparing'; token: ExportPreparationToken }
  | { status: 'ready'; token: ExportPreparationToken; result: PostProcessorResult; operations: PreparedOperation[] }
  | { status: 'blocked'; token: ExportPreparationToken; reason: ExportBlockReason }

/** Stable key for the postprocessor options, so an option change invalidates a token. */
export function exportOptionsKey(options: ExportPostOptions): string {
  return [
    options.emitToolChanges ? '1' : '0',
    options.emitCoolant ? '1' : '0',
    options.captureMotionTrace ? '1' : '0',
    options.programName,
  ].join('|')
}

export function createExportToken(
  id: number,
  context: GenerationContext,
  operationIds: readonly string[],
  definition: MachineDefinition,
  options: ExportPostOptions,
): ExportPreparationToken {
  return {
    id,
    documentKey: context.documentKey,
    project: context.project,
    operationIds: [...operationIds],
    definitionId: definition.id,
    optionsKey: exportOptionsKey(options),
  }
}

/**
 * Does this token still describe the live inputs?
 *
 * Project identity is compared by reference: any edit produces a new object, so
 * this is both cheap and strict. Strict is the right direction — re-preparing
 * an export that did not really change costs a moment; writing a file from
 * inputs that did costs a part.
 */
export function tokenMatchesContext(
  token: ExportPreparationToken,
  context: GenerationContext,
  operationIds: readonly string[],
  definition: MachineDefinition | null,
  options: ExportPostOptions,
): boolean {
  if (!definition) return false
  if (token.documentKey !== context.documentKey) return false
  if (token.project !== context.project) return false
  if (token.definitionId !== definition.id) return false
  if (token.optionsKey !== exportOptionsKey(options)) return false
  if (token.operationIds.length !== operationIds.length) return false
  return token.operationIds.every((id, index) => id === operationIds[index])
}

/**
 * Await every selected operation, then post the complete set.
 *
 * `signal` abandons the preparation; the service settles each consumer, and the
 * caller discards whatever comes back here.
 */
export async function prepareExport(
  service: ToolpathGenerationService,
  context: GenerationContext,
  token: ExportPreparationToken,
  definition: MachineDefinition | null,
  options: ExportPostOptions,
  signal?: AbortSignal,
): Promise<ExportPreparation> {
  if (!definition) {
    return { status: 'blocked', token, reason: { kind: 'no-machine' } }
  }
  if (token.operationIds.length === 0) {
    return { status: 'blocked', token, reason: { kind: 'no-operations' } }
  }

  // Requested together rather than in sequence: they are independent, and the
  // service's own queue decides the order work actually runs in. The assembled
  // rows below are put back into project order regardless, because the order
  // operations are posted in is the order they will be cut.
  const outcomes = await Promise.all(
    token.operationIds.map(async (operationId) => ({
      operationId,
      outcome: await service.request(context, operationId, { purpose: 'export', signal }),
    })),
  )

  const prepared: PreparedOperation[] = []
  for (const { operationId, outcome } of outcomes) {
    if (outcome.status === 'failed') {
      return {
        status: 'blocked',
        token,
        reason: { kind: 'generation-failed', operationId, message: outcome.failure.message },
      }
    }
    if (outcome.status === 'cancelled') {
      return { status: 'blocked', token, reason: { kind: 'generation-cancelled', operationId } }
    }
    if (outcome.status === 'superseded') {
      return { status: 'blocked', token, reason: { kind: 'generation-superseded', operationId } }
    }

    const operation = token.project.operations.find((candidate) => candidate.id === operationId)
    const toolRecord = operation?.toolRef
      ? token.project.tools.find((tool) => tool.id === operation.toolRef) ?? null
      : null
    if (!operation || !toolRecord) {
      return { status: 'blocked', token, reason: { kind: 'missing-tool', operationId } }
    }

    prepared.push({
      operation,
      tool: normalizeToolForProject(toolRecord, token.project),
      toolpath: outcome.result,
    })
  }

  // The postprocessor sees the captured project, not the live one: origin,
  // units, names and tools have to come from the same revision as the paths.
  const result = runPostProcessor({
    project: token.project,
    operations: prepared,
    definition,
    options: {
      emitToolChanges: options.emitToolChanges,
      emitCoolant: options.emitCoolant,
      programName: options.programName,
      captureMotionTrace: options.captureMotionTrace,
    },
  })

  return { status: 'ready', token, result, operations: prepared }
}
