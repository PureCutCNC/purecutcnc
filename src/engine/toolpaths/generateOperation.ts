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
 * shared sequence — focused engine suites own the behaviour of each one.
 *
 * Machining setups (issue #946) are handled here and nowhere below: an
 * operation in a setup that turns the stock is generated against the project
 * turned into that setup's frame (`projectInSetupFrame`), by the same chains,
 * and its result is carried back into stock space. The chains and the
 * generators under them only ever see a top-down project, so none of them
 * branches on a face.
 */

import { generatePlasmaProfileToolpath } from './plasma'

import { applyClampWarnings } from './clamps'
import { applyEdgeRouteTabs, applyTabsToEdgeRoute, applyTabWarnings } from './tabs'
import { optimizeLinearMoves } from './linearMoveOptimization'
import { generateDrillingToolpath } from './drilling'
import { edgeRouteTargetWalls, generateEdgeRouteToolpath } from './edge'
import { generateFinishSurfaceCleanupToolpath } from './finishSurfaceCleanup'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { generateFollowLineToolpath } from './carving'
import { generatePocketToolpath } from './pocket'
import { generateRoughSurfaceToolpath } from './roughSurface'
import { generateSurfaceCleanToolpath } from './surface'
import { generateVCarveMedialToolpath } from './vcarveMedial'
import { generateVCarveToolpath } from './vcarve'
import type { ToolpathResult } from './types'
import type { ToolpathWarning } from './warningCodes'
import type { Operation, Project } from '../../types/project'
import { projectInSetupFrame, toolpathInStockFrame } from '../setupFrameProject'
import { setupFrameForOperation } from '../setupOrientation'
import { setupGenerationBlock } from '../setupTargets'
import type { SetupGenerationBlock } from '../setupTargets'

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

function setupBlockWarning(block: SetupGenerationBlock): ToolpathWarning {
  return { code: 'setupTargetNotThrough', params: { features: block.features.map((feature) => feature.featureName).join(', ') } }
}

/**
 * Generate one operation's toolpath, post-processing included.
 *
 * Returns `null` for an operation kind this dispatch does not handle, which is
 * how the caller distinguishes "nothing to generate" from a generated empty
 * path. An empty path with warnings is a *successful* result and comes back as
 * a normal envelope — infrastructure failures must never be encoded that way.
 *
 * The result is always in stock space, whichever setup the operation is cut
 * in. A Top operation takes the path it always did: the project and the
 * result are passed through untouched, not copied.
 */
export function computeOperationToolpath(
  project: Project,
  operation: Operation,
  options: ComputeOperationOptions = {},
): OperationToolpathEnvelope | null {
  // An operation its setup may not cut produces no motion, and says why.
  const block = setupGenerationBlock(project, operation)
  if (block) {
    return {
      result: { operationId: operation.id, moves: [], warnings: [setupBlockWarning(block)], bounds: null },
      raw: null,
    }
  }

  const frame = setupFrameForOperation(project, operation)
  if (!frame) return computeTopDownToolpath(project, operation, options)

  const envelope = computeTopDownToolpath(projectInSetupFrame(project, frame), operation, options)
  if (!envelope) return null
  return {
    result: toolpathInStockFrame(envelope.result, frame),
    raw: envelope.raw ? toolpathInStockFrame(envelope.raw, frame) : null,
  }
}

/**
 * The per-kind dispatch, for a project in the conventional top-down frame:
 * the cutter comes down onto the face that is up. A turned setup's project
 * has already been turned into that frame by the time it gets here.
 */
function computeTopDownToolpath(
  project: Project,
  operation: Operation,
  options: ComputeOperationOptions,
): OperationToolpathEnvelope | null {
  let raw: ToolpathResult | null = null

  // The optimization seam (issue #356): the always-on linear-move merge, with
  // the pre-merge path captured on the way through when a trace was asked for.
  const optimizeAndCapture = (generated: ToolpathResult): ToolpathResult => {
    if (options.trace) raw = generated
    return optimizeLinearMoves(generated)
  }

  let result: ToolpathResult | null = null

  if (operation.kind === 'plasma_profile') {
    result = applyClampWarnings(project, optimizeAndCapture(generatePlasmaProfileToolpath(project, operation)), operation)
  } else if (operation.kind === 'pocket') {
    result = applyClampWarnings(project, optimizeAndCapture(applyTabWarnings(project, operation, generatePocketToolpath(project, operation))), operation)
  } else if (operation.kind === 'v_carve') {
    result = applyClampWarnings(project, optimizeAndCapture(generateVCarveToolpath(project, operation)), operation)
  } else if (operation.kind === 'v_carve_medial') {
    result = applyClampWarnings(project, optimizeAndCapture(generateVCarveMedialToolpath(project, operation)), operation)
  } else if (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside') {
    // Warnings first: applyTabWarnings judges each tab against the cut Z range, and
    // applyTabsToEdgeRoute raises that range to the tab tops. Run it on the adjusted
    // moves and every applied tab reports as lying outside the range it just created.
    // Judged against the route's own walls, not its whole cut box (issue #916).
    const warned = applyTabWarnings(
      project,
      operation,
      generateEdgeRouteToolpath(project, operation),
      () => edgeRouteTargetWalls(project, operation),
    )
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
