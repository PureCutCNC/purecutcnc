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

import type { CannedShapeParams, SketchProfile } from '../types/project'

/**
 * One outline a canned shape draws, in the definition's local space. The
 * generator does not decide Add/Subtract: the model derives that from nesting
 * depth, exactly as it does for Text's glyph contours (issue #1112).
 */
export interface CannedShapeOutline {
  profile: SketchProfile
  /** Optional row name used when the shape is expanded to plain features. */
  name?: string
}

/** What Properties shows on a canned shape's one-line summary. */
export interface CannedShapeSummary {
  /** i18n key for the summary line. */
  key: string
  values?: Record<string, string | number>
}

/**
 * The extension point slices D–G code against. Registering a generator is the
 * only change a new canned shape needs in the model:
 *
 * - `kind` is the registry key stored in `CannedShapeData.kind`.
 * - `labelKey` names the shape ("Gear") for the Edit button. The button itself
 *   is generic (`Edit {shape}…`), so the label is the shape's own key.
 * - `generate` returns every outline in definition-local coordinates. Closed
 *   outlines nest by containment (outer = the feature's operation, a hole =
 *   the opposite, and so on); open outlines always keep the feature's
 *   operation. It must be deterministic — a saved file regenerates the same
 *   geometry after a reload.
 * - `normalizeParams` validates untrusted stored parameters. Return `null` to
 *   refuse generation; the stored data is not dropped either way.
 * - `summary` describes the parameters for Properties.
 */
export interface CannedShapeGenerator<P extends CannedShapeParams = CannedShapeParams> {
  /** Registry key stored in `CannedShapeData.kind`. */
  kind: string
  /** i18n key naming the shape, e.g. `'canned.gear.name'`. */
  labelKey: string
  generate(params: P): CannedShapeOutline[]
  /** Validate stored parameters. Omit when the shape has no schema to check. */
  normalizeParams?(raw: CannedShapeParams): P | null
  /**
   * Convert length parameters when the project changes units. The hook is the
   * only part of unit conversion the model cannot do itself: a size, a radius
   * and a pitch are lengths, but a tooth count and an angle are not, so the
   * generator must say which fields are which. Omit when every parameter is
   * unitless, or the parameters would silently keep their old unit.
   */
  convertParams?(params: P, convertLength: (value: number) => number): P
  summary(params: P): CannedShapeSummary
}

/** A generator after type erasure, which is how the registry stores it. */
export type RegisteredCannedShapeGenerator = CannedShapeGenerator<CannedShapeParams>

/**
 * Type-erase a concrete generator for registration while keeping `params`
 * typed inside the implementation. Generators are heterogeneous (each owns its
 * own parameter schema), so the registry cannot be generic over all of them.
 */
export function defineCannedShape<P extends CannedShapeParams>(
  generator: CannedShapeGenerator<P>,
): RegisteredCannedShapeGenerator {
  return generator as unknown as RegisteredCannedShapeGenerator
}
