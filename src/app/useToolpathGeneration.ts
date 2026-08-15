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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyClampWarnings,
  applyEdgeRouteTabs,
  applyTabsToEdgeRoute,
  applyTabWarnings,
  diffToolpathInputs,
  generateDrillingToolpath,
  generateEdgeRouteToolpath,
  generateFinishSurfaceCleanupToolpath,
  generateFinishSurfaceToolpath,
  generateFollowLineToolpath,
  generatePocketToolpath,
  generateRoughSurfaceToolpath,
  generateSurfaceCleanToolpath,
  generateVCarveMedialToolpath,
  generateVCarveToolpath,
  operationAffectedByChange,
  operationFootprint,
  optimizeLinearMoves,
  type OperationFootprint,
  type ToolpathResult,
  type ToolpathGenerationTrace,
} from '../engine/toolpaths'
import type { Clamp, Operation, Project, Stock, Tab, Tool } from '../types/project'
import { projectsEqual } from '../store/helpers/normalize'

export interface ToolpathCacheEntry {
  result: ToolpathResult
  operation: Operation
  stock: Stock
  /** The project snapshot this result was generated from (issue #518). */
  project: Project
  /**
   * The world-XY region a feature change must reach to invalidate this entry
   * (issue #518, S3b). Computed from the same `project` snapshot at the point
   * the entry is written, so it can never disagree with the inputs the result
   * was generated from.
   */
  footprint: OperationFootprint
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
    && a.edgeStrategy === b.edgeStrategy
    && a.carveStrategy === b.carveStrategy
    && a.trochoidalCutWidth === b.trochoidalCutWidth
    && a.trochoidalAdvance === b.trochoidalAdvance
    && a.entryStrategy === b.entryStrategy
    && a.entryRampAngle === b.entryRampAngle
    && a.entryHelixDiameterPercent === b.entryHelixDiameterPercent
    && a.pocketSlotFeedPercent === b.pocketSlotFeedPercent
    && a.pocketFeedReduction === b.pocketFeedReduction
    && a.roundOutsideCorners === b.roundOutsideCorners
    && a.cornerRelief === b.cornerRelief
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
    && a.countersinkDiameter === b.countersinkDiameter
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
  if (
    !operationComputationEquals(entry.operation, operation)
    || entry.stock !== project.stock
    || entry.tabs !== project.tabs
    || entry.clamps !== project.clamps
  ) {
    return false
  }

  // Tools are narrowed to the operation's own tool (issue #518, S5): every
  // engine read is `project.tools.find(t => t.id === operation.toolRef)` —
  // clamps.ts, carving.ts, drilling.ts, edge.ts, pocket.ts, geometry.ts, and
  // four more — and no call site reads any other tool, so importing, editing,
  // or deleting an unrelated tool cannot change this operation's output.
  // Keep the whole-array identity fast path; a changed array compares only
  // the operation's tool row, identity-first with a deep-equal fallback.
  // Missing on either side counts as changed: unknown means invalidate.
  //
  // `tabs` and `clamps` deliberately stay whole-array identity: tab reads are
  // not all spatially filtered (modelProtection.ts iterates every tab;
  // edge.ts passes `project.tabs` wholesale for trochoidal), so narrowing
  // them needs its own footprint argument and is out of scope here.
  if (entry.tools !== project.tools) {
    const before = entry.tools.find((tool) => tool.id === operation.toolRef) ?? null
    const after = project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    if (before !== after && (!before || !after || !projectsEqual(before, after))) return false
  }

  // The entry holds the full project snapshot it was generated from
  // (`entry.project`). Holding one `Project` reference per entry is bounded —
  // at most one per operation — and immutable updates share structure, so
  // this is not a leak. When the snapshot's identity still matches, skip the
  // O(n) diff below.
  if (entry.project === project) return true

  // Each entry diffs against its **own** snapshot, not a single global
  // "changed since last render" set: operations are generated at different
  // times, so one entry may be several edits older than another and a shared
  // set would be wrong for the stale one. Display-only instance changes
  // (visible, locked, folderId) produce an empty diff and stop invalidating.
  // Whether a geometry change invalidates is decided by the footprint
  // consult below.
  const diff = diffToolpathInputs(entry.project, project)
  if (diff.invalidatesEveryOperation) return false
  if (diff.changedFeatureIds.size === 0) return true
  // Spatial narrowing (issue #518, S3b): a changed feature invalidates this
  // entry only when the change reaches the footprint recorded on it. The
  // footprint was computed from `entry.project` — the same snapshot the
  // result was generated from — so the two can never disagree, and an
  // unknown footprint invalidates by construction (`bounds === null`).
  return !operationAffectedByChange(entry.footprint, entry.project, project, diff.changedFeatureIds)
}

