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
 * What an operation's "What it cuts" group shows (issue #1102): the reach cards
 * only where two faces meet and no "Move…" on a rotary pass.
 *
 * The reach rule is per entry, not per operation: one operation can target a
 * single-sided pocket (no card — nothing has two sides) and a through-feature
 * (a card — it must be measured on both) at the same time.
 *
 * Run with: npx tsx src/components/cam/setupOperationControls.test.ts
 */

import assert from 'node:assert/strict'
import { canMoveOperation, visibleTargetReach } from './setupSections'
import type { TargetReach } from './setupSections'
import type { TargetFaceStatus, TargetFaceVerdict } from '../../engine/setupTargets'
import type { OperationKind } from '../../types/project'

function verdict(id: string, status: TargetFaceStatus, through = false): TargetFaceVerdict {
  return {
    featureId: id,
    featureName: id,
    authoringFace: 'top',
    through,
    model: false,
    status,
    rejection: status === 'rejected' ? 'crossFaceNotThrough' : null,
    depth: null,
  }
}

function reach(id: string, entry: TargetFaceVerdict): TargetReach {
  return { featureId: id, featureName: id, verdict: entry, range: null, coverage: null }
}

/** The ids the cards would render, in order. */
function shown(face: 'top' | 'bottom' | 'around', reaches: TargetReach[]): string[] {
  return visibleTargetReach(face, reaches).map((entry) => entry.featureId)
}

// A blind pocket on the setup's own face: one side only, so no card.
assert.deepEqual(shown('top', [reach('blind', verdict('blind', 'same-face'))]), [], 'a single-sided target has no card on Top')
assert.deepEqual(shown('bottom', [reach('blind', verdict('blind', 'same-face'))]), [], 'nor on Bottom')

// A through-feature reaches both faces: it must be measured on both.
assert.deepEqual(shown('top', [reach('pin', verdict('pin', 'same-face', true))]), ['pin'], 'a through target keeps its card')

// Cut from the other face: same reason.
assert.deepEqual(shown('bottom', [reach('pin', verdict('pin', 'cross-face', true))]), ['pin'], 'a cross-face target keeps its card')

// "Cannot reach" is an error the user has to see, so it keeps its card too.
assert.deepEqual(shown('top', [reach('wrong', verdict('wrong', 'rejected'))]), ['wrong'], 'a rejected target keeps its card')

// Around has no other face at all — not even a through or a rejected entry shows.
assert.deepEqual(
  shown('around', [reach('pin', verdict('pin', 'same-face', true)), reach('wrong', verdict('wrong', 'rejected'))]),
  [],
  'Around shows no reach cards',
)

// Mixed targets: only the ones worth measuring, in target order.
assert.deepEqual(
  shown('top', [
    reach('blind', verdict('blind', 'same-face')),
    reach('pin', verdict('pin', 'cross-face', true)),
    reach('wrong', verdict('wrong', 'rejected')),
  ]),
  ['pin', 'wrong'],
  'single-sided entries are dropped and the rest keep their order',
)

// Moving is offered for every operation that can live on more than one setup.
const movableKinds: OperationKind[] = [
  'plasma_profile', 'pocket', 'v_carve', 'v_carve_medial', 'edge_route_inside', 'edge_route_outside',
  'surface_clean', 'rough_surface', 'finish_surface', 'finish_surface_cleanup', 'follow_line', 'drilling',
]
for (const kind of movableKinds) {
  assert.equal(canMoveOperation(kind), true, `${kind} can be moved`)
}
// A rotary pass only ever lives on Around, so there is nowhere to move it.
assert.equal(canMoveOperation('rotary_rough'), false, 'rotary rough cannot be moved')
assert.equal(canMoveOperation('rotary_finish'), false, 'rotary finish cannot be moved')

console.log('setup operation controls tests passed')
