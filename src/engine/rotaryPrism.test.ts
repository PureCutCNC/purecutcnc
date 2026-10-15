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
 * Generated polygon prism (issue #1016 C2, hex/polygon half).
 *
 * The geometry is checked against closed-form values — apothem, circumradius,
 * flat orientation, the polygon area times the length, and a hand-built
 * support/envelope calculation — never by re-running the generator's own loop.
 * The cutter section loads the generated mesh through the real persisted-model
 * seam (`loadSTLTransformedGeometry`, which stretches raw Z bounds to the
 * feature's Z span) with the fixture's real mesh bounds and identity transform,
 * then samples it with the real `sampleRotaryModel` at several cutter radii and
 * compares each flat/ball tip against an independently computed envelope.
 *
 * Tolerances, stated where they are used:
 * - Vertex, polygon and volume assertions hold to 1e-4 project units (Float32
 *   mesh positions against analytic doubles).
 * - A cut tip is quantised by the sampler's height-map cell, so its allowance is
 *   derived from that cell and the steepest cross-section slope, not fitted.
 *
 * Run with: npx tsx src/engine/rotaryPrism.test.ts
 *
 * Mutations this file was checked against (each one must fail):
 * - Flip the triangle winding (`flip = false` in `rotaryPrism.ts`): the
 *   outward-normal assertion fails on the X bar (`side triangle 0 faces away
 *   from the centreline`), and the signed volume turns negative.
 * - Put a cross-section vertex on +up (drop the half-step offset): the ring
 *   match against the canonical flat-up polygon fails, which is exactly the
 *   orientation that assertion pins.
 * - Move the prism off the bar's Z centreline (mutation `radius + up` →
 *   `radius + up + 10`): the extracted cross-section is no longer the flat-up
 *   polygon at the bar's centreline, so the ring match fails first and the
 *   stock-space Z assertions would report the offset too.
 */

import assert from 'node:assert/strict'
import {
  newProject, roundStock, roundStockCentre,
  type Matrix2D, type Project, type RoundStock,
} from '../types/project'
import { computeMeshBounds, deserializeImportedMesh, serializeImportedMesh, type ImportedTriangleMesh } from './importedMesh'
import { loadSTLTransformedGeometry } from './csg'
import { resolveFeatureInstance } from '../store/helpers/resolveFeatures'
import { sampleRotaryModel, type RotaryModelMesh } from './toolpaths/rotaryModel'
import type { NormalizedTool } from './toolpaths/types'
import type { ToolpathWarning } from './toolpaths/warningCodes'
import { buildRotaryPolygonPrism } from './rotaryPrism'

const EPS = 1e-4

function approx(actual: number, expected: number, label: string, tolerance = EPS): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected} (±${tolerance})`)
}

interface Vec3 {
  x: number
  y: number
  z: number
}

interface CrossPoint {
  across: number
  up: number
}

function vertexAt(mesh: ImportedTriangleMesh, index: number): Vec3 {
  return { x: mesh.positions[index * 3], y: mesh.positions[index * 3 + 1], z: mesh.positions[index * 3 + 2] }
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function triangleVertices(mesh: ImportedTriangleMesh, triangle: number): [Vec3, Vec3, Vec3] {
  return [
    vertexAt(mesh, mesh.index[triangle * 3]),
    vertexAt(mesh, mesh.index[triangle * 3 + 1]),
    vertexAt(mesh, mesh.index[triangle * 3 + 2]),
  ]
}

function triangleNormal(mesh: ImportedTriangleMesh, triangle: number): Vec3 {
  const [a, b, c] = triangleVertices(mesh, triangle)
  return cross(subtract(b, a), subtract(c, a))
}

/** Signed volume via the divergence theorem. Positive for outward-facing triangles. */
function signedVolume(mesh: ImportedTriangleMesh): number {
  let total = 0
  for (let t = 0; t < mesh.index.length / 3; t++) {
    const [a, b, c] = triangleVertices(mesh, t)
    total += dot(a, cross(b, c)) / 6
  }
  return total
}

/**
 * Every side face's normal points away from the cross-section centre, and each
 * endcap faces its own bar end. The centre is the physical point
 * (`roundStockCentre`, `diameter / 2`), not 0 — a Z-centring mistake is caught
 * here as well as by the volume.
 */
function assertOutwardFaces(mesh: ImportedTriangleMesh, stock: RoundStock, label: string): { sides: number; caps: number } {
  const acrossCentre = roundStockCentre(stock)
  const radius = stock.thickness / 2
  let sides = 0
  let caps = 0
  for (let t = 0; t < mesh.index.length / 3; t++) {
    const [a, b, c] = triangleVertices(mesh, t)
    const normal = triangleNormal(mesh, t)
    const alongValues = [a, b, c].map((point) => stock.axis === 'x' ? point.x : point.y)
    if (alongValues.every((value) => value === alongValues[0])) {
      // Endcap: faces the end it sits on, away from the prism.
      const axial = stock.axis === 'x' ? normal.x : normal.y
      const alongMin = stock.axis === 'x' ? mesh.bounds.minX : mesh.bounds.minY
      const alongMax = stock.axis === 'x' ? mesh.bounds.maxX : mesh.bounds.maxY
      const expectedSign = Math.abs(alongValues[0] - alongMin) <= Math.abs(alongValues[0] - alongMax) ? -1 : 1
      assert.equal(Math.sign(axial), expectedSign, `${label} endcap at ${alongValues[0]} faces outward`)
      caps++
      continue
    }
    const centroid = {
      x: (a.x + b.x + c.x) / 3,
      y: (a.y + b.y + c.y) / 3,
      z: (a.z + b.z + c.z) / 3,
    }
    const radial = stock.axis === 'x'
      ? { x: 0, y: centroid.y - acrossCentre, z: centroid.z - radius }
      : { x: centroid.x - acrossCentre, y: 0, z: centroid.z - radius }
    assert.ok(Math.hypot(radial.x, radial.y, radial.z) > 1e-6, `${label} side triangle ${t} has a radial reference`)
    assert.ok(dot(normal, radial) > 0, `${label} side triangle ${t} faces away from the centreline`)
    sides++
  }
  return { sides, caps }
}

/** Every directed edge appears exactly once, and its reverse exactly once. */
function assertClosedOriented(mesh: ImportedTriangleMesh, label: string): void {
  const directed = new Map<string, number>()
  for (let t = 0; t < mesh.index.length; t += 3) {
    const triangle = [mesh.index[t], mesh.index[t + 1], mesh.index[t + 2]]
    for (let e = 0; e < 3; e++) {
      const key = `${triangle[e]}>${triangle[(e + 1) % 3]}`
      directed.set(key, (directed.get(key) ?? 0) + 1)
    }
  }
  assert.equal(directed.size, mesh.index.length, `${label} has ${mesh.index.length} directed edges`)
  for (const [key, count] of directed) {
    assert.equal(count, 1, `${label} directed edge ${key} appears once`)
    const [from, to] = key.split('>')
    assert.equal(directed.get(`${to}>${from}`), 1, `${label} edge ${key} has exactly one opposite partner`)
  }
}

/** Emitted cross-section vertices in the bar's (across, up) plane. */
function crossSectionOf(mesh: ImportedTriangleMesh, stock: RoundStock, sides: number): CrossPoint[] {
  const acrossCentre = roundStockCentre(stock)
  const radius = stock.thickness / 2
  const points: CrossPoint[] = []
  for (let i = 0; i < sides; i++) {
    const v = vertexAt(mesh, i)
    points.push(stock.axis === 'x'
      ? { across: v.y - acrossCentre, up: v.z - radius }
      : { across: v.x - acrossCentre, up: v.z - radius })
  }
  return points
}

/**
 * The same vertices in the analytic frame. The canonical rotation-0 set is
 * built from first principles — a flat at the top means the two vertices
 * adjacent to +up, at 90° ± step/2 — and `rotationDeg` is then applied as a
 * plain counterclockwise turn in (across, up).
 */
function analyticCrossSection(sides: number, acrossFlats: number, rotationDeg = 0): CrossPoint[] {
  const circumradius = acrossFlats / 2 / Math.cos(Math.PI / sides)
  const step = (2 * Math.PI) / sides
  const rotation = rotationDeg * Math.PI / 180
  const points: CrossPoint[] = []
  // The generator's ring is indexed clockwise from the top-right vertex; walk
  // the same indices rather than re-sorting, so vertex i pairs with vertex i.
  for (let i = 0; i < sides; i++) {
    const angle = Math.PI / 2 + step / 2 - i * step
    const across = circumradius * Math.cos(angle)
    const up = circumradius * Math.sin(angle)
    points.push({
      across: across * Math.cos(rotation) - up * Math.sin(rotation),
      up: across * Math.sin(rotation) + up * Math.cos(rotation),
    })
  }
  return points
}

/** Apply +angleDeg about the cross-section origin, CCW in (across, up). */
function rotateCrossSection(points: CrossPoint[], angleDeg: number): CrossPoint[] {
  const t = angleDeg * Math.PI / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  return points.map((point) => ({
    across: point.across * cos - point.up * sin,
    up: point.across * sin + point.up * cos,
  }))
}

/** Shoelace area of a closed cross-section. */
function polygonArea(points: CrossPoint[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.across * b.up - b.across * a.up
  }
  return Math.abs(sum) / 2
}

/**
 * The cyclic shift that maps `actual[i]` onto `expected[i + offset]`. The
 * generator is allowed to index its ring from any of the polygon's identical
 * vertices; the point set is what must match.
 */
function matchAnalyticOffset(actual: CrossPoint[], expected: CrossPoint[]): number {
  for (let offset = 0; offset < expected.length; offset++) {
    if (actual.every((point, i) => {
      const partner = expected[(i + offset) % expected.length]
      return Math.hypot(point.across - partner.across, point.up - partner.up) <= EPS
    })) return offset
  }
  return -1
}

// ---------------------------------------------------------------------------
// A1/A2: cross-section values, both axes, several polygon counts.
// ---------------------------------------------------------------------------

function assertAnalyticPolygon(stock: RoundStock, sides: number, alongStart: number, alongEnd: number): void {
  const label = `${stock.axis} bar, ${sides} sides`
  const acrossFlats = 15
  const mesh = buildRotaryPolygonPrism(stock, { sides, acrossFlats, alongStart, alongEnd })
  const apothem = acrossFlats / 2
  const circumradius = apothem / Math.cos(Math.PI / sides)
  const expected = analyticCrossSection(sides, acrossFlats)
  const actual = crossSectionOf(mesh, stock, sides)

  // The generator's ring is one cyclic rotation of the canonical flat-up set,
  // which is a different *indexing* of the same polygon, not different
  // geometry. Derive that shift once, then hold every vertex to its analytic
  // partner.
  const ringOffset = matchAnalyticOffset(actual, expected)
  assert.ok(ringOffset >= 0, `${label} emitted ring matches the flat-up polygon vertex for vertex`)

  assert.equal(mesh.positions.length, sides * 2 * 3, `${label} carries two rings of exactly ${sides} vertices`)
  assert.equal(mesh.index.length, (4 * sides - 4) * 3, `${label} has the minimal prism triangulation`)

  // A2: every cross-section vertex is on the circumradius circle and exactly
  // the apothem from both adjacent edge lines.
  actual.forEach((point, i) => {
    approx(Math.hypot(point.across, point.up), circumradius, `${label} vertex ${i} circumradius`)
    const partner = expected[(i + ringOffset) % sides]
    approx(point.across, partner.across, `${label} vertex ${i} across`)
    approx(point.up, partner.up, `${label} vertex ${i} up`)
    const neighbours = [actual[(i + 1) % sides], actual[(i - 1 + sides) % sides]]
    for (const neighbour of neighbours) {
      const edgeAcross = neighbour.across - point.across
      const edgeUp = neighbour.up - point.up
      const length = Math.hypot(edgeAcross, edgeUp)
      const distance = Math.abs(point.across * edgeUp - point.up * edgeAcross) / length
      approx(distance, apothem, `${label} vertex ${i} apothem to its neighbour edge`)
    }
  })

  // A1: at rotation 0 one flat's outward normal points up. The topmost edge is
  // then horizontal with its midpoint at (0, apothem); a corner up top would
  // leave the two candidates at across = ±a half-edge instead.
  let topEdge = [actual[0], actual[1]] as [CrossPoint, CrossPoint]
  for (let i = 1; i < sides; i++) {
    const edge = [actual[i], actual[(i + 1) % sides]] as [CrossPoint, CrossPoint]
    if ((edge[0].up + edge[1].up) / 2 > (topEdge[0].up + topEdge[1].up) / 2) topEdge = edge
  }
  approx(topEdge[0].up, topEdge[1].up, `${label} the top edge is horizontal`, 1e-4)
  approx(topEdge[0].across + topEdge[1].across, 0, `${label} the top edge is centred on the axis`, 1e-4)
  approx((topEdge[0].up + topEdge[1].up) / 2, apothem, `${label} the top flat sits one apothem above the centreline`)

  // A3: closed and consistently oriented.
  assertClosedOriented(mesh, label)

  // A4: outward winding and a positive volume.
  const faces = assertOutwardFaces(mesh, stock, label)
  assert.equal(faces.sides, 2 * sides, `${label} two side triangles per polygon edge`)
  assert.equal(faces.caps, 2 * (sides - 2), `${label} n - 2 cap triangles per end`)
  const volume = signedVolume(mesh)
  const expectedVolume = polygonArea(expected) * (alongEnd - alongStart)
  approx(volume, expectedVolume, `${label} signed volume`, Math.max(1e-6, expectedVolume * 1e-6))

  // A5: stock-space placement. The Z envelope is the cross-section's own
  // vertical extent, so for an odd count a flat-up triangle is centred on its
  // circumcentre (up = 0) but not symmetric about it in the vertical extent.
  assert.deepEqual(mesh.bounds, computeMeshBounds(mesh.positions), `${label} bounds are the emitted vertices`)
  const centre = roundStockCentre(stock)
  const radius = stock.thickness / 2
  const ups = actual.map((point) => point.up)
  approx(mesh.bounds.minZ, radius + Math.min(...ups), `${label} min Z`)
  approx(mesh.bounds.maxZ, radius + Math.max(...ups), `${label} max Z`)
  approx(ups.reduce((sum, up) => sum + up, 0) / ups.length, 0, `${label} circumcentre is the bar centreline`, 1e-4)
  if (stock.axis === 'x') {
    approx(mesh.bounds.minX, alongStart, `${label} alongStart`)
    approx(mesh.bounds.maxX, alongEnd, `${label} alongEnd`)
    approx((mesh.bounds.minY + mesh.bounds.maxY) / 2, centre, `${label} across centre`)
  } else {
    approx(mesh.bounds.minY, alongStart, `${label} alongStart`)
    approx(mesh.bounds.maxY, alongEnd, `${label} alongEnd`)
    approx((mesh.bounds.minX + mesh.bounds.maxX) / 2, centre, `${label} across centre`)
  }

  for (const value of mesh.positions) assert.ok(Number.isFinite(value), `${label} finite vertices`)
}

for (const axis of ['x', 'y'] as const) {
  // Deliberately translated across-axis stock: catches using 0 or R as the centre.
  const stock = roundStock(40, 80, axis, axis === 'x' ? { x: 0, y: 7 } : { x: 7, y: 0 })
  for (const sides of [3, 4, 6]) {
    assertAnalyticPolygon(stock, sides, 10, 30)
  }
}

// ---------------------------------------------------------------------------
// A6: a non-symmetric rotation.
// ---------------------------------------------------------------------------

{
  const stock = roundStock(40, 80, 'x', { x: 0, y: 7 })
  const base = buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 15, alongStart: 10, alongEnd: 30 })
  const baseCross = crossSectionOf(base, stock, 6)
  const canonical = analyticCrossSection(6, 15)
  const ringOffset = matchAnalyticOffset(baseCross, canonical)
  assert.ok(ringOffset >= 0, 'rotation fixture: the base ring matches the canonical polygon')
  const centre = roundStockCentre(stock)
  for (const rotationDeg of [37, -25]) {
    const rotated = buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 15, alongStart: 10, alongEnd: 30, rotationDeg })
    const rotatedCross = crossSectionOf(rotated, stock, 6)
    // The expected geometry is the canonical polygon turned by the same angle
    // in (across, up) — an independent construction of the rotation, not a
    // replay of the generator's own sine and cosine loop.
    const expected = rotateCrossSection(canonical, rotationDeg)
    rotatedCross.forEach((point, i) => {
      const partner = expected[(i + ringOffset) % 6]
      approx(point.across, partner.across, `rotation ${rotationDeg} vertex ${i} across`)
      approx(point.up, partner.up, `rotation ${rotationDeg} vertex ${i} up`)
    })
    assert.notDeepEqual(rotatedCross, baseCross, `rotation ${rotationDeg} moves the cross-section`)
    approx(rotated.bounds.minY, centre + Math.min(...rotatedCross.map((point) => point.across)), `rotation ${rotationDeg} min across`)
    approx(rotated.bounds.maxY, centre + Math.max(...rotatedCross.map((point) => point.across)), `rotation ${rotationDeg} max across`)
    approx(rotated.bounds.minZ, 20 + Math.min(...rotatedCross.map((point) => point.up)), `rotation ${rotationDeg} min Z`)
    approx(rotated.bounds.maxZ, 20 + Math.max(...rotatedCross.map((point) => point.up)), `rotation ${rotationDeg} max Z`)
    assert.ok(signedVolume(rotated) > 0, `rotation ${rotationDeg} keeps the volume positive`)
  }

  // 90 degrees counterclockwise carries the top flat round to the -across
  // side: its edge midpoint moves from (0, apothem) to (-apothem, 0), and the
  // vertical envelope grows to the circumradius. Deliberately not a no-op and
  // easy to read as a pure rotation.
  const turned = buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 15, alongStart: 10, alongEnd: 30, rotationDeg: 90 })
  const turnedCross = crossSectionOf(turned, stock, 6)
  let rotatedTop = [turnedCross[0], turnedCross[1]] as [CrossPoint, CrossPoint]
  for (let i = 1; i < 6; i++) {
    const edge = [turnedCross[i], turnedCross[(i + 1) % 6]] as [CrossPoint, CrossPoint]
    if ((edge[0].across + edge[1].across) / 2 < (rotatedTop[0].across + rotatedTop[1].across) / 2) rotatedTop = edge
  }
  approx((rotatedTop[0].across + rotatedTop[1].across) / 2, -7.5, 'rotation 90 carries the top flat to the -across side')
  approx((rotatedTop[0].up + rotatedTop[1].up) / 2, 0, 'rotation 90 leaves the top flat on the centreline', 1e-4)
  const analyticTurned = analyticCrossSection(6, 15, 90)
  approx(turned.bounds.minZ, 20 + Math.min(...analyticTurned.map((point) => point.up)),
    'rotation 90 envelope follows the analytic rotation', 1e-4)
}

// ---------------------------------------------------------------------------
// A7: the real persisted-model seam preserves the generated geometry.
// ---------------------------------------------------------------------------

/**
 * The fixture the load-Z identity needs: the feature's z_bottom/z_top are the
 * model's *actual* mesh Z bounds, not the bar's diameter.
 * `loadSTLTransformedGeometry` fits raw Z bounds to that span, so a range equal
 * to the real bounds makes the fit an identity — 0..diameter would stretch the
 * prism.
 */
function persistedModelProject(mesh: ImportedTriangleMesh): Project {
  const project = newProject('rotary prism fixture', 'mm')
  const assetId = 'model-asset'
  project.modelAssets = { [assetId]: serializeImportedMesh(mesh, 'stl') }
  project.featureDefinitions = {
    model: {
      id: 'model',
      kind: 'stl',
      profile: { start: { x: 0, y: 0 }, closed: true, segments: [] },
      dimensions: [],
      text: null,
      stl: {
        format: 'stl',
        scale: 1,
        axisSwap: 'none',
        meshAssetId: assetId,
        silhouettePaths: [],
      },
      operation: 'model',
    },
  }
  project.features = [{
    id: 'model',
    name: 'Model',
    definitionId: 'model',
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } satisfies Matrix2D,
    constraints: [],
    z_top: mesh.bounds.maxZ,
    z_bottom: mesh.bounds.minZ,
    authoringFace: 'top',
    folderId: null,
    visible: true,
    locked: false,
  }]
  return project
}

function loadPersisted(project: Project): ImportedTriangleMesh {
  const feature = resolveFeatureInstance(project, 'model')
  assert.ok(feature, 'the persisted model feature resolves through the real resolver')
  const transformed = loadSTLTransformedGeometry(feature, project)
  assert.ok(transformed, 'the persisted model loads through the real seam')
  return { positions: transformed.positions, index: transformed.index, bounds: computeMeshBounds(transformed.positions) }
}

{
  for (const axis of ['x', 'y'] as const) {
    const stock = roundStock(40, 80, axis, axis === 'x' ? { x: 0, y: 7 } : { x: 7, y: 0 })
    const built = buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 15, alongStart: 10, alongEnd: 30 })
    const project = persistedModelProject(built)
    const loaded = loadPersisted(project)

    // Loaded geometry equals the intended stock-space geometry exactly.
    assert.equal(loaded.positions.length, built.positions.length, `${axis} vertex count`)
    assert.equal(Number(loaded.bounds.minZ), Number(built.bounds.minZ), `${axis} min Z preserved`)
    assert.equal(Number(loaded.bounds.maxZ), Number(built.bounds.maxZ), `${axis} max Z preserved`)
    let maxDelta = 0
    for (let i = 0; i < built.positions.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(built.positions[i] - loaded.positions[i]))
    }
    assert.ok(maxDelta < 1e-5, `${axis} the load is an identity, not a stretch (max delta ${maxDelta})`)
    assert.deepEqual(Array.from(loaded.index), Array.from(built.index), `${axis} index preserved`)

    // The real mesh serialization round-trips.
    const deserialized = deserializeImportedMesh(project.modelAssets['model-asset'])
    assert.ok(deserialized, `${axis} asset deserializes`)
    assert.deepEqual(Array.from(deserialized.positions), Array.from(built.positions), `${axis} serialization round-trip`)

    // The raw flat-up hexagon is shorter than the bar: the case the load-Z
    // identity exists for. A 0..diameter span would have stretched it.
    const rawHeight = built.bounds.maxZ - built.bounds.minZ
    assert.ok(rawHeight < stock.thickness, `${axis} a flat-up hexagon's raw height is below the diameter`)
    approx(rawHeight, 15, `${axis} flat-up hexagon raw height is the across-flats`, 0.01)

    // The intake's load-Z trap, demonstrated rather than assumed: the same mesh
    // through the same loader but with a feature span of 0..diameter comes out
    // stretched, while the actual-bounds fixture above came out exact. This is
    // what makes the fixture's choice of z_top/z_bottom load-bearing.
    const stretched = structuredClone(project)
    stretched.features[0].z_bottom = 0
    stretched.features[0].z_top = stock.thickness
    const stretchedMesh = loadPersisted(stretched)
    approx(stretchedMesh.bounds.minZ, 0, `${axis} the 0..diameter span starts at 0`, 1e-4)
    approx(stretchedMesh.bounds.maxZ, stock.thickness, `${axis} the 0..diameter span fills the diameter`, 1e-4)
    assert.ok(stretchedMesh.bounds.maxZ - stretchedMesh.bounds.minZ > rawHeight + 1,
      `${axis} a 0..diameter span really stretches the prism, so the identity fixture is required`)
  }
}

