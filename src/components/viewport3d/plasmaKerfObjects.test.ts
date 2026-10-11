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
 * The 3D plasma kerf band and pierce markers (issue #961, slice B).
 *
 * The properties that matter are pinned on the objects themselves: the world
 * mapping `[x, topZ, y]`, a band in world units exactly one kerf wide, contour
 * and leads in different colours, and a screen-space marker sprite. Nothing
 * here renders, so it runs under `npx tsx` with no DOM.
 *
 * Mutations these assertions were checked against:
 * - `worldUnits: false` on the band material → the world-unit assertion fails;
 * - dropping the `PlasmaKerfGeometry` part from `buildPlasmaKerfObjects` (e.g.
 *   always emitting the contour band) → the switched-off assertions fail.
 *
 * Run with: npx tsx src/components/viewport3d/plasmaKerfObjects.test.ts
 */

import assert from 'node:assert/strict'
import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import {
  PLASMA_KERF_BAND_ALPHA,
  PLASMA_PIERCE_MARKER_RADIUS_PX,
  type PlasmaKerfGeometry,
} from '../plasmaKerfPreview'
import {
  buildPlasmaKerfObjects,
  disposePlasmaKerfMaterial,
  plasmaKerfSegmentPositions,
  plasmaPiercePositions,
  type PlasmaKerfObjectOptions,
} from './plasmaKerfObjects'

const CUT_COLOR = 0x112233
const LEAD_COLOR = 0x445566

function options(overrides: Partial<PlasmaKerfObjectOptions> = {}): PlasmaKerfObjectOptions {
  return {
    width: 2,
    topZ: 6,
    cutColor: CUT_COLOR,
    leadColor: LEAD_COLOR,
    emphasized: true,
    muted: false,
    resolution: new THREE.Vector2(800, 600),
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

function bands(objects: readonly THREE.Object3D[]): LineSegments2[] {
  return objects.filter((object): object is LineSegments2 => object instanceof LineSegments2)
}

function markers(objects: readonly THREE.Object3D[]): THREE.Points[] {
  return objects.filter((object): object is THREE.Points => object instanceof THREE.Points)
}

// ── Positions: the world mapping is [x, topZ, y] ──────────────────────────

{
  const segments = [
    { fromX: 1, fromY: 2, toX: 3, toY: 4 },
    { fromX: 5, fromY: 6, toX: 7, toY: 8 },
  ]
  const positions = plasmaKerfSegmentPositions(segments, 9)
  assert.ok(positions instanceof Float32Array, 'segment positions are a Float32Array')
  assert.equal(positions.length, 12, 'two segments give two triplets of endpoints')
  assert.deepEqual(
    [...positions],
    [1, 9, 2, 3, 9, 4, 5, 9, 6, 7, 9, 8],
    'each endpoint maps to [x, topZ, y]',
  )
  assert.equal(plasmaKerfSegmentPositions([], 9).length, 0, 'no segments give no positions')
}

{
  const positions = plasmaPiercePositions([{ x: 1, y: 2 }, { x: 3, y: 4 }], 5)
  assert.ok(positions instanceof Float32Array, 'pierce positions are a Float32Array')
  assert.equal(positions.length, 6, 'two pierces give two [x, topZ, y] triples')
  assert.deepEqual([...positions], [1, 5, 2, 3, 5, 4], 'each pierce maps to [x, topZ, y]')
  assert.equal(plasmaPiercePositions([], 5).length, 0, 'no pierces give no positions')
}

// ── The band: world units, one kerf wide, two colours ─────────────────────

{
  const objects = buildPlasmaKerfObjects(geometry, options())
  assert.equal(objects.length, 3, 'a contour band, a lead band and one marker object')
  const contourBand = bands(objects)[0]
  const leadBand = bands(objects)[1]
  assert.ok(contourBand && leadBand, 'both bands are LineSegments2')

  const contourMaterial = contourBand.material as LineMaterial
  const leadMaterial = leadBand.material as LineMaterial
  assert.equal(contourMaterial.worldUnits, true, 'the band is in world units')
  assert.equal(contourMaterial.linewidth, 2, 'the band line width is the kerf width')
  assert.equal(contourMaterial.color.getHex(), CUT_COLOR, 'the contour band uses the cut colour')
  assert.equal(leadMaterial.color.getHex(), LEAD_COLOR, 'the lead band uses the plunge colour')
  assert.notEqual(contourMaterial.color.getHex(), leadMaterial.color.getHex(), 'the two band colours differ')
  assert.equal(contourMaterial.transparent, true, 'the band is translucent')
  assert.equal(contourMaterial.depthWrite, false, 'the band does not write depth')
  assert.equal(contourMaterial.depthTest, false, 'the band is not depth-tested')
  assert.ok(
    Math.abs(contourMaterial.opacity - 0.98 * PLASMA_KERF_BAND_ALPHA) < 1e-9,
    'an emphasized band uses the band alpha at full strength',
  )
  const mutedMaterial = (buildPlasmaKerfObjects(geometry, options({ emphasized: false, muted: true }))[0] as LineSegments2)
    .material as LineMaterial
  assert.ok(mutedMaterial.opacity < contourMaterial.opacity, 'a muted band is fainter than an emphasized one')

  // The contour geometry is the mapped contour, not the leads.
  const start = contourBand.geometry.getAttribute('instanceStart')
  const end = contourBand.geometry.getAttribute('instanceEnd')
  assert.equal(start.count, 1, 'one contour segment')
  assert.deepEqual([start.getX(0), start.getY(0), start.getZ(0)], [0, 6, 0], 'the contour starts on the part line at topZ')
  assert.deepEqual([end.getX(0), end.getY(0), end.getZ(0)], [10, 6, 0], 'the contour ends on the part line at topZ')
}

// ── The markers: a fixed-size screen sprite ───────────────────────────────

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
    (bands(noContour)[0].material as LineMaterial).color.getHex(),
    LEAD_COLOR,
    'the surviving band is the lead band',
  )
  assert.equal(markers(noContour).length, 1, 'switching off the contour keeps the marker')

  const noLeads = buildPlasmaKerfObjects(geometry, options({ showLeads: false }))
  assert.equal(bands(noLeads).length, 1, 'switching off the leads leaves exactly the contour band')
  assert.equal(
    (bands(noLeads)[0].material as LineMaterial).color.getHex(),
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
  assert.equal(disposed, 1, 'disposing a marker material disposes its ring texture with it')
}

console.log('plasmaKerfObjects tests passed')
