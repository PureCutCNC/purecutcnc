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
 * The cylinder mesh shared by Square to round and Turn (issue #1016 C2,
 * #1112 slice G).
 *
 * This module deliberately has no unit dependency: the caller supplies the
 * segment count. `rotaryCylinder.ts` derives it from the project's sagitta for
 * the one-shot command, while a canned Turn stores the count it was authored
 * with. Splitting it out also keeps the generator off the `utils/units` import
 * that would otherwise cycle back through the canned-shape registry.
 */

import { barCentre, barPivotZ, type RotaryBarGeometry } from '../types/barStock'
import { getStockBounds } from '../types/project'
import { computeMeshBounds } from './importedMesh'
import type { ImportedTriangleMesh } from './importedMesh'

export interface RotaryCylinderInput {
  /** Finished diameter, project units. Positive and finite, at most the stock size. */
  diameter: number
  /** Start position along the bar, absolute project coordinates. Inside the bar. */
  alongStart: number
  /** End position along the bar, absolute project coordinates. Strictly after `alongStart`. */
  alongEnd: number
}

/** Fewest segments a target cylinder is built with, however coarse the bound allows. */
export const ROTARY_CYLINDER_MIN_SEGMENTS = 8

/** Most segments a target cylinder is built with before the request is refused as unbounded. */
export const ROTARY_CYLINDER_MAX_SEGMENTS = 4096

/**
 * Numeric slack for the stock-containment tests, matching `rotaryPrism.ts`: a
 * value written at a bound can read back a few Float32 ulps off it (~1e-5 on a
 * 100 mm bar), so an absolute 1e-4 (project units) covers that at both mm and
 * inch scale without admitting a genuinely outside value.
 */
const TOLERANCE = 1e-4

function validate(stock: RotaryBarGeometry, input: RotaryCylinderInput): void {
  const bounds = getStockBounds(stock)
  if (![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every((value) => Number.isFinite(value))) {
    throw new RangeError(
      `Rotary cylinder needs finite stock bounds, got x ${bounds.minX}..${bounds.maxX} and y ${bounds.minY}..${bounds.maxY}.`)
  }

  const side = stock.thickness
  if (!Number.isFinite(side) || side <= 0) {
    throw new RangeError(`Rotary cylinder needs a positive finite stock size, got ${side}.`)
  }

  const diameter = input.diameter
  if (!Number.isFinite(diameter) || diameter <= 0) {
    throw new RangeError(`Rotary cylinder diameter must be positive and finite, got ${diameter}.`)
  }
  // The finished target must fit inside the stock: at most its thickness, which
  // is the square blank's side or the round bar's diameter.
  if (diameter > side + TOLERANCE) {
    throw new RangeError(`Rotary cylinder diameter ${diameter} exceeds the ${side} stock size.`)
  }

  const alongStart = input.alongStart
  const alongEnd = input.alongEnd
  if (!Number.isFinite(alongStart) || !Number.isFinite(alongEnd)) {
    throw new RangeError(`Rotary cylinder alongStart/alongEnd must be finite, got ${alongStart} and ${alongEnd}.`)
  }
  if (!(alongEnd > alongStart)) {
    throw new RangeError(`Rotary cylinder needs alongStart < alongEnd, got ${alongStart} and ${alongEnd}.`)
  }

  const alongMin = stock.axis === 'x' ? bounds.minX : bounds.minY
  const alongMax = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  if (alongStart < alongMin - TOLERANCE || alongStart > alongMax + TOLERANCE
    || alongEnd < alongMin - TOLERANCE || alongEnd > alongMax + TOLERANCE) {
    throw new RangeError(
      `Rotary cylinder span ${alongStart}..${alongEnd} is outside the stock's ${alongMin}..${alongMax} extent along its axis.`)
  }
}


interface CrossPoint {
  across: number
  up: number
}

/**
 * Validate the geometry as the Float32 mesh actually stores it: a ring whose
 * vertices are not all distinct is not the requested cylinder, and a triangle
 * that rounds to zero area is a sliver the loaders and CSG cannot use. Both can
 * pass every finite-number check — rounding collapses them — so they are
 * refused here, before the mesh is handed back.
 */
function assertEmittedGeometry(positions: Float32Array, index: readonly number[], segments: number): void {
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < segments; i++) {
      for (let j = i + 1; j < segments; j++) {
        const a = (ring * segments + i) * 3
        const b = (ring * segments + j) * 3
        if (positions[a] === positions[b]
          && positions[a + 1] === positions[b + 1]
          && positions[a + 2] === positions[b + 2]) {
          throw new RangeError(
            `Rotary cylinder ring collapses under Float32 mesh coordinates: vertices ${i} and ${j} coincide. `
            + 'Move the stock closer to the origin or enlarge the cylinder.')
        }
      }
    }
  }

  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3
    const b = index[t + 1] * 3
    const c = index[t + 2] * 3
    const ux = positions[b] - positions[a]
    const uy = positions[b + 1] - positions[a + 1]
    const uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a]
    const vy = positions[c + 1] - positions[a + 1]
    const vz = positions[c + 2] - positions[a + 2]
    if (uy * vz - uz * vy === 0
      && uz * vx - ux * vz === 0
      && ux * vy - uy * vx === 0) {
      throw new RangeError(
        `Rotary cylinder triangle ${t / 3} is degenerate under Float32 mesh coordinates; `
        + 'the diameter or the span is too small to represent in the mesh.')
    }
  }
}

