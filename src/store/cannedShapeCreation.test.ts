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
 * The five flat canned shapes through the real creation and edit paths
 * (issue #1112 slice D).
 *
 * Run with: npx tsx src/store/cannedShapeCreation.test.ts
 *
 * Load-bearing properties, one per shape:
 *   1. The outline resolved from a created feature is the outline the old
 *      one-shot command drew, for several parameter sets — an operation on the
 *      canned shape cuts what it cut before.
 *   2. Save → load → regenerate is the same geometry.
 *   3. An old project's plain outline stays plain and editable.
 *   4. Hit testing follows the generated outline, not the placement frame.
 *   5. One parameter edit through `updateFeature` is one undo step.
 */

import {
  ellipseProfile,
  ngonProfile,
  slotProfile,
  newProject,
  type CannedShapeData,
  type FeatureDefinition,
  type Project,
  type SketchProfile,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { resolvedProjectFeatures, type ResolvedSketchFeature } from './helpers/resolveFeatures'
import { normalizeProject } from './helpers/projectFormat'
import { chamferedRectProfile, roundedRectProfile } from './helpers/cannedRectProfiles'
import { resolveCannedShapeProfiles } from '../cannedShapes'
import { findHitFeatureId } from '../components/canvas/hitTest'
import type { ViewTransform } from '../components/canvas/viewTransform'
import type { FeatureLike } from '../components/canvas/hitTest'

let passCount = 0
let failCount = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`✓ ${name}`)
    passCount += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).message}`)
    failCount += 1
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
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
    },
    history: { past: [], future: [], transactionStart: null },
    sketchEditSession: null,
    pendingConstraint: null,
    pendingTransform: null,
    pendingOffset: null,
  } as unknown as Partial<ProjectStore>)
}

function project(): Project {
  return useProjectStore.getState().project
}

function onlyFeature(): ResolvedSketchFeature {
  const features = resolvedProjectFeatures(project())
  assert(features.length === 1, `expected one feature, got ${features.length}`)
  return features[0]
}

/** The world-space outline the created canned shape draws. */
function onlyProfile(): SketchProfile {
  const profiles = resolveCannedShapeProfiles(onlyFeature())
  assert(profiles.length === 1, `expected one generated outline, got ${profiles.length}`)
  return profiles[0]
}

/**
 * Compare two outlines point by point, so an arc or Bézier written from a
 * transformed definition matches the one the old command computed directly.
 * Sampling would depend on a step-count threshold; the fields themselves are
 * the geometry. The tolerance is float noise, not design slack.
 */
function assertSameOutline(actual: SketchProfile, expected: SketchProfile, label: string): void {
  assert(actual.closed === expected.closed, `${label}: closed differs`)
  assertPoint(actual.start, expected.start, `${label}: start`)
  assert(
    actual.segments.length === expected.segments.length,
    `${label}: segment count ${actual.segments.length} vs ${expected.segments.length}`,
  )
  actual.segments.forEach((segment, index) => {
    const expectedSegment = expected.segments[index]
    assert(segment.type === expectedSegment.type, `${label}: segment ${index} is ${segment.type}, expected ${expectedSegment.type}`)
    assertPoint(segment.to, expectedSegment.to, `${label}: segment ${index} end`)
    if (segment.type === 'arc' || segment.type === 'circle') {
      assert(expectedSegment.type === segment.type, `${label}: segment ${index} kind mismatch`)
      assertPoint(segment.center, expectedSegment.center, `${label}: segment ${index} centre`)
      assert(segment.clockwise === expectedSegment.clockwise, `${label}: segment ${index} winding`)
    } else if (segment.type === 'bezier') {
      assert(expectedSegment.type === 'bezier', `${label}: segment ${index} kind mismatch`)
      assertPoint(segment.control1, expectedSegment.control1, `${label}: segment ${index} control 1`)
      assertPoint(segment.control2, expectedSegment.control2, `${label}: segment ${index} control 2`)
    }
  })
}

function assertPoint(actual: { x: number; y: number }, expected: { x: number; y: number }, label: string): void {
  assert(
    Math.abs(actual.x - expected.x) <= 1e-6 && Math.abs(actual.y - expected.y) <= 1e-6,
    `${label}: expected (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`,
  )
}

function assertCanned(kind: string, params: Record<string, unknown>): void {
  const canned = onlyFeature().canned
  assert(canned?.kind === kind, `expected canned kind ${kind}, got ${canned?.kind}`)
  for (const [key, value] of Object.entries(params)) {
    assert(canned?.params[key] === value, `expected ${kind}.${key} = ${String(value)}, got ${String(canned?.params[key])}`)
  }
}

// ── 1. Equivalence with the old one-shot command ────────────────────

const ELLIPSES = [
  { cx: 50, cy: 50, rx: 30, ry: 20 },
  { cx: 0, cy: 0, rx: 1, ry: 1 },
  { cx: 120, cy: -40, rx: 5, ry: 60 },
]

ELLIPSES.forEach(({ cx, cy, rx, ry }, index) => {
  test(`ellipse ${index + 1}: created outline is the old ellipseProfile`, () => {
    resetStore()
    useProjectStore.getState().addEllipseFeature('Ellipse', cx, cy, rx, ry, 5)
    assertCanned('ellipse', { rx, ry })
    assertSameOutline(onlyProfile(), ellipseProfile(cx, cy, rx, ry), 'ellipse')
  })
})

const SLOTS = [
  { p1: { x: 10, y: 10 }, p2: { x: 90, y: 10 }, width: 10 },
  { p1: { x: 0, y: 0 }, p2: { x: 0, y: 50 }, width: 4 },
  { p1: { x: 5, y: 5 }, p2: { x: 60, y: 40 }, width: 8 },
]

SLOTS.forEach(({ p1, p2, width }, index) => {
  test(`slot ${index + 1}: created outline is the old slotProfile`, () => {
    resetStore()
    useProjectStore.getState().addSlotFeature('Slot', p1, p2, width, 5)
    assertCanned('slot', { length: Math.hypot(p2.x - p1.x, p2.y - p1.y), width })
    assertSameOutline(onlyProfile(), slotProfile(p1, p2, width), 'slot')
  })
})

const NGONS = [
  { sides: 6, radius: 20, angle: 0 },
  { sides: 3, radius: 15, angle: 0.5 },
  { sides: 12, radius: 5, angle: -1.2 },
]

NGONS.forEach(({ sides, radius, angle }, index) => {
  test(`regular polygon ${index + 1}: created outline is the old ngonProfile`, () => {
    resetStore()
    useProjectStore.getState().addNgonFeature('Polygon', 30, -10, sides, radius, angle, 5)
    assertCanned('ngon', { sides, size: radius })
    assertSameOutline(
      onlyProfile(),
      ngonProfile(30, -10, sides, radius, angle),
      'polygon',
    )
  })
})

const ROUND_RECTS = [
  { x: 10, y: 20, w: 80, h: 40, corner: 5 },
  { x: 0, y: 0, w: 10, h: 10, corner: 100 },
  { x: 5, y: 5, w: 50, h: 20, corner: 0 },
]

ROUND_RECTS.forEach(({ x, y, w, h, corner }, index) => {
  test(`rounded rectangle ${index + 1}: created outline is the old roundedRectProfile`, () => {
    resetStore()
    useProjectStore.getState().addRoundRectFeature('Rounded rect', x, y, w, h, corner, 5)
    assertCanned('roundrect', { width: w, height: h, radius: corner })
    assertSameOutline(
      onlyProfile(),
      roundedRectProfile({ x, y }, { x: x + w, y: y + h }, corner),
      'rounded rect',
    )
  })
})

const CHAMFER_RECTS = [
  { x: 10, y: 20, w: 80, h: 40, corner: 5 },
  { x: 0, y: 0, w: 10, h: 10, corner: 100 },
  { x: 5, y: 5, w: 50, h: 20, corner: 0 },
]

CHAMFER_RECTS.forEach(({ x, y, w, h, corner }, index) => {
  test(`chamfered rectangle ${index + 1}: created outline is the old chamferedRectProfile`, () => {
    resetStore()
    useProjectStore.getState().addChamferRectFeature('Chamfered rect', x, y, w, h, corner, 5)
    assertCanned('chamferrect', { width: w, height: h, chamfer: corner })
    assertSameOutline(
      onlyProfile(),
      chamferedRectProfile({ x, y }, { x: x + w, y: y + h }, corner),
      'chamfered rect',
    )
  })
})

test('creation carries the old operation and Z, not a generated-shape quirk', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addRectFeature('Base', 0, 0, 200, 200, 5)
  store.addEllipseFeature('Pocket', 100, 100, 20, 10, 2)
  const features = resolvedProjectFeatures(project())
  const pocket = features.find((feature) => feature.name === 'Pocket')
  assert(pocket !== undefined, 'pocket exists')
  assert(pocket.operation === 'subtract', `a closed shape inside a solid stays a cut, got ${pocket.operation}`)
  assert(pocket.z_top === 2 && pocket.z_bottom === 0, 'the old depth is unchanged')
})

// ── 2. Save → load → regenerate ─────────────────────────────────────

const ROUND_TRIP: Array<{ name: string; canned: CannedShapeData; create: (store: ProjectStore) => void }> = [
  {
    name: 'ellipse',
    canned: { kind: 'ellipse', params: { rx: 30, ry: 20 } },
    create: (store) => store.addEllipseFeature('Ellipse', 50, 50, 30, 20, 5),
  },
  {
    name: 'slot',
    canned: { kind: 'slot', params: { length: 80, width: 10 } },
    create: (store) => store.addSlotFeature('Slot', { x: 10, y: 10 }, { x: 90, y: 10 }, 10, 5),
  },
  {
    name: 'ngon',
    canned: { kind: 'ngon', params: { sides: 8, size: 20, rotation: 22.5 } },
    create: (store) => store.addNgonFeature('Octagon', 0, 0, 8, 20, Math.PI / 8, 5),
  },
  {
    name: 'roundrect',
    canned: { kind: 'roundrect', params: { width: 80, height: 40, radius: 5 } },
    create: (store) => store.addRoundRectFeature('Rounded rect', 10, 20, 80, 40, 5, 5),
  },
  {
    name: 'chamferrect',
    canned: { kind: 'chamferrect', params: { width: 80, height: 40, chamfer: 5 } },
    create: (store) => store.addChamferRectFeature('Chamfered rect', 10, 20, 80, 40, 5, 5),
  },
]

for (const shape of ROUND_TRIP) {
  test(`${shape.name}: save, load, regenerate gives the same geometry and parameters`, () => {
    resetStore()
    shape.create(useProjectStore.getState())
    const before = onlyProfile()
    const saved = JSON.parse(JSON.stringify(project())) as Project

    useProjectStore.setState({
      project: normalizeProject(saved),
      history: { past: [], future: [], transactionStart: null },
    } as unknown as Partial<ProjectStore>)

    const reloadedCanned = onlyFeature().canned
    assert(
      JSON.stringify(reloadedCanned) === JSON.stringify(shape.canned),
      `${shape.name}: parameters changed on load — ${JSON.stringify(reloadedCanned)}`,
    )
    assertSameOutline(onlyProfile(), before, `${shape.name} reload`)
  })
}

// ── 3. Old plain outlines stay plain ────────────────────────────────

function plainEllipseProject(): Project {
  const base = newProject()
  const definition: FeatureDefinition = {
    id: 'def-plain-ellipse',
    kind: 'ellipse',
    profile: ellipseProfile(50, 50, 30, 20),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
  return {
    ...base,
    featureDefinitions: { [definition.id]: definition },
    features: [{
      id: 'f-plain',
      name: 'Old ellipse',
      definitionId: definition.id,
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      constraints: [],
      folderId: null,
      z_top: 5,
      z_bottom: 0,
      authoringFace: 'top',
      visible: true,
      locked: false,
    }],
    featureTree: [{ type: 'feature', featureId: 'f-plain' }],
  }
}

test('an old plain ellipse loads plain: no canned data and the same profile', () => {
  const loaded = normalizeProject(JSON.parse(JSON.stringify(plainEllipseProject())) as Project)
  const definition = Object.values(loaded.featureDefinitions)[0]
  assert(definition.canned === undefined, 'a plain ellipse must not gain canned data')
  assertSameOutline(definition.profile, ellipseProfile(50, 50, 30, 20), 'plain ellipse')
})

test('creation writes canned data only on the new definition', () => {
  resetStore(plainEllipseProject())
  useProjectStore.getState().addEllipseFeature('New ellipse', 0, 0, 10, 5, 5)
  const definitions = Object.values(project().featureDefinitions)
  const plain = definitions.find((definition) => definition.id === 'def-plain-ellipse')
  const canned = definitions.find((definition) => definition.canned !== undefined)
  assert(plain?.canned === undefined, 'the old definition stays plain')
  assert(canned?.canned?.kind === 'ellipse', 'the new definition is canned')
})

// ── 4. Hit testing follows the generated outline ─────────────────────

const vt: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }
// The near-outline tolerance is 8 px, so the slot's empty frame corner (about
// 2 world units from the end cap) needs a zoomed view to be out of reach.
const preciseVt: ViewTransform = { scale: 10, offsetX: 0, offsetY: 0 }

test('a slot is selectable through its stadium, not through its frame corners', () => {
  resetStore()
  useProjectStore.getState().addSlotFeature('Slot', { x: 10, y: 10 }, { x: 90, y: 10 }, 10, 5)
  const features = resolvedProjectFeatures(project()) as unknown as FeatureLike[]
  // Inside the frame (x 5..95, y 5..15) but outside the rounded end: no hit.
  assert(findHitFeatureId({ x: 5, y: 5 }, features, preciseVt) === null, 'frame corner must not select')
  // Inside the stadium's end cap, and on its long edge.
  assert(findHitFeatureId({ x: 10, y: 8 }, features, vt) !== null, 'the end cap selects')
  assert(findHitFeatureId({ x: 50, y: 14 }, features, vt) !== null, 'the body selects')
})

test('an ellipse is selectable through its curve, not its bounding box', () => {
  resetStore()
  useProjectStore.getState().addEllipseFeature('Ellipse', 50, 50, 30, 20, 5)
  const features = resolvedProjectFeatures(project()) as unknown as FeatureLike[]
  // The frame is x 20..80, y 30..70; this corner point is outside the ellipse.
  assert(findHitFeatureId({ x: 21, y: 31 }, features, vt) === null, 'bounding-box corner must not select')
  assert(findHitFeatureId({ x: 50, y: 50 }, features, vt) !== null, 'the ellipse material selects')
})

// ── 5. Edit through updateFeature: one undo step ─────────────────────

test('one parameter edit rebuilds the outline in one undo step', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addNgonFeature('Polygon', 20, 30, 6, 10, 0, 5)
  const featureId = onlyFeature().id
  const before = onlyProfile()
  const undoStepsBefore = useProjectStore.getState().history.past.length

  useProjectStore.getState().updateFeature(featureId, {
    canned: { kind: 'ngon', params: { sides: 8, size: 25, rotation: 10 } },
  })

  const state = useProjectStore.getState()
  assert(
    state.history.past.length === undoStepsBefore + 1,
    `expected one undo step, got ${state.history.past.length - undoStepsBefore}`,
  )
  const canned = onlyFeature().canned
  assert(canned?.kind === 'ngon', 'the shape stays canned')
  assert(canned?.params.sides === 8 && canned?.params.size === 25, 'the edit is stored')
  const after = onlyProfile()
  assert(JSON.stringify(after) !== JSON.stringify(before), 'the generated outline changed')
  // The placement is the instance's, so an edit of the parameters never moves it.
  const transform = onlyFeature().transform
  assert(transform.e === 20 && transform.f === 30, 'the instance placement is untouched')
  // 8 sides after the edit, whatever the earlier 6 were.
  assert(after.segments.length === 8, `expected 8 segments, got ${after.segments.length}`)
})

test('undo returns the previous outline', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addNgonFeature('Polygon', 20, 30, 6, 10, 0, 5)
  const featureId = onlyFeature().id
  const before = JSON.stringify(onlyProfile())

  useProjectStore.getState().updateFeature(featureId, {
    canned: { kind: 'ngon', params: { sides: 8, size: 25, rotation: 10 } },
  })
  useProjectStore.getState().undo()

  assert(JSON.stringify(onlyProfile()) === before, 'undo restores the old outline')
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) {
  process.exitCode = 1
}
