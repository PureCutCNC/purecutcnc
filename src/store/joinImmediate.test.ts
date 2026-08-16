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
 * Skipping the confirmation panel when the selection already qualifies
 * (issue #522).
 *
 * Two halves, and the second matters more than the first:
 *
 * - a qualifying selection joins outright, in one undoable step;
 * - **every** non-qualifying selection still opens the panel, and no member of
 *   the selection is silently dropped on either path. The dangerous shape here
 *   is a *partial* qualification: `startJoinSelectedFeatures` narrows to the
 *   largest connected group, so auto-joining a selection with a stray member
 *   would consume the rest and quietly leave the stray behind.
 *
 * Run with: npx tsx src/store/joinImmediate.test.ts
 */

import {
  IDENTITY_MATRIX,
  newProject,
  rectProfile,
  type FeatureDefinition,
  type FeatureInstance,
  type FeatureKind,
  type FeatureOperation,
  type Project,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

// ── Helpers ────────────────────────────────────────────────────────

interface RectOptions {
  operation?: FeatureOperation
  kind?: FeatureKind
  locked?: boolean
  closed?: boolean
}

function resetStore(): void {
  useProjectStore.setState({
    project: newProject(),
    selection: { selectedFeatureIds: [], selectedTabIds: [], selectedClampIds: [] },
    pendingShapeAction: null,
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)
}

/** Add a strict instance + canonical definition via direct state mutation. */
function addRect(id: string, x: number, y: number, w: number, h: number, options: RectOptions = {}): void {
  const profile = rectProfile(x, y, w, h)
  const definition: FeatureDefinition = {
    id: `def-${id}`,
    kind: options.kind ?? 'rect',
    profile: options.closed === false ? { ...profile, closed: false } : profile,
    dimensions: [],
    text: options.kind === 'text' ? { text: 'Hi', style: 'outline', font: 'simple_stroke', size: 10 } : null,
    stl: null,
    operation: options.operation ?? 'add',
  } as FeatureDefinition
  const feature: FeatureInstance = {
    id,
    name: id,
    definitionId: `def-${id}`,
    transform: { ...IDENTITY_MATRIX },
    constraints: [],
    folderId: null,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: options.locked ?? false,
  }

  const state = useProjectStore.getState()
  useProjectStore.setState({
    project: {
      ...state.project,
      features: [...state.project.features, feature],
      featureDefinitions: { ...state.project.featureDefinitions, [`def-${id}`]: definition },
    },
  } as unknown as Partial<ProjectStore>)
}

function selectFeatures(ids: string[]): void {
  useProjectStore.setState({
    selection: {
      ...useProjectStore.getState().selection,
      selectedFeatureIds: ids,
      selectedFeatureId: ids.at(-1) ?? null,
      selectedNode: ids.length > 0 ? { type: 'feature', featureId: ids[ids.length - 1] } : null,
      mode: 'feature',
      activeControl: null,
    },
  } as unknown as Partial<ProjectStore>)
}

function getProject(): Project {
  return useProjectStore.getState().project
}

function featureIds(): string[] {
  return getProject().features.map((feature) => feature.id)
}

function joinPanelIds(): string[] | null {
  const pending = useProjectStore.getState().pendingShapeAction
  return pending?.kind === 'join' ? pending.entityIds : null
}

/** Two overlapping rects that qualify on every clause. */
function seedQualifyingPair(options: RectOptions = {}): void {
  resetStore()
  addRect('a', 0, 0, 10, 10, options)
  addRect('b', 5, 0, 10, 10, options)
  selectFeatures(['a', 'b'])
}

/** Asserts the panel opened and nothing was merged. */
function assertPanelOpened(reason: string): void {
  assert(joinPanelIds() !== null, `${reason}: the join panel must still open`)
  assert(featureIds().includes('a'), `${reason}: originals must survive`)
  assert(featureIds().includes('b'), `${reason}: originals must survive`)
}

// ────────────────────────────────────────────────────────────────────

console.log('\nJoin — skip the confirmation panel for a qualifying selection (issue #522)')

test('a qualifying selection joins outright, with no panel', () => {
  seedQualifyingPair()

  useProjectStore.getState().startJoinSelectedFeatures()

  assert(joinPanelIds() === null, 'no join panel may be left pending')
  const ids = featureIds()
  assert(ids.length === 1, `originals must be replaced by one merged feature, got ${ids.length}`)
  assert(!ids.includes('a') && !ids.includes('b'), `originals must be consumed, got ${ids.join(',')}`)
  assert(
    useProjectStore.getState().selection.selectedFeatureIds.join(',') === ids[0],
    'the merged feature must be left selected',
  )
})

test('the immediate join is a single undo step', () => {
  seedQualifyingPair()

  useProjectStore.getState().startJoinSelectedFeatures()
  useProjectStore.getState().undo()

  const ids = featureIds().sort()
  assert(ids.join(',') === 'a,b', `one undo must restore both originals, got ${ids.join(',')}`)
})

test('a partially qualifying selection keeps its panel and drops nothing', () => {
  resetStore()
  addRect('a', 0, 0, 10, 10)
  addRect('b', 5, 0, 10, 10)
  addRect('stray', 100, 100, 10, 10)
  selectFeatures(['a', 'b', 'stray'])

  useProjectStore.getState().startJoinSelectedFeatures()

  const panelIds = joinPanelIds()
  assert(panelIds !== null, 'a selection with a disconnected member must open the panel')
  assert(panelIds.length === 2, `the panel must narrow to the connected group, got ${panelIds.join(',')}`)
  const ids = featureIds().sort()
  assert(ids.join(',') === 'a,b,stray', `nothing may be merged behind the prompt, got ${ids.join(',')}`)
})

test('one selected feature still opens the picking mode', () => {
  resetStore()
  addRect('a', 0, 0, 10, 10)
  addRect('b', 5, 0, 10, 10)
  selectFeatures(['a'])

  useProjectStore.getState().startJoinSelectedFeatures()

  assert(joinPanelIds()?.join(',') === 'a', 'a single selection must start a join session, not a join')
  assert(featureIds().length === 2, 'nothing may be merged from a one-feature selection')
})

test('no selection opens the picking mode', () => {
  resetStore()
  addRect('a', 0, 0, 10, 10)
  addRect('b', 5, 0, 10, 10)
  selectFeatures([])

  useProjectStore.getState().startJoinSelectedFeatures()

  assert(joinPanelIds()?.length === 0, 'pressing Join with nothing selected must start an empty join session')
  assert(featureIds().length === 2, 'nothing may be merged from an empty selection')
})

// Defence in depth: an open member also fails the connectivity clause, since
// `featuresOverlap` rejects open profiles outright. The explicit closed check
// stays because the reason it matters — `mergeSelectedFeatures` silently
// filters open profiles out — is about the merge, not about connectivity, and
// should not depend on a second helper keeping that property.
test('an open profile in the selection keeps the panel', () => {
  seedQualifyingPair()
  addRect('open', 5, 0, 10, 10, { closed: false })
  selectFeatures(['a', 'b', 'open'])

  useProjectStore.getState().startJoinSelectedFeatures()

  assert(joinPanelIds() !== null, 'an open member would be silently filtered by the merge — keep the prompt')
  assert(featureIds().includes('open'), 'the open feature must survive')
})

test('a locked feature keeps the panel', () => {
  seedQualifyingPair({ locked: true })

  useProjectStore.getState().startJoinSelectedFeatures()

  assertPanelOpened('locked selection')
})

test('a text feature keeps the panel', () => {
  seedQualifyingPair({ kind: 'text' })

  useProjectStore.getState().startJoinSelectedFeatures()

  assertPanelOpened('text selection')
})

test('imported model features keep the panel', () => {
  seedQualifyingPair({ operation: 'model' })

  useProjectStore.getState().startJoinSelectedFeatures()

  assertPanelOpened('model selection')
})

test('a mixed add/subtract selection keeps the panel', () => {
  resetStore()
  addRect('a', 0, 0, 10, 10, { operation: 'add' })
  addRect('b', 5, 0, 10, 10, { operation: 'subtract' })
  selectFeatures(['a', 'b'])

  useProjectStore.getState().startJoinSelectedFeatures()

  assertPanelOpened('mixed-operation selection')
})

test('a shared non-add operation still qualifies', () => {
  seedQualifyingPair({ operation: 'subtract' })

  useProjectStore.getState().startJoinSelectedFeatures()

  assert(joinPanelIds() === null, 'two subtract features are unambiguous and must join outright')
  const merged = getProject().features
  assert(merged.length === 1, `expected one merged feature, got ${merged.length}`)
  assert(
    getProject().featureDefinitions[merged[0].definitionId].operation === 'subtract',
    'the merged feature must keep the shared operation',
  )
})

test('the panel path still merges when it is confirmed', () => {
  resetStore()
  addRect('a', 0, 0, 10, 10)
  addRect('b', 5, 0, 10, 10)
  addRect('stray', 100, 100, 10, 10)
  selectFeatures(['a', 'b', 'stray'])

  useProjectStore.getState().startJoinSelectedFeatures()
  const created = useProjectStore.getState().completePendingShapeAction()

  assert(created.length === 1, `confirming the panel must still merge, got ${created.length}`)
  const ids = featureIds().sort()
  assert(ids.join(',') === `${created[0]},stray`, `only the group may be consumed, got ${ids.join(',')}`)
})

console.log('\nCut — skip the cutter phase for an unambiguous cutter (issue #522)')

test('one selected feature opens cut on target selection', () => {
  resetStore()
  addRect('a', 0, 0, 10, 10)
  addRect('b', 5, 0, 10, 10)
  selectFeatures(['a'])

  useProjectStore.getState().startCutSelectedFeatures()

  const pending = useProjectStore.getState().pendingShapeAction
  assert(pending?.kind === 'cut', 'cut must be pending')
  assert(pending.phase === 'targets', `an unambiguous cutter must skip the cutter phase, got ${pending.phase}`)
  assert(pending.cutterIds.join(',') === 'a', `the selection must become the cutter, got ${pending.cutterIds.join(',')}`)
})

test('two selected features keep the cutter phase', () => {
  resetStore()
  addRect('a', 0, 0, 10, 10)
  addRect('b', 5, 0, 10, 10)
  selectFeatures(['a', 'b'])

  useProjectStore.getState().startCutSelectedFeatures()

  const pending = useProjectStore.getState().pendingShapeAction
  assert(pending?.kind === 'cut', 'cut must be pending')
  assert(pending.phase === 'cutters', 'cutter-vs-target is ambiguous with two selected — keep the phase')
})

test('a locked feature keeps the cutter phase', () => {
  resetStore()
  addRect('a', 0, 0, 10, 10, { locked: true })
  selectFeatures(['a'])

  useProjectStore.getState().startCutSelectedFeatures()

  const pending = useProjectStore.getState().pendingShapeAction
  assert(pending?.kind === 'cut', 'cut must be pending')
  assert(pending.phase === 'cutters', 'a locked cutter must not be locked in')
})

test('no selection opens cut on the cutter phase', () => {
  resetStore()
  addRect('a', 0, 0, 10, 10)
  selectFeatures([])

  useProjectStore.getState().startCutSelectedFeatures()

  const pending = useProjectStore.getState().pendingShapeAction
  assert(pending?.kind === 'cut', 'cut must be pending')
  assert(pending.phase === 'cutters', 'with nothing selected the cutter phase is the whole point')
})

// ── Results ─────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed${failed > 0 ? ' ❌' : ' ✓'}\n`)

if (failed > 0) throw new Error(`${failed} test(s) failed`)
