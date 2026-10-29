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
 * Mutations checked one at a time against these assertions:
 * - dropping the `gearFace !== 'around'` condition in `gearFeature.ts` (i.e.
 *   the first gear on Around goes back to Add) → the Around gear assertions
 *   fail;
 * - making that condition unconditional (every face subtract) → the Top and
 *   Bottom assertions fail;
 * - removing `inferManualFeatureOperation` from `buildShapeFeature`'s closed
 *   path (so a canned shape is always Add) → every Around assertion fails.
 *
 * Run with: npx tsx src/store/cannedShapeAroundDefaults.test.ts
 */

import {
  newProject,
  roundStock,
  type Project,
  type SketchFeature,
  type Stock,
} from '../types/project'
import { squareStock } from '../types/barStock'
import { bundledMachines } from '../machine/registry'
import { validateMachineDefinition } from '../engine/gcode/types'
import { resolveCannedShapeShapes } from '../cannedShapes'
import { useProjectStore } from './projectStore'
import { switchWorkspaceFace } from './workspaceFace'
import { activeFace } from './helpers/activeFace'
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

function testSquareAroundStaysRoundOnly(): void {
  // A square blank's Around sheet is round-only (#1016 C2-U1): the canned kinds
  // are refused before any project, selection or history write, so there is no
  // default operation to pick there.
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
  console.log('square Around stays round-only: PASSED')
}

testEveryCannedKindOnAroundCutsIntoTheBar()
testLaterShapesOnAroundStillNest()
testGearBoreOnAroundIsAnAddIsland()
testTopAndBottomKeepTheirDefaults()
testSquareAroundStaysRoundOnly()
