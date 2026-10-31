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
 * 3. **A diameter change, a taper and an imported model are not guessed**: the
 *    depth falls back to the bar surface and the row carries a warning, in the
 *    same words the dialog uses. The warning distinguishes **where** the change
 *    is (#1112 rt3-c correction 1): a band crossing a Turn's **end** says so —
 *    "This pattern crosses the end of Turn, where the bar's diameter changes."
 *    (item 30) — while a groove or step **inside** one Turn says "This pattern
 *    crosses a diameter change in Turn." Calling an internal groove an end
 *    crossing is the named mutation, and the sentence is asserted as text, not
 *    just as a key, so a shared sentence cannot pass by accident. Dropping the
 *    Turn's name, or keeping the old "more than one diameter" text, is the
 *    other mutation.
 * 4. **A Turn added after the thread moves it too**, so order of creation does
 *    not decide the surface.
 * 5. **The Thread's own placement places its band**: moving the row off a Turn
 *    returns it to the bar, and moving it back takes the Turn again. Reading
 *    the stored `start`/`length` alone is the named mutation.
 * 6. **A Turn moved off the bar axis, raised in Z or rotated no longer supplies
 *    one diameter**: it is warned about and measured from the bar, instead of
 *    keeping the unrotated constant. Ignoring the placed geometry is the named
 *    mutation.
 * 7. **A stored span is never an override** (#1112 rt6-c): a span that differs
 *    from the derived one — the Properties Z a user typed, an old file's span —
 *    is rewritten in the same write and again when the file is opened, and a
 *    later Turn edit still moves the row. Restoring the "explicit override"
 *    rule (keep a span that differed before the write) is the named mutation.
 * 8. **The Properties surface Z is the span's own formula**: `rotarySurfaceZ`
 *    is the axis plus the radius, on a round bar and on a square blank alike, so
 *    "surface at Z …" and the span the cut starts from cannot drift. Using the
 *    bar surface as the axis is the mutation.
 *
 * Other mutations checked one at a time:
 * - the surface resolved from the bar for every band → the on-Turn Z and the
 *   diameter-follow assertions fail;
 * - the Turn edit not re-syncing Thread rows → the follow assertion fails;
 * - a model or a taper silently claiming a diameter → the warning assertions
 *   fail;
 * - the warning map not filtering by canned kind → a plain line row warns too
 *   and the "no warning on the plain bar" assertion fails;
 * - an internal step classified as an end crossing → the groove case asserts
 *   the `step` kind and the "diameter change in Turn" sentence, so it fails.
 * - the band read from the stored parameters instead of the placement → the
 *   Thread move assertions fail;
 * - the sync keeping a span that differed before the write → the hand-typed
 *   span assertions fail;
 * - the sync skipped when the document is replaced → the open-a-file assertion
 *   fails, because the file's span is left as it was;
 * - `rotarySurfaceZ` reading the bar surface as the axis (thickness + radius)
 *   → the surface-Z assertions fail on both bar shapes.
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
import { barPivotZ } from '../types/barStock'
import { squareStock } from '../types/barStock'
import { rotarySolidFrame } from '../cannedShapes/generators/rotarySolidParams'
import { rotarySolidCannedData } from './helpers/rotarySolids'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import {
  rotaryPatternSurface,
  rotaryPatternSurfaceOfFeature,
  rotaryPatternSurfaceWarnings,
  rotarySurfaceZ,
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
// The floor is 0.2 long inside a 40 long Turn: any fixed sampling grid lands on
// the radius-5 land on either side and calls the surface one diameter.
//
// The band (25–35) is wholly on the Turn (20–60) and crosses that internal
// groove, not the Turn's end. This is the reviewed false-warning case (#1112
// rt3-c correction 1): the row must warn about a diameter change *inside*
// Turn, not claim it crosses the end of Turn.

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
addThread(25, 10)
assert.deepEqual(
  rotaryPatternSurface(store().project, { start: 25, length: 10 }).kind,
  'step',
  'an internal groove is classified from its segments, not from sample stations',
)
const grooveWarning = rotaryPatternSurfaceWarnings(store().project).get(threadFeature().id)
assert.equal(
  grooveWarning?.key,
  'dialogs.rotary.surface.step',
  'the groove warns instead of silently taking radius 5',
)
assert.deepEqual(grooveWarning?.values, { turn: 'Turn' }, 'the groove warning names the Turn it is inside')
// The text itself, not just the key: the sentence must not claim an end
// crossing, because the band never reaches the Turn's end.
assert.equal(
  interpolate(enMessages['dialogs.rotary.surface.step'], grooveWarning?.values),
  'This pattern crosses a diameter change in Turn.',
  'the internal groove names the Turn and the diameter change, not an end',
)
assert.ok(
  !interpolate(enMessages['dialogs.rotary.surface.step'], grooveWarning?.values).includes('end of'),
  'an internal groove does not claim to cross the Turn end',
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

// ── a Turn off the bar axis no longer supplies one diameter ──
//
// A Move is locked to the bar (issue #1112 rt6-d item 42): both the preview and
// the commit project the drag onto the along axis, so the off-centre body this
// rule covers arrives the way an old file or a transform about an off-centre
// pivot still leaves it — as a stored instance transform. The rule reads the
// placed body, not how it got there.

load()
const shiftedTurn = addTurn(20, 40, 10)
const shiftedThread = addThread(25, 20)
assertNear(threadZ(shiftedThread), BAR_RADIUS + 5, 'the thread starts on the centred Turn')
const centredProject = store().project
store().loadProject({
  ...centredProject,
  features: centredProject.features.map((row) => (
    row.id === shiftedTurn ? { ...row, transform: { ...row.transform, f: 5 } } : row
  )),
})
assertNear(threadZ(shiftedThread), BAR_DIAMETER, 'an off-centre Turn is not measured as the old diameter')
assert.equal(
  rotaryPatternSurfaceOfFeature(store().project, shiftedThread)?.kind,
  'step',
  'the shifted Turn spans a near and a far surface',
)
assert.equal(
  rotaryPatternSurfaceWarnings(store().project).get(shiftedThread)?.key,
  'dialogs.rotary.surface.step',
  'the row warns about the diameter change instead of keeping a stale constant',
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
  'step',
  'the raised body spans a near and a far surface',
)
assert.equal(
  rotaryPatternSurfaceWarnings(store().project).get(raisedThread)?.key,
  'dialogs.rotary.surface.step',
  'the raised row warns about the diameter change instead of keeping a stale Z span',
)

// ── a stored span is not an override: the surface always wins ──
//
// Frank (rt6-c): "I am still not sure if I can verify that the thread floats on
// top of turn and it changes if I change turn diameter." It did not always: a Z
// span typed in Properties used to count as an explicit override, so that
// Thread silently stopped following. Every span is derived now, both on a write
// and when the document is opened.

load()
const typedTurn = addTurn(20, 40, 10)
const typedThread = addThread(25, 20)
assertNear(threadZ(typedThread), BAR_RADIUS + 5, 'the derived span before the typed one')
store().updateFeature(typedThread, { z_top: 18, z_bottom: 17 })
assertNear(threadZ(typedThread), BAR_RADIUS + 5, 'a hand-typed span is rewritten in the same write')
store().updateFeature(typedThread, { name: 'Renamed thread' })
assertNear(threadZ(typedThread), BAR_RADIUS + 5, 'an unrelated write keeps the derived span')

// An old file whose span was typed by hand is re-derived on open.
const typedFile = JSON.parse(store().saveProject()) as Project
typedFile.features = typedFile.features.map((feature) => (
  feature.id === typedThread ? { ...feature, z_top: 18, z_bottom: 17 } : feature
))
load()
store().openProjectFromText(JSON.stringify(typedFile), null)
assertNear(threadZ(typedThread), BAR_RADIUS + 5, 'opening a file with a hand-typed span re-derives it')
assert.equal(store().dirty, false, 'opening a saved file leaves the document clean')

// Nothing was frozen by the old file: a later Turn edit still moves the row.
const typedFrame = rotarySolidFrame(store().project)
assert.ok(typedFrame)
const finalCanned = rotarySolidCannedData(
  typedFrame,
  { kind: 'turn', start: 20, length: 40, diameter: 8 },
  store().project.meta.units,
)
assert.ok(finalCanned)
store().updateFeature(typedTurn, { canned: finalCanned })
assertNear(threadZ(typedThread), BAR_RADIUS + 4, 'a later Turn edit still moves the Thread')
const laterTurn = addTurn(70, 20, 8)
assertNear(threadZ(typedThread), BAR_RADIUS + 4, 'adding another Turn off the band does not move it')
assert.equal(
  resolveFeatureInstance(store().project, laterTurn)?.canned?.kind,
  'turn',
  'the added row is the new Turn',
)

// ── the sync helper leaves an unchanged span alone ─────────

const stable = store().project
const synced = syncRotaryPatternSurfaces(stable, stable.features, stable.featureDefinitions)
assert.equal(synced, stable.features, 'an unchanged surface does not churn the rows')

// ── "surface at Z" is the span's own formula, on either bar ──
//
// Properties says where a Turn's diameter (or a Thread's surface) sits, and the
// Thread span is placed with the same call. The axis is mid-thickness on a round
// bar and on a square blank alike (barPivotZ), so reading the bar surface as the
// axis is the mutation this catches.

const roundBar = roundStock(40, 120, 'x', { x: 0, y: 0 })
assertNear(rotarySurfaceZ(roundBar, 30), barPivotZ(roundBar) + 15, 'a round bar: axis + Ø/2')
assertNear(rotarySurfaceZ(roundBar, 30), 35, 'a Ø30 Turn on a Ø40 round bar sits at Z 35')
assertNear(rotarySurfaceZ(roundBar, 40), BAR_DIAMETER + 20, 'the bar surface itself is the thickness')

const squareBar = squareStock(40, 120, 'x')
assertNear(barPivotZ(squareBar), barPivotZ(roundBar), 'both bar shapes turn about mid-thickness')
assertNear(rotarySurfaceZ(squareBar, 30), barPivotZ(squareBar) + 15, 'a square blank uses the same axis')
assertNear(rotarySurfaceZ(squareBar, 30), 35, 'so the same Turn sits at the same Z on either blank')

console.log('rotary surface: all assertions passed.')
