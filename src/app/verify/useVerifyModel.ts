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
 * The Verify mode's state (issue #1269): whether the simulation viewport is in
 * Verify mode, the chosen comparison, and the one run on screen.
 *
 * A run starts only from `run()`. It acquires the covered operations' paths
 * through the same `requestToolpath` the simulation uses, then runs
 * `runVerification` with yields between operations. The finished result is
 * kept until the next run; when the project or the request changes it is
 * reported stale (`staleness`), never recomputed by itself.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getActiveMachineDefinition } from '../../engine/gcode/definitions'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { activeSetup } from '../../store/helpers/activeFace'
import type { Operation, Project } from '../../types/project'
import { setupOperations } from '../simulationSetup'
import { runVerification, type VerifyRunResult } from './verifyRun'
import {
  verifyOperations,
  verifyStaleness,
  verifyUptoOperationId,
  type VerifyComparison,
  type VerifyRequest,
  type VerifyStaleness,
} from './verifyRequest'

export type VerifyRunStatus = 'idle' | 'running' | 'done' | 'failed'

/** What the viewport reads and calls. */
export interface VerifyModel {
  active: boolean
  setActive: (active: boolean) => void
  comparison: VerifyComparison
  setComparison: (comparison: VerifyComparison) => void
  status: VerifyRunStatus
  /** Operations done of the run's total while running. */
  progress: { done: number; total: number } | null
  result: VerifyRunResult | null
  /** Null without a result. */
  staleness: VerifyStaleness | null
  /** What a run now would cover: the setup, and the operation it is cumulative up to. */
  scope: { setupName: string; uptoOperationName: string | null }
  run: () => void
  cancel: () => void
}

interface UseVerifyModelArgs {
  project: Project
  selectedOperationId: string | null
  detailCells: number
  requestToolpath: (operationId: string, purpose: 'simulation', signal?: AbortSignal) => Promise<ToolpathResult | null>
}

function scopedOperations(project: Project, setup: ReturnType<typeof activeSetup>): Operation[] {
  try {
    return setupOperations(project, setup)
  } catch {
    return []
  }
}

export function useVerifyModel({ project, selectedOperationId, detailCells, requestToolpath }: UseVerifyModelArgs): VerifyModel {
  const [active, setActiveState] = useState(false)
  const [comparison, setComparison] = useState<VerifyComparison>('modelInternal')
  const [status, setStatus] = useState<VerifyRunStatus>('idle')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<VerifyRunResult | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const setup = useMemo(() => activeSetup(project), [project])
  const operations = useMemo(() => scopedOperations(project, setup), [project, setup])
  const uptoOperationId = verifyUptoOperationId(operations, selectedOperationId)
  const request = useMemo<VerifyRequest>(() => ({
    project, setupId: setup.id, comparison, uptoOperationId, detailCells,
  }), [comparison, detailCells, project, setup.id, uptoOperationId])

  // The latest inputs for `run`, so the callback stays stable across renders.
  const latest = useRef({ request, setup, operations, requestToolpath })
  latest.current = { request, setup, operations, requestToolpath }

  const cancel = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setStatus((current) => (current === 'running' ? 'idle' : current))
    setProgress(null)
  }, [])

  const run = useCallback(() => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const { request: ran, setup: ranSetup, operations: setupOps, requestToolpath: acquire } = latest.current
    const covered = verifyOperations(ran.project, setupOps, ran.uptoOperationId)
    setStatus('running')
    setProgress({ done: 0, total: covered.length + 1 })
    void (async () => {
      try {
        const entries = await Promise.all(covered.map(async (operation) => (
          [operation.id, await acquire(operation.id, 'simulation', controller.signal)] as const
        )))
        if (controller.signal.aborted) return
        const toolpaths = new Map<string, ToolpathResult>()
        for (const [id, toolpath] of entries) if (toolpath) toolpaths.set(id, toolpath)
        const finished = await runVerification({
          request: ran,
          setup: ranSetup,
          operations: covered,
          toolpaths,
          definition: getActiveMachineDefinition(ran.project),
        }, {
          signal: controller.signal,
          onProgress: (done, total) => { if (!controller.signal.aborted) setProgress({ done, total }) },
        })
        if (finished === null || controller.signal.aborted) return
        setResult(finished)
        setStatus('done')
      } catch (error) {
        if (controller.signal.aborted) return
        console.error('Verification failed.', error)
        setStatus('failed')
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null
          setProgress(null)
        }
      }
    })()
  }, [])

  const setActive = useCallback((next: boolean) => {
    if (!next) cancel()
    setActiveState(next)
  }, [cancel])

  useEffect(() => () => controllerRef.current?.abort(), [])

  const staleness = result ? verifyStaleness(result.request, request) : null
  const uptoOperationName = uptoOperationId === null
    ? null
    : operations.find((operation) => operation.id === uptoOperationId)?.name ?? null
  const scope = useMemo(() => ({ setupName: setup.name, uptoOperationName }), [setup.name, uptoOperationName])
  return { active, setActive, comparison, setComparison, status, progress, result, staleness, scope, run, cancel }
}
