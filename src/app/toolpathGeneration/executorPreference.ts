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
 * Which execution backend generation uses (issue #675, slice 4).
 *
 * **There is no backend choice since issue #1102 slice D1.** Generation always
 * runs on the worker when the runtime has one, and falls back to the main
 * thread automatically — first by the availability check below, and, if the
 * worker fails while starting, by the service switching this session to the
 * main thread and reporting it. That automatic fallback is unchanged.
 *
 * **The storage key and its codec survive for one reason: development.** A
 * development build still honours a stored `inline`, which is how the e2e
 * parity spec forces the main thread so it has something to compare the worker
 * against. In production the stored value is ignored, so a user who stored
 * `inline` in an older build gets the worker.
 *
 * **Local, and deliberately not part of the document.** It is not in `.camj`,
 * not in undo history, and not in the project store. Where a toolpath was
 * computed cannot change what it is — that is the whole claim the parity corpus
 * exists to defend — so a project carrying a backend choice would be a project
 * carrying something that must not matter.
 */

import type { ExecutorKind } from './types'

export const EXECUTOR_PREFERENCE_STORAGE_KEY = 'purecut.generation.executor'

/**
 * The stored default for a profile that has never chosen, and the value a
 * development build honours besides a stored `inline`.
 */
export const DEFAULT_EXECUTOR_KIND: ExecutorKind = 'worker'

/**
 * Read a stored value, falling back to the default for anything unrecognised.
 *
 * A stored preference is user-controlled text that can also be older than the
 * code reading it. Falling back rather than throwing means a corrupt or
 * retired value costs a setting, not a working application — and specifically
 * cannot wedge someone into a backend that is failing for them.
 */
export function parseExecutorPreference(raw: string | null): ExecutorKind {
  if (raw === 'worker' || raw === 'inline') return raw
  return DEFAULT_EXECUTOR_KIND
}

export function serializeExecutorPreference(kind: ExecutorKind): string {
  return kind
}

/**
 * Is the worker backend usable in this runtime at all?
 *
 * A build can be loaded where `Worker` or module workers are unavailable — an
 * old embedded webview, a locked-down environment. Offering a choice that
 * cannot work is worse than not offering it, so this decides between the worker
 * and the main thread before generation starts.
 */
export function workerBackendAvailable(scope: { Worker?: unknown } = globalThis): boolean {
  return typeof scope.Worker === 'function'
}

/**
 * The backend generation actually uses.
 *
 * Production ignores the stored value entirely: `worker` when the runtime has
 * one, `inline` when it does not. Development still honours a stored `inline`
 * so the parity spec can force the main thread; everything else there resolves
 * the same way production does.
 */
export function effectiveExecutorKind(
  stored: ExecutorKind,
  workerAvailable: boolean = workerBackendAvailable(),
  development: boolean = false,
): ExecutorKind {
  if (!workerAvailable) return 'inline'
  if (development && stored === 'inline') return 'inline'
  return 'worker'
}
