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
 * The project turned into a setup's frame, in numbers (issue #946).
 *
 * The stock is 100 × 80 × 20 at (10, 5) — off the origin and not square, so
 * a mirror about the wrong line, or about the origin, is visible. Its centre
 * is (60, 45): about X a point reads (x, 90 − y, 20 − z), about Y
 * (120 − x, y, 20 − z).
 *
 * `setupGeneration.test.ts` proves the frame end to end against a
 * hand-mirrored project. This file pins each piece on its own, so a failure
 * there can be traced to the piece that moved.
 *
 * Run with: npx tsx src/engine/setupFrameProject.test.ts
 */

import { circleProfile, defaultTool, IDENTITY_MATRIX, newProject, polygonProfile, rectProfile } from '../types/project'
import type { Point, Project, SketchFeature, SketchProfile } from '../types/project'
import { projectWithFeatures, resolvedFeature, withBottomSetup } from '../test/projectFixtures'
import { loadSTLTransformedGeometry } from './csg'
import { computeMeshBounds, serializeImportedMesh } from './importedMesh'
import { isModelTurnedOver, modelDataTurnedOver } from './importedModelTransform'
import { resolvedProjectFeatures } from '../store/helpers/resolveFeatures'
import { getFeatureGeometryProfiles, getTextFrameProfile } from '../text'
import { projectInSetupFrame, setupPlanMirror, toolpathInStockFrame } from './setupFrameProject'
import { canonicalToSetupPoint, setupFrame } from './setupOrientation'
import type { PocketToolpathResult, ToolpathResult } from './toolpaths/types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

