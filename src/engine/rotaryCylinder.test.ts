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
 * The square-to-round finished-target cylinder (issue #1016 C2-B).
 *
 * Mutations checked one at a time against these assertions:
 * - the pivot taken as `0` or as the corner radius instead of `barPivotZ`
 *   (side / 2) → "the axis sits on the true pivot on both bar axes" fails;
 * - the blank's centreline replaced by the stock origin → the across-placement
 *   assertions fail;
 * - the axis mapping swapped (across → project X on an X bar) → the Y-bar
 *   placement assertions fail;
 * - the winding flip dropped (`flip` always false) → the outward-normal,
 *   closed-orientation and positive-volume assertions fail;
 * - the sagitta bound ignored (a fixed triangle fan, or `π / acos` replaced by
 *   a constant count) → the halving-radius test and the faceting-error
 *   assertion fail;
 * - the `MAX_SEGMENTS` ceiling raised to `Infinity` → the unbounded-allocation
 *   refusal fails (and the finite request above it no longer refuses);
 * - the `diameter > side` check removed → the blank-fit refusal fails, and the
 *   inside-the-blank assertion fails for an oversized request;
 * - the ring-distinct / degenerate-triangle guard removed → the
 *   Float32-collapse refusal fails;
 * - the along-span containment check removed → the outside-the-blank refusal
 *   fails;
 * - `Number.isFinite` validation replaced by a truthiness test → the NaN and
 *   Infinity refusals fail.
 *
 * Run with: npx tsx src/engine/rotaryCylinder.test.ts
 */

import assert from 'node:assert/strict'
import { squareStock, barCentre, barPivotZ } from '../types/barStock'
import type { SquareStock } from '../types/project'
import { convertLength } from '../utils/units'
import {
  ROTARY_CYLINDER_MAX_SEGMENTS,
  ROTARY_CYLINDER_MIN_SEGMENTS,
  ROTARY_CYLINDER_SAGITTA_MM,
  buildRotaryCylinder,
  rotaryCylinderSegments,
} from './rotaryCylinder'
import type { ImportedTriangleMesh } from './importedMesh'

function near(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

function log(message: string): void {
  console.log(message)
}

function throwsRangeError(fn: () => unknown, label: string): void {
  assert.throws(fn, (error: unknown) => error instanceof RangeError, label)
}

function vertexAt(mesh: ImportedTriangleMesh, i: number): [number, number, number] {
  return [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]]
}

/** Signed volume of a closed triangle mesh (positive when wound outward). */
function signedVolume(mesh: ImportedTriangleMesh): number {
  let volume = 0
  for (let t = 0; t < mesh.index.length; t += 3) {
    const a = vertexAt(mesh, mesh.index[t])
    const b = vertexAt(mesh, mesh.index[t + 1])
    const c = vertexAt(mesh, mesh.index[t + 2])
    volume += (
      a[0] * (b[1] * c[2] - b[2] * c[1])
      - a[1] * (b[0] * c[2] - b[2] * c[0])
      + a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6
  }
  return volume
}

/** True when every undirected edge is shared by exactly two triangles. */
function isClosedManifold(mesh: ImportedTriangleMesh): boolean {
  const edges = new Map<string, number>()
  const add = (a: number, b: number): void => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }
  for (let t = 0; t < mesh.index.length; t += 3) {
    add(mesh.index[t], mesh.index[t + 1])
    add(mesh.index[t + 1], mesh.index[t + 2])
    add(mesh.index[t + 2], mesh.index[t])
  }
  return [...edges.values()].every((count) => count === 2)
}

/** The bar-frame (along, across, up) coordinates of a project-space mesh vertex. */
function barVertex(mesh: ImportedTriangleMesh, i: number, axis: 'x' | 'y'): [number, number, number] {
  const [x, y, z] = vertexAt(mesh, i)
  return axis === 'x' ? [x, y, z] : [y, x, z]
}

function triangleNormal(mesh: ImportedTriangleMesh, t: number): [number, number, number] {
  const a = vertexAt(mesh, mesh.index[t * 3])
  const b = vertexAt(mesh, mesh.index[t * 3 + 1])
  const c = vertexAt(mesh, mesh.index[t * 3 + 2])
  const u: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
}

// ── the sagitta-bound segment count ───────────────────────────

log('Testing the documented sagitta bound...')
{
  for (const units of ['mm', 'inch'] as const) {
    const tolerance = convertLength(ROTARY_CYLINDER_SAGITTA_MM, 'mm', units)
    // A range spanning the minimum-segment regime up to a large bar.
    for (const radius of units === 'mm' ? [0.002, 0.05, 0.5, 5, 40, 500, 2000] : [0.001, 0.01, 0.25, 2, 40]) {
      const segments = rotaryCylinderSegments(radius, units)
      assert.ok(segments >= ROTARY_CYLINDER_MIN_SEGMENTS, `${units}/${radius}: at least the minimum segments`)
      assert.ok(segments <= ROTARY_CYLINDER_MAX_SEGMENTS, `${units}/${radius}: within the ceiling`)
      const sagitta = radius * (1 - Math.cos(Math.PI / segments))
      assert.ok(
        sagitta <= tolerance * (1 + 1e-12),
        `${units}/${radius}: sagitta ${sagitta} within ${tolerance} (segments ${segments})`,
      )
    }

    // The count grows with radius: a bigger cylinder needs more facets for the
    // same absolute sagitta. This fails if a fixed count is used.
    const small = rotaryCylinderSegments(units === 'mm' ? 20 : 1, units)
    const large = rotaryCylinderSegments(units === 'mm' ? 200 : 10, units)
    assert.ok(large > small, `${units}: a larger radius takes more segments (${small} -> ${large})`)

    // A tiny radius is in the minimum-segment regime, and the bound still holds
    // there because eight segments already meet it.
    assert.equal(rotaryCylinderSegments(tolerance / 2, units), ROTARY_CYLINDER_MIN_SEGMENTS,
      `${units}: a radius below the tolerance takes the minimum`)
  }

  // Unbounded requests are refused, not allocated.
  throwsRangeError(() => rotaryCylinderSegments(1e6, 'mm'), 'a radius needing more than the ceiling is refused')
  throwsRangeError(() => rotaryCylinderSegments(Number.MAX_VALUE, 'mm'), 'acos rounding to one turn is refused')
  // Non-representable arguments are refused.
  for (const radius of [0, -1, NaN, Infinity]) {
    throwsRangeError(() => rotaryCylinderSegments(radius, 'mm'), `radius ${radius} is refused`)
  }
}

// ── topology, winding and volume on both bar axes ─────────────

log('Testing closed topology, outward winding and volume on both bar axes...')
{
  for (const axis of ['x', 'y'] as const) {
    const side = 30
    const length = 120
    const diameter = 20
    const alongStart = axis === 'x' ? 25 : 40
    const alongEnd = alongStart + 60
    const stock: SquareStock = squareStock(side, length, axis, { x: 10, y: 20 })
    const mesh = buildRotaryCylinder(stock, { diameter, alongStart, alongEnd }, 'mm')
    const segments = rotaryCylinderSegments(diameter / 2, 'mm')

    assert.equal(mesh.positions.length, segments * 2 * 3, `${axis}: two rings of segments`)
    assert.equal(mesh.index.length, (4 * segments - 4) * 3, `${axis}: the minimal closed triangulation`)
    assert.ok(isClosedManifold(mesh), `${axis}: every edge is shared by exactly two triangles`)

    // Placement: the axis sits on the true pivot and the blank's centreline,
    // and the band is the requested absolute span.
    const centre = barCentre(stock)
    const pivot = barPivotZ(stock)
    near(pivot, side / 2, `${axis}: pivot is side / 2`)
    for (let i = 0; i < segments * 2; i++) {
      const [along, across, up] = barVertex(mesh, i, axis)
      assert.ok(along === alongStart || along === alongEnd, `${axis}: vertex ${i} sits on a requested end`)
      const radial = Math.hypot(across - centre, up - pivot)
      near(radial, diameter / 2, `${axis}: vertex ${i} lies on the cylinder`, 1e-4)
    }
    const bounds = mesh.bounds
    if (axis === 'x') {
      near(bounds.minX, alongStart, `${axis}: bounds start at the requested along`)
      near(bounds.maxX, alongEnd, `${axis}: bounds end at the requested along`)
    } else {
      near(bounds.minY, alongStart, `${axis}: bounds start at the requested along`)
      near(bounds.maxY, alongEnd, `${axis}: bounds end at the requested along`)
    }

    // Inside the real blank: the cross-section never leaves the square and Z
    // never leaves the physical side.
    const halfSide = side / 2
    for (let i = 0; i < segments * 2; i++) {
      const [, across, up] = barVertex(mesh, i, axis)
      assert.ok(Math.abs(across - centre) <= halfSide + 1e-4, `${axis}: vertex ${i} inside the blank across`)
      assert.ok(up >= -1e-4 && up <= side + 1e-4, `${axis}: vertex ${i} inside the blank in Z`)
    }

    // Winding: the signed volume is positive and equals the ring's polygon
    // area times the length; the true cylinder is the upper bound.
    const radius = diameter / 2
    const polygonArea = 0.5 * segments * radius * radius * Math.sin((2 * Math.PI) / segments)
    const volume = signedVolume(mesh)
    const expectedVolume = polygonArea * (alongEnd - alongStart)
    near(volume, expectedVolume, `${axis}: volume is the ring area times the length`, expectedVolume * 1e-6)
    const idealVolume = Math.PI * radius * radius * (alongEnd - alongStart)
    assert.ok(volume > 0 && volume < idealVolume, `${axis}: positive volume below the ideal cylinder`)

    // Side faces point away from the axis, and the two endcaps face opposite
    // ways along the bar: together with the closed manifold above, that is the
    // outward orientation rather than merely a positive volume.
    let sideFaces = 0
    let capFaces = 0
    for (let t = 0; t < mesh.index.length / 3; t++) {
      const normal = triangleNormal(mesh, t)
      const a = barVertex(mesh, mesh.index[t * 3], axis)
      const b = barVertex(mesh, mesh.index[t * 3 + 1], axis)
      const c = barVertex(mesh, mesh.index[t * 3 + 2], axis)
      const alongs = [a[0], b[0], c[0]]
      const isCap = alongs.every((value) => Math.abs(value - alongs[0]) < 1e-4)
      if (isCap) {
        // The project-space normal's axial component, read through the same map.
        const axial = axis === 'x' ? normal[0] : normal[1]
        assert.ok(Math.abs(axial) > 1e-9, `${axis}: cap triangle ${t} faces along the bar`)
        capFaces += 1
        continue
      }
      const centroidAcross = (a[1] + b[1] + c[1]) / 3
      const centroidUp = (a[2] + b[2] + c[2]) / 3
      const radial: [number, number, number] = axis === 'x'
        ? [0, centroidAcross - centre, centroidUp - pivot]
        : [centroidAcross - centre, 0, centroidUp - pivot]
      const dot = normal[0] * radial[0] + normal[1] * radial[1] + normal[2] * radial[2]
      assert.ok(dot > 0, `${axis}: side triangle ${t} points away from the axis (${dot})`)
      sideFaces += 1
    }
    assert.equal(capFaces, 2 * (segments - 2), `${axis}: both endcaps are present`)
    assert.equal(sideFaces, 2 * segments, `${axis}: every side quad is present`)

    // Faceting error: the faceted volume is short of the ideal by at most the
    // documented sagitta applied over the circumference.
    const tolerance = ROTARY_CYLINDER_SAGITTA_MM
    const relativeError = (idealVolume - volume) / idealVolume
    assert.ok(
      relativeError <= (2 * tolerance) / radius + 1e-9,
      `${axis}: faceting error ${relativeError} within the sagitta bound`,
    )
  }
}

// ── refusals ──────────────────────────────────────────────────

log('Testing invalid, oversized and non-representable requests...')
{
  const stock = squareStock(30, 120, 'x', { x: 10, y: 20 })
  const ok = { diameter: 20, alongStart: 25, alongEnd: 85 }

  // Diameter: positive, finite, and no larger than the blank's side.
  for (const diameter of [0, -1, NaN, Infinity]) {
    throwsRangeError(() => buildRotaryCylinder(stock, { ...ok, diameter }, 'mm'), `diameter ${diameter} is refused`)
  }
  throwsRangeError(() => buildRotaryCylinder(stock, { ...ok, diameter: 30.001 }, 'mm'), 'diameter above the side is refused')
  // Exactly the side is the inscribed circle and is allowed.
  assert.ok(buildRotaryCylinder(stock, { ...ok, diameter: 30 }, 'mm'), 'diameter equal to the side is allowed')

  // Along range: finite, ascending, inside the blank.
  for (const [alongStart, alongEnd] of [[NaN, 50], [10, Infinity], [50, 50], [60, 40], [-1, 50], [10, 131]] as const) {
    throwsRangeError(
      () => buildRotaryCylinder(stock, { ...ok, alongStart, alongEnd }, 'mm'),
      `along ${alongStart}..${alongEnd} is refused`,
    )
  }
  // A span written exactly at the bounds is allowed (within the numeric slack).
  assert.ok(buildRotaryCylinder(stock, { ...ok, alongStart: 10, alongEnd: 130 }, 'mm'), 'the full blank span is allowed')

  // A cross-section too small to represent at the blank's offset is refused
  // rather than returned as a mesh whose adjacent vertices round onto a line.
  // At a ~5 m centre a Float32 coordinate steps by 0.5; a cylinder built to the
  // 0.001 mm sagitta changes `across` by about 4 × sagitta = 0.004 between
  // neighbouring vertices near the top of the ring, which rounds flat, so no
  // bound-satisfying cylinder on that blank survives.
  const distant = squareStock(1e7, 10, 'x', { x: 0, y: 0 })
  throwsRangeError(
    () => buildRotaryCylinder(distant, { diameter: 1e-3, alongStart: 0, alongEnd: 10 }, 'mm'),
    'a collapsed cross-section is refused',
  )
  throwsRangeError(
    () => buildRotaryCylinder(distant, { diameter: 6000, alongStart: 0, alongEnd: 10 }, 'mm'),
    'a cross-section that rounds to a line is refused',
  )

  // The same blank shape at a moderate offset is representable and builds: the
  // guard refuses only the geometry Float32 actually cannot hold.
  const offsetBlank = squareStock(30, 120, 'x', { x: 1000, y: 1000 })
  const offsetMesh = buildRotaryCylinder(offsetBlank, { diameter: 20, alongStart: 1025, alongEnd: 1085 }, 'mm')
  assert.ok(offsetMesh.positions.length > 0, 'a representable cross-section on an offset blank is built')
}

log('rotaryCylinder: all assertions passed.')