/**
 * Build a closed outward cylinder inside a round bar or square blank in stock
 * coordinates, with an explicit segment count. A canned Turn stores the
 * count chosen when the diameter was set, so a unit conversion keeps the
 * tessellation the geometry was authored with (issue #1112 slice G).
 *
 * @throws RangeError for the input refusals above, and when `segments` is not an
 *   integer in the supported range.
 */
export function buildRotaryCylinderMesh(
  stock: RotaryBarGeometry,
  input: RotaryCylinderInput,
  segments: number,
): ImportedTriangleMesh {
  validate(stock, input)
  if (!Number.isInteger(segments)
    || segments < ROTARY_CYLINDER_MIN_SEGMENTS
    || segments > ROTARY_CYLINDER_MAX_SEGMENTS) {
    throw new RangeError(
      `Rotary cylinder needs an integer segment count ${ROTARY_CYLINDER_MIN_SEGMENTS}..${ROTARY_CYLINDER_MAX_SEGMENTS}, got ${segments}.`)
  }

  const radius = input.diameter / 2
  const alongStart = input.alongStart
  const alongEnd = input.alongEnd
  const centre = barCentre(stock)
  const pivotZ = barPivotZ(stock)

  // Ring vertices in the bar's own (across, up) plane. Decreasing angles keep
  // the ring clockwise in that plane; the project-axis handedness below turns
  // that into the outward winding (the same derivation as `rotaryPrism.ts`,
  // re-checked numerically by the test).
  const step = (2 * Math.PI) / segments
  const cross: CrossPoint[] = []
  for (let i = 0; i < segments; i++) {
    const angle = -i * step
    cross.push({ across: radius * Math.cos(angle), up: radius * Math.sin(angle) })
  }

  const vertex = (along: number, point: CrossPoint): readonly [number, number, number] => {
    const across = centre + point.across
    const z = pivotZ + point.up
    return stock.axis === 'x' ? [along, across, z] : [across, along, z]
  }

  const positions = new Float32Array(segments * 2 * 3)
  for (let i = 0; i < segments; i++) {
    const point = cross[i]
    const start = vertex(alongStart, point)
    const end = vertex(alongEnd, point)
    positions[i * 3] = start[0]
    positions[i * 3 + 1] = start[1]
    positions[i * 3 + 2] = start[2]
    const offset = (segments + i) * 3
    positions[offset] = end[0]
    positions[offset + 1] = end[1]
    positions[offset + 2] = end[2]
  }

  const flip = stock.axis === 'x'
  const index: number[] = []
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments
    const a = i
    const b = next
    const c = segments + next
    const d = segments + i
    if (!flip) index.push(a, b, c, a, c, d)
    else index.push(a, c, b, a, d, c)
  }
  for (let i = 1; i < segments - 1; i++) {
    const base = segments
    if (!flip) {
      index.push(0, i + 1, i)
      index.push(base, base + i, base + i + 1)
    } else {
      index.push(0, i, i + 1)
      index.push(base, base + i + 1, base + i)
    }
  }

  for (const value of positions) {
    if (!Number.isFinite(value)) {
      throw new RangeError(
        'Rotary cylinder geometry is outside the Float32 range of the mesh coordinates; shorten the span, reduce the stock, or move it towards the origin.')
    }
  }
  const meshBounds = computeMeshBounds(positions)
  const alongSpan = stock.axis === 'x' ? meshBounds.maxX - meshBounds.minX : meshBounds.maxY - meshBounds.minY
  if (!(alongSpan > 0)) {
    throw new RangeError(
      `Rotary cylinder span ${alongStart}..${alongEnd} collapses to zero length under Float32 mesh coordinates.`)
  }

  assertEmittedGeometry(positions, index, segments)

  return {
    positions,
    index: new Uint32Array(index),
    bounds: meshBounds,
  }
}
