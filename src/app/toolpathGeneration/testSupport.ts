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

/** Minimal fixtures for the service suites. No geometry: these tests are about scheduling. */

import { newProject, type Operation, type Project } from '../../types/project'
import type { ToolpathResult } from '../../engine/toolpaths'
import { createToolpathGenerationService, type GenerationContext, type ToolpathGenerationService } from './service'
import type { ExecutorRequest, GenerationExecutor } from './executor'
import type { GenerationOutcome } from './types'

export type { GenerationOutcome } from './types'
export type { ToolpathResult }

export function makeOperation(id: string): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: [id] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
}

/**
 * Operations are swapped onto a single shared base project, so every field the
 * cache compares by identity — stock, tools, tabs, clamps — stays identical
 * across contexts unless a test changes it deliberately.
 */
const BASE: Project = newProject('service-test', 'mm')

export function projectWith(operations: Operation[]): Project {
  return { ...BASE, operations }
}

export function makeResult(operationId: string, moveCount: number): ToolpathResult {
  return {
    operationId,
    moves: Array.from({ length: moveCount }, () => ({
      kind: 'cut' as const,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 1, y: 0, z: 0 },
    })),
    warnings: [],
    bounds: null,
  }
}

export interface CountingServiceHarness {
  service: ToolpathGenerationService
  setContext: (context: GenerationContext) => void
  context: () => GenerationContext
  /** Operation ids in the order the executor was asked for them. */
  order: string[]
  calls: () => number
  /** Run the microtask queue so service continuations land before assertions. */
  settle: () => Promise<void>
}

/**
 * A service whose executor counts its calls and answers immediately.
 *
 * Shared by the cache-invalidation and scheduling suites, which both need "how
 * many times was this actually computed" and would otherwise keep two copies of
 * the same harness in step by hand.
 */
export function makeCountingService(
  initial: GenerationContext,
  resultFor: (operationId: string) => ToolpathResult = (id) => makeResult(id, 1),
): CountingServiceHarness {
  let current = initial
  const order: string[] = []
  const service = createToolpathGenerationService({
    getCurrentContext: () => current,
    createExecutor: (_kind, epoch): GenerationExecutor => ({
      kind: 'inline',
      epoch,
      supportsHardCancellation: false,
      run: (request: ExecutorRequest): Promise<GenerationOutcome> => {
        order.push(request.identity.operationId)
        return Promise.resolve({
          status: 'completed',
          result: resultFor(request.identity.operationId),
          raw: null,
        })
      },
      terminate: () => {},
      dispose: () => {},
    }),
  })
  return {
    service,
    setContext: (context) => { current = context },
    context: () => current,
    order,
    calls: () => order.length,
    settle: async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() },
  }
}
