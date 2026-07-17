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
import type { Matrix2D, Point, SketchFeature } from '../types/project'

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
