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
 * Plasma kerf band and pierce markers as 3D scene objects (issue #961, slice B).
 *
 * Display only, exactly like the 2D band in `plasmaKerfBand.ts`: the geometry
 * comes from `plasmaKerfGeometry`, the width from `plasmaKerfWidth`, and the
 * world mapping is `toolpathPointToWorldTuple`'s `[x, z, y]` so the band and
 * the centre line sit on the same coordinates. Nothing here feeds toolpath
 * generation, G-code, the store or the `.camj` format.
 *
 * The band is a `LineSegments2` in **world units**, one kerf wide, drawn under
 * the centre line; the markers are a screen-space `THREE.Points` sprite whose
 * ring texture is built in code, so the module loads without a DOM (the tests
 * run it under `npx tsx`).
 *
 * The band materials write the **stencil buffer** so that every pixel of a band
 * is painted at most once. A `LineSegments2` is one quad per segment with round
 * caps, so where two quads overlap — every corner, and every place a long arc
 * is made of short segments — the alpha adds up and the overlap reads darker
 * than a straight run. The 2D band does not have the problem because one canvas
 * path is stroked once. Contour and lead bands use different stencil refs, so a
 * lead still shows in its own colour where it meets the contour, and two bands
 * of the same kind (the same operation's segments, or two operations) never add
 * up on each other. The pierce markers do not write the stencil: they are
 * screen-space sprites, not band pixels.
 */

import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import {
  PLASMA_KERF_BAND_ALPHA,
  PLASMA_PIERCE_MARKER_RADIUS_PX,
  type PlasmaKerfGeometry,
  type PlasmaKerfPoint,
  type PlasmaKerfSegment,
} from '../plasmaKerfPreview'
import {
  DEFAULT_TOOLPATH_LINE_SEGMENTS_PER_CHUNK,
  toolpathOverlayOpacity,
} from './toolpathOverlay'

/** Sprite edge of the pierce marker's ring texture, in texels. */
const PIERCE_RING_TEXTURE_SIZE = 64

/**
 * Stencil ref a contour band writes and then tests `NotEqual` against. One
 * constant per band kind keeps the two kinds from suppressing each other, and
 * keeps two bands of the same kind from adding up.
 */
export const PLASMA_KERF_CONTOUR_STENCIL_REF = 1

/** Stencil ref a lead band writes and then tests `NotEqual` against. */
export const PLASMA_KERF_LEAD_STENCIL_REF = 2

/**
 * Segment positions `[x, topZ, y]` for every segment's two endpoints, in the
 * world mapping of `toolpathPointToWorldTuple` (`[x, z, y]`). One `Float32Array`
 * of 6 floats per segment, which is what `LineSegmentsGeometry.setPositions`
 * consumes.
 */
export function plasmaKerfSegmentPositions(
  segments: readonly PlasmaKerfSegment[],
  topZ: number,
): Float32Array {
  const positions = new Float32Array(segments.length * 6)
  let offset = 0
  for (const segment of segments) {
    positions[offset] = segment.fromX
    positions[offset + 1] = topZ
    positions[offset + 2] = segment.fromY
    positions[offset + 3] = segment.toX
    positions[offset + 4] = topZ
    positions[offset + 5] = segment.toY
    offset += 6
  }
  return positions
}

/** Pierce positions `[x, topZ, y]`, one point per pierce. */
export function plasmaPiercePositions(
  pierces: readonly PlasmaKerfPoint[],
  topZ: number,
): Float32Array {
  const positions = new Float32Array(pierces.length * 3)
  let offset = 0
  for (const pierce of pierces) {
    positions[offset] = pierce.x
    positions[offset + 1] = topZ
    positions[offset + 2] = pierce.y
    offset += 3
  }
  return positions
}

/**
 * A ring with a filled centre dot, drawn in code as a white RGBA sprite. The
 * material's `color` tints it, so it can carry the plunge token like the 2D
 * marker does. White + a hard alpha shape means the tint is exact, and a fresh
 * texture per marker object keeps a disposal from taking another operation's
 * markers with it.
 */
function buildPierceMarkerTexture(): THREE.DataTexture {
  const size = PIERCE_RING_TEXTURE_SIZE
  const data = new Uint8Array(size * size * 4)
  const center = (size - 1) / 2
  // Normalised radius: 1 is the sprite's half-width, i.e. the marker radius.
  // The ring sits just inside the edge so its 1.5 px stroke is not clipped by
  // the sprite, which is sized `2 * radius` screen pixels.
  const ringRadius = 0.82
  const ringHalfWidth = 0.16
  const dotRadius = 0.25
  // One texel's worth of anti-aliasing, in the same normalised units.
  const feather = 2 / size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - center) / center
      const dy = (y - center) / center
      const distance = Math.hypot(dx, dy)
      const ringCoverage = 1 - Math.min(1, Math.abs(distance - ringRadius) / (ringHalfWidth + feather))
      const dotCoverage = 1 - Math.min(1, Math.max(0, distance - dotRadius) / feather)
      const alpha = Math.max(0, Math.min(1, Math.max(ringCoverage, dotCoverage)))
      const offset = (y * size + x) * 4
      data[offset] = 255
      data[offset + 1] = 255
      data[offset + 2] = 255
      data[offset + 3] = Math.round(alpha * 255)
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

export interface PlasmaKerfObjectOptions {
  width: number
  topZ: number
  cutColor: number
  leadColor: number
  emphasized: boolean
  muted: boolean
  resolution: THREE.Vector2
  showContour: boolean
  showLeads: boolean
  showPierces: boolean
}

/**
 * One kerf band: a world-unit `LineSegments2` per chunk, all sharing one
 * material, so a long contour costs one material and not one per chunk — the
 * same trade `buildToolpathOverlay` makes.
 */
function buildPlasmaKerfBand(
  segments: readonly PlasmaKerfSegment[],
  color: number,
  stencilRef: number,
  options: PlasmaKerfObjectOptions,
): THREE.Object3D[] {
  const material = new LineMaterial({
    color,
    linewidth: options.width,
    worldUnits: true,
    resolution: options.resolution,
    transparent: true,
    opacity: toolpathOverlayOpacity(0.98, options.emphasized, options.muted) * PLASMA_KERF_BAND_ALPHA,
    depthWrite: false,
    depthTest: false,
    // Paint each band pixel once: a fragment survives only while the stencil
    // does not already hold this band kind's ref, and the passing fragment
    // writes the ref so later overlaps of the same kind are discarded.
    stencilWrite: true,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilRef,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  })

  const chunkSize = Math.max(1, Math.floor(DEFAULT_TOOLPATH_LINE_SEGMENTS_PER_CHUNK))
  const objects: THREE.Object3D[] = []
  for (let start = 0; start < segments.length; start += chunkSize) {
    const chunk = segments.slice(start, start + chunkSize)
    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(plasmaKerfSegmentPositions(chunk, options.topZ))
    objects.push(new LineSegments2(geometry, material))
  }
  return objects
}

function buildPlasmaPierceMarkers(
  pierces: readonly PlasmaKerfPoint[],
  options: PlasmaKerfObjectOptions,
): THREE.Object3D {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(plasmaPiercePositions(pierces, options.topZ), 3))
  const material = new THREE.PointsMaterial({
    color: options.leadColor,
    // Screen pixels, never world units: a pierce marks a place, not a size.
    size: 2 * PLASMA_PIERCE_MARKER_RADIUS_PX,
    sizeAttenuation: false,
    map: buildPierceMarkerTexture(),
    transparent: true,
    opacity: toolpathOverlayOpacity(0.98, options.emphasized, options.muted),
    depthWrite: false,
    depthTest: false,
  })
  return new THREE.Points(geometry, material)
}

/**
 * The band and pierce marker objects for one plasma toolpath. Empty geometry,
 * or a part switched off through `show*`, returns nothing for that part — so a
 * hidden layer costs no scene object at all.
 */
export function buildPlasmaKerfObjects(
  geometry: PlasmaKerfGeometry,
  options: PlasmaKerfObjectOptions,
): THREE.Object3D[] {
  const objects: THREE.Object3D[] = []
  if (options.showContour && geometry.contour.length > 0) {
    objects.push(...buildPlasmaKerfBand(geometry.contour, options.cutColor, PLASMA_KERF_CONTOUR_STENCIL_REF, options))
  }
  if (options.showLeads && geometry.leads.length > 0) {
    objects.push(...buildPlasmaKerfBand(geometry.leads, options.leadColor, PLASMA_KERF_LEAD_STENCIL_REF, options))
  }
  if (options.showPierces && geometry.pierces.length > 0) {
    objects.push(buildPlasmaPierceMarkers(geometry.pierces, options))
  }
  return objects
}

/**
 * Dispose one material, its `map` included.
 *
 * The pierce texture is created per marker object, so it has to go with it; a
 * plain `material.dispose()` would leave the GPU copy behind until the context
 * is lost. Only `PointsMaterial` is checked for a map — the band materials
 * carry none — so this cannot dispose a texture another object still shares.
 */
export function disposePlasmaKerfMaterial(material: THREE.Material | THREE.Material[]): void {
  const materials = Array.isArray(material) ? material : [material]
  for (const entry of materials) {
    if (entry instanceof THREE.PointsMaterial && entry.map) {
      entry.map.dispose()
    }
    entry.dispose()
  }
}
