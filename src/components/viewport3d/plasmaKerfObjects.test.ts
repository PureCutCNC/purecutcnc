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
 * The 3D plasma kerf band and pierce markers (issue #961).
 *
 * The properties that matter are pinned on the objects themselves: the world
 * mapping `[x, topZ, y]`, a flat band in the sheet-top plane exactly one kerf
 * wide (caps included), contour and leads in different colours, a screen-space
 * marker sprite, and the stencil state that keeps the band's overlapping quads
 * and caps from adding up. Nothing here renders, so it runs under `npx tsx`
 * with no DOM.
 *
 * Mutations these assertions were checked against:
 * - one band vertex at `topZ + 1` → the "every vertex has Y === topZ" assertion
 *   fails (this is the regression test for the camera-facing ribbon defect);
 * - `width` instead of `width / 2` as the half width → the one-kerf-wide
 *   assertions fail;
 * - dropping the cap discs → the vertex-count and zero-length-disc assertions
 *   fail;
 * - `stencilWrite: false` on the band material → the stencil assertions fail;
 * - giving both bands the same stencil ref → the differing-refs assertion
 *   fails.
 *
 * Run with: npx tsx src/components/viewport3d/plasmaKerfObjects.test.ts
 */

import assert from 'node:assert/strict'
import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import {
  PLASMA_KERF_BAND_ALPHA,
  PLASMA_PIERCE_MARKER_RADIUS_PX,
  type PlasmaKerfGeometry,
  type PlasmaKerfSegment,
} from '../plasmaKerfPreview'
import {
  buildPlasmaKerfObjects,
  disposePlasmaKerfMaterial,
  plasmaKerfBandPositions,
  plasmaPiercePositions,
  PLASMA_KERF_CONTOUR_STENCIL_REF,
  PLASMA_KERF_LEAD_STENCIL_REF,
  type PlasmaKerfObjectOptions,
} from './plasmaKerfObjects'

const CUT_COLOR = 0x112233
const LEAD_COLOR = 0x445566

/** Triangle-fan steps per cap, mirrored from the module's named constant. */
const CAP_STEPS = 16
/** Vertices: one 6-vertex quad plus one `CAP_STEPS`-triangle disc per endpoint. */
const VERTICES_PER_SEGMENT = 6 + 2 * CAP_STEPS * 3

/**
 * The spec's ideal slack is `1e-9`, but the positions are a `Float32Array`:
 * storing a half width of 1 already rounds by ~1.2e-7, so the one-kerf-wide
 * budget is the smallest epsilon the stored values can meet. A wrong half width
 * misses it by half the width, orders of magnitude above this.
 */
const HALF_WIDTH_TOLERANCE = 1e-6

function options(overrides: Partial<PlasmaKerfObjectOptions> = {}): PlasmaKerfObjectOptions {
  return {
    width: 2,
    topZ: 6,
    cutColor: CUT_COLOR,
    leadColor: LEAD_COLOR,
    emphasized: true,
    muted: false,
    showContour: true,
    showLeads: true,
    showPierces: true,
    ...overrides,
  }
}

const geometry: PlasmaKerfGeometry = {
  contour: [{ fromX: 0, fromY: 0, toX: 10, toY: 0 }],
  leads: [{ fromX: -2, fromY: -2, toX: 0, toY: 0 }],
  pierces: [{ x: -2, y: -2 }],
}

/** Read one vertex of a `[x, topZ, y]` position array as `[x, y]` in plan view. */
function vertexAt(positions: Float32Array, index: number): { x: number; y: number; worldY: number } {
  return { x: positions[index * 3], y: positions[index * 3 + 2], worldY: positions[index * 3 + 1] }
}

/** Distance from a point to the segment `a`–`b` (not its infinite line). */
function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function bands(objects: readonly THREE.Object3D[]): THREE.Mesh[] {
  return objects.filter((object): object is THREE.Mesh => object.userData.plasmaKerfBand === true)
}

function markers(objects: readonly THREE.Object3D[]): THREE.Points[] {
  return objects.filter((object): object is THREE.Points => object instanceof THREE.Points)
}

// ── Positions: a flat mesh in the sheet-top plane ─────────────────────────

{
  const positions = plasmaKerfBandPositions(
    [
      { fromX: 1, fromY: 2, toX: 3, toY: 4 },
      { fromX: 5, fromY: 6, toX: 7, toY: 8 },
    ],
    2,
    9,
  )
  assert.ok(positions instanceof Float32Array, 'band positions are a Float32Array')
  assert.equal(positions.length, 2 * VERTICES_PER_SEGMENT * 3, 'each non-zero segment is a quad plus two caps')
  for (let index = 0; index < positions.length; index += 3) {
    // The regression test for the defect: the band lies in the sheet-top plane,
    // so no vertex may rise above or sink below `topZ`.
    assert.equal(positions[index + 1], 9, 'every band vertex has world Y exactly topZ')
  }
}

{
  const positions = plasmaKerfBandPositions([], 2, 6)
  assert.ok(positions instanceof Float32Array, 'empty input still gives a Float32Array')
  assert.equal(positions.length, 0, 'no segments give no positions')
}

// ── One horizontal segment is exactly one kerf wide, caps included ────────

{
  const width = 2
  const half = width / 2
  const topZ = 6
  const segment: PlasmaKerfSegment = { fromX: 0, fromY: 0, toX: 10, toY: 0 }
  const positions = plasmaKerfBandPositions([segment], width, topZ)

  assert.equal(positions.length, VERTICES_PER_SEGMENT * 3, 'one segment is a quad plus two cap discs')

  // The first six vertices are the quad. Its corners sit exactly `W / 2` off
  // the segment's line, on both sides — the band is one kerf wide, not two.
  const sides = new Set<number>()
  for (let index = 0; index < 6; index += 1) {
    const vertex = vertexAt(positions, index)
    assert.ok(
      Math.abs(Math.abs(vertex.y) - half) <= HALF_WIDTH_TOLERANCE,
      'every quad corner is W / 2 from the segment line',
    )
    sides.add(Math.sign(vertex.y))
  }
  assert.deepEqual([...sides].sort(), [-1, 1], 'the quad straddles the segment line on both sides')

  // Caps included, nothing reaches outside the kerf: every vertex is within
  // `W / 2` of the segment itself, so the band is exactly one kerf wide.
  for (let index = 0; index < positions.length / 3; index += 1) {
    const vertex = vertexAt(positions, index)
    const distance = distanceToSegment(
      vertex.x,
      vertex.y,
      segment.fromX,
      segment.fromY,
      segment.toX,
      segment.toY,
    )
    assert.ok(
      distance <= half + HALF_WIDTH_TOLERANCE,
      'no band vertex lies outside half the kerf width from the segment',
    )
  }
}

{
  // A zero-length segment contributes its disc only: one fan of CAP_STEPS
  // triangles around the point, no quad.
  const positions = plasmaKerfBandPositions([{ fromX: 3, fromY: 4, toX: 3, toY: 4 }], 2, 6)
  assert.equal(positions.length, CAP_STEPS * 3 * 3, 'a zero-length segment gives one cap disc')
  for (let index = 0; index < positions.length / 3; index += 1) {
    const vertex = vertexAt(positions, index)
    const distance = Math.hypot(vertex.x - 3, vertex.y - 4)
    assert.ok(distance <= 1 + HALF_WIDTH_TOLERANCE, 'every disc vertex is within the kerf radius')
    assert.equal(vertex.worldY, 6, 'the disc lies in the sheet-top plane')
  }
}

{
  const positions = plasmaPiercePositions([{ x: 1, y: 2 }, { x: 3, y: 4 }], 5)
  assert.ok(positions instanceof Float32Array, 'pierce positions are a Float32Array')
  assert.equal(positions.length, 6, 'two pierces give two [x, topZ, y] triples')
  assert.deepEqual([...positions], [1, 5, 2, 3, 5, 4], 'each pierce maps to [x, topZ, y]')
  assert.equal(plasmaPiercePositions([], 5).length, 0, 'no pierces give no positions')
}

// ── The band: a flat mesh, one kerf wide, two colours ─────────────────────

{
  const objects = buildPlasmaKerfObjects(geometry, options())
  assert.equal(objects.length, 3, 'a contour band, a lead band and one marker object')
  const contourBand = bands(objects)[0]
  const leadBand = bands(objects)[1]
  assert.ok(contourBand && leadBand, 'both bands are meshes')
  assert.ok(contourBand instanceof THREE.Mesh, 'the band is a THREE.Mesh')
  assert.ok(!(contourBand instanceof LineSegments2), 'the band is no longer a LineSegments2')
  assert.equal(contourBand.userData.plasmaKerfBand, true, 'the band is marked for its own geometry disposal')

  const contourMaterial = contourBand.material as THREE.MeshBasicMaterial
  const leadMaterial = leadBand.material as THREE.MeshBasicMaterial
  assert.ok(contourMaterial instanceof THREE.MeshBasicMaterial, 'the band uses a MeshBasicMaterial')
  assert.equal(contourMaterial.color.getHex(), CUT_COLOR, 'the contour band uses the cut colour')
  assert.equal(leadMaterial.color.getHex(), LEAD_COLOR, 'the lead band uses the plunge colour')
  assert.notEqual(contourMaterial.color.getHex(), leadMaterial.color.getHex(), 'the two band colours differ')
  assert.equal(contourMaterial.side, THREE.DoubleSide, 'the flat band paints from both sides')
  assert.equal(contourMaterial.transparent, true, 'the band is translucent')
  assert.equal(contourMaterial.depthWrite, false, 'the band does not write depth')
  assert.equal(contourMaterial.depthTest, false, 'the band is not depth-tested')
  assert.ok(
    Math.abs(contourMaterial.opacity - 0.98 * PLASMA_KERF_BAND_ALPHA) < 1e-9,
    'an emphasized band uses the band alpha at full strength',
  )

  // Stencil: one band pixel each, two kinds that do not swallow each other.
  assert.equal(contourMaterial.stencilWrite, true, 'the contour band writes the stencil buffer')
  assert.equal(contourMaterial.stencilFunc, THREE.NotEqualStencilFunc, 'a contour pixel already holding the ref is discarded')
  assert.equal(contourMaterial.stencilRef, PLASMA_KERF_CONTOUR_STENCIL_REF, 'the contour band uses the contour ref')
  assert.equal(contourMaterial.stencilZPass, THREE.ReplaceStencilOp, 'a drawn contour pixel replaces the stencil with its ref')
  assert.equal(contourMaterial.stencilFail, THREE.KeepStencilOp, 'a discarded contour pixel leaves the stencil alone')
  assert.equal(contourMaterial.stencilZFail, THREE.KeepStencilOp, 'a depth-failed contour pixel leaves the stencil alone')

  assert.equal(leadMaterial.stencilWrite, true, 'the lead band writes the stencil buffer')
  assert.equal(leadMaterial.stencilFunc, THREE.NotEqualStencilFunc, 'a lead pixel already holding the ref is discarded')
  assert.equal(leadMaterial.stencilRef, PLASMA_KERF_LEAD_STENCIL_REF, 'the lead band uses the lead ref')
  assert.equal(leadMaterial.stencilZPass, THREE.ReplaceStencilOp, 'a drawn lead pixel replaces the stencil with its ref')

  assert.notEqual(
    PLASMA_KERF_CONTOUR_STENCIL_REF,
    PLASMA_KERF_LEAD_STENCIL_REF,
    'contour and lead bands use different refs so a lead still shows where it meets the contour',
  )

  const mutedBand = bands(buildPlasmaKerfObjects(geometry, options({ emphasized: false, muted: true })))[0]
  const mutedMaterial = mutedBand.material as THREE.MeshBasicMaterial
  assert.ok(mutedMaterial.opacity < contourMaterial.opacity, 'a muted band is fainter than an emphasized one')

  // The contour geometry is the mapped contour, flat at topZ.
  const position = contourBand.geometry.getAttribute('position')
  assert.equal(position.count, VERTICES_PER_SEGMENT, 'one contour segment is a quad plus two cap discs')
  assert.equal(position.itemSize, 3, 'positions are [x, topZ, y] triples')
  for (let index = 0; index < position.count; index += 1) {
    assert.equal(position.getY(index), 6, 'every contour band vertex sits on the sheet top')
  }
}

// ── The markers: a fixed-size screen sprite, unchanged ────────────────────

{
  const object = markers(buildPlasmaKerfObjects(geometry, options()))[0]
  assert.ok(object, 'the marker object is a THREE.Points')
  const material = object.material as THREE.PointsMaterial
  assert.equal(material.size, 2 * PLASMA_PIERCE_MARKER_RADIUS_PX, 'the marker size is twice the marker radius')
  assert.equal(material.sizeAttenuation, false, 'the marker never scales with distance or zoom')
  assert.equal(material.color.getHex(), LEAD_COLOR, 'the marker uses the plunge colour')
  assert.ok(material.map instanceof THREE.DataTexture, 'the marker carries a code-built ring texture')
  assert.equal(material.depthWrite, false, 'the marker does not write depth')
  assert.equal(material.depthTest, false, 'the marker is not depth-tested')
  assert.equal(material.stencilWrite, false, 'the pierce marker does not touch the stencil buffer')

  const position = object.geometry.getAttribute('position')
  assert.equal(position.count, 1, 'one pierce gives one point')
  assert.deepEqual([position.getX(0), position.getY(0), position.getZ(0)], [-2, 6, -2], 'the pierce maps to [x, topZ, y]')

  // The ring texture has a translucent ring and a centre dot separated by a
  // transparent gap, so it reads as a ring rather than a filled disc.
  const data = (material.map as THREE.DataTexture).image.data as Uint8Array
  const size = 64
  const alphaAt = (x: number, y: number): number => data[(y * size + x) * 4 + 3]
  const mid = Math.floor(size / 2)
  assert.equal(alphaAt(0, 0), 0, 'the sprite corner is transparent')
  assert.equal(alphaAt(mid, mid), 255, 'the centre dot is opaque')
  let maxAlpha = 0
  for (let index = 3; index < data.length; index += 4) {
    maxAlpha = Math.max(maxAlpha, data[index])
  }
  assert.equal(maxAlpha, 255, 'the sprite carries fully opaque pixels')
  let sawGap = false
  let ringAfterGap = false
  for (let x = mid; x < size; x += 1) {
    if (alphaAt(x, mid) === 0) {
      sawGap = true
    } else if (sawGap) {
      ringAfterGap = true
      break
    }
  }
  assert.ok(ringAfterGap, 'the middle row has a transparent gap between the centre dot and the ring')
}

// ── Switched-off parts and empty geometry cost no object ──────────────────

{
  assert.equal(buildPlasmaKerfObjects(geometry, options({ showContour: false })).length, 2, 'no contour band when cuts are off')
  assert.equal(buildPlasmaKerfObjects(geometry, options({ showLeads: false })).length, 2, 'no lead band when lead-ins are off')
  assert.equal(buildPlasmaKerfObjects(geometry, options({ showPierces: false })).length, 2, 'no marker when plunges are off')
  assert.equal(
    buildPlasmaKerfObjects(geometry, options({ showContour: false, showLeads: false, showPierces: false })).length,
    0,
    'every part switched off draws nothing',
  )

  const noContour = buildPlasmaKerfObjects(geometry, options({ showContour: false }))
  assert.equal(bands(noContour).length, 1, 'switching off the contour leaves exactly the lead band')
  assert.equal(
    (bands(noContour)[0].material as THREE.MeshBasicMaterial).color.getHex(),
    LEAD_COLOR,
    'the surviving band is the lead band',
  )
  assert.equal(markers(noContour).length, 1, 'switching off the contour keeps the marker')

  const noLeads = buildPlasmaKerfObjects(geometry, options({ showLeads: false }))
  assert.equal(bands(noLeads).length, 1, 'switching off the leads leaves exactly the contour band')
  assert.equal(
    (bands(noLeads)[0].material as THREE.MeshBasicMaterial).color.getHex(),
    CUT_COLOR,
    'the surviving band is the contour band',
  )
  assert.equal(markers(noLeads).length, 1, 'switching off the leads keeps the marker')

  const noPierces = buildPlasmaKerfObjects(geometry, options({ showPierces: false }))
  assert.equal(markers(noPierces).length, 0, 'switching off the plunges removes the marker')
  assert.equal(bands(noPierces).length, 2, 'switching off the plunges keeps both bands')

  assert.deepEqual(
    buildPlasmaKerfObjects({ contour: [], leads: [], pierces: [] }, options()),
    [],
    'empty geometry builds nothing even with every part on',
  )
}

// ── Disposal ──────────────────────────────────────────────────────────────

{
  const objects = buildPlasmaKerfObjects(geometry, options())
  const bandGeometry = bands(objects)[0].geometry
  let bandGeometryDisposed = false
  bandGeometry.addEventListener('dispose', () => { bandGeometryDisposed = true })

  const markerMaterial = (markers(objects)[0].material as THREE.PointsMaterial)
  const texture = markerMaterial.map as THREE.DataTexture
  let disposed = 0
  texture.addEventListener('dispose', () => { disposed += 1 })
  for (const object of objects) {
    object.traverse((entry) => {
      if (entry instanceof THREE.Mesh || entry instanceof THREE.Points) {
        entry.geometry.dispose()
        disposePlasmaKerfMaterial(entry.material)
      }
    })
  }
  assert.equal(bandGeometryDisposed, true, 'the band mesh owns a geometry that a disposal reaches')
  assert.equal(disposed, 1, 'disposing a marker material disposes its ring texture with it')
}

console.log('plasmaKerfObjects tests passed')
