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
 * Generation through the setup transform (issue #946).
 *
 * The parity rule: an operation in a Bottom setup generates exactly the
 * toolpath of the same shapes **drawn mirrored on a Top-only project and
 * generated the old way**. The mirrored project here is built by hand —
 * literal mirrored coordinates in the same vertex order, depths written from
 * the top face, identity transforms, no setup — so it shares nothing with the
 * code under test. If the setup frame is built with the wrong pivot, the
 * wrong axis, an unflipped Z span or an unturned tab, the two diverge.
 *
 * The stock is 100 × 80 × 20 at (0, 0): centre (50, 40), mid-thickness 10.
 * Flipped about X a point reads (x, 80 − y, 20 − z); about Y, (100 − x, y,
 * 20 − z).
 *
 * Mutations these assertions were checked against are listed in the pull
 * request for #946.
 *
 * Run with: npx tsx src/engine/toolpaths/setupGeneration.test.ts
 */

import { circleProfile, defaultTool, IDENTITY_MATRIX, newProject, polygonProfile, rectProfile } from '../../types/project'
import type {
  Clamp,
  Operation,
  Point,
  Project,
  SetupFace,
  SetupOrientation,
  SketchFeature,
  SketchProfile,
  Tab,
} from '../../types/project'
import { BOTTOM_SETUP_ID, projectWithFeatures, resolvedFeature, withBottomSetup, withoutSetupFields } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { syncProjectSetups } from '../../store/helpers/setups'
import { loadSTLTransformedGeometry } from '../csg'
import { computeMeshBounds, serializeImportedMesh } from '../importedMesh'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import type { MachineDefinition } from '../gcode/types'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import type { ToolpathMove, ToolpathResult } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const WIDTH = 100
const HEIGHT = 80
const THICKNESS = 20
/** Round-trip noise of `2·pivot − value`, far below anything a program can express. */
const EPSILON = 1e-9

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  if (!found) throw new Error(`Fixture error: no bundled definition "${id}"`)
  return validateMachineDefinition(structuredClone(found))
}

const GRBL = bundled('grbl')
const SHOPBOT = bundled('shopbot')

// ── Fixtures ──────────────────────────────────────────────────

type Axis = SetupOrientation['axis']

/** The plan-view mirror, written out rather than taken from the engine. */
function mirrored(point: Point, axis: Axis): Point {
  return axis === 'x' ? { x: point.x, y: HEIGHT - point.y } : { x: WIDTH - point.x, y: point.y }
}

function feature(
  id: string,
  kind: SketchFeature['kind'],
  profile: SketchProfile,
  zTop: number,
  zBottom: number,
  authoringFace: SetupFace,
  role: SketchFeature['operation'] = 'subtract',
): SketchFeature {
  return {
    id,
    name: id,
    kind,
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: role,
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace,
    visible: true,
    locked: false,
  }
}

function operation(overrides: Partial<Operation> & Pick<Operation, 'kind' | 'target'>): Operation {
  return {
    id: 'op1',
    name: 'op',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    ...overrides,
  }
}

interface Extras {
  tabs?: Tab[]
  clamps?: Clamp[]
}

