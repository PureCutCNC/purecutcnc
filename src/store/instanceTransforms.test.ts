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
 * Tests for instance transform matrix helpers.
 *
 * Run with: npx tsx src/store/instanceTransforms.test.ts
 */

import { IDENTITY_MATRIX, type Matrix2D } from '../types/project'
import {
  translateMatrix,
  rotateMatrix,
  scaleMatrix,
  multiplyMatrix,
  pivotTransform,
  rotateDelta,
  scaleDelta,
  mirrorDelta,
} from './helpers/instanceTransforms'
import { applyMatrixToPoint, isCirclePreservingTransform, isIdentityMatrix, isMirrorTransform } from './helpers/resolveFeatures'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon
}

function matrixApprox(a: Matrix2D, b: Matrix2D, epsilon = 1e-9): boolean {
  return (
    approx(a.a, b.a, epsilon) &&
    approx(a.b, b.b, epsilon) &&
    approx(a.c, b.c, epsilon) &&
    approx(a.d, b.d, epsilon) &&
    approx(a.e, b.e, epsilon) &&
    approx(a.f, b.f, epsilon)
  )
}

// ============================================================================
// Builder tests
// ============================================================================

function testTranslateMatrix(): void {
  console.log('Testing translateMatrix...')
  const t = translateMatrix(10, -5)
  assert(approx(t.a, 1), 'a should be 1')
  assert(approx(t.b, 0), 'b should be 0')
  assert(approx(t.c, 0), 'c should be 0')
  assert(approx(t.d, 1), 'd should be 1')
  assert(approx(t.e, 10), 'e should be 10')
  assert(approx(t.f, -5), 'f should be -5')

  const p = applyMatrixToPoint(t, { x: 3, y: 7 })
  assert(approx(p.x, 13), 'x should be 13')
  assert(approx(p.y, 2), 'y should be 2')
}

function testRotateMatrix(): void {
  console.log('Testing rotateMatrix...')
  const r = rotateMatrix(Math.PI / 2)
  const p = applyMatrixToPoint(r, { x: 1, y: 0 })
  assert(approx(p.x, 0), 'x should be 0 after 90° rotation')
  assert(approx(p.y, 1), 'y should be 1 after 90° rotation')
}

function testScaleMatrix(): void {
  console.log('Testing scaleMatrix...')
  const s = scaleMatrix(2, 3)
  const p = applyMatrixToPoint(s, { x: 5, y: 7 })
  assert(approx(p.x, 10), 'x should be 10')
  assert(approx(p.y, 21), 'y should be 21')
}

// ============================================================================
// Composition tests
// ============================================================================

function testMultiplyIdentity(): void {
  console.log('Testing multiplyMatrix with identity...')
  const t = translateMatrix(5, 10)
  assert(matrixApprox(multiplyMatrix(t, IDENTITY_MATRIX), t), 'T·I should equal T')
  assert(matrixApprox(multiplyMatrix(IDENTITY_MATRIX, t), t), 'I·T should equal T')
}

function testMultiplyTranslateCompose(): void {
  console.log('Testing multiplyMatrix translate compose...')
  const t1 = translateMatrix(3, 0)
  const t2 = translateMatrix(0, 4)
  const composed = multiplyMatrix(t2, t1)
  const expected = translateMatrix(3, 4)
  assert(matrixApprox(composed, expected), 'T2·T1 should equal T(3,4)')
}

function testMultiplyRotateThenTranslate(): void {
  console.log('Testing multiplyMatrix rotate then translate...')
  const rotate = rotateMatrix(Math.PI / 2)
  const translate = translateMatrix(10, 0)
  const composed = multiplyMatrix(translate, rotate)
  // Rotate (1,0) 90° → (0,1); then translate by (10,0) → (10,1)
  const p = applyMatrixToPoint(composed, { x: 1, y: 0 })
  assert(approx(p.x, 10), 'x should be 10')
  assert(approx(p.y, 1), 'y should be 1')
}

