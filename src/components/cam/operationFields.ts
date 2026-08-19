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

export const OPERATION_FIELD_GROUP_IDS = ['basic', 'advanced'] as const

export type OperationFieldGroupId = typeof OPERATION_FIELD_GROUP_IDS[number]

export interface OperationFieldGroup {
  id: OperationFieldGroupId
  /**
   * Section heading. `null` renders the group's fields bare, with no disclosure
   * wrapper — how the always-visible run reads today.
   */
  titleKey: (keyof typeof camEn) | null
  /** Persisted open/collapsed key; omitted for a bare group. */
  storageKey?: string
  /** Whether a collapsible group starts open the first time it is seen. */
  defaultOpen?: boolean
}

/** Groups render in this order. A group with no applicable field is skipped. */
export const OPERATION_FIELD_GROUPS: readonly OperationFieldGroup[] = [
  { id: 'basic', titleKey: null },
  {
    id: 'advanced',
    titleKey: 'cam.operation.advanced',
    storageKey: 'cam-operation-advanced',
    defaultOpen: false,
  },
]

// ── Fields ─────────────────────────────────────────────────────────

export const OPERATION_FIELD_IDS = [
  // Basic — the always-visible run.
  'name',
  'description',
  'kind',
  'pass',
  'maxCarveDepth',
  'carveDepth',
  'target',
  'targetSource',
  'restMachining',
  'booklet',
  'tabs',
  'toolpathWarnings',
  'tool',
  'enabled',
  'arcFitting',
  'stepdown',
  'edgeStrategy',
  'carveStrategy',
  'trochoidalCutWidth',
  'trochoidalAdvance',
  'trochoidalCarveChannel',
  'stepover',
  // Advanced.
  'entryStrategy',
  'entryRampAngle',
  'entryHelixDiameter',
  'pattern',
  'rasterAngle',
  'cutDirection',
  'machiningOrder',
  'roundOutsideCorners',
  'roundLinkCorners',
  'cleanWallCorners',
  'cornerRelief',
  'drillType',
  'peckDepth',
  'dwellTime',
  'countersinkDiameter',
  'countersinkDepth',
  'retractHeight',
  'finishWalls',
  'finishFloor',
  'debugToolpath',
  'feed',
  'plungeFeed',
  'slotFeed',
  'engagementMode',
  'rpm',
  'stockToLeaveRadial',
  'adaptiveRefinement',
  'adaptiveSpacing',
  'maxRings',
  'stockToLeaveAxial',
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
  // ── Basic ────────────────────────────────────────────────────────
  { id: 'name', group: 'basic', appliesTo: always },
  { id: 'description', group: 'basic', appliesTo: always },
  { id: 'kind', group: 'basic', appliesTo: always },
  {
    id: 'pass',
    group: 'basic',
    // Kinds with a single meaningful pass do not offer the choice.
    appliesTo: (operation) => operation.kind !== 'v_carve'
      && operation.kind !== 'v_carve_medial'
      && operation.kind !== 'drilling'
      && operation.kind !== 'rough_surface'
      && operation.kind !== 'finish_surface'
      && operation.kind !== 'finish_surface_cleanup',
  },
  {
    id: 'maxCarveDepth',
    group: 'basic',
    paramRef: 'maxDepth',
    appliesTo: (operation) => operation.kind === 'v_carve' || operation.kind === 'v_carve_medial',
  },
  {
    id: 'carveDepth',
    group: 'basic',
    paramRef: 'maxDepth',
    appliesTo: (operation) => operation.kind === 'follow_line',
  },
  { id: 'target', group: 'basic', appliesTo: always },
  { id: 'targetSource', group: 'basic', appliesTo: always },
  {
    id: 'restMachining',
    group: 'basic',
    appliesTo: (operation) => operation.kind === 'pocket'
      || operation.kind === 'edge_route_inside'
      || operation.kind === 'edge_route_outside',
  },
  { id: 'booklet', group: 'basic', appliesTo: always },
  {
    id: 'tabs',
    group: 'basic',
    appliesTo: (operation) => operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside',
  },
  { id: 'toolpathWarnings', group: 'basic', appliesTo: always },
  { id: 'tool', group: 'basic', appliesTo: always },
  { id: 'enabled', group: 'basic', appliesTo: always },
  { id: 'arcFitting', group: 'basic', appliesTo: always },
  { id: 'stepdown', group: 'basic', paramRef: 'stepdown', appliesTo: showStepdown },
  { id: 'edgeStrategy', group: 'basic', paramRef: 'edgeStrategy', appliesTo: isRoughEdgeRoute },
  {
    id: 'carveStrategy',
    group: 'basic',
    paramRef: 'edgeStrategy',
    appliesTo: (operation) => operation.kind === 'follow_line',
  },
  {
    id: 'trochoidalCutWidth',
    group: 'basic',
    paramRef: 'trochoidalCutWidth',
    appliesTo: isTrochoidalOperation,
  },
  {
    id: 'trochoidalAdvance',
    group: 'basic',
    paramRef: 'trochoidalAdvance',
    appliesTo: isTrochoidalOperation,
  },
  // Derived channel-width readout and its two cautions; engraving only.
  { id: 'trochoidalCarveChannel', group: 'basic', appliesTo: isTrochoidalCarve },
  {
    id: 'stepover',
    group: 'basic',
    paramRef: 'stepover',
    // Waterline finishing spaces its rings adaptively, so a ratio means nothing.
    appliesTo: (operation) => operation.kind !== 'follow_line'
      && operation.kind !== 'drilling'
      && operation.kind !== 'v_carve_medial'
      && operation.kind !== 'edge_route_inside'
      && operation.kind !== 'edge_route_outside'
      && !isWaterlineFinish(operation),
  },

  // ── Advanced ─────────────────────────────────────────────────────
  { id: 'entryStrategy', group: 'advanced', paramRef: 'entryStrategy', appliesTo: supportsEntryStrategy },
  {
    id: 'entryRampAngle',
    group: 'advanced',
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
    group: 'advanced',
    paramRef: 'entryHelixDiameter',
    // Deliberately not offered for helical drilling: there the selected circle
    // defines the bore diameter, not this shared setting (issue #412).
    appliesTo: (operation) => supportsEntryStrategy(operation) && resolvedEntryStrategy(operation) === 'helix',
  },
  {
    id: 'pattern',
    group: 'advanced',
    paramRef: 'pattern',
    // One row; the offered patterns differ per kind and live in the renderer.
    appliesTo: (operation) => operation.kind === 'pocket'
      || operation.kind === 'surface_clean'
      || operation.kind === 'finish_surface'
      || operation.kind === 'finish_surface_cleanup',
  },
  {
    id: 'rasterAngle',
    group: 'advanced',
    paramRef: 'rasterAngle',
    appliesTo: (operation) => (operation.kind === 'pocket'
      || operation.kind === 'surface_clean'
      || operation.kind === 'finish_surface'
      || operation.kind === 'finish_surface_cleanup')
      && operation.pocketPattern === 'parallel',
  },
  {
    id: 'cutDirection',
    group: 'advanced',
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
    group: 'advanced',
    paramRef: 'machiningOrder',
    appliesTo: (operation) => operation.kind === 'pocket'
      || operation.kind === 'edge_route_inside'
      || operation.kind === 'edge_route_outside',
  },
  {
    id: 'roundOutsideCorners',
    group: 'advanced',
    appliesTo: (operation) => operation.kind === 'edge_route_outside'
      || operation.kind === 'pocket'
      || operation.kind === 'surface_clean'
      || operation.kind === 'rough_surface'
      || operation.kind === 'finish_surface_cleanup',
  },
  {
    id: 'roundLinkCorners',
    group: 'advanced',
    appliesTo: (operation) => operation.kind === 'pocket' && operation.pocketPattern !== 'parallel',
  },
  {
    id: 'cleanWallCorners',
    group: 'advanced',
    // Only meaningful once the interior rings are already rounded.
    appliesTo: (operation) => operation.kind === 'pocket'
      && operation.pocketPattern !== 'parallel'
      && (operation.roundOutsideCorners ?? false),
  },
  {
    id: 'cornerRelief',
    group: 'advanced',
    paramRef: 'cornerRelief',
    appliesTo: (operation) => operation.kind === 'pocket'
      || operation.kind === 'edge_route_inside'
      || operation.kind === 'edge_route_outside',
  },
  {
    id: 'drillType',
    group: 'advanced',
    paramRef: 'drillType',
    appliesTo: (operation) => operation.kind === 'drilling',
  },
  {
    id: 'peckDepth',
    group: 'advanced',
    paramRef: 'peckDepth',
    appliesTo: (operation) => operation.kind === 'drilling'
      && (operation.drillType === 'peck' || operation.drillType === 'chip_breaking'),
  },
  {
    id: 'dwellTime',
    group: 'advanced',
    paramRef: 'dwell',
    appliesTo: (operation) => operation.kind === 'drilling' && operation.drillType === 'dwell',
  },
  {
    id: 'countersinkDiameter',
    group: 'advanced',
    paramRef: 'countersinkDiameter',
    appliesTo: isCountersinkDrill,
  },
  // Derived plunge depth plus the two conditions the operator can fix here.
  { id: 'countersinkDepth', group: 'advanced', appliesTo: isCountersinkDrill },
  {
    id: 'retractHeight',
    group: 'advanced',
    paramRef: 'retractHeight',
    appliesTo: (operation) => operation.kind === 'drilling',
  },
  { id: 'finishWalls', group: 'advanced', paramRef: 'finishWalls', appliesTo: offersFinishSurfaces },
  { id: 'finishFloor', group: 'advanced', paramRef: 'finishFloor', appliesTo: offersFinishSurfaces },
  { id: 'debugToolpath', group: 'advanced', appliesTo: always },
  { id: 'feed', group: 'advanced', paramRef: 'feed', appliesTo: always },
  { id: 'plungeFeed', group: 'advanced', paramRef: 'plungeFeed', appliesTo: always },
  { id: 'slotFeed', group: 'advanced', paramRef: 'slotFeed', appliesTo: cutsSlots },
  { id: 'engagementMode', group: 'advanced', paramRef: 'engagementMode', appliesTo: cutsSlots },
  { id: 'rpm', group: 'advanced', paramRef: 'rpm', appliesTo: always },
  {
    id: 'stockToLeaveRadial',
    group: 'advanced',
    paramRef: 'stockRadial',
    // Surface finishing leaves radial stock only on the waterline pattern, where
    // the rings are walls; the parallel pattern only has a floor.
    appliesTo: (operation) => leavesStock(operation)
      && (operation.kind !== 'finish_surface' || isWaterlineFinish(operation)),
  },
  {
    id: 'adaptiveRefinement',
    group: 'advanced',
    paramRef: 'adaptiveRefinement',
    appliesTo: isWaterlineFinish,
  },
  {
    id: 'adaptiveSpacing',
    group: 'advanced',
    paramRef: 'adaptiveSpacing',
    appliesTo: (operation) => isWaterlineFinish(operation) && (operation.waterlineAdaptiveRefinement ?? true),
  },
  {
    id: 'maxRings',
    group: 'advanced',
    paramRef: 'maxRings',
    appliesTo: (operation) => isWaterlineFinish(operation) && (operation.waterlineAdaptiveRefinement ?? true),
  },
  { id: 'stockToLeaveAxial', group: 'advanced', paramRef: 'stockAxial', appliesTo: leavesStock },
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