function baseProject(features: SketchFeature[], op: Operation, extras: Extras = {}): Project {
  const base = newProject('setup-generation', 'mm')
  base.meta = { ...base.meta, created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z' }
  base.stock = { ...base.stock, profile: rectProfile(0, 0, WIDTH, HEIGHT), thickness: THICKNESS }
  base.origin = { name: 'Origin', x: 0, y: HEIGHT, z: THICKNESS, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat 6', diameter: 6, maxCutDepth: 25 }]
  const project = projectWithFeatures(base, features)
  return syncProjectSetups({
    ...project,
    operations: [op],
    tabs: extras.tabs ?? [],
    clamps: extras.clamps ?? [],
  })
}

/** The project with its one operation moved to a Bottom setup flipped about `axis`. */
function inBottomSetup(project: Project, axis: Axis): Project {
  return withBottomSetup(project, { axis, operationIds: project.operations.map((entry) => entry.id) })
}

function generate(project: Project): ToolpathResult {
  const envelope = computeOperationToolpath(project, project.operations[0])
  assert(envelope, 'the operation kind is generated')
  return envelope.result
}

function exportProgram(project: Project, toolpath: ToolpathResult, definition: MachineDefinition): string {
  const op = project.operations[0]
  return runPostProcessor({
    project,
    definition,
    operations: [{ operation: op, tool: normalizeToolForProject(project.tools[0], project), toolpath }],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode
}

/** The program without the setup header a two-setup project writes. */
function withoutSetupHeader(program: string): string {
  const lineEnding = program.includes('\r\n') ? '\r\n' : '\n'
  const lines = program.split(lineEnding)
  const kept = lines.filter((line) => !/(SETUP \d\d:|REGISTRATION:|TOUCH OFF:)/.test(line))
  assert(lines.length - kept.length === 3, `the Bottom program carries a three-line setup header, found ${lines.length - kept.length}`)
  return kept.join(lineEnding)
}

/**
 * Bottom moves, in stock space, against the moves of the hand-mirrored Top
 * project: same count, same kinds, same feed scaling, and each point the
 * mirror of its counterpart — X or Y reflected across the stock centre and Z
 * reflected through mid-thickness.
 */
function assertTurnedMoves(bottom: ToolpathMove[], top: ToolpathMove[], axis: Axis, label: string): void {
  assert(bottom.length === top.length, `${label}: ${bottom.length} moves, expected ${top.length}`)
  assert(top.length > 0, `${label}: the mirrored Top project generates moves`)
  for (let index = 0; index < top.length; index += 1) {
    const a = bottom[index]
    const b = top[index]
    assert(a.kind === b.kind, `${label}: move ${index} is a ${a.kind}, expected a ${b.kind}`)
    assert(a.feedScale === b.feedScale, `${label}: move ${index} feed scale`)
    for (const end of ['from', 'to'] as const) {
      const expected = { ...mirrored(b[end], axis), z: THICKNESS - b[end].z }
      const got = a[end]
      assert(
        Math.abs(got.x - expected.x) <= EPSILON && Math.abs(got.y - expected.y) <= EPSILON && Math.abs(got.z - expected.z) <= EPSILON,
        `${label}: move ${index} ${end} is (${got.x}, ${got.y}, ${got.z}), expected (${expected.x}, ${expected.y}, ${expected.z})`,
      )
    }
  }
}

/** An L-shaped outline, off-centre and asymmetric, so no mirror or pivot error can hide. */
const L_SHAPE: Point[] = [
  { x: 12, y: 10 },
  { x: 52, y: 10 },
  { x: 52, y: 26 },
  { x: 30, y: 26 },
  { x: 30, y: 44 },
  { x: 12, y: 44 },
]

// ── Parity ────────────────────────────────────────────────────

function testPocketParity(): void {
  console.log('Testing a Bottom pocket equals the pocket drawn mirrored on a Top-only project...')
  for (const axis of ['x', 'y'] as const) {
    // Drawn on Bottom: 6 deep from the bottom face, so stock Z 0 → 6.
    const pocket = operation({ kind: 'pocket', target: { source: 'features', featureIds: ['pocket'] } })
    const bottomProject = inBottomSetup(
      baseProject([feature('pocket', 'polygon', polygonProfile(L_SHAPE), 6, 0, 'bottom')], pocket),
      axis,
    )
    assert(bottomProject.operations[0].setupId === BOTTOM_SETUP_ID, 'fixture: the operation is in the Bottom setup')

    // The same pocket as someone without setups would have drawn it: mirrored
    // by hand, 6 deep from the top face (stock Z 14 → 20), cut from Top.
    const mirroredOutline = L_SHAPE.map((point) => mirrored(point, axis))
    const topProject = baseProject(
      [feature('pocket', 'polygon', polygonProfile(mirroredOutline), 20, 14, 'top')],
      pocket,
    )

    const bottom = generate(bottomProject)
    const top = generate(topProject)
    assertTurnedMoves(bottom.moves, top.moves, axis, `pocket about ${axis}`)
    assert(bottom.warnings.length === top.warnings.length, `pocket about ${axis}: same warnings`)

    // Depth and safe-Z, in numbers. From Top the pocket floor is stock Z 14
    // and the cutter clears above the stock; from Bottom the floor is stock
    // Z 6 and the cutter clears *under* the stock.
    assert(top.bounds && bottom.bounds, 'both have bounds')
    assert(top.bounds.minZ === 14, `fixture: the Top pocket floor is at stock Z 14, got ${top.bounds.minZ}`)
    assert(Math.abs(bottom.bounds.maxZ - 6) <= EPSILON, `the Bottom pocket floor is at stock Z 6, got ${bottom.bounds.maxZ}`)
    assert(top.bounds.maxZ > THICKNESS, 'fixture: Top clears above the stock')
    assert(
      Math.abs(bottom.bounds.minZ - (THICKNESS - top.bounds.maxZ)) <= EPSILON && bottom.bounds.minZ < 0,
      `Bottom clears under the stock by the same distance, got ${bottom.bounds.minZ}`,
    )
    const cuts = bottom.moves.filter((move) => move.kind === 'cut')
    assert(cuts.length > 0 && cuts.every((move) => move.to.z >= -EPSILON && move.to.z <= 6 + EPSILON), 'every Bottom cut is inside stock Z 0 → 6')
    const rapidsAcross = bottom.moves.filter((move) => move.kind === 'rapid' && (move.from.x !== move.to.x || move.from.y !== move.to.y))
    assert(rapidsAcross.every((move) => move.to.z < 0 && move.from.z < 0), 'every Bottom rapid that travels does so under the stock')

    // The exported programs are the same program: mirrored coordinates, the
    // same depths below the face that is up and the same safe height above it.
    for (const definition of [GRBL, SHOPBOT]) {
      const bottomProgram = withoutSetupHeader(exportProgram(bottomProject, bottom, definition))
      const topProgram = exportProgram(topProject, top, definition)
      assert(bottomProgram === topProgram, `${definition.id}, about ${axis}: the Bottom program is the mirrored Top program`)
    }
  }
}

function testStockSpaceResultSitsOnTheFeature(): void {
  console.log('Testing the Bottom toolpath sits, in stock space, on the feature as drawn...')
  const pocket = operation({ kind: 'pocket', target: { source: 'features', featureIds: ['pocket'] } })
  const features = [feature('pocket', 'polygon', polygonProfile(L_SHAPE), 6, 0, 'bottom')]
  const programs: string[] = []
  for (const axis of ['x', 'y'] as const) {
    const project = inBottomSetup(baseProject(features, pocket), axis)
    const result = generate(project)
    // The 6 mm cutter stays 3 inside the outline's box, (12, 10) → (52, 44),
    // wherever the stock was flipped: the result is stored where the feature is.
    const cuts = result.moves.filter((move) => move.kind === 'cut')
    assert(cuts.length > 0, `about ${axis}: the pocket has cuts`)
    for (const move of cuts) {
      assert(
        move.to.x >= 15 - EPSILON && move.to.x <= 49 + EPSILON && move.to.y >= 13 - EPSILON && move.to.y <= 41 + EPSILON,
        `about ${axis}: a cut at (${move.to.x}, ${move.to.y}) is outside the pocket as drawn`,
      )
    }
    programs.push(exportProgram(project, result, GRBL))
  }
  // …and the flip axis decides which way the program mirrors it.
  assert(programs[0] !== programs[1], 'the flip axis changes the exported program')
}

function testDrillingParity(): void {
  console.log('Testing Bottom drilling: holes, depths and drill cycles are turned...')
  const holes = [{ x: 20, y: 15 }, { x: 70, y: 22 }, { x: 35, y: 60 }]
  const drill = operation({
    kind: 'drilling',
    drillType: 'peck',
    peckDepth: 2,
    retractHeight: 3,
    target: { source: 'features', featureIds: holes.map((_, index) => `hole${index}`) },
  })
  for (const axis of ['x', 'y'] as const) {
    // Blind holes drawn on Bottom, 8 deep: stock Z 0 → 8.
    const bottomProject = inBottomSetup(
      baseProject(holes.map((hole, index) => feature(`hole${index}`, 'circle', circleProfile(hole.x, hole.y, 3), 8, 0, 'bottom')), drill),
      axis,
    )
    const topProject = baseProject(
      holes.map((hole, index) => {
        const at = mirrored(hole, axis)
        return feature(`hole${index}`, 'circle', circleProfile(at.x, at.y, 3), 20, 12, 'top')
      }),
      drill,
    )
    const bottom = generate(bottomProject)
    const top = generate(topProject)
    assertTurnedMoves(bottom.moves, top.moves, axis, `drilling about ${axis}`)

    assert(top.drillCycles && bottom.drillCycles, 'both carry drill cycles')
    assert(top.drillCycles.length === holes.length && bottom.drillCycles.length === holes.length, 'one cycle per hole')
    top.drillCycles.forEach((cycle, index) => {
      const got = bottom.drillCycles![index]
      const at = mirrored({ x: cycle.x, y: cycle.y }, axis)
      assert(Math.abs(got.x - at.x) <= EPSILON && Math.abs(got.y - at.y) <= EPSILON, `drill cycle ${index} position about ${axis}`)
      assert(Math.abs(got.bottomZ - (THICKNESS - cycle.bottomZ)) <= EPSILON, `drill cycle ${index} bottom Z`)
      assert(Math.abs(got.retractZ - (THICKNESS - cycle.retractZ)) <= EPSILON, `drill cycle ${index} retract Z`)
      assert(Math.abs(got.clearZ - (THICKNESS - cycle.clearZ)) <= EPSILON, `drill cycle ${index} clear Z`)
      assert(got.peckDepth === cycle.peckDepth && got.drillType === cycle.drillType, `drill cycle ${index} keeps its peck and type`)
    })
    // In numbers: an 8 deep hole from the bottom face stops at stock Z 8.
    assert(Math.abs(bottom.drillCycles[0].bottomZ - 8) <= EPSILON, `the hole bottom is at stock Z 8, got ${bottom.drillCycles[0].bottomZ}`)
    assert(bottom.drillCycles[0].retractZ < 0 && bottom.drillCycles[0].clearZ < bottom.drillCycles[0].retractZ, 'retract and clearance are under the stock')

    // Canned cycles (GRBL has none; LinuxCNC does) and expanded moves both.
    for (const definition of [bundled('linuxcnc'), GRBL, SHOPBOT]) {
      assert(
        withoutSetupHeader(exportProgram(bottomProject, bottom, definition)) === exportProgram(topProject, top, definition),
        `${definition.id}, about ${axis}: the Bottom drilling program is the mirrored Top program`,
      )
    }
  }
}

function testTabsAndClampsTurnWithTheStock(): void {
  console.log('Testing tabs and clamps turn with the stock...')
  const outline: Point[] = [{ x: 20, y: 14 }, { x: 70, y: 14 }, { x: 70, y: 50 }, { x: 20, y: 50 }]
  const route = operation({
    kind: 'edge_route_outside',
    stepdown: 4,
    target: { source: 'features', featureIds: ['part'] },
  })
  // A tab holding the part at the top face (stock Z 16 → 20): from Bottom it
  // is the last material the route reaches. The clamp stands on the route.
  const tab: Tab = { id: 'tab1', name: 'Tab', x: 40, y: 8, w: 8, h: 10, z_top: 20, z_bottom: 16, visible: true }
  const clamp: Clamp = { id: 'c1', name: 'Clamp', type: 'step_clamp', x: 66, y: 28, w: 14, h: 10, height: 15, visible: true }

  for (const axis of ['x', 'y'] as const) {
    const bottomProject = inBottomSetup(
      baseProject([feature('part', 'polygon', polygonProfile(outline), 20, 0, 'bottom', 'add')], route, { tabs: [tab], clamps: [clamp] }),
      axis,
    )
    // By hand: the rectangles mirrored, the tab now at the bottom of the cut
    // (stock Z 0 → 4), the clamp the same height above the face that is up.
    const topProject = baseProject(
      [feature('part', 'polygon', polygonProfile(outline.map((point) => mirrored(point, axis))), 20, 0, 'top', 'add')],
      route,
      {
        tabs: [axis === 'x'
          ? { ...tab, y: HEIGHT - (tab.y + tab.h), z_top: 4, z_bottom: 0 }
          : { ...tab, x: WIDTH - (tab.x + tab.w), z_top: 4, z_bottom: 0 }],
        clamps: [axis === 'x'
          ? { ...clamp, y: HEIGHT - (clamp.y + clamp.h) }
          : { ...clamp, x: WIDTH - (clamp.x + clamp.w) }],
      },
    )
    const bottom = generate(bottomProject)
    const top = generate(topProject)
    assertTurnedMoves(bottom.moves, top.moves, axis, `edge route with a tab and a clamp about ${axis}`)

    // Both did something on the mirrored Top project, so a tab or clamp left
    // unturned would have changed the Bottom path.
    const withoutTab = generate({ ...topProject, tabs: [] })
    const withoutClamp = generate({ ...topProject, clamps: [] })
    assert(JSON.stringify(withoutTab.moves) !== JSON.stringify(top.moves), `fixture: the tab changes the route (about ${axis})`)
    assert(
      JSON.stringify(withoutClamp.moves) !== JSON.stringify(top.moves) || JSON.stringify(withoutClamp.warnings) !== JSON.stringify(top.warnings),
      `fixture: the clamp changes the route (about ${axis})`,
    )
    assert(JSON.stringify(bottom.warnings) === JSON.stringify(top.warnings), `tab and clamp warnings match about ${axis}`)
    assert(
      JSON.stringify(bottom.collidingClampIds ?? []) === JSON.stringify(top.collidingClampIds ?? []),
      `clamp collisions match about ${axis}`,
    )
    assert(
      JSON.stringify(bottom.collidingMoveIndices ?? []) === JSON.stringify(top.collidingMoveIndices ?? []),
      `colliding move indices still name the same moves about ${axis}`,
    )
  }
}

// ── Imported models ───────────────────────────────────────────

/**
 * A model with no symmetry: both its underside and its top are sloped, and
 * differently. Raw heights at the four corners, bottom then top.
 */
const MODEL_POSITIONS = new Float32Array([
  0, 0, 0, 40, 0, 2, 40, 30, 3, 0, 30, 1,
  0, 0, 6, 40, 0, 9, 40, 30, 13, 0, 30, 10,
])
const MODEL_INDEX = new Uint32Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
])

/** The stock with the model placed at (25, 20), filling stock Z 3 → 17, and one surface operation on it. */
function modelProject(op: Operation): Project {
  const base = newProject('setup-generation-model', 'mm')
  base.meta = { ...base.meta, created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z' }
  base.stock = { ...base.stock, profile: rectProfile(0, 0, WIDTH, HEIGHT), thickness: THICKNESS }
  base.origin = { name: 'Origin', x: 0, y: HEIGHT, z: THICKNESS, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Ball 6', type: 'ball_endmill', diameter: 6, maxCutDepth: 30 }]
  return syncProjectSetups({
    ...base,
    modelAssets: { asset: serializeImportedMesh({ positions: MODEL_POSITIONS, index: MODEL_INDEX, bounds: computeMeshBounds(MODEL_POSITIONS) }, 'stl') },
    featureDefinitions: {
      model: {
        id: 'model',
        kind: 'stl',
        profile: rectProfile(0, 0, 40, 30),
        dimensions: [],
        text: null,
        stl: {
          format: 'stl',
          scale: 1,
          axisSwap: 'none',
          meshAssetId: 'asset',
          silhouettePaths: [[{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }]],
        },
        operation: 'model',
      },
    },
    features: [{
      id: 'model',
      name: 'Model',
      definitionId: 'model',
      transform: { ...IDENTITY_MATRIX, e: 25, f: 20 },
      constraints: [],
      z_top: 17,
      z_bottom: 3,
      authoringFace: 'top',
      folderId: null,
      visible: true,
      locked: false,
    }],
    featureTree: [{ type: 'feature', featureId: 'model' }],
    operations: [op],
  })
}

/**
 * The model's surface in stock space at (x, y), read straight off the mesh as
 * drawn: its lowest and highest Z there, or null outside it. Brute force over
 * the triangles, and independent of everything the setup frame does.
 */
function modelSurfaceAt(project: Project, x: number, y: number): { low: number; high: number } | null {
  const geometry = loadSTLTransformedGeometry(resolvedFeature(project, 'model'), project)
  assert(geometry, 'fixture: the model loads')
  const { positions, index } = geometry
  let low = Infinity
  let high = -Infinity
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t] * 3, index[t + 1] * 3, index[t + 2] * 3]
    const [ax, ay, bx, by, cx, cy] = [positions[a], positions[a + 1], positions[b], positions[b + 1], positions[c], positions[c + 1]]
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(det) < 1e-12) continue
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det
    const w = 1 - u - v
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue
    const z = u * positions[a + 2] + v * positions[b + 2] + w * positions[c + 2]
    low = Math.min(low, z)
    high = Math.max(high, z)
  }
  return Number.isFinite(low) ? { low, high } : null
}

