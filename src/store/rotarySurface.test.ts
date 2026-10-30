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
 * Thread/Flutes measure depth from the surface they sit on (issue #1112 slice
 * H, decision 10).
 *
 * Run with: npx tsx src/store/rotarySurface.test.ts
 *
 * Load-bearing properties:
 *
 * 1. **A band wholly on one Turn takes that Turn's diameter**: the instance Z
 *    top is `bar radius + Turn radius`, not the bar surface. Keeping the bar
 *    diameter on a Turn is the named mutation.
 * 2. **Editing the Turn's diameter moves the thread with it**, in the same
 *    store write, and the moved span survives save → load.
 * 3. **Two diameters, a taper and an imported model are not guessed**: the
 *    depth falls back to the bar surface and the row carries a warning, in the
 *    same words the dialog uses. A warned band that crosses a Turn names it in
 *    the warning, and the sentence is the plain reworded one (#1112 rt3-c item
 *    30): "This pattern crosses the end of Turn, where the bar's diameter
 *    changes." — dropping the name, or keeping the old "more than one diameter"
 *    text, is the named mutation.
 * 4. **A Turn added after the thread moves it too**, so order of creation does
 *    not decide the surface.
 * 5. **The Thread's own placement places its band**: moving the row off a Turn
 *    returns it to the bar, and moving it back takes the Turn again. Reading
 *    the stored `start`/`length` alone is the named mutation.
 * 6. **A Turn moved off the bar axis, raised in Z or rotated no longer supplies
 *    one diameter**: it is warned about and measured from the bar, instead of
 *    keeping the unrotated constant. Ignoring the placed geometry is the named
 *    mutation.
 * 7. **A Properties Z span is an override**: it survives the same write, an
 *    unrelated write, save → open (which stays clean) and a later Turn edit.
 *    Re-deriving on load or on the next sync is the named mutation.
 *
 * Other mutations checked one at a time:
 * - the surface resolved from the bar for every band → the on-Turn Z and the
 *   diameter-follow assertions fail;
 * - the Turn edit not re-syncing Thread rows → the follow assertion fails;
 * - a model or a taper silently claiming a diameter → the warning assertions
 *   fail;
 * - the warning map not filtering by canned kind → a plain line row warns too
 *   and the "no warning on the plain bar" assertion fails;
 * - the band read from the stored parameters instead of the placement → the
 *   Thread move assertions fail;
 * - the sync overwriting every stored span → the override assertions fail;
 * - the sync re-deriving on open → the override-on-load assertion fails and
 *   the opened document turns dirty.
 */

