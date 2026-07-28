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

import type { ToolpathMoveKind } from './types'

/** Move kinds that carry a feed. Rapids are positioning moves and have none. */
export type FedMoveKind = Exclude<ToolpathMoveKind, 'rapid'>

/**
 * Compute the effective feed rate for a toolpath move.
 *
 * Plunge moves return `plungeFeed` unchanged (feedScale never applies).
 * Cut, lead-in, and lead-out moves return `cutFeed` multiplied by
 * `feedScale` (defaulting to 1 when absent).
 *
 * `'rapid'` is excluded at the type level rather than by convention: a rapid
 * has no feed, and falling through to the cut branch would hand a real cutting
 * feed to a positioning move. Callers must branch on rapid before calling.
 *
 * All four sites that apply feedScale share this single entry point:
 * the postprocessor, booklet time estimator, simulation playback ratio,
 * and the simulation viewport live-feed readout.
 */
export function effectiveFeed(
  moveKind: FedMoveKind,
  feedScale: number | undefined,
  cutFeed: number,
  plungeFeed: number,
): number {
  if (moveKind === 'plunge') {
    return plungeFeed
  }
  return cutFeed * (feedScale ?? 1)
}