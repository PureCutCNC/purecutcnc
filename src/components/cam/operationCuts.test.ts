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
 * The operation's Cuts list (issue #1112 slice I): only its current targets,
 * in target order, with folder grouping for a long list and a remove × that
 * can never empty the operation.
 *
 * Mutations checked one at a time against these assertions:
 *  - every candidate listed instead of the target only → "only the operation's
 *    own targets are rows" fails;
 *  - rows in project order instead of target order → the order assertion fails;
 *  - grouping below the threshold → "a short list stays flat" fails;
 *  - every folder defaulting to one flat list → "a long list groups by the
 *    tree's folders" fails;
 *  - the last target removable → "the only target cannot be removed" fails;
 *  - a region filter treated as a machined shape → the filter assertion fails.
 *
 * Run with: npx tsx src/components/cam/operationCuts.test.ts
 */

import assert from 'node:assert/strict'
import { newProject, rectProfile } from '../../types/project'
import type { FeatureFolder, Operation, OperationKind, Project, SketchFeature } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { CUTS_FOLDER_GROUP_THRESHOLD, cutRemovalTarget, operationCutGroups, operationCutRows } from './operationCuts'

function hole(id: string, folderId: string | null = null, operation: SketchFeature['operation'] = 'subtract'): SketchFeature {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'rect',
    folderId,
    sketch: { profile: rectProfile(1, 1, 2, 2), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation,
    z_top: 2,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function fixture(ids: string[], folders: FeatureFolder[] = [], extra: SketchFeature[] = []): Project {
  // The folders must exist before the rows are normalised, or a row naming
  // one is treated as orphaned and its folderId is dropped.
  const base = { ...newProject('cuts', 'mm'), featureFolders: folders }
  return projectWithFeatures(base, [
    ...ids.map((id) => hole(id, id.startsWith('f') ? 'folder' : null)),
    ...extra,
  ])
}

function operation(project: Project, target: Operation['target'], kind: OperationKind = 'pocket'): Operation {
  return defaultOperationForTarget(project, kind, 'rough', target, 0)
}

// ── Rows are the operation's own targets, in target order ────
{
  const project = fixture(['a', 'b', 'c', 'd'])
  const op = operation(project, { source: 'features', featureIds: ['c', 'a'] })
  const rows = operationCutRows(project, op)
  assert.deepEqual(
    rows.map((row) => row.featureId),
    ['c', 'a'],
    "only the operation's own targets are rows, in target order",
  )
  assert.deepEqual(rows.map((row) => row.name), ['C', 'A'], 'a row shows the target name')
  assert(rows.every((row) => row.filter === false), 'a machined shape is not a filter')
}

// An id that names no feature any more is skipped, not turned into a blank row.
{
  const project = fixture(['a'])
  const op = operation(project, { source: 'features', featureIds: ['a', 'gone'] })
  assert.deepEqual(operationCutRows(project, op).map((row) => row.featureId), ['a'], 'a missing target is skipped')
}

// A closed Region mask is a filter, and says so.
{
  const project = fixture(['a', 'region'], [], [])
  const region = project.features.find((feature) => feature.id === 'region')!
  project.featureDefinitions[region.definitionId] = { ...project.featureDefinitions[region.definitionId], operation: 'region' }
  const op = operation(project, { source: 'features', featureIds: ['a', 'region'] })
  const rows = operationCutRows(project, op)
  assert.equal(rows.find((row) => row.featureId === 'region')?.filter, true, 'a region is marked as a filter')
  assert.equal(rows.find((row) => row.featureId === 'a')?.filter, false, 'a machined shape is not')
}

// ── Removing a row never empties the operation ───────────────
{
  const project = fixture(['a', 'b'])
  const op = operation(project, { source: 'features', featureIds: ['a', 'b'] })
  assert.deepEqual(
    cutRemovalTarget(project, op, 'b'),
    { source: 'features', featureIds: ['a'] },
    'removing one of two leaves the other',
  )
  assert.equal(cutRemovalTarget(project, op, 'gone'), null, 'a row not in the target writes nothing')
  const single = operation(project, { source: 'features', featureIds: ['a'] })
  assert.equal(cutRemovalTarget(project, single, 'a'), null, 'the only target cannot be removed')
  assert.equal(operationCutRows(project, single)[0].removable, false, 'its × is disabled')
  const stock = operation(project, { source: 'stock' })
  assert.equal(cutRemovalTarget(project, stock, 'a'), null, 'a stock target has no rows to remove')
  assert.deepEqual(operationCutRows(project, stock), [], 'a stock target lists no feature rows')
}

// ── Grouping: short stays flat, long groups by the tree's folders ──
{
  const ids = Array.from({ length: CUTS_FOLDER_GROUP_THRESHOLD }, (_, index) => `f${index}`)
  const folders: FeatureFolder[] = [{ id: 'folder', name: 'Holes', collapsed: false, section: 'features' }]
  const project = fixture(ids, folders)
  const short = operation(project, { source: 'features', featureIds: ids })
  const shortRows = operationCutRows(project, short)
  assert.equal(operationCutGroups(project, shortRows).grouped, false, 'a short list stays flat')
}

{
  const ids = Array.from({ length: CUTS_FOLDER_GROUP_THRESHOLD + 1 }, (_, index) => `f${index}`)
  const folders: FeatureFolder[] = [{ id: 'folder', name: 'Holes', collapsed: false, section: 'features' }]
  const project = fixture(ids, folders, [hole('loose')])
  const op = operation(project, { source: 'features', featureIds: [...ids, 'loose'] })
  const rows = operationCutRows(project, op)
  const grouped = operationCutGroups(project, rows)
  assert.equal(grouped.grouped, true, 'a long list groups by the tree folders')
  assert.equal(grouped.groups.length, 2, 'one folder block and one ungrouped block')
  assert.equal(grouped.groups[0].folderId, 'folder', 'the folder comes first, in target order')
  assert.equal(grouped.groups[0].folderName, 'Holes', 'the block is named after the tree folder')
  assert.equal(grouped.groups[0].rows.length, CUTS_FOLDER_GROUP_THRESHOLD + 1, 'every folder row is in it')
  assert.equal(grouped.groups[1].folderId, null, 'the row outside a folder is ungrouped')
  assert.deepEqual(grouped.groups[1].rows.map((row) => row.featureId), ['loose'], 'and lands in its own block')
}

// A long list with no folders stays flat: there is nothing to group by.
{
  const ids = Array.from({ length: CUTS_FOLDER_GROUP_THRESHOLD + 1 }, (_, index) => `n${index}`)
  const project = fixture(ids)
  const op = operation(project, { source: 'features', featureIds: ids })
  assert.equal(operationCutGroups(project, operationCutRows(project, op)).grouped, false, 'no folders: no grouping')
}

console.log('operation cuts tests passed')