/**
 * Build the cache entry the hook writes when a toolpath is generated. This is
 * the **single definition** of what an entry contains (issue #518, S3c): the
 * hook's write path and the test suite both consume this builder, so the
 * predicate is always tested against the exact entry shape production writes.
 *
 * The footprint is computed from the same `project` snapshot the result was
 * generated from, at the point the entry is written, so it can never disagree
 * with the inputs the result was generated from.
 */
export function buildToolpathCacheEntry(
  project: Project,
  operation: Operation,
  result: ToolpathResult,
): ToolpathCacheEntry {
  return {
    result,
    operation,
    stock: project.stock,
    project,
    footprint: operationFootprint(project, operation),
    tools: project.tools,
    tabs: project.tabs,
    clamps: project.clamps,
  }
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
  const toCompute: string[] = []
  // Cache-hit results, classified exactly once per needed operation before the
  // map updater below runs (React defers updaters, so the classification must
  // not live inside it — `toCompute` has to be ready synchronously).
  const hitResults = new Map<string, ToolpathResult>()

  for (const id of neededOperationIds) {
    const op = project.operations.find((o) => o.id === id)
    if (!op) continue

    const entry = toolpathCache.get(id)
    if (entry && isCacheHit(entry, op, project)) {
      hitResults.set(id, entry.result)
    } else {
      toCompute.push(id)
    }
  }

  // Build the initial map from `neededOperationIds` alone, in this order per
  // id (issue #518, S4): the cache-hit result when the entry is valid;
  // otherwise the **previous** map's entry, retained as a stale placeholder so
  // a visible toolpath does not blank out while its recompute is pending (the
  // `generatingOperationIds` spinner already signals the recompute); otherwise
  // absent. An operation no longer in `neededOperationIds` is never carried
  // over — the map is rebuilt from the list each time, so nothing leaks.
  //
  // Retaining a stale result is display-only and cannot affect exported
  // G-code: the export dialog calls `generateToolpathForOperation` (App.tsx
  // passes it as `generateToolpath`), which re-validates through `isCacheHit`
  // and regenerates on a miss. It never reads `toolpathMap`.
  setToolpathMap((prev) => {
    const next = new Map<string, ToolpathResult>()
    for (const id of neededOperationIds) {
      const op = project.operations.find((o) => o.id === id)
      if (!op) continue
      const hit = hitResults.get(id)
      if (hit) {
        next.set(id, hit)
        continue
      }
      const stale = prev.get(id)
      if (stale) next.set(id, stale)
    }
    return next
  })

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

/**
 * The pipeline effect body (issue #518, S4): a no-op while `deferGeneration`
 * is true, otherwise the pipeline itself. Exported so the deferral decision is
 * unit-testable without a React renderer; `useToolpathGeneration`'s effect is
 * exactly this call.
 */
export function runToolpathGenerationEffect(
  options: StartToolpathGenerationPipelineOptions,
  deferGeneration = false,
): () => void {
  if (deferGeneration) return () => {}
  return startToolpathGenerationPipeline(options)
}

export function useToolpathGeneration(
  project: Project,
  selectedOperation: Operation | null,
  deferGeneration = false,
): {
  toolpathMap: Map<string, ToolpathResult>
  generateToolpathForOperation: (op: Operation | null) => ToolpathResult | null
  getGenerationTrace: (operation: Operation) => ToolpathGenerationTrace | null
  generatingOperationIds: Set<string>
  selectedToolpath: ToolpathResult | null
  visibleToolpaths: ToolpathResult[]
  collidingClampIds: string[]
} {
  const toolpathCacheRef = useRef<Map<string, ToolpathCacheEntry>>(new Map())
  // Ephemeral, debug-only (issue #356): the pre-optimization toolpath per
  // operation, captured at the optimization seam. Never serialised; used only
  // by the exported-motion debug view's "Generated" layer.
  const rawToolpathRef = useRef<Map<string, ToolpathResult>>(new Map())
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

      // Capture the pre-optimization toolpath into the ephemeral raw trace
      // (issue #356), then run the always-on linear-move merge. `runOptimize`
      // is aliased so the call sites below can be redirected wholesale to
      // `optimizeAndCapture` without recursing back into this definition.
      const runOptimize = optimizeLinearMoves
      const optimizeAndCapture = (raw: ToolpathResult): ToolpathResult => {
        rawToolpathRef.current.set(raw.operationId, raw)
        return runOptimize(raw)
      }

      let result: ToolpathResult | null = null

      if (operation.kind === 'pocket') {
        result = applyClampWarnings(project, optimizeAndCapture(applyTabWarnings(project, operation, generatePocketToolpath(project, operation))), operation)
      } else if (operation.kind === 'v_carve') {
        result = applyClampWarnings(project, optimizeAndCapture(generateVCarveToolpath(project, operation)), operation)
      } else if (operation.kind === 'v_carve_medial') {
        result = applyClampWarnings(project, optimizeAndCapture(generateVCarveMedialToolpath(project, operation)), operation)
      } else if (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside') {
        // Warnings first: applyTabWarnings judges each tab against the cut Z range, and
        // applyTabsToEdgeRoute raises that range to the tab tops. Run it on the adjusted
        // moves and every applied tab reports as lying outside the range it just created.
        const warned = applyTabWarnings(project, operation, generateEdgeRouteToolpath(project, operation))
        // applyEdgeRouteTabs, not applyTabsToEdgeRoute: trochoidal roughing owns
        // its own tab motion and must not be tabbed twice. See its docstring.
        result = applyClampWarnings(project, optimizeAndCapture(applyEdgeRouteTabs(project, operation, warned)), operation)
      } else if (operation.kind === 'surface_clean') {
        result = applyClampWarnings(project, optimizeAndCapture(applyTabWarnings(project, operation, generateSurfaceCleanToolpath(project, operation))), operation)
      } else if (operation.kind === 'rough_surface') {
        result = applyClampWarnings(project, optimizeAndCapture(applyTabWarnings(project, operation, generateRoughSurfaceToolpath(project, operation))), operation)
      } else if (operation.kind === 'finish_surface') {
        const warned = applyTabWarnings(project, operation, generateFinishSurfaceToolpath(project, operation))
        result = applyClampWarnings(project, optimizeAndCapture(applyTabsToEdgeRoute(project, operation, warned)), operation)
      } else if (operation.kind === 'finish_surface_cleanup') {
        const warned = applyTabWarnings(project, operation, generateFinishSurfaceCleanupToolpath(project, operation))
        result = applyClampWarnings(project, optimizeAndCapture(applyTabsToEdgeRoute(project, operation, warned)), operation)
      } else if (operation.kind === 'follow_line') {
        result = applyClampWarnings(project, optimizeAndCapture(generateFollowLineToolpath(project, operation)), operation)
      } else if (operation.kind === 'drilling') {
        result = applyClampWarnings(project, optimizeAndCapture(generateDrillingToolpath(project, operation)), operation)
      }

      if (result) {
        toolpathCacheRef.current.set(operation.id, buildToolpathCacheEntry(project, operation, result))
      }

      return result
    },
    [project]
  )

  // Debug-only (issue #356): produce a {raw, optimized} trace for one operation.
  // Forces a fresh compute (deleting the cache entry bypasses the cache-hit
  // path, which skips raw capture) so the ephemeral raw trace is guaranteed
  // fresh for the debug view. Generation is deterministic, so the recompute
  // recaches the same optimized result preview/simulation already use.
  const getGenerationTrace = useCallback((operation: Operation): ToolpathGenerationTrace | null => {
    rawToolpathRef.current.delete(operation.id)
    toolpathCacheRef.current.delete(operation.id)
    const optimized = generateToolpathForOperation(operation)
    const raw = rawToolpathRef.current.get(operation.id)
    if (!optimized || !raw) {
      return null
    }
    return { operationId: operation.id, raw, optimized }
  }, [generateToolpathForOperation])

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
  //
  // While a history transaction is open (issue #518, S4) the store rewrites
  // `project` on every pointermove; starting the pipeline per frame would
  // restart generation mid-gesture. `deferGeneration` defers — returning the
  // no-op cleanup and leaving `toolpathMap` untouched — so one gesture commit
  // produces exactly one regeneration when the flag flips back to false.
  useEffect(() => {
    return runToolpathGenerationEffect(
      {
        neededOperationIds,
        project,
        toolpathCache: toolpathCacheRef.current,
        generateToolpathForOperation,
        setToolpathMap,
      },
      deferGeneration,
    )
  }, [neededOperationIds, generateToolpathForOperation, project, deferGeneration])

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
    getGenerationTrace,
    generatingOperationIds,
    selectedToolpath,
    visibleToolpaths,
    collidingClampIds,
  }
}