function feature(id: string, kind: SketchFeature['kind'], profile: SketchProfile, zTop: number | string, zBottom: number | string): SketchFeature {
  return {
    id,
    name: id,
    kind,
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

const ARC_PROFILE: SketchProfile = {
  start: { x: 30, y: 20 },
  segments: [
    { type: 'line', to: { x: 50, y: 20 } },
    { type: 'arc', to: { x: 50, y: 40 }, center: { x: 50, y: 30 }, clockwise: true },
    { type: 'line', to: { x: 30, y: 40 } },
    { type: 'line', to: { x: 30, y: 20 } },
  ],
  closed: true,
}

function makeProject(): Project {
  const base = newProject('Frame', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(10, 5, 100, 80), thickness: 20 }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1' }]
  base.dimensions = { depth: { id: 'depth', name: 'depth', value: 13, formula: null } }
  const project = projectWithFeatures(base, [
    feature('rect', 'rect', rectProfile(20, 15, 30, 10), 20, 14),
    feature('floating', 'rect', rectProfile(60, 50, 10, 10), 'depth', 4),
    feature('hole', 'circle', circleProfile(80, 25, 4), 20, 0),
    feature('arc', 'composite', ARC_PROFILE, 6, 0),
  ])
  return {
    ...withBottomSetup(project),
    // A placed copy: the mirror has to compose onto a transform that is not the identity.
    features: project.features.map((entry) => (
      entry.id === 'rect' ? { ...entry, transform: { ...IDENTITY_MATRIX, e: 5, f: 3 } } : entry
    )),
    tabs: [{ id: 'tab', name: 'Tab', x: 30, y: 10, w: 8, h: 6, z_top: 3, z_bottom: 0, visible: true }],
    clamps: [{ id: 'clamp', name: 'Clamp', type: 'step_clamp', x: 90, y: 60, w: 15, h: 20, height: 12, visible: true }],
  }
}

function profilePoints(profile: SketchProfile): Point[] {
  return [profile.start, ...profile.segments.map((segment) => segment.to)]
}

function testTopIsTheSameObject(): void {
  console.log('Testing a Top frame hands the project back untouched...')
  const project = makeProject()
  assert(projectInSetupFrame(project, undefined) === project, 'no frame: the same object')
  assert(projectInSetupFrame(project, setupFrame({ axis: 'x', angleDeg: 0 }, project.stock)) === project, '0°: the same object')
  const result: ToolpathResult = { operationId: 'op', moves: [], warnings: [], bounds: null }
  assert(toolpathInStockFrame(result, undefined) === result, 'no frame: the same toolpath object')
  assert(toolpathInStockFrame(result, setupFrame({ axis: 'y', angleDeg: 0 }, project.stock)) === result, '0°: the same toolpath object')
}

function testFeaturesTurn(): void {
  console.log('Testing features turn: plan mirror and Z span...')
  const project = makeProject()
  const before = new Map(resolvedProjectFeatures(project).map((entry) => [entry.id, entry]))

  for (const axis of ['x', 'y'] as const) {
    const frame = setupFrame({ axis, angleDeg: 180 }, project.stock)
    const turned = projectInSetupFrame(project, frame)
    const after = new Map(resolvedProjectFeatures(turned).map((entry) => [entry.id, entry]))
    const mirror = (point: Point): Point => (axis === 'x' ? { x: point.x, y: 90 - point.y } : { x: 120 - point.x, y: point.y })

    for (const id of ['rect', 'floating', 'hole', 'arc']) {
      assertEqual(
        profilePoints(after.get(id)!.sketch.profile),
        profilePoints(before.get(id)!.sketch.profile).map(mirror),
        `${id} about ${axis}: every vertex is mirrored across the stock centre`,
      )
    }
    // Mirroring reverses the sense of an arc and a circle.
    const arcBefore = before.get('arc')!.sketch.profile.segments[1]
    const arcAfter = after.get('arc')!.sketch.profile.segments[1]
    assert(arcBefore.type === 'arc' && arcAfter.type === 'arc', 'the arc stays an arc')
    assert(arcAfter.clockwise === !arcBefore.clockwise, `arc about ${axis}: the sense is reversed`)
    assertEqual(arcAfter.center, mirror(arcBefore.center), `arc about ${axis}: the centre is mirrored`)
    const circleAfter = after.get('hole')!.sketch.profile.segments[0]
    assert(circleAfter.type === 'circle', 'the circle stays a circle')
    assertEqual(circleAfter.center, mirror({ x: 80, y: 25 }), `circle about ${axis}: the centre is mirrored`)

    // Z: reflected through mid-thickness, and still top above bottom.
    const span = (id: string) => {
      const row = turned.features.find((entry) => entry.id === id)!
      return [row.z_top, row.z_bottom]
    }
    assertEqual(span('rect'), [6, 0], `about ${axis}: a pocket 6 deep from the top is 6 up from the bottom`)
    assertEqual(span('floating'), [16, 7], `about ${axis}: a floating span stays floating, its named top resolved`)
    assertEqual(span('hole'), [20, 0], `about ${axis}: a through span is unchanged`)
    assertEqual(span('arc'), [20, 14], `about ${axis}: a pocket open at the bottom opens at the top`)
  }

  // The source is never written to.
  assertEqual(project.features.find((entry) => entry.id === 'floating')!.z_top, 'depth', 'the source project keeps its named dimension')
}

function testStockTabsAndClamps(): void {
  console.log('Testing stock, tabs and clamps turn; the origin does not...')
  const project = makeProject()
  const aboutX = projectInSetupFrame(project, setupFrame({ axis: 'x', angleDeg: 180 }, project.stock))
  const aboutY = projectInSetupFrame(project, setupFrame({ axis: 'y', angleDeg: 180 }, project.stock))

  for (const turned of [aboutX, aboutY]) {
    const xs = profilePoints(turned.stock.profile).map((point) => point.x)
    const ys = profilePoints(turned.stock.profile).map((point) => point.y)
    assertEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [10, 110, 5, 85], 'the turned stock occupies the same box')
    assertEqual(turned.stock.thickness, 20, 'and is as thick')
    assert(turned.origin === project.origin, 'the origin is shared, not turned')
    assert(turned.setups.every((setup) => setup.orientation.angleDeg === 0), 'the turned project reads as unturned, so it cannot be turned twice')
    assert(turned.modelAssets === project.modelAssets && turned.tools === project.tools, 'what has no position is shared, not copied')
  }

  // A stock that is not its own mirror image: a notch cut from one corner.
  // Its bounds, and so the pivot, are still the 100 × 80 box at (10, 5).
  const notched: Project = {
    ...project,
    stock: {
      ...project.stock,
      profile: polygonProfile([
        { x: 10, y: 5 }, { x: 110, y: 5 }, { x: 110, y: 85 }, { x: 40, y: 85 }, { x: 40, y: 60 }, { x: 10, y: 60 },
      ]),
    },
  }
  assertEqual(
    profilePoints(projectInSetupFrame(notched, setupFrame({ axis: 'x', angleDeg: 180 }, notched.stock)).stock.profile).slice(0, 6),
    [{ x: 10, y: 85 }, { x: 110, y: 85 }, { x: 110, y: 5 }, { x: 40, y: 5 }, { x: 40, y: 30 }, { x: 10, y: 30 }],
    'the stock outline is mirrored about X: the notch moves to the other edge',
  )
  assertEqual(
    profilePoints(projectInSetupFrame(notched, setupFrame({ axis: 'y', angleDeg: 180 }, notched.stock)).stock.profile).slice(0, 6),
    [{ x: 110, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 85 }, { x: 80, y: 85 }, { x: 80, y: 60 }, { x: 110, y: 60 }],
    'and about Y',
  )

  // Tab at (30, 10) 8 × 6, stock Z 0 → 3. About X its far edge y = 16 maps to 74.
  assertEqual(
    { x: aboutX.tabs[0].x, y: aboutX.tabs[0].y, w: aboutX.tabs[0].w, h: aboutX.tabs[0].h, top: aboutX.tabs[0].z_top, bottom: aboutX.tabs[0].z_bottom },
    { x: 30, y: 74, w: 8, h: 6, top: 20, bottom: 17 },
    'tab about X',
  )
  assertEqual(
    { x: aboutY.tabs[0].x, y: aboutY.tabs[0].y, top: aboutY.tabs[0].z_top, bottom: aboutY.tabs[0].z_bottom },
    { x: 82, y: 10, top: 20, bottom: 17 },
    'tab about Y',
  )
  // Clamp at (90, 60) 15 × 20: it keeps its height above whichever face is up.
  assertEqual({ x: aboutX.clamps[0].x, y: aboutX.clamps[0].y, height: aboutX.clamps[0].height }, { x: 90, y: 10, height: 12 }, 'clamp about X')
  assertEqual({ x: aboutY.clamps[0].x, y: aboutY.clamps[0].y, height: aboutY.clamps[0].height }, { x: 15, y: 60, height: 12 }, 'clamp about Y')
}

function testPlanMirrorMatchesThePointTransform(): void {
  console.log('Testing the plan mirror is the point transform seen from above...')
  const project = makeProject()
  for (const axis of ['x', 'y'] as const) {
    const frame = setupFrame({ axis, angleDeg: 180 }, project.stock)
    const m = setupPlanMirror(frame)
    for (const point of [{ x: 0.1, y: 0.2 }, { x: 33.3333, y: 71.7 }, { x: 110, y: 5 }]) {
      const viaMatrix = { x: m.a * point.x + m.c * point.y + m.e, y: m.b * point.x + m.d * point.y + m.f }
      const viaPoint = canonicalToSetupPoint({ ...point, z: 0 }, frame)
      // Exactly equal, not merely close: a profile resolved through the matrix
      // must land on the points the toolpath transform maps back from.
      assert(viaMatrix.x === viaPoint.x && viaMatrix.y === viaPoint.y, `about ${axis}: the matrix and the point transform agree exactly at (${point.x}, ${point.y})`)
    }
  }
}

function testTextTurns(): void {
  console.log('Testing text turns with its glyphs mirrored...')
  const base = newProject('Text', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(10, 5, 100, 80), thickness: 20 }
  // "F4" has no mirror symmetry, so an unmirrored glyph cannot pass for a mirrored one.
  const textData = { text: 'F4', style: 'outline' as const, fontId: 'helvetiker_regular' as const, size: 10 }
  const config = { ...textData, operation: 'subtract' as const }
  const text: SketchFeature = {
    ...feature('text', 'text', getTextFrameProfile(config, { x: 25, y: 30 }), 20, 18),
    text: textData,
  }
  const project = withBottomSetup(projectWithFeatures(base, [text]))
  const [before] = resolvedProjectFeatures(project)
  const frame = setupFrame({ axis: 'x', angleDeg: 180 }, project.stock)
  const [after] = resolvedProjectFeatures(projectInSetupFrame(project, frame))

  const glyphsBefore = getFeatureGeometryProfiles(before)
  const glyphsAfter = getFeatureGeometryProfiles(after)
  assert(glyphsBefore.length > 1 && glyphsAfter.length === glyphsBefore.length, 'the same glyph outlines, turned')
  glyphsBefore.forEach((glyph, index) => {
    const expected = profilePoints(glyph).map((point) => ({ x: point.x, y: 90 - point.y }))
    const got = profilePoints(glyphsAfter[index])
    assert(got.length === expected.length, `glyph ${index}: same vertex count`)
    got.forEach((point, vertex) => {
      assert(
        Math.abs(point.x - expected[vertex].x) <= 1e-9 && Math.abs(point.y - expected[vertex].y) <= 1e-9,
        `glyph ${index} vertex ${vertex}: (${point.x}, ${point.y}), expected (${expected[vertex].x}, ${expected[vertex].y})`,
      )
    })
  })
}

function testToolpathBackToStockSpace(): void {
  console.log('Testing a toolpath is carried back into stock space...')
  const project = makeProject()
  const frame = setupFrame({ axis: 'x', angleDeg: 180 }, project.stock)
  const local: PocketToolpathResult = {
    operationId: 'op',
    warnings: [{ code: 'debug' }],
    moves: [
      { kind: 'rapid', from: { x: 20, y: 30, z: 25 }, to: { x: 20, y: 30, z: 25 } },
      { kind: 'plunge', from: { x: 20, y: 30, z: 25 }, to: { x: 20, y: 30, z: 14 } },
      { kind: 'cut', from: { x: 20, y: 30, z: 14 }, to: { x: 40, y: 50, z: 14 }, feedScale: 0.5, source: 'ring' },
    ],
    bounds: { minX: 20, minY: 30, minZ: 14, maxX: 40, maxY: 50, maxZ: 25 },
    drillCycles: [{ x: 20, y: 30, clearZ: 30, retractZ: 22, bottomZ: 8, drillType: 'peck', peckDepth: 2 }],
    collidingMoveIndices: [2],
    stepLevels: [18, 14],
  }
  const stock = toolpathInStockFrame(local, frame)

  // (x, 90 − y, 20 − z): the cut 6 below the face that is up is 6 above the bottom face.
  assertEqual(stock.moves.map((move) => move.to), [
    { x: 20, y: 60, z: -5 },
    { x: 20, y: 60, z: 6 },
    { x: 40, y: 40, z: 6 },
  ], 'move ends')
  assertEqual(stock.moves[2].from, { x: 20, y: 60, z: 6 }, 'move starts')
  assertEqual([stock.moves[2].kind, stock.moves[2].feedScale, stock.moves[2].source], ['cut', 0.5, 'ring'], 'a move keeps everything but its points')
  assertEqual(stock.bounds, { minX: 20, minY: 40, minZ: -5, maxX: 40, maxY: 60, maxZ: 6 }, 'bounds are re-measured, not just relabelled')
  assertEqual(
    stock.drillCycles,
    [{ x: 20, y: 60, clearZ: -10, retractZ: -2, bottomZ: 12, drillType: 'peck', peckDepth: 2 }],
    'drill cycles: position and every height',
  )
  assertEqual(stock.stepLevels, [2, 6], 'cut levels')
  assertEqual(stock.collidingMoveIndices, [2], 'indices into moves still name the same moves')
  assertEqual(stock.warnings, local.warnings, 'warnings ride through')
  assertEqual(local.moves[1].to, { x: 20, y: 30, z: 14 }, 'the input is not written to')

  // About Y: (120 − x, y, 20 − z).
  const aboutY = toolpathInStockFrame(local, setupFrame({ axis: 'y', angleDeg: 180 }, project.stock))
  assertEqual(aboutY.moves[2].to, { x: 80, y: 50, z: 6 }, 'about Y')
  assertEqual(aboutY.bounds, { minX: 80, minY: 30, minZ: -5, maxX: 100, maxY: 50, maxZ: 6 }, 'bounds about Y')

  // A half turn undoes itself.
  assertEqual(toolpathInStockFrame(stock, frame).moves, local.moves, 'turning twice is the identity')
  assert(toolpathInStockFrame({ ...local, bounds: null }, frame).bounds === null, 'no bounds stays no bounds')
}

/**
 * An imported model is turned over with the stock (issue #946): what a
 * generator loads for the turned project is, vertex for vertex, the half turn
 * of what it loads for the project as drawn. The mesh is a wedge with no
 * symmetry at all — every vertex has its own height — placed off-centre,
 * scaled and rotated in plan, so a missing mirror, an unreflected Z or a turn
 * about the wrong point each move a vertex.
 */
function testModelTurnsOver(): void {
  console.log('Testing an imported model is turned over with the stock...')
  const positions = new Float32Array([
    0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0,
    0, 0, 1, 4, 0, 2, 4, 3, 5, 0, 3, 3,
  ])
  const index = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ])
  const base = newProject('Model', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(10, 5, 100, 80), thickness: 20 }
  const project: Project = withBottomSetup({
    ...base,
    modelAssets: { asset: serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl') },
    featureDefinitions: {
      model: {
        id: 'model',
        kind: 'stl',
        profile: rectProfile(0, 0, 8, 6),
        dimensions: [],
        text: null,
        stl: {
          format: 'stl',
          scale: 2,
          axisSwap: 'none',
          orientation: { rx: 0, ry: 0, rz: 90 },
          meshAssetId: 'asset',
          silhouettePaths: [[{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 6 }, { x: 0, y: 6 }]],
        },
        operation: 'model',
      },
    },
    features: [{
      id: 'model',
      name: 'Model',
      definitionId: 'model',
      // Rotated 90° in plan and moved off the stock centre.
      transform: { a: 0, b: 1, c: -1, d: 0, e: 70, f: 20 },
      constraints: [],
      z_top: 17,
      z_bottom: 4,
      authoringFace: 'top',
      folderId: null,
      visible: true,
      locked: false,
    }],
    featureTree: [{ type: 'feature', featureId: 'model' }],
  })

  const asDrawn = loadSTLTransformedGeometry(resolvedFeature(project, 'model'), project)
  assert(asDrawn, 'fixture: the model loads')
  const zs = Array.from(asDrawn.positions).filter((_, i) => i % 3 === 2)
  assert(Math.min(...zs) === 4 && Math.max(...zs) === 17, 'fixture: the model fills its span, stock Z 4 → 17')

  for (const axis of ['x', 'y'] as const) {
    const frame = setupFrame({ axis, angleDeg: 180 }, project.stock)
    const turnedProject = projectInSetupFrame(project, frame)
    const turned = loadSTLTransformedGeometry(resolvedFeature(turnedProject, 'model'), turnedProject)
    assert(turned, `about ${axis}: the turned model loads`)
    assert(turned !== asDrawn, `about ${axis}: turned geometry is not served from the as-drawn cache entry`)
    assert(turned.positions.length === asDrawn.positions.length, `about ${axis}: same vertex count`)
    for (let i = 0; i < asDrawn.positions.length; i += 3) {
      const expected = canonicalToSetupPoint({ x: asDrawn.positions[i], y: asDrawn.positions[i + 1], z: asDrawn.positions[i + 2] }, frame)
      const got = { x: turned.positions[i], y: turned.positions[i + 1], z: turned.positions[i + 2] }
      assert(
        Math.abs(got.x - expected.x) < 1e-4 && Math.abs(got.y - expected.y) < 1e-4 && Math.abs(got.z - expected.z) < 1e-4,
        `about ${axis}: vertex ${i / 3} is (${got.x}, ${got.y}, ${got.z}), expected the half turn (${expected.x}, ${expected.y}, ${expected.z})`,
      )
    }
    // The flat base, at stock Z 4, is now the top of the model: 20 − 4.
    const turnedZs = Array.from(turned.positions).filter((_, i) => i % 3 === 2)
    assert(Math.max(...turnedZs) === 16 && Math.min(...turnedZs) === 3, `about ${axis}: the model occupies the reflected span, 3 → 16`)
    assert(turnedZs.filter((z) => z === 16).length === 4, `about ${axis}: its flat base is the face that is up`)
    assert(Array.from(turned.index).join() === Array.from(asDrawn.index).join(), `about ${axis}: triangles keep their winding — a half turn is a rotation`)
    // The silhouette a 2.5D operation reads is the mirror of the original.
    const before = resolvedFeature(project, 'model').stl?.silhouettePaths?.[0] ?? []
    const after = resolvedFeature(turnedProject, 'model').stl?.silhouettePaths?.[0] ?? []
    assertEqual(after, before.map((point) => (axis === 'x' ? { x: point.x, y: 90 - point.y } : { x: 120 - point.x, y: point.y })), `about ${axis}: the silhouette is mirrored`)
  }

  // The mark alone — same placement, same span — is other geometry, so it
  // must not be answered from the as-drawn cache entry: reflected in Z only.
  const drawnFeature = resolvedFeature(project, 'model')
  const markedOnly = loadSTLTransformedGeometry({ ...drawnFeature, stl: modelDataTurnedOver(drawnFeature.stl!) }, project)
  assert(markedOnly && markedOnly !== asDrawn, 'marked data at the same placement is not served the as-drawn geometry')
  for (let i = 0; i < asDrawn.positions.length; i += 3) {
    assert(
      markedOnly.positions[i] === asDrawn.positions[i] && markedOnly.positions[i + 1] === asDrawn.positions[i + 1]
      && Math.abs(markedOnly.positions[i + 2] - (21 - asDrawn.positions[i + 2])) < 1e-4,
      `the mark reflects vertex ${i / 3} inside the model's own span, 4 → 17`,
    )
  }

  // The source is untouched, and still loads as drawn.
  assert(loadSTLTransformedGeometry(resolvedFeature(project, 'model'), project) === asDrawn, 'the project as drawn still loads its own geometry')
  assert(!isModelTurnedOver(project.featureDefinitions.model.stl), 'the source definition is not marked')
  // The mark cannot be saved or sent to the worker by accident.
  const marked = projectInSetupFrame(project, setupFrame({ axis: 'x', angleDeg: 180 }, project.stock)).featureDefinitions.model.stl
  assert(isModelTurnedOver(marked), 'the turned definition is marked')
  assert(!isModelTurnedOver(JSON.parse(JSON.stringify(marked))), 'the mark does not survive serialization')
  assert(!isModelTurnedOver(structuredClone(marked)), 'nor a structured clone')
  assert(JSON.stringify(marked) === JSON.stringify(project.featureDefinitions.model.stl), 'and the saved form is unchanged')
}

testTopIsTheSameObject()
testModelTurnsOver()
testFeaturesTurn()
testStockTabsAndClamps()
testPlanMirrorMatchesThePointTransform()
testTextTurns()
testToolpathBackToStockSpace()

console.log('setup frame project tests passed')
