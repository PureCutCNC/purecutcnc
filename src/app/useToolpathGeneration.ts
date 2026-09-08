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

import { useCallback, useEffect, useMemo } from 'react'
import type { ToolpathResult, ToolpathGenerationTrace } from '../engine/toolpaths'
import {
  captureCacheInputs,
  cacheInputsValid,
  operationComputationEquals,
  type ToolpathCacheEntry,
} from './toolpathGeneration/cacheInputs'
import { useGenerationService } from './toolpathGeneration/useGenerationService'
import { DEFAULT_EXECUTOR_KIND } from './toolpathGeneration/executorPreference'
import type { GenerationContext, ToolpathGenerationService } from './toolpathGeneration/service'
import type {
  ExecutorKind,
  GenerationPurpose,
  GenerationStatusSnapshot,
} from './toolpathGeneration/types'
import type { Operation, Project } from '../types/project'

// Re-exported so the cache suites keep testing the production rules through the
// names they were written against; the rules themselves live in
// `toolpathGeneration/cacheInputs.ts` now that pending jobs must be validated
// too (issue #675).
export { operationComputationEquals }
export type { ToolpathCacheEntry }

/**
 * Is a cached result still valid for this operation in this project?
 *
 * A thin wrapper over `cacheInputsValid` (issue #675): the rules moved to
 * `toolpathGeneration/cacheInputs.ts` when in-flight jobs needed validating
 * too, and this name stays so the cache suites keep testing them through the
 * entry point they were written against.
 */
export function isCacheHit(entry: ToolpathCacheEntry, operation: Operation, project: Project): boolean {
  return cacheInputsValid(entry, operation, project)
}

/**
 * Build the cache entry written when a toolpath is generated — the **single
 * definition** of what an entry contains (issue #518, S3c), so the predicate is
 * always tested against the exact shape production writes.
 *
 * The footprint comes from the same `project` snapshot the result was generated
 * from, so the two can never disagree.
 */
export function buildToolpathCacheEntry(
  project: Project,
  operation: Operation,
  result: ToolpathResult,
): ToolpathCacheEntry {
  return { ...captureCacheInputs(project, operation), result }
}

/**
 * The operations the preview wants computed, selected first.
 *
 * Order is priority: the operation the user is looking at is the one they are
 * waiting for, so it goes to the front of the queue and the rest follow in
 * project order.
 */
export function selectNeededOperationIds(
  project: Project,
  selectedOperation: Operation | null,
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  if (selectedOperation) {
    ids.push(selectedOperation.id)
    seen.add(selectedOperation.id)
  }
  for (const operation of project.operations) {
    if (operation.showToolpath && !seen.has(operation.id)) {
      ids.push(operation.id)
    }
  }
  return ids
}

type DisplayReader = Pick<ToolpathGenerationService, 'peekCurrent' | 'peekDisplayOnly'>

/**
 * The map the viewport draws.
 *
 * Per id, in this order: the cache-valid result; otherwise the last result for
 * that operation, retained as a **stale placeholder** so a visible toolpath does
 * not blank out while its recompute is pending (the spinner already signals
 * that); otherwise absent.
 *
 * Rebuilt from `neededOperationIds` every time, so an operation that is no
 * longer needed is dropped rather than lingering.
 *
 * Retaining a stale path here is display-only and cannot reach a program:
 * export, simulation, booklet and debug all go through `service.request`, which
 * either returns a validated result or refuses. `peekDisplayOnly` is named the
 * way it is so that distinction survives being read at a glance.
 */
export function buildDisplayToolpathMap(
  service: DisplayReader,
  context: GenerationContext,
  neededOperationIds: readonly string[],
): Map<string, ToolpathResult> {
  const next = new Map<string, ToolpathResult>()
  for (const id of neededOperationIds) {
    if (!context.project.operations.some((operation) => operation.id === id)) continue
    const current = service.peekCurrent(context, id)
    if (current) {
      next.set(id, current)
      continue
    }
    const stale = service.peekDisplayOnly(id)
    if (stale) next.set(id, stale)
  }
  return next
}