// ---------------------------------------------------------------------------
// A8: limits, tolerances and refusals.
// ---------------------------------------------------------------------------

{
  const stock = roundStock(40, 80, 'x', { x: 0, y: 7 })
  const refusals: Array<[string, () => unknown]> = [
    ['non-integer sides', () => buildRotaryPolygonPrism(stock, { sides: 3.5, acrossFlats: 10, alongStart: 10, alongEnd: 30 })],
    ['NaN sides', () => buildRotaryPolygonPrism(stock, { sides: Number.NaN, acrossFlats: 10, alongStart: 10, alongEnd: 30 })],
    ['sides below 3', () => buildRotaryPolygonPrism(stock, { sides: 2, acrossFlats: 10, alongStart: 10, alongEnd: 30 })],
    ['sides above 64', () => buildRotaryPolygonPrism(stock, { sides: 65, acrossFlats: 10, alongStart: 10, alongEnd: 30 })],
    ['zero acrossFlats', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 0, alongStart: 10, alongEnd: 30 })],
    ['negative acrossFlats', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: -5, alongStart: 10, alongEnd: 30 })],
    ['infinite acrossFlats', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: Number.POSITIVE_INFINITY, alongStart: 10, alongEnd: 30 })],
    ['NaN acrossFlats', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: Number.NaN, alongStart: 10, alongEnd: 30 })],
    ['non-finite rotation', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 10, alongStart: 10, alongEnd: 30, rotationDeg: Number.NaN })],
    ['infinite rotation', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 10, alongStart: 10, alongEnd: 30, rotationDeg: Number.POSITIVE_INFINITY })],
    ['non-finite along', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 10, alongStart: Number.NaN, alongEnd: 30 })],
    ['descending along', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 10, alongStart: 30, alongEnd: 10 })],
    ['equal along', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 10, alongStart: 20, alongEnd: 20 })],
    ['along before the bar', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 10, alongStart: -20, alongEnd: 30 })],
    ['along past the bar', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 10, alongStart: 10, alongEnd: 200000 })],
    ['polygon bigger than the bar', () => buildRotaryPolygonPrism(stock, { sides: 3, acrossFlats: 80, alongStart: 10, alongEnd: 30 })],
    ['hexagon corners past the bar', () => buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 39.9, alongStart: 10, alongEnd: 30 })],
  ]
  for (const [label, call] of refusals) {
    assert.throws(call, RangeError, `${label} is refused with RangeError`)
  }

  // A non-positive stock diameter is refused even though `roundStock` itself
  // would build the rectangle.
  const degenerate = roundStock(0, 80, 'x')
  assert.throws(
    () => buildRotaryPolygonPrism(degenerate, { sides: 6, acrossFlats: 10, alongStart: 10, alongEnd: 30 }),
    RangeError, 'zero diameter is refused')

  // The accepted side of the boundary: the whole bar length is inside it, and a
  // genuinely tiny span is still a closed prism.
  const fullLength = buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 10, alongStart: 0, alongEnd: 80 })
  approx(fullLength.bounds.minX, 0, 'full-bar span starts at the bar start')
  approx(fullLength.bounds.maxX, 80, 'full-bar span ends at the bar end')

  const thin = buildRotaryPolygonPrism(stock, { sides: 6, acrossFlats: 10, alongStart: 10, alongEnd: 10.001 })
  assertClosedOriented(thin, 'thin span')
  assert.ok(signedVolume(thin) > 0, 'thin span keeps a positive volume')

  // The invalid request is refused before large arrays are allocated: an
  // absurd sides count must not cost proportional work.
  const started = Date.now()
  for (let i = 0; i < 200; i++) {
    assert.throws(
      () => buildRotaryPolygonPrism(stock, { sides: 1e6, acrossFlats: 1e9, alongStart: 10, alongEnd: 30, rotationDeg: Number.NaN }),
      RangeError,
    )
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1000, `200 oversized refusals are cheap (${elapsed} ms)`)
}

