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

import { getStockBounds, roundStockCentre } from '../types/project'
import type { RoundStock } from '../types/project'
import { computeMeshBounds } from './importedMesh'
import type { ImportedTriangleMesh } from './importedMesh'

/**
 * A regular polygon prism generated inside a round bar (issue #1016 C2, the
 * hex/polygon half).
 *
 * The prism is plain geometry: it is handed to the model loaders and the
 * rotary sampler (#1015) as an ordinary imported mesh. Nothing here stores a
 * generator parameter block — once it is created the pattern the user gets is
 * ordinary editable geometry, exactly as C1's dialog-established lines are.
 *
 * ## Conventions
 *
 * - The cross-section is a regular `sides`-gon inscribed in a circle of radius
 *   `acrossFlats / (2 cos(π / sides))` about the bar's centreline. `acrossFlats`
 *   is twice the apothem for every `sides` — the diameter of the polygon's
 *   inscribed circle. For an even count that is also the distance between
 *   opposite flats; for an odd count there is no opposite-flat pair, and
 *   `acrossFlats` is still twice the apothem, *not* the across-corners distance
 *   (which is `acrossFlats / cos(π / sides)`, larger). A hexagon at 10 means a
 *   10 mm across-flats hexagon.
 * - At `rotationDeg` 0 one flat's outward normal points up (+Z). Rotation is
 *   applied in the bar's own (across, up) plane, counterclockwise seen from the
 *   bar's +axially end; positive angles turn the cross-section counterclockwise
 *   in that plane. Finite degrees are reduced modulo 360 *before* the radians
 *   conversion, so a whole turn is an identity and a very large finite angle
 *   cannot overflow `degrees × π / 180` into a non-finite rotation.
 * - The mesh is emitted in final stock coordinates: on the centreline at
 *   `roundStockCentre(stock)` across the bar, on the bar's Z centreline at
 *   `diameter / 2`, and at the absolute `alongStart`/`alongEnd` positions along
 *   it. No other transform is needed before use.
 * - The two rings carry exactly the `sides` cross-section vertices, with no
 *   along-axis subdivisions beyond the requested span: `2 * sides` finite
 *   vertices and `4 * sides - 4` triangles — the minimal triangulation of a
 *   closed prism, endcaps included. `bounds` is computed from the emitted
 *   vertices, so a loader that fits raw Z bounds to a feature's Z span (the
 *   persisted model path) can be handed the real extents.
 * - A request whose emitted geometry cannot survive the mesh's Float32 storage
 *   is refused with `RangeError`: non-finite stock bounds, a coordinate outside
 *   the Float32 range, an axial span that collapses under the Float32 rounding,
 *   a cross-section that rounds to fewer than `sides` distinct ring vertices,
 *   or a triangle that rounds to zero area. The function returns either a mesh
 *   that is still a closed prism, or no mesh at all.
 * - The winding is oriented from the local cross-section and the project axis,
 *   never from the global sign of project Y. See the comment at the index
 *   build below for the exact derivation.
 */

export interface RotaryPolygonPrismInput {
  /** Number of polygon sides. Integer 3..64; 6 is the hex-bolt head. */
  sides: number
  /** Twice the polygon's apothem (across-flats). Positive and finite. */
  acrossFlats: number
  /** Start position along the bar, absolute project coordinates. Inside the bar. */
  alongStart: number
  /** End position along the bar, absolute project coordinates. Strictly after `alongStart`. */
  alongEnd: number
  /** Rotation about the bar's axis in degrees. Finite; default 0 (one flat up). */
  rotationDeg?: number
}

interface CrossPoint {
  across: number
  up: number
}

/** Maximum sides the generator accepts. Beyond this the shape is not a practical milling form. */
const MAX_SIDES = 64

/**
 * Numeric slack for the bar-containment tests. The stock's bounds and the
 * vertices are Float32 in places, so a value written at a bound can read back a
 * few ulps off it (~1e-5 on a 100 mm bar); an absolute 1e-4 (project units)
 * covers that at both mm and inch scale without admitting a genuinely outside
 * value.
 */
const TOLERANCE = 1e-4

/**
 * Validate everything before a single vertex is built. Throws `RangeError` for
 * any out-of-range input, so a caller gets either real geometry or a refusal,
 * never a partly-built mesh.
 */
