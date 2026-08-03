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

import { IDENTITY_MATRIX } from '../types/project'
import type { Matrix2D, ModelOrientation, Point, SketchFeature } from '../types/project'

type TransformableImportedModel = SketchFeature & { transform?: Matrix2D }

/** Column-major 4x4 affine matrix shared by Three.js and manifold-3d. */
export type ImportedModelMatrix4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]

/** Return the strict instance transform, with identity for legacy test callers. */
export function importedModelInstanceTransform(feature: SketchFeature): Matrix2D {
  return (feature as TransformableImportedModel).transform ?? IDENTITY_MATRIX
}

/** Apply the model's authoritative 2D instance transform to an X/Y point. */
export function transformImportedModelPoint(transform: Matrix2D, x: number, y: number): Point {
  return {
    x: transform.a * x + transform.c * y + transform.e,
    y: transform.b * x + transform.d * y + transform.f,
  }
}

/** Convert the 2D affine instance transform to a Z-preserving 4x4 matrix. */
export function importedModelMatrix4(transform: Matrix2D): ImportedModelMatrix4 {
  return [
    transform.a, transform.b, 0, 0,
    transform.c, transform.d, 0, 0,
    0, 0, 1, 0,
    transform.e, transform.f, 0, 1,
  ]
}

/** Stable cache-key fragment containing every affine matrix component. */
export function importedModelTransformKey(transform: Matrix2D): string {
  return [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f].join(',')
}

// ============================================================================
// Post-import 3D orientation (issue #241)
// ============================================================================

/** No post-import rotation — the model as the importer produced it. */
export const IDENTITY_MODEL_ORIENTATION: ModelOrientation = { rx: 0, ry: 0, rz: 0 }

/** Angles closer than this to zero are treated as no rotation at all. */
const ORIENTATION_EPSILON = 1e-9

/** Normalize an angle to (-180, 180] so 360° and 0° share one canonical form. */
function normalizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const wrapped = ((degrees % 360) + 360) % 360
  const signed = wrapped > 180 ? wrapped - 360 : wrapped
  return Math.abs(signed) < ORIENTATION_EPSILON ? 0 : signed
}

/**
 * Canonical orientation for storage and comparison: every angle wrapped into
 * (-180, 180]. Returns `null` when the result is identity, which is what gets
 * persisted so an untouched or reset model carries no `orientation` field.
 */
export function normalizeModelOrientation(
  orientation: ModelOrientation | null | undefined,
): ModelOrientation | null {
  if (!orientation) return null
  const normalized: ModelOrientation = {
    rx: normalizeDegrees(orientation.rx),
    ry: normalizeDegrees(orientation.ry),
    rz: normalizeDegrees(orientation.rz),
  }
  return isIdentityModelOrientation(normalized) ? null : normalized
}

/** True when the orientation applies no rotation (or is absent). */
export function isIdentityModelOrientation(
  orientation: ModelOrientation | null | undefined,
): boolean {
  if (!orientation) return true
  return (
    normalizeDegrees(orientation.rx) === 0
    && normalizeDegrees(orientation.ry) === 0
    && normalizeDegrees(orientation.rz) === 0
  )
}

/**
 * Exact sine/cosine for the 90° multiples that dominate real use, so a
 * quarter-turn is a clean 0/±1 instead of `Math.sin(Math.PI / 2)` drift. Four
 * successive 90° rotations therefore round-trip back to the identity exactly.
 */
function sinCosDegrees(degrees: number): { sin: number, cos: number } {
  const wrapped = ((degrees % 360) + 360) % 360
  if (wrapped === 0) return { sin: 0, cos: 1 }
  if (wrapped === 90) return { sin: 1, cos: 0 }
  if (wrapped === 180) return { sin: 0, cos: -1 }
  if (wrapped === 270) return { sin: -1, cos: 0 }
  const radians = (wrapped * Math.PI) / 180
  return { sin: Math.sin(radians), cos: Math.cos(radians) }
}

/**
 * Rotate a single model-local point by the orientation.
 *
 * Application order is **X, then Y, then Z** about the model's own axes, i.e.
 * `p' = Rz · Ry · Rx · p`. This is the single definition of the order; every
 * other consumer goes through {@link modelOrientationMatrix4} or this function.
 */
export function rotatePointByModelOrientation(
  orientation: ModelOrientation,
  x: number,
  y: number,
  z: number,
): { x: number, y: number, z: number } {
  const { sin: sx, cos: cx } = sinCosDegrees(orientation.rx)
  const { sin: sy, cos: cy } = sinCosDegrees(orientation.ry)
  const { sin: sz, cos: cz } = sinCosDegrees(orientation.rz)

  // Rx
  const y1 = cx * y - sx * z
  const z1 = sx * y + cx * z
  // Ry
  const x2 = cy * x + sy * z1
  const z2 = -sy * x + cy * z1
  // Rz
  return {
    x: cz * x2 - sz * y1,
    y: sz * x2 + cz * y1,
    z: z2,
  }
}

/**
 * Column-major 4x4 rotation matrix for the orientation, in the same layout as
 * {@link importedModelMatrix4} so Three.js and manifold-3d can consume it
 * directly. Equivalent to {@link rotatePointByModelOrientation}.
 */
export function modelOrientationMatrix4(orientation: ModelOrientation): ImportedModelMatrix4 {
  // Build from the basis images so the matrix can never drift from the
  // point-rotation helper above.
  const ex = rotatePointByModelOrientation(orientation, 1, 0, 0)
  const ey = rotatePointByModelOrientation(orientation, 0, 1, 0)
  const ez = rotatePointByModelOrientation(orientation, 0, 0, 1)
  return [
    ex.x, ex.y, ex.z, 0,
    ey.x, ey.y, ey.z, 0,
    ez.x, ez.y, ez.z, 0,
    0, 0, 0, 1,
  ]
}

/** Stable cache-key fragment for an orientation. Identity collapses to `none`. */
export function modelOrientationKey(orientation: ModelOrientation | null | undefined): string {
  const normalized = normalizeModelOrientation(orientation)
  return normalized ? `${normalized.rx},${normalized.ry},${normalized.rz}` : 'none'
}