import assert from 'node:assert/strict'
import {
  defaultTool,
  newProject,
  rectProfile,
  roundStock,
  type Project,
  type SketchFeature,
  type Tool,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { enMessages } from '../i18n/locales/en'
import { interpolate } from '../i18n/catalog'
import { bundledMachines } from '../machine/registry'
import { validateMachineDefinition } from '../engine/gcode/types'
import { rotarySolidFrame } from '../cannedShapes/generators/rotarySolidParams'
import { rotarySolidCannedData } from './helpers/rotarySolids'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import {
  rotaryPatternSurface,
  rotaryPatternSurfaceOfFeature,
  rotaryPatternSurfaceWarnings,
  syncRotaryPatternSurfaces,
} from './helpers/rotarySurface'
import { switchWorkspaceFace } from './workspaceFace'
import { useProjectStore } from './projectStore'

const store = () => useProjectStore.getState()

function assertNear(actual: number, expected: number, label: string, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

const BAR_DIAMETER = 20
const BAR_RADIUS = BAR_DIAMETER / 2

function rotaryProject(features: SketchFeature[] = []): Project {
  const base = newProject('Thread surface', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(BAR_DIAMETER, 120, 'x', { x: 0, y: 0 })
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'around-surface',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
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

function threadFeature() {
  const project = store().project
  const row = project.features.find(
    (feature) => project.featureDefinitions[feature.definitionId]?.canned?.kind === 'thread',
  )
  assert.ok(row, 'the thread row exists')
  const feature = resolveFeatureInstance(project, row.id)
  assert.ok(feature, 'the thread row resolves')
  return feature
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

function addThread(start: number, length: number, depth = 1): string {
  const result = store().addRotaryPattern({ kind: 'thread', start, length, pitch: 2, depth })
  assert.ok(result.ok, `thread created (${result.ok ? '' : result.reason})`)
  return result.featureId
}

function threadZ(featureId: string): number {
  const feature = resolveFeatureInstance(store().project, featureId)
  assert.ok(feature, `thread ${featureId} resolves`)
  return Number(feature.z_top)
}

// ── a thread wholly on one Turn ──────────────────────────────

load()
const turnId = addTurn(20, 40, 10)
addThread(25, 20)
const thread = threadFeature()
assertNear(Number(thread.z_top), BAR_RADIUS + 5, 'the thread surface is the Turn radius')
assertNear(Number(thread.z_bottom), BAR_RADIUS + 5 - 1, 'the depth is measured down from the Turn')

const surface = rotaryPatternSurface(store().project, { start: 25, length: 20 })
assert.equal(surface.kind, 'turn', 'the band is wholly on the Turn')
assert.equal(surface.diameter, 10, 'the Turn diameter')
assert.equal(surface.turnName, 'Turn', 'the read-only line names the Turn')
assert.equal(rotaryPatternSurfaceWarnings(store().project).size, 0, 'a Turn surface needs no warning')

// Editing the Turn's diameter moves the thread in the same write.
const frame = rotarySolidFrame(store().project)
assert.ok(frame)
const smaller = rotarySolidCannedData(frame, { kind: 'turn', start: 20, length: 40, diameter: 8 }, store().project.meta.units)
assert.ok(smaller)
store().updateFeature(turnId, { canned: smaller })
const moved = threadFeature()
assertNear(Number(moved.z_top), BAR_RADIUS + 4, 'the thread follows the edited Turn diameter')
assertNear(Number(moved.z_bottom), BAR_RADIUS + 4 - 1, 'the depth follows too')

// The move is part of the Turn's one history entry, not a second edit.
store().undo()
assertNear(Number(threadFeature().z_top), BAR_RADIUS + 5, 'undo restores the thread with the Turn')
store().redo()
assertNear(Number(threadFeature().z_top), BAR_RADIUS + 4, 'redo moves it again')

// Save → load keeps the moved span and the same surface.
const file = store().saveProject()
store().openProjectFromText(file, null)
const reloaded = threadFeature()
assertNear(Number(reloaded.z_top), BAR_RADIUS + 4, 'the moved thread span survives save/load')
assert.equal(
  rotaryPatternSurface(store().project, { start: 25, length: 20 }).kind,
  'turn',
  'the reloaded band still resolves to the Turn',
)

// ── a Turn added after the thread moves it too ──────────────

load()
addThread(25, 20)
assertNear(Number(threadFeature().z_top), BAR_DIAMETER, 'on the plain bar the surface is the bar')
addTurn(20, 40, 10)
assertNear(Number(threadFeature().z_top), BAR_RADIUS + 5, 'a later Turn moves the existing thread')

// ── two diameters ───────────────────────────────────────────

load()
addTurn(0, 20, 12)
addTurn(20, 20, 8)
addThread(10, 20)
assertNear(Number(threadFeature().z_top), BAR_DIAMETER, 'two diameters fall back to the bar surface')
assert.deepEqual(
  rotaryPatternSurface(store().project, { start: 10, length: 20 }).kind,
  'twoDiameters',
  'two diameters are named',
)
const twoDiametersWarning = rotaryPatternSurfaceWarnings(store().project).get(threadFeature().id)
assert.equal(twoDiametersWarning?.key, 'dialogs.rotary.surface.twoDiameters', 'the row warns about two diameters')
assert.deepEqual(twoDiametersWarning?.values, { turn: 'Turn, Turn 2' }, 'the warning names both Turns it crosses')

// ── a band crossing a Turn's end ─────────────────────────────
//
// The item-30 wording: plain words naming the Turn whose end the band runs
// past, instead of "this pattern crosses more than one diameter".

load()
addTurn(20, 40, 10)
addThread(10, 20)
assert.equal(
  rotaryPatternSurface(store().project, { start: 10, length: 20 }).kind,
  'twoDiameters',
  'a band running past one Turn end is a warned kind',
)
const turnEndWarning = rotaryPatternSurfaceWarnings(store().project).get(threadFeature().id)
assert.equal(turnEndWarning?.key, 'dialogs.rotary.surface.twoDiameters', 'a Turn-end crossing warns')
assert.deepEqual(turnEndWarning?.values, { turn: 'Turn' }, 'the warning names the Turn it crosses')

// The sentence itself: it names the Turn and no longer talks about measuring
// from the bar surface. The tree and the dialog both interpolate this key.
assert.equal(
  interpolate(enMessages['dialogs.rotary.surface.twoDiameters'], turnEndWarning?.values),
  'This pattern crosses the end of Turn, where the bar\'s diameter changes.',
  'the row and dialog show the reworded sentence with the Turn in it',
)

// ── a taper ─────────────────────────────────────────────────

load()
addTurn(0, 40, 20, {
  sourceFeatureId: 'no-source',
  contours: [{
    closed: false,
    points: [{ along: 0, radius: 8 }, { along: 40, radius: 4 }],
  }],
})
addThread(10, 20)
assert.deepEqual(
  rotaryPatternSurface(store().project, { start: 10, length: 20 }).kind,
  'taper',
  'a taper is named',
)
assert.equal(
  rotaryPatternSurfaceWarnings(store().project).get(threadFeature().id)?.key,
  'dialogs.rotary.surface.taper',
  'the row warns about a taper',
)

// ── a narrow groove is not sampled past ─────────────────────
//
// The floor is 0.2 long over a 40 long Turn: any fixed sampling grid lands on
// the radius-5 land on either side and calls the surface one diameter.

load()
addTurn(20, 40, 20, {
  sourceFeatureId: 'no-source',
  contours: [{
    closed: false,
    points: [
      { along: 20, radius: 5 },
      { along: 30.1, radius: 5 },
      { along: 30.1, radius: 3 },
      { along: 30.3, radius: 3 },
      { along: 30.3, radius: 5 },
      { along: 60, radius: 5 },
    ],
  }],
})
addThread(20, 40)
assert.deepEqual(
  rotaryPatternSurface(store().project, { start: 20, length: 40 }).kind,
  'twoDiameters',
  'a narrow groove is classified from its segments, not from sample stations',
)
assert.equal(
  rotaryPatternSurfaceWarnings(store().project).get(threadFeature().id)?.key,
  'dialogs.rotary.surface.twoDiameters',
  'the groove warns instead of silently taking radius 5',
)
assertNear(Number(threadFeature().z_top), BAR_DIAMETER, 'a grooved surface falls back to the bar')

// ── over an imported model ──────────────────────────────────

const modelDraft: SketchFeature = {
  id: 'f-figure',
  name: 'Figure 1',
  kind: 'stl',
  folderId: null,
  sketch: {
    profile: rectProfile(10, -5, 40, 10),
    origin: { x: 0, y: 0 },
    orientationAngle: 0,
    dimensions: [],
    constraints: [],
  },
  operation: 'model',
  authoringFace: 'top',
  z_top: 5,
  z_bottom: 0,
  visible: true,
  locked: false,
}
load(rotaryProject([modelDraft]))
addThread(15, 20)
const modelSurface = rotaryPatternSurface(store().project, { start: 15, length: 20 })
assert.equal(modelSurface.kind, 'model', 'a model band is named')
assert.deepEqual(modelSurface.modelNames, ['Figure 1'], 'the model row is named')
assertNear(Number(threadFeature().z_top), BAR_DIAMETER, 'an imported model measures from the bar surface')
const modelWarning = rotaryPatternSurfaceWarnings(store().project).get(threadFeature().id)
assert.equal(modelWarning?.key, 'dialogs.rotary.surface.model', 'the row warns over a model')
assert.deepEqual(modelWarning?.values, { model: 'Figure 1' }, 'the warning names the model')

// ── every project mutation re-syncs ──────────────────────────
//
// A Turn delete, undo/redo, move, transform, make-unique, folder change,
// expand or import is only the *trigger*: the Thread span itself is written by
// the one post-write sync, so testing each path is what keeps a future action
// from needing its own copy of the rule.

// Delete, undo and redo of the delete.
load()
const deleteTurn = addTurn(20, 40, 10)
const deleteThread = addThread(25, 20)
assertNear(threadZ(deleteThread), BAR_RADIUS + 5, 'the thread starts on the Turn')
store().deleteFeature(deleteTurn)
assertNear(threadZ(deleteThread), BAR_DIAMETER, 'deleting the Turn returns the thread to the bar')
store().undo()
assertNear(threadZ(deleteThread), BAR_RADIUS + 5, 'undo restores both rows and the Turn span')
store().redo()
assertNear(threadZ(deleteThread), BAR_DIAMETER, 'redo moves the thread off the deleted Turn again')

// Move: the Turn world span follows its instance transform, so the band under
// the old place falls back to the bar and the band under the new place takes
// the Turn diameter.
load()
const moveTurn = addTurn(20, 40, 10)
const oldBand = addThread(25, 20)
const newBand = addThread(65, 20)
assertNear(threadZ(oldBand), BAR_RADIUS + 5, 'the first band is on the Turn')
assertNear(threadZ(newBand), BAR_DIAMETER, 'the second band starts on the plain bar')
store().startMoveFeature(moveTurn)
store().setPendingMoveFrom({ x: 20, y: 0 })
store().completePendingMove({ x: 60, y: 0 })
assertNear(threadZ(oldBand), BAR_DIAMETER, 'moving the Turn away moves the old band to the bar')
assertNear(threadZ(newBand), BAR_RADIUS + 5, 'the band at the transformed span takes the Turn diameter')

// Transform (uniform resize of the Turn) scales the diameter the band reads.
// The pivot is on the bar's centreline so this stays a *coaxial* resize; a
// resize about an off-centre pivot moves the body off the axis and is covered
// by the placement cases below.
load()
const resizeTurn = addTurn(20, 40, 10)
const resizeThread = addThread(30, 20)
store().startResizeFeature(resizeTurn)
store().setPendingTransformReferenceStart({ x: 40, y: 10 })
store().setPendingTransformReferenceEnd({ x: 60, y: 10 })
store().completePendingTransform({ x: 64, y: 10 })
// An STL resize scales the instance Z band about its bottom, which lifts the
// body off the bar's Z plane (5..17 after this 1.2x drag, axis at Z11). A
// raised Turn is deliberately not a surface (see the Z-placement case below),
// so re-centre it before reading the placed diameter: this assertion is about
// the 1.2x radius, with the body coaxial again.
store().updateFeature(resizeTurn, {
  z_top: BAR_RADIUS + 6,
  z_bottom: BAR_RADIUS - 6,
})
assertNear(threadZ(resizeThread), BAR_RADIUS + 6, 'a 1.2x Turn supplies a 1.2x radius')
assert.equal(
  rotaryPatternSurface(store().project, { start: 30, length: 20 }).kind,
  'turn',
  'the resized Turn still resolves as one Turn',
)

// Make unique: the copy keeps its own placement and definition, so editing the
// copy's diameter moves the band on it and leaves the original band alone.
load()
const originalTurn = addTurn(20, 40, 10)
const originalThread = addThread(25, 20)
const beforeCopy = new Set(store().project.features.map((feature) => feature.id))
store().startCopyFeature(originalTurn, 'reference')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 40, y: 0 })
const copyTurn = store().project.features.find(
  (feature) => !beforeCopy.has(feature.id)
    && store().project.featureDefinitions[feature.definitionId]?.canned?.kind === 'turn',
)
assert.ok(copyTurn, 'the reference copy is a Turn')
const copyThread = addThread(65, 20)
assertNear(threadZ(copyThread), BAR_RADIUS + 5, 'the linked copy supplies the same diameter')
store().makeUnique(copyTurn.id)
const resizeFrame = rotarySolidFrame(store().project)
assert.ok(resizeFrame)
const copyCanned = rotarySolidCannedData(
  resizeFrame,
  { kind: 'turn', start: 20, length: 40, diameter: 8 },
  store().project.meta.units,
)
assert.ok(copyCanned)
store().updateFeature(copyTurn.id, { canned: copyCanned })
assertNear(threadZ(copyThread), BAR_RADIUS + 4, 'the unique copy now supplies its own diameter')
assertNear(threadZ(originalThread), BAR_RADIUS + 5, 'the original Turn and its band are untouched')

// Folder delete only re-parents: the surface and the span stay put.
const folderId = store().addFeatureFolder()
store().assignFeaturesToFolder([originalTurn, originalThread], folderId)
assertNear(threadZ(originalThread), BAR_RADIUS + 5, 'filing the Turn keeps its band')
store().deleteFeatureFolder(folderId)
assertNear(threadZ(originalThread), BAR_RADIUS + 5, 'deleting the folder keeps the Turn surface')

// Expand is refused for a model Turn; it must not disturb either row.
const beforeExpand = store().project.features.length
store().expandCannedFeature(originalTurn)
assert.equal(store().project.features.length, beforeExpand, 'a Turn model is not expandable')
assertNear(threadZ(originalThread), BAR_RADIUS + 5, 'a refused Expand leaves the band alone')

// Import: a stale stored span in the source is re-measured against the imported
// Turn in the same write.
load()
const importTurn = addTurn(20, 40, 10)
const importThread = addThread(25, 20)
const importFolder = store().addFeatureFolder()
store().assignFeaturesToFolder([importTurn, importThread], importFolder)
const importSource = structuredClone(store().project)
importSource.features = importSource.features.map((feature) => (
  feature.id === importThread
    ? { ...feature, z_top: BAR_DIAMETER, z_bottom: BAR_DIAMETER - 1 }
    : feature
))
load()
const importedIds = store().importCamjFolders({
  fileName: 'turn-source.camj',
  sourceProject: importSource,
  selectedFolderIds: [importFolder],
})
assert.equal(importedIds.length, 2, 'the Turn and its band import')
const importedThread = store().project.features.find(
  (feature) => importedIds.includes(feature.id)
    && store().project.featureDefinitions[feature.definitionId]?.canned?.kind === 'thread',
)
assert.ok(importedThread, 'the imported folder contains the thread')
assertNear(Number(importedThread.z_top), BAR_RADIUS + 5, 'import re-syncs the stale thread span onto the Turn')

// ── the Thread's own placement decides its band ─────────────
//
// The stored `start`/`length` are where the row was drawn; moving the row
// moves its band. Reading the parameters alone left the old Turn-derived Z
// behind after a move.

load()
addTurn(20, 40, 10)
const placedThread = addThread(25, 20)
assertNear(threadZ(placedThread), BAR_RADIUS + 5, 'the thread starts on the Turn')
store().startMoveFeature(placedThread)
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 50, y: 0 })
assertNear(threadZ(placedThread), BAR_DIAMETER, 'moving the Thread off the Turn returns it to the bar')
assert.equal(
  rotaryPatternSurfaceOfFeature(store().project, placedThread)?.kind,
  'bar',
  'the moved row resolves from its new place, not its stored start',
)
store().startMoveFeature(placedThread)
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: -50, y: 0 })
assertNear(threadZ(placedThread), BAR_RADIUS + 5, 'moving it back onto the Turn takes the Turn diameter again')

