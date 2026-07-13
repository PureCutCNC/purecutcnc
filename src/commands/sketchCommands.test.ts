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
 * Unit tests for shared sketch command predicate derivation.
 * Run with: npx tsx src/commands/sketchCommands.test.ts
 */

import type { Project, SketchFeature } from '../types/project'
import { newProject } from '../types/project'
import type { SelectionState } from '../store/types'
import { projectWithFeatures } from '../test/projectFixtures'
import { deriveSketchCommandState } from './sketchCommands'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function baseSketch() {
  return {
    profile: {
      start: { x: 0, y: 0 },
      closed: true,
      segments: [
        { type: 'line' as const, to: { x: 10, y: 0 } },
        { type: 'line' as const, to: { x: 10, y: 10 } },
        { type: 'line' as const, to: { x: 0, y: 10 } },
        { type: 'line' as const, to: { x: 0, y: 0 } },
      ],
    },
    origin: { x: 0, y: 0 },
    orientationAngle: 0,
    dimensions: [],
    constraints: [],
  }
}

function makeFeature(id: string, overrides: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: baseSketch(),
    operation: 'add',
    z_top: 0,
    z_bottom: -3,
    visible: true,
    locked: false,
    ...overrides,
  }
}

function makeProject(features: SketchFeature[]): Project {
  return projectWithFeatures(newProject('sketch-command-test', 'mm'), features)
}

function makeSelection(ids: string[], overrides: Partial<SelectionState> = {}): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: ids[0] ?? null,
    selectedFeatureIds: ids,
    selectedNode: ids[0] ? { type: 'feature', featureId: ids[0] } : null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
    ...overrides,
  }
}

function makeCommandState(
  project: Project,
  selection: SelectionState,
  overrides: Partial<Parameters<typeof deriveSketchCommandState>[0]> = {},
) {
  return deriveSketchCommandState({
    project,
    selection,
    pendingMove: null,
    pendingTransform: null,
    pendingOffset: null,
    pendingShapeAction: null,
    pendingConstraint: null,
    tapeMeasure: null,
    pendingDimension: null,
    dimensionDeleteArmed: false,
    ...overrides,
  })
}

function testLockedSelectionGating() {
  console.log('Testing locked-selection command gating...')

  const project = makeProject([makeFeature('feature-1', { locked: true })])
  const result = makeCommandState(project, makeSelection(['feature-1']))

  assert(result.predicates.hasLockedSelectedFeatures, 'locked selection predicate is true')
  assert(result.transform.copy.enabled, 'copy remains enabled for locked selection')
  assert(!result.transform.move.enabled, 'move is disabled for locked selection')
  assert(!result.transform.resize.enabled, 'resize is disabled for locked selection')
  assert(!result.transform.rotate.enabled, 'rotate is disabled for locked selection')
  assert(!result.transform.mirror.enabled, 'mirror is disabled for locked selection')
  assert(!result.boolean.offset.enabled, 'offset is disabled for locked selection')
  assert(!result.constraint.enabled, 'constraint is disabled for locked selection')

  console.log('locked-selection command gating: PASSED')
}

function testClosedProfileOffsetGating() {
  console.log('Testing closed-profile offset gating...')

  const closedProject = makeProject([makeFeature('closed')])
  const closedResult = makeCommandState(closedProject, makeSelection(['closed']))
  assert(closedResult.predicates.hasClosedSelectedFeatures, 'closed feature is detected')
  assert(closedResult.boolean.offset.enabled, 'offset is enabled for closed non-text feature')

  const openProject = makeProject([
    makeFeature('open', {
      kind: 'polygon',
      sketch: {
        ...baseSketch(),
        profile: {
          start: { x: 0, y: 0 },
          closed: false,
          segments: [
            { type: 'line', to: { x: 10, y: 0 } },
            { type: 'line', to: { x: 10, y: 10 } },
          ],
        },
      },
    }),
  ])
  const openResult = makeCommandState(openProject, makeSelection(['open']))
  assert(!openResult.predicates.hasClosedSelectedFeatures, 'open feature is not closed')
  assert(!openResult.boolean.offset.enabled, 'offset is disabled for open feature')

  const textProject = makeProject([makeFeature('text', { kind: 'text' })])
  const textResult = makeCommandState(textProject, makeSelection(['text']))
  assert(textResult.predicates.hasClosedSelectedFeatures, 'text feature can still have closed geometry')
  assert(!textResult.predicates.hasOffsetEligibleSelectedFeatures, 'text feature is not offset-eligible')
  assert(!textResult.boolean.offset.enabled, 'offset is disabled for text feature')

  console.log('closed-profile offset gating: PASSED')
}

