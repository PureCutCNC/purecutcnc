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
 * The operation a new canned outline shape defaults to, per face (issue #1112
 * R2 item 14).
 *
 * Frank: "a gear created on the Around face came out as Add." On the unrolled
 * Around sheet the bar is already the material (#395, #1108), so a shape drawn
 * there is a cut into the bar — exactly the rule a hand-drawn outline follows
 * (`inferManualFeatureOperation`). A gear is one canned feature like the rest,
 * but the gear action had its own "the first machining feature is Add" rule,
 * which is right on Top/Bottom (a block's base solid) and wrong on Around.
 * These tests pin each canned kind by the real store action, first-feature and
 * later, on both bar shapes and on a block, so "Top/Bottom unchanged" is proven
 * rather than assumed.
 *
 * A square blank's Around sheet is round-only for authoring (#1016 C2-U1): its
 * frozen policy test (`squareAroundPolicy.test.ts`, four axis/unit specs) pins
 * that every Around authoring path — `addFeature`, the drawing tools, imports,
 * paste, and both gear branches — writes nothing on it, and rt2-c keeps those
 * drawer entries visible-but-disabled while #1128 owns sheet work. That
 * refusal is therefore *not* item 14's default and must not be lifted here: a
 * square blank authors Top and Bottom, so its coverage is two-fold.
 *  1. Real creation of every named kind on the square blank's authorable
 *     faces (Top and Bottom) is a cut into the bar, proving the bar-is-material
 *     rule through the store actions rather than a draft;
 *  2. its Around *default* is pinned per kind at the point creation decides
 *     it — `buildShapeFeature` is the draft builder every canned creator
 *     passes its profile to, and `gearCreationOperation` is the first-gear
 *     rule the gear action applies to that draft — so enabling the sheet
 *     later (#1128) cannot quietly bring the gear's Add back.
 *
 * Mutations checked one at a time against these assertions:
 * - dropping the `face !== 'around'` condition in `gearCreationOperation`
 *   (i.e. the first gear on Around goes back to Add) → the Around gear
 *   assertions fail, on the round bar and on the square blank's draft;
 * - making that condition unconditional (every face subtract) → the Top and
 *   Bottom assertions fail;
 * - removing `inferManualFeatureOperation` from `buildShapeFeature`'s closed
 *   path (so a canned shape is always Add) → every Around assertion fails;
 * - scoping the bar-is-material branch of `inferManualFeatureOperation` to a
 *   round bar (`barSeedsModel` && round stock) (so a square bar classifies like
 *   a block) → the square-blank real-creation assertions on Top and Bottom
 *   (every kind) fail, and so do its Around creation-draft assertions;
 * - dropping the square-blank guard in `addFeature` / `createAddGearFeatureAction`
 *   (so a cutting outline is authored on the round-only sheet) → the
 *   square-Around refusal assertions fail.
 *
 * Run with: npx tsx src/store/cannedShapeAroundDefaults.test.ts
 */

import {
  newProject,
  ellipseProfile,
  ngonProfile,
  roundStock,
  slotProfile,
  type Project,
  type SketchFeature,
  type SketchProfile,
  type Stock,
} from '../types/project'
import { squareStock } from '../types/barStock'
import { buildGearProfile, defaultGearCreationParams } from '../sketch/gearProfile'
import { bundledMachines } from '../machine/registry'
import { validateMachineDefinition } from '../engine/gcode/types'
import { resolveCannedShapeShapes } from '../cannedShapes'
import { useProjectStore } from './projectStore'
import { switchWorkspaceFace } from './workspaceFace'
import { activeFace } from './helpers/activeFace'
import { buildShapeFeature } from './helpers/buildShapeFeature'
import { gearCreationOperation } from './helpers/gearFeature'
import { chamferedRectProfile, roundedRectProfile } from './helpers/cannedRectProfiles'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import type { ProjectStore } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`)
  }
}

const ROUND_BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })
const SQUARE_BAR = squareStock(40, 200, 'x', { x: 10, y: 30 })

function projectWith(stock: Stock, type: 'milling' | 'rotary'): Project {
  const base = newProject('Canned defaults', 'mm')
  base.stock = stock
  base.meta.projectType = type
  if (type === 'rotary') {
    const machine = validateMachineDefinition({
      ...structuredClone(bundledMachines()[0]),
      id: 'canned-defaults',
      rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
    })
    base.meta.machineDefinitions = [machine]
    base.meta.selectedMachineId = machine.id
  }
  return base
}

function resetStore(project: Project): void {
  useProjectStore.setState({
    project,
    creationTarget: 'feature',
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: [],
      selectedNode: null,
      mode: 'feature' as const,
      sketchEditTool: null,
      activeControl: null,
      hoveredFeatureId: null,
      groupFolderId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    sketchEditSession: null,
    pendingConstraint: null,
    pendingTransform: null,
    pendingOffset: null,
    pendingAdd: null,
    pendingMove: null,
    pendingShapeAction: null,
  } as unknown as Partial<ProjectStore>)
}

/** One creation call per canned outline kind, through the action the UI uses. */
const CANNED_CREATORS: ReadonlyArray<[kind: string, create: () => unknown]> = [
  ['ellipse', () => useProjectStore.getState().addEllipseFeature('Ellipse', 10, 10, 4, 3, 5)],
  ['slot', () => useProjectStore.getState().addSlotFeature('Slot', { x: 10, y: 20 }, { x: 30, y: 20 }, 4, 5)],
  ['ngon', () => useProjectStore.getState().addNgonFeature('Polygon', 20, 30, 6, 5, 0, 5)],
  ['roundrect', () => useProjectStore.getState().addRoundRectFeature('Rounded rect', 10, 10, 20, 10, 2, 5)],
  ['chamferrect', () => useProjectStore.getState().addChamferRectFeature('Chamfered rect', 10, 10, 20, 10, 2, 5)],
]

/**
 * The profile each canned creator passes to `buildShapeFeature` — the one call
 * that decides the operation a new canned shape is created with. These are the
 * same arguments the creators above use, so the draft the default is read from
 * is the draft creation would write.
 */
const CANNED_DRAFT_PROFILES: ReadonlyArray<[kind: string, profile: () => SketchProfile]> = [
  ['ellipse', () => ellipseProfile(10, 10, 4, 3)],
  ['slot', () => slotProfile({ x: 10, y: 20 }, { x: 30, y: 20 }, 4)],
  ['ngon', () => ngonProfile(20, 30, 6, 5, 0)],
  ['roundrect', () => roundedRectProfile({ x: 10, y: 10 }, { x: 30, y: 20 }, 2)],
  ['chamferrect', () => chamferedRectProfile({ x: 10, y: 10 }, { x: 30, y: 20 }, 2)],
]

/** The gear profile the gear action builds, at the size the fixtures use. */
function gearProfile(): SketchProfile {
  return buildGearProfile({
    ...defaultGearCreationParams(8),
    center: { x: 40, y: 30 },
    outsideRadius: 8,
  })
}

/** The gear through the placement + completion path the canvas button uses. */
function createGear(center = { x: 40, y: 30 }, radius = 8): string[] {
  const store = useProjectStore.getState()
  store.startAddGearPlacement()
  useProjectStore.getState().setPendingAddAnchor(center)
  useProjectStore.getState().setPendingGearRadiusAt({ x: center.x + radius, y: center.y })
  return useProjectStore.getState().completePendingGear()
}

/** The operation on each created row, read the way the tree and CAM read it. */
function operations(): string[] {
  return useProjectStore.getState().project.features.map((row) => {
    const resolved = resolveFeatureInstance(useProjectStore.getState().project, row.id)
    assert(resolved, `row ${row.id} resolves`)
    return resolved.operation
  })
}

function onFace(project: Project, face: 'top' | 'bottom' | 'around'): void {
  resetStore(project)
  const switched = switchWorkspaceFace(face)
  assert(switched, `the workspace reaches ${face}`)
  assertEqual(activeFace(useProjectStore.getState().project), face, `the workspace is on ${face}`)
}

function createdFeature(id: string): SketchFeature {
  const feature = resolveFeatureInstance(useProjectStore.getState().project, id)
  assert(feature != null, `feature ${id} should exist`)
  return feature
}

function testEveryCannedKindOnAroundCutsIntoTheBar(): void {
  for (const [kind, create] of CANNED_CREATORS) {
    onFace(projectWith(ROUND_BAR, 'rotary'), 'around')
    create()
    assertEqual(operations(), ['subtract'], `a first ${kind} on Around cuts into the bar`)
  }
  onFace(projectWith(ROUND_BAR, 'rotary'), 'around')
  const gearIds = createGear()
  assertEqual(gearIds.length, 1, 'the gear is created on Around')
  assertEqual(operations(), ['subtract'], 'a first gear on Around cuts into the bar, not Add')
  console.log('around: every canned outline shape is a cut: PASSED')
}

function testLaterShapesOnAroundStillNest(): void {
  // The fix must not replace the classifier: once a subtract exists, a canned
  // shape inside it is an island again, exactly as before.
  onFace(projectWith(ROUND_BAR, 'rotary'), 'around')
  assertEqual(createGear({ x: 40, y: 30 }, 15).length, 1, 'the outer gear is created')
  useProjectStore.getState().addEllipseFeature('Ellipse', 40, 30, 3, 3, 5)
  assertEqual(operations(), ['subtract', 'add'], 'a shape inside the gear cut is an island')
  console.log('around: later shapes still nest: PASSED')
}

function testGearBoreOnAroundIsAnAddIsland(): void {
  onFace(projectWith(ROUND_BAR, 'rotary'), 'around')
  const store = useProjectStore.getState()
  store.startAddGearPlacement()
  useProjectStore.getState().setPendingAddAnchor({ x: 40, y: 30 })
  useProjectStore.getState().setPendingGearRadiusAt({ x: 55, y: 30 })
  useProjectStore.getState().setPendingGearParams({ boreDiameter: 6 })
  const ids = useProjectStore.getState().completePendingGear()
  assertEqual(ids.length, 1, 'the gear is created')
  const gear = createdFeature(ids[0])
  assertEqual(gear.operation, 'subtract', 'the gear itself is a cut')
  assertEqual(
    resolveCannedShapeShapes(gear).map((shape) => shape.operation),
    ['subtract', 'add'],
    'its bore is an Add island, the reverse of the Top gear',
  )
  console.log('around: gear bore nests as an Add island: PASSED')
}

function testTopAndBottomKeepTheirDefaults(): void {
  // A block's first closed shape is its base solid, so every kind is Add.
  for (const face of ['top', 'bottom'] as const) {
    for (const [kind, create] of CANNED_CREATORS) {
      onFace(projectWith(newProject('Block', 'mm').stock, 'milling'), face)
      create()
      assertEqual(operations(), ['add'], `a first ${kind} on a block's ${face} is the base solid`)
    }
    onFace(projectWith(newProject('Block', 'mm').stock, 'milling'), face)
    assertEqual(createGear().length, 1, `the gear is created on ${face}`)
    assertEqual(operations(), ['add'], `a first gear on a block's ${face} is the base solid`)
  }

  // On a bar the bar is the material on every face, so a hand-drawn or canned
  // outline is a cut there too. The gear action's historical first-gear Add is
  // kept on Top/Bottom on purpose (issue #1112 R2 item 14 scopes the change to
  // Around), so it is pinned here rather than quietly aligned.
  for (const face of ['top', 'bottom'] as const) {
    onFace(projectWith(ROUND_BAR, 'rotary'), face)
    useProjectStore.getState().addEllipseFeature('Ellipse', 10, 10, 4, 3, 5)
    assertEqual(operations(), ['subtract'], `a first ellipse on a bar's ${face} cuts into the bar`)
    onFace(projectWith(ROUND_BAR, 'rotary'), face)
    assertEqual(createGear().length, 1, `the gear is created on a bar's ${face}`)
    assertEqual(operations(), ['add'], `the historical first-gear Add on a bar's ${face} is unchanged`)
  }
  console.log('top/bottom defaults are unchanged: PASSED')
}

