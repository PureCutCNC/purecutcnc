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
 * The stored execution-backend preference, resolved against what this runtime
 * can actually do (issue #675, slice 4).
 *
 * Keeps two values distinct on purpose. `preference` is what the user chose and
 * what the menu shows; `resolved` is what generation will really use. They
 * differ when a stored `worker` preference is loaded somewhere without Workers
 * — the choice is remembered for when it can be honoured, while generation
 * quietly falls back rather than breaking.
 */

import { useMemo } from 'react'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import {
  DEFAULT_EXECUTOR_KIND,
  EXECUTOR_PREFERENCE_STORAGE_KEY,
  parseExecutorPreference,
  resolveExecutorKind,
  serializeExecutorPreference,
  workerBackendAvailable,
} from './executorPreference'
import type { ExecutorKind } from './types'

export interface ExecutorPreferenceBinding {
  /** What the user chose. Shown in the menu. */
  preference: ExecutorKind
  setPreference: (kind: ExecutorKind) => void
  /** What generation will actually use. */
  resolved: ExecutorKind
  workerAvailable: boolean
  /** True when the resolved backend can interrupt work already running. */
  canStop: boolean
}

export function useExecutorPreference(): ExecutorPreferenceBinding {
  const [preference, setPreference] = useLocalStorageState<ExecutorKind>(
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
    () => resolveExecutorKind(preference, workerAvailable),
    [preference, workerAvailable],
  )

  return {
    preference,
    setPreference,
    resolved,
    workerAvailable,
    // Only the worker backend can be stopped mid-operation. Reported from the
    // resolved kind, not the preference, so a fallback cannot leave the UI
    // offering a Stop that does nothing.
    canStop: resolved === 'worker',
  }
}