function testMultiplyNoncommutative(): void {
  console.log('Testing matrix multiplication is not commutative...')
  const rotate = rotateMatrix(Math.PI / 2)
  const translate = translateMatrix(10, 0)
  const rt = multiplyMatrix(translate, rotate)   // rotate then translate
  const tr = multiplyMatrix(rotate, translate)   // translate then rotate
  const p1 = applyMatrixToPoint(rt, { x: 1, y: 0 })
  const p2 = applyMatrixToPoint(tr, { x: 1, y: 0 })
  assert(!approx(p1.x, p2.x) || !approx(p1.y, p2.y), 'RT should differ from TR')
}

// ============================================================================
// Pivot tests
// ============================================================================

function testPivotRotate(): void {
  console.log('Testing pivotTransform with rotate...')
  const pivot = { x: 5, y: 0 }
  const angle = Math.PI / 2
  const pivoted = pivotTransform(pivot, rotateMatrix(angle))
  // Point (5, 1) rotated 90° around (5, 0) → (4, 0)
  const p = applyMatrixToPoint(pivoted, { x: 5, y: 1 })
  assert(approx(p.x, 4), 'x should be 4 after 90° pivot rotation')
  assert(approx(p.y, 0, 1e-6), 'y should be 0 after 90° pivot rotation')
}

function testPivotScale(): void {
  console.log('Testing pivotTransform with scale...')
  const pivot = { x: 2, y: 2 }
  const pivoted = pivotTransform(pivot, scaleMatrix(2, 2))
  // Point (3, 2) scaled 2x around (2, 2) → distance (1, 0) * 2 + pivot = (4, 2)
  const p = applyMatrixToPoint(pivoted, { x: 3, y: 2 })
  assert(approx(p.x, 4), 'x should be 4')
  assert(approx(p.y, 2), 'y should be 2')
}

// ============================================================================
// Delta builder tests
// ============================================================================

function testRotateDeltaEquivalent(): void {
  console.log('Testing rotateDelta equals manual pivot...')
  const pivot = { x: 3, y: 4 }
  const angle = Math.PI / 3
  const expected = pivotTransform(pivot, rotateMatrix(angle))
  const delta = rotateDelta(pivot, angle)
  assert(matrixApprox(delta, expected), 'rotateDelta should match pivotTransform + rotateMatrix')
}

function testScaleDeltaEquivalent(): void {
  console.log('Testing scaleDelta equals manual pivot...')
  const pivot = { x: 1, y: 2 }
  const expected = pivotTransform(pivot, scaleMatrix(2, 0.5))
  const delta = scaleDelta(pivot, 2, 0.5)
  assert(matrixApprox(delta, expected), 'scaleDelta should match pivotTransform + scaleMatrix')
}

function testMirrorDeltaHorizontal(): void {
  console.log('Testing mirrorDelta across horizontal axis...')
  // Mirror across the x-axis line (y = 0) from left to right
  const delta = mirrorDelta({ x: -10, y: 0 }, { x: 10, y: 0 })
  // Point above axis maps below
  const p = applyMatrixToPoint(delta, { x: 5, y: 3 })
  assert(approx(p.x, 5), 'x should stay the same')
  assert(approx(p.y, -3), 'y should be negated')
}

function testMirrorDeltaVertical(): void {
  console.log('Testing mirrorDelta across vertical axis...')
  // Mirror across the y-axis line (x = 0) from top to bottom
  const delta = mirrorDelta({ x: 0, y: -10 }, { x: 0, y: 10 })
  const p = applyMatrixToPoint(delta, { x: 5, y: 3 })
  assert(approx(p.x, -5), 'x should be negated')
  assert(approx(p.y, 3), 'y should stay the same')
}

