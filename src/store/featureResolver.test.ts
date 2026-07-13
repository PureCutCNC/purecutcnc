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
 * Tests for Feature References resolver helpers (slice 02).
 *
 * Run with: npx tsx src/store/featureResolver.test.ts
 */

import {
  circleProfile,
  IDENTITY_MATRIX,
  newProject,
  rectProfile,
  type FeatureDefinition,
  type Matrix2D,
  type Project,
  type SketchFeature,
} from '../types/project'
import {
  applyMatrixToPoint,
  commitResolvedInstances,
  isCirclePreservingTransform,
  isIdentityMatrix,
  isMirrorTransform,
  resolveFeatureDefinition,
  resolveFeatureInstance,
  resolveFeatureInstances,
  resolveProfile,
  resolveSketch,
} from './helpers/resolveFeatures'
import { projectWithFeatures } from '../test/projectFixtures'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

function assertApprox(left: number, right: number, msg: string, epsilon = 1e-6): void {
  assert(approx(left, right, epsilon), `${msg}: expected ≈${right}, got ${left}`)
}

// ── Helpers ────────────────────────────────────────────────────────

function makeRectFeature(
  id: string,
  name = 'Rect',
  cx = 10, cy = 20, w = 30, h = 15,
): SketchFeature {
  return {
    id,
    name,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(cx, cy, w, h),
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
}

function makeCircleFeature(
  id: string,
  name = 'Circle',
  cx = 50, cy = 50, r = 10,
): SketchFeature {
  return {
    id,
    name,
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: circleProfile(cx, cy, r),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 3,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

/** Build a minimal migrated project (like normalizeProject output). */
function makeMigratedProject(features: SketchFeature[]): Project {
  return projectWithFeatures(newProject('test'), features)
}

// ── Matrix helpers ──────────────────────────────────────────────────

function testIdentityMatrixDetection(): void {
  console.log('1. isIdentityMatrix...')
  assert(isIdentityMatrix(IDENTITY_MATRIX), 'IDENTITY_MATRIX should be identity')
  assert(isIdentityMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), 'literal identity should be identity')

  assert(!isIdentityMatrix({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }), 'uniform scale 2 is not identity')
  assert(!isIdentityMatrix({ a: 1, b: 0, c: 0, d: 1, e: 5, f: 0 }), 'translate e=5 is not identity')
  assert(!isIdentityMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 3 }), 'translate f=3 is not identity')
  console.log('   ✓ identity detection correct')
}

