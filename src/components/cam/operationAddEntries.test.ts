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
 * What the Add operation menu offers, per face and stock shape (issue #1112
 * slice K, decision 5).
 *
 * On Around the menu shows only what Around can do: the 3D surface strategies
 * are not listed, and the rotary rough/finish rows lead. On a square blank the
 * round-only wrapped rows stay listed, disabled with "Needs a round bar" — a
 * changeable reason, so they are never hidden.
 *
 * Mutations checked one at a time against these assertions:
 * - leaving the surface kinds in the Around menu → the exclusion assertion
 *   fails;
 * - offering the rotary rows on Top (or after the flat kinds on Around) → the
 *   order assertion fails;
 * - dropping the square-blank rule → the round-only rows come back with no
 *   hint (or a selection reason), and the `needsRoundBar` assertion fails —
 *   this is the required "a round-only entry enabled on a square blank" check;
 * - hiding the round-only rows on a square blank instead of disabling them →
 *   the row-exists assertion fails.
 *
 * Run with: npx tsx src/components/cam/operationAddEntries.test.ts
 */

import { operationAddEntries, operationAddHint, operationAddKinds } from './operationAddEntries'
import { camT } from './camI18n'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { squareStock } from '../../types/barStock'
import type { SelectionState } from '../../store/types'
import type { OperationKind, Project } from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function noSelection(): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: null,
    selectedFeatureIds: [],
    selectedTabIds: [],
    selectedClampIds: [],
    selectedNode: null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
  }
}

function modelSelection(): SelectionState {
  return { ...noSelection(), selectedFeatureId: 'model', selectedFeatureIds: ['model'] }
}

/** The same fixture on a square blank of the same physical box. */
function square(project: Project): Project {
  return { ...project, stock: squareStock(12, 30, 'x') }
}

const ROUND = rotaryOperationFixture('x', 'rotary_rough')
const SQUARE = square(ROUND)
const AROUND_SURFACE: readonly OperationKind[] = ['rough_surface', 'finish_surface', 'finish_surface_cleanup']

// ── Around lists only the work it can cut ─────────────────────────────

const aroundKinds = operationAddKinds(ROUND, 'around')
assert(
  !aroundKinds.some((kind) => AROUND_SURFACE.includes(kind)),
  `the Around menu has no 3D surface strategy, got ${aroundKinds.join(',')}`,
)
assert(
  aroundKinds[0] === 'rotary_rough' && aroundKinds[1] === 'rotary_finish',
  `the rotary rows lead the Around menu, got ${aroundKinds.slice(0, 3).join(',')}`,
)
for (const kind of ['pocket', 'follow_line', 'drilling', 'plasma_profile'] as const) {
  assert(aroundKinds.includes(kind), `Around still offers ${kind}`)
}

// On a flat face the surface strategies are back and the rotary rows are gone.
const topKinds = operationAddKinds(ROUND, 'top')
assert(
  AROUND_SURFACE.every((kind) => topKinds.includes(kind)),
  'a flat face still offers the 3D surface strategies',
)
assert(
  !topKinds.includes('rotary_rough') && !topKinds.includes('rotary_finish'),
  'the rotary rows stay out of the flat-face menu (issue #1015)',
)

// ── A square blank disables the round-only rows, with the reason ──────

const squareEntries = operationAddEntries(SQUARE, noSelection(), 'router', 'around')
const squareByKind = new Map(squareEntries.map((entry) => [entry.kind, entry]))

for (const kind of ['pocket', 'v_carve', 'v_carve_medial', 'edge_route_inside', 'edge_route_outside', 'surface_clean', 'follow_line', 'drilling'] as const) {
  const entry = squareByKind.get(kind)
  assert(entry, `${kind} is kept in the square blank's Around menu, not hidden`)
  assert(
    entry.hint === camT('cam.addMenu.needsRoundBar'),
    `${kind} says "Needs a round bar" on a square blank, got "${entry.hint ?? 'no hint'}"`,
  )
}
// The rotary turning rows are the square blank's own work: they keep their
// model hint (or none), never the stock-shape refusal.
for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
  const entry = squareByKind.get(kind)
  assert(entry, `${kind} is offered on a square blank`)
  assert(
    entry.hint !== camT('cam.addMenu.needsRoundBar'),
    `${kind} is not refused for the stock shape`,
  )
}
// A selection does not move the reason: the stock blocks the kind whatever is
// selected, and the reason must stay the one the user can act on.
assert(
  operationAddHint(SQUARE, modelSelection(), 'router', 'around', 'pocket')
    === camT('cam.addMenu.needsRoundBar'),
  'the square-blank reason wins over a selection-based hint',
)
// The project-type reason still comes first, as it does on every face.
assert(
  squareByKind.get('plasma_profile')?.hint === camT('cam.addMenu.needsPlasmaProject'),
  'a plasma cut keeps its project-type reason on a square blank',
)
// Nothing extra is hidden: every round-bar Around row is present on the blank.
assert(
  squareEntries.length === operationAddEntries(ROUND, noSelection(), 'router', 'around').length,
  'the square blank keeps the same rows as the round bar',
)

// On a round bar the same rows are available (or blocked by the selection),
// never by the stock.
for (const kind of ['pocket', 'follow_line'] as const) {
  assert(
    operationAddHint(ROUND, noSelection(), 'router', 'around', kind) !== camT('cam.addMenu.needsRoundBar'),
    `${kind} is not refused for the stock shape on a round bar`,
  )
}

console.log('operation add entries tests passed')
