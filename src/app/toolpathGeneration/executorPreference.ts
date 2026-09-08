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
 * Which execution backend generation uses, as a machine-local preference
 * (issue #675, slice 4).
 *
 * **Local, and deliberately not part of the document.** It is not in `.camj`,
 * not in undo history, and not in the project store. Where a toolpath was
 * computed cannot change what it is — that is the whole claim the parity corpus
 * exists to defend — so a project carrying a backend choice would be a project
 * carrying something that must not matter. It would also travel: a file saved
 * on a machine where the worker is fine would arrive on one where it is not.
 *
 * The default is `inline`, and stays `inline` until a maintainer's explicit
 * go/no-go on the evidence (slice 5). Shipping the worker as an opt-in that a
 * user chooses is a different risk from shipping it as the path everyone lands
 * on unknowingly.
 */

import type { ExecutorKind } from './types'

export const EXECUTOR_PREFERENCE_STORAGE_KEY = 'purecut.generation.executor'

/**
 * The shipped default.
 *
 * `inline` is what the application did before this work, so a user who never
 * touches the setting gets the behaviour that has been in use all along.
 */
export const DEFAULT_EXECUTOR_KIND: ExecutorKind = 'inline'

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
 * cannot work is worse than not offering it, so the control asks this before
 * rendering the option, and a stored `worker` preference resolves back to
 * `inline` when it is false.
 */
export function workerBackendAvailable(scope: { Worker?: unknown } = globalThis): boolean {
  return typeof scope.Worker === 'function'
}

/** The backend to actually use, given a preference and what the runtime supports. */
export function resolveExecutorKind(
  preference: ExecutorKind,
  available = workerBackendAvailable(),
): ExecutorKind {
  if (preference === 'worker' && !available) return 'inline'
  return preference
}