function testSquareBarDefaultsAreSubtract(): void {
  // Item 14 names both bar shapes, and the default is a property of the face,
  // not of the bar's outline: `inferManualFeatureOperation` asks whether the bar
  // is the material, which a square blank is as much as a round one. This is
  // pinned per kind on the draft creation would write — `buildShapeFeature` is
  // the one call every canned creator makes, and `gearCreationOperation` is the
  // gear action's extra first-gear rule applied to that draft — so the default
  // is read from the production path, not re-derived here.
  const squareAround = (): Project => {
    onFace(projectWith(SQUARE_BAR, 'rotary'), 'around')
    return useProjectStore.getState().project
  }

  for (const [kind, profile] of CANNED_DRAFT_PROFILES) {
    const draft = buildShapeFeature(squareAround(), 'feature', 'composite', profile(), `Square ${kind}`, 5)
    assertEqual(draft.operation, 'subtract', `a ${kind}'s creation draft on a square bar's Around cuts into the bar`)
  }

  const around = squareAround()
  const aroundGear = buildShapeFeature(around, 'feature', 'composite', gearProfile(), 'Gear', 5)
  assertEqual(aroundGear.operation, 'subtract', "a gear's creation draft on a square bar's Around cuts into the bar")
  assertEqual(
    gearCreationOperation(around, aroundGear, 'around'),
    'subtract',
    "the first-gear Add rule does not override it on Around",
  )

  // The same gear draft on Top keeps the historical first-gear Add, so the
  // square-bar pin above cannot pass by weakening that rule everywhere.
  onFace(projectWith(SQUARE_BAR, 'rotary'), 'top')
  const top = useProjectStore.getState().project
  const topGear = buildShapeFeature(top, 'feature', 'composite', gearProfile(), 'Gear', 5)
  assertEqual(
    gearCreationOperation(top, topGear, 'top'),
    'add',
    "a first gear on a bar's Top is still the historical Add",
  )
  console.log('square Around: every canned creation draft is a cut: PASSED')
}

