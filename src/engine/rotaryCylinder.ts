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
 * The round finished target of a square-to-round job (issue #1016 C2), and the
 * canned Turn's cylinder on either bar shape (issue #1112 slice G).
 *
 * The mesh itself lives in `rotaryCylinderMesh.ts`; this module chooses the
 * segment count from the project's chord-sagitta tolerance for the one-shot
 * command. A canned Turn stores the count it was authored with, so a unit
 * conversion keeps that tessellation instead of re-deriving it.
 *
 * ## Tessellation
 *
 * The number of segments is chosen from the **chord sagitta** — the radial
 * distance between a chord's midpoint and the true circle — so the faceted
 * target is never more than {@link ROTARY_CYLINDER_SAGITTA_MM} (0.001 mm,
 * converted into the project's units) inside the ideal cylinder at any angle:
 *
 *   `s(n) = r · (1 − cos(π / n))`  ≤  `sagitta`
 *
 * which gives `n ≥ π / acos(1 − sagitta / r)`. `n` is then raised to at least
 * {@link ROTARY_CYLINDER_MIN_SEGMENTS} (a bare triangle fan is not a useful
 * target) — that minimum can only apply where the requested count is already
 * below it, so the bound still holds — and a request that would need more than
 * {@link ROTARY_CYLINDER_MAX_SEGMENTS} is refused rather than allocating an
 * unbounded mesh. Nothing here times anything or keeps module-level state.
 */

import type { RotaryBarGeometry } from '../types/barStock'
import { convertLength, type Units } from '../utils/units'
import {
  ROTARY_CYLINDER_MAX_SEGMENTS,
  ROTARY_CYLINDER_MIN_SEGMENTS,
  buildRotaryCylinderMesh,
  type RotaryCylinderInput,
} from './rotaryCylinderMesh'
import type { ImportedTriangleMesh } from './importedMesh'

export {
  ROTARY_CYLINDER_MAX_SEGMENTS,
  ROTARY_CYLINDER_MIN_SEGMENTS,
  buildRotaryCylinderMesh,
}
export type { RotaryCylinderInput }

/**
 * The documented chord-sagitta ceiling, in millimetres. Converted into the
 * project's units before a segment count is derived, so a millimetre project
 * and an inch project both get a facet that is 0.001 mm (0.0000394 in) off the
 * ideal surface at its worst point.
 */
export const ROTARY_CYLINDER_SAGITTA_MM = 0.001

/**
 * The segment count that keeps the chord sagitta within
 * {@link ROTARY_CYLINDER_SAGITTA_MM} at this radius.
 *
 * @throws RangeError when `radius` is not positive and finite, or when the
 *   bound would need more than {@link ROTARY_CYLINDER_MAX_SEGMENTS} segments
 *   (a radius so large, or a sagitta so small, that the request is unbounded).
 */
export function rotaryCylinderSegments(radius: number, units: Units): number {
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new RangeError(`Rotary cylinder needs a positive finite radius, got ${radius}.`)
  }
  const sagitta = convertLength(ROTARY_CYLINDER_SAGITTA_MM, 'mm', units)
  // `sagitta >= radius` is a cylinder smaller than its own tolerance: any
  // three-segment ring already meets the bound, so only the minimum applies.
  const raw = sagitta >= radius ? 3 : Math.ceil(Math.PI / Math.acos(1 - sagitta / radius))
  if (!Number.isFinite(raw)) {
    throw new RangeError(
      `Rotary cylinder radius ${radius} needs an unbounded segment count for a ${sagitta} sagitta.`)
  }
  const segments = Math.max(ROTARY_CYLINDER_MIN_SEGMENTS, raw)
  if (segments > ROTARY_CYLINDER_MAX_SEGMENTS) {
    throw new RangeError(
      `Rotary cylinder radius ${radius} needs ${segments} segments for a ${sagitta} sagitta, `
      + `more than the ${ROTARY_CYLINDER_MAX_SEGMENTS}-segment ceiling.`)
  }
  return segments
}

/**
 * Build a closed outward cylinder inside a round bar or square blank in stock
 * coordinates, with the segment count the units' sagitta bound asks for.
 *
 * @throws RangeError when the stock has no usable size or finite bounds, when
 *   `input` is out of range (see `rotaryCylinderMesh.ts`), or when the emitted
 *   geometry is not representable in the mesh's Float32 coordinates.
 */
export function buildRotaryCylinder(
  stock: RotaryBarGeometry,
  input: RotaryCylinderInput,
  units: Units,
): ImportedTriangleMesh {
  return buildRotaryCylinderMesh(stock, input, rotaryCylinderSegments(input.diameter / 2, units))
}
