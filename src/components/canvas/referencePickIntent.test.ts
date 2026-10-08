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

import { strict as assert } from 'node:assert'
import { useProjectStore } from '../../store/projectStore'
import type { ProjectStore } from '../../store/types'
import { referencePickIntent } from './referencePickIntent'

const base = useProjectStore.getState()
const idle = { ...base, pendingAdd: null, pendingMove: null, pendingTransform: null, pendingOffset: null,
  pendingConstraint: null, pendingShapeAction: null, pendingSketchEdit: null, pendingFeatureDistribution: null,
  pendingTextLayout: null, pendingDimension: null, tapeMeasure: null,
  selection: { ...base.selection, mode: 'feature' as const } }
const intent = (patch: Partial<ProjectStore> = {}) => referencePickIntent({ ...idle, ...patch })
assert.equal(intent(), null, 'ordinary selection never sees foreign references')
assert.equal(intent({ selection: { ...idle.selection, mode: 'sketch_edit' } }), 'point', 'own sketch placement accepts points')
assert.equal(intent({ pendingAdd: { shape: 'rect', anchor: null, session: 1 } }), 'point')
assert.equal(intent({ tapeMeasure: { first: null, frozen: null } }), 'point')
assert.equal(intent({ pendingDimension: { type: 'horizontal', a: null, b: null, c: null, session: 1 } }), 'point')
const distribution: NonNullable<ProjectStore['pendingFeatureDistribution']> = {
  sourceIds: ['subject'], guideId: null, pickTarget: 'guide', radialCenterPicked: false, session: 1,
  spec: { mode: 'path', copyCount: 2, startOffset: 0, endOffset: 0, orientation: 'follow', startScale: 100, endScale: 100 },
}
assert.equal(intent({ pendingFeatureDistribution: distribution }), 'distribution-guide')
assert.equal(intent({ pendingFeatureDistribution: { ...distribution, pickTarget: 'radial-center' } }), 'point')
assert.equal(intent({ pendingFeatureDistribution: { ...distribution, pickTarget: null } }), null, 'configuration is not picking')
const text: NonNullable<ProjectStore['pendingTextLayout']> = { featureId: 'run', layout: null, center: null,
  guideId: null, pickTarget: 'guide', directionPinned: false, session: 1 }
assert.equal(intent({ pendingTextLayout: text }), 'text-guide')
assert.equal(intent({ pendingTextLayout: { ...text, pickTarget: 'center' } }), 'point')
assert.equal(intent({ pendingSketchEdit: { tool: 'trim', phase: 'pick-reference' } }), 'segment')
assert.equal(intent({ pendingSketchEdit: { tool: 'extend', phase: 'pick-subject' } }), null, 'subject picking cannot read ghosts')
const constraint: NonNullable<ProjectStore['pendingConstraint']> = { featureId: 'subject', anchor: null, reference: null, session: 1 }
assert.equal(intent({ pendingConstraint: constraint, pendingTextLayout: text }), null, 'constraint exclusions win over stale reference state')
assert.equal(intent({ pendingShapeAction: { kind: 'join', entityIds: ['subject'], keepOriginals: true, session: 1 }, pendingFeatureDistribution: distribution }), null, 'join operands stay face-local')
console.log('referencePickIntent tests passed')
