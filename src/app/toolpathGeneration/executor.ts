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
 * The backend seam (issue #675).
 *
 * Both backends run the *same* engine function; they differ only in which
 * thread it runs on and therefore in what can be done to it while it runs. The
 * service is written against this interface so nothing above it has to know
 * which one is installed.
 */

import type { Project } from '../../types/project'
import type {
  ExecutorKind,
  GenerationOutcome,
  GenerationStage,
  RequestIdentity,
} from './types'

export interface ExecutorRequest {
  identity: RequestIdentity
  /**
   * The captured main-thread snapshot to generate from. Held by reference on
   * this side — it is only cloned if the backend actually crosses a thread.
   */
  project: Project
}

export interface GenerationExecutor {
  readonly kind: ExecutorKind
  /** Changes whenever the executor is replaced. Stamped into every identity. */
  readonly epoch: number
  /**
   * True when `terminate()` can actually stop work already in progress.
   *
   * The inline backend cannot: a running generator holds the only thread, so
   * nothing can observe a cancel until it returns on its own. The UI must say
   * so rather than offer a Stop that quietly does nothing.
   */
  readonly supportsHardCancellation: boolean
  /**
   * Run one computation. **Never rejects** — every path resolves to an outcome,
   * so a caller can settle its consumers without a try/catch around the seam.
   */
  run(request: ExecutorRequest, onStage?: (stage: GenerationStage) => void): Promise<GenerationOutcome>
  /**
   * Discard whatever is running. In-flight requests settle as `cancelled`.
   * A worker backend does this by killing the thread; the inline backend can
   * only refuse to install the result it is still computing.
   */
  terminate(): void
  /** Release everything. The executor is unusable afterwards. */
  dispose(): void
}
