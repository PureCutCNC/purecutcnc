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

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  applyClampWarnings,
  applyTabsToEdgeRoute,
  applyTabWarnings,
  generateDrillingToolpath,
  generateEdgeRouteToolpath,
  generateFinishSurfaceCleanupToolpath,
  generateFinishSurfaceToolpath,
  generateFollowLineToolpath,
  generatePocketToolpath,
  generateRoughSurfaceToolpath,
  generateSurfaceCleanToolpath,
  generateVCarveRecursiveToolpath,
  generateVCarveToolpath,
  type ToolpathResult,
} from '../engine/toolpaths'
import type { Clamp, Operation, Project, SketchFeature, Stock, Tab, Tool } from '../types/project'

export interface ToolpathCacheEntry {
  result: ToolpathResult
  operation: Operation
  stock: Stock
  features: SketchFeature[]
  tools: Tool[]
  tabs: Tab[]
  clamps: Clamp[]
}

type ToolpathMapUpdater = Map<string, ToolpathResult> | ((prev: Map<string, ToolpathResult>) => Map<string, ToolpathResult>)
type ToolpathMapSetter = (value: ToolpathMapUpdater) => void

interface StartToolpathGenerationPipelineOptions {
  neededOperationIds: string[]
  project: Project
  toolpathCache: Map<string, ToolpathCacheEntry>
  generateToolpathForOperation: (operation: Operation | null) => ToolpathResult | null
  setToolpathMap: ToolpathMapSetter
  requestAnimationFrameFn?: (callback: FrameRequestCallback) => number
  scheduleAfterPaintFn?: (fn: () => void) => void
}

// Compare only fields that affect toolpath geometry. Excluded (display-only):
//   name, enabled, showToolpath
// Any new computation-relevant field added to Operation must be listed here.
export function operationComputationEquals(a: Operation, b: Operation): boolean {
  if (a === b) return true
  return (
    a.kind === b.kind
    && a.pass === b.pass
    && a.target === b.target
    && a.toolRef === b.toolRef
    && a.stepdown === b.stepdown
    && a.stepover === b.stepover
    && a.feed === b.feed
    && a.plungeFeed === b.plungeFeed
    && a.rpm === b.rpm
    && a.pocketPattern === b.pocketPattern
    && a.pocketAngle === b.pocketAngle
    && a.pocketSlotFeedPercent === b.pocketSlotFeedPercent
    && a.roundOutsideCorners === b.roundOutsideCorners
    && a.stockToLeaveRadial === b.stockToLeaveRadial
    && a.stockToLeaveAxial === b.stockToLeaveAxial
    && a.finishWalls === b.finishWalls
    && a.finishFloor === b.finishFloor
    && a.carveDepth === b.carveDepth
    && a.maxCarveDepth === b.maxCarveDepth
    && a.cutDirection === b.cutDirection
    && a.machiningOrder === b.machiningOrder
    && a.drillType === b.drillType
    && a.peckDepth === b.peckDepth
    && a.dwellTime === b.dwellTime
    && a.retractHeight === b.retractHeight
    && a.debugToolpath === b.debugToolpath
    && a.debugShowRejectedCorners === b.debugShowRejectedCorners
    && a.waterlineAdaptiveRefinement === b.waterlineAdaptiveRefinement
    && a.waterlineMicroStepover === b.waterlineMicroStepover
    && a.waterlineRefinementThreshold === b.waterlineRefinementThreshold
    && a.waterlineMaxRingsPerBand === b.waterlineMaxRingsPerBand
    && a.waterlineTipStepdown === b.waterlineTipStepdown
  )
}

export function isCacheHit(entry: ToolpathCacheEntry, operation: Operation, project: Project): boolean {
  return (
    operationComputationEquals(entry.operation, operation)
    && entry.stock === project.stock
    && entry.features === project.features
    && entry.tools === project.tools
    && entry.tabs === project.tabs
    && entry.clamps === project.clamps
  )
}

