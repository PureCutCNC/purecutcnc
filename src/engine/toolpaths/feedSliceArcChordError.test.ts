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

// Pocket feed reduction slices cut moves where engagement changes. A slice of
// a sampled chord bows no more than the whole chord, so it keeps the chord's
// export allowance (#1253 review).

import assert from 'node:assert/strict'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { projectWithFeatures } from '../../test/projectFixtures'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation } from '../../types/project'
import { generatePocketToolpath } from './pocket'
import type { ToolpathMove } from './types'

const tool = { ...defaultTool('mm', 1), id: 't1', diameter: 6.35 }
const base = newProject('Feed slices keep chord allowances', 'mm')
const project = projectWithFeatures({
  ...base,
  stock: { ...base.stock, thickness: 18, profile: rectProfile(0, 0, 230, 200) },
  tools: [tool],
  origin: { name: 'Origin', x: 0, y: 200, z: 18, visible: true },
}, [{
  id: 'target', name: 'Target', folderId: null, kind: 'composite', operation: 'subtract',
  z_top: 18, z_bottom: 14, locked: false, visible: true,
  sketch: {
    profile: circleProfile(110, 90, 45), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
  },
}])
const plain: Operation = {
  ...defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: ['target'] }, 0),
  entryStrategy: 'plunge',
  arcFittingEnabled: true,
  pocketSlotFeedPercent: undefined,
  pocketFeedReduction: undefined,
}

const cuts = (moves: ToolpathMove[]): ToolpathMove[] => moves.filter(move => move.kind === 'cut')
const length = (move: ToolpathMove): number => Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
const allowed = (moves: ToolpathMove[]): number =>
  cuts(moves).filter(move => move.arcChordError !== undefined).reduce((sum, move) => sum + length(move), 0)

const reference = generatePocketToolpath(project, plain).moves
assert(allowed(reference) > 0, 'the circular pocket rings must carry allowances')
// Engagement feed reduction slices ring chords where engagement changes.
for (const reduction of [{ pocketSlotFeedPercent: 40, pocketFeedReduction: 'engagement' as const }]) {
  const label = JSON.stringify(reduction)
  const moves = generatePocketToolpath(project, { ...plain, ...reduction }).moves
  assert(cuts(moves).some(move => move.feedScale !== undefined), `${label}: some cuts must be slowed`)
  assert(cuts(moves).length > cuts(reference).length, `${label}: feed changes must slice some cuts`)
  assert(Math.abs(allowed(moves) - allowed(reference)) < 1e-6,
    `${label}: sliced chords must keep their allowance (${allowed(moves)} vs ${allowed(reference)} mm)`)
}
console.log('Feed slices keep chord allowances: PASSED')
