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
 * A move of a canned rotary feature travels along the bar (issue #1112 rt6-d,
 * item 42).
 *
 * Frank: "the Move preview lets them leave the bar's axis and the finished move
 * snaps them back; a Turn can't be moved at all." The one rule lives in
 * `helpers/rotaryMove.ts` and is used by the pointer preview, the click that
 * ends the drag and the commit, so the three cannot disagree.
 *
 * Run with: npx tsx src/store/rotaryMove.test.ts
 *
 * Load-bearing properties:
 *
 * 1. **A Turn move changes its stored start**, so `Edit Turn…` shows the new
 *    band, the regenerated mesh sits at it, and a Thread over the band follows
 *    the moved Turn in the same write.
 * 2. **Off-axis drag, on-axis result for a Turn/Polygon**: the across component
 *    is dropped, because a turned or prismatic body is about the bar's axis.
 *    Thread/Flutes keep it — across the sheet is a turn around the bar and the
 *    commit has always kept it — so the rule is "preview == commit", not
 *    "everything is horizontal". The named mutations are a preview that ignores
 *    the projection and a commit that keeps the raw 2D offset for a model.
 * 3. **The band never leaves the bar**: a drag past either end clamps the start
 *    into `[0, barLength - length]`, the Polygon panel's own range.
 * 4. **One undo step**, and undo puts the start, the mesh and the Thread's span
 *    back.
 * 5. A **copy** move is untouched: a copy is a new row, not this band.
 * 6. **An unselected linked copy stays put**: a definition is shared with every
 *    linked copy, so the band write only happens when the selection holds all of
 *    them (the review of rt6-d found a move moving an unselected copy). Otherwise
 *    the selected rows translate by the projected displacement, which is what a
 *    Polygon's move has always done.
 * 7. **A typed distance is the same projection**: the point a typed target is
 *    drawn at is the point the commit stores, including the clamp past the bar's
 *    end (also the review of rt6-d).
 *
 * Other mutations checked one at a time:
 * - the preview projection returning the raw point → the Turn/Polygon
 *   "preview == commit" assertions fail (the stored start moves by the across
 *   component too, or the preview stops matching);
 * - the commit keeping the raw 2D offset (the old generic translate) → the
 *   stored start assertions fail;
 * - dropping the across component for Thread/Flutes → its preview/commit
 *   equality fails;
 * - clamping to the stock bounds instead of the band → the past-the-end
 *   assertion fails;
 * - skipping the model rebuild → the mesh-bounds assertion stays at the old
 *   span;
 * - a second history entry (the parameter write plus a transform write) → the
 *   one-undo assertion fails;
 * - dropping the shared-definition guard → the unselected linked copy's placed
 *   start moves with the moved one;
 * - translating a linked move by the raw 2D drag instead of the projection →
 *   the moved copy lands off the bar, by the diagonal.
 */

