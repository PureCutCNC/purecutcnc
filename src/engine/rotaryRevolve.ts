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
 * A turned side profile revolved about the bar axis (issue #1112 slice H,
 * decision 11).
 *
 * The profile lives in the bar's side view: `along` is the bar's project axis
 * and `radius` is the distance from the centreline. Revolving the closed region
 * bounded by the profile (an open profile is closed by projecting its ends onto
 * the axis) produces the finished solid of revolution. The Turn generator
 * stores the profile copy and calls this builder, so the mesh is regenerated
 * from the parameters, never from the sketch that was picked.
 *
 * The ring winding is the cylinder builder's (`angle = -i·step`, across
 * `cos`, up `sin`), and the emitted triangles are flipped as a whole when the
 * signed volume comes out negative, so a profile drawn either way round still
 * produces an outward-facing closed mesh.
 */

import { barCentre, barPivotZ, type RotaryBarGeometry } from '../types/barStock'
import { getStockBounds } from '../types/project'
import {
  ROTARY_CYLINDER_MAX_SEGMENTS,
  ROTARY_CYLINDER_MIN_SEGMENTS,
} from './rotaryCylinderMesh'

/** One point of a side profile: distance along the bar, distance from its axis. */
export interface RevolveProfilePoint {
  along: number
  radius: number
}

/** One outline in the side view. Open outlines are closed onto the axis. */
export interface RevolveProfileContour {
  points: readonly RevolveProfilePoint[]
  closed: boolean
}

export interface RevolveProfileMesh {
  positions: Float32Array
  indices: Uint32Array
}

