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

import { barCentre, barPivotZ } from '../types/barStock'
import { getStockBounds } from '../types/project'
import type { SquareStock } from '../types/project'
import { convertLength, type Units } from '../utils/units'
import { computeMeshBounds } from './importedMesh'
import type { ImportedTriangleMesh } from './importedMesh'

/**
 * The round **finished target** of a square-to-round job (issue #1016 C2,
 * square-to-round half).
 *
 * A square blank cannot be turned round by one operation on the Around face:
 * the finished part is a cylinder that already fits inside the blank, so the
 * job is the ordinary one of producing that cylinder from the real square
 * stock. This module builds the cylinder target as plain geometry, exactly as
 * `rotaryPrism.ts` builds the polygon target: an ordinary imported mesh handed
 * to the model loaders and the rotary sampler (#1015), with no stored
 * generator parameter block.
 *
 * This is deliberately **not** a circumscribed round envelope of the blank.
 * The returned cylinder is the material the finished part keeps, and the
 * corners of the real square blank are stock the roughing operation removes —
 * neither is expressed here. The retained square ends are the engine's own
 * square-stock problem and are out of scope for this file. Nothing here
 * relabels the stock, builds a round bar, or writes any project state.
 *
 * ## Tessellation
 *
 * The cylinder is a regular `segments`-gon prism whose ring vertices lie
 * exactly on the requested radius. The number of segments is chosen from the
 * **chord sagitta** — the radial distance between a chord's midpoint and the
 * true circle — so the faceted target is never more than
 * {@link ROTARY_CYLINDER_SAGITTA_MM} (0.001 mm, converted into the project's
 * units) inside the ideal cylinder at any angle:
 *
 *   `s(n) = r · (1 − cos(π / n))`  ≤  `sagitta`
 *
 * which gives `n ≥ π / acos(1 − sagitta / r)`. `n` is then raised to at least
 * {@link ROTARY_CYLINDER_MIN_SEGMENTS} (a bare triangle fan is not a useful
 * target) — that minimum can only apply where the requested count is already
 * below it, so the bound still holds — and a request that would need more than
 * {@link ROTARY_CYLINDER_MAX_SEGMENTS} is refused rather than allocating an
 * unbounded mesh. Nothing here times anything or keeps module-level state.
 *
 * ## Conventions
 *
 * - The axis sits on the blank's true pivot: `barPivotZ(stock)` (the physical
 *   mid-thickness, `side / 2`) and `barCentre(stock)` across the bar. The
 *   `alongStart`/`alongEnd` positions are absolute project coordinates along
 *   the stock's axis.
 * - The mesh is emitted in final stock coordinates: `across` maps to project Y
 *   on an X bar and project X on a Y bar, `up` is project Z above the pivot,
 *   and the two rings sit at the absolute `alongStart`/`alongEnd`. No other
 *   transform is needed before use.
 * - The winding follows the project axis (`stock.axis === 'x'` flips it), the
 *   same rule `rotaryPrism.ts` documents: the ring is clockwise in the bar's
 *   (across, up) plane, and the project-axis handedness turns that into the
 *   outward winding. `rotaryCylinder.test.ts` re-derives it from the emitted
 *   triangles instead of trusting this note — every side normal points away
 *   from the axis, each endcap faces its own end, and the signed volume is
 *   positive and equal to the ring's polygon area times the length.
 * - A request whose emitted geometry cannot survive the mesh's Float32 storage
 *   is refused with `RangeError`: non-finite stock bounds or coordinates, a
 *   coordinate outside the Float32 range, an axial span or a ring vertex that
 *   collapses under Float32 rounding, or a triangle that rounds to zero area.
 */

export interface RotaryCylinderInput {
  /** Finished diameter, project units. Positive and finite, at most the blank's side. */
  diameter: number
  /** Start position along the bar, absolute project coordinates. Inside the blank. */
  alongStart: number
  /** End position along the bar, absolute project coordinates. Strictly after `alongStart`. */
  alongEnd: number
}

/**
 * The documented chord-sagitta ceiling, in millimetres. Converted into the
 * project's units before a segment count is derived, so a millimetre project
 * and an inch project both get a facet that is 0.001 mm (0.0000394 in) off the
 * ideal surface at its worst point.
 */
export const ROTARY_CYLINDER_SAGITTA_MM = 0.001

/** Fewest segments a target cylinder is built with, however coarse the bound allows. */
export const ROTARY_CYLINDER_MIN_SEGMENTS = 8

/** Most segments a target cylinder is built with before the request is refused as unbounded. */
export const ROTARY_CYLINDER_MAX_SEGMENTS = 4096

/**
 * Numeric slack for the blank-containment tests, matching `rotaryPrism.ts`: a
 * value written at a bound can read back a few Float32 ulps off it (~1e-5 on a
 * 100 mm bar), so an absolute 1e-4 (project units) covers that at both mm and
 * inch scale without admitting a genuinely outside value.
 */
const TOLERANCE = 1e-4

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

function validate(stock: SquareStock, input: RotaryCylinderInput): void {
  const bounds = getStockBounds(stock)
  if (![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every((value) => Number.isFinite(value))) {
    throw new RangeError(
      `Rotary cylinder needs finite stock bounds, got x ${bounds.minX}..${bounds.maxX} and y ${bounds.minY}..${bounds.maxY}.`)
  }

  const side = stock.thickness
  if (!Number.isFinite(side) || side <= 0) {
    throw new RangeError(`Rotary cylinder needs a positive finite blank side, got ${side}.`)
  }

  const diameter = input.diameter
  if (!Number.isFinite(diameter) || diameter <= 0) {
    throw new RangeError(`Rotary cylinder diameter must be positive and finite, got ${diameter}.`)
  }
  // The finished target must fit inside the real blank: at most the inscribed
  // circle of the square, i.e. its side.
  if (diameter > side + TOLERANCE) {
    throw new RangeError(`Rotary cylinder diameter ${diameter} exceeds the ${side} blank side.`)
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
      `Rotary cylinder span ${alongStart}..${alongEnd} is outside the blank's ${alongMin}..${alongMax} extent along its axis.`)
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
            + 'Move the blank closer to the origin or enlarge the cylinder.')
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
 * Build a closed outward cylinder **inside a square blank** in stock
 * coordinates.
 *
 * @throws RangeError when the blank has no usable side or finite bounds, or
 *   when `input` is out of range: `diameter` not positive and finite or larger
 *   than the blank's side, `alongStart`/`alongEnd` not finite, not strictly
 *   ascending or outside the blank's along extent (within a small documented
 *   numeric tolerance), the segment count unbounded, or the emitted geometry
 *   not representable in the mesh's Float32 coordinates (a non-finite
 *   coordinate, a collapsed ring or span, or a degenerate triangle).
 */
export function buildRotaryCylinder(
  stock: SquareStock,
  input: RotaryCylinderInput,
  units: Units,
): ImportedTriangleMesh {
  validate(stock, input)

  const radius = input.diameter / 2
  const segments = rotaryCylinderSegments(radius, units)
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
        'Rotary cylinder geometry is outside the Float32 range of the mesh coordinates; shorten the span, reduce the blank, or move it towards the origin.')
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