function validate(
  input: RotaryPolygonPrismInput,
  diameter: number,
  axis: RoundStock['axis'],
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): void {
  if (!Number.isFinite(diameter) || diameter <= 0) {
    throw new RangeError(`Rotary polygon needs a positive finite stock diameter, got ${diameter}.`)
  }

  // The centreline and both axial extents come from these bounds; a broken
  // stock must not pass silently just because NaN comparisons are all false.
  if (![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every((value) => Number.isFinite(value))) {
    throw new RangeError(
      `Rotary polygon needs finite stock bounds, got x ${bounds.minX}..${bounds.maxX} and y ${bounds.minY}..${bounds.maxY}.`)
  }

  const sides = input.sides
  if (!Number.isInteger(sides) || sides < 3 || sides > MAX_SIDES) {
    throw new RangeError(`Rotary polygon sides must be an integer 3..${MAX_SIDES}, got ${sides}.`)
  }

  const acrossFlats = input.acrossFlats
  if (!Number.isFinite(acrossFlats) || acrossFlats <= 0) {
    throw new RangeError(`Rotary polygon acrossFlats must be positive and finite, got ${acrossFlats}.`)
  }

  const rotationDeg = input.rotationDeg ?? 0
  if (!Number.isFinite(rotationDeg)) {
    throw new RangeError(`Rotary polygon rotationDeg must be finite, got ${rotationDeg}.`)
  }

  const alongStart = input.alongStart
  const alongEnd = input.alongEnd
  if (!Number.isFinite(alongStart) || !Number.isFinite(alongEnd)) {
    throw new RangeError(`Rotary polygon alongStart/alongEnd must be finite, got ${alongStart} and ${alongEnd}.`)
  }
  if (!(alongEnd > alongStart)) {
    throw new RangeError(`Rotary polygon needs alongStart < alongEnd, got ${alongStart} and ${alongEnd}.`)
  }

  const alongMin = axis === 'x' ? bounds.minX : bounds.minY
  const alongMax = axis === 'x' ? bounds.maxX : bounds.maxY
  if (alongStart < alongMin - TOLERANCE || alongStart > alongMax + TOLERANCE
    || alongEnd < alongMin - TOLERANCE || alongEnd > alongMax + TOLERANCE) {
    throw new RangeError(
      `Rotary polygon span ${alongStart}..${alongEnd} is outside the bar's ${alongMin}..${alongMax} extent along its axis.`)
  }

  // The polygon must fit inside the bar, or it is not a machinable shape in
  // this stock. The corner radius is the binding figure, not acrossFlats.
  const acrossCorners = acrossFlats / Math.cos(Math.PI / sides)
  if (acrossCorners > diameter + TOLERANCE) {
    throw new RangeError(`Rotary polygon across-corners ${acrossCorners} exceeds the ${diameter} stock diameter.`)
  }
}

/**
 * Validate the geometry as the Float32 mesh actually stores it. Every requested
 * number can be finite, positive and inside the bar while the emitted ring is
 * not a polygon at all: rounding can collapse a small cross-section to a single
 * point, merge two ring vertices into one, or flatten three distinct vertices
 * into a straight line. Those cases pass the finite-vertex and axial-span
 * checks, so they are refused here, before the mesh is returned. Nothing is
 * compared against a minimum feature size — only the geometry that would be
 * handed back.
 */
function assertEmittedGeometry(positions: Float32Array, index: readonly number[], sides: number): void {
  // The two rings share the cross-section: ring r's vertex i lives at
  // (r * sides + i) * 3. A ring whose vertices are not all distinct is not the
  // requested polygon, and the endcap fan from it is necessarily degenerate.
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < sides; i++) {
      for (let j = i + 1; j < sides; j++) {
        const a = (ring * sides + i) * 3
        const b = (ring * sides + j) * 3
        if (positions[a] === positions[b]
          && positions[a + 1] === positions[b + 1]
          && positions[a + 2] === positions[b + 2]) {
          throw new RangeError(
            `Rotary polygon cross-section collapses under Float32 mesh coordinates: vertices ${i} and ${j} of a ring coincide. `
            + 'Move the bar closer to the origin or enlarge the polygon.')
        }
      }
    }
  }

  // A zero-area triangle is a sliver the loaders and CSG cannot use, and the
  // ring check above does not catch three *distinct* vertices that rounded into
  // a straight line — a small polygon at an offset can do exactly that.
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
        `Rotary polygon triangle ${t / 3} is degenerate under Float32 mesh coordinates; `
        + 'the cross-section or the span is too small to represent in the mesh.')
    }
  }
}

/**
 * Build a closed regular polygon prism in stock coordinates inside a round bar.
 *
 * @throws RangeError when the stock has no usable diameter or finite bounds, or
 *   when `input` is out of range: `sides` not an integer 3..64, `acrossFlats`
 *   not positive and finite, `rotationDeg` not finite, `alongStart`/`alongEnd`
 *   not finite and strictly ascending inside the bar, the polygon's
 *   across-corners larger than the stock diameter (within a small documented
 *   numeric tolerance), or the emitted geometry not representable in the mesh's
 *   Float32 coordinates (a non-finite coordinate, a collapsed axial span, a
 *   duplicated ring vertex, or a degenerate triangle).
 */
