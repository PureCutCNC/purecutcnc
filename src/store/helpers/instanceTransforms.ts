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
 * Instance Transform Helpers — matrix builders, composition, and delta-transform
 * helpers for feature instance placement.
 *
 * Reuses classification helpers from {@link resolveFeatures.ts} rather than
 * duplicating them.
 */

import type { Matrix2D, Point } from '../../types/project'
import { IDENTITY_MATRIX } from '../../types/project'

// ============================================================================
// Matrix builders
// ============================================================================

/** Build a pure translation matrix. */
export function translateMatrix(dx: number, dy: number): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy }
}

/** Build a pure rotation matrix (around origin, angle in radians). */
export function rotateMatrix(angleRadians: number): Matrix2D {
  const cos = Math.cos(angleRadians)
  const sin = Math.sin(angleRadians)
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
}

/** Build a pure scale matrix (around origin). */
export function scaleMatrix(sx: number, sy: number): Matrix2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }
}

// ============================================================================
// Matrix composition
// ============================================================================

/**
 * Multiply two affine matrices:  `a · b`  (a applied *after* b).
 *
 * In column-vector convention (x' = a·x + c·y + e), the composed matrix
 * a·b means: first apply b, then apply a.
 */
export function multiplyMatrix(a: Matrix2D, b: Matrix2D): Matrix2D {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  }
}

// ============================================================================
// Pivoted transforms
// ============================================================================

/**
 * Wrap a transform around a pivot so it operates relative to `pivot`:
 *   T(pivot) · inner · T(-pivot)
 */
export function pivotTransform(pivot: Point, inner: Matrix2D): Matrix2D {
  const toPivot = translateMatrix(pivot.x, pivot.y)
  const fromPivot = translateMatrix(-pivot.x, -pivot.y)
  return multiplyMatrix(toPivot, multiplyMatrix(inner, fromPivot))
}

// ============================================================================
// Gesture delta builders
// ============================================================================

/** Delta matrix for a move (translate) gesture. */
export function moveDelta(dx: number, dy: number): Matrix2D {
  return translateMatrix(dx, dy)
}

/** Delta matrix for a rotate gesture around `pivot` by `angleRadians`. */
export function rotateDelta(pivot: Point, angleRadians: number): Matrix2D {
  return pivotTransform(pivot, rotateMatrix(angleRadians))
}

/** Delta matrix for an axis-aligned scale gesture around `pivot`. */
export function scaleDelta(pivot: Point, sx: number, sy: number): Matrix2D {
  return pivotTransform(pivot, scaleMatrix(sx, sy))
}

/**
 * Delta matrix for a mirror (reflection) across a line defined by two points.
 *
 * The line direction determines the reflection axis.  The matrix reflects
 * across this line — points on the line are fixed; points off the line are
 * mapped to the opposite side.
 */
export function mirrorDelta(lineStart: Point, lineEnd: Point): Matrix2D {
  const dx = lineEnd.x - lineStart.x
  const dy = lineEnd.y - lineStart.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) {
    return { ...IDENTITY_MATRIX }
  }
  const ux = dx / len
  const uy = dy / len
  const cos2 = ux * ux - uy * uy   // cos(2θ) = cos²θ - sin²θ
  const sin2 = 2 * ux * uy          // sin(2θ) = 2 sinθ cosθ

  // Mirror across line through origin with direction angle θ:
  //   [ cos2   sin2   0 ]
  //   [ sin2  -cos2   0 ]
  //   [   0      0    1 ]
  const mirrorOrigin: Matrix2D = { a: cos2, b: sin2, c: sin2, d: -cos2, e: 0, f: 0 }

  return pivotTransform(lineStart, mirrorOrigin)
}
