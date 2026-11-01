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
 * The pure simulation computation behind `useSimulationModel.ts`.
 *
 * Every stock shape takes the same heightfield path (issue #1016 C2): a square
 * blank is the round bar's radial heightfield whose cells start at the blank's
 * true cross section, so there is no separate square job and no worker. The
 * synchronous entry point is the reference; `computeSimulationResultAsync`
 * drives the same engine in yielding, cancellable slices so the app can commit
 * the simulation tab before a heavy replay (issue #1112 review P1). This module
 * stays free of React, the store and browser-only code: it holds the one
 * definition of "a simulation result for this input" and the prior-operation
 * replay the playback starting stock is built from.
 */

import { findOperationTool } from '../toolPolicy'
import { createSimulationGrid } from '../engine/simulation/grid'
import {
  simulateOperationHeightfield,
  simulateOperationHeightfieldChunked,
  simulateReplayItemsHeightfield,
  simulateReplayItemsHeightfieldChunked,
  type SimulationChunkOptions,
} from '../engine/simulation/replay'
import type {
  SimulationBuildOptions,
  SimulationGrid,
  SimulationReplayItem,
  SimulationResult,
} from '../engine/simulation/types'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import type { ToolpathResult } from '../engine/toolpaths/types'
import type { Operation, Project } from '../types/project'
import type { SimulationSetupInput } from './simulationSetup'

/** Stable empty set, so "nothing to acquire" does not churn a replay. */
const NO_PATHS: ReadonlyMap<string, ToolpathResult> = new Map()

/**
 * The one grid/build option set every simulation entry point uses (issue
 * #1016 C2-R2V): the same periodic sheet and the same transient bar
 * descriptors, so the static grid, the selected cut, the visible replay and
 * the playback base grid cannot disagree about what blank is being cut. A flat
 * round bar's profile (issue #1049) rides here with the same contract as the
 * square blank's.
 */
export function simulationBuildOptions(setupInput: SimulationSetupInput | null, detailCells: number): SimulationBuildOptions {
  const bar = setupInput?.bar
  const squareBar = setupInput?.squareBar
  const flatRoundBar = setupInput?.flatRoundBar
  return {
    targetLongAxisCells: detailCells,
    ...(bar
      ? { wrap: { axis: bar.frame.axis === 'x' ? 'y' as const : 'x' as const, period: bar.frame.circumference } }
      : {}),
    ...(squareBar ? { squareBar } : {}),
    ...(flatRoundBar ? { flatRoundBar } : {}),
  }
}

/**
 * The empty result's statistics. A square blank's virgin surface is its true
 * cross section, whose lowest top is the inscribed radius over the grid's own
 * cells; `stockTopZ` there is the corner maximum. A flat round bar's virgin
 * surface is its curved upper half (issue #1049), and its empty cells outside
 * the bar start at the stock bottom, so the uniform top is wrong for it too.
 * The optional immutable baseline is the signal for both: the lowest of a
 * grid's own starting heights is what it reports (the replay's minimum over
 * `topZ` includes the same empty cells, so the two agree). Flat and round grids
 * without one keep the exact stock-thickness value they always reported.
 */
function emptySimulationStats(grid: SimulationGrid): SimulationResult['stats'] {
  let minTopZ = grid.stockTopZ
  if (grid.initialTopZ) {
    const baseline = grid.initialTopZ
    for (let index = 0; index < baseline.length; index += 1) {
      if (baseline[index] < minTopZ) minTopZ = baseline[index]
    }
  }
  return { removedCellCount: 0, minTopZ, maxRemovedDepth: 0, processedMoveCount: 0 }
}

/**
 * One simulation result in the selected or visible mode (issue #1016 C2-R2V
 * keeps this the single place the result modes are dispatched, so every mode
 * receives the same square initialization input and periodic sheet). Exported
 * from here and re-exported by `useSimulationModel.ts` for the focused wiring
 * test: the hook calls this very function, so a mode that drops the descriptor
 * fails there and cannot pass behind a test-only copy.
 */
export interface SimulationResultInput {
  setupInput: SimulationSetupInput | null
  project: Project
  simulationMode: 'selected' | 'visible'
  simulationDetailCells: number
  selectedInSetup: Operation | null
  /** `null` while the acquired paths are still pending. */
  paths: ReadonlyMap<string, ToolpathResult> | null
}

interface SimulationContext {
  localProject: Project
  localPaths: ReadonlyMap<string, ToolpathResult>
  options: SimulationBuildOptions
  empty: SimulationResult
}

/** The setup-local inputs and the empty result every mode starts from. */
function simulationContext(
  setupInput: SimulationSetupInput | null,
  project: Project,
  simulationDetailCells: number,
): SimulationContext {
  const localProject = setupInput?.project ?? project
  const localPaths = setupInput?.toolpaths ?? NO_PATHS
  const options = simulationBuildOptions(setupInput, simulationDetailCells)
  const emptyGrid = createSimulationGrid(localProject, options)
  return {
    localProject,
    localPaths,
    options,
    empty: {
      grid: emptyGrid,
      stats: emptySimulationStats(emptyGrid),
      warnings: [],
    },
  }
}

/** One selected-operation replay item, or null when it cannot be drawn. */
function selectedReplayItem(
  context: SimulationContext,
  selectedInSetup: Operation | null,
): SimulationReplayItem | null {
  const selectedLocalToolpath = selectedInSetup ? context.localPaths.get(selectedInSetup.id) ?? null : null
  if (!selectedInSetup || !selectedLocalToolpath) return null
  const toolRecord = findOperationTool(context.localProject, selectedInSetup)
  if (!toolRecord) return null
  const normalizedTool = normalizeToolForProject(toolRecord, context.localProject)
  return {
    operationId: selectedInSetup.id,
    operationName: selectedInSetup.name,
    toolRef: toolRecord.id,
    toolType: toolRecord.type,
    toolRadius: normalizedTool.radius,
    vBitAngle: normalizedTool.vBitAngle,
    toolpath: selectedLocalToolpath,
  }
}

/** The visible mode's replay items, in cut order, skipping anything unbuildable. */
function visibleReplayItems(
  context: SimulationContext,
  setupInput: SimulationSetupInput | null,
  paths: ReadonlyMap<string, ToolpathResult> | null,
): SimulationReplayItem[] {
  return (setupInput?.operations ?? [])
    .filter((operation) => operation.enabled && operation.showToolpath && operation.toolRef)
    .map((operation) => {
      const toolpath = paths === null ? null : context.localPaths.get(operation.id) ?? null
      const toolRecord = findOperationTool(context.localProject, operation)

      if (!toolpath || !toolRecord) {
        return null
      }

      const normalizedTool = normalizeToolForProject(toolRecord, context.localProject)
      return {
        operationId: operation.id,
        operationName: operation.name,
        toolRef: toolRecord.id,
        toolType: toolRecord.type,
        toolRadius: normalizedTool.radius,
        vBitAngle: normalizedTool.vBitAngle,
        toolpath,
      }
    })
    .filter((item) => item !== null)
}

/**
 * The synchronous result (issue #1016 C2). Kept for the tests and consumers
 * that already hold every input; the app opens the simulation tab through
 * `computeSimulationResultAsync` so the render that switches tabs is never the
 * one that replays a heavy selected operation (issue #1112 review P1).
 */
export function computeSimulationResult({
  setupInput,
  project,
  simulationMode,
  simulationDetailCells,
  selectedInSetup,
  paths,
}: SimulationResultInput): SimulationResult {
  const context = simulationContext(setupInput, project, simulationDetailCells)

  if (simulationMode === 'selected') {
    const item = selectedReplayItem(context, selectedInSetup)
    if (!item) return context.empty
    return simulateOperationHeightfield(context.localProject, selectedInSetup!, item.toolpath, context.options)
  }

  const replayItems = visibleReplayItems(context, setupInput, paths)
  if (replayItems.length === 0) {
    return context.empty
  }

  return simulateReplayItemsHeightfield(context.localProject, replayItems, context.options)
}

/**
 * The same result, built in yielding slices and cancellable (issue #1112
 * review P1). The tab, its loading state and any loading overlay commit before
 * the first slice runs; a superseded build returns null instead of installing a
 * result the current selection no longer describes.
 */
export async function computeSimulationResultAsync(
  {
    setupInput,
    project,
    simulationMode,
    simulationDetailCells,
    selectedInSetup,
    paths,
  }: SimulationResultInput,
  chunk: SimulationChunkOptions = {},
): Promise<SimulationResult | null> {
  const context = simulationContext(setupInput, project, simulationDetailCells)

  if (simulationMode === 'selected') {
    const item = selectedReplayItem(context, selectedInSetup)
    if (!item) return context.empty
    return simulateOperationHeightfieldChunked(
      context.localProject,
      selectedInSetup!,
      item.toolpath,
      context.options,
      chunk,
    )
  }

  const replayItems = visibleReplayItems(context, setupInput, paths)
  if (replayItems.length === 0) {
    return context.empty
  }

  return simulateReplayItemsHeightfieldChunked(context.localProject, replayItems, context.options, chunk)
}

/**
 * The items playback starts from: the simulated setup's operations BEFORE the
 * selected one, in cut order.
 *
 * Operations listed after the selection have not run yet at this point in the
 * cycle, so their cuts must not appear, and another setup's never do (fresh
 * stock, issue #947). Read, never generate: a path the caller did not acquire
 * stays missing, because the playback supplier must never start work of its
 * own — the thing acquiring the paths up front exists to prevent.
 */
export function buildPriorReplayItems(
  project: Project,
  operations: readonly Operation[],
  paths: ReadonlyMap<string, ToolpathResult>,
  selectedOperationId: string,
): SimulationReplayItem[] {
  const selectedIndex = operations.findIndex((operation) => operation.id === selectedOperationId)
  const priorOperations = selectedIndex >= 0 ? operations.slice(0, selectedIndex) : []

  return priorOperations
    .filter((operation) =>
      operation.enabled
      && operation.showToolpath
      && operation.toolRef,
    )
    .map((operation): SimulationReplayItem | null => {
      const toolpath = paths.get(operation.id) ?? null
      const operationTool = findOperationTool(project, operation)
      if (!toolpath || !operationTool) {
        return null
      }
      const normalizedTool = normalizeToolForProject(operationTool, project)
      return {
        operationId: operation.id,
        operationName: operation.name,
        toolRef: operationTool.id,
        toolType: operationTool.type,
        toolRadius: normalizedTool.radius,
        vBitAngle: normalizedTool.vBitAngle,
        toolpath,
      }
    })
    .filter((item): item is SimulationReplayItem => item !== null)
}

/** The playback starting stock: the prior operations replayed into a fresh grid. */
export function priorReplayGrid(
  project: Project,
  operations: readonly Operation[],
  paths: ReadonlyMap<string, ToolpathResult>,
  selectedOperationId: string,
  options: SimulationBuildOptions,
): SimulationGrid {
  return simulateReplayItemsHeightfield(
    project,
    buildPriorReplayItems(project, operations, paths, selectedOperationId),
    options,
  ).grid
}
