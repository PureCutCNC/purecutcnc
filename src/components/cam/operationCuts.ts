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
 * The operation's "Cuts" list (issue #1112 slice I): the current targets, in
 * target order, with the folder grouping its long form uses and the target a
 * remove × would write.
 *
 * The list shows **only what the operation already targets** — never every
 * candidate. Picking a new target stays with selection (select then Add, Use
 * current selection, right-click Add to operation), so this module is about
 * reading and removing, not offering.
 *
 * Grouping is a display decision, so it is testable here rather than in JSX:
 * a long list groups by the tree's folders and each folder is a collapsible
 * row ("Holes (200)"). A short list stays flat — collapsing two rows would
 * hide targets without saving anything.
 *
 * Every operation needs at least one target; a remove that would leave an
 * empty or otherwise invalid target is refused here and the panel disables
 * its ×.
 */

import type { FeatureKind, Operation, OperationTarget, Project } from '../../types/project'
import { resolveProject } from '../../store/helpers/resolveFeatures'
import type { ResolvedProject, ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { isRegion } from '../../store/helpers/featureRoles'
import { isOperationTargetValidResolved } from '../../store/helpers/operationDefaults'
import { GEAR_CANNED_KIND } from '../../cannedShapes/generators/gear'
import {
  CHAMFER_RECT_CANNED_KIND,
  ELLIPSE_CANNED_KIND,
  FLUTES_CANNED_KIND,
  NGON_CANNED_KIND,
  POLYGON_CANNED_KIND,
  ROUND_RECT_CANNED_KIND,
  SLOT_CANNED_KIND,
  THREAD_CANNED_KIND,
  TURN_CANNED_KIND,
} from '../../cannedShapes/generators/kinds'

/** One target row: the name the list shows and whether its × may be used. */
export interface OperationCutRow {
  featureId: string
  name: string
  /** Icon id of the target's own shape, shown before the name. */
  icon: string
  /** A closed Region mask, which filters the cut rather than being machined. */
  filter: boolean
  /** False when removing it would leave the operation with no valid target. */
  removable: boolean
}

/**
 * Icons for the targets a Cuts row can name (issue #1112 rt3-a, item 25): a
 * canned shape answers for its own kind, so a Turn reads as a turned solid and
 * a slot as a slot; a plain feature answers for its `FeatureKind`.
 */
const CANNED_ICONS: Readonly<Record<string, string>> = {
  [ELLIPSE_CANNED_KIND]: 'ellipse',
  [SLOT_CANNED_KIND]: 'slot',
  [NGON_CANNED_KIND]: 'ngon',
  [ROUND_RECT_CANNED_KIND]: 'roundrect',
  [CHAMFER_RECT_CANNED_KIND]: 'chamferrect',
  [THREAD_CANNED_KIND]: 'spline',
  [FLUTES_CANNED_KIND]: 'spline',
  [TURN_CANNED_KIND]: 'turn',
  [POLYGON_CANNED_KIND]: 'polygon',
  [GEAR_CANNED_KIND]: 'gear',
}

const KIND_ICONS: Readonly<Record<FeatureKind, string>> = {
  rect: 'rect',
  circle: 'circle',
  ellipse: 'ellipse',
  polygon: 'polygon',
  spline: 'spline',
  composite: 'composite',
  text: 'text',
  stl: 'import',
}

/**
 * The icon a row shows before its target's name, the way a list shows an item's
 * type. An imported mesh has no canned parameters and reads as an import; a
 * kind the sprite has no icon for falls back to `composite`, so a shape added
 * later still gets a row icon rather than a blank space.
 */
export function cutRowIcon(feature: Pick<ResolvedSketchFeature, 'kind' | 'canned'>): string {
  return (feature.canned ? CANNED_ICONS[feature.canned.kind] : undefined)
    ?? KIND_ICONS[feature.kind]
    ?? 'composite'
}

/** One rendered block of rows: a tree folder when long, or the ungrouped rows. */
export interface OperationCutGroup {
  /** The tree folder the rows share; null for rows outside every folder. */
  folderId: string | null
  folderName: string | null
  rows: OperationCutRow[]
}

/**
 * More target rows than this and the list groups by the tree's folders. A
 * folder is how the tree already organises a run of holes, so the list reads as
 * the same organisation rather than a second one; below the threshold a flat
 * list is shorter to scan.
 */
export const CUTS_FOLDER_GROUP_THRESHOLD = 8

/**
 * The operation's current targets, in target order. A region filter is marked
 * so the row can say it is not a machined shape; an id that names no feature
 * any more is skipped, as the target summary always did.
 */
export function operationCutRows(project: Project, operation: Operation): OperationCutRow[] {
  if (operation.target.source !== 'features') return []
  // One resolution for the whole list: a folder of 200 holes must not resolve
  // the project 200 times just to know which × is refused.
  const resolved = resolveProject(project)
  const featureById = new Map(resolved.features.map((feature) => [feature.id, feature]))
  return operation.target.featureIds.flatMap((featureId) => {
    const feature = featureById.get(featureId)
    return feature ? [{
      featureId: feature.id,
      name: feature.name,
      icon: cutRowIcon(feature),
      filter: isRegion(feature),
      removable: cutRemovalTargetResolved(resolved, operation, feature.id) !== null,
    }] : []
  })
}

/** The feature a row's × removes, or null when the operation must keep it. */
export function cutRemovalTarget(
  project: Project,
  operation: Operation,
  featureId: string,
): OperationTarget | null {
  return cutRemovalTargetResolved(resolveProject(project), operation, featureId)
}

function cutRemovalTargetResolved(
  project: ResolvedProject,
  operation: Operation,
  featureId: string,
): OperationTarget | null {
  if (operation.target.source !== 'features') return null
  const featureIds = operation.target.featureIds.filter((id) => id !== featureId)
  if (featureIds.length === operation.target.featureIds.length) return null
  const target: OperationTarget = { source: 'features', featureIds }
  return isOperationTargetValidResolved(project, operation.kind, target) ? target : null
}

/**
 * The rows as the list draws them: one flat block while the list is short, or
 * one block per tree folder once it is long. Rows outside a folder share the
 * ungrouped block, created where the first of them appears so the display
 * still follows target order.
 */
export function operationCutGroups(project: Project, rows: readonly OperationCutRow[]): {
  grouped: boolean
  groups: OperationCutGroup[]
} {
  const folderOf = new Map<string, string | null>()
  for (const feature of project.features) folderOf.set(feature.id, feature.folderId)
  const folderNames = new Map(project.featureFolders.map((folder) => [folder.id, folder.name]))
  const grouped = rows.length > CUTS_FOLDER_GROUP_THRESHOLD
    && rows.some((row) => (folderOf.get(row.featureId) ?? null) !== null)
  if (!grouped) return { grouped: false, groups: [{ folderId: null, folderName: null, rows: [...rows] }] }

  const byFolder = new Map<string | null, OperationCutGroup>()
  for (const row of rows) {
    const folderId = folderOf.get(row.featureId) ?? null
    let group = byFolder.get(folderId)
    if (!group) {
      group = {
        folderId,
        folderName: folderId === null ? null : folderNames.get(folderId) ?? '',
        rows: [],
      }
      byFolder.set(folderId, group)
    }
    group.rows.push(row)
  }
  return { grouped: true, groups: [...byFolder.values()] }
}
