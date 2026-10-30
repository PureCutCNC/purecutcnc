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
 * and the flat plasma cut are not listed, and the rotary rough/finish rows
 * lead. On a square blank the round-only wrapped rows stay listed in place,
 * disabled with "Needs a round bar" — a changeable reason, so they are never
 * hidden behind the selection's disclosure.
 *
 * Mutations checked one at a time against these assertions:
 * - leaving the surface kinds or the plasma cut in the Around menu → the
 *   exclusion assertions fail;
 * - offering the rotary rows on Top (or after the flat kinds on Around) → the
 *   order assertion fails;
 * - dropping the square-blank rule → the round-only rows come back with no
 *   hint (or a selection reason), and the `needsRoundBar` / `blockedInPlace`
 *   assertions fail — this is the required "a round-only entry enabled on a
 *   square blank" check;
 * - hiding the round-only rows on a square blank instead of disabling them →
 *   the row-exists assertion fails;
 * - scanning "Select all" for a project-type refusal → the Top plasma row's
 *   empty-ids assertion fails (the original menu returned [] there).
 *
 * Run with: npx tsx src/components/cam/operationAddEntries.test.ts
 */

import {
  operationAddEntries,
  operationAddHint,
  operationAddKinds,
  validQuickOperationsForFeatureOnActiveFace,
} from './operationAddEntries'
import { selectAllCompatibleFeatureIds } from './operationValidity'
import { camT } from './camI18n'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { projectWithFeatures } from '../../test/projectFixtures'
import { squareStock } from '../../types/barStock'
import type { SelectionState } from '../../store/types'
import { rectProfile, type MachiningSetup, type OperationKind, type Project, type SketchFeature } from '../../types/project'

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
for (const kind of ['pocket', 'follow_line', 'drilling'] as const) {
  assert(aroundKinds.includes(kind), `Around still offers ${kind}`)
}
// A plasma cut goes through a flat plate; it does not belong on the sheet.
assert(!aroundKinds.includes('plasma_profile'), 'Around does not offer the flat plasma cut')

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

// ── A project-type refusal offers no "Select all" ──────────────────────
// The extraction once handed the plasma row a target set; the original menu
// returned [] for it, and a selection cannot make a plasma cut belong to a
// router project. The scan *would* find a target here, so a non-empty result
// is the mutation.
const topSheet = {
  ...ROUND.features.find((feature) => feature.id === 'sketch')!,
  id: 'top-sheet',
  name: 'Top sheet',
  authoringFace: 'top' as const,
  z_top: 6,
  z_bottom: 4,
}
const TOP_PROJECT: Project = {
  ...ROUND,
  activeSetupId: ROUND.setups[0].id,
  features: [...ROUND.features, topSheet],
}
assert(
  selectAllCompatibleFeatureIds(TOP_PROJECT, 'plasma_profile').length > 0,
  'the fixture has plasma-compatible targets for the scan to find',
)
const topPlasma = operationAddEntries(TOP_PROJECT, noSelection(), 'router', 'top')
  .find((entry) => entry.kind === 'plasma_profile')
assert(topPlasma, 'the flat menu still lists the plasma cut')
assert(
  topPlasma.hint === camT('cam.addMenu.needsPlasmaProject'),
  'the plasma row keeps its project-type reason',
)
assert(
  topPlasma.selectAllFeatureIds.length === 0,
  'a project-type refusal never offers "Select all"',
)

// ── A square blank disables the round-only rows, with the reason ──────

const squareEntries = operationAddEntries(SQUARE, noSelection(), 'router', 'around')
const squareByKind = new Map(squareEntries.map((entry) => [entry.kind, entry]))

