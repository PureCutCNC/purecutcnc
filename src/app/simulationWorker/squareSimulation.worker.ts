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
 * Worker entry for a square blank's simulation replay (issue #1016 C2 P2).
 *
 * One job per worker: the client creates it for one simulation input and
 * terminates it on completion, failure and cancellation. The square replay is
 * synchronous and can take a minute, so it never checks a message queue — only
 * `terminate()` can stop it, exactly as with the nesting and STEP workers.
 *
 * The job and its answer are plain data; the answer's typed arrays travel by
 * transfer so the result costs a pointer move rather than a copy. Everything
 * computed here is the shipped `runSquareSimulationJob`, the same function the
 * in-thread fallback runs.
 */

import type { SimulationGrid, SimulationResult } from '../../engine/simulation/types'
import { runSquareSimulationJob, type SquareSimulationJob } from '../simulationCompute'

export type SquareSimulationWorkerRequest = { type: 'run'; job: SquareSimulationJob }

export type SquareSimulationWorkerResponse =
  | { type: 'result'; result: SimulationResult; startingStock: SimulationGrid | null }
  | { type: 'error'; message: string }

/**
 * The worker scope, declared locally rather than adding `"WebWorker"` to
 * `lib`, which would collide with `DOM` across every browser source (the same
 * reason as `toolpath.worker.ts` and `step.worker.ts`).
 */
interface SquareSimulationWorkerScope {
  postMessage(message: SquareSimulationWorkerResponse, transfer?: ArrayBuffer[]): void
  onmessage: ((event: MessageEvent<SquareSimulationWorkerRequest>) => void) | null
}

declare const self: SquareSimulationWorkerScope

/**
 * Runs one job and turns it into the wire message. Exported so the focused
 * test can call the real worker's handler directly, without a browser Worker.
 */
export function handleSquareSimulationMessage(message: SquareSimulationWorkerRequest): SquareSimulationWorkerResponse {
  try {
    const { result, startingStock } = runSquareSimulationJob(message.job)
    return { type: 'result', result, startingStock }
  } catch (error: unknown) {
    return { type: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The typed arrays a result owns, handed over instead of copied. The interval
 * map is plain number arrays and clones; only the heightfields are buffers.
 * Duplicates are dropped because posting the same buffer twice throws.
 */
export function squareSimulationTransfer(response: SquareSimulationWorkerResponse): ArrayBuffer[] {
  if (response.type !== 'result') return []
  const buffers = new Set<ArrayBuffer>()
  const add = (grid: SimulationGrid | null): void => {
    if (!grid) return
    buffers.add(grid.topZ.buffer as ArrayBuffer)
    if (grid.initialTopZ) buffers.add(grid.initialTopZ.buffer as ArrayBuffer)
  }
  add(response.result.grid)
  add(response.startingStock)
  return [...buffers]
}

// Absent under Node, where tests import this module for its handler.
if (typeof self !== 'undefined') {
  self.onmessage = (event) => {
    const response = handleSquareSimulationMessage(event.data)
    self.postMessage(response, squareSimulationTransfer(response))
  }
}
