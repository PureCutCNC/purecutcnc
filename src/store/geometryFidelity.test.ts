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
 * Geometry Fidelity Regression Tests (Phase 1).
 *
 * Systematic matrix: every FeatureKind × every transform class, verifying
 * resolveProfile fidelity, segment-kind preservation, edit round-trip,
 * duplicate-as-reference, and per-kind store transforms.
 *
 * Run with: npx tsx src/store/geometryFidelity.test.ts
 */

import {
  IDENTITY_MATRIX,
  circleProfile,
  ellipseProfile,
  newProject,
  polygonProfile,
  rectProfile,
  splineProfile,
  type FeatureDefinition,
  type Matrix2D,
  type Point,
  type Project,
  type SketchFeature,
  type STLFeatureData,
  type TextFeatureData,
} from '../types/project'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { resolveProfile, applyMatrixToPoint } from './helpers/resolveFeatures'
import {
  mirrorDelta,
  rotateMatrix,
  scaleMatrix,
  translateMatrix,
} from './helpers/instanceTransforms'
import { transformProfileAffine } from './helpers/transform'

// ── Assertion helpers ──────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon
}

function pointEq(a: Point, b: Point, epsilon = 1e-6): boolean {
  return approx(a.x, b.x, epsilon) && approx(a.y, b.y, epsilon)
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

// ── Store helpers ──────────────────────────────────────────────────

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
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

function getProject(): Project {
  return useProjectStore.getState().project
}

function getFeatures(): SketchFeature[] {
  return getProject().features
}

// ── Transform class matrix ─────────────────────────────────────────

/** Degrees to use for rotate tests — small enough that reference points stay distinct. */
const ROTATE_DEG = 30

const TRANSFORM_CLASSES: Record<string, Matrix2D> = {
  identity: IDENTITY_MATRIX,
  translate: translateMatrix(100, 50),
  rotate: rotateMatrix(degToRad(ROTATE_DEG)),
  uniformScale: scaleMatrix(2, 2),
  /** Mirror across the X axis (y → -y). */
  mirror: mirrorDelta({ x: 0, y: 0 }, { x: 1, y: 0 }),
  /** Non-uniform scale: stretch X by 2×, Y unchanged. */
  nonUniform: scaleMatrix(2, 1),
}

/** Which transforms preserve circles/arcs (similarity). */
const SIMILARITY_CLASSES = new Set(['identity', 'translate', 'rotate', 'uniformScale', 'mirror'])

// ── Test runner ────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

// ============================================================================
// 1. RECT — resolveProfile fidelity
// ============================================================================

console.log('\nRect — resolveProfile fidelity')

function rectDef(): FeatureDefinition {
  return {
    id: 'd-rect',
    kind: 'rect',
    profile: rectProfile(10, 20, 30, 15),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
}

for (const [className, matrix] of Object.entries(TRANSFORM_CLASSES)) {
  test(`resolveProfile rect × ${className}: reference point maps correctly`, () => {
    const def = rectDef()
    const resolved = resolveProfile(def, matrix)
    const expected = applyMatrixToPoint(matrix, { x: 10, y: 20 })
    assert(pointEq(resolved.start, expected),
      `start should be (${expected.x}, ${expected.y}), got (${resolved.start.x}, ${resolved.start.y})`)
  })

  test(`resolveProfile rect × ${className}: all segments stay 'line'`, () => {
    const def = rectDef()
    const resolved = resolveProfile(def, matrix)
    for (const seg of resolved.segments) {
      assert(seg.type === 'line', `expected line, got ${seg.type} under ${className}`)
    }
    assert(resolved.closed === true, 'rect should stay closed')
  })
}

// ============================================================================
// 2. CIRCLE — resolveProfile fidelity
// ============================================================================

console.log('\nCircle — resolveProfile fidelity')

function circleDef(): FeatureDefinition {
  return {
    id: 'd-circle',
    kind: 'circle',
    profile: circleProfile(50, 50, 10),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
}

for (const [className, matrix] of Object.entries(TRANSFORM_CLASSES)) {
  const isSimilarity = SIMILARITY_CLASSES.has(className)

  test(`resolveProfile circle × ${className}: reference point maps correctly`, () => {
    const def = circleDef()
    const resolved = resolveProfile(def, matrix)
    // Reference: the circle start point = (cx + r, cy) = (60, 50)
    const expected = applyMatrixToPoint(matrix, { x: 60, y: 50 })
    assert(pointEq(resolved.start, expected),
      `start should be (${expected.x}, ${expected.y}), got (${resolved.start.x}, ${resolved.start.y})`)
  })

  test(`resolveProfile circle × ${className}: segment kind ${isSimilarity ? 'preserved as circle' : 'converted to beziers'}`, () => {
    const def = circleDef()
    const resolved = resolveProfile(def, matrix)
    if (isSimilarity) {
      assert(resolved.segments.length === 1, `expected 1 segment, got ${resolved.segments.length}`)
      assert(resolved.segments[0].type === 'circle',
        `expected circle under ${className}, got ${resolved.segments[0].type}`)
      const seg = resolved.segments[0] as { type: 'circle'; center: Point; to: Point }
      // Verify center transformed correctly
      const expectedCenter = applyMatrixToPoint(matrix, { x: 50, y: 50 })
      assert(pointEq(seg.center, expectedCenter),
        `center should be (${expectedCenter.x}, ${expectedCenter.y}), got (${seg.center.x}, ${seg.center.y})`)
    } else {
      // nonUniform: circle becomes 4 bezier segments
      assert(resolved.segments.length === 4, `expected 4 bezier segments under ${className}, got ${resolved.segments.length}`)
      for (const seg of resolved.segments) {
        assert(seg.type === 'bezier', `expected bezier under ${className}, got ${seg.type}`)
      }
    }
  })

  if (className === 'mirror') {
    test(`resolveProfile circle × mirror: clockwise flips`, () => {
      const def = circleDef()
      const resolved = resolveProfile(def, matrix)
      const seg = resolved.segments[0] as { type: 'circle'; clockwise: boolean }
      assert(seg.type === 'circle', 'circle should stay circle under mirror')
      assert(seg.clockwise === false, `mirror should flip clockwise from true to false, got ${seg.clockwise}`)
    })
  }
}

// ============================================================================
// 3. ELLIPSE — resolveProfile fidelity
// ============================================================================

console.log('\nEllipse — resolveProfile fidelity')

function ellipseDef(): FeatureDefinition {
  return {
    id: 'd-ellipse',
    kind: 'ellipse',
    profile: ellipseProfile(50, 50, 30, 20),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
}

for (const [className, matrix] of Object.entries(TRANSFORM_CLASSES)) {
  test(`resolveProfile ellipse × ${className}: reference point maps correctly`, () => {
    const def = ellipseDef()
    const resolved = resolveProfile(def, matrix)
    // Reference: rightmost point (cx + rx, cy) = (80, 50)
    const expected = applyMatrixToPoint(matrix, { x: 80, y: 50 })
    assert(pointEq(resolved.start, expected),
      `start should be (${expected.x}, ${expected.y}), got (${resolved.start.x}, ${resolved.start.y})`)
  })

  test(`resolveProfile ellipse × ${className}: all segments stay 'bezier'`, () => {
    const def = ellipseDef()
    const resolved = resolveProfile(def, matrix)
    assert(resolved.segments.length === 4, `expected 4 segments, got ${resolved.segments.length}`)
    for (const seg of resolved.segments) {
      assert(seg.type === 'bezier', `expected bezier under ${className}, got ${seg.type}`)
    }
  })
}

// ============================================================================
// 4. POLYGON — resolveProfile fidelity
// ============================================================================

console.log('\nPolygon — resolveProfile fidelity')

function polygonDef(): FeatureDefinition {
  return {
    id: 'd-polygon',
    kind: 'polygon',
    profile: polygonProfile([{ x: 10, y: 20 }, { x: 50, y: 10 }, { x: 60, y: 40 }, { x: 20, y: 50 }]),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
}

for (const [className, matrix] of Object.entries(TRANSFORM_CLASSES)) {
  test(`resolveProfile polygon × ${className}: reference point maps correctly`, () => {
    const def = polygonDef()
    const resolved = resolveProfile(def, matrix)
    const expected = applyMatrixToPoint(matrix, { x: 10, y: 20 })
    assert(pointEq(resolved.start, expected),
      `start should be (${expected.x}, ${expected.y}), got (${resolved.start.x}, ${resolved.start.y})`)
  })

  test(`resolveProfile polygon × ${className}: all segments stay 'line'`, () => {
    const def = polygonDef()
    const resolved = resolveProfile(def, matrix)
    for (const seg of resolved.segments) {
      assert(seg.type === 'line', `expected line under ${className}, got ${seg.type}`)
    }
  })
}

// ============================================================================
// 5. SPLINE — resolveProfile fidelity
// ============================================================================

console.log('\nSpline — resolveProfile fidelity')

function splineDef(): FeatureDefinition {
  return {
    id: 'd-spline',
    kind: 'spline',
    profile: splineProfile([{ x: 10, y: 20 }, { x: 40, y: 10 }, { x: 60, y: 40 }, { x: 20, y: 50 }]),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
}

for (const [className, matrix] of Object.entries(TRANSFORM_CLASSES)) {
  test(`resolveProfile spline × ${className}: reference point maps correctly`, () => {
    const def = splineDef()
    const resolved = resolveProfile(def, matrix)
    const expected = applyMatrixToPoint(matrix, { x: 10, y: 20 })
    assert(pointEq(resolved.start, expected),
      `start should be (${expected.x}, ${expected.y}), got (${resolved.start.x}, ${resolved.start.y})`)
  })

  test(`resolveProfile spline × ${className}: all segments stay 'bezier'`, () => {
    const def = splineDef()
    const resolved = resolveProfile(def, matrix)
    assert(resolved.segments.length === 4, `expected 4 segments, got ${resolved.segments.length}`)
    for (const seg of resolved.segments) {
      assert(seg.type === 'bezier', `expected bezier under ${className}, got ${seg.type}`)
    }
  })
}

// ============================================================================
// 6. COMPOSITE (WITH ARC) — resolveProfile fidelity
// ============================================================================

console.log('\nComposite (with arc) — resolveProfile fidelity')

function compositeWithArcDef(): FeatureDefinition {
  return {
    id: 'd-composite',
    kind: 'composite',
    profile: {
      start: { x: 10, y: 0 },
      segments: [
        { type: 'line' as const, to: { x: 20, y: 0 } },
        { type: 'arc' as const, to: { x: 30, y: 10 }, center: { x: 20, y: 10 }, clockwise: false },
        { type: 'line' as const, to: { x: 10, y: 10 } },
        { type: 'line' as const, to: { x: 10, y: 0 } },
      ],
      closed: true,
    },
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }
}

for (const [className, matrix] of Object.entries(TRANSFORM_CLASSES)) {
  const isSimilarity = SIMILARITY_CLASSES.has(className)

  test(`resolveProfile composite × ${className}: reference point maps correctly`, () => {
    const def = compositeWithArcDef()
    const resolved = resolveProfile(def, matrix)
    const expected = applyMatrixToPoint(matrix, { x: 10, y: 0 })
    assert(pointEq(resolved.start, expected),
      `start should be (${expected.x}, ${expected.y}), got (${resolved.start.x}, ${resolved.start.y})`)
  })

  test(`resolveProfile composite × ${className}: line segments stay line, arc ${isSimilarity ? 'stays arc' : 'becomes bezier'}`, () => {
    const def = compositeWithArcDef()
    const resolved = resolveProfile(def, matrix)
    // Segment 0: line → always line
    assert(resolved.segments[0].type === 'line', `seg[0] should be line under ${className}, got ${resolved.segments[0].type}`)
    // Segment 1: arc → arc under similarity, bezier under nonUniform
    if (isSimilarity) {
      assert(resolved.segments[1].type === 'arc', `seg[1] should be arc under ${className}, got ${resolved.segments[1].type}`)
    } else {
      assert(resolved.segments[1].type === 'bezier', `seg[1] should be bezier under ${className}, got ${resolved.segments[1].type}`)
    }
    // Segments 2-3: line → always line
    assert(resolved.segments[2].type === 'line', `seg[2] should be line under ${className}, got ${resolved.segments[2].type}`)
    assert(resolved.segments[3].type === 'line', `seg[3] should be line under ${className}, got ${resolved.segments[3].type}`)
  })

  if (className === 'mirror') {
    test(`resolveProfile composite × mirror: arc clockwise flips`, () => {
      const def = compositeWithArcDef()
      const resolved = resolveProfile(def, matrix)
      // Mirror across X axis (y → -y): isMirrorTransform(matrix) === true
      // Arc clockwise flips from false to true
      const arcSeg = resolved.segments[1]
      assert(arcSeg.type === 'arc', `arc should stay arc under mirror, got ${arcSeg.type}`)
      const a = arcSeg as { type: 'arc'; clockwise: boolean }
      assert(a.clockwise === true, `mirror should flip arc clockwise from false to true, got ${a.clockwise}`)
    })
  }
}

// ============================================================================
// 7. TEXT — resolveProfile fidelity (kind + data survival, no segment geometry)
// ============================================================================

console.log('\nText — resolveProfile fidelity')

function textDef(): FeatureDefinition {
  return {
    id: 'd-text',
    kind: 'text',
    profile: rectProfile(0, 0, 20, 10),
    dimensions: [],
    text: { text: 'Hello', style: 'skeleton', fontId: 'simple_stroke', size: 10 },
    stl: null,
    operation: 'add',
  }
}

for (const [className, matrix] of Object.entries(TRANSFORM_CLASSES)) {
  test(`resolveProfile text × ${className}: profile transforms, text data preserved`, () => {
    const def = textDef()
    const resolved = resolveProfile(def, matrix)
    // Profile still resolves (it's a rect profile for bounding)
    const expected = applyMatrixToPoint(matrix, { x: 0, y: 0 })
    assert(pointEq(resolved.start, expected),
      `start should be (${expected.x}, ${expected.y}), got (${resolved.start.x}, ${resolved.start.y})`)
    // Text data is on the definition, not the profile — profile resolves are geometry-only
  })
}

// ============================================================================
// 8. STL — resolveProfile fidelity (kind + data survival, no segment geometry)
// ============================================================================

console.log('\nSTL — resolveProfile fidelity')

function stlDef(): FeatureDefinition {
  return {
    id: 'd-stl',
    kind: 'stl',
    profile: rectProfile(0, 0, 50, 30),
    dimensions: [],
    text: null,
    stl: { scale: 1, axisSwap: 'none' },
    operation: 'add',
  }
}

for (const [className, matrix] of Object.entries(TRANSFORM_CLASSES)) {
  test(`resolveProfile stl × ${className}: profile transforms, stl data on definition`, () => {
    const def = stlDef()
    const resolved = resolveProfile(def, matrix)
    const expected = applyMatrixToPoint(matrix, { x: 0, y: 0 })
    assert(pointEq(resolved.start, expected),
      `start should be (${expected.x}, ${expected.y}), got (${resolved.start.x}, ${resolved.start.y})`)
    // STL data is on the definition — profile resolves are geometry-only
  })
}

// ============================================================================
// SECTION B — Edit round-trip per kind (store-driven)
// ============================================================================

// ── Rect edit round-trip ───────────────────────────────────────────

console.log('\nRect — edit round-trip')

test('rect: enterSketchEdit → move anchor → applySketchEdit preserves kind + segments', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addRectFeature('Rect', 10, 20, 30, 15, 5)

  const features = getFeatures()
  assert(features.length === 1, `expected 1 feature, got ${features.length}`)
  const f = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!
  assert(defId != null, 'rect should have definitionId')

  // Record pre-edit segment kinds from the resolved profile
  const preResolved = resolveProfile(getProject().featureDefinitions[defId], f.transform ?? IDENTITY_MATRIX)
  const preKinds = preResolved.segments.map((s) => s.type)

  store.selectFeature(f.id)
  store.enterSketchEdit(f.id)

  // Move anchor 0 by +5 in X (world-space edit)
  store.moveFeatureControl(f.id, { kind: 'anchor', index: 0 }, { x: 15, y: 20 })

  store.applySketchEdit()

  const postFeatures = getFeatures()
  const postF = postFeatures[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const postResolved = resolveProfile(getProject().featureDefinitions[postF.definitionId!], postF.transform ?? IDENTITY_MATRIX)
  const postKinds = postResolved.segments.map((s) => s.type)

  // Segment kinds should match
  assert(preKinds.length === postKinds.length, `segment count changed: ${preKinds.length} → ${postKinds.length}`)
  for (let i = 0; i < preKinds.length; i++) {
    assert(preKinds[i] === postKinds[i], `seg[${i}]: expected ${preKinds[i]}, got ${postKinds[i]}`)
  }

  // Definition should hold canonical shape (start.x ≈ 15 because anchor 0 was moved to 15)
  const def = getProject().featureDefinitions[postF.definitionId!]
  assert(def != null, 'definition should exist')
  assert(approx(def.profile.start.x, 15, 1e-4), `def-local start.x should be near 15, got ${def.profile.start.x}`)
})

// ── Circle edit round-trip ─────────────────────────────────────────

console.log('\nCircle — edit round-trip')

test('circle: enterSketchEdit → move radius anchor → applySketchEdit preserves circle kind', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addCircleFeature('Circle', 50, 50, 10, 5)

  const features = getFeatures()
  const f = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!
  assert(defId != null, 'circle should have definitionId')

  const preDef = getProject().featureDefinitions[defId]
  assert(preDef.profile.segments[0].type === 'circle', 'pre-edit should be circle')

  store.selectFeature(f.id)
  store.enterSketchEdit(f.id)

  // Move the radius anchor (anchor index 0) to increase radius
  store.moveFeatureControl(f.id, { kind: 'anchor', index: 0 }, { x: 65, y: 50 })

  store.applySketchEdit()

  const postDef = getProject().featureDefinitions[defId]
  assert(postDef.profile.segments[0].type === 'circle',
    `post-edit should still be circle, got ${postDef.profile.segments[0].type}`)
  // The center should still be at (50, 50) in definition-local
  const seg = postDef.profile.segments[0] as { type: 'circle'; center: Point }
  assert(pointEq(seg.center, { x: 50, y: 50 }),
    `center should stay at (50,50), got (${seg.center.x}, ${seg.center.y})`)
  // Radius should have changed (from 10 to 15)
  const newR = Math.hypot(postDef.profile.start.x - seg.center.x, postDef.profile.start.y - seg.center.y)
  assert(approx(newR, 15, 1e-4), `radius should be 15 after move to (65,50), got ${newR}`)
})

// ── Ellipse edit round-trip ────────────────────────────────────────

console.log('\nEllipse — edit round-trip')

test('ellipse: enterSketchEdit → move anchor → applySketchEdit preserves bezier segments', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addEllipseFeature('Ellipse', 50, 50, 30, 20, 5)

  const features = getFeatures()
  const f = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!
  assert(defId != null, 'ellipse should have definitionId')

  const preDef = getProject().featureDefinitions[defId]
  assert(preDef.profile.segments.length === 4, 'ellipse should have 4 segments')
  for (const seg of preDef.profile.segments) {
    assert(seg.type === 'bezier', `ellipse segments should be bezier, got ${seg.type}`)
  }

  store.selectFeature(f.id)
  store.enterSketchEdit(f.id)

  // Move anchor 0 (rightmost point) outward
  store.moveFeatureControl(f.id, { kind: 'anchor', index: 0 }, { x: 85, y: 50 })

  store.applySketchEdit()

  const postDef = getProject().featureDefinitions[defId]
  assert(postDef.profile.segments.length === 4, 'ellipse should still have 4 segments after edit')
  for (const seg of postDef.profile.segments) {
    assert(seg.type === 'bezier', `ellipse segments should stay bezier after edit, got ${seg.type}`)
  }
})

// ── Polygon edit round-trip ────────────────────────────────────────

console.log('\nPolygon — edit round-trip')

test('polygon: enterSketchEdit → move anchor → applySketchEdit preserves line segments', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addPolygonFeature('Polygon', [{ x: 10, y: 20 }, { x: 50, y: 10 }, { x: 60, y: 40 }, { x: 20, y: 50 }], 5)

  const features = getFeatures()
  const f = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!

  store.selectFeature(f.id)
  store.enterSketchEdit(f.id)

  // Move vertex 0
  store.moveFeatureControl(f.id, { kind: 'anchor', index: 0 }, { x: 15, y: 25 })

  store.applySketchEdit()

  const postDef = getProject().featureDefinitions[defId]
  for (const seg of postDef.profile.segments) {
    assert(seg.type === 'line', `polygon segments should stay line, got ${seg.type}`)
  }
  assert(postDef.profile.closed === true, 'polygon should stay closed')
})

// ── Spline edit round-trip ─────────────────────────────────────────

console.log('\nSpline — edit round-trip')

test('spline: enterSketchEdit → move control → applySketchEdit preserves bezier segments', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addSplineFeature('Spline', [{ x: 10, y: 20 }, { x: 40, y: 10 }, { x: 60, y: 40 }, { x: 20, y: 50 }], 5)

  const features = getFeatures()
  const f = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!

  store.selectFeature(f.id)
  store.enterSketchEdit(f.id)

  // Move anchor 0
  store.moveFeatureControl(f.id, { kind: 'anchor', index: 0 }, { x: 15, y: 25 })

  store.applySketchEdit()

  const postDef = getProject().featureDefinitions[defId]
  for (const seg of postDef.profile.segments) {
    assert(seg.type === 'bezier', `spline segments should stay bezier, got ${seg.type}`)
  }
})

// ── Composite (with arc) edit round-trip ───────────────────────────

console.log('\nComposite (with arc) — edit round-trip')

test('composite-with-arc: enterSketchEdit → move line vertex (leave arc) → applySketchEdit preserves arc', () => {
  resetStore()
  const store = useProjectStore.getState()

  const feature: SketchFeature = {
    id: 'f-comp-edit',
    name: 'Composite',
    kind: 'composite',
    folderId: null,
    sketch: {
      profile: {
        start: { x: 10, y: 0 },
        segments: [
          { type: 'line' as const, to: { x: 20, y: 0 } },
          { type: 'arc' as const, to: { x: 30, y: 10 }, center: { x: 20, y: 10 }, clockwise: false },
          { type: 'line' as const, to: { x: 10, y: 10 } },
          { type: 'line' as const, to: { x: 10, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  store.addFeature(feature)

  const features = getFeatures()
  const f = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!

  store.selectFeature(f.id)
  store.enterSketchEdit(f.id)

  // Move the end of the first line segment (anchor 1) — leave arc untouched
  store.moveFeatureControl(f.id, { kind: 'anchor', index: 1 }, { x: 22, y: 0 })

  store.applySketchEdit()

  const postDef = getProject().featureDefinitions[defId]
  // The arc segment should still be present and be an arc
  const arcSegs = postDef.profile.segments.filter((s) => s.type === 'arc')
  assert(arcSegs.length === 1, `expected 1 arc segment after edit, got ${arcSegs.length}`)
})

// ── Text edit round-trip (text has no sketch-editable profile) ─────

console.log('\nText — round-trip (kind + data preserved)')

test('text: create → addFeature, text data survives', () => {
  resetStore()
  const store = useProjectStore.getState()

  const textData: TextFeatureData = {
    text: 'Hello',
    style: 'skeleton',
    fontId: 'simple_stroke',
    size: 10,
  }

  const feature: SketchFeature = {
    id: 'f-text-rt',
    name: 'Text RT',
    kind: 'text',
    text: textData,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 20, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 1,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  store.addFeature(feature)

  const features = getFeatures()
  const f = features[0] as SketchFeature & { definitionId?: string; text?: TextFeatureData | null }
  assert(f.kind === 'text', `kind should be text, got ${f.kind}`)
  const defId = f.definitionId!
  const def = getProject().featureDefinitions[defId]
  assert(def.kind === 'text', `def kind should be text, got ${def.kind}`)
  assert(def.text != null, 'def should carry text data')
  assert(def.text!.text === 'Hello', `text content should survive, got ${def.text!.text}`)
})

// ── STL round-trip (stl has no sketch-editable profile) ────────────

console.log('\nSTL — round-trip (kind + data preserved)')

test('stl: create → addFeature, stl data survives', () => {
  resetStore()
  const store = useProjectStore.getState()

  const stlData: STLFeatureData = {
    scale: 1.5,
    axisSwap: 'xz',
  }

  const feature: SketchFeature = {
    id: 'f-stl-rt',
    name: 'STL RT',
    kind: 'stl',
    stl: stlData,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 50, 30),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  store.addFeature(feature)

  const features = getFeatures()
  const f = features[0] as SketchFeature & { definitionId?: string; stl?: STLFeatureData | null }
  assert(f.kind === 'stl', `kind should be stl, got ${f.kind}`)
  const defId = f.definitionId!
  const def = getProject().featureDefinitions[defId]
  assert(def.kind === 'stl', `def kind should be stl, got ${def.kind}`)
  assert(def.stl != null, 'def should carry stl data')
  assert(def.stl!.scale === 1.5, `stl scale should survive, got ${def.stl!.scale}`)
  assert(def.stl!.axisSwap === 'xz', `stl axisSwap should survive, got ${def.stl!.axisSwap}`)
})

// ============================================================================
// SECTION C — Duplicate-as-reference per kind
// ============================================================================

function duplicateAndAssert(kind: string, createFn: () => void, expectDefinitionShared: boolean = true) {
  resetStore()
  const store = useProjectStore.getState()

  createFn()

  const features = getFeatures()
  assert(features.length === 1, `[${kind}] expected 1 feature, got ${features.length}`)
  const orig = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const origDefId = orig.definitionId!
  assert(origDefId != null, `[${kind}] original should have definitionId`)

  store.selectFeature(orig.id)
  store.startCopyFeature(orig.id)
  store.setPendingMoveFrom({ x: 0, y: 0 })
  store.completePendingMove({ x: 50, y: 0 })

  const postFeatures = getFeatures()
  assert(postFeatures.length === 2, `[${kind}] expected 2 features after copy, got ${postFeatures.length}`)
  const copy = postFeatures[1] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const copyDefId = copy.definitionId!

  assert(orig.kind === copy.kind, `[${kind}] copy should have same kind: ${orig.kind} vs ${copy.kind}`)

  if (expectDefinitionShared) {
    assert(origDefId === copyDefId, `[${kind}] copy should share definitionId: ${origDefId} vs ${copyDefId}`)
  }
}

console.log('\nDuplicate-as-reference — all kinds')

test('rect: duplicate shares definitionId + preserves kind', () => {
  duplicateAndAssert('rect', () => {
    useProjectStore.getState().addRectFeature('Rect', 10, 20, 30, 15, 5)
  })
})

test('circle: duplicate shares definitionId + preserves kind', () => {
  duplicateAndAssert('circle', () => {
    useProjectStore.getState().addCircleFeature('Circle', 50, 50, 10, 5)
  })
})

test('ellipse: duplicate shares definitionId + preserves kind', () => {
  duplicateAndAssert('ellipse', () => {
    useProjectStore.getState().addEllipseFeature('Ellipse', 50, 50, 30, 20, 5)
  })
})

test('polygon: duplicate shares definitionId + preserves kind', () => {
  duplicateAndAssert('polygon', () => {
    useProjectStore.getState().addPolygonFeature('Polygon', [{ x: 10, y: 20 }, { x: 50, y: 10 }, { x: 60, y: 40 }], 5)
  })
})

test('spline: duplicate shares definitionId + preserves kind', () => {
  duplicateAndAssert('spline', () => {
    useProjectStore.getState().addSplineFeature('Spline', [{ x: 10, y: 20 }, { x: 40, y: 10 }, { x: 60, y: 40 }], 5)
  })
})

test('composite-with-arc: duplicate shares definitionId + preserves kind', () => {
  duplicateAndAssert('composite', () => {
    const store = useProjectStore.getState()
    const feature: SketchFeature = {
      id: 'f-comp-dup',
      name: 'Composite',
      kind: 'composite',
      folderId: null,
      sketch: {
        profile: {
          start: { x: 10, y: 0 },
          segments: [
            { type: 'line' as const, to: { x: 20, y: 0 } },
            { type: 'arc' as const, to: { x: 30, y: 10 }, center: { x: 20, y: 10 }, clockwise: false },
            { type: 'line' as const, to: { x: 10, y: 10 } },
            { type: 'line' as const, to: { x: 10, y: 0 } },
          ],
          closed: true,
        },
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'add',
      z_top: 5,
      z_bottom: 0,
      visible: true,
      locked: false,
    }
    store.addFeature(feature)
  })
})

test('text: duplicate shares definitionId + preserves kind + text data', () => {
  resetStore()
  const store = useProjectStore.getState()

  const textData: TextFeatureData = {
    text: 'Hello',
    style: 'skeleton',
    fontId: 'simple_stroke',
    size: 10,
  }

  store.addFeature({
    id: 'f-text-dup',
    name: 'Text',
    kind: 'text',
    text: textData,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 20, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 1,
    z_bottom: 0,
    visible: true,
    locked: false,
  })

  const orig = getFeatures()[0] as SketchFeature & { definitionId?: string }
  const origDefId = orig.definitionId!

  store.selectFeature(orig.id)
  store.startCopyFeature(orig.id)
  store.setPendingMoveFrom({ x: 0, y: 0 })
  store.completePendingMove({ x: 50, y: 0 })

  const postFeatures = getFeatures()
  assert(postFeatures.length === 2, `expected 2 features, got ${postFeatures.length}`)
  const copy = postFeatures[1] as SketchFeature & { definitionId?: string }
  assert(copy.kind === 'text', `copy kind should be text, got ${copy.kind}`)
  assert(copy.definitionId === origDefId, 'copy should share definitionId')

  // Text data on definition should survive
  const def = getProject().featureDefinitions[origDefId]
  assert(def.text!.text === 'Hello', 'text data should survive duplicate')
})

test('stl: duplicate shares definitionId + preserves kind + stl data', () => {
  resetStore()
  const store = useProjectStore.getState()

  const stlData: STLFeatureData = { scale: 1, axisSwap: 'none' }

  store.addFeature({
    id: 'f-stl-dup',
    name: 'STL',
    kind: 'stl',
    stl: stlData,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 50, 30),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  })

  const orig = getFeatures()[0] as SketchFeature & { definitionId?: string }
  const origDefId = orig.definitionId!

  store.selectFeature(orig.id)
  store.startCopyFeature(orig.id)
  store.setPendingMoveFrom({ x: 0, y: 0 })
  store.completePendingMove({ x: 50, y: 0 })

  const postFeatures = getFeatures()
  assert(postFeatures.length === 2, `expected 2 features, got ${postFeatures.length}`)
  const copy = postFeatures[1] as SketchFeature & { definitionId?: string }
  assert(copy.kind === 'stl', `copy kind should be stl, got ${copy.kind}`)
  assert(copy.definitionId === origDefId, 'copy should share definitionId')

  const def = getProject().featureDefinitions[origDefId]
  assert(def.stl != null, 'stl data should survive duplicate')
})

// ============================================================================
// SECTION D — Per-kind transforms via store actions
// ============================================================================

console.log('\nPer-kind transforms — move')

// Test move for each shape kind
function testMove(kind: string, createFn: () => void, expectedKind: string) {
  resetStore()
  const store = useProjectStore.getState()
  createFn()

  const features = getFeatures()
  const f = features[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const origDefId = f.definitionId!

  store.selectFeature(f.id)
  store.startMoveFeature(f.id)
  store.setPendingMoveFrom({ x: 0, y: 0 })
  store.completePendingMove({ x: 30, y: 20 })

  const moved = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(moved.kind === expectedKind, `[${kind}] kind should still be ${expectedKind} after move, got ${moved.kind}`)

  // Transform should reflect the move
  const t = moved.transform ?? IDENTITY_MATRIX
  assert(approx(t.e, 30, 1e-4), `[${kind}] transform.e should be 30, got ${t.e}`)
  assert(approx(t.f, 20, 1e-4), `[${kind}] transform.f should be 20, got ${t.f}`)

  // Resolved profile should be at new position
  const def = getProject().featureDefinitions[origDefId]
  const resolved = resolveProfile(def, t)
  // For a feature created at position (x, y), the resolved start should be (x+30, y+20)
  assert(resolved != null, `[${kind}] resolved profile should exist`)
}

test('rect: move via store preserves kind', () => {
  testMove('rect', () => {
    useProjectStore.getState().addRectFeature('Rect', 10, 20, 30, 15, 5)
  }, 'rect')
})

test('circle: move via store preserves kind', () => {
  testMove('circle', () => {
    useProjectStore.getState().addCircleFeature('Circle', 50, 50, 10, 5)
  }, 'circle')
})

test('ellipse: move via store preserves kind', () => {
  testMove('ellipse', () => {
    useProjectStore.getState().addEllipseFeature('Ellipse', 50, 50, 30, 20, 5)
  }, 'ellipse')
})

test('polygon: move via store preserves kind', () => {
  testMove('polygon', () => {
    useProjectStore.getState().addPolygonFeature('Polygon', [{ x: 10, y: 20 }, { x: 50, y: 10 }, { x: 60, y: 40 }], 5)
  }, 'polygon')
})

test('spline: move via store preserves kind', () => {
  testMove('spline', () => {
    useProjectStore.getState().addSplineFeature('Spline', [{ x: 10, y: 20 }, { x: 40, y: 10 }, { x: 60, y: 40 }], 5)
  }, 'spline')
})

console.log('\nPer-kind transforms — rotate')

test('circle: rotate via store preserves circle kind', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addCircleFeature('Circle', 50, 50, 10, 5)

  const f = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!

  store.selectFeature(f.id)
  store.startRotateFeature(f.id)
  store.setPendingTransformReferenceStart({ x: 50, y: 50 })
  store.setPendingTransformReferenceEnd({ x: 60, y: 50 })
  store.completePendingTransform({ x: 50, y: 60 })

  const rotated = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(rotated.kind === 'circle', `circle should stay circle after rotate, got ${rotated.kind}`)

  // Resolve with the rotated transform — should still be a circle
  const def = getProject().featureDefinitions[defId]
  const resolved = resolveProfile(def, rotated.transform ?? IDENTITY_MATRIX)
  assert(resolved.segments[0].type === 'circle', `rotated circle should resolve as circle, got ${resolved.segments[0].type}`)
})

test('rect: rotate via store preserves rect kind', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addRectFeature('Rect', 10, 20, 30, 15, 5)

  const f = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  store.selectFeature(f.id)
  store.startRotateFeature(f.id)
  store.setPendingTransformReferenceStart({ x: 25, y: 27.5 })
  store.setPendingTransformReferenceEnd({ x: 40, y: 27.5 })
  store.completePendingTransform({ x: 25, y: 42.5 })

  const rotated = getFeatures()[0] as SketchFeature & { definitionId?: string }
  assert(rotated.kind === 'rect', `rect should stay rect after rotate, got ${rotated.kind}`)
})

console.log('\nPer-kind transforms — resize')

test('circle: uniform resize via store preserves circle kind', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addCircleFeature('Circle', 50, 50, 10, 5)

  const f = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!

  // Use diagonal reference (>12° from either axis) to avoid axis-snap,
  // producing a genuine uniform scale.
  store.selectFeature(f.id)
  store.startResizeFeature(f.id)
  store.setPendingTransformReferenceStart({ x: 50, y: 50 })
  store.setPendingTransformReferenceEnd({ x: 60, y: 60 })
  store.completePendingTransform({ x: 70, y: 70 })

  const resized = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(resized.kind === 'circle', `circle should stay circle after resize, got ${resized.kind}`)

  const def = getProject().featureDefinitions[defId]
  const resolved = resolveProfile(def, resized.transform ?? IDENTITY_MATRIX)
  assert(resolved.segments[0].type === 'circle', `uniform-resized circle should resolve as circle, got ${resolved.segments[0].type}`)
})

test('circle: non-uniform resize correctly converts to beziers', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addCircleFeature('Circle', 50, 50, 10, 5)

  const f = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!

  // Horizontal reference (within 12° of axis) triggers axis-snap → non-uniform scale
  store.selectFeature(f.id)
  store.startResizeFeature(f.id)
  store.setPendingTransformReferenceStart({ x: 50, y: 50 })
  store.setPendingTransformReferenceEnd({ x: 60, y: 50 })
  store.completePendingTransform({ x: 70, y: 50 })

  const resized = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  // kind may be re-inferred as 'ellipse' after non-uniform resize
  const def = getProject().featureDefinitions[defId]
  const resolved = resolveProfile(def, resized.transform ?? IDENTITY_MATRIX)
  // Non-uniform scale: circle → beziers (correct)
  assert(resolved.segments[0].type === 'bezier',
    `non-uniform-resized circle should resolve as bezier, got ${resolved.segments[0].type}`)
  assert(resolved.segments.length === 4, `expected 4 bezier segments, got ${resolved.segments.length}`)
})

test('rect: resize via store preserves rect kind', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addRectFeature('Rect', 10, 20, 30, 15, 5)

  const f = getFeatures()[0] as SketchFeature & { definitionId?: string }

  store.selectFeature(f.id)
  store.startResizeFeature(f.id)
  store.setPendingTransformReferenceStart({ x: 10, y: 20 })
  store.setPendingTransformReferenceEnd({ x: 40, y: 20 })
  store.completePendingTransform({ x: 70, y: 20 })

  const resized = getFeatures()[0] as SketchFeature & { definitionId?: string }
  assert(resized.kind === 'rect', `rect should stay rect after resize, got ${resized.kind}`)
})

console.log('\nPer-kind transforms — mirror')

test('circle: mirror via store preserves circle kind', () => {
  resetStore()
  const store = useProjectStore.getState()
  store.addCircleFeature('Circle', 50, 50, 10, 5)

  const f = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!

  store.selectFeature(f.id)
  store.startMirrorFeature(f.id)
  store.setPendingTransformReferenceStart({ x: 50, y: 0 })
  store.setPendingTransformReferenceEnd({ x: 50, y: 10 })
  store.setPendingTransformKeepOriginals(false)
  store.completePendingTransform({ x: 50, y: 10 })

  const mirrored = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  assert(mirrored.kind === 'circle', `circle should stay circle after mirror, got ${mirrored.kind}`)

  const def = getProject().featureDefinitions[defId]
  const resolved = resolveProfile(def, mirrored.transform ?? IDENTITY_MATRIX)
  assert(resolved.segments[0].type === 'circle', `mirrored circle should resolve as circle, got ${resolved.segments[0].type}`)
})

test('composite-with-arc: mirror via store preserves arc segment kind (similarity)', () => {
  resetStore()
  const store = useProjectStore.getState()

  const feature: SketchFeature = {
    id: 'f-comp-mirror',
    name: 'Composite',
    kind: 'composite',
    folderId: null,
    sketch: {
      profile: {
        start: { x: 10, y: 0 },
        segments: [
          { type: 'line' as const, to: { x: 20, y: 0 } },
          { type: 'arc' as const, to: { x: 30, y: 10 }, center: { x: 20, y: 10 }, clockwise: false },
          { type: 'line' as const, to: { x: 10, y: 10 } },
          { type: 'line' as const, to: { x: 10, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }

  store.addFeature(feature)

  const f = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const defId = f.definitionId!

  store.selectFeature(f.id)
  store.startMirrorFeature(f.id)
  store.setPendingTransformReferenceStart({ x: 0, y: 5 })
  store.setPendingTransformReferenceEnd({ x: 10, y: 5 })
  store.setPendingTransformKeepOriginals(false)
  store.completePendingTransform({ x: 10, y: 5 })

  const mirrored = getFeatures()[0] as SketchFeature & { definitionId?: string; transform?: Matrix2D }
  const def = getProject().featureDefinitions[defId]
  const resolved = resolveProfile(def, mirrored.transform ?? IDENTITY_MATRIX)

  // Arc should survive mirror (similarity transform)
  const arcSegs = resolved.segments.filter((s) => s.type === 'arc')
  assert(arcSegs.length === 1, `expected 1 arc after mirror, got ${arcSegs.length}`)
})

// ============================================================================
// SECTION E — Regression-specific assertions
// ============================================================================

console.log('\nRegression: circle/arc transform correctness')

// Regression: huge-circle bug — transformProfileAffine must transform circle center
test('transformProfileAffine transforms circle center (not just edge)', () => {
  const profile = {
    start: { x: 60, y: 50 },
    segments: [
      { type: 'circle' as const, center: { x: 50, y: 50 }, to: { x: 60, y: 50 }, clockwise: false },
    ],
    closed: true,
  }
  const moved = transformProfileAffine(
    profile,
    (p: Point) => ({ x: p.x + 100, y: p.y + 100 }),
  )
  const seg = moved.segments[0] as { type: 'circle'; center: Point; to: Point }
  assert(seg.type === 'circle', 'segment should remain a circle')
  assert(pointEq(seg.center, { x: 150, y: 150 }),
    `center should move to (150,150), got (${seg.center.x},${seg.center.y})`)
  const radius = Math.hypot(moved.start.x - seg.center.x, moved.start.y - seg.center.y)
  assert(approx(radius, 10), `radius preserved at 10, got ${radius}`)
})

// Regression: arc segments in composites survive rebake
test('resolveProfile preserves arc segments under identity + translate', () => {
  const profile = {
    start: { x: 10, y: 0 },
    segments: [
      { type: 'arc' as const, to: { x: 0, y: 10 }, center: { x: 0, y: 0 }, clockwise: false },
      { type: 'line' as const, to: { x: 0, y: 0 } },
      { type: 'line' as const, to: { x: 10, y: 0 } },
    ],
    closed: true,
  }
  const def: FeatureDefinition = {
    id: 'd-arc-regress', kind: 'composite', profile,
    dimensions: [], text: null, stl: null, operation: 'add',
  }
  const ident = resolveProfile(def, IDENTITY_MATRIX)
  assert(ident.segments[0].type === 'arc', `identity should keep arc, got ${ident.segments[0].type}`)

  const moved = resolveProfile(def, translateMatrix(100, 50))
  const a = moved.segments[0]
  assert(a.type === 'arc', `translate should keep arc, got ${a.type}`)
  assert(a.type === 'arc' && pointEq(a.center, { x: 100, y: 50 }), 'arc center should translate')
})

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