// Double-rAF: the first rAF fires before the current paint, the second
// fires in the next frame — guaranteeing one browser paint in between.
// This ensures the spinner is visually rendered before computation blocks.
export function scheduleAfterPaint(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn))
}

export function startToolpathGenerationPipeline({
  neededOperationIds,
  project,
  toolpathCache,
  generateToolpathForOperation,
  setToolpathMap,
  requestAnimationFrameFn = requestAnimationFrame,
  scheduleAfterPaintFn = scheduleAfterPaint,
}: StartToolpathGenerationPipelineOptions): () => void {
  const immediateResults = new Map<string, ToolpathResult>()
  const toCompute: string[] = []

  for (const id of neededOperationIds) {
    const op = project.operations.find((o) => o.id === id)
    if (!op) continue

    const entry = toolpathCache.get(id)
    if (entry && isCacheHit(entry, op, project)) {
      immediateResults.set(id, entry.result)
    } else {
      toCompute.push(id)
    }
  }

  setToolpathMap(immediateResults)

  if (toCompute.length === 0) {
    return () => {}
  }

  let cancelled = false
  let idx = 0

  function computeNext() {
    if (cancelled || idx >= toCompute.length) return

    const op = project.operations.find((o) => o.id === toCompute[idx])
    if (op && !cancelled) {
      const result = generateToolpathForOperation(op)
      if (!cancelled) {
        setToolpathMap((prev) => {
          const next = new Map(prev)
          if (result) next.set(op.id, result)
          return next
        })
      }
    }

    idx++
    if (idx < toCompute.length && !cancelled) {
      scheduleAfterPaintFn(computeNext)
    }
  }

  // Double-rAF: the first rAF fires before the current paint, the second
  // fires in the next frame — guaranteeing one browser paint in between.
  // This ensures the spinner is visually rendered before computation blocks.
  requestAnimationFrameFn(() => {
    if (!cancelled) requestAnimationFrameFn(computeNext)
  })
  return () => { cancelled = true }
}