// ---------------------------------------------------------------------------
// B: physical cutter sampling through the real shared sampler.
//
// The reference is the sampler's own admissible-tip rule applied to the exact
// prism surface on a grid much finer than the sampler's height map:
//
//   flat: row value = max surface Z over cells whose centres are within the
//         cutter radius (a flat disc never gouges anything it cannot reach);
//   ball: row value = max over the same cells of Z - r + sqrt(r^2 - d^2), the
//         lowest point of the ball's surface at that cell.
//
// `sampleRotaryModel` is real production code and this fixture is not a
// regression fixture of it, so the assertion is a bounded agreement, not bit
// equality: the sampler quantises at its own cell size, this reference at one
// 20x finer, and the gap is bounded by the surface slope across a sampler cell.
// Matching the published rule is what makes the tips physical rather than
// merely non-empty.
// ---------------------------------------------------------------------------

const FLAT_TOOL: NormalizedTool = {
  id: 'flat-3', name: '6 mm flat endmill', sourceUnits: 'mm', units: 'mm',
  type: 'flat_endmill', diameter: 6, radius: 3, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}

const BALL_TOOL: NormalizedTool = {
  ...FLAT_TOOL, id: 'ball-3', name: '3 mm ball nose', type: 'ball_endmill', diameter: 3, radius: 1.5,
}

