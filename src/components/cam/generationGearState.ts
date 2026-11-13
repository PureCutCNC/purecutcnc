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
 * What the generation gear shows, kept pure so each rule is testable on its own
 * (issue #1102 slice D1).
 *
 * The gear is the only place a stopped pipeline or a renderer that fell back to
 * Canvas can be noticed, because a menu hides what is inside it. That makes
 * these two predicates load-bearing: a truthy answer must never depend on the
 * menu being open, and a fallback must not be mistaken for a failure.
 */

import type { ToolpathRendererStatus } from '../canvas/toolpathRendererPreference'

export interface GearFlagState {
  /** Generation is paused by the user. */
  paused: boolean
  /** An operation failed, or the executor itself did. */
  failed: boolean
  /** The worker could not start, so this session runs on the main thread. */
  workerFallback: boolean
  /** The GPU could not start, so toolpaths draw with Canvas. */
  rendererFallback: boolean
}

/**
 * Mark the gear when something inside it needs attention.
 *
 * The two fallbacks keep working and are therefore notices, not failures — but
 * they are the reason the Display section exists, so the gear marks itself for
 * them exactly as it does for a pause or a failure.
 */
export function gearFlagged({ paused, failed, workerFallback, rendererFallback }: GearFlagState): boolean {
  return paused || failed || workerFallback || rendererFallback
}

/** The one renderer status that earns a line of its own in the Display section. */
export type RendererNotice = 'loading' | 'fallback' | null

/**
 * Loading and fallback are the only renderer states that need saying out loud:
 * `gpu` and `canvas` are already carried by the selected button.
 */
export function rendererNotice(status: ToolpathRendererStatus | null): RendererNotice {
  return status === 'loading' || status === 'fallback' ? status : null
}
