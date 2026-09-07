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

import { useEffect, useMemo, useState } from 'react'
import type { SimulationPlaybackInput } from '../components/simulation/SimulationViewport'
import {
  createSimulationGrid,
  simulateOperationHeightfield,
  simulateReplayItemsHeightfield,
  type SimulationGrid,
  type SimulationReplayItem,
  type SimulationResult,
} from '../engine/simulation'
import type { ToolpathResult } from '../engine/toolpaths'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import type { Operation, Project } from '../types/project'

/** Stable empty set, so "nothing to acquire" does not churn the memos below. */
const NO_PATHS: ReadonlyMap<string, ToolpathResult> = new Map()

/** Defer a computation to first call and cache the result for later calls. */
function lazyOnce<T>(compute: () => T): () => T {
  let cached: { value: T } | null = null
  return () => {
    if (cached === null) {
      cached = { value: compute() }
    }
    return cached.value
  }
}

interface UseSimulationModelArgs {
  project: Project
  centerTab: 'sketch' | 'preview3d' | 'simulation'
  simulationMode: 'selected' | 'visible'
  simulationDetailCells: number
  selectedOperation: Operation | null
  selectedToolpath: ToolpathResult | null
  /** Async acquisition (issue #675). Resolves null when the path cannot be produced. */
  requestToolpath: (
    operationId: string,
    purpose: 'simulation',
    signal?: AbortSignal,
  ) => Promise<ToolpathResult | null>
}