const PRISM_SIDES = 6
const PRISM_ACROSS_FLATS = 15
const SAMPLE_ALONG = 20
const SAMPLE_CELL = 0.05
const SAMPLE_ANGLES = [0, 12, 30, 47, 60, 90, 123]

/** The cross-section the sample mesh actually carries. */
function sampledCrossSection(stock: RoundStock, mesh: RotaryModelMesh, sides: number): CrossPoint[] {
  const acrossCentre = roundStockCentre(stock)
  const radius = stock.thickness / 2
  const points: CrossPoint[] = []
  for (let i = 0; i < sides; i++) {
    const x = mesh.positions[i * 3]
    const y = mesh.positions[i * 3 + 1]
    const z = mesh.positions[i * 3 + 2]
    points.push(stock.axis === 'x'
      ? { across: y - acrossCentre, up: z - radius }
      : { across: x - acrossCentre, up: z - radius })
  }
  return points
}

/**
 * The prism's surface height at a point in the tool frame, or -Infinity when
 * the point is outside the polygon. The cross-section is convex, so this is the
 * largest edge height among those spanning `across` (plus the vertex case).
 */
function prismSurfaceZ(points: CrossPoint[], across: number): number {
  let best = Number.NEGATIVE_INFINITY
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const wrapped = i === points.length - 1
    const lo = Math.min(a.across, b.across)
    const hi = Math.max(a.across, b.across)
    if (wrapped || (across >= lo && across <= hi)) {
      const denominator = b.across - a.across
      const s = Math.abs(denominator) > 1e-12 ? (across - a.across) / denominator : 0
      if (s >= -1e-9 && s <= 1 + 1e-9) best = Math.max(best, a.up + (b.up - a.up) * s)
    }
    if (Math.abs(across - a.across) <= 1e-9) best = Math.max(best, a.up)
  }
  return best
}