// ── a Turn moved off the bar axis no longer supplies one diameter ──

load()
const shiftedTurn = addTurn(20, 40, 10)
const shiftedThread = addThread(25, 20)
assertNear(threadZ(shiftedThread), BAR_RADIUS + 5, 'the thread starts on the centred Turn')
store().startMoveFeature(shiftedTurn)
store().setPendingMoveFrom({ x: 20, y: 0 })
store().completePendingMove({ x: 20, y: 5 })
assertNear(threadZ(shiftedThread), BAR_DIAMETER, 'an off-centre Turn is not measured as the old diameter')
assert.equal(
  rotaryPatternSurfaceOfFeature(store().project, shiftedThread)?.kind,
  'twoDiameters',
  'the moved Turn spans a near and a far surface',
)
assert.equal(
  rotaryPatternSurfaceWarnings(store().project).get(shiftedThread)?.key,
  'dialogs.rotary.surface.twoDiameters',
  'the row warns instead of keeping a stale constant',
)

// ── a rotated Turn is tilted away from the bar axis ─────────

load()
const rotatedTurn = addTurn(20, 40, 10)
const rotatedThread = addThread(25, 20)
store().startRotateFeature(rotatedTurn)
store().setPendingTransformReferenceStart({ x: 40, y: 0 })
store().setPendingTransformReferenceEnd({ x: 60, y: 0 })
store().completePendingTransform({
  x: 40 + 20 * Math.cos(Math.PI / 6),
  y: 20 * Math.sin(Math.PI / 6),
})
assertNear(threadZ(rotatedThread), BAR_DIAMETER, 'a 30° Turn no longer reports the unrotated diameter')
assert.equal(
  rotaryPatternSurfaceOfFeature(store().project, rotatedThread)?.kind,
  'taper',
  'the tilted body reads as a varying surface',
)
assert.equal(
  rotaryPatternSurfaceWarnings(store().project).get(rotatedThread)?.key,
  'dialogs.rotary.surface.taper',
  'the tilted row warns',
)

