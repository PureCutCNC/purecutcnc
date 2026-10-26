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
  foldsNonTargetSubtracts,
  operationAffectedByChange,
  operationFootprint,
  plasmaCutOrderInputs,
  subtractsMachinedElsewhere,
  type OperationFootprint,
} from '../../engine/toolpaths'
import type { ToolpathResult } from '../../engine/toolpaths'
import {
  rotaryPrecedingRoughs,
  type RotaryRoughDependency,
} from '../../engine/toolpaths/rotaryOperation'
import type { Clamp, Operation, Project, SetupOrientation, Stock, Tab, Tool } from '../../types/project'
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
  /**
   * Feature ids machined by *other* enabled operations (issue #749).
   *
   * `discoverNonTargetSubtracts` folds a non-target subtract into the region
   * only when nothing else machines it, so another operation's target list and
   * enabled flag are inputs to this operation's geometry. Nothing else in this
   * stamp captures them: `diffToolpathInputs` diffs features and never reads
   * `project.operations`, and the checks above compare only this operation's
   * own row.
   */
  machinedElsewhere: ReadonlySet<string>
  /**
   * How the operation's setup turns the stock (issue #946), or null for an
   * operation without a setup.
   *
   * The operation row only names its setup. The turn lives on the setup, and
   * changing a Bottom setup's flip axis keeps its id — so `setupId` comparing
   * equal says nothing about whether the path was generated in the frame the
   * setup has now.
   */
  setupOrientation: (SetupOrientation & { kind?: 'around' }) | null
  /**
   * The rotary finish's preceding-rough dependency (issue #1045).
   *
   * `rotaryFinishWithoutRough` reads every enabled `rotary_rough` before the
   * finish in the setup and the STL models each one targets, so enabling,
   * disabling, adding, removing, reordering or moving a rough changes the
   * finish's advisory without moving a feature. Empty for every other
   * operation kind: they never read it, and comparing it for them would
   * invalidate on unrelated operation edits.
   */
  rotaryPrecedingRoughs: readonly RotaryRoughDependency[]
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
    && a.plasmaSide === b.plasmaSide
    && a.plasmaReverseDirection === b.plasmaReverseDirection
    && a.plasmaLeadIn === b.plasmaLeadIn
    && a.plasmaLeadInLength === b.plasmaLeadInLength
    && a.plasmaLeadOut === b.plasmaLeadOut
    && a.plasmaLeadOutLength === b.plasmaLeadOutLength
    && projectsEqual(a.plasmaStartPoint ?? null, b.plasmaStartPoint ?? null)
    && projectsEqual(a.plasmaStartPoints ?? null, b.plasmaStartPoints ?? null)
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
    && (a.rotaryChuckSupport ?? 0) === (b.rotaryChuckSupport ?? 0)
    && (a.rotaryTailSupport ?? 0) === (b.rotaryTailSupport ?? 0)
    && (a.rotaryPassDirection ?? 'along') === (b.rotaryPassDirection ?? 'along')
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
    // The setup decides the frame an operation is cut in (issue #944).
    && a.setupId === b.setupId
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

/** The turn of the setup an operation belongs to; null when it names none that exists. */
function operationSetupOrientation(project: Project, operation: Operation): (SetupOrientation & { kind?: 'around' }) | null {
  if (operation.setupId === undefined) return null
  const setup = project.setups?.find((setup) => setup.id === operation.setupId)
  return setup ? { ...setup.orientation, kind: setup.kind } : null
}

function sameOrientation(a: (SetupOrientation & { kind?: 'around' }) | null, b: (SetupOrientation & { kind?: 'around' }) | null): boolean {
  if (a === b) return true
  return a !== null && b !== null && a.axis === b.axis && a.angleDeg === b.angleDeg && a.kind === b.kind
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
    machinedElsewhere: subtractsMachinedElsewhere(project, operation),
    setupOrientation: operationSetupOrientation(project, operation),
    rotaryPrecedingRoughs: rotaryPrecedingRoughs(project, operation),
  }
}

