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

import { useMemo } from 'react'
import type { SimulationPlaybackInput } from '../components/simulation/SimulationViewport'
import {
  createSimulationGrid,
  simulateOperationHeightfield,
  simulateReplayItemsHeightfield,
  type SimulationReplayItem,
  type SimulationResult,
} from '../engine/simulation'
import type { ToolpathResult } from '../engine/toolpaths'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import type { Operation, Project } from '../types/project'

interface UseSimulationModelArgs {
  project: Project
  centerTab: 'sketch' | 'preview3d' | 'simulation'
  simulationMode: 'selected' | 'visible'
  simulationDetailCells: number
  selectedOperation: Operation | null
  selectedToolpath: ToolpathResult | null
  generateToolpathForOperation: (op: Operation | null) => ToolpathResult | null
}

export function useSimulationModel({
  project,
  centerTab,
  simulationMode,
  simulationDetailCells,
  selectedOperation,
  selectedToolpath,
  generateToolpathForOperation,
}: UseSimulationModelArgs): {
  simulationResult: SimulationResult | null
  simulationOperationCount: number
  simulationPlaybackInput: SimulationPlaybackInput | null
} {
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
        const toolpath = generateToolpathForOperation(operation)
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
  }, [centerTab, generateToolpathForOperation, project, selectedOperation, selectedToolpath, simulationDetailCells, simulationMode])

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

    const normalizedSelectedTool = normalizeToolForProject(toolRecord, project)

    // Pre-apply only operations that come BEFORE the selected one in the feature
    // tree order — operations listed after the selection haven't run yet at this
    // point in the cycle, so their cuts shouldn't appear in the starting state.
    const selectedIndex = project.operations.findIndex((operation) => operation.id === selectedOperation.id)
    const priorOperations = selectedIndex >= 0 ? project.operations.slice(0, selectedIndex) : []

    const priorItems: SimulationReplayItem[] = priorOperations
      .filter((operation) =>
        operation.enabled
        && operation.showToolpath
        && operation.toolRef,
      )
      .map((operation): SimulationReplayItem | null => {
        const toolpath = generateToolpathForOperation(operation)
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

    const baseResult = simulateReplayItemsHeightfield(project, priorItems, {
      targetLongAxisCells: simulationDetailCells,
    })

    const diameter = normalizedSelectedTool.radius * 2
    // Both maxCutDepth and diameter come from `normalizeToolForProject`, so they're
    // already in project units — mm or inch, whichever the project uses. All the
    // derived dimensions below stay unit-agnostic by staying diameter-relative.
    const toolCutLength = normalizedSelectedTool.maxCutDepth > 0
      ? normalizedSelectedTool.maxCutDepth
      : diameter * 3
    const toolShankLength = diameter * 2
    // Split source moves longer than ~0.4× tool radius so long straights don't
    // apply a single giant cut in one shot. The playback controller also throttles
    // by distance-per-frame now, so this is belt-and-suspenders for partial-cut
    // granularity on very long segments.
    const maxSegmentLength = normalizedSelectedTool.radius * 0.4

    // Operation feed is stored in project-units-per-minute. The viewport works in
    // units-per-second, so divide by 60. This becomes the "1×" playback speed so
    // users can intuitively speed up or slow down relative to the real feed rate.
    const feedPerSecond = selectedOperation.feed > 0 ? selectedOperation.feed / 60 : undefined
    // `project.meta.units` uses 'inch'; the playback UI shows the short label 'in'.
    const units: 'mm' | 'in' = project.meta.units === 'inch' ? 'in' : 'mm'

    return {
      baseGrid: baseResult.grid,
      moves: selectedToolpath.moves,
      toolType: toolRecord.type,
      toolRadius: normalizedSelectedTool.radius,
      vBitAngle: normalizedSelectedTool.vBitAngle,
      toolCutLength,
      toolShankLength,
      maxSegmentLength,
      units,
      feedPerSecond,
    }
  }, [centerTab, generateToolpathForOperation, project, selectedOperation, selectedToolpath, simulationDetailCells, simulationMode])

  return {
    simulationResult,
    simulationOperationCount,
    simulationPlaybackInput,
  }
}