export function useSimulationModel({
  project,
  centerTab,
  simulationMode,
  simulationDetailCells,
  selectedOperation,
  selectedToolpath,
  requestToolpath,
}: UseSimulationModelArgs): {
  simulationResult: SimulationResult | null
  simulationOperationCount: number
  simulationPlaybackInput: SimulationPlaybackInput | null
  /** True while the paths simulation needs are still being produced. */
  simulationInputPending: boolean
} {
  /**
   * The toolpaths simulation needs, acquired in an effect (issue #675).
   *
   * Simulation used to generate during render, which is exactly what a worker
   * boundary makes impossible: the answer no longer arrives in the same tick as
   * the question. Acquiring here keeps generation out of render *and* out of the
   * playback callback — the base-grid supplier below closes over what has
   * already been resolved and can never start work of its own.
   *
   * `resolvedFor` stamps which project the paths belong to, so a set acquired
   * for an older revision is never mixed into a simulation of the current one.
   */
  const [acquired, setAcquired] = useState<{ project: Project; paths: Map<string, ToolpathResult> } | null>(null)

  // Every operation simulation may need: the visible set for 'visible' mode,
  // and the prior operations for 'selected' playback's starting stock.
  const requiredOperationIds = useMemo(() => {
    if (centerTab !== 'simulation') return []
    const eligible = (operation: Operation): boolean =>
      operation.enabled && operation.showToolpath && operation.toolRef !== null
    if (simulationMode === 'visible') {
      return project.operations.filter(eligible).map((operation) => operation.id)
    }
    if (!selectedOperation) return []
    const selectedIndex = project.operations.findIndex((operation) => operation.id === selectedOperation.id)
    const prior = selectedIndex >= 0 ? project.operations.slice(0, selectedIndex) : []
    return prior.filter(eligible).map((operation) => operation.id)
  }, [centerTab, project.operations, selectedOperation, simulationMode])

  const requiredKey = requiredOperationIds.join(',')

  useEffect(() => {
    if (centerTab !== 'simulation') {
      setAcquired(null)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(requiredOperationIds.map(async (operationId) => ({
        operationId,
        toolpath: await requestToolpath(operationId, 'simulation', controller.signal),
      })))
      if (cancelled) return
      const paths = new Map<string, ToolpathResult>()
      for (const { operationId, toolpath } of entries) {
        if (toolpath) paths.set(operationId, toolpath)
      }
      setAcquired({ project, paths })
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- requiredKey stands in for the id list; `project` identity is what a re-acquire keys on
  }, [centerTab, requiredKey, project, requestToolpath])

  // Only paths acquired for *this* project revision may be used. A pending or
  // superseded acquisition leaves this null, which is what stops a playback
  // starting on a mixed input set.
  //
  // An empty requirement is already satisfied: a selected operation with no
  // prior operations has nothing to wait for, and making it wait for an effect
  // would delay playback for the commonest case in the name of a dependency
  // that does not exist.
  const paths: ReadonlyMap<string, ToolpathResult> | null = requiredOperationIds.length === 0
    ? NO_PATHS
    : acquired && acquired.project === project ? acquired.paths : null
  const simulationInputPending = centerTab === 'simulation' && paths === null
  const simulationResult = useMemo(() => {
    if (centerTab !== 'simulation') {
      return null
    }

    const emptySimulationResult = {
      grid: createSimulationGrid(project, {
        targetLongAxisCells: simulationDetailCells,
      }),
      stats: {
        removedCellCount: 0,
        minTopZ: project.stock.thickness,
        maxRemovedDepth: 0,
        processedMoveCount: 0,
      },
      warnings: [],
    }

    if (simulationMode === 'selected') {
      if (!selectedOperation || !selectedToolpath) {
        return emptySimulationResult
      }

      return simulateOperationHeightfield(project, selectedOperation, selectedToolpath, {
        targetLongAxisCells: simulationDetailCells,
      })
    }

    const replayItems = project.operations
      .filter((operation) => operation.enabled && operation.showToolpath && operation.toolRef)
      .map((operation) => {
        const toolpath = paths?.get(operation.id) ?? null
        const toolRecord = operation.toolRef
          ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
          : null

        if (!toolpath || !toolRecord) {
          return null
        }

        const normalizedTool = normalizeToolForProject(toolRecord, project)
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

    if (replayItems.length === 0) {
      return emptySimulationResult
    }

    return simulateReplayItemsHeightfield(project, replayItems, {
      targetLongAxisCells: simulationDetailCells,
    })
  }, [centerTab, paths, project, selectedOperation, selectedToolpath, simulationDetailCells, simulationMode])

  const simulationOperationCount = useMemo(() => {
    if (simulationMode === 'selected') {
      return selectedOperation && selectedToolpath ? 1 : 0
    }

    return project.operations.filter((operation) => operation.enabled && operation.showToolpath).length
  }, [project.operations, selectedOperation, selectedToolpath, simulationMode])

  const simulationPlaybackInput = useMemo<SimulationPlaybackInput | null>(() => {
    if (centerTab !== 'simulation' || simulationMode !== 'selected') {
      return null
    }
    if (!selectedOperation || !selectedToolpath) {
      return null
    }
    const toolRecord = selectedOperation.toolRef
      ? project.tools.find((tool) => tool.id === selectedOperation.toolRef) ?? null
      : null
    if (!toolRecord || toolRecord.type === 'drill') {
      return null
    }

    // No playback until every prior operation's path is in hand. Handing the
    // viewport a supplier that would have to generate is what put generation on
    // the playback path in the first place.
    if (paths === null) {
      return null
    }
    const resolvedPaths = paths

    const normalizedSelectedTool = normalizeToolForProject(toolRecord, project)

    // Starting stock state for playback: all operations BEFORE the selected one
    // in the feature tree order, replayed into a fresh grid — operations listed
    // after the selection haven't run yet at this point in the cycle, so their
    // cuts shouldn't appear. The replay is deferred until the viewport actually
    // starts playback (lazyOnce): while the simulation tab is open this memo
    // re-runs on every project change, and eagerly replaying prior operations
    // each time made ordinary edits pay for a full heightfield replay.
    const getBaseGrid = lazyOnce((): SimulationGrid => {
      const selectedIndex = project.operations.findIndex((operation) => operation.id === selectedOperation.id)
      const priorOperations = selectedIndex >= 0 ? project.operations.slice(0, selectedIndex) : []

      const priorItems: SimulationReplayItem[] = priorOperations
        .filter((operation) =>
          operation.enabled
          && operation.showToolpath
          && operation.toolRef,
        )
        .map((operation): SimulationReplayItem | null => {
          // Read, never generate: this runs inside the playback supplier, and a
          // supplier that could start work would be generation on the playback
          // path — the thing acquiring these up front exists to prevent.
          const toolpath = resolvedPaths.get(operation.id) ?? null
          const operationTool = operation.toolRef
            ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
            : null
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

      return simulateReplayItemsHeightfield(project, priorItems, {
        targetLongAxisCells: simulationDetailCells,
      }).grid
    })

    const diameter = normalizedSelectedTool.radius * 2
    // Both maxCutDepth and diameter come from `normalizeToolForProject`, so they're
    // already in project units — mm or inch, whichever the project uses. All the
    // derived dimensions below stay unit-agnostic by staying diameter-relative.
    const toolCutLength = normalizedSelectedTool.maxCutDepth > 0
      ? normalizedSelectedTool.maxCutDepth
      : diameter * 3
    const toolShankLength = diameter * 2
    // Split long source moves so a single move's cell-loop bounding box stays
    // close to the swept path (long diagonals would otherwise test a huge
    // rectangle). Correctness doesn't depend on the length — the controller
    // applies partial moves exactly — so the trade-off is pure overhead: every
    // sub-segment re-tests the tool-radius end caps it shares with its
    // neighbors. At 0.4× radius that overlap dominated (~5/6 of cell tests
    // were repeats); 2× radius keeps bounding boxes tight while cutting the
    // redundant work ~4×.
    const maxSegmentLength = normalizedSelectedTool.radius * 2

    // Operation feed is stored in project-units-per-minute. The viewport works in
    // units-per-second, so divide by 60. This becomes the "1×" playback speed so
    // users can intuitively speed up or slow down relative to the real feed rate.
    const feedPerSecond = selectedOperation.feed > 0 ? selectedOperation.feed / 60 : undefined
    const plungeFeedPerSecond = selectedOperation.plungeFeed > 0 ? selectedOperation.plungeFeed / 60 : undefined
    // `project.meta.units` uses 'inch'; the playback UI shows the short label 'in'.
    const units: 'mm' | 'in' = project.meta.units === 'inch' ? 'in' : 'mm'

    return {
      getBaseGrid,
      moves: selectedToolpath.moves,
      toolType: toolRecord.type,
      toolRadius: normalizedSelectedTool.radius,
      vBitAngle: normalizedSelectedTool.vBitAngle,
      toolCutLength,
      toolShankLength,
      maxSegmentLength,
      units,
      feedPerSecond,
      plungeFeedPerSecond,
    }
  }, [centerTab, paths, project, selectedOperation, selectedToolpath, simulationDetailCells, simulationMode])

  return {
    simulationResult,
    simulationOperationCount,
    simulationPlaybackInput,
    simulationInputPending,
  }
}