for (const kind of ['pocket', 'v_carve', 'v_carve_medial', 'edge_route_inside', 'edge_route_outside', 'surface_clean', 'follow_line', 'drilling'] as const) {
  const entry = squareByKind.get(kind)
  assert(entry, `${kind} is kept in the square blank's Around menu, not hidden`)
  assert(
    entry.hint === camT('cam.addMenu.squareBarUnavailable'),
    `${kind} says the work is not available on a square bar, got "${entry.hint ?? 'no hint'}"`,
  )
  // The menu renders these in place rather than in the selection disclosure
  // (issue #1112 K review): the reason is the stock, not the selection.
  assert(entry.blockedInPlace, `${kind} is shown disabled in place, not behind a disclosure`)
}
// The rotary turning rows are the square blank's own work: they keep their
// model hint (or none), never the stock-shape refusal.
for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
  const entry = squareByKind.get(kind)
  assert(entry, `${kind} is offered on a square blank`)
  assert(
    entry.hint !== camT('cam.addMenu.squareBarUnavailable'),
    `${kind} is not refused for the stock shape`,
  )
  assert(!entry.blockedInPlace, `${kind} is not part of the stock-blocked rows`)
}
// A selection does not move the reason: the stock blocks the kind whatever is
// selected, and the reason must stay the one the user can act on.
assert(
  operationAddHint(SQUARE, modelSelection(), 'router', 'around', 'pocket')
    === camT('cam.addMenu.squareBarUnavailable'),
  'the square-blank reason wins over a selection-based hint',
)
// The flat plasma cut is not offered on Around at all, square or round: it
// belongs to the flat faces (decision 5).
assert(
  !squareByKind.has('plasma_profile'),
  'a plasma cut is not listed on the Around face',
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
    operationAddHint(ROUND, noSelection(), 'router', 'around', kind) !== camT('cam.addMenu.squareBarUnavailable'),
    `${kind} is not refused for the stock shape on a round bar`,
  )
}

// ── A feature's own Create-operation list, from another face (#1112 F2) ──

function kindsFor(project: Project, featureId: string): string {
  return validQuickOperationsForFeatureOnActiveFace(project, featureId).map((quickOp) => quickOp.kind).join()
}

/** The same fixture with `face` turned up, since the list follows the Add menu. */
function onFace(project: Project, face: 'top' | 'bottom'): Project {
  const setup: MachiningSetup = {
    ...project.setups[0],
    id: `setup-${face}`,
    name: face,
    orientation: { axis: 'x', angleDeg: face === 'bottom' ? 180 : 0 },
  }
  return { ...project, setups: [project.setups[0], setup], activeSetupId: setup.id }
}

// The fixture's model is authored on Top. On the Around face only the rotary
// rows can take it: the 2D kinds either cannot target a model from Around
// (`activeSetupTargetHint`) or are blocked by the square blank's stock, and the
// surface strategies are not offered on Around at all. An unfiltered list would
// bring Edge route outside / Surface clean back on the round bar, and the
// CAM panel's quick list (which asks the face without a kind) answers nothing.
assert(
  kindsFor(SQUARE, 'model') === 'rotary_rough,rotary_finish',
  `a model on a square blank's Around face is cut by the rotary rows, got "${kindsFor(SQUARE, 'model')}"`,
)
assert(
  kindsFor(ROUND, 'model') === 'rotary_rough,rotary_finish',
  `and on a round bar it is still the rotary rows, not the hidden flat ones, got "${kindsFor(ROUND, 'model')}"`,
)
// A wrapped 2D feature on its own face keeps the wrapped operations, and is not
// offered a rotary operation that would target the bar's model instead.
const aroundKindsForSketch = kindsFor(ROUND, 'sketch')
assert(aroundKindsForSketch.split(',').includes('pocket'), `an Around subtract can still be pocketed, got "${aroundKindsForSketch}"`)
assert(!aroundKindsForSketch.split(',').includes('rotary_rough'), 'a non-model feature is never offered a rotary operation')

// A blind feature on the other flat face is not a target of this face at all.
const blind: SketchFeature = {
  id: 'top-add',
  name: 'Top add',
  kind: 'rect',
  folderId: null,
  sketch: { profile: rectProfile(1, 1, 4, 4), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  operation: 'add',
  authoringFace: 'top',
  z_top: 11,
  z_bottom: 10,
  visible: true,
  locked: false,
}
const BLIND = projectWithFeatures(ROUND, [...ROUND.features, blind])
assert(
  kindsFor(onFace(BLIND, 'bottom'), 'top-add') === '',
  `an add that does not reach Bottom offers nothing there, got "${kindsFor(onFace(BLIND, 'bottom'), 'top-add')}"`,
)
// A through cut is the exception: the other flat face may machine it.
const through: SketchFeature = { ...blind, id: 'top-through', operation: 'subtract', z_top: 12, z_bottom: 0 }
const THROUGH = projectWithFeatures(ROUND, [...ROUND.features, through])
assert(
  kindsFor(onFace(THROUGH, 'bottom'), 'top-through').split(',').includes('pocket'),
  `a through cut can be pocketed from the other face, got "${kindsFor(onFace(THROUGH, 'bottom'), 'top-through')}"`,
)
// A feature the project does not have offers nothing.
assert(kindsFor(ROUND, 'no-such-feature') === '', 'an unknown feature id offers nothing')

console.log('operation add entries tests passed')