function testCirclePreservingTransform(): void {
  console.log('2. isCirclePreservingTransform...')

  // Identity preserves circles
  assert(isCirclePreservingTransform(IDENTITY_MATRIX), 'identity should preserve circles')

  // Translation preserves circles
  assert(isCirclePreservingTransform({ a: 1, b: 0, c: 0, d: 1, e: 10, f: -5 }),
    'translation should preserve circles')

  // Uniform scale preserves circles
  assert(isCirclePreservingTransform({ a: 3, b: 0, c: 0, d: 3, e: 0, f: 0 }),
    'uniform scale 3 should preserve circles')

  // Rotation preserves circles
  const cos45 = Math.cos(Math.PI / 4)
  const sin45 = Math.sin(Math.PI / 4)
  assert(isCirclePreservingTransform({ a: cos45, b: sin45, c: -sin45, d: cos45, e: 0, f: 0 }),
    '45° rotation should preserve circles')

  // Uniform scale + rotation preserves circles
  assert(isCirclePreservingTransform({ a: 2 * cos45, b: 2 * sin45, c: -2 * sin45, d: 2 * cos45, e: 100, f: 200 }),
    'uniform scale + rotation + translation should preserve circles')

  // Mirror about X (a=1, d=-1) preserves circles
  assert(isCirclePreservingTransform({ a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 }),
    'mirror about X should preserve circles')

  // Non-uniform scale does NOT preserve circles
  assert(!isCirclePreservingTransform({ a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    'non-uniform scale (2x width) should not preserve circles')

  assert(!isCirclePreservingTransform({ a: 1, b: 0, c: 0, d: 3, e: 0, f: 0 }),
    'non-uniform scale (3x height) should not preserve circles')

  // Shear does NOT preserve circles
  assert(!isCirclePreservingTransform({ a: 1, b: 0, c: 0.5, d: 1, e: 0, f: 0 }),
    'shear should not preserve circles')

  console.log('   ✓ circle-preserving classification correct')
}

function testMirrorDetection(): void {
  console.log('3. isMirrorTransform...')

  assert(!isMirrorTransform(IDENTITY_MATRIX), 'identity is not a mirror')
  assert(!isMirrorTransform({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }), 'uniform scale is not a mirror')

  // Mirror about Y axis: a=-1, d=1 → det = -1
  assert(isMirrorTransform({ a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    'mirror about Y has det < 0')

  // Mirror about X axis: a=1, d=-1 → det = -1
  assert(isMirrorTransform({ a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 }),
    'mirror about X has det < 0')

  // Both axes mirrored: a=-1, d=-1 → det = 1 (rotation by 180°, not a mirror)
  assert(!isMirrorTransform({ a: -1, b: 0, c: 0, d: -1, e: 0, f: 0 }),
    'both axes negated is 180° rotation, not a mirror')

  console.log('   ✓ mirror detection correct')
}

function testApplyMatrixToPoint(): void {
  console.log('4. applyMatrixToPoint...')

  // Identity
  const p0 = applyMatrixToPoint(IDENTITY_MATRIX, { x: 5, y: 7 })
  assertApprox(p0.x, 5, 'identity x')
  assertApprox(p0.y, 7, 'identity y')

  // Translation
  const p1 = applyMatrixToPoint({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 }, { x: 5, y: 7 })
  assertApprox(p1.x, 15, 'translate x')
  assertApprox(p1.y, 27, 'translate y')

  // Scale ×2
  const p2 = applyMatrixToPoint({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }, { x: 3, y: -4 })
  assertApprox(p2.x, 6, 'scale x')
  assertApprox(p2.y, -8, 'scale y')

  // Rotation 90° CCW: a=cos, b=sin, c=-sin, d=cos with θ=π/2
  const p3 = applyMatrixToPoint({ a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 }, { x: 1, y: 0 })
  assertApprox(p3.x, 0, 'rotate 90° x')
  assertApprox(p3.y, 1, 'rotate 90° y')

  console.log('   ✓ matrix→point application correct')
}

// ── Profile resolution ─────────────────────────────────────────────

function testIdentityProfileResolution(): void {
  console.log('5. Identity transform resolution returns equivalent profile...')

  const def: FeatureDefinition = {
    id: 'd1',
    kind: 'rect',
    profile: rectProfile(10, 20, 30, 15),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }

  const resolved = resolveProfile(def, IDENTITY_MATRIX)
  assertApprox(resolved.start.x, 10, 'start.x')
  assertApprox(resolved.start.y, 20, 'start.y')
  assert(resolved.segments.length === 4, `expected 4 segments, got ${resolved.segments.length}`)
  assert(resolved.closed === true, 'expected closed')

  // Segment 0: line to (40, 20)
  const s0 = resolved.segments[0]
  assert(s0.type === 'line', `expected line, got ${s0.type}`)
  if (s0.type === 'line') {
    assertApprox(s0.to.x, 40, 'seg0 to.x')
    assertApprox(s0.to.y, 20, 'seg0 to.y')
  }

  console.log('   ✓ identity profile resolution matches definition')
}

function testTranslateProfileResolution(): void {
  console.log('6. Translate profile resolution...')

  const def: FeatureDefinition = {
    id: 'd1',
    kind: 'rect',
    profile: rectProfile(0, 0, 10, 5),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }

  const resolved = resolveProfile(def, { a: 1, b: 0, c: 0, d: 1, e: 15, f: 25 })
  assertApprox(resolved.start.x, 15, 'start.x')
  assertApprox(resolved.start.y, 25, 'start.y')

  const s0 = resolved.segments[0]
  assert(s0.type === 'line', `expected line, got ${s0.type}`)
  if (s0.type === 'line') {
    assertApprox(s0.to.x, 25, 'seg0 to.x (+10)')
    assertApprox(s0.to.y, 25, 'seg0 to.y')
  }

  const lastSeg = resolved.segments[resolved.segments.length - 1]
  assert(lastSeg.type === 'line', `expected line, got ${lastSeg.type}`)
  if (lastSeg.type === 'line') {
    assertApprox(lastSeg.to.x, 15, 'last to.x (back to start)')
    assertApprox(lastSeg.to.y, 25, 'last to.y (back to start)')
  }

  console.log('   ✓ translate profile resolution correct')
}

function testRotateProfileResolution(): void {
  console.log('7. Rotate profile resolution...')

  // A rect at origin: (0,0) → (10,0) → (10,5) → (0,5) → (0,0)
  const def: FeatureDefinition = {
    id: 'd1',
    kind: 'rect',
    profile: rectProfile(0, 0, 10, 5),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }

  // 90° CCW around origin: (x,y) → (-y, x)
  const cos90 = 0
  const sin90 = 1
  const resolved = resolveProfile(def, { a: cos90, b: sin90, c: -sin90, d: cos90, e: 0, f: 0 })

  assertApprox(resolved.start.x, 0, 'start.x after 90° rot')
  assertApprox(resolved.start.y, 0, 'start.y after 90° rot')

  const s0 = resolved.segments[0]
  assert(s0.type === 'line', `expected line, got ${s0.type}`)
  if (s0.type === 'line') {
    // (10,0) rotated 90° CCW → (0, 10)
    assertApprox(s0.to.x, 0, 'seg0 to.x')
    assertApprox(s0.to.y, 10, 'seg0 to.y')
  }

  console.log('   ✓ rotate profile resolution correct')
}

function testUniformScaleCirclePreserved(): void {
  console.log('8. Uniform scale preserves circle segment...')

  const def: FeatureDefinition = {
    id: 'd1',
    kind: 'circle',
    profile: circleProfile(50, 50, 10),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }

  // Uniform scale ×3 + translate (10, -5)
  const transform: Matrix2D = { a: 3, b: 0, c: 0, d: 3, e: 10, f: -5 }
  assert(isCirclePreservingTransform(transform), 'transform should be circle-preserving')

  const resolved = resolveProfile(def, transform)

  assert(resolved.segments.length === 1, `expected 1 segment, got ${resolved.segments.length}`)
  const seg = resolved.segments[0]
  assert(seg.type === 'circle', `expected circle, got ${seg.type}`)

  if (seg.type === 'circle') {
    // Center: (50,50) → (3*50+10, 3*50-5) = (160, 145)
    assertApprox(seg.center.x, 160, 'circle center.x')
    assertApprox(seg.center.y, 145, 'circle center.y')

    // Radius: 10 → 30
    const r = Math.hypot(resolved.start.x - seg.center.x, resolved.start.y - seg.center.y)
    assertApprox(r, 30, 'circle radius')
  }

  console.log('   ✓ uniform scale preserves circle as circle')
}

function testNonUniformScaleCircleFallback(): void {
  console.log('9. Non-uniform scale converts circle to beziers...')

  const def: FeatureDefinition = {
    id: 'd1',
    kind: 'circle',
    profile: circleProfile(50, 50, 10),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }

  // Non-uniform scale: ×2 in X, ×1 in Y
  const transform: Matrix2D = { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 }
  assert(!isCirclePreservingTransform(transform), 'transform should NOT be circle-preserving')

  const resolved = resolveProfile(def, transform)

  // Should have converted to beziers (4 quarter-circle segments)
  assert(resolved.segments.length === 4, `expected 4 bezier segments, got ${resolved.segments.length}`)
  assert(resolved.segments.every((s) => s.type === 'bezier'),
    `all segments should be beziers, got types: ${resolved.segments.map((s) => s.type).join(',')}`)

  // Verify the bounding box is roughly correct (ellipse: rx=20, ry=10, centered at 100,50)
  // Rightmost point of original circle: (60, 50) → (120, 50)
  // Leftmost: (40, 50) → (80, 50)
  // Topmost: (50, 40) → (100, 40)
  // Bottommost: (50, 60) → (100, 60)
  const allX = [resolved.start.x, ...resolved.segments.map((s) => s.to.x)]
  const allY = [resolved.start.y, ...resolved.segments.map((s) => s.to.y)]
  const minX = Math.min(...allX)
  const maxX = Math.max(...allX)
  const minY = Math.min(...allY)
  const maxY = Math.max(...allY)

  assert(approx(minX, 80, 0.5), `minX should be ≈80, got ${minX}`)
  assert(approx(maxX, 120, 0.5), `maxX should be ≈120, got ${maxX}`)
  assert(approx(minY, 40, 0.5), `minY should be ≈40, got ${minY}`)
  assert(approx(maxY, 60, 0.5), `maxY should be ≈60, got ${maxY}`)

  console.log('   ✓ non-uniform circle scale falls back to beziers (ellipse)')
}

function testMirrorProfileFlipsCircleClockwise(): void {
  console.log('10. Mirror profile flips circle clockwise...')

  const def: FeatureDefinition = {
    id: 'd1',
    kind: 'circle',
    profile: circleProfile(0, 0, 5),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }

  const originalClockwise = def.profile.segments[0].type === 'circle'
    ? def.profile.segments[0].clockwise
    : null
  assert(originalClockwise === true, 'original circle should be clockwise')

  // Mirror about Y axis: x → -x
  const resolved = resolveProfile(def, { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  assert(isMirrorTransform({ a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 }), 'mirror about Y')

  const seg = resolved.segments[0]
  assert(seg.type === 'circle', `expected circle, got ${seg.type}`)
  if (seg.type === 'circle') {
    assert(seg.clockwise === false, `mirrored circle clockwise should flip to false, got ${seg.clockwise}`)
  }

  console.log('   ✓ mirror flips circle clockwise')
}

function testMirrorProfileRectGeometry(): void {
  console.log('11. Mirror profile rect geometry...')

  const def: FeatureDefinition = {
    id: 'd1',
    kind: 'rect',
    profile: rectProfile(0, 0, 10, 5),
    dimensions: [],
    text: null,
    stl: null,
    operation: 'add',
  }

  // Mirror about Y axis (x=5): point x → 10-x
  // But we apply a matrix: translate to origin, mirror, translate back
  // translate(-5, 0) → mirror Y (a=-1) → translate(+5, 0)
  // Combined: x' = -1*(x-5) + 5 = 10 - x
  // matrix: a=-1, c=0, e=10; b=0, d=1, f=0
  const transform: Matrix2D = { a: -1, b: 0, c: 0, d: 1, e: 10, f: 0 }
  const resolved = resolveProfile(def, transform)

  // Start was (0,0) → (10, 0)
  assertApprox(resolved.start.x, 10, 'mirrored start.x')
  assertApprox(resolved.start.y, 0, 'mirrored start.y')

  // First segment: (10,0) was to (10,0), now goes to (0,0)
  const s0 = resolved.segments[0]
  assert(s0.type === 'line', `expected line, got ${s0.type}`)
  if (s0.type === 'line') {
    assertApprox(s0.to.x, 0, 'mirrored seg0 to.x')
    assertApprox(s0.to.y, 0, 'mirrored seg0 to.y')
  }

  console.log('   ✓ mirror profile rect geometry correct')
}

// ── Sketch resolution ───────────────────────────────────────────────

function testResolveSketch(): void {
  console.log('12. resolveSketch builds sketch with resolved profile...')

  const def: FeatureDefinition = {
    id: 'd1',
    kind: 'rect',
    profile: rectProfile(0, 0, 10, 5),
    dimensions: [{ id: 'dim1', type: 'distance', value: 10, segment_ids: ['s1'] }],
    text: null,
    stl: null,
    operation: 'add',
  }

  const sketch = resolveSketch(def, IDENTITY_MATRIX)
  assert(sketch.origin.x === 0 && sketch.origin.y === 0, 'origin should be (0,0)')
  assert(sketch.orientationAngle === 0, 'orientationAngle should be 0')
  assert(sketch.dimensions.length === 1, `expected 1 dimension, got ${sketch.dimensions.length}`)
  assert(sketch.constraints.length === 0, 'constraints should be empty')
  assertApprox(sketch.profile.start.x, 0, 'profile start.x')

  // With translation
  const sketch2 = resolveSketch(def, { a: 1, b: 0, c: 0, d: 1, e: 100, f: 200 })
  assertApprox(sketch2.profile.start.x, 100, 'translated profile start.x')
  assertApprox(sketch2.profile.start.y, 200, 'translated profile start.y')

  console.log('   ✓ resolveSketch correct')
}

// ── Feature resolution ──────────────────────────────────────────────

function testIdentityFeatureResolution(): void {
  console.log('13. Identity feature resolution...')

  const feature = makeRectFeature('f-001', 'Rect A')
  const project = makeMigratedProject([feature])

  const resolved = resolveFeatureInstance(project, 'f-001')
  assert(resolved !== null, 'should resolve')
  assert(resolved.id === 'f-001', `expected id f-001, got ${resolved.id}`)
  assert(resolved.definitionId === 'f-001', `expected definitionId f-001, got ${resolved.definitionId}`)
  assert(resolved.instanceId === 'f-001', `expected instanceId f-001, got ${resolved.instanceId}`)
  assert(resolved.name === 'Rect A', `expected name Rect A, got ${resolved.name}`)
  assert(resolved.kind === 'rect', `expected kind rect, got ${resolved.kind}`)
  assert(resolved.operation === 'add', `expected operation add, got ${resolved.operation}`)

  // Profile should match the original (identity transform)
  assertApprox(resolved.sketch.profile.start.x, 10, 'resolved start.x')
  assertApprox(resolved.sketch.profile.start.y, 20, 'resolved start.y')

  // Metadata preserved
  assert(resolved.z_top === 5, `expected z_top 5, got ${resolved.z_top}`)
  assert(resolved.z_bottom === 0, `expected z_bottom 0, got ${resolved.z_bottom}`)
  assert(resolved.visible === true, 'expected visible')
  assert(resolved.locked === false, 'expected not locked')
  assert(resolved.folderId === null, 'expected null folderId')

  console.log('   ✓ identity feature resolution matches original')
}

function testTranslatedFeatureResolution(): void {
  console.log('14. Translated instance resolution...')

  const feature = makeRectFeature('f-001', 'Translated')
  const project = makeMigratedProject([feature])

  // Add a definitionId and transform to the feature row (future shape)
  const featureWithTransform = {
    ...project.features[0],
    transform: { a: 1, b: 0, c: 0, d: 1, e: 50, f: -30 },
  }
  const project2: Project = {
    ...project,
    features: [featureWithTransform],
  }

  const resolved = resolveFeatureInstance(project2, 'f-001')
  assert(resolved !== null, 'should resolve')

  // Profile should be translated by (50, -30)
  assertApprox(resolved.sketch.profile.start.x, 60, 'translated start.x (10+50)')
  assertApprox(resolved.sketch.profile.start.y, -10, 'translated start.y (20-30)')

  console.log('   ✓ translated instance resolution correct')
}

function testRotatedInstanceResolution(): void {
  console.log('15. Rotated instance resolution...')

  const feature = makeRectFeature('f-001', 'Rotated', 0, 0, 10, 5)
  const project = makeMigratedProject([feature])

  // 90° CCW around origin
  const featureWithTransform = {
    ...project.features[0],
    transform: { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 },
  }
  const project2: Project = {
    ...project,
    features: [featureWithTransform],
  }

  const resolved = resolveFeatureInstance(project2, 'f-001')
  assert(resolved !== null, 'should resolve')

  const s0 = resolved.sketch.profile.segments[0]
  assert(s0.type === 'line', `expected line, got ${s0.type}`)
  if (s0.type === 'line') {
    // (10, 0) rotated 90° → (0, 10)
    assertApprox(s0.to.x, 0, 'rotated seg0 to.x')
    assertApprox(s0.to.y, 10, 'rotated seg0 to.y')
  }

  console.log('   ✓ rotated instance resolution correct')
}

function testUniformScaleCircleInstanceResolution(): void {
  console.log('16. Uniform scaled circle instance resolves as circle...')

  const feature = makeCircleFeature('f-circle-01', 'Circle', 50, 50, 10)
  const project = makeMigratedProject([feature])

  const featureWithTransform = {
    ...project.features[0],
    transform: { a: 2, b: 0, c: 0, d: 2, e: 10, f: 10 },
  }
  const project2: Project = {
    ...project,
    features: [featureWithTransform],
  }

  const resolved = resolveFeatureInstance(project2, 'f-circle-01')
  assert(resolved !== null, 'should resolve')

  const prof = resolved.sketch.profile
  assert(prof.segments.length === 1, `expected 1 segment, got ${prof.segments.length}`)
  assert(prof.segments[0].type === 'circle', `expected circle, got ${prof.segments[0].type}`)

  if (prof.segments[0].type === 'circle') {
    // Center: (50,50) * 2 + (10,10) = (110, 110)
    assertApprox(prof.segments[0].center.x, 110, 'circle center.x')
    assertApprox(prof.segments[0].center.y, 110, 'circle center.y')
    const r = Math.hypot(prof.start.x - prof.segments[0].center.x, prof.start.y - prof.segments[0].center.y)
    assertApprox(r, 20, 'circle radius (10*2)')
  }

  console.log('   ✓ uniform scaled circle instance resolves as circle')
}

function testMissingDefinitionReturnsNull(): void {
  console.log('17. Missing definition returns null...')

  // Feature with no matching definition
  const feature = makeRectFeature('f-orphan', 'Orphan')
  const project2 = makeMigratedProject([feature])
  delete project2.featureDefinitions['f-orphan']

  const resolved = resolveFeatureInstance(project2, 'f-orphan')
  assert(resolved === null, 'expected null for missing definition')

  console.log('   ✓ missing definition returns null')
}

function testMissingFeatureIdReturnsNull(): void {
  console.log('18. Missing feature ID returns null...')

  const feature = makeRectFeature('f-001', 'Only')
  const project = makeMigratedProject([feature])

  const resolved = resolveFeatureInstance(project, 'f-nonexistent')
  assert(resolved === null, 'expected null for nonexistent feature ID')

  console.log('   ✓ nonexistent feature ID returns null')
}

function testExplicitDefinitionIdMissingDoesNotFallback(): void {
  console.log('19. Explicit definitionId missing does not fall back to feature ID...')

  // feature.id = "f-inst"
  // feature.definitionId = "missing-def"
  // project.featureDefinitions has "f-inst" but NOT "missing-def"
  // → resolve must return null, NOT the stale f-inst definition.
  const feature: SketchFeature = {
    ...makeRectFeature('f-inst', 'Instance'),
  }
  const project = makeMigratedProject([feature])
  // definition for "f-inst" exists (from makeMigratedProject)

  // Add explicit definitionId pointing nowhere
  const featureWithBadDefId = {
    ...project.features[0],
    definitionId: 'missing-def',
  }
  const project2: Project = {
    ...project,
    features: [featureWithBadDefId],
  }

  const resolved = resolveFeatureInstance(project2, 'f-inst')
  assert(resolved === null, 'expected null when explicit definitionId is missing — must not fall back to feature.id')

  console.log('   ✓ explicit definitionId missing does not fall back')
}

function testResolveFeatureInstancesAll(): void {
  console.log('20. resolveFeatureInstances resolves all features...')

  const f1 = makeRectFeature('f-001', 'First', 0, 0, 10, 5)
  const f2 = makeCircleFeature('f-002', 'Second', 20, 20, 8)
  const project = makeMigratedProject([f1, f2])

  const resolved = resolveFeatureInstances(project)
  assert(resolved.length === 2, `expected 2 resolved, got ${resolved.length}`)
  assert(resolved[0].id === 'f-001', `expected f-001 first, got ${resolved[0].id}`)
  assert(resolved[1].id === 'f-002', `expected f-002 second, got ${resolved[1].id}`)

  console.log('   ✓ resolveFeatureInstances resolves all in order')
}

function testResolveFeatureInstancesFiltered(): void {
  console.log('21. resolveFeatureInstances resolves specific IDs in order...')

  const f1 = makeRectFeature('f-001', 'First')
  const f2 = makeCircleFeature('f-002', 'Second')
  const f3 = makeCircleFeature('f-003', 'Third', 30, 30, 5)
  const project = makeMigratedProject([f1, f2, f3])

  // Request in reverse order
  const resolved = resolveFeatureInstances(project, ['f-003', 'f-001'])
  assert(resolved.length === 2, `expected 2 resolved, got ${resolved.length}`)
  assert(resolved[0].id === 'f-003', `expected f-003 first, got ${resolved[0].id}`)
  assert(resolved[1].id === 'f-001', `expected f-001 second, got ${resolved[1].id}`)

  console.log('   ✓ resolveFeatureInstances preserves requested order')
}

function testResolveFeatureInstancesSkipsMissing(): void {
  console.log('22. resolveFeatureInstances skips missing definitions...')

  const f1 = makeRectFeature('f-001', 'First')
  const project = makeMigratedProject([f1])

  // Request a mix of existing and missing
  const resolved = resolveFeatureInstances(project, ['f-001', 'f-missing', 'f-also-missing'])
  assert(resolved.length === 1, `expected 1 resolved, got ${resolved.length}`)
  assert(resolved[0].id === 'f-001', `expected f-001, got ${resolved[0].id}`)

  console.log('   ✓ resolveFeatureInstances skips missing definitions')
}

function testResolveFeatureDefinition(): void {
  console.log('23. resolveFeatureDefinition...')

  const feature = makeRectFeature('f-001', 'Rect')
  const project = makeMigratedProject([feature])

  const def = resolveFeatureDefinition(project, 'f-001')
  assert(def !== null, 'should find definition')
  assert(def.id === 'f-001', `expected id f-001, got ${def.id}`)
  assert(def.kind === 'rect', `expected kind rect, got ${def.kind}`)

  const missing = resolveFeatureDefinition(project, 'nonexistent')
  assert(missing === null, 'should return null for missing')

  console.log('   ✓ resolveFeatureDefinition correct')
}

function testMissingDefinitionIdDoesNotFallback(): void {
  console.log('24. Missing definitionId does not fall back to feature ID...')

  const feature = makeRectFeature('f-trans-01', 'Invalid current row')
  const project = makeMigratedProject([feature])
  delete (project.features[0] as unknown as Record<string, unknown>).definitionId

  const resolved = resolveFeatureInstance(project, 'f-trans-01')
  assert(resolved === null, 'should not resolve without an explicit definition ID')

  console.log('   ✓ missing definitionId has no fallback')
}

function testInstanceConstraintsPreserved(): void {
  console.log('25. Per-instance constraints are preserved in resolved sketch...')

  const feature: SketchFeature = {
    ...makeRectFeature('f-001', 'Constrained'),
    sketch: {
      profile: rectProfile(0, 0, 10, 5),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [{
        id: 'c1',
        type: 'horizontal',
        segment_ids: ['s1'],
      }],
    },
  }
  const project = makeMigratedProject([feature])

  const resolved = resolveFeatureInstance(project, 'f-001')
  assert(resolved !== null, 'should resolve')
  assert(resolved.sketch.constraints.length === 1, `expected 1 constraint, got ${resolved.sketch.constraints.length}`)
  assert(resolved.sketch.constraints[0].id === 'c1', `expected constraint id c1, got ${resolved.sketch.constraints[0].id}`)
  assert(resolved.sketch.constraints[0].type === 'horizontal', 'expected horizontal constraint')

  console.log('   ✓ instance constraints preserved')
}

function testCommitResolvedSubsetPreservesOtherInstances(): void {
  console.log('26. Committing a resolved subset preserves unrelated instances...')

  const project = makeMigratedProject([
    makeRectFeature('f-first', 'First'),
    makeCircleFeature('f-second', 'Second'),
  ])
  const first = resolveFeatureInstance(project, 'f-first')
  assert(first !== null, 'first feature should resolve')
  const edited = {
    ...first,
    sketch: {
      ...first.sketch,
      profile: {
        ...first.sketch.profile,
        start: {
          x: first.sketch.profile.start.x + 12,
          y: first.sketch.profile.start.y - 4,
        },
      },
    },
  }

  const committed = commitResolvedInstances(project, [edited])
  assert(committed.length === 2, `expected 2 instances, got ${committed.length}`)
  assert(committed[1] === project.features[1], 'unrelated instance should be preserved unchanged')
  assert(committed[0].transform.e === 12, `expected x translation 12, got ${committed[0].transform.e}`)
  assert(committed[0].transform.f === -4, `expected y translation -4, got ${committed[0].transform.f}`)

  console.log('   ✓ resolved subset commit preserves unrelated instances')
}

// ── Main ────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

const tests: Array<{ name: string; fn: () => void }> = [
  { name: 'isIdentityMatrix', fn: testIdentityMatrixDetection },
  { name: 'isCirclePreservingTransform', fn: testCirclePreservingTransform },
  { name: 'isMirrorTransform', fn: testMirrorDetection },
  { name: 'applyMatrixToPoint', fn: testApplyMatrixToPoint },
  { name: 'identity profile resolution', fn: testIdentityProfileResolution },
  { name: 'translate profile resolution', fn: testTranslateProfileResolution },
  { name: 'rotate profile resolution', fn: testRotateProfileResolution },
  { name: 'uniform scale circle preserved', fn: testUniformScaleCirclePreserved },
  { name: 'non-uniform scale circle fallback', fn: testNonUniformScaleCircleFallback },
  { name: 'mirror flips circle clockwise', fn: testMirrorProfileFlipsCircleClockwise },
  { name: 'mirror rect geometry', fn: testMirrorProfileRectGeometry },
  { name: 'resolveSketch', fn: testResolveSketch },
  { name: 'identity feature resolution', fn: testIdentityFeatureResolution },
  { name: 'translated instance resolution', fn: testTranslatedFeatureResolution },
  { name: 'rotated instance resolution', fn: testRotatedInstanceResolution },
  { name: 'uniform scaled circle instance', fn: testUniformScaleCircleInstanceResolution },
  { name: 'missing definition → null', fn: testMissingDefinitionReturnsNull },
  { name: 'missing feature ID → null', fn: testMissingFeatureIdReturnsNull },
  { name: 'explicit definitionId missing → no fallback', fn: testExplicitDefinitionIdMissingDoesNotFallback },
  { name: 'resolveFeatureInstances all', fn: testResolveFeatureInstancesAll },
  { name: 'resolveFeatureInstances filtered', fn: testResolveFeatureInstancesFiltered },
  { name: 'resolveFeatureInstances skips missing', fn: testResolveFeatureInstancesSkipsMissing },
  { name: 'resolveFeatureDefinition', fn: testResolveFeatureDefinition },
  { name: 'missing definitionId has no fallback', fn: testMissingDefinitionIdDoesNotFallback },
  { name: 'instance constraints', fn: testInstanceConstraintsPreserved },
  { name: 'resolved subset commit', fn: testCommitResolvedSubsetPreservesOtherInstances },
]

for (const test of tests) {
  try {
    test.fn()
    passed += 1
  } catch (err) {
    failed += 1
    console.error(`✗ ${test.name} FAILED:`, err instanceof Error ? err.message : err)
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total\n`)

if (failed > 0) {
  throw new Error(`${failed} test(s) failed`)
}