function testSquareBarCreationIsACut(): void {
  // Item 14 names both bar shapes, and a square blank is a bar: the bar is the
  // material on every face, so the first canned outline created on it is a cut.
  // This runs the real store creators — the same actions the drawer calls — and
  // reads the operation off the created row, not off a draft.
  //
  // A square blank's *Around sheet* is the one place those creators do not run:
  // #1016 C2-U1 freezes it round-only (pinned by `squareAroundPolicy.test.ts`
  // for every path and both gear branches) and #1128 owns that sheet. Top and
  // Bottom are where a square blank authors, so that is where the bar-is-material
  // default is proven through creation; the Around default it will need is
  // pinned per kind in `testSquareBarDefaultsAreSubtract` above.
  for (const face of ['top', 'bottom'] as const) {
    for (const [kind, create] of CANNED_CREATORS) {
      onFace(projectWith(SQUARE_BAR, 'rotary'), face)
      create()
      assertEqual(operations(), ['subtract'], `a first ${kind} created on a square bar's ${face} cuts into the bar`)
    }

    // The gear keeps its historical first-gear Add on a flat face (item 14
    // scopes the change to Around), and that stays pinned on the square bar too,
    // so the assertions above cannot pass by making every square-bar shape a cut.
    onFace(projectWith(SQUARE_BAR, 'rotary'), face)
    assertEqual(createGear().length, 1, `the gear is created on a square bar's ${face}`)
    assertEqual(operations(), ['add'], `the historical first-gear Add on a square bar's ${face} is unchanged`)
  }
  console.log('square bar: every canned outline created on Top/Bottom is a cut: PASSED')
}

