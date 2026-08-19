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
 * Declared field order and grouping for the CAM operation properties panel
 * (issue #559).
 *
 * Before this table, a control's vertical position was an accident of which
 * `if (kind === …)` branch its JSX happened to be written into, so the same
 * field could render from two places at two different positions, and a new
 * field landed wherever the diff was smallest.
 *
 * Here, position is a property of the field: `OPERATION_FIELDS` is one ordered
 * list, `OPERATION_FIELD_GROUPS` is the order the groups render in, and
 * `CAMPanel` walks them. Adding a control means adding a row here — which
 * *requires* naming its group — and supplying the matching renderer, which the
 * `Record<OperationFieldId, …>` in `CAMPanel` makes a compile-time obligation.
 *
 * This is deliberately not merged into `operationParamRefData.ts`: that table is
 * keyed by reference-diagram kind, and the mapping to fields is one-to-many
 * (`maxDepth` serves both carve-depth fields, `entryRampAngle` serves both the
 * entry and the helical-drilling angle). Field id is the primary key here, and
 * each row carries its `paramRef` so a field's group, order and help icon still
 * live in a single row.
 *
 * Everything in this module is pure — no React, no store — so the ordering and
 * applicability rules are unit-testable on their own (`operationFields.test.ts`).
 */

import type { camEn } from '../../i18n/locales/en/cam'
import type { EntryStrategy, Operation } from '../../types/project'
import { isTrochoidalCarve, isTrochoidalEdgeRoughing } from '../../types/project'
import type { OperationParamRefKind } from './operationParamRefData'

// ── Shared operation predicates ────────────────────────────────────
//
// These are the single spelling of each visibility rule. CAMPanel imports them
// rather than re-deriving them inline, so the registry's applicability and the
// renderer's own conditionals can never drift apart.

/** Stepdown is meaningless where depth is not stepped (V-carve, drilling) or
 *  where the pass cuts full depth in one go (finish edge routes). */
export function showStepdown(operation: Operation): boolean {
  if (
    operation.kind === 'v_carve'
    || operation.kind === 'v_carve_medial'
    || operation.kind === 'drilling'
    || operation.kind === 'finish_surface_cleanup'
  ) {
    return false
  }

  if ((operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside') && operation.pass === 'finish') {
    return false
  }

  return true
}

/** An edge route on its roughing pass — the only pass that offers a strategy. */
export function isRoughEdgeRoute(operation: Operation): boolean {
  return operation.pass === 'rough'
    && (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside')
}

/** Either flavour of trochoidal motion: rough edge routing or engraving. */
export function isTrochoidalOperation(operation: Operation): boolean {
  return isTrochoidalEdgeRoughing(operation) || isTrochoidalCarve(operation)
}

/** Operations that let the user choose how the cutter enters the material. */
export function supportsEntryStrategy(operation: Operation): boolean {
  return operation.kind === 'pocket'
    || operation.kind === 'surface_clean'
    || operation.kind === 'rough_surface'
    || isTrochoidalOperation(operation)
}

/**
 * The entry strategy actually in force. Trochoidal motion has no ramp, so a
 * stale `'ramp'` on the operation reads back as a helix rather than as a mode
 * the generator does not implement.
 */
export function resolvedEntryStrategy(operation: Operation): EntryStrategy {
  if (isTrochoidalOperation(operation)) {
    return operation.entryStrategy === 'plunge' ? 'plunge' : 'helix'
  }
  return operation.entryStrategy ?? 'plunge'
}

/** Countersink drilling derives its depth from a mouth diameter and a V-bit. */
export function isCountersinkDrill(operation: Operation): boolean {
  return operation.kind === 'drilling' && operation.drillType === 'countersink'
}

/** Waterline finishing is the only pattern with adaptive ring refinement. */
function isWaterlineFinish(operation: Operation): boolean {
  return operation.kind === 'finish_surface' && operation.pocketPattern === 'waterline'
}

/** Pocket feed reduction applies wherever the cutter can end up fully engaged. */
function cutsSlots(operation: Operation): boolean {
  return operation.kind === 'pocket'
    && (operation.pass === 'rough' || (operation.pass === 'finish' && operation.finishFloor))
}

/** Wall/floor finishing switches, offered by the passes that can skip either. */
function offersFinishSurfaces(operation: Operation): boolean {
  return ((operation.kind === 'pocket' || operation.kind === 'surface_clean') && operation.pass === 'finish')
    || operation.kind === 'finish_surface_cleanup'
}

/** Kinds whose depth is fully described by a carve depth, so no stock is left. */
function leavesStock(operation: Operation): boolean {
  return operation.kind !== 'follow_line'
    && operation.kind !== 'v_carve'
    && operation.kind !== 'v_carve_medial'
    && operation.kind !== 'drilling'
}

// ── Groups ─────────────────────────────────────────────────────────

export const OPERATION_FIELD_GROUP_IDS = [
  'identity',
  'target',
  'tool',
  'depth',
  'feeds',
  'strategy',
  'entry',
  'corners',
  'drilling',
  'output',
] as const

export type OperationFieldGroupId = typeof OPERATION_FIELD_GROUP_IDS[number]

export interface OperationFieldGroup {
  id: OperationFieldGroupId
  /** Section heading. */
  titleKey: keyof typeof camEn
  /** Persisted open/collapsed key. */
  storageKey: string
  /** Whether the group starts open the first time it is seen. */
  defaultOpen: boolean
}

/**
 * Groups render in this order. A group with no applicable field is skipped.
 *
 * Each group answers one question, and the open/collapsed line is "do you set
 * this when starting a job" versus "do you tune this occasionally". That is what
 * puts speeds and feeds above the fold and arc fitting below it — the previous
 * single "Advanced" section had it exactly backwards, burying `feed`,
 * `plungeFeed` and `rpm` (changed on every material change) while leaving
 * `arcFitting` (a G-code output detail set once per machine) always visible.
 */
export const OPERATION_FIELD_GROUPS: readonly OperationFieldGroup[] = [
  { id: 'identity', titleKey: 'cam.operation.group.identity', storageKey: 'cam-op-identity', defaultOpen: true },
  { id: 'target', titleKey: 'cam.operation.group.target', storageKey: 'cam-op-target', defaultOpen: true },
  { id: 'tool', titleKey: 'cam.operation.group.tool', storageKey: 'cam-op-tool', defaultOpen: true },
  { id: 'depth', titleKey: 'cam.operation.group.depth', storageKey: 'cam-op-depth', defaultOpen: true },
  { id: 'feeds', titleKey: 'cam.operation.group.feeds', storageKey: 'cam-op-feeds', defaultOpen: true },
  { id: 'strategy', titleKey: 'cam.operation.group.strategy', storageKey: 'cam-op-strategy', defaultOpen: false },
  { id: 'entry', titleKey: 'cam.operation.group.entry', storageKey: 'cam-op-entry', defaultOpen: false },
  { id: 'corners', titleKey: 'cam.operation.group.corners', storageKey: 'cam-op-corners', defaultOpen: false },
  // Drilling applies to one kind, so when it renders at all it is the point of
  // the operation — it opens rather than hiding its own reason for existing.
  { id: 'drilling', titleKey: 'cam.operation.group.drilling', storageKey: 'cam-op-drilling', defaultOpen: true },
  { id: 'output', titleKey: 'cam.operation.group.output', storageKey: 'cam-op-output', defaultOpen: false },
]

// ── Fields ─────────────────────────────────────────────────────────

export const OPERATION_FIELD_IDS = [
  // Identity — what this operation is.
  'name',
  'description',
  'kind',
  'pass',
  'enabled',
  // What it cuts.
  'target',
  'targetSource',
  'restMachining',
  'tabs',
  // Tool.
  'tool',
  // Depth.
  'carveDepth',
  'maxCarveDepth',
  'stepdown',
  'finishWalls',
  'finishFloor',
  'stockToLeaveRadial',
  'stockToLeaveAxial',
  // Speeds & feeds.
  'feed',
  'plungeFeed',
  'slotFeed',
  'engagementMode',
  'rpm',
  // Strategy.
  'pattern',
  'rasterAngle',
  'cutDirection',
  'machiningOrder',
  'edgeStrategy',
  'carveStrategy',
  'trochoidalCutWidth',
  'trochoidalAdvance',
  'trochoidalCarveChannel',
  'stepover',
  'adaptiveRefinement',
  'adaptiveSpacing',
  'maxRings',
  // Entry & retract.
  'entryStrategy',
  'entryRampAngle',
  'entryHelixDiameter',
  'retractHeight',
  // Corners.
  'roundOutsideCorners',
  'roundLinkCorners',
  'cleanWallCorners',
  'cornerRelief',
  // Drilling.
  'drillType',
  'peckDepth',
  'dwellTime',
  'countersinkDiameter',
  'countersinkDepth',
  // Output.
  'arcFitting',
] as const

export type OperationFieldId = typeof OPERATION_FIELD_IDS[number]

export interface OperationFieldSpec {
  id: OperationFieldId
  group: OperationFieldGroupId
  /** Reference-diagram kind rendered in the row's icon rail, when it has one. */
  paramRef?: OperationParamRefKind
  /** Whether the field is offered for this operation. Pure. */
  appliesTo: (operation: Operation) => boolean
}

const always = () => true

/**
 * Every control in the operation panel, in render order.
 *
 * Ordering within a group is this array's order; ordering across groups is
 * `OPERATION_FIELD_GROUPS`. A field appears exactly once, so switching operation
 * kind can no longer move a control the user was just editing.
 */
export const OPERATION_FIELDS: readonly OperationFieldSpec[] = [
  // ── Identity — what this operation is.
  { id: 'name', group: 'identity', appliesTo: always },
  { id: 'description', group: 'identity', appliesTo: always },
  { id: 'kind', group: 'identity', appliesTo: always },
  {
    id: 'pass',
    group: 'identity',
    // Kinds with a single meaningful pass do not offer the choice.
    appliesTo: (operation) => operation.kind !== 'v_carve'
      && operation.kind !== 'v_carve_medial'
      && operation.kind !== 'drilling'
      && operation.kind !== 'rough_surface'
      && operation.kind !== 'finish_surface'
      && operation.kind !== 'finish_surface_cleanup',
  },
  { id: 'enabled', group: 'identity', appliesTo: always },
  // ── What it cuts.
  { id: 'target', group: 'target', appliesTo: always },
  { id: 'targetSource', group: 'target', appliesTo: always },
  {
    id: 'restMachining',
    group: 'target',
    appliesTo: (operation) => operation.kind === 'pocket'
      || operation.kind === 'edge_route_inside'
      || operation.kind === 'edge_route_outside',
  },
  {
    id: 'tabs',
    group: 'target',
    appliesTo: (operation) => operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside',
  },
  // ── Tool.
  { id: 'tool', group: 'tool', appliesTo: always },
  // ── Depth.
  {
    id: 'carveDepth',
    group: 'depth',
    paramRef: 'maxDepth',
    appliesTo: (operation) => operation.kind === 'follow_line',
  },
  {
    id: 'maxCarveDepth',
    group: 'depth',
    paramRef: 'maxDepth',
    appliesTo: (operation) => operation.kind === 'v_carve' || operation.kind === 'v_carve_medial',
  },
  { id: 'stepdown', group: 'depth', paramRef: 'stepdown', appliesTo: showStepdown },
  { id: 'finishWalls', group: 'depth', paramRef: 'finishWalls', appliesTo: offersFinishSurfaces },
  { id: 'finishFloor', group: 'depth', paramRef: 'finishFloor', appliesTo: offersFinishSurfaces },
  {
    id: 'stockToLeaveRadial',
    group: 'depth',
    paramRef: 'stockRadial',
    // Surface finishing leaves radial stock only on the waterline pattern, where
    // the rings are walls; the parallel pattern only has a floor.
    appliesTo: (operation) => leavesStock(operation)
      && (operation.kind !== 'finish_surface' || isWaterlineFinish(operation)),
  },
  { id: 'stockToLeaveAxial', group: 'depth', paramRef: 'stockAxial', appliesTo: leavesStock },
  // ── Speeds & feeds — the numbers that change with the material. Slot feed and
  //   its engagement mode stay adjacent: the mode governs how the reduction
  //   above it is applied, so splitting them reads as two unrelated settings.
  { id: 'feed', group: 'feeds', paramRef: 'feed', appliesTo: always },
  { id: 'plungeFeed', group: 'feeds', paramRef: 'plungeFeed', appliesTo: always },
  { id: 'slotFeed', group: 'feeds', paramRef: 'slotFeed', appliesTo: cutsSlots },
  { id: 'engagementMode', group: 'feeds', paramRef: 'engagementMode', appliesTo: cutsSlots },
  { id: 'rpm', group: 'feeds', paramRef: 'rpm', appliesTo: always },
  // ── Strategy — how the cutter covers the material.
  {
    id: 'pattern',
    group: 'strategy',
    paramRef: 'pattern',
    // One row; the offered patterns differ per kind and live in the renderer.
    appliesTo: (operation) => operation.kind === 'pocket'
      || operation.kind === 'surface_clean'
      || operation.kind === 'finish_surface'
      || operation.kind === 'finish_surface_cleanup',
  },
  {
    id: 'rasterAngle',
    group: 'strategy',
    paramRef: 'rasterAngle',
    appliesTo: (operation) => (operation.kind === 'pocket'
      || operation.kind === 'surface_clean'
      || operation.kind === 'finish_surface'
      || operation.kind === 'finish_surface_cleanup')
      && operation.pocketPattern === 'parallel',
  },
  {
    id: 'cutDirection',
    group: 'strategy',
    paramRef: 'cutDirection',
    appliesTo: (operation) => operation.kind === 'pocket'
      || operation.kind === 'edge_route_inside'
      || operation.kind === 'edge_route_outside'
      || operation.kind === 'v_carve'
      || operation.kind === 'surface_clean'
      || operation.kind === 'rough_surface'
      || operation.kind === 'finish_surface'
      || operation.kind === 'finish_surface_cleanup'
      || isTrochoidalCarve(operation),
  },
  {
    id: 'machiningOrder',
    group: 'strategy',
    paramRef: 'machiningOrder',
    appliesTo: (operation) => operation.kind === 'pocket'
      || operation.kind === 'edge_route_inside'
      || operation.kind === 'edge_route_outside',
  },
  { id: 'edgeStrategy', group: 'strategy', paramRef: 'edgeStrategy', appliesTo: isRoughEdgeRoute },
  {
    id: 'carveStrategy',
    group: 'strategy',
    paramRef: 'edgeStrategy',
    appliesTo: (operation) => operation.kind === 'follow_line',
  },
  {
    id: 'trochoidalCutWidth',
    group: 'strategy',
    paramRef: 'trochoidalCutWidth',
    appliesTo: isTrochoidalOperation,
  },
  {
    id: 'trochoidalAdvance',
    group: 'strategy',
    paramRef: 'trochoidalAdvance',
    appliesTo: isTrochoidalOperation,
  },
  { id: 'trochoidalCarveChannel', group: 'strategy', appliesTo: isTrochoidalCarve },
  {
    id: 'stepover',
    group: 'strategy',
    paramRef: 'stepover',
    // Waterline finishing spaces its rings adaptively, so a ratio means nothing.
    appliesTo: (operation) => operation.kind !== 'follow_line'
      && operation.kind !== 'drilling'
      && operation.kind !== 'v_carve_medial'
      && operation.kind !== 'edge_route_inside'
      && operation.kind !== 'edge_route_outside'
      && !isWaterlineFinish(operation),
  },
  {
    id: 'adaptiveRefinement',
    group: 'strategy',
    paramRef: 'adaptiveRefinement',
    appliesTo: isWaterlineFinish,
  },
  {
    id: 'adaptiveSpacing',
    group: 'strategy',
    paramRef: 'adaptiveSpacing',
    appliesTo: (operation) => isWaterlineFinish(operation) && (operation.waterlineAdaptiveRefinement ?? true),
  },
  {
    id: 'maxRings',
    group: 'strategy',
    paramRef: 'maxRings',
    appliesTo: (operation) => isWaterlineFinish(operation) && (operation.waterlineAdaptiveRefinement ?? true),
  },
  // ── Entry & retract — how the cutter gets into and out of the cut.
  { id: 'entryStrategy', group: 'entry', paramRef: 'entryStrategy', appliesTo: supportsEntryStrategy },
  {
    id: 'entryRampAngle',
    group: 'entry',
    paramRef: 'entryRampAngle',
    // One row for both users of the angle: a ramping/helical entry, and helical
    // drilling. The two predicates are disjoint (drilling offers no entry
    // strategy), so the field still renders from exactly one place.
    appliesTo: (operation) => (supportsEntryStrategy(operation)
      && (resolvedEntryStrategy(operation) === 'helix' || resolvedEntryStrategy(operation) === 'ramp'))
      || (operation.kind === 'drilling' && operation.drillType === 'helical'),
  },
  {
    id: 'entryHelixDiameter',
    group: 'entry',
    paramRef: 'entryHelixDiameter',
    // Deliberately not offered for helical drilling: there the selected circle
    // defines the bore diameter, not this shared setting (issue #412).
    appliesTo: (operation) => supportsEntryStrategy(operation) && resolvedEntryStrategy(operation) === 'helix',
  },
  {
    id: 'retractHeight',
    group: 'entry',
    paramRef: 'retractHeight',
    appliesTo: (operation) => operation.kind === 'drilling',
  },
  // ── Corners.
  {
    id: 'roundOutsideCorners',
    group: 'corners',
    appliesTo: (operation) => operation.kind === 'edge_route_outside'
      || operation.kind === 'pocket'
      || operation.kind === 'surface_clean'
      || operation.kind === 'rough_surface'
      || operation.kind === 'finish_surface_cleanup',
  },
  {
    id: 'roundLinkCorners',
    group: 'corners',
    appliesTo: (operation) => operation.kind === 'pocket' && operation.pocketPattern !== 'parallel',
  },
  {
    id: 'cleanWallCorners',
    group: 'corners',
    // Only meaningful once the interior rings are already rounded.
    appliesTo: (operation) => operation.kind === 'pocket'
      && operation.pocketPattern !== 'parallel'
      && (operation.roundOutsideCorners ?? false),
  },
  {
    id: 'cornerRelief',
    group: 'corners',
    paramRef: 'cornerRelief',
    appliesTo: (operation) => operation.kind === 'pocket'
      || operation.kind === 'edge_route_inside'
      || operation.kind === 'edge_route_outside',
  },
  // ── Drilling — applies to one kind, so the group is absent everywhere else.
  {
    id: 'drillType',
    group: 'drilling',
    paramRef: 'drillType',
    appliesTo: (operation) => operation.kind === 'drilling',
  },
  {
    id: 'peckDepth',
    group: 'drilling',
    paramRef: 'peckDepth',
    appliesTo: (operation) => operation.kind === 'drilling'
      && (operation.drillType === 'peck' || operation.drillType === 'chip_breaking'),
  },
  {
    id: 'dwellTime',
    group: 'drilling',
    paramRef: 'dwell',
    appliesTo: (operation) => operation.kind === 'drilling' && operation.drillType === 'dwell',
  },
  {
    id: 'countersinkDiameter',
    group: 'drilling',
    paramRef: 'countersinkDiameter',
    appliesTo: isCountersinkDrill,
  },
  { id: 'countersinkDepth', group: 'drilling', appliesTo: isCountersinkDrill },
  // ── Output — G-code detail, set once per machine.
  { id: 'arcFitting', group: 'output', appliesTo: always },
]

/**
 * The fields of `group` that apply to `operation`, in render order. An empty
 * result means the group must not render at all.
 */
export function operationFieldsForGroup(
  group: OperationFieldGroupId,
  operation: Operation,
): OperationFieldSpec[] {
  return OPERATION_FIELDS.filter((field) => field.group === group && field.appliesTo(operation))
}