/** Whether two captured preceding-rough dependency lists are the same inputs. */
function sameRotaryPrecedingRoughs(
  before: readonly RotaryRoughDependency[],
  after: readonly RotaryRoughDependency[],
): boolean {
  const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((id, index) => id === right[index])
  // #1096 re-review (P2): the mask is order-sensitive, so the composition
  // order is an advisory input too. Comparing only the sorted include/exclude
  // ids would serve a stale warning after a region is reordered.
  const sameEntries = (
    left: RotaryRoughDependency['regions']['entries'],
    right: RotaryRoughDependency['regions']['entries'],
  ): boolean => left.length === right.length
    && left.every((entry, index) => entry.id === right[index].id && entry.mode === right[index].mode)
  return before.length === after.length && before.every((entry, index) => {
    const other = after[index]
    return entry.setupId === other.setupId
      && sameIds(entry.modelIds, other.modelIds)
      // #1096: a rough's region decides whether it covers the finish, so both
      // of its halves -- include and exclude -- are advisory inputs exactly as
      // the models are (#1096 review, P2).
      && sameIds(entry.regions.includeIds, other.regions.includeIds)
      && sameIds(entry.regions.excludeIds, other.regions.excludeIds)
      && sameEntries(entry.regions.entries, other.regions.entries)
  })
}

/** Ids in exactly one of the two sets — the ownership that gained or lost an owner. */
function symmetricDifference(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): Set<string> {
  const changed = new Set<string>()
  for (const id of before) if (!after.has(id)) changed.add(id)
  for (const id of after) if (!before.has(id)) changed.add(id)
  return changed
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
    // The same setup id, turned another way, is another frame (issue #946).
    || !sameOrientation(inputs.setupOrientation, operationSetupOrientation(project, operation))
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
  // snapshot's identity still matches, skip the O(n) diff below. Operations
  // live on the project, so an identical snapshot also means identical
  // ownership and the check below cannot have anything to say.
  if (inputs.project === project) return true

  // Plasma cut order (issue #958) reads two things no check here covers: the
  // machine origin, where the first cut is chosen from, and what later plasma
  // operations cut, which decides the outline-before-hole warning. Neither
  // moves a feature, so the diff below would pass a stale path. Compared
  // against the entry's own snapshot, so the stamp needs no field of its own.
  if (
    operation.kind === 'plasma_profile'
    && plasmaCutOrderInputs(inputs.project, inputs.operation) !== plasmaCutOrderInputs(project, operation)
  ) {
    return false
  }

  // A rotary finish's missing-rough advisory reads the roughs before it (issue
  // #1045). Placed ahead of the feature diff for the same reason as the
  // ownership check below: an operations-only edit moves no feature, so
  // `changedFeatureIds` is empty and the early return would serve a stale
  // warning. Only a finish has this input; every other kind keeps its cache
  // behaviour unchanged.
  if (
    operation.kind === 'rotary_finish'
    && !sameRotaryPrecedingRoughs(inputs.rotaryPrecedingRoughs, rotaryPrecedingRoughs(project, operation))
  ) {
    return false
  }

  // Ownership: which subtracts *other* operations machine (issue #749).
  //
  // Placed ahead of the feature diff because an ownership change moves no
  // feature — adding an operation leaves `features` untouched — so
  // `changedFeatureIds` is empty and the `size === 0` early return below would
  // pass a now-stale entry.
  //
  // Narrowed twice, or a target edit anywhere would regenerate everything.
  // By kind: `foldsNonTargetSubtracts` is the same policy table the resolver
  // gates on, so an operation that never reads ownership never invalidates on
  // it. Spatially: the ids whose ownership changed are fed to the #518 bbox
  // narrowing, which asks whether they reach this operation's footprint. The
  // feature itself is unmoved, so both snapshots resolve the same bounds and
  // the test reduces to reachability.
  if (foldsNonTargetSubtracts(operation)) {
    const current = subtractsMachinedElsewhere(project, operation)
    const changedOwnership = symmetricDifference(inputs.machinedElsewhere, current)
    if (
      changedOwnership.size > 0
      && operationAffectedByChange(inputs.footprint, inputs.project, project, changedOwnership)
    ) {
      return false
    }
  }

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
