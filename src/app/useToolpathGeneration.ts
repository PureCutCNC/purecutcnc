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
  computeOperationToolpath,
  type ToolpathResult,
  type ToolpathGenerationTrace,
} from '../engine/toolpaths'
import {
  captureCacheInputs,
  cacheInputsValid,
  operationComputationEquals,
  type ToolpathCacheEntry,
} from './toolpathGeneration/cacheInputs'
import type { Operation, Project } from '../types/project'

// Re-exported so the cache suites keep testing the production rules through the
// names they were written against; the rules themselves live in
// `toolpathGeneration/cacheInputs.ts` now that pending jobs must be validated
// too (issue #675).
export { operationComputationEquals }
export type { ToolpathCacheEntry }

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

export function isCacheHit(entry: ToolpathCacheEntry, operation: Operation, project: Project): boolean {
  return cacheInputsValid(entry, operation, project)
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
  return { ...captureCacheInputs(project, operation), result }
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

      // Generation itself lives in the engine (issue #675): one synchronous,
      // DOM-free entry point that the inline and worker backends both call, so
      // the two can never drift apart. What stays here is what cannot cross a
      // thread boundary — the cache keyed on main-thread object identity.
      const envelope = computeOperationToolpath(project, operation)
      if (!envelope) {
        return null
      }

      toolpathCacheRef.current.set(operation.id, buildToolpathCacheEntry(project, operation, envelope.result))
      return envelope.result
    },
    [project]
  )

  // Debug-only (issue #356): produce a {raw, optimized} trace for one operation.
  // Always a fresh compute — the raw path is not retained by ordinary
  // generation, so it can only come from a run that asked for it. Generation is
  // deterministic, so the recompute yields the same optimized result preview and
  // simulation already hold, and the cache is refreshed rather than evicted.
  const getGenerationTrace = useCallback((operation: Operation): ToolpathGenerationTrace | null => {
    const envelope = computeOperationToolpath(project, operation, { trace: true })
    if (!envelope || !envelope.raw) {
      return null
    }
    toolpathCacheRef.current.set(operation.id, buildToolpathCacheEntry(project, operation, envelope.result))
    return { operationId: operation.id, raw: envelope.raw, optimized: envelope.result }
  }, [project])

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
  // When generation is deferred (issue #680) no computation runs, so the
  // spinner must not show: the cache is stale by design until the defer ends.
  const generatingOperationIds = useMemo(() => {
    if (deferGeneration) return new Set<string>()
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
  }, [neededOperationIds, project, toolpathMap, deferGeneration])

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