function testMirrorDeltaOffOrigin(): void {
  console.log('Testing mirrorDelta across line not through origin...')
  // Mirror across vertical line x = 3
  const delta = mirrorDelta({ x: 3, y: -10 }, { x: 3, y: 10 })
  const p = applyMatrixToPoint(delta, { x: 5, y: 7 })
  assert(approx(p.x, 1), 'x should reflect to 1')
  assert(approx(p.y, 7), 'y should stay the same')
}

function testMirrorIsReflection(): void {
  console.log('Testing mirrorDelta has negative determinant...')
  const delta = mirrorDelta({ x: 0, y: 0 }, { x: 1, y: 1 })
  assert(isMirrorTransform(delta), 'mirror should have negative determinant')
}

// ============================================================================
// Circle preservation
// ============================================================================

function testTranslatePreservesCircle(): void {
  console.log('Testing translateMatrix is circle-preserving...')
  assert(isCirclePreservingTransform(translateMatrix(5, 10)), 'translate should preserve circles')
}

function testRotatePreservesCircle(): void {
  console.log('Testing rotateMatrix is circle-preserving...')
  assert(isCirclePreservingTransform(rotateMatrix(Math.PI / 4)), 'rotate should preserve circles')
}

function testUniformScalePreservesCircle(): void {
  console.log('Testing uniform scaleMatrix is circle-preserving...')
  assert(isCirclePreservingTransform(scaleMatrix(2, 2)), 'uniform scale should preserve circles')
}

function testNonuniformScaleDoesNotPreserveCircle(): void {
  console.log('Testing non-uniform scaleMatrix is NOT circle-preserving...')
  assert(!isCirclePreservingTransform(scaleMatrix(2, 3)), 'non-uniform scale should not preserve circles')
}

// ============================================================================
// Identity tests
// ============================================================================

function testIdentityMatrixIsIdentity(): void {
  console.log('Testing IDENTITY_MATRIX is recognized as identity...')
  assert(isIdentityMatrix(IDENTITY_MATRIX), 'IDENTITY_MATRIX should be identity')
  assert(isIdentityMatrix(translateMatrix(0, 0)), 'translate(0,0) should be identity')
}

function testTranslateIsNotIdentity(): void {
  console.log('Testing non-zero translate is not identity...')
  assert(!isIdentityMatrix(translateMatrix(1, 0)), 'translate(1,0) should not be identity')
}

// ============================================================================
// Composition round-trip
// ============================================================================

function testComposeSeqenceRoundTrip(): void {
  console.log('Testing multi-transform compose...')
  // Move (10, 0), then rotate 90° around origin, then move back (-10, 0)
  const m1 = translateMatrix(10, 0)
  const r = rotateMatrix(Math.PI / 2)
  const m2 = translateMatrix(-10, 0)
  const composed = multiplyMatrix(m2, multiplyMatrix(r, m1))
  // A point at (10, 5): m1 → (20, 5), r → (-5, 20), m2 → (-15, 20)
  const p = applyMatrixToPoint(composed, { x: 10, y: 5 })
  assert(approx(p.x, -15), 'x should be -15')
  assert(approx(p.y, 20), 'y should be 20')
}

// ============================================================================
// Run all tests
// ============================================================================

testTranslateMatrix()
testRotateMatrix()
testScaleMatrix()
testMultiplyIdentity()
testMultiplyTranslateCompose()
testMultiplyRotateThenTranslate()
testMultiplyNoncommutative()
testPivotRotate()
testPivotScale()
testRotateDeltaEquivalent()
testScaleDeltaEquivalent()
testMirrorDeltaHorizontal()
testMirrorDeltaVertical()
testMirrorDeltaOffOrigin()
testMirrorIsReflection()
testTranslatePreservesCircle()
testRotatePreservesCircle()
testUniformScalePreservesCircle()
testNonuniformScaleDoesNotPreserveCircle()
testIdentityMatrixIsIdentity()
testTranslateIsNotIdentity()
testComposeSeqenceRoundTrip()

console.log('instanceTransforms tests passed')