import assert from 'node:assert/strict'
import {
  defaultTool,
  newProject,
  roundStock,
  type Project,
  type SketchFeature,
  type Tool,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { bundledMachines } from '../machine/registry'
import { validateMachineDefinition } from '../engine/gcode/types'
import { switchWorkspaceFace } from './workspaceFace'
import { useProjectStore } from './projectStore'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { cannedShapeModelAssetId } from '../cannedShapes/model'
import {
  projectMovePreviewPoint,
  projectedMoveTarget,
  rotaryMoveBand,
  rotaryMoveDelta,
} from './helpers/rotaryMove'
import { computeMoveDistancePreviewPoint } from '../components/canvas/manualEntry'

const store = () => useProjectStore.getState()

function near(actual: number, expected: number, label: string, tolerance = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected}`,
  )
}

const BAR_DIAMETER = 25
const BAR_LENGTH = 120
const BAR_RADIUS = BAR_DIAMETER / 2

function rotaryProject(features: SketchFeature[] = [], axis: 'x' | 'y' = 'x'): Project {
  const base = newProject('Rotary move', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(BAR_DIAMETER, BAR_LENGTH, axis, { x: 0, y: 0 })
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'rotary-move',
    rotary: { about: axis, drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [{ ...defaultTool('mm', 1), id: 'ball', type: 'ball_endmill', diameter: 3 } as Tool]
  return projectWithFeatures(base, features)
}

function load(project: Project = rotaryProject()): Project {
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  return store().project
}

function addTurn(start: number, length: number, diameter: number, profile?: unknown): string {
  const result = store().addRotarySolid({
    kind: 'turn',
    start,
    length,
    diameter,
    ...(profile ? { profile: profile as never } : {}),
  })
  if (!result.ok) throw new Error(`Turn refused: ${result.reason}`)
  return result.featureId
}

/** The stored copied profile's along coordinates, in stock order. */
function profileAlong(featureId: string): number[] {
  const project = store().project
  const row = project.features.find((feature) => feature.id === featureId)
  assert.ok(row, `row ${featureId} exists`)
  const profile = project.featureDefinitions[row.definitionId]?.canned?.params.profile as
    | { contours: { points: { along: number }[] }[] }
    | null
    | undefined
  assert.ok(profile, `the definition of ${featureId} carries a copied profile`)
  return profile.contours.flatMap((contour) => contour.points.map((point) => point.along))
}

function addPolygon(start: number, length: number, acrossFlats: number): string {
  const result = store().addRotarySolid({ kind: 'polygon', start, length, sides: 6, acrossFlats })
  if (!result.ok) throw new Error(`Polygon refused: ${result.reason}`)
  return result.featureId
}

function addPattern(kind: 'thread' | 'flutes', start: number, length: number): string {
  const result = kind === 'thread'
    ? store().addRotaryPattern({ kind, start, length, pitch: 2, depth: 1 })
    : store().addRotaryPattern({ kind, start, length, count: 4, twist: 0, depth: 1 })
  if (!result.ok) throw new Error(`${kind} refused: ${result.reason}`)
  return result.featureId
}

/** The stored start of a canned feature, read where the edit panel reads it. */
function storedStart(featureId: string): number {
  const project = store().project
  const row = project.features.find((feature) => feature.id === featureId)
  assert.ok(row, `row ${featureId} exists`)
  const canned = project.featureDefinitions[row.definitionId]?.canned
  assert.ok(canned, `definition of ${featureId} is canned`)
  const start = canned.params.start
  assert.equal(typeof start, 'number', 'the stored start is a number')
  return start as number
}

/** The regenerated mesh's own X extent, from the persisted asset bounds. */
function meshSpanX(featureId: string): { min: number; max: number } {
  const project = store().project
  const row = project.features.find((feature) => feature.id === featureId)
  assert.ok(row, `row ${featureId} exists`)
  const asset = project.modelAssets?.[cannedShapeModelAssetId(row.definitionId)]
  assert.ok(asset, `the model asset of ${featureId} exists`)
  return { min: asset.bounds.minX, max: asset.bounds.maxX }
}

/** The placed band's along start in stock coordinates. */
function placedAlongStart(featureId: string): number {
  const feature = resolveFeatureInstance(store().project, featureId)
  assert.ok(feature, `feature ${featureId} resolves`)
  return feature.sketch.profile.start.x
}

function featureIds(): string[] {
  return store().project.features.map((feature) => feature.id)
}

function move(featureId: string, from: { x: number; y: number }, to: { x: number; y: number }): void {
  store().startMoveFeature(featureId)
  assert.deepEqual(store().pendingMove?.entityIds, [featureId], 'the move is armed for the row')
  store().setPendingMoveFrom(from)
  store().completePendingMove(to)
}

/** What the canvas preview draws for this drag: the point the outline lands on. */
function preview(featureId: string, from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number } {
  return projectedMoveTarget(
    store().project,
    { mode: 'move', entityType: 'feature', entityIds: [featureId] },
    from,
    to,
  )
}

// ── a Turn's move is its band ───────────────────────────────
//
// The stored start, the regenerated mesh and the edit panel all read the same
// number, and a Thread over the band follows the moved Turn in that one write.
// The named mutation is the old generic translate: the Start field kept its old
// value and the shape moved by its instance transform alone.

load()
const turnId = addTurn(10, 20, 10)
const threadId = addPattern('thread', 12, 6)
const historyBefore = store().history.past.length
// The Thread starts on the turned surface: radius 5 above the axis.
near(Number(resolveFeatureInstance(store().project, threadId)!.z_top), BAR_RADIUS + 5, 'the Thread starts on the Turn')

const turnMeshBefore = meshSpanX(turnId)
near(turnMeshBefore.min, 10, 'the mesh starts at the stored start')
move(turnId, { x: 20, y: 0 }, { x: 35, y: 0 })

near(storedStart(turnId), 25, 'the stored start moved by the along component')
near(placedAlongStart(turnId), 25, 'the placed band sits at the new start')
const turnMeshAfter = meshSpanX(turnId)
near(turnMeshAfter.min, 25, 'the regenerated mesh moved with the start')
near(turnMeshAfter.max, 45, 'the mesh keeps its length')
near(Number(resolveFeatureInstance(store().project, threadId)!.z_top), BAR_DIAMETER,
  'the Thread over the old band follows the moved Turn back to the bar surface')
assert.equal(store().history.past.length, historyBefore + 1, 'the move is one undo step')

store().undo()
near(storedStart(turnId), 10, 'undo puts the stored start back')
near(meshSpanX(turnId).min, turnMeshBefore.min, 'undo puts the regenerated mesh back')
near(Number(resolveFeatureInstance(store().project, threadId)!.z_top), BAR_RADIUS + 5,
  'undo puts the Thread back on the Turn')
store().redo()
near(storedStart(turnId), 25, 'redo moves the band again')

// A Turn moved off the bar's axis is refused by this rule: a model is a body
// about the bar's axis, so the across component is not applied at all. On Top
// that was the excursion the preview showed and the commit hid.
load()
const centredTurn = addTurn(10, 20, 10)
move(centredTurn, { x: 20, y: 0 }, { x: 25, y: 9 })
near(storedStart(centredTurn), 15, 'the along component moved the band')
near(placedAlongStart(centredTurn), 15, 'the band stayed on the bar axis')
const centredRow = store().project.features.find((feature) => feature.id === centredTurn)
assert.deepEqual(centredRow?.transform, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  'a Turn move leaves no across offset on the instance')

// A profiled Turn is geometry, not a number: its contours are absolute
// stock-space points, so the move shifts them and the start follows. The named
// mutation is writing the start alone, which regenerates the same mesh in the
// same place (the profile is what the generator revolves).
load()
const profiledTurn = addTurn(20, 40, 10, {
  sourceFeatureId: 'no-source',
  contours: [{
    closed: false,
    points: [{ along: 20, radius: 5 }, { along: 60, radius: 5 }],
  }],
})
const profiledMeshBefore = meshSpanX(profiledTurn)
const profiledAlongBefore = profileAlong(profiledTurn)
move(profiledTurn, { x: 30, y: 5 }, { x: 40, y: 9 })
near(storedStart(profiledTurn), 30, 'a profiled Turn stores the moved start')
near(meshSpanX(profiledTurn).min, profiledMeshBefore.min + 10, 'the revolved mesh moved with the band')
assert.deepEqual(
  profileAlong(profiledTurn),
  profiledAlongBefore.map((along) => along + 10),
  'the copied profile moved along the bar with the band',
)

// ── the preview is the commit, for every canned rotary kind ─
//
// One drag, compared twice: the point the preview draws the feature at and the
// place the commit stores it. Turn and Polygon land on the axis; Thread and
// Flutes keep the across motion their commit has always kept.
//
// The named mutation is a preview that skips the projection: the Turn/Polygon
// comparison then fails by the across component, and the drag's outline leaves
// the bar again.

const projectionCases: {
  kind: 'turn' | 'polygon' | 'thread' | 'flutes'
  add: () => string
  acrossKept: boolean
}[] = [
  { kind: 'turn', add: () => addTurn(20, 10, 10), acrossKept: false },
  { kind: 'polygon', add: () => addPolygon(20, 10, 12), acrossKept: false },
  { kind: 'thread', add: () => addPattern('thread', 20, 10), acrossKept: true },
  { kind: 'flutes', add: () => addPattern('flutes', 20, 10), acrossKept: true },
]

for (const entry of projectionCases) {
  load()
  const id = entry.add()
  const from = { x: 25, y: 5 }
  const to = { x: 35, y: 11 }
  const previewed = preview(id, from, to)
  const before = placedAlongStart(id)
  const beforeAcross = resolveFeatureInstance(store().project, id)!.sketch.profile.start.y

  move(id, from, to)

  const after = resolveFeatureInstance(store().project, id)!
  near(after.sketch.profile.start.x - before, previewed.x - from.x,
    `${entry.kind}: the commit moves as far along the bar as the preview showed`)
  near(after.sketch.profile.start.y - beforeAcross, previewed.y - from.y,
    `${entry.kind}: the commit moves as far across as the preview showed`)
  if (entry.acrossKept) {
    near(after.sketch.profile.start.y - beforeAcross, to.y - from.y,
      `${entry.kind}: across the sheet is kept, as its commit has always kept it`)
  } else {
    near(previewed.y, from.y, `${entry.kind}: the preview stays on the bar axis`)
    near(after.sketch.profile.start.y, beforeAcross, `${entry.kind}: the commit stays on the bar axis`)
  }
}

// ── the band never leaves the bar ───────────────────────────
//
// The Polygon panel's own range: start >= 0 and start + length <= the bar.
// Clamping the *delta* (not the stock bounds) is what keeps the band whole.

load()
const edgeTurn = addTurn(10, 20, 10)
const band = rotaryMoveBand(store().project, store().project.featureDefinitions[
  store().project.features.find((feature) => feature.id === edgeTurn)!.definitionId
]!.canned!)
assert.ok(band, 'the band is readable')
near(band.barLength, BAR_LENGTH, 'the stored frame is the bar the Turn was made on')

move(edgeTurn, { x: 20, y: 0 }, { x: 400, y: 0 })
near(storedStart(edgeTurn), BAR_LENGTH - 20, 'a drag past the far end clamps to the bar end')
move(edgeTurn, { x: 100, y: 0 }, { x: -400, y: 0 })
near(storedStart(edgeTurn), 0, 'a drag past the chuck end clamps to it')

// The same rule broken into its two halves, so a preview can be checked without
// a store write: an off-axis drag of 400 clamps to the end and keeps dy at zero.
load()
const previewTurn = addTurn(10, 20, 10)
const clipped = rotaryMoveDelta(
  store().project,
  [{
    canned: store().project.featureDefinitions[
      store().project.features.find((feature) => feature.id === previewTurn)!.definitionId
    ]!.canned!,
  }],
  400,
  9,
)
near(clipped.dx, BAR_LENGTH - 20 - 10, 'the preview clamps the along displacement')
near(clipped.dy, 0, 'the preview drops the across displacement')

// ── a bar along Y moves the other way ───────────────────────
//
// The chuck end is the bar's max Y, so the stored start counts *down* from it
// (`alongStartDirection`). Moving the band down the sheet increases stock Y and
// must decrease the start; the sign is the classic trap this pins.

load(rotaryProject([], 'y'))
const yTurn = addTurn(20, 20, 10)
const yAlongBefore = resolveFeatureInstance(store().project, yTurn)!.sketch.profile.start.y
move(yTurn, { x: 12.5, y: 30 }, { x: 17.5, y: 40 })
near(storedStart(yTurn), 10, 'the Y-bar start moved against stock Y')
near(resolveFeatureInstance(store().project, yTurn)!.sketch.profile.start.y, yAlongBefore + 10,
  'the placed band followed the drag along the bar')
assert.deepEqual(
  store().project.features.find((feature) => feature.id === yTurn)?.transform,
  { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  'the across component is dropped on a Y bar too',
)

// ── a copy is a new row, not a band ─────────────────────────
//
// The generic copy path is untouched: the source's stored start does not move
// and the copy is placed at the offset, exactly as before this rule.

load()
const copiedFrom = addPolygon(20, 10, 12)
store().startCopyFeature(copiedFrom)
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 30, y: 5 })
assert.equal(featureIds().length, 2, 'the copy is a second row')
near(storedStart(copiedFrom), 20, 'the source band did not move')
const copyRow = store().project.features.find((feature) => feature.id !== copiedFrom)
assert.ok(copyRow, 'the copy row exists')
assert.deepEqual(copyRow.transform, { a: 1, b: 0, c: 0, d: 1, e: 30, f: 5 },
  'the copy keeps the ordinary 2D offset a copy always had')

// ── an unselected linked copy does not move ─────────────────
//
// A definition is shared with every linked copy, so its stored start belongs to
// all of them. Writing the moved start moved a copy the user did not select
// (review of rt6-d): the previous path translates the selected rows, and a
// Polygon's move has always left the other copies where they are. The
// translation is the *projected* displacement, so the outline still lands where
// the preview drew it.
//
// Named mutations: dropping the shared-definition guard → the unselected copy's
// placed start moves too; translating by the raw 2D drag instead of the
// projection → the moved copy lands off the bar and by the diagonal.

load()
const linkedSource = addPolygon(20, 10, 12)
store().startCopyFeature(linkedSource, 'reference')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 30, y: 5 })
assert.equal(featureIds().length, 2, 'the linked copy is a second row')
const linkedCopy = featureIds().find((id) => id !== linkedSource)!
const linkedSourceRow = store().project.features.find((feature) => feature.id === linkedSource)
const linkedCopyRow = store().project.features.find((feature) => feature.id === linkedCopy)
assert.equal(linkedCopyRow?.definitionId, linkedSourceRow?.definitionId, 'the copy is linked, not independent')
const linkedStoredBefore = storedStart(linkedSource)
const linkedMovedBefore = placedAlongStart(linkedSource)
const linkedCopyBefore = placedAlongStart(linkedCopy)
const linkedHistoryBefore = store().history.past.length

const linkedDragFrom = { x: 20, y: 0 }
const linkedDragTo = { x: 35, y: 9 }
const linkedPreview = preview(linkedSource, linkedDragFrom, linkedDragTo)
move(linkedSource, linkedDragFrom, linkedDragTo)

near(linkedPreview.x - linkedDragFrom.x, 15, 'the preview keeps only the along component')
near(placedAlongStart(linkedSource), linkedMovedBefore + 15,
  'the moved copy travels exactly the previewed along distance')
assert.deepEqual(
  store().project.features.find((feature) => feature.id === linkedSource)?.transform,
  { a: 1, b: 0, c: 0, d: 1, e: 15, f: 0 },
  'the translation carries the projected (along only) displacement, not the diagonal drag',
)
near(placedAlongStart(linkedCopy), linkedCopyBefore,
  'an unselected linked copy stays where it was')
near(storedStart(linkedSource), linkedStoredBefore,
  'the shared definition keeps its band, so the other copy cannot follow')
assert.equal(
  store().project.features.find((feature) => feature.id === linkedCopy)?.transform.e,
  linkedCopyRow?.transform.e,
  'the unselected copy keeps its own placement',
)
assert.equal(store().history.past.length, linkedHistoryBefore + 1, 'the move is one undo step')

store().undo()
near(placedAlongStart(linkedSource), linkedMovedBefore, 'undo puts the moved copy back')
near(placedAlongStart(linkedCopy), linkedCopyBefore, 'undo leaves the unselected copy alone')

// Selecting every copy is what lets the shared band move: one write, both rows.
load()
const groupSource = addPolygon(20, 10, 12)
store().startCopyFeature(groupSource, 'reference')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 30, y: 5 })
const groupCopy = featureIds().find((id) => id !== groupSource)!
store().selectFeatures([groupSource, groupCopy])
store().startMoveFeature(groupSource)
assert.deepEqual(store().pendingMove?.entityIds, [groupSource, groupCopy],
  'both linked copies are in the move')
const groupHistoryBefore = store().history.past.length
store().setPendingMoveFrom({ x: 20, y: 0 })
store().completePendingMove({ x: 30, y: 0 })
near(storedStart(groupSource), 30, 'moving every copy writes the shared band once')
near(placedAlongStart(groupSource), 30, 'the first copy sits at the moved band')
near(placedAlongStart(groupCopy), 60, 'the linked copy follows the band it shares')
assert.equal(store().history.past.length, groupHistoryBefore + 1, 'moving the group is one undo step')

// ── a typed distance is projected too ───────────────────────
//
// The review of rt6-d found the typed preview computed without the projection,
// so a 400-unit target drew 400 away and committed 90 (the bar end). The one
// preview point every publisher stores is the committed point; here the typed
// path is checked against the commit for a target past the end of the bar.
//
// Named mutation: skipping the projection in the preview point → the preview
// reads 400 past the origin while the commit stores the clamped band, and the
// two assertions below disagree by 310.

load()
const typedTurn = addTurn(10, 20, 10)
const typedFrom = { x: 20, y: 0 }
const typedReference = { x: 35, y: 0 }
const typedRaw = computeMoveDistancePreviewPoint(typedFrom, typedReference, 400)
const typedPreview = projectMovePreviewPoint(
  store().project,
  { mode: 'move', entityType: 'feature', entityIds: [typedTurn] },
  typedFrom,
  typedRaw,
)
near(typedPreview.x, typedFrom.x + (BAR_LENGTH - 10 - 20),
  'the typed preview clamps to the bar end')
near(typedPreview.y, typedFrom.y, 'the typed preview stays on the bar axis')
move(typedTurn, typedFrom, typedRaw)
near(storedStart(typedTurn), 100, 'the commit stores the clamped start')
near(storedStart(typedTurn) - 10, typedPreview.x - typedFrom.x,
  'the typed preview and the commit moved the band the same distance')

console.log('rotaryMove.test.ts passed')
