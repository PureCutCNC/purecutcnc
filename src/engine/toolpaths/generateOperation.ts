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

import { isRotaryOperationKind } from '../../types/project'
import { generateRotaryOperation } from './rotaryOperation'
import { generatePlasmaProfileToolpath, plasmaSetupIsTop } from './plasma'

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
import { formatLength } from '../../utils/units'
import type { Units } from '../../utils/units'
import { projectInSetupFrame, toolpathInStockFrame } from '../setupFrameProject'
import {
  aroundFrameForOperation,
  aroundMaterialBands,
  flatFaceProject,
  unrolledProject,
  wrapToolpath,
} from '../aroundFrame'
import type { AroundMaterialBands } from '../aroundFrame'
import { setupFrameForOperation } from '../setupOrientation'
import { operationFace, setupGenerationBlock, withoutUnreachableSubtracts } from '../setupTargets'
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

/**
 * The warning for a square blank's unsupported setup (#1016 C2-S4). Its own
 * refusals are errors, so they block a save; the round/flat mismatch above
 * keeps its historical warning severity.
 *
 * When the physical workholding guard is what refused, the verdict's reason is
 * carried into the block (`SetupGenerationBlock.refusal`) and the message names
 * the actual problem rather than saying the setup "cannot cut it". Lengths are
 * formatted in the project's units. Anything else — a wrapped 2D path, a
 * non-model target, an unreadable blank or a stale cutter — keeps the generic
 * code as the fallback (#1016 C2 F3).
 */
function squareRotaryBlockWarning(
  block: SetupGenerationBlock,
  operation: Operation,
  units: Units,
): ToolpathWarning {
  const refusal = block.refusal
  const diameter = refusal?.diameter
  const required = refusal?.required
  if (refusal?.reason === 'workholdingDiameter'
    && typeof diameter === 'number' && Number.isFinite(diameter)
    && typeof required === 'number' && Number.isFinite(required)) {
    return {
      code: 'workholdingDiameter',
      params: {
        operation: operation.name,
        clamp: refusal.clampName,
        diameter: formatLength(diameter, units),
        required: formatLength(required, units),
      },
    }
  }
  if (refusal?.reason === 'workholdingPlacement') {
    return { code: 'workholdingPlacement', params: { operation: operation.name, clamp: refusal.clampName } }
  }
  if (refusal?.reason === 'ordinaryClampOverlap') {
    return { code: 'ordinaryClampOverlap', params: { operation: operation.name, clamp: refusal.clampName } }
  }
  return { code: 'postSetupOperationRefused', params: { operation: operation.name } }
}

function setupBlockWarning(block: SetupGenerationBlock, operation: Operation, units: Units): ToolpathWarning {
  if (block.reason === 'aroundStockMismatch') return { code: 'aroundStockMismatch', params: { operation: operation.name } }
  if (block.reason === 'squareRotaryUnsupported') return squareRotaryBlockWarning(block, operation, units)
  if (block.reason === 'aroundCentreline') return { code: 'aroundCentreline', params: { operation: operation.name, feature: block.features.map((feature) => feature.featureName).join(', ') } }
  return { code: 'setupTargetNotThrough', params: { features: block.features.map((feature) => feature.featureName).join(', ') } }
}

/**
 * True when a **cutting** move of a flat Around toolpath reaches the bar's
 * centreline (issue #395). Around flat heights are lowered by the radius, so
 * the centreline is flat zero; a cut at or below it would pass through the
 * middle of the bar. Rapids are exempt — they travel above the work.
 */
function reachesCentreline(result: ToolpathResult): boolean {
  return result.moves.some((move) => move.kind !== 'rapid' && Math.min(move.from.z, move.to.z) <= 0)
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
 * in. A Top operation in a project with no Around feature takes the path it
 * always did: the project and the result are passed through untouched, not
 * copied. A flat face and Around exchange nothing (issue #395): an operation
 * that is not in an Around setup is generated without the project's Around
 * features, which belong to the bar's unrolled sheet.
 */
export function computeOperationToolpath(
  project: Project,
  operation: Operation,
  options: ComputeOperationOptions = {},
): OperationToolpathEnvelope | null {
  // Plasma is Top-only: diagnose its original setup before target checks or
  // the Bottom transform, which makes every setup top-down for milling.
  if (operation.kind === 'plasma_profile' && !plasmaSetupIsTop(project, operation)) {
    return computeTopDownToolpath(flatFaceProject(project), operation, options)
  }

  // An operation its setup may not cut produces no motion, and says why.
  const block = setupGenerationBlock(project, operation)
  if (block) {
    return {
      result: { operationId: operation.id, moves: [], warnings: [setupBlockWarning(block, operation, project.meta.units)], bounds: null },
      raw: null,
    }
  }

  if (isRotaryOperationKind(operation.kind)) {
    return { result: generateRotaryOperation(project, operation), raw: null }
  }

  // The face this operation is cut from, read in stock space before anything
  // is turned, and the one gate that keeps every resolver below from reading
  // work authored on the other face as if this setup could reach it (#1079).
  const face = operationFace(project, operation)

  const around = aroundFrameForOperation(project, operation)
  if (around) {
    // What stands on the sheet, for the Follow line's keep-out (issue #1112
    // rt6-e). Computed from the real project, before the unroll drops the
    // models it is made of, and in the unrolled frame the generator reads.
    const materials = operation.kind === 'follow_line' ? aroundMaterialBands(project, around) : undefined
    const envelope = computeTopDownToolpath(
      withoutUnreachableSubtracts(unrolledProject(project, around), face),
      operation,
      options,
      materials,
    )
    if (!envelope) return null
    // A depth the operation works out itself — an Engrave's carve depth, a
    // countersink's derived plunge — can reach the centreline although the
    // target is stored short of it. Refuse rather than cut the bar through.
    if (reachesCentreline(envelope.result)) {
      return {
        result: {
          operationId: operation.id,
          moves: [],
          warnings: [{ code: 'aroundCutReachesCentreline', params: { operation: operation.name } }],
          bounds: null,
        },
        raw: null,
      }
    }
    return {
      result: wrapToolpath(envelope.result, around),
      raw: envelope.raw ? wrapToolpath(envelope.raw, around) : null,
    }
  }

  const frame = setupFrameForOperation(project, operation)
  const flat = flatFaceProject(project)
  if (!frame) {
    return computeTopDownToolpath(withoutUnreachableSubtracts(flat, face), operation, options)
  }

  const envelope = computeTopDownToolpath(
    withoutUnreachableSubtracts(projectInSetupFrame(flat, frame), face),
    operation,
    options,
  )
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
  /** Around only: the material standing on the unrolled sheet, see the call site. */
  materials?: AroundMaterialBands,
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
    result = applyClampWarnings(project, optimizeAndCapture(generateFollowLineToolpath(project, operation, materials)), operation)
  } else if (operation.kind === 'drilling') {
    result = applyClampWarnings(project, optimizeAndCapture(generateDrillingToolpath(project, operation)), operation)
  }

  if (!result) return null
  return { result, raw }
}
