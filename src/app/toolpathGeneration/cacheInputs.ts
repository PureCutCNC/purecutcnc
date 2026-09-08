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
 * The toolpath cache's input stamp and validity predicate (issue #675).
 *
 * Extracted **mechanically** from `useToolpathGeneration`: the dependency
 * policy, the field classifications and the spatial narrowing are the ones that
 * shipped, unchanged. `isCacheHit` and `ToolpathCacheEntry` are now thin
 * wrappers over what is here, so the existing cache tests keep testing the
 * production rules through their original names.
 *
 * The reason it moved at all: once generation is asynchronous there are jobs in
 * flight with inputs but no result yet, and their validity has to be checkable
 * without inventing a result to hang the check on. Splitting the stamp from the
 * entry is what allows that.
 *
 * **This layer stays on the main thread.** Validity is decided by *reference
 * identity* on `stock`, `tabs`, `clamps`, `tools` and `project` — immutable
 * updates share structure, so identity is what makes an unrelated edit cheap to
 * dismiss. A structured clone of a project has all-new identities, so a cloned
 * object can never be the baseline a later comparison is made against. The
 * worker returns moves; it never returns the thing the cache remembers.
 */

import {
  diffToolpathInputs,
  operationAffectedByChange,
  operationFootprint,
  type OperationFootprint,
} from '../../engine/toolpaths'
import type { ToolpathResult } from '../../engine/toolpaths'
import type { Clamp, Operation, Project, Stock, Tab, Tool } from '../../types/project'
import { projectsEqual } from '../../store/helpers/normalize'

/**
 * Everything a generated result depends on, captured from the snapshot it was
 * generated from. No result — that is what lets a pending job carry one.
 */
export interface ToolpathCacheInputs {
  operation: Operation
  stock: Stock
  /** The project snapshot these inputs were captured from (issue #518). */
  project: Project
  /**
   * The world-XY region a feature change must reach to invalidate this entry
   * (issue #518, S3b). Computed from the same `project` snapshot the result was
   * generated from, so the two can never disagree.
   */
  footprint: OperationFootprint
  tools: Tool[]
  tabs: Tab[]
  clamps: Clamp[]
}

/** Captured inputs plus the result they produced. */
export interface ToolpathCacheEntry extends ToolpathCacheInputs {
  result: ToolpathResult
}

// Compare only fields that affect toolpath geometry. Excluded (display-only):
//   name, enabled, showToolpath
// Any new computation-relevant field added to Operation must be listed here.
export function operationComputationEquals(a: Operation, b: Operation): boolean {
  if (a === b) return true
  return (
    a.kind === b.kind
    && a.pass === b.pass
    && a.target === b.target
    && a.toolRef === b.toolRef
    && a.stepdown === b.stepdown
    && a.stepover === b.stepover
    && a.feed === b.feed
    && a.plungeFeed === b.plungeFeed
    && a.rpm === b.rpm
    && a.pocketPattern === b.pocketPattern
    && a.pocketAngle === b.pocketAngle
    && a.edgeStrategy === b.edgeStrategy
    && a.carveStrategy === b.carveStrategy
    && a.trochoidalCutWidth === b.trochoidalCutWidth
    && a.trochoidalAdvance === b.trochoidalAdvance
    && a.entryStrategy === b.entryStrategy
    && a.entryRampAngle === b.entryRampAngle
    && a.entryHelixDiameterPercent === b.entryHelixDiameterPercent
    && a.xyLeadStrategy === b.xyLeadStrategy
    && a.pocketSlotFeedPercent === b.pocketSlotFeedPercent
    && a.pocketFeedReduction === b.pocketFeedReduction
    && a.roundOutsideCorners === b.roundOutsideCorners
    && a.roundLinkCorners === b.roundLinkCorners
    && a.cleanWallCorners === b.cleanWallCorners
    && a.cornerRelief === b.cornerRelief
    && a.stockToLeaveRadial === b.stockToLeaveRadial
    && a.stockToLeaveAxial === b.stockToLeaveAxial
    && a.finishWalls === b.finishWalls
    && a.finishFloor === b.finishFloor
    && a.carveDepth === b.carveDepth
    && a.maxCarveDepth === b.maxCarveDepth
    && a.cutDirection === b.cutDirection
    && a.machiningOrder === b.machiningOrder
    && a.drillType === b.drillType
    && a.peckDepth === b.peckDepth
    && a.dwellTime === b.dwellTime
    && a.countersinkDiameter === b.countersinkDiameter
    && a.retractHeight === b.retractHeight
    && a.debugToolpath === b.debugToolpath
    && a.debugShowRejectedCorners === b.debugShowRejectedCorners
    && a.finishSlopeMin === b.finishSlopeMin
    && a.finishSlopeMax === b.finishSlopeMax
    && a.finishScallopHeight === b.finishScallopHeight
    && a.waterlineAdaptiveRefinement === b.waterlineAdaptiveRefinement
    && a.waterlineMicroStepover === b.waterlineMicroStepover
    && a.waterlineRefinementThreshold === b.waterlineRefinementThreshold
    && a.waterlineMaxRingsPerBand === b.waterlineMaxRingsPerBand
    && a.waterlineTipStepdown === b.waterlineTipStepdown
  )
}