function testSquareAroundAuthoringStaysRefused(): void {
  // The refusal is #1016 C2-U1's round-only sheet, not item 14's default: a
  // square blank is workflow-available on Around (its generated rotary models
  // cut there) but the unrolled sheet's raw coordinates only describe a round
  // bar, so a cutting outline is not authored on it — and a non-rotary cut
  // stored there would not even be part of the job (`operationCutsInProject`).
  // rt2-c keeps the drawer entries visible and disabled ("Not available on a
  // square bar yet") and #1128 owns sheet work on the turned section. Pinned
  // here as the guard's own contract — a canned creator must not grow a private
  // path around `addFeature` — so that enabling the sheet is a deliberate change
  // in #1128, not a side effect of a default. `squareAroundPolicy.test.ts` holds
  // the store-wide version of this rule; do not remove either one.
  for (const [kind, create] of CANNED_CREATORS) {
    onFace(projectWith(SQUARE_BAR, 'rotary'), 'around')
    const before = useProjectStore.getState().project
    create()
    assertEqual(useProjectStore.getState().project, before, `a ${kind} on a square blank's Around writes nothing`)
  }
  onFace(projectWith(SQUARE_BAR, 'rotary'), 'around')
  const before = useProjectStore.getState().project
  assertEqual(createGear(), [], 'the gear is refused on a square blank')
  assertEqual(useProjectStore.getState().project, before, 'the refusal writes nothing')
  console.log('square Around: cutting authoring stays refused until #1128: PASSED')
}

testEveryCannedKindOnAroundCutsIntoTheBar()
testLaterShapesOnAroundStillNest()
testGearBoreOnAroundIsAnAddIsland()
testTopAndBottomKeepTheirDefaults()
testSquareBarDefaultsAreSubtract()
testSquareBarCreationIsACut()
testSquareAroundAuthoringStaysRefused()