export function buildRotaryPolygonPrism(
  stock: RoundStock,
  input: RotaryPolygonPrismInput,
): ImportedTriangleMesh {
  const bounds = getStockBounds(stock)
  const diameter = stock.thickness
  validate(input, diameter, stock.axis, bounds)

  const sides = input.sides
  const alongStart = input.alongStart
  const alongEnd = input.alongEnd
  const acrossCentre = roundStockCentre(stock)
  const radius = diameter / 2

  // Cross-section vertices in the bar's own (across, up) plane. The half-step
  // offset puts a *flat* over the +up direction — its two vertices straddle it
  // at 90° ± step/2, so their edge midpoint is exactly (0, apothem) — where a
  // whole-step offset would put a corner on a triangle or a pentagon.
  // Decreasing angles keep the ring clockwise in that plane; the project-axis
  // handedness below turns that into the outward winding.
  const apothem = input.acrossFlats / 2
  const circumradius = apothem / Math.cos(Math.PI / sides)
  const step = (2 * Math.PI) / sides
  const cross: CrossPoint[] = []
  for (let i = 0; i < sides; i++) {
    const angle = Math.PI / 2 - (i + 0.5) * step
    cross.push({ across: circumradius * Math.cos(angle), up: circumradius * Math.sin(angle) })
  }

  // `rotationDeg` turns the cross-section counterclockwise in (across, up), so
  // a positive angle carries the flat-up hexagon's top flat towards -across.
  // Reduce modulo a whole turn *before* the radians conversion: a finite degree
  // value near `Number.MAX_VALUE` overflows `deg * π / 180` to Infinity, whose
  // sine and cosine are NaN, so validation on finiteness alone is not enough.
  const rotation = ((input.rotationDeg ?? 0) % 360) * Math.PI / 180
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  if (rotation !== 0) {
    for (let i = 0; i < sides; i++) {
      const point = cross[i]
      cross[i] = {
        across: point.across * cos - point.up * sin,
        up: point.across * sin + point.up * cos,
      }
    }
  }

  // Project a cross-section point at an absolute along position into stock
  // coordinates. `across` maps to project Y on an X bar and project X on a Y
  // bar; `up` is project Z above the bar's centreline.
  const vertex = (along: number, point: { across: number; up: number }): readonly [number, number, number] => {
    const across = acrossCentre + point.across
    const z = radius + point.up
    return stock.axis === 'x' ? [along, across, z] : [across, along, z]
  }

  const positions = new Float32Array(sides * 2 * 3)
  for (let i = 0; i < sides; i++) {
    const point = cross[i]
    const start = vertex(alongStart, point)
    const end = vertex(alongEnd, point)
    positions[i * 3] = start[0]
    positions[i * 3 + 1] = start[1]
    positions[i * 3 + 2] = start[2]
    const offset = (sides + i) * 3
    positions[offset] = end[0]
    positions[offset + 1] = end[1]
    positions[offset + 2] = end[2]
  }

  // Side quads and endcap fans from cross-section vertex 0, minimal for a
  // prism.
  //
  // Which of the two windings is outward follows from the project axis, never
  // from the global sign of project Y: the ring above is clockwise in the
  // (across, up) plane, and on an X bar that plane's across direction is +Y
  // while the axial direction is +X, so the same `(a, b, c)` that faces out on
  // a Y bar faces in and both quads and caps flip. The rule was pinned
  // numerically while building this file — all four combinations of the two
  // axes and the two windings, on several side counts — and is asserted on
  // both axes by `rotaryPrism.test.ts`: every side face's normal points away
  // from the centreline, each endcap faces its own bar end, and the signed
  // volume is positive and equal to the polygon area times the length.
  const flip = stock.axis === 'x'
  const index: number[] = []
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides
    const a = i
    const b = next
    const c = sides + next
    const d = sides + i
    if (!flip) index.push(a, b, c, a, c, d)
    else index.push(a, c, b, a, d, c)
  }
  for (let i = 1; i < sides - 1; i++) {
    const base = sides
    if (!flip) {
      index.push(0, i + 1, i)
      index.push(base, base + i, base + i + 1)
    } else {
      index.push(0, i, i + 1)
      index.push(base, base + i + 1, base + i)
    }
  }

  // Float32 storage silently turns a finite double into Infinity, and two
  // distinct axial positions can round to the same Float32 value. Either way
  // the emitted mesh would be invalid — a non-finite vertex, or a zero-length
  // prism with a non-finite or degenerate bounds — so refuse it rather than
  // return it under a promise that every vertex is finite.
  for (const value of positions) {
    if (!Number.isFinite(value)) {
      throw new RangeError(
        'Rotary polygon geometry is outside the Float32 range of the mesh coordinates; shorten the span, reduce the stock, or move the bar towards the origin.')
    }
  }
  const meshBounds = computeMeshBounds(positions)
  const alongSpan = stock.axis === 'x' ? meshBounds.maxX - meshBounds.minX : meshBounds.maxY - meshBounds.minY
  if (!(alongSpan > 0)) {
    throw new RangeError(
      `Rotary polygon span ${alongStart}..${alongEnd} collapses to zero length under Float32 mesh coordinates.`)
  }

  // The axial span can survive while the cross-section does not, so the emitted
  // ring and triangles are checked as stored before the mesh is returned.
  assertEmittedGeometry(positions, index, sides)

  return {
    positions,
    index: new Uint32Array(index),
    bounds: meshBounds,
  }
}
