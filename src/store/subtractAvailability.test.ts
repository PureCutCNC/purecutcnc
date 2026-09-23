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
 * The operation menus offer Subtract only where the store keeps it (#827).
 *
 * `canChooseSubtract` predicts the base-solid rule that `applyFeaturePatch`
 * applies after every operation edit. Each scenario checks the prediction
 * against what `updateFeature` actually does to every row, so an enabled
 * Subtract never silently comes back as Add.
 *
 * Run with: npx tsx src/store/subtractAvailability.test.ts
 */

import { newProject, rectProfile, type FeatureOperation, type Project } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import type { LegacyFeatureRow } from './helpers/projectFormat'
import { canChooseSubtract } from './helpers/featureRoles'
import { resolveFeatureInstance, resolvedProjectFeatures } from './helpers/resolveFeatures'
import { useProjectStore } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function row(id: string, operation: FeatureOperation, definitionId?: string): LegacyFeatureRow {
  return {
    id,
    name: id,
    kind: 'polygon',
    definitionId,
    operation,
    visible: true,
    locked: false,
    z_top: 5,
    z_bottom: 0,
    folderId: null,
    sketch: {
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
      profile: rectProfile(0, 0, 20, 10),
    },
    text: null,
    stl: null,
  } as LegacyFeatureRow
}

function buildProject(rows: LegacyFeatureRow[]): Project {
  return projectWithFeatures(newProject('Subtract availability', 'mm'), rows)
}

function load(project: Project): void {
  useProjectStore.setState({
    project,
    pendingAdd: null,
    history: { past: [], future: [], transactionStart: null },
  })
}

function operationOf(id: string): FeatureOperation {
  const feature = resolveFeatureInstance(useProjectStore.getState().project, id)
  assert(feature, `feature ${id} exists`)
  return feature.operation
}

function offered(project: Project, id: string): boolean {
  return canChooseSubtract(resolvedProjectFeatures(project), id)
}

/**
 * For every row that is not already Subtract, the menu's prediction must match
 * the store: choosing Subtract either sticks (offered) or is rewritten to Add
 * (withheld). Returns the ids that offer Subtract.
 */
function checkEveryRow(project: Project, label: string): string[] {
  const offeredIds: string[] = []
  for (const feature of resolvedProjectFeatures(project)) {
    if (feature.operation === 'subtract' || feature.operation === 'model') continue
    const predicted = offered(project, feature.id)
    load(project)
    useProjectStore.getState().updateFeature(feature.id, { operation: 'subtract' })
    const kept = operationOf(feature.id) === 'subtract'
    assert(
      predicted === kept,
      `${label}: ${feature.id} (${feature.operation}) menu says ${predicted ? 'offered' : 'withheld'}, store ${kept ? 'kept Subtract' : `made it ${operationOf(feature.id)}`}`,
    )
    if (predicted) offeredIds.push(feature.id)
  }
  return offeredIds
}

function sameIds(actual: string[], expected: string[], label: string): void {
  assert(
    actual.join(',') === expected.join(','),
    `${label}: expected Subtract on [${expected.join(', ')}], got [${actual.join(', ')}]`,
  )
}

// ── The reported case: an SVG import of two closed Lines ─────────

{
  const project = buildProject([row('lineA', 'line'), row('lineB', 'line')])
  sameIds(checkEveryRow(project, 'two lines'), [], 'two lines')

  // The old menu offered Subtract here; the store turns it into Add.
  load(project)
  useProjectStore.getState().updateFeature('lineB', { operation: 'subtract' })
  assert(operationOf('lineB') === 'add', 'store still forces the would-be first solid to Add')
}

// ── An earlier Add unlocks Subtract below it, not above it ───────

{
  const lowerAdd = buildProject([row('lineA', 'line'), row('lineB', 'add')])
  sameIds(checkEveryRow(lowerAdd, 'add below'), [], 'Add below the line does not unlock it')

  const upperAdd = buildProject([row('lineA', 'add'), row('lineB', 'line')])
  sameIds(checkEveryRow(upperAdd, 'add above'), ['lineB'], 'Add above the line unlocks it')
}

// ── Reordering changes which row is first ─────────────────────────

{
  const project = buildProject([row('base', 'add'), row('line', 'line'), row('region', 'region'), row('ref', 'construction')])
  sameIds(checkEveryRow(project, 'before reorder'), ['line', 'region', 'ref'], 'every role below the base offers Subtract')

  load(project)
  useProjectStore.getState().moveFeatureTreeFeature('line', null, 'base')
  assert(resolvedProjectFeatures(useProjectStore.getState().project)[0].id === 'line', 'line now leads the tree')
  const reordered = useProjectStore.getState().project
  sameIds(checkEveryRow(reordered, 'line moved up'), ['region', 'ref'], 'a line moved above the base loses Subtract')
}

// ── Converting the base away hands the lock to the next solid ────

{
  const project = buildProject([row('base', 'add'), row('pocket', 'subtract'), row('line', 'line')])
  load(project)
  useProjectStore.getState().updateFeature('base', { operation: 'line' })
  const converted = useProjectStore.getState().project
  assert(operationOf('pocket') === 'add', 'pocket became the base solid')
  sameIds(checkEveryRow(converted, 'base converted'), ['line'], 'only rows below the new base offer Subtract')
}

// ── Linked copies share the definition's operation ───────────────

{
  // lineB is a linked copy of lineA. Subtract on lineB changes lineA too, and
  // lineA sits above the base, so Subtract is withheld on both.
  const project = buildProject([row('lineA', 'line'), row('base', 'add'), row('lineB', 'line', 'lineA')])
  sameIds(checkEveryRow(project, 'linked copy'), [], 'a linked copy above the base withholds Subtract')

  const below = buildProject([row('base', 'add'), row('lineA', 'line'), row('lineB', 'line', 'lineA')])
  sameIds(checkEveryRow(below, 'linked below'), ['lineA', 'lineB'], 'linked copies below the base offer Subtract')
}

// ── No features at all ────────────────────────────────────────────

assert(!canChooseSubtract([], 'missing'), 'an unknown row never offers Subtract')

console.log('subtractAvailability tests passed')
