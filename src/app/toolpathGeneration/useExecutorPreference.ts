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
 * The execution backend generation will use (issue #1102 slice D1).
 *
 * There is no user-facing choice any more: the gear always runs generation on
 * the worker when the runtime has one, and the service's own automatic fallback
 * to the main thread is what covers a worker that fails to start. The stored
 * value is still read and written, because a development build honours it — the
 * e2e parity spec needs a way to force the main thread.
 */

import { useMemo } from 'react'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import {
  DEFAULT_EXECUTOR_KIND,
  EXECUTOR_PREFERENCE_STORAGE_KEY,
  effectiveExecutorKind,
  parseExecutorPreference,
  serializeExecutorPreference,
  workerBackendAvailable,
} from './executorPreference'
import type { ExecutorKind } from './types'

export interface ExecutorPreferenceBinding {
  /** What generation will actually use. */
  resolved: ExecutorKind
  /** True when the resolved backend can interrupt work already running. */
  canStop: boolean
}

export function useExecutorPreference(): ExecutorPreferenceBinding {
  // Kept for its dev-only meaning (see executorPreference.ts): production
  // ignores the stored value, but reading and writing it keeps the parity
  // seam working, including writing the shipped default on a fresh profile.
  const [stored] = useLocalStorageState<ExecutorKind>(
    EXECUTOR_PREFERENCE_STORAGE_KEY,
    DEFAULT_EXECUTOR_KIND,
    {
      codec: {
        serialize: serializeExecutorPreference,
        deserialize: parseExecutorPreference,
      },
    },
  )

  const workerAvailable = workerBackendAvailable()
  const resolved = useMemo(
    () => effectiveExecutorKind(stored, workerAvailable, import.meta.env.DEV),
    [stored, workerAvailable],
  )

  return {
    resolved,
    // Only the worker backend can be stopped mid-operation. Reported from the
    // resolved kind, not the stored one, so a fallback cannot leave the UI
    // offering a Stop that does nothing.
    canStop: resolved === 'worker',
  }
}