export function useToolpathGeneration(project: Project, selectedOperation: Operation | null): {
  toolpathMap: Map<string, ToolpathResult>
  generateToolpathForOperation: (op: Operation | null) => ToolpathResult | null
  generatingOperationIds: Set<string>
  selectedToolpath: ToolpathResult | null
  visibleToolpaths: ToolpathResult[]
  collidingClampIds: string[]
} {
  const toolpathCacheRef = useRef<Map<string, ToolpathCacheEntry>>(new Map())
  const [toolpathMap, setToolpathMap] = useState<Map<string, ToolpathResult>>(new Map())

  const generateToolpathForOperation = useMemo(
    () => (operation: Operation | null): ToolpathResult | null => {
      if (!operation) {
        return null
      }

      const cached = toolpathCacheRef.current.get(operation.id)
      if (cached && isCacheHit(cached, operation, project)) {
        return cached.result
      }

      let result: ToolpathResult | null = null

      if (operation.kind === 'pocket') {
        result = applyClampWarnings(project, applyTabWarnings(project, operation, generatePocketToolpath(project, operation)), operation)
      } else if (operation.kind === 'v_carve') {
        result = applyClampWarnings(project, generateVCarveToolpath(project, operation), operation)
      } else if (operation.kind === 'v_carve_recursive') {
        result = applyClampWarnings(project, generateVCarveRecursiveToolpath(project, operation), operation)
      } else if (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside') {
        const tabAware = applyTabsToEdgeRoute(project, operation, generateEdgeRouteToolpath(project, operation))
        result = applyClampWarnings(project, applyTabWarnings(project, operation, tabAware), operation)
      } else if (operation.kind === 'surface_clean') {
        result = applyClampWarnings(project, applyTabWarnings(project, operation, generateSurfaceCleanToolpath(project, operation)), operation)
      } else if (operation.kind === 'rough_surface') {
        result = applyClampWarnings(project, applyTabWarnings(project, operation, generateRoughSurfaceToolpath(project, operation)), operation)
      } else if (operation.kind === 'finish_surface') {
        const tabAware = applyTabsToEdgeRoute(project, operation, generateFinishSurfaceToolpath(project, operation))
        result = applyClampWarnings(project, applyTabWarnings(project, operation, tabAware), operation)
      } else if (operation.kind === 'finish_surface_cleanup') {
        const tabAware = applyTabsToEdgeRoute(project, operation, generateFinishSurfaceCleanupToolpath(project, operation))
        result = applyClampWarnings(project, applyTabWarnings(project, operation, tabAware), operation)
      } else if (operation.kind === 'follow_line') {
        result = applyClampWarnings(project, generateFollowLineToolpath(project, operation), operation)
      } else if (operation.kind === 'drilling') {
        result = applyClampWarnings(project, generateDrillingToolpath(project, operation), operation)
      }

      if (result) {
        toolpathCacheRef.current.set(operation.id, {
          result,
          operation,
          stock: project.stock,
          features: project.features,
          tools: project.tools,
          tabs: project.tabs,
          clamps: project.clamps,
        })
      }

      return result
    },
    [project]
  )

  // Operations that need toolpath computation (selected first for priority)
  const neededOperationIds = useMemo(() => {
    const ids: string[] = []
    const seen = new Set<string>()
    if (selectedOperation) {
      ids.push(selectedOperation.id)
      seen.add(selectedOperation.id)
    }
    for (const op of project.operations) {
      if (op.showToolpath && !seen.has(op.id)) {
        ids.push(op.id)
      }
    }
    return ids
  }, [selectedOperation, project.operations])

  // Derived during render by checking cache validity — the spinner shows on
  // the very first render after a parameter change, not one frame late.
  // toolpathMap is included as a dependency so the memo recomputes when the
  // async pipeline finishes and updates the map (which also updates the cache).
  const generatingOperationIds = useMemo(() => {
    const ids = new Set<string>()
    for (const id of neededOperationIds) {
      const op = project.operations.find((o) => o.id === id)
      if (!op) continue
      const entry = toolpathCacheRef.current.get(id)
      if (!entry || !isCacheHit(entry, op, project)) {
        ids.add(id)
      }
    }
    return ids
  // toolpathMap is load-bearing, not unnecessary: the memo reads cache state via
  // toolpathCacheRef (a ref the rule can't see) which is updated in lockstep with
  // toolpathMap when the async pipeline finishes. Dropping it would leave the
  // generating spinner stuck on. `project` does not change when generation completes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededOperationIds, project, toolpathMap])

  // Async toolpath pipeline: resolves cached results immediately, defers
  // uncached operations one-per-frame with a paint gap in between so the
  // spinner (derived from cache staleness above) stays animated.
  useEffect(() => {
    return startToolpathGenerationPipeline({
      neededOperationIds,
      project,
      toolpathCache: toolpathCacheRef.current,
      generateToolpathForOperation,
      setToolpathMap,
    })
  }, [neededOperationIds, generateToolpathForOperation, project])

  const selectedToolpath = selectedOperation
    ? toolpathMap.get(selectedOperation.id) ?? null
    : null

  const visibleToolpaths = useMemo<ToolpathResult[]>(() => {
    return project.operations
      .filter((operation) => operation.showToolpath)
      .map((operation) => toolpathMap.get(operation.id))
      .filter((toolpath): toolpath is ToolpathResult => toolpath != null)
  }, [project.operations, toolpathMap])
  const collidingClampIds = useMemo(
    () => [
      ...new Set([
        ...visibleToolpaths.flatMap((toolpath) => toolpath.collidingClampIds ?? []),
        ...(selectedToolpath?.collidingClampIds ?? []),
      ]),
    ],
    [selectedToolpath, visibleToolpaths],
  )

  return {
    toolpathMap,
    generateToolpathForOperation,
    generatingOperationIds,
    selectedToolpath,
    visibleToolpaths,
    collidingClampIds,
  }
}