function testModelIsMachinedFromItsBackFace(): void {
  console.log('Testing an imported model is machined from its back face in a Bottom setup...')
  const template = modelProject(operation({ kind: 'pocket', target: { source: 'stock' } }))
  // Well inside the model's outline, (25, 20) → (65, 50), clear of its walls.
  const overModel = (move: ToolpathMove): boolean => (
    (move.kind === 'cut' || move.kind === 'plunge')
    && move.to.x > 31 && move.to.x < 59 && move.to.y > 26 && move.to.y < 44
  )

  for (const [kind, pass] of [['finish_surface', 'finish'], ['rough_surface', 'rough']] as const) {
    const op: Operation = {
      ...defaultOperationForTarget(template, kind, pass, { source: 'features', featureIds: ['model'] }, 0),
      id: 'op1',
      toolRef: 't1',
    }
    const topProject = modelProject(op)
    const top = generate(topProject).moves.filter(overModel)
    assert(top.length > 0, `${kind}: fixture: the Top operation cuts over the model`)
    // From Top the cutter never goes below the model's upper surface.
    for (const move of top) {
      const surface = modelSurfaceAt(topProject, move.to.x, move.to.y)
      assert(surface && move.to.z >= surface.high - 1e-3, `${kind} from Top: tip at Z ${move.to.z} is inside the model (surface ${surface?.high}) at (${move.to.x}, ${move.to.y})`)
    }

    for (const axis of ['x', 'y'] as const) {
      const bottomProject = inBottomSetup(topProject, axis)
      const result = generate(bottomProject)
      assert(!result.warnings.some((warning) => warning.code === 'setupTargetNotThrough'), `${kind} about ${axis}: a model is not refused from the other face`)
      const bottom = result.moves.filter(overModel)
      assert(bottom.length > 0, `${kind} about ${axis}: the Bottom operation cuts over the model`)
      // From Bottom the cutter comes up from under the stock and stops at the
      // model's underside: in stock space the tip is never above that surface.
      let closest = Infinity
      for (const move of bottom) {
        const surface = modelSurfaceAt(bottomProject, move.to.x, move.to.y)
        assert(surface, `${kind} about ${axis}: (${move.to.x}, ${move.to.y}) is over the model`)
        assert(
          move.to.z <= surface.low + 1e-3,
          `${kind} about ${axis}: tip at stock Z ${move.to.z} is inside the model (underside ${surface.low}) at (${move.to.x}, ${move.to.y})`,
        )
        closest = Math.min(closest, surface.low - move.to.z)
      }
      // …and it does reach that surface: this is the back face being cut, not air under it.
      assert(closest < 1.5, `${kind} about ${axis}: the cutter comes within ${closest} of the model's underside`)
      // The underside is not the top surface mirrored: the two programs differ in depth.
      const topDepths = top.map((move) => THICKNESS - move.to.z)
      const bottomDepths = bottom.map((move) => move.to.z)
      assert(
        Math.abs(Math.max(...topDepths) - Math.max(...bottomDepths)) > 0.5,
        `${kind} about ${axis}: fixture: the two faces are cut to different depths`,
      )
    }
  }
}