/**
 * Capture the inputs an operation is about to be generated from.
 *
 * Called at *submission* time with the main-thread project, so the stamp
 * describes the inputs the job actually ran on — not whatever happens to be
 * current when it finishes.
 */
export function captureCacheInputs(project: Project, operation: Operation): ToolpathCacheInputs {
  return {
    operation,
    stock: project.stock,
    project,
    footprint: operationFootprint(project, operation),
    tools: project.tools,
    tabs: project.tabs,
    clamps: project.clamps,
  }
}

/**
 * Are these captured inputs still valid for `operation` in `project`?
 *
 * The rules are unchanged from the shipped `isCacheHit`; only their home moved.
 */
export function cacheInputsValid(
  inputs: ToolpathCacheInputs,
  operation: Operation,
  project: Project,
): boolean {
  if (
    !operationComputationEquals(inputs.operation, operation)
    || inputs.stock !== project.stock
    || inputs.tabs !== project.tabs
    || inputs.clamps !== project.clamps
  ) {
    return false
  }

  // Tools are narrowed to the operation's own tool (issue #518, S5): every
  // engine read is `project.tools.find(t => t.id === operation.toolRef)` —
  // clamps.ts, carving.ts, drilling.ts, edge.ts, pocket.ts, geometry.ts, and
  // four more — and no call site reads any other tool, so importing, editing,
  // or deleting an unrelated tool cannot change this operation's output.
  // Keep the whole-array identity fast path; a changed array compares only
  // the operation's tool row, identity-first with a deep-equal fallback.
  // Missing on either side counts as changed: unknown means invalidate.
  //
  // `tabs` and `clamps` deliberately stay whole-array identity: tab reads are
  // not all spatially filtered (modelProtection.ts iterates every tab;
  // edge.ts passes `project.tabs` wholesale for trochoidal), so narrowing
  // them needs its own footprint argument and is out of scope here.
  if (inputs.tools !== project.tools) {
    const before = inputs.tools.find((tool) => tool.id === operation.toolRef) ?? null
    const after = project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    if (before !== after && (!before || !after || !projectsEqual(before, after))) return false
  }

  // The stamp holds the full project snapshot it was captured from. Holding one
  // `Project` reference per entry is bounded — at most one per operation — and
  // immutable updates share structure, so this is not a leak. When the
  // snapshot's identity still matches, skip the O(n) diff below.
  if (inputs.project === project) return true

  // Each entry diffs against its **own** snapshot, not a single global
  // "changed since last render" set: operations are generated at different
  // times, so one entry may be several edits older than another and a shared
  // set would be wrong for the stale one. Display-only instance changes
  // (visible, locked, folderId) produce an empty diff and stop invalidating.
  // Whether a geometry change invalidates is decided by the footprint
  // consult below.
  const diff = diffToolpathInputs(inputs.project, project)
  if (diff.invalidatesEveryOperation) return false
  if (diff.changedFeatureIds.size === 0) return true
  // Spatial narrowing (issue #518, S3b): a changed feature invalidates this
  // entry only when the change reaches the footprint recorded on it. The
  // footprint was computed from `inputs.project` — the same snapshot the
  // result was generated from — so the two can never disagree, and an
  // unknown footprint invalidates by construction (`bounds === null`).
  return !operationAffectedByChange(inputs.footprint, inputs.project, project, diff.changedFeatureIds)
}
