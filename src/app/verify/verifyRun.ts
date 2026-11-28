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
 * One Verify run (issue #1269): build the replay items a comparison needs,
 * compare, and report per operation.
 *
 * - **Model ↔ Internal** replays the generated toolpaths and classifies the
 *   cumulative stock against the combined model (`verifyAgainstModel`).
 * - **Model ↔ Exported** posts each operation with the project's machine,
 *   reads the program back (`verifyExportedOperation(...).motion.moves`, in
 *   stock space) and replays those moves instead.
 * - **Internal ↔ Exported** reports slice 1's parity verdict per operation,
 *   and replays the internal toolpaths into the same grid the model check
 *   uses, so its deviations have stock to sit on.
 *
 * The work is synchronous per operation; the run yields between operations
 * and before the model comparison, so the panel stays responsive and can be
 * cancelled. Nothing here reads React, the store or the DOM.
 *
 * Every operation the run covers is reported, and one the comparison could not
 * be made for reads `unverified` with its reasons — it is never left out.
 */

import { findOperationTool } from '../../toolPolicy'
import { verifyExportedOperation } from '../../engine/gcode/exportParity'
import type { ExportDeviationKind, ExportParityUnverifiedReason } from '../../engine/gcode/exportParity'
import type { ExportedMotionReason, ExportedMotionReasonCode, ExportedOperationMotion } from '../../engine/gcode/exportedMotion'
import type { MachineDefinition } from '../../engine/gcode/types'
import { canonicalToSetupPoint } from '../../engine/setupOrientation'
import { createSimulationGrid } from '../../engine/simulation/grid'
import {
  MODEL_DEVIATION_CLASSES,
  modelVerificationGridOptions,
  verifyAgainstModel,
  type ModelDeviationClass,
  type ModelVerificationReason,
} from '../../engine/simulation/modelDeviation'
import { modelSetupView } from '../../engine/simulation/modelTarget'
import { replayItemsIntoGrid } from '../../engine/simulation/replay'
import type { SimulationGrid, SimulationReplayItem } from '../../engine/simulation/types'
import { toolpathInSetupFrame } from '../../engine/setupFrameProject'
import { normalizeToolForProject } from '../../engine/toolpaths/geometry'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { MachiningSetup, Operation, Project } from '../../types/project'
import { comparisonUsesExport, type VerifyRequest } from './verifyRequest'

// ── Result types ────────────────────────────────────────────────────────────

/** Every reason a run or an operation can be unverified. The UI words them. */
export type VerifyReasonCode =
  | ModelVerificationReason
  | ExportParityUnverifiedReason
  | ExportedMotionReasonCode
  /** The operation's toolpath could not be produced. */
  | 'noToolpath'
  /** An exported comparison, and the project has no machine selected. */
  | 'noMachine'
  /** Nothing in the setup up to the selection can be verified. */
  | 'noOperations'

export interface VerifyReason {
  code: VerifyReasonCode
  line?: number
  command?: string
  axis?: string
}

export type VerifyFindingKind = Exclude<ModelDeviationClass, 'ok'> | ExportDeviationKind

/** One listed deviation: a model region or a parity deviation. Setup-local coordinates. */
export interface VerifyFinding {
  id: string
  kind: VerifyFindingKind
  operationId: string | null
  /** Max deviation of a region, distance of a geometric deviation, feed difference of a feed one. */
  size: number
  /** Plan area of a region; null for a parity deviation. */
  area: number | null
  /** Where it is worst. */
  at: { x: number; y: number; z: number }
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  expectedFeed?: number
  actualFeed?: number
  inverseTime?: boolean
}

export type VerifyVerdict = 'verified' | 'deviation' | 'unverified'

export interface VerifyOperationReport {
  operationId: string
  name: string
  verdict: VerifyVerdict
  reasons: VerifyReason[]
  findings: VerifyFinding[]
  /** Parity deviations found in all; more than `findings` when the list was capped. */
  deviationCount: number
}

/** Cell codes of the overlay: the model classes, then an unverified operation's cells. */
export const VERIFY_CELL_UNVERIFIED = MODEL_DEVIATION_CLASSES.length

export interface VerifyDisplay {
  /** The cumulative stock, in the setup-local frame. */
  grid: SimulationGrid
  /** One code per cell: `MODEL_DEVIATION_CLASSES` index, or `VERIFY_CELL_UNVERIFIED`. */
  cellCodes: Uint8Array
}

export interface VerifyRunResult {
  request: VerifyRequest
  /** `unverified`: the comparison could not be made at all (`reason`). */
  status: 'verified' | 'unverified'
  reason: VerifyReason | null
  operations: VerifyOperationReport[]
  /** Model regions no operation cut (material no cut reached). */
  unattributed: VerifyFinding[]
  /** Null for an Around setup or when nothing was compared. */
  display: VerifyDisplay | null
}

export interface VerifyRunInput {
  request: VerifyRequest
  setup: MachiningSetup
  /** The operations covered, in cut order (`verifyOperations`). */
  operations: readonly Operation[]
  /** Their generated toolpaths in stock space; a missing one is unverified. */
  toolpaths: ReadonlyMap<string, ToolpathResult>
  /** The project's machine (`getActiveMachineDefinition`), for the exported comparisons. */
  definition: MachineDefinition | null
}

export interface VerifyRunOptions {
  signal?: AbortSignal
  /** Yield to the host between operations; a macrotask by default. */
  yieldNow?: () => Promise<void>
  onProgress?: (done: number, total: number) => void
}

// ── Replay items ────────────────────────────────────────────────────────────

/** The internal toolpath as a replay item, or null when the operation has no tool. */
export function internalReplayItem(project: Project, operation: Operation, toolpath: ToolpathResult): SimulationReplayItem | null {
  const tool = findOperationTool(project, operation)
  if (!tool) return null
  const normalized = normalizeToolForProject(tool, project)
  return {
    operationId: operation.id,
    operationName: operation.name,
    toolRef: tool.id,
    toolType: tool.type,
    toolRadius: normalized.radius,
    vBitAngle: normalized.vBitAngle,
    toolpath,
  }
}

/** The same item cutting the exported program's moves (stock space) instead. */
export function exportedReplayItem(internal: SimulationReplayItem, motion: Pick<ExportedOperationMotion, 'moves'>): SimulationReplayItem {
  return {
    ...internal,
    toolpath: { operationId: internal.operationId, moves: motion.moves, warnings: [], bounds: null },
  }
}

/** The reasons of a read-back worth listing: what made it unsupported or failed. */
export function motionReasons(reasons: readonly ExportedMotionReason[]): VerifyReason[] {
  return reasons
    .filter((reason) => reason.severity !== 'info')
    .map((reason) => ({
      code: reason.code,
      ...(reason.line !== undefined ? { line: reason.line } : {}),
      ...(reason.command !== undefined ? { command: reason.command } : {}),
      ...(reason.axis !== undefined ? { axis: reason.axis } : {}),
    }))
}

// ── The run ─────────────────────────────────────────────────────────────────

function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

function pointBounds(x: number, y: number): VerifyFinding['bounds'] {
  return { minX: x, minY: y, maxX: x, maxY: y }
}

interface Stage {
  reports: Map<string, VerifyOperationReport>
  /** Items in cut order, with the operation each replays. */
  items: SimulationReplayItem[]
  unverifiedOperations: Set<string>
}

function report(operation: Operation): VerifyOperationReport {
  return { operationId: operation.id, name: operation.name, verdict: 'verified', reasons: [], findings: [], deviationCount: 0 }
}

function markUnverified(entry: VerifyOperationReport, reasons: VerifyReason[]): void {
  entry.verdict = 'unverified'
  for (const reason of reasons) {
    if (!entry.reasons.some((known) => known.code === reason.code && known.line === reason.line)) entry.reasons.push(reason)
  }
}

function unverifiedRun(input: VerifyRunInput, reason: VerifyReason, reports?: Map<string, VerifyOperationReport>): VerifyRunResult {
  const operations = input.operations.map((operation) => {
    const entry = reports?.get(operation.id) ?? report(operation)
    markUnverified(entry, [reason])
    return entry
  })
  return { request: input.request, status: 'unverified', reason, operations, unattributed: [], display: null }
}

/** The setup frame a flat setup's local grid uses, or null for Around / an unmachinable orientation. */
function flatView(project: Project, setup: MachiningSetup): ReturnType<typeof modelSetupView> | null {
  try {
    return modelSetupView(project, setup)
  } catch {
    return null
  }
}

/**
 * Run one verification. Resolves null when cancelled through `signal`.
 */
export async function runVerification(input: VerifyRunInput, options: VerifyRunOptions = {}): Promise<VerifyRunResult | null> {
  const { request, setup, definition } = input
  const { project, comparison } = request
  const yieldNow = options.yieldNow ?? yieldMacrotask
  const cancelled = () => options.signal?.aborted === true

  if (input.operations.length === 0) return unverifiedRun(input, { code: 'noOperations' })
  if (comparisonUsesExport(comparison) && !definition) return unverifiedRun(input, { code: 'noMachine' })

  const stage: Stage = { reports: new Map(), items: [], unverifiedOperations: new Set() }
  const total = input.operations.length + 1
  options.onProgress?.(0, total)
  const view = setup.kind === 'around' ? null : flatView(project, setup)

  for (const [index, operation] of input.operations.entries()) {
    await yieldNow()
    if (cancelled()) return null
    const entry = report(operation)
    stage.reports.set(operation.id, entry)
    const toolpath = input.toolpaths.get(operation.id)
    const internal = toolpath ? internalReplayItem(project, operation, toolpath) : null
    if (!toolpath || !internal) {
      markUnverified(entry, [{ code: toolpath ? 'noTool' : 'noToolpath' }])
      stage.unverifiedOperations.add(operation.id)
      options.onProgress?.(index + 1, total)
      continue
    }
    if (comparison === 'modelInternal') {
      stage.items.push(internal)
    } else {
      let checked: ReturnType<typeof verifyExportedOperation> | null = null
      try {
        checked = verifyExportedOperation({ project, operation, toolpath, definition: definition! })
      } catch {
        checked = null
      }
      if (!checked) {
        markUnverified(entry, [{ code: 'postFailed' }])
        stage.unverifiedOperations.add(operation.id)
      } else if (comparison === 'modelExported') {
        stage.items.push(exportedReplayItem(internal, checked.motion))
        if (checked.motion.status !== 'verified') {
          markUnverified(entry, motionReasons(checked.motion.reasons))
          stage.unverifiedOperations.add(operation.id)
        }
      } else {
        stage.items.push(internal)
        const { parity, motion } = checked
        entry.verdict = parity.verdict
        entry.deviationCount = parity.deviationCount
        if (parity.verdict === 'unverified') {
          markUnverified(entry, [...(parity.reason ? [{ code: parity.reason }] : []), ...motionReasons(motion.reasons)])
          stage.unverifiedOperations.add(operation.id)
        }
        entry.findings = parity.deviations.map((deviation, n) => {
          const local = view?.frame ? canonicalToSetupPoint(deviation.location, view.frame) : deviation.location
          return {
            id: `${operation.id}:${n}`,
            kind: deviation.kind,
            operationId: operation.id,
            size: deviation.distance,
            area: null,
            at: { x: local.x, y: local.y, z: local.z },
            bounds: pointBounds(local.x, local.y),
            ...(deviation.expectedFeed !== undefined ? { expectedFeed: deviation.expectedFeed } : {}),
            ...(deviation.actualFeed !== undefined ? { actualFeed: deviation.actualFeed } : {}),
            ...(deviation.inverseTime !== undefined ? { inverseTime: deviation.inverseTime } : {}),
          }
        })
      }
    }
    options.onProgress?.(index + 1, total)
  }

  await yieldNow()
  if (cancelled()) return null
  const result = comparison === 'internalExported'
    ? await internalStock(input, stage, view, yieldNow, cancelled)
    : await modelComparison(input, stage)
  if (result) options.onProgress?.(total, total)
  return result
}

async function modelComparison(input: VerifyRunInput, stage: Stage): Promise<VerifyRunResult> {
  const { request, setup } = input
  if (stage.items.length === 0) return unverifiedRun(input, { code: 'noOperations' }, stage.reports)
  const model = await verifyAgainstModel({
    project: request.project,
    items: stage.items,
    setup,
    detailCells: request.detailCells,
  })
  if (model.status === 'unverified') return unverifiedRun(input, { code: model.reason }, stage.reports)

  const unattributed: VerifyFinding[] = []
  model.regions.forEach((region, index) => {
    const finding: VerifyFinding = {
      id: `region:${index}`,
      kind: region.class,
      operationId: region.operationId,
      size: region.maxDeviation,
      area: region.area,
      at: { x: region.maxDeviationAt.x, y: region.maxDeviationAt.y, z: region.maxDeviationAt.simulatedZ },
      bounds: region.bounds,
    }
    const entry = region.operationId === null ? undefined : stage.reports.get(region.operationId)
    if (!entry) {
      unattributed.push(finding)
      return
    }
    entry.findings.push(finding)
    if (entry.verdict !== 'unverified' && region.class !== 'intendedLeftover') entry.verdict = 'deviation'
  })

  const cellCodes = new Uint8Array(model.cellClasses)
  if (stage.unverifiedOperations.size > 0) {
    for (let cell = 0; cell < cellCodes.length; cell += 1) {
      const item = model.cellOperation[cell]
      if (item >= 0 && stage.unverifiedOperations.has(model.operationIds[item])) cellCodes[cell] = VERIFY_CELL_UNVERIFIED
    }
  }
  return {
    request,
    status: 'verified',
    reason: null,
    operations: input.operations.map((operation) => stage.reports.get(operation.id)!),
    unattributed,
    display: { grid: model.grid, cellCodes },
  }
}

/** Internal ↔ Exported: the internal stock the deviations sit on, with unverified operations' cells marked. */
async function internalStock(
  input: VerifyRunInput,
  stage: Stage,
  view: ReturnType<typeof modelSetupView> | null,
  yieldNow: () => Promise<void>,
  cancelled: () => boolean,
): Promise<VerifyRunResult | null> {
  const operations = input.operations.map((operation) => stage.reports.get(operation.id)!)
  const base: VerifyRunResult = { request: input.request, status: 'verified', reason: null, operations, unattributed: [], display: null }
  if (!view || stage.items.length === 0) return base
  const grid = createSimulationGrid(view.localProject, modelVerificationGridOptions(view.localProject, input.request.detailCells))
  const cellCodes = new Uint8Array(grid.cols * grid.rows)
  const before = new Float32Array(grid.topZ.length)
  for (const item of stage.items) {
    await yieldNow()
    if (cancelled()) return null
    before.set(grid.topZ)
    replayItemsIntoGrid(grid, [{ ...item, toolpath: toolpathInSetupFrame(item.toolpath, view.frame) }])
    const code = stage.unverifiedOperations.has(item.operationId) ? VERIFY_CELL_UNVERIFIED : 0
    for (let cell = 0; cell < cellCodes.length; cell += 1) {
      if (grid.topZ[cell] < before[cell]) cellCodes[cell] = code
    }
  }
  return { ...base, display: { grid, cellCodes } }
}