// ── a Turn raised out of the bar's Z plane is off-axis too ──
//
// The 2D placement keeps the axis on the bar's centreline; the instance Z span
// puts it in the bar's Z plane. A Turn lifted by 3 mm has an unchanged stored
// diameter, but it no longer presents one surface about the bar axis: near and
// far sides are 3 mm differently placed, so the row must warn and measure from
// the bar instead of keeping the old Ø10 span.

load()
const raisedTurn = addTurn(20, 40, 10)
const raisedThread = addThread(25, 20)
assertNear(threadZ(raisedThread), BAR_RADIUS + 5, 'the thread starts on the centred Turn')
const raisedFeature = store().project.features.find((feature) => feature.id === raisedTurn)
assert.ok(raisedFeature, 'the Turn row exists')
store().updateFeature(raisedTurn, {
  z_top: Number(raisedFeature.z_top) + 3,
  z_bottom: Number(raisedFeature.z_bottom) + 3,
})
assertNear(threadZ(raisedThread), BAR_DIAMETER, 'a Turn raised in Z is not measured as the old diameter')
assert.equal(
  rotaryPatternSurfaceOfFeature(store().project, raisedThread)?.kind,
  'twoDiameters',
  'the raised body spans a near and a far surface',
)
assert.equal(
  rotaryPatternSurfaceWarnings(store().project).get(raisedThread)?.key,
  'dialogs.rotary.surface.twoDiameters',
  'the raised row warns instead of keeping a stale Z span',
)