/**
 * The exact sampler rule on a fine grid, in the tool's frame for
 * `toolAngleDeg`: turn the cross-section by -angle (the sampler turns the stock
 * under a tool at the bar's top), then apply the published footprint rule. The
 * result is the tool-tip radius from the centreline, which is what
 * `tipRadius` carries — the absolute tip Z is `bar radius + this`.
 */
function referenceTipHeight(points: CrossPoint[], toolAngleDeg: number, tool: NormalizedTool): number {
  const turned = rotateCrossSection(points, -toolAngleDeg)
  const half = Math.max(...turned.map((point) => Math.hypot(point.across, point.up))) + 1
  const steps = 600
  const stepSize = (2 * half) / steps
  const radiusSq = tool.radius * tool.radius
  let best = Number.NEGATIVE_INFINITY
  for (let i = 0; i <= steps; i++) {
    const across = -half + i * stepSize
    for (let j = 0; j <= steps; j++) {
      const up = -half + j * stepSize
      const distanceSq = across * across + up * up
      if (distanceSq > radiusSq) continue
      const z = prismSurfaceZ(turned, across)
      if (!Number.isFinite(z)) continue
      const constrained = tool.type === 'ball_endmill'
        ? z - tool.radius + Math.sqrt(Math.max(0, radiusSq - distanceSq))
        : z
      if (constrained > best) best = constrained
    }
  }
  return best
}

