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
 * 2. **Off-axis drag, on-axis result for every kind**: the across component is
 *    dropped for all four, because a canned rotary band has no across placement
 *    — a Turn or Polygon is a body about the bar's axis, and a Thread or Flutes
 *    turn *around* the bar rather than moving off it (issue #1112 rt7-f review).
 *    The named mutations are a preview that ignores the projection, a commit
 *    that keeps the raw 2D offset, and the old rule that kept the across part
 *    for Thread/Flutes.
 * 3. **The band never leaves the bar**: a drag past either end clamps the start
 *    into `[0, barLength - length]`, the Polygon panel's own range.
 * 4. **One undo step**, and undo puts the start, the mesh and the Thread's span
 *    back.
 * 5. A **copy** is a new row, placed by the same projection: along the bar,
 *    clamped at its ends, for every kind — exactly as a move of the same shape
 *    is. The source band stays where it is and the copy is the linked instance
 *    it always was (issue #1112 rt7-f: Frank's copy slid off the bar's axis
 *    while a move stayed on it). A copy **count** greater than one clamps every
 *    placement, not just the first (issue #1112 rt7-f review).
 * 6. **An unselected linked copy stays put**: a definition is shared with every
 *    linked copy, so the band write only happens when the selection holds all of
 *    them (the review of rt6-d found a move moving an unselected copy). Otherwise
 *    the selected rows translate by the projected displacement, which is what a
 *    Polygon's move has always done.
 * 7. **A typed distance is the same projection**: the point a typed target is
 *    drawn at is the point the commit stores, including the clamp past the bar's
 *    end (also the review of rt6-d).
 * 8. **The bar bounds the placed band, not the shared start**: a linked copy is
 *    the same definition translated, so a moved copy has to be clamped from
 *    where it actually sits. Otherwise repeated moves walk it past the bar's
 *    end (the second review of rt6-d).
 * 9. **A move on the Around sheet is the same bar move** (issue #1112 rt7-f):
 *    the sheet is stock X and Y unrolled across (`components/canvas/aroundSheet`),
 *    so the along direction, the clamp, the Thread/Flutes surface sync and the
 *    one undo step are identical on Top and on Around. The face's refusal was
 *    the context menu's other-face gate, which is where the Around case is
 *    pinned as *offered* (`components/feature-tree/featureContextMenu.test.ts`);
 *    the store and the canvas never gated by face.
 *
 * Other mutations checked one at a time:
 * - the preview projection returning the raw point → the Turn/Polygon
 *   "preview == commit" assertions fail (the stored start moves by the across
 *   component too, or the preview stops matching);
 * - the commit keeping the raw 2D offset (the old generic translate) → the
 *   stored start assertions fail;
 * - keeping the across part for Thread/Flutes (the rt6-d rule) → the Thread and
 *   Flutes preview/commit assertions find the band off the bar's axis;
 * - dropping the per-copy clamp (multiplying the first copy's displacement by
 *   the copy index) → the three-copy assertion finds copies at 110, 200 and
 *   290 mm on a 120 mm bar;
 * - clamping to the stock bounds instead of the band → the past-the-end
 *   assertion fails;
 * - skipping the model rebuild → the mesh-bounds assertion stays at the old
 *   span;
 * - a second history entry (the parameter write plus a transform write) → the
 *   one-undo assertion fails;
 * - dropping the shared-definition guard → the unselected linked copy's placed
 *   start moves with the moved one;
 * - translating a linked move by the raw 2D drag instead of the projection →
 *   the moved copy lands off the bar, by the diagonal;
 * - clamping a linked copy against the shared definition's start instead of its
 *   own placed band → the repeated move stores 125 on a 120 bar, and the group
 *   move drives the translated copy past the end;
 * - dropping the copy's projection from `projectedMoveTarget` → the copy
 *   preview assertions fail (the drawn place keeps the raw across component);
 * - dropping it from the copy branch of `completePendingMove` → the copied row
 *   lands off the bar by the diagonal under a preview that stayed on it;
 * - dropping the clamp from the copy's displacement → the clamped-copy
 *   assertion finds the copy past the bar's end.
 */

import assert from 'node:assert/strict'
import {
  defaultTool,
  newProject,
  roundStock,
  type CannedShapeData,
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
import { cannedShapeFrame } from '../cannedShapes'
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

/** A canned feature's stored parameters, read straight from its definition. */
function cannedOf(featureId: string): CannedShapeData {
  const project = store().project
  const row = project.features.find((feature) => feature.id === featureId)
  assert.ok(row, `row ${featureId} exists`)
  const canned = project.featureDefinitions[row.definitionId]?.canned
  assert.ok(canned, `definition of ${featureId} is canned`)
  return canned
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

/** The placed band's along start in stock coordinates (X unless the bar runs Y). */
function placedAlongStart(featureId: string, axis: 'x' | 'y' = 'x'): number {
  const feature = resolveFeatureInstance(store().project, featureId)
  assert.ok(feature, `feature ${featureId} resolves`)
  return axis === 'x' ? feature.sketch.profile.start.x : feature.sketch.profile.start.y
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
// place the commit stores it. Every kind lands on the axis — the across part is
// not a placement a canned rotary band has (issue #1112 rt7-f review).
//
// The named mutations are a preview that skips the projection, and the rt6-d
// rule that kept the across part for Thread/Flutes: either leaves the outline
// off the bar again for those two kinds.

const projectionCases: {
  kind: 'turn' | 'polygon' | 'thread' | 'flutes'
  add: () => string
}[] = [
  { kind: 'turn', add: () => addTurn(20, 10, 10) },
  { kind: 'polygon', add: () => addPolygon(20, 10, 12) },
  { kind: 'thread', add: () => addPattern('thread', 20, 10) },
  { kind: 'flutes', add: () => addPattern('flutes', 20, 10) },
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
  near(previewed.y, from.y, `${entry.kind}: the preview stays on the bar axis`)
  near(after.sketch.profile.start.y, beforeAcross, `${entry.kind}: the commit stays on the bar axis`)
  assert.deepEqual(
    store().project.features.find((feature) => feature.id === id)?.transform,
    { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    `${entry.kind}: the move writes no across offset on the instance`,
  )
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

// ── a move on Around is the same bar move ───────────────────
//
// Frank: "move is only in Top for all rotary features. we should allow move in
// the Around, with the same method we did for top now." The refusal he hit is
// the context menu's other-face gate (pinned as *offered* in
// `feature-tree/featureContextMenu.test.ts`); the store and the canvas never
// gated by face, and the Around sheet is stock X and Y unrolled across
// (`components/canvas/aroundSheet.ts`), so along the bar is the same coordinate
// on both sheets. What this pins is that the whole move — the projection, the
// clamp, the Thread's surface and the undo step — is identical there, with the
// rows authored exactly as the app authors them: a Turn on Top, a Thread and a
// Flutes on Around (`store/helpers/rotarySolids.ts`, `rotaryPatterns.ts`).

const aroundCases: {
  kind: 'turn' | 'thread' | 'flutes'
  add: () => string
}[] = [
  { kind: 'turn', add: () => addTurn(10, 20, 10) },
  { kind: 'thread', add: () => addPattern('thread', 40, 10) },
  { kind: 'flutes', add: () => addPattern('flutes', 40, 10) },
]

for (const entry of aroundCases) {
  load()
  const id = entry.add()
  const where = `${entry.kind} moved on Around`
  const from = { x: 30, y: 5 }
  const to = { x: 45, y: 11 }
  const previewed = preview(id, from, to)
  const alongBefore = placedAlongStart(id)
  const acrossBefore = resolveFeatureInstance(store().project, id)!.sketch.profile.start.y
  const historyBefore = store().history.past.length

  move(id, from, to)

  const after = resolveFeatureInstance(store().project, id)!
  near(after.sketch.profile.start.x - alongBefore, previewed.x - from.x,
    `${where}: the band moves as far along the bar as the preview drew`)
  near(after.sketch.profile.start.x - alongBefore, to.x - from.x,
    `${where}: the along component is kept in full`)
  near(previewed.y, from.y, `${where}: the preview stays on the bar axis`)
  near(after.sketch.profile.start.y, acrossBefore, `${where}: the band stays on the bar axis`)
  assert.deepEqual(
    store().project.features.find((feature) => feature.id === id)?.transform,
    { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    `${where}: the move writes no across offset on the instance`,
  )
  assert.equal(store().history.past.length, historyBefore + 1, `${where}: the move is one undo step`)
  store().undo()
  near(placedAlongStart(id), alongBefore, `${where}: undo puts the band back`)
  store().redo()
  near(placedAlongStart(id), alongBefore + (to.x - from.x), `${where}: redo moves it again`)
}

// The bar's ends clamp on the Around sheet exactly as they do on Top, and undo
// puts the whole move back in one step.
load()
const aroundEdgeTurn = addTurn(10, 20, 10)
move(aroundEdgeTurn, { x: 20, y: 0 }, { x: 400, y: 0 })
near(storedStart(aroundEdgeTurn), BAR_LENGTH - 20, 'a drag past the far end clamps to it on Around')
move(aroundEdgeTurn, { x: 100, y: 0 }, { x: -400, y: 0 })
near(storedStart(aroundEdgeTurn), 0, 'a drag past the chuck end clamps to it on Around')

// The Thread/Flutes surface sync is the same on Around: moving the Turn takes
// every band that lay on it back to the bar's own surface, in the same write.
load()
const aroundSurfaceTurn = addTurn(10, 20, 10)
const aroundSurfaceThread = addPattern('thread', 12, 6)
const aroundHistoryBefore = store().history.past.length
near(Number(resolveFeatureInstance(store().project, aroundSurfaceThread)!.z_top), BAR_RADIUS + 5,
  'the Thread starts on the Turn on Around too')
move(aroundSurfaceTurn, { x: 20, y: 0 }, { x: 35, y: 0 })
near(Number(resolveFeatureInstance(store().project, aroundSurfaceThread)!.z_top), BAR_DIAMETER,
  'the Thread follows the moved Turn back to the bar surface on Around')
assert.equal(store().history.past.length, aroundHistoryBefore + 1,
  'the Turn move and the Thread it re-measures are one undo step on Around')
store().undo()
near(Number(resolveFeatureInstance(store().project, aroundSurfaceThread)!.z_top), BAR_RADIUS + 5,
  'undo puts the Thread back on the Turn on Around')

// ── a copy is placed along the bar, on Top and on Around ────
//
// Frank: "copy does not lock the rotary axis and it should". A copy is a new
// row placed by its own instance translate, so the displacement that places it
// is the projection that places a moved band: along the bar, clamped at the
// bar's ends, for every kind — exactly as a move of the same shape is. The
// source band stays where it is and the copy is the linked instance it always
// was.
//
// Named mutations: dropping the projection from `projectedMoveTarget` → the
// preview assertions fail (the drawn copy keeps the raw across component);
// dropping it from the copy branch of `completePendingMove` → the copy lands
// off the bar while the preview stayed on it; keeping the across part for
// Thread/Flutes → their copy lands off the axis.

/** Copy one row by a drag, from the point to the point, and answer the new id. */
function copyBy(
  featureId: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  mode: 'reference' | 'independent' = 'reference',
): string {
  const before = new Set(featureIds())
  store().startCopyFeature(featureId, mode)
  store().setPendingMoveFrom(from)
  store().completePendingMove(to)
  const created = featureIds().find((id) => !before.has(id))
  assert.ok(created, 'the copy created a row')
  return created
}

const copyCases: {
  face: 'top' | 'around'
  kind: 'turn' | 'polygon' | 'thread' | 'flutes'
  add: () => string
}[] = [
  { face: 'top', kind: 'turn', add: () => addTurn(20, 10, 10) },
  { face: 'top', kind: 'polygon', add: () => addPolygon(20, 10, 12) },
  { face: 'around', kind: 'turn', add: () => addTurn(20, 10, 10) },
  { face: 'around', kind: 'polygon', add: () => addPolygon(20, 10, 12) },
  { face: 'around', kind: 'thread', add: () => addPattern('thread', 20, 10) },
  { face: 'around', kind: 'flutes', add: () => addPattern('flutes', 20, 10) },
]

for (const entry of copyCases) {
  load()
  const id = entry.add()
  if (entry.face === 'top') assert.equal(switchWorkspaceFace('top'), true, `${entry.kind}: the workspace enters Top`)
  const where = `${entry.kind} copied on ${entry.face}`
  const from = { x: 25, y: 5 }
  const to = { x: 55, y: 11 }
  const previewed = projectedMoveTarget(
    store().project,
    { mode: 'copy', entityType: 'feature', entityIds: [id] },
    from,
    to,
  )
  const sourceAlongBefore = placedAlongStart(id)
  const sourceAcrossBefore = resolveFeatureInstance(store().project, id)!.sketch.profile.start.y
  const sourceStoredBefore = storedStart(id)
  const historyBefore = store().history.past.length

  const copyId = copyBy(id, from, to)

  const copyRow = store().project.features.find((feature) => feature.id === copyId)
  const sourceRow = store().project.features.find((feature) => feature.id === id)
  assert.equal(copyRow?.definitionId, sourceRow?.definitionId,
    `${where}: the copy is the linked instance it always was`)
  near(placedAlongStart(copyId) - sourceAlongBefore, previewed.x - from.x,
    `${where}: the copy lands as far along the bar as the preview drew it`)
  near(placedAlongStart(copyId) - sourceAlongBefore, to.x - from.x,
    `${where}: the along component is kept in full`)
  near(previewed.y, from.y, `${where}: the copy preview stays on the bar axis`)
  near(resolveFeatureInstance(store().project, copyId)!.sketch.profile.start.y, sourceAcrossBefore,
    `${where}: the copy itself stays on the bar axis`)
  assert.deepEqual(
    copyRow?.transform,
    { a: 1, b: 0, c: 0, d: 1, e: to.x - from.x, f: 0 },
    `${where}: the copy's transform carries only the along displacement`,
  )
  near(placedAlongStart(id), sourceAlongBefore, `${where}: the source band did not move`)
  near(storedStart(id), sourceStoredBefore, `${where}: the source keeps its stored start`)
  assert.equal(store().history.past.length, historyBefore + 1, `${where}: the copy is one undo step`)
}

// The clamp is the move's clamp: a copy dragged past the bar's end stops with
// its own band at the end, as a move of it does.
//
// Named mutation: dropping the projection's clamp from the copy's displacement
// → the copy lands past the bar.
load()
const clampedCopySource = addTurn(20, 10, 10)
const clampedCopy = copyBy(clampedCopySource, { x: 20, y: 0 }, { x: 400, y: 0 })
near(placedAlongStart(clampedCopy), BAR_LENGTH - 10,
  'a copy dragged past the far end stops at the bar end')
const clampedAgain = copyBy(clampedCopy, { x: 20, y: 0 }, { x: -400, y: 0 })
near(placedAlongStart(clampedAgain), 0, 'and a copy dragged past the chuck end stops at it')
near(storedStart(clampedAgain), storedStart(clampedCopySource),
  'a copy never writes the shared band, so neither end changes the stored start')

// ── every copy is placed inside the bar, not just the first ─
//
// A copy count places each row at a multiple of the drag, but a canned rotary
// band's multiple has to be clamped from where the one before it landed.
// Clamping the first displacement and then multiplying it by the copy index
// walked a 10 mm Turn copied three times off a 120 mm bar — 110, 200 and
// 290 mm (issue #1112 rt7-f review).
//
// Named mutation: multiplying the clamped displacement by the copy index →
// the second and third copies land past the bar end.

load()
const countedTurn = addTurn(20, 10, 10)
const countedBefore = featureIds()
store().startCopyFeature(countedTurn, 'reference')
store().setPendingMoveFrom({ x: 20, y: 0 })
store().completePendingMove({ x: 110, y: 0 }, 3)
const countedCopies = featureIds().filter((id) => !countedBefore.includes(id))
assert.equal(countedCopies.length, 3, 'three copies were created')
const countedStarts = countedCopies.map((id) => placedAlongStart(id))
assert.deepEqual(countedStarts, [110, 110, 110],
  `every copy stops at the bar end, not at a multiple past it: ${countedStarts.join(', ')}`)
for (const start of countedStarts) {
  assert.ok(start >= 0 && start + 10 <= BAR_LENGTH, `the copy band at ${start} is inside the bar`)
}
near(storedStart(countedTurn), 20, 'the counted copy leaves the source band where it was')

// Around too: the same count, the same clamp, and the band stays on the axis.
load()
const countedThread = addPattern('thread', 20, 10)
const countedAroundBefore = featureIds()
const countedAcrossBefore = resolveFeatureInstance(store().project, countedThread)!.sketch.profile.start.y
store().startCopyFeature(countedThread, 'reference')
store().setPendingMoveFrom({ x: 20, y: 4 })
store().completePendingMove({ x: 110, y: 10 }, 3)
const countedAround = featureIds().filter((id) => !countedAroundBefore.includes(id))
assert.deepEqual(
  countedAround.map((id) => placedAlongStart(id)),
  [110, 110, 110],
  'every repeated copy on Around stops at the bar end',
)
for (const id of countedAround) {
  near(resolveFeatureInstance(store().project, id)!.sketch.profile.start.y, countedAcrossBefore,
    'a repeated copy on Around stays on the bar axis')
}

// The count clamps the other way on a Y bar: the band travels up the sheet
// towards the chuck end and stops there, and no copy is placed further.
load(rotaryProject([], 'y'))
const countedYTurn = addTurn(20, 10, 10)
const countedYBefore = featureIds()
const countedYSource = placedAlongStart(countedYTurn, 'y')
store().startCopyFeature(countedYTurn, 'reference')
store().setPendingMoveFrom({ x: 12.5, y: 20 })
store().completePendingMove({ x: 12.5, y: 120 }, 3)
const countedYCopies = featureIds().filter((id) => !countedYBefore.includes(id))
const countedYStarts = countedYCopies.map((id) => placedAlongStart(id, 'y'))
near(countedYStarts[0], countedYSource + 20, 'the first Y-bar copy travels as far as the bar allows')
near(countedYStarts[1], countedYStarts[0], 'the second Y-bar copy stops where the first did')
near(countedYStarts[2], countedYStarts[0], 'the third Y-bar copy stops where the first did')
assert.deepEqual(
  countedYCopies.map((id) => store().project.features.find((row) => row.id === id)?.transform.e),
  [0, 0, 0],
  'a Y-bar copy is placed along Y only',
)

// A selection that is not a canned rotary one keeps the ordinary multiple: the
// per-step clamp only decides where a band may go, never where an ordinary copy
// lands.
load()
const plainBefore = featureIds()
store().addEllipseFeature('Ellipse', 40, 30, 3, 3, 5)
const plainEllipse = featureIds().find((id) => !plainBefore.includes(id))!
const plainCopyBefore = featureIds()
const plainSourceE = store().project.features.find((row) => row.id === plainEllipse)?.transform.e
assert.equal(typeof plainSourceE, 'number', 'the ellipse carries a placement')
store().startCopyFeature(plainEllipse, 'reference')
store().setPendingMoveFrom({ x: 10, y: 0 })
store().completePendingMove({ x: 20, y: 0 }, 3)
const plainCopies = featureIds().filter((id) => !plainCopyBefore.includes(id))
assert.deepEqual(
  plainCopies.map((id) => (store().project.features.find((row) => row.id === id)?.transform.e ?? 0) - (plainSourceE as number)),
  [10, 20, 30],
  'a non-rotary copy still lands at its plain multiple of the drag',
)

// A copied Thread is measured on the surface it lands on: copied off the Turn's
// band it sits back on the bar, which is where its depth is measured from.
load()
const surfaceTurn = addTurn(10, 20, 10)
const surfaceThread = addPattern('thread', 12, 6)
near(Number(resolveFeatureInstance(store().project, surfaceThread)!.z_top), BAR_RADIUS + 5,
  'the Thread starts on the turned surface')
const surfaceCopy = copyBy(surfaceThread, { x: 20, y: 0 }, { x: 60, y: 0 })
near(Number(resolveFeatureInstance(store().project, surfaceCopy)!.z_top), BAR_DIAMETER,
  'the copied Thread is measured from the bar surface it landed on')
near(Number(resolveFeatureInstance(store().project, surfaceThread)!.z_top), BAR_RADIUS + 5,
  'the source Thread stays on the Turn it sits on')
assert.ok(surfaceTurn, 'the Turn the source Thread sits on is still there')

// An independent copy keeps its own definition, as every independent copy does,
// and is placed by the same projection.
load()
const independentSource = addPolygon(20, 10, 12)
const independentCopy = copyBy(independentSource, { x: 20, y: 0 }, { x: 35, y: 8 }, 'independent')
const independentSourceRow = store().project.features.find((feature) => feature.id === independentSource)
const independentCopyRow = store().project.features.find((feature) => feature.id === independentCopy)
assert.ok(independentCopyRow && independentSourceRow, 'both rows exist')
assert.notEqual(independentCopyRow.definitionId, independentSourceRow.definitionId,
  'an independent copy gets its own definition')
near(placedAlongStart(independentCopy), 35,
  'the independent copy still travels only along the bar')

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

// ── a translated linked copy is clamped from where it sits ──
//
// The bar's ends bound the *placed* band, not the shared definition's stored
// start: a linked copy is the same parameters translated, so it can already sit
// further along the bar than the definition says. The review of rt6-d caught
// the clamp reading the definition's start, which let a translated copy walk
// past the bar one move at a time — start 20, length 10, copied, then moved +15
// and +400 landed at 125 on a 120 bar.
//
// Named mutations: clamping against `band.start` instead of the placed start in
// `rotaryMoveDelta` → the repeat move stores 125; dropping each row's offset
// from `rotaryMoveFeatures` → the preview draws past the bar; dropping it from
// `moveCannedRotaryFeatures` → the group move drives the translated copy off
// the end.

load()
const repeatSource = addPolygon(20, 10, 12)
store().startCopyFeature(repeatSource, 'reference')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 30, y: 5 })
const repeatCopy = featureIds().find((id) => id !== repeatSource)!
const repeatCopyBefore = placedAlongStart(repeatCopy)
const repeatHistoryBefore = store().history.past.length

// The first move travels the along component from the row's own placed band.
near(preview(repeatSource, { x: 10, y: 0 }, { x: 25, y: 9 }).x - 10, 15,
  'the first move of the copy keeps only the along component')
move(repeatSource, { x: 10, y: 0 }, { x: 25, y: 9 })
near(placedAlongStart(repeatSource), 35, 'the first move puts the band at 35')

// The second move starts from 35, not from the definition's 20: the band has
// 75 left to travel, and no more.
const repeatDragFrom = { x: 10, y: 0 }
const repeatDragTo = { x: 410, y: 0 }
near(preview(repeatSource, repeatDragFrom, repeatDragTo).x - repeatDragFrom.x, BAR_LENGTH - 10 - 35,
  'the preview clamps the placed band at the bar end')
move(repeatSource, repeatDragFrom, repeatDragTo)
near(placedAlongStart(repeatSource), BAR_LENGTH - 10,
  'the repeated move stops with its band at the far end of the bar')
assert.deepEqual(
  store().project.features.find((feature) => feature.id === repeatSource)?.transform,
  { a: 1, b: 0, c: 0, d: 1, e: 90, f: 0 },
  'the placed band, not the definition state, is what the clamp measured',
)
near(placedAlongStart(repeatCopy), repeatCopyBefore, 'the unselected linked copy still stays put')
near(storedStart(repeatSource), 20, 'the shared definition still keeps its own start')
assert.equal(store().history.past.length, repeatHistoryBefore + 2, 'each repeated move is one undo step')

// A group move writes the shared start, so the tightest placed band decides how
// far the write may go: the copy at +30 is the one the bar end limits.
load()
const bandSource = addPolygon(20, 10, 12)
store().startCopyFeature(bandSource, 'reference')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 30, y: 5 })
const bandCopy = featureIds().find((id) => id !== bandSource)!
store().selectFeatures([bandSource, bandCopy])
store().startMoveFeature(bandSource)
store().setPendingMoveFrom({ x: 20, y: 0 })
store().completePendingMove({ x: 420, y: 0 })
near(storedStart(bandSource), BAR_LENGTH - 30 - 10,
  'the shared start stops where the furthest placed copy meets the bar end')
near(placedAlongStart(bandSource), 80, 'the source follows the shared band')
near(placedAlongStart(bandCopy), BAR_LENGTH - 10,
  'the translated copy ends at the bar end, never past it')

// The sign of the placed offset is the bar's own: on a Y bar a copy moved up
// the sheet sits *further* along the start, and is clamped from there.
load(rotaryProject([], 'y'))
const yLinkedSource = addPolygon(20, 10, 12)
store().startCopyFeature(yLinkedSource, 'reference')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 0, y: -30 })
const yLinkedCopy = featureIds().find((id) => id !== yLinkedSource)!
near(placedAlongStart(yLinkedCopy, 'y'), 60,
  'the Y-bar copy up the sheet is further along the start')
move(yLinkedCopy, { x: 0, y: 20 }, { x: 0, y: -380 })
// The band's far end is the chuck end's opposite: it stops at the bar's low Y,
// y 0..10, i.e. stored start 110 — not at y -30 as a definition-start clamp did.
near(placedAlongStart(yLinkedCopy, 'y'), 0,
  'the Y-bar copy clamps from its own placed band, not the definition start')
near(placedAlongStart(yLinkedSource, 'y'), 90, 'the unselected Y-bar copy stays where it was')

// ── a surviving translated copy never stores an invalid band ─
//
// The clamp bounds the *placed* band, but the write that follows lands on the
// shared start. A copy translated along the bar can be dragged far enough
// towards the chuck end that the start it implies is negative — a band its own
// generator refuses, so the shape kept the mesh it already had while the
// preview promised the bar's low end (third review of rt6-d: Polygon start 20,
// length 10, copy at +30, original deleted, move the copy -400 → stored -30,
// geometry still at 50).
//
// A start its own kind refuses is not written; the row translates by the
// displacement the preview drew instead, the same fallback an unselected linked
// copy already takes. So the band lands where the drag showed it and the stored
// parameters stay a band the generator accepts.
//
// Named mutations: dropping the stored-start check in `movedCannedBand` → the
// write stores -30 and the placed band stays at 50; checking only the chuck end
// → the far move stores 130 on a 120 bar.

load()
const orphanSource = addPolygon(20, 10, 12)
store().startCopyFeature(orphanSource, 'reference')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 30, y: 5 })
const orphanCopy = featureIds().find((id) => id !== orphanSource)!
store().deleteFeatures([orphanSource])
assert.deepEqual(featureIds(), [orphanCopy], 'the translated copy is the only row left')
near(placedAlongStart(orphanCopy), 50, 'the surviving copy sits at its translated place')
const orphanHistoryBefore = store().history.past.length

const orphanFrom = { x: 60, y: 0 }
const orphanTo = { x: -400, y: 0 }
near(preview(orphanCopy, orphanFrom, orphanTo).x - orphanFrom.x, -50,
  'the preview draws the band all the way to the chuck end')
move(orphanCopy, orphanFrom, orphanTo)
near(placedAlongStart(orphanCopy), 0, 'the band lands where the preview drew it')
near(storedStart(orphanCopy), 20,
  'the stored start is not written outside the range its own generator accepts')
assert.ok(cannedShapeFrame(cannedOf(orphanCopy)) !== null,
  'the stored band is still one the generator accepts')
assert.equal(store().history.past.length, orphanHistoryBefore + 1, 'the move is one undo step')
store().undo()
near(placedAlongStart(orphanCopy), 50, 'undo puts the copy back where it sat')
near(storedStart(orphanCopy), 20, 'undo leaves the stored start alone')
store().redo()
near(placedAlongStart(orphanCopy), 0, 'redo puts the band back at the chuck end')

// The other end is the same rule: from the chuck end the band has the whole bar
// to travel, and the start that would need (20 + 110) is past the stored bar.
const orphanFarFrom = { x: 0, y: 0 }
const orphanFarTo = { x: 400, y: 0 }
near(preview(orphanCopy, orphanFarFrom, orphanFarTo).x - orphanFarFrom.x, BAR_LENGTH - 10,
  'the preview draws the band all the way to the far end')
move(orphanCopy, orphanFarFrom, orphanFarTo)
near(placedAlongStart(orphanCopy), BAR_LENGTH - 10, 'the band reaches the far end')
near(storedStart(orphanCopy), 20, 'the far move does not write 130 onto the stored band')
assert.ok(cannedShapeFrame(cannedOf(orphanCopy)) !== null,
  'the stored band is still a band, not an empty range')

// A move the stored band *can* hold still writes it: the fallback is only for
// the writes that would leave the kind's own range.
move(orphanCopy, { x: 200, y: 0 }, { x: 190, y: 0 })
near(storedStart(orphanCopy), 10, 'a move the stored band can hold still writes the start')
near(placedAlongStart(orphanCopy), 100, 'and lands the band where the preview drew it')

// A Turn is a model too, and its start is written the same way.
load()
const orphanTurnSource = addTurn(20, 10, 10)
store().startCopyFeature(orphanTurnSource, 'reference')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 30, y: 0 })
const orphanTurn = featureIds().find((id) => id !== orphanTurnSource)!
store().deleteFeatures([orphanTurnSource])
near(placedAlongStart(orphanTurn), 50, 'the surviving Turn copy sits at its translated place')
move(orphanTurn, { x: 60, y: 0 }, { x: -400, y: 0 })
near(placedAlongStart(orphanTurn), 0, 'the Turn band lands where the preview drew it')
near(storedStart(orphanTurn), 20, 'the Turn keeps a stored start its generator accepts')
assert.ok(cannedShapeFrame(cannedOf(orphanTurn)) !== null,
  'the Turn definition is still a band the generator accepts')

// A Thread's start is written the same way, and its own line builder refuses a
// negative one too.
load()
const orphanThreadSource = addPattern('thread', 20, 10)
store().startCopyFeature(orphanThreadSource, 'reference')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 30, y: 0 })
const orphanThread = featureIds().find((id) => id !== orphanThreadSource)!
store().deleteFeatures([orphanThreadSource])
near(placedAlongStart(orphanThread), 50, 'the surviving Thread copy sits at its translated place')
move(orphanThread, { x: 60, y: 0 }, { x: -400, y: 0 })
near(placedAlongStart(orphanThread), 0, 'the Thread band lands where the preview drew it')
near(storedStart(orphanThread), 20, 'the Thread keeps a stored start its own builder accepts')
assert.ok(cannedShapeFrame(cannedOf(orphanThread)) !== null,
  'the Thread definition still draws its lines')

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