function testArrangeThresholds() {
  console.log('Testing align/distribute thresholds...')

  const project = makeProject([
    makeFeature('feature-1'),
    makeFeature('feature-2'),
    makeFeature('feature-3'),
  ])

  const one = makeCommandState(project, makeSelection(['feature-1']))
  assert(!one.arrange.align.enabled, 'align disabled below two unlocked features')
  assert(!one.arrange.distribute.enabled, 'distribute disabled below three unlocked features')

  const two = makeCommandState(project, makeSelection(['feature-1', 'feature-2']))
  assert(two.arrange.align.enabled, 'align enabled at two unlocked features')
  assert(!two.arrange.distribute.enabled, 'distribute disabled at two unlocked features')

  const three = makeCommandState(project, makeSelection(['feature-1', 'feature-2', 'feature-3']))
  assert(three.arrange.align.enabled, 'align enabled at three unlocked features')
  assert(three.arrange.distribute.enabled, 'distribute enabled at three unlocked features')

  console.log('align/distribute thresholds: PASSED')
}

function testSketchEditActive() {
  console.log('Testing sketch-edit active predicate...')

  const project = makeProject([makeFeature('feature-1')])
  const selection = makeSelection([], {
    mode: 'sketch_edit',
    selectedFeatureId: 'feature-1',
    selectedFeatureIds: ['feature-1'],
    selectedNode: { type: 'feature', featureId: 'feature-1' },
    sketchEditTool: 'fillet',
  })
  const result = makeCommandState(project, selection)

  assert(result.predicates.featureSketchEditActive, 'feature sketch edit is active')
  assert(result.sketchEdit.add_point.enabled, 'sketch edit tools are enabled')
  assert(result.sketchEdit.chamfer.enabled, 'chamfer is enabled during sketch edit')
  assert(result.sketchEdit.fillet.active, 'active sketch edit tool is reflected')
  assert(!result.sketchEdit.add_point.active, 'inactive sketch edit tools are not active')

  const chamferResult = makeCommandState(project, { ...selection, sketchEditTool: 'chamfer' })
  assert(chamferResult.sketchEdit.chamfer.active, 'chamfer active state is reflected')
  assert(!chamferResult.sketchEdit.fillet.active, 'fillet is inactive while chamfer is active')

  console.log('sketch-edit active predicate: PASSED')
}

function testToggleActiveStates() {
  console.log('Testing pending toggle active states...')

  const project = makeProject([makeFeature('feature-1')])
  const selection = makeSelection(['feature-1'])
  const result = makeCommandState(project, selection, {
    pendingMove: { mode: 'copy', entityType: 'feature', entityIds: ['feature-1'], fromPoint: null, toPoint: null, session: 1 },
    pendingTransform: { mode: 'rotate', entityType: 'feature', entityIds: ['feature-1'], referenceStart: null, referenceEnd: null, keepOriginals: false, session: 1 },
    pendingOffset: { entityIds: ['feature-1'], session: 1 },
    pendingShapeAction: { kind: 'join', entityIds: ['feature-1'], keepOriginals: false, session: 1 },
    pendingConstraint: { featureId: 'feature-1', anchor: null, reference: null, session: 1 },
    pendingDimension: { type: 'horizontal', a: null, b: null, c: null, session: 1 },
    dimensionDeleteArmed: true,
  })

  assert(result.transform.copy.active, 'copy pending is active')
  assert(!result.transform.move.active, 'move is inactive when copy is pending')
  assert(result.transform.rotate.active, 'rotate pending is active')
  assert(result.boolean.offset.active, 'offset pending is active')
  assert(result.boolean.join.active, 'join pending is active')
  assert(!result.boolean.cut.active, 'cut inactive when join is pending')
  assert(result.constraint.active, 'constraint pending is active')
  assert(result.dimension.dimensionTypes.horizontal.active, 'pending dimension type is active')
  assert(result.dimension.deleteDimension.active, 'dimension delete armed is active')

  console.log('pending toggle active states: PASSED')
}

testLockedSelectionGating()
testClosedProfileOffsetGating()
testArrangeThresholds()
testSketchEditActive()
testToggleActiveStates()

console.log('All sketch command tests passed')