// The reference rule itself is checked against closed-form answers before it
// judges the sampler: a flat top at 0 degrees is the apothem for any tool, a
// square's corner at 45 degrees is its half-diagonal for a point, and a ball
// over a flat is the flat less its radius plus its centre's clearance.
{
  const hex = analyticCrossSection(6, 15)
  approx(referenceTipHeight(hex, 0, { ...FLAT_TOOL, radius: 3 }), 7.5, 'reference: hex flat at 0 is the apothem', 0.01)
  approx(referenceTipHeight(hex, 0, { ...BALL_TOOL, radius: 1.5 }), 7.5, 'reference: ball touches the flat at the apothem', 0.01)
  const square = analyticCrossSection(4, 10)
  approx(referenceTipHeight(square, 45, { ...BALL_TOOL, radius: 0.001 }), 5 * Math.SQRT2,
    'reference: square corner at 45 is the half-diagonal', 0.01)
}

for (const axis of ['x', 'y'] as const) {
  const stock = roundStock(40, 80, axis, axis === 'x' ? { x: 0, y: 7 } : { x: 7, y: 0 })
  const built = buildRotaryPolygonPrism(stock, {
    sides: PRISM_SIDES,
    acrossFlats: PRISM_ACROSS_FLATS,
    alongStart: 10,
    alongEnd: 30,
  })
  const project = persistedModelProject(built)
  const loaded = loadPersisted(project)
  const model: RotaryModelMesh = { positions: loaded.positions, index: loaded.index }
  const cross = sampledCrossSection(stock, model, PRISM_SIDES)
  const apothem = PRISM_ACROSS_FLATS / 2
  const circumradius = apothem / Math.cos(Math.PI / PRISM_SIDES)
  const radius = stock.thickness / 2

  const warnings: ToolpathWarning[] = []
  const sample = (tool: NormalizedTool): ReturnType<typeof sampleRotaryModel> => sampleRotaryModel(
    model, stock, tool, { anglesDeg: SAMPLE_ANGLES, along: [SAMPLE_ALONG], requestedCellSize: SAMPLE_CELL }, warnings)
  const flatSample = sample(FLAT_TOOL)
  const ballSample = sample(BALL_TOOL)
  const narrowFlatSample = sample({ ...FLAT_TOOL, radius: 1 })

  for (const [label, result] of [['flat', flatSample], ['ball', ballSample], ['narrow flat', narrowFlatSample]] as const) {
    assert.deepEqual(result.along, [SAMPLE_ALONG], `${axis} ${label} along positions`)
    assert.deepEqual(result.anglesDeg, SAMPLE_ANGLES, `${axis} ${label} angle order`)
    assert.ok(result.tipRadius.every((row) => row.every(Number.isFinite)), `${axis} ${label} sampled the model at every angle`)
  }

  // The fixture box is about 17.4 mm across by 20 mm along, so the requested
  // 0.05 mm cell is under the 1,000,000-cell cap and the sampler used 0.05.
  // A cell-centre footprint can trail the exact envelope by the height change
  // across one cell, bounded by the steepest hexagon edge slope (tan 30°) times
  // the cell diagonal. The reference grid is 0.029 mm, itself a small share.
  const cell = SAMPLE_CELL
  const quantisation = cell * Math.tan(Math.PI / 6) * Math.SQRT2 + 0.01
  assert.ok(quantisation < 0.1, `${axis} quantisation allowance is small (${quantisation.toFixed(4)} mm)`)

  let checked = 0
  SAMPLE_ANGLES.forEach((angle, row) => {
    const exactFlat = referenceTipHeight(cross, angle, FLAT_TOOL)
    const exactBall = referenceTipHeight(cross, angle, BALL_TOOL)
    assert.ok(Number.isFinite(exactFlat) && Number.isFinite(exactBall), `${axis} angle ${angle} reference is finite`)

    const sampledFlat = flatSample.tipRadius[row][0]
    const sampledBall = ballSample.tipRadius[row][0]
    approx(sampledFlat, exactFlat, `${axis} flat tip at ${angle} matches the envelope`, quantisation)
    approx(sampledBall, exactBall, `${axis} ball tip at ${angle} matches the envelope`, quantisation)
    // Neither may go below the physical envelope: that would gouge the model.
    assert.ok(sampledFlat >= exactFlat - quantisation, `${axis} flat ${angle} does not gouge`)
    assert.ok(sampledBall >= exactBall - quantisation, `${axis} ball ${angle} does not gouge`)
    checked++
  })
  assert.equal(checked, SAMPLE_ANGLES.length, `${axis} checked every angle`)

  // Anchors that read as geometry, not as sampler output: the tip radius at
  // 0° is the apothem for every cutter (the top flat is exactly that far above
  // the centreline), so a wider or narrower flat must give the same value.
  approx(flatSample.tipRadius[0][0], apothem, `${axis} flat tip on the top flat is the apothem`, quantisation)
  approx(ballSample.tipRadius[0][0], apothem, `${axis} ball tip on the top flat is the apothem`, quantisation)
  approx(narrowFlatSample.tipRadius[0][0], apothem, `${axis} a 2 mm flat gives the same tip on a flat`, quantisation)

  // The cutter-width effect. A 2.5D prism's surface is constant along the bar,
  // so the tip moves with the cutter radius only through the *lateral* surface
  // under the footprint: a small cutter resting inside one flat sees the flat
  // alone, while a wider one reaches over the adjacent, higher faces. That is a
  // real geometric difference and both sampled tips are already held to their
  // own exact references above; this pins the difference itself, so a sampler
  // that ignored the tool radius in one direction would fail rather than hide
  // inside the tolerance. The exact reference says there is no difference at
  // 0/30/60/90 degrees, where the cutter fits inside one facet, and the sampled
  // tips must then agree.
  let widthEffectWitnesses = 0
  for (let row = 0; row < SAMPLE_ANGLES.length; row++) {
    const angle = SAMPLE_ANGLES[row]
    const exactWide = referenceTipHeight(cross, angle, FLAT_TOOL)
    const exactNarrow = referenceTipHeight(cross, angle, { ...FLAT_TOOL, radius: 1 })
    const sampledDelta = flatSample.tipRadius[row][0] - narrowFlatSample.tipRadius[row][0]
    approx(sampledDelta, exactWide - exactNarrow,
      `${axis} cutter-width effect at ${angle} matches the envelope`, quantisation * 2)
    if (Math.abs(exactWide - exactNarrow) <= 1e-6) {
      approx(sampledDelta, 0, `${axis} no cutter-width effect inside one facet at ${angle}`, quantisation)
    } else {
      assert.ok(sampledDelta > 0, `${axis} the wider cutter sits higher at ${angle} (${sampledDelta})`)
      widthEffectWitnesses++
    }
  }
  assert.ok(widthEffectWitnesses > 0, `${axis} measured at least one real cutter-width effect`)

  // The geometry the sampler read is the generated cross-section.
  approx(Math.max(...cross.map((point) => Math.hypot(point.across, point.up))), circumradius,
    `${axis} sampled cross-section circumradius`)
  assert.ok(flatSample.tipRadius.every((row) => row[0] <= radius + circumradius + 1e-6),
    `${axis} no sampled tip exceeds the bar radius + circumradius`)
}

console.log('engine/rotaryPrism.test.ts: all assertions passed')