/** Numeric slack for coincident points and for treating a radius as zero. */
const TOLERANCE = 1e-9

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Revolved profile needs a finite ${label}, got ${value}.`)
  }
}

function validate(stock: RotaryBarGeometry, contours: readonly RevolveProfileContour[], segments: number): void {
  const bounds = getStockBounds(stock)
  if (![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every((value) => Number.isFinite(value))) {
    throw new RangeError('Revolved profile needs finite stock bounds.')
  }
  if (!Number.isFinite(stock.thickness) || stock.thickness <= 0) {
    throw new RangeError(`Revolved profile needs a positive finite stock size, got ${stock.thickness}.`)
  }
  if (!Number.isInteger(segments)
    || segments < ROTARY_CYLINDER_MIN_SEGMENTS
    || segments > ROTARY_CYLINDER_MAX_SEGMENTS) {
    throw new RangeError(
      `Revolved profile needs an integer segment count ${ROTARY_CYLINDER_MIN_SEGMENTS}..${ROTARY_CYLINDER_MAX_SEGMENTS}, got ${segments}.`)
  }
  if (contours.length === 0) {
    throw new RangeError('Revolved profile needs at least one outline.')
  }
  for (const contour of contours) {
    if (contour.points.length < 2) {
      throw new RangeError('Revolved profile needs at least two points per outline.')
    }
    for (const point of contour.points) {
      assertFinite(point.along, 'along position')
      assertFinite(point.radius, 'radius')
      if (point.radius < -TOLERANCE) {
        throw new RangeError(`Revolved profile radius cannot be negative, got ${point.radius}.`)
      }
    }
  }
}

/** The outline closed into a polygon: an open half-profile is closed onto the axis. */
function contourPolygon(contour: RevolveProfileContour): RevolveProfilePoint[] {
  const points = contour.points.map((point) => ({
    along: point.along,
    radius: point.radius <= TOLERANCE ? 0 : point.radius,
  }))
  if (!contour.closed) {
    const last = points[points.length - 1]
    const first = points[0]
    if (last && last.radius > 0) points.push({ along: last.along, radius: 0 })
    if (first && first.radius > 0) points.push({ along: first.along, radius: 0 })
  }
  const deduped: RevolveProfilePoint[] = []
  for (const point of points) {
    const previous = deduped[deduped.length - 1]
    if (previous
      && Math.abs(previous.along - point.along) <= TOLERANCE
      && Math.abs(previous.radius - point.radius) <= TOLERANCE) {
      continue
    }
    deduped.push(point)
  }
  const last = deduped[deduped.length - 1]
  const first = deduped[0]
  if (deduped.length > 1 && last && first
    && Math.abs(last.along - first.along) <= TOLERANCE
    && Math.abs(last.radius - first.radius) <= TOLERANCE) {
    deduped.pop()
  }
  return deduped
}

function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let volume = 0
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index] * 3
    const b = indices[index + 1] * 3
    const c = indices[index + 2] * 3
    const ax = positions[a]
    const ay = positions[a + 1]
    const az = positions[a + 2]
    const bx = positions[b]
    const by = positions[b + 1]
    const bz = positions[b + 2]
    const cx = positions[c]
    const cy = positions[c + 1]
    const cz = positions[c + 2]
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  return volume
}

function flipWinding(indices: Uint32Array): void {
  for (let index = 0; index < indices.length; index += 3) {
    const second = indices[index + 1]
    indices[index + 1] = indices[index + 2]
    indices[index + 2] = second
  }
}

/**
 * Revolve the profile outlines about the bar axis in stock coordinates.
 *
 * @throws RangeError for a non-finite or empty profile, a radius below zero, an
 *   unsupported segment count, or a profile that collapses to no surface.
 */
export function buildRotaryRevolveMesh(
  stock: RotaryBarGeometry,
  contours: readonly RevolveProfileContour[],
  segments: number,
): RevolveProfileMesh {
  validate(stock, contours, segments)

  const centre = barCentre(stock)
  const pivotZ = barPivotZ(stock)
  const step = (2 * Math.PI) / segments
  const cos: number[] = []
  const sin: number[] = []
  for (let i = 0; i < segments; i += 1) {
    const angle = -i * step
    cos.push(Math.cos(angle))
    sin.push(Math.sin(angle))
  }

  const positionValues: number[] = []
  const indexValues: number[] = []
  let vertexCount = 0

  const vertex = (along: number, radius: number, ring: number): number => {
    const across = centre + radius * cos[ring]
    const up = pivotZ + radius * sin[ring]
    if (stock.axis === 'x') {
      positionValues.push(along, across, up)
    } else {
      positionValues.push(across, along, up)
    }
    return vertexCount++
  }

  for (const contour of contours) {
    const polygon = contourPolygon(contour)
    if (polygon.length < 3) {
      throw new RangeError('Revolved profile outline collapses to fewer than three distinct points.')
    }

    // One ring per outline vertex, shared by its two incident edges.
    const rings: number[][] = polygon.map((point) => {
      const ring: number[] = []
      for (let i = 0; i < segments; i += 1) {
        ring.push(vertex(point.along, point.radius, i))
      }
      return ring
    })

    const edgeCount = contour.closed ? polygon.length : polygon.length - 1
    for (let edge = 0; edge < edgeCount; edge += 1) {
      const next = (edge + 1) % polygon.length
      const start = polygon[edge]
      const end = polygon[next]
      if (!start || !end) continue
      if (start.radius <= TOLERANCE && end.radius <= TOLERANCE) continue
      const startRing = rings[edge]
      const endRing = rings[next]
      if (!startRing || !endRing) continue
      for (let i = 0; i < segments; i += 1) {
        const j = (i + 1) % segments
        const a = startRing[i]
        const b = startRing[j]
        const c = endRing[j]
        const d = endRing[i]
        if (start.radius <= TOLERANCE) {
          indexValues.push(a, c, d)
        } else if (end.radius <= TOLERANCE) {
          indexValues.push(a, b, c)
        } else {
          indexValues.push(a, b, c, a, c, d)
        }
      }
    }
  }

  if (indexValues.length === 0) {
    throw new RangeError('Revolved profile produces no surface; every outline lies on the bar axis.')
  }

  const positions = new Float32Array(positionValues)
  const indices = new Uint32Array(indexValues)
  for (const value of positions) {
    if (!Number.isFinite(value)) {
      throw new RangeError(
        'Revolved profile is outside the Float32 range of the mesh coordinates; move the bar towards the origin or shrink the profile.')
    }
  }
  if (signedVolume(positions, indices) < 0) flipWinding(indices)
  return { positions, indices }
}
