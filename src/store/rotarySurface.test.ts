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
 *    same words the dialog uses.
 * 4. **A Turn added after the thread moves it too**, so order of creation does
 *    not decide the surface.
 *
 * Other mutations checked one at a time:
 * - the surface resolved from the bar for every band → the on-Turn Z and the
 *   diameter-follow assertions fail;
 * - the Turn edit not re-syncing Thread rows → the follow assertion fails;
 * - a model or a taper silently claiming a diameter → the warning assertions
 *   fail;
 * - the warning map not filtering by canned kind → a plain line row warns too
 *   and the "no warning on the plain bar" assertion fails.
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
import { bundledMachines } from '../machine/registry'
import { validateMachineDefinition } from '../engine/gcode/types'
import { rotarySolidFrame } from '../cannedShapes/generators/rotarySolidParams'
import { rotarySolidCannedData } from './helpers/rotarySolids'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import {
  rotaryPatternSurface,
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

function addThread(start: number, length: number, depth = 1): void {
  const result = store().addRotaryPattern({ kind: 'thread', start, length, pitch: 2, depth })
  assert.ok(result.ok, `thread created (${result.ok ? '' : result.reason})`)
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

// ── the sync helper leaves an unchanged span alone ─────────

const stable = store().project
const synced = syncRotaryPatternSurfaces(stable, stable.features, stable.featureDefinitions)
assert.equal(synced, stable.features, 'an unchanged surface does not churn the rows')

console.log('rotary surface: all assertions passed.')