// ── a Properties Z override survives the sync and a reload ──

load()
const overrideTurn = addTurn(20, 40, 10)
const overrideThread = addThread(25, 20)
assertNear(threadZ(overrideThread), BAR_RADIUS + 5, 'the derived span before the override')
store().updateFeature(overrideThread, { z_top: 18 })
assertNear(threadZ(overrideThread), 18, 'the Properties Z top survives the same write')
store().updateFeature(overrideThread, { name: 'Raised thread' })
assertNear(threadZ(overrideThread), 18, 'an unrelated write does not reset the override')
const overrideFile = store().saveProject()
// Open it as a **fresh** document, not as the one already in memory. The load
// guard is what keeps the file's stored span authoritative; reopening the same
// document would still have the old row in `previous` and mistake the override
// for a derived span. A different document leaves no matching previous row, so
// a sync on load would re-derive Z18 to the Turn surface and this assertion
// fails — the named mutation for removing the guard.
load()
store().openProjectFromText(overrideFile, null)
assertNear(threadZ(overrideThread), 18, 'save → open a fresh document keeps the override')
assert.equal(store().dirty, false, 'opening a saved file leaves the document clean')
const overrideFrame = rotarySolidFrame(store().project)
assert.ok(overrideFrame)
const overrideCanned = rotarySolidCannedData(
  overrideFrame,
  { kind: 'turn', start: 20, length: 40, diameter: 8 },
  store().project.meta.units,
)
assert.ok(overrideCanned)
store().updateFeature(overrideTurn, { canned: overrideCanned })
assertNear(threadZ(overrideThread), 18, 'the explicit span wins over a later Turn edit')
const lateTurn = addTurn(70, 20, 8)
assertNear(threadZ(overrideThread), 18, 'adding another Turn does not clobber the override')
assert.equal(
  resolveFeatureInstance(store().project, lateTurn)?.canned?.kind,
  'turn',
  'the added row is the new Turn',
)

// ── the sync helper leaves an unchanged span alone ─────────

const stable = store().project
const synced = syncRotaryPatternSurfaces(stable, stable.features, stable.featureDefinitions)
assert.equal(synced, stable.features, 'an unchanged surface does not churn the rows')

console.log('rotary surface: all assertions passed.')