export interface ToolpathGenerationBinding {
  toolpathMap: Map<string, ToolpathResult>
  /** Await a validated result. Resolves null when the operation could not be produced. */
  requestToolpath: (
    operationId: string,
    purpose: GenerationPurpose,
    signal?: AbortSignal,
  ) => Promise<ToolpathResult | null>
  /** Await a {raw, optimized} trace (issue #356). Never served from the ordinary cache. */
  requestGenerationTrace: (
    operationId: string,
    signal?: AbortSignal,
  ) => Promise<ToolpathGenerationTrace | null>
  generatingOperationIds: Set<string>
  selectedToolpath: ToolpathResult | null
  visibleToolpaths: ToolpathResult[]
  collidingClampIds: string[]
  generationStatus: GenerationStatusSnapshot
  /** For consumers that assemble their own multi-operation request. */
  service: ToolpathGenerationService
  contextRef: React.RefObject<GenerationContext>
  stopGeneration: () => void
  resumeGeneration: () => void
  retryGeneration: () => void
}

/**
 * Preview's adapter onto the generation service (issue #675).
 *
 * This hook no longer generates anything. It states what the preview needs,
 * reads back what the service has, and exposes explicit status — the compute
 * callback it used to hand out is gone, because a synchronous one cannot exist
 * once the work may happen on another thread.
 */
export function useToolpathGeneration(
  project: Project,
  selectedOperation: Operation | null,
  deferGeneration = false,
  documentKey = 0,
  executor: ExecutorKind = DEFAULT_EXECUTOR_KIND,
): ToolpathGenerationBinding {
  const { service, status, context, contextRef } = useGenerationService(project, documentKey, executor)

  const neededOperationIds = useMemo(
    () => selectNeededOperationIds(project, selectedOperation),
    [project, selectedOperation],
  )

  // Demand is stated in an effect, never during render: submitting work is a
  // side effect, and a render React discards must not leave a job behind.
  //
  // While a history transaction is open (issue #518, S4) the store rewrites
  // `project` on every pointermove. `deferGeneration` withholds demand for the
  // duration, so one gesture produces one regeneration on commit rather than
  // one per frame.
  useEffect(() => {
    service.setAutomaticDemand({ project, documentKey }, neededOperationIds, deferGeneration)
  }, [service, project, documentKey, neededOperationIds, deferGeneration])

  // Derived during render from cache validity, so the spinner appears on the
  // first render after a parameter change rather than a frame later. Both reads
  // are pure — they start no work. `status` is a dependency because a
  // completion is what makes an id stop generating.
  const generatingOperationIds = useMemo(() => {
    if (deferGeneration) return new Set<string>()
    const ids = new Set<string>()
    for (const id of neededOperationIds) {
      if (!service.peekCurrent(context, id)) ids.add(id)
    }
    return ids
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `context` is rebuilt per render from project/documentKey; `status` is what signals a completion
  }, [service, neededOperationIds, project, documentKey, status, deferGeneration])

  const toolpathMap = useMemo(
    () => buildDisplayToolpathMap(service, context, neededOperationIds),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
    [service, neededOperationIds, project, documentKey, status],
  )

  const requestToolpath = useCallback(
    async (operationId: string, purpose: GenerationPurpose, signal?: AbortSignal): Promise<ToolpathResult | null> => {
      const outcome = await service.request(contextRef.current, operationId, { purpose, signal })
      return outcome.status === 'completed' ? outcome.result : null
    },
    [service, contextRef],
  )

  const requestGenerationTrace = useCallback(
    async (operationId: string, signal?: AbortSignal): Promise<ToolpathGenerationTrace | null> => {
      const outcome = await service.request(contextRef.current, operationId, { purpose: 'debug', trace: true, signal })
      if (outcome.status !== 'completed' || !outcome.raw) return null
      return { operationId, raw: outcome.raw, optimized: outcome.result }
    },
    [service, contextRef],
  )

  const stopGeneration = useCallback(() => { service.stopAutomaticGeneration() }, [service])
  const resumeGeneration = useCallback(() => { service.resumeAutomaticGeneration() }, [service])
  const retryGeneration = useCallback(() => { service.retryAfterFailure() }, [service])

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
    requestToolpath,
    requestGenerationTrace,
    generatingOperationIds,
    selectedToolpath,
    visibleToolpaths,
    collidingClampIds,
    generationStatus: status,
    service,
    contextRef,
    stopGeneration,
    resumeGeneration,
    retryGeneration,
  }
}