// ── Target rules at generation ────────────────────────────────

function testCrossFaceThroughFeature(): void {
  console.log('Testing a through-feature is cut from the other setup...')
  // A through slot drawn on Top, routed from Bottom.
  const slot = [{ x: 15, y: 12 }, { x: 45, y: 12 }, { x: 45, y: 30 }, { x: 15, y: 30 }]
  const pocket = operation({ kind: 'pocket', target: { source: 'features', featureIds: ['slot'] } })
  const bottomProject = inBottomSetup(
    baseProject([feature('slot', 'polygon', polygonProfile(slot), 20, 0, 'top')], pocket),
    'x',
  )
  const topProject = baseProject(
    [feature('slot', 'polygon', polygonProfile(slot.map((point) => mirrored(point, 'x'))), 20, 0, 'top')],
    pocket,
  )
  const bottom = generate(bottomProject)
  assertTurnedMoves(bottom.moves, generate(topProject).moves, 'x', 'cross-face through pocket')
  assert(!bottom.warnings.some((warning) => warning.code === 'setupTargetNotThrough'), 'a through-feature is not refused')
}

function testCrossFaceBlindFeatureIsRefused(): void {
  console.log('Testing a blind feature on the other face generates nothing, with a reason...')
  const outline = polygonProfile(L_SHAPE)
  const pocket = operation({ kind: 'pocket', target: { source: 'features', featureIds: ['Tray'] } })

  // Drawn on Top, 6 deep; targeted from Bottom.
  const fromBottom = generate(inBottomSetup(baseProject([feature('Tray', 'polygon', outline, 20, 14, 'top')], pocket), 'x'))
  assert(fromBottom.moves.length === 0 && fromBottom.bounds === null, 'no motion from Bottom')
  assert(fromBottom.warnings.length === 1 && fromBottom.warnings[0].code === 'setupTargetNotThrough', 'the reason is given')
  assert(fromBottom.warnings[0].params?.features === 'Tray', 'the reason names the feature')

  // Drawn on Bottom, 6 deep; targeted from Top.
  const fromTop = generate(baseProject([feature('Tray', 'polygon', outline, 6, 0, 'bottom')], pocket))
  assert(fromTop.moves.length === 0 && fromTop.warnings[0]?.code === 'setupTargetNotThrough', 'no motion from Top either')

  // The same features on their own face generate.
  assert(generate(baseProject([feature('Tray', 'polygon', outline, 20, 14, 'top')], pocket)).moves.length > 0, 'the Top pocket generates from Top')
}

