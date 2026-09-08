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
 * The one synchronous entry point into toolpath generation (issue #675).
 *
 * Every backend calls exactly this function: the inline executor on the main
 * thread today, and the worker executor in its own thread. Anything that lives
 * here therefore runs identically in both, and anything that does not — the
 * cache, scheduling, React state — stays on the main thread by construction.
 *
 * Two constraints hold for the whole module and must survive any edit:
 *
 * - **DOM-free and framework-free.** No `window`, no `document`, no React, no
 *   project-store singleton. The worker has none of them.
 * - **Synchronous and pure.** Generators are pure computation over
 *   `(project, operation)`. No Promises, no cooperative yields, no timing
 *   dependence — a generator that behaved differently under a worker would
 *   make the parity corpus meaningless.
 *
 * The per-kind chains below were moved here verbatim from
 * `useToolpathGeneration`. Their differences are deliberate and load-bearing;
 * each one carries the comment that explains it. Do not "tidy" them into a
 * shared sequence — `generateOperationParity.test.ts` asserts the exact
 * pre-extraction output of all of them.
 */

import { applyClampWarnings } from './clamps'
import { applyEdgeRouteTabs, applyTabsToEdgeRoute, applyTabWarnings } from './tabs'
import { optimizeLinearMoves } from './linearMoveOptimization'
import { generateDrillingToolpath } from './drilling'
import { generateEdgeRouteToolpath } from './edge'
import { generateFinishSurfaceCleanupToolpath } from './finishSurfaceCleanup'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { generateFollowLineToolpath } from './carving'
import { generatePocketToolpath } from './pocket'
import { generateRoughSurfaceToolpath } from './roughSurface'
import { generateSurfaceCleanToolpath } from './surface'
import { generateVCarveMedialToolpath } from './vcarveMedial'
import { generateVCarveToolpath } from './vcarve'
import type { ToolpathResult } from './types'
import type { Operation, Project } from '../../types/project'

export interface ComputeOperationOptions {
  /**
   * Capture the pre-optimization toolpath alongside the final one (issue
   * #356's "Generated" debug layer).
   *
   * Opt-in rather than always-on: the raw path is a second full copy of the
   * moves, and ordinary preview generation has no use for it. Under the worker
   * backend it would also have to cross the thread boundary, doubling transport
   * for every request, to be thrown away.
   */
  trace?: boolean
}

export interface OperationToolpathEnvelope {
  /**
   * The complete runtime result, exactly as the application consumes it —
   * including whichever `ToolpathResult` subtype the generator returned, with
   * its strategy-specific fields (`stepLevels`, engagement telemetry, drill
   * cycles, collision indices) intact. Never narrowed to a moves/warnings/
   * bounds triple: the subtype fields are what the viewport and postprocessor
   * read.
   */
  result: ToolpathResult
  /** The pre-optimization result; `null` unless `trace` was requested. */
  raw: ToolpathResult | null
}

/**
 * Generate one operation's toolpath, post-processing included.
 *
 * Returns `null` for an operation kind this dispatch does not handle, which is
 * how the caller distinguishes "nothing to generate" from a generated empty
 * path. An empty path with warnings is a *successful* result and comes back as
 * a normal envelope — infrastructure failures must never be encoded that way.
 */
export function computeOperationToolpath(
  project: Project,
  operation: Operation,
  options: ComputeOperationOptions = {},
): OperationToolpathEnvelope | null {
  let raw: ToolpathResult | null = null

  // The optimization seam (issue #356): the always-on linear-move merge, with
  // the pre-merge path captured on the way through when a trace was asked for.
  const optimizeAndCapture = (generated: ToolpathResult): ToolpathResult => {
    if (options.trace) raw = generated
    return optimizeLinearMoves(generated)
  }

  let result: ToolpathResult | null = null

  if (operation.kind === 'pocket') {
    result = applyClampWarnings(project, optimizeAndCapture(applyTabWarnings(project, operation, generatePocketToolpath(project, operation))), operation)
  } else if (operation.kind === 'v_carve') {
    result = applyClampWarnings(project, optimizeAndCapture(generateVCarveToolpath(project, operation)), operation)
  } else if (operation.kind === 'v_carve_medial') {
    result = applyClampWarnings(project, optimizeAndCapture(generateVCarveMedialToolpath(project, operation)), operation)
  } else if (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside') {
    // Warnings first: applyTabWarnings judges each tab against the cut Z range, and
    // applyTabsToEdgeRoute raises that range to the tab tops. Run it on the adjusted
    // moves and every applied tab reports as lying outside the range it just created.
    const warned = applyTabWarnings(project, operation, generateEdgeRouteToolpath(project, operation))
    // applyEdgeRouteTabs, not applyTabsToEdgeRoute: trochoidal roughing owns
    // its own tab motion and must not be tabbed twice. See its docstring.
    result = applyClampWarnings(project, optimizeAndCapture(applyEdgeRouteTabs(project, operation, warned)), operation)
  } else if (operation.kind === 'surface_clean') {
    result = applyClampWarnings(project, optimizeAndCapture(applyTabWarnings(project, operation, generateSurfaceCleanToolpath(project, operation))), operation)
  } else if (operation.kind === 'rough_surface') {
    result = applyClampWarnings(project, optimizeAndCapture(applyTabWarnings(project, operation, generateRoughSurfaceToolpath(project, operation))), operation)
  } else if (operation.kind === 'finish_surface') {
    const warned = applyTabWarnings(project, operation, generateFinishSurfaceToolpath(project, operation))
    result = applyClampWarnings(project, optimizeAndCapture(applyTabsToEdgeRoute(project, operation, warned)), operation)
  } else if (operation.kind === 'finish_surface_cleanup') {
    const warned = applyTabWarnings(project, operation, generateFinishSurfaceCleanupToolpath(project, operation))
    result = applyClampWarnings(project, optimizeAndCapture(applyTabsToEdgeRoute(project, operation, warned)), operation)
  } else if (operation.kind === 'follow_line') {
    result = applyClampWarnings(project, optimizeAndCapture(generateFollowLineToolpath(project, operation)), operation)
  } else if (operation.kind === 'drilling') {
    result = applyClampWarnings(project, optimizeAndCapture(generateDrillingToolpath(project, operation)), operation)
  }

  if (!result) return null
  return { result, raw }
}