// ── Top is untouched ──────────────────────────────────────────

function testTopIsUntouched(): void {
  console.log('Testing a Top operation generates as it did before setups...')
  const pocket = operation({ kind: 'pocket', target: { source: 'features', featureIds: ['pocket'] } })
  const project = baseProject([feature('pocket', 'polygon', polygonProfile(L_SHAPE), 20, 14, 'top')], pocket)
  const before = generate(project)
  assert(before.moves.length > 0, 'fixture: the Top pocket generates')

  // A Bottom setup beside it, with another operation in it, changes nothing.
  const beside: Project = withBottomSetup(
    { ...project, operations: [...project.operations, { ...pocket, id: 'op2', name: 'other' }] },
    { operationIds: ['op2'] },
  )
  const after = computeOperationToolpath(beside, beside.operations[0])
  assert(after && JSON.stringify(after.result) === JSON.stringify(before), 'a Top operation beside a Bottom setup is unchanged')

  // The pre-setup in-memory shape: no setups, no setupId, no authoringFace.
  const legacy = withoutSetupFields(project) as unknown as Project
  const legacyResult = computeOperationToolpath(legacy, legacy.operations[0])
  assert(legacyResult && JSON.stringify(legacyResult.result) === JSON.stringify(before), 'the legacy shape generates the same toolpath')
}

function testRawTraceIsTurnedToo(): void {
  console.log('Testing the pre-optimization trace comes back in stock space...')
  const pocket = operation({ kind: 'pocket', target: { source: 'features', featureIds: ['pocket'] } })
  const project = inBottomSetup(baseProject([feature('pocket', 'polygon', polygonProfile(L_SHAPE), 6, 0, 'bottom')], pocket), 'x')
  const envelope = computeOperationToolpath(project, project.operations[0], { trace: true })
  assert(envelope && envelope.raw, 'a trace was captured')
  const cuts = envelope.raw.moves.filter((move) => move.kind === 'cut')
  assert(cuts.length > 0 && cuts.every((move) => move.to.z <= 6 + EPSILON), 'the raw trace is in stock space too')
}

testPocketParity()
testStockSpaceResultSitsOnTheFeature()
testDrillingParity()
testTabsAndClampsTurnWithTheStock()
testModelIsMachinedFromItsBackFace()
testCrossFaceThroughFeature()
testCrossFaceBlindFeatureIsRefused()
testTopIsUntouched()
testRawTraceIsTurnedToo()

console.log('setup generation tests passed')
