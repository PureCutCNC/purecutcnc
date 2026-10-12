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
 * Plasma kerf band and pierce markers as 3D scene objects (issue #961).
 *
 * Display only, exactly like the 2D band in `plasmaKerfBand.ts`: the geometry
 * comes from `plasmaKerfGeometry`, the width from `plasmaKerfWidth`, and the
 * world mapping is `toolpathPointToWorldTuple`'s `[x, z, y]` so the band and
 * the centre line sit on the same coordinates. Nothing here feeds toolpath
 * generation, G-code, the store or the `.camj` format.
 *
 * The band is a **flat triangle mesh lying in the sheet-top plane**, one kerf
 * wide. It used to be a world-unit `LineSegments2`, whose ribbon always turns
 * to face the camera: from a steep angle that reads as a flat band, but from a
 * low angle the ribbon stands up like a wall, half above and half below the
 * sheet top, and looks detached from the sheet. A mesh built from
 * `plasmaKerfBandPositions` is fixed in the plane of the sheet from every
 * angle, so it always looks painted on the top face.
 *
 * Each segment contributes one quad (two triangles) plus a round cap disc at
 * each endpoint, so the band has a single closed silhouette exactly one kerf
 * wide, caps included. The discs and quads overlap — every corner, and every
 * place a long arc is made of short segments — so the band materials still
 * write the **stencil buffer**: a fragment survives only while the stencil does
 * not already hold this band kind's ref, and a passing fragment writes the ref,
 * which keeps every band pixel painted at most once instead of adding up and
 * reading darker at an overlap. Contour and lead bands use different stencil
 * refs, so a lead still shows in its own colour where it meets the contour, and
 * two bands of the same kind (the same operation's segments, or two operations)
 * never add up on each other.
 *
 * The markers are a screen-space `THREE.Points` sprite whose ring texture is
 * built in code, so the module loads without a DOM (the tests run it under
 * `npx tsx`). A screen-space sprite is the right shape for a marker, unlike the
 * band. The pierce markers do not write the stencil: they are sprites, not band
 * pixels.
 */

import * as THREE from 'three'
import {
  PLASMA_KERF_BAND_ALPHA,
  PLASMA_PIERCE_MARKER_RADIUS_PX,
  type PlasmaKerfGeometry,
  type PlasmaKerfPoint,
  type PlasmaKerfSegment,
} from '../plasmaKerfPreview'
import { toolpathOverlayOpacity } from './toolpathOverlay'

/** Sprite edge of the pierce marker's ring texture, in texels. */
const PIERCE_RING_TEXTURE_SIZE = 64

/** Triangle-fan steps in each round kerf-band cap. */
const KERF_BAND_CAP_STEPS = 16

/**
 * Stencil ref a contour band writes and then tests `NotEqual` against. One
 * constant per band kind keeps the two kinds from suppressing each other, and
 * keeps two bands of the same kind from adding up.
 */
export const PLASMA_KERF_CONTOUR_STENCIL_REF = 1

/** Stencil ref a lead band writes and then tests `NotEqual` against. */
export const PLASMA_KERF_LEAD_STENCIL_REF = 2

/**
 * Non-indexed triangle positions for the kerf band, in the world mapping of
 * `toolpathPointToWorldTuple` (`[x, z, y]`), every vertex at exactly `topZ`.
 *
 * One quad (two triangles) per segment with non-zero length, its corners the
 * two endpoints offset by `+/- width / 2` along the segment's in-plane normal,
 * plus a round cap disc of radius `width / 2` at each endpoint as a triangle
 * fan. A zero-length segment contributes its disc only — the two endpoints
 * coincide, so one disc is the cap at both.
 */
export function plasmaKerfBandPositions(
  segments: readonly PlasmaKerfSegment[],
  width: number,
  topZ: number,
): Float32Array {
  const half = width / 2
  // The cap ring, shared by every cap: the fan triangles reuse it by offset.
  const ring: number[] = []
  for (let step = 0; step < KERF_BAND_CAP_STEPS; step += 1) {
    const angle = (step / KERF_BAND_CAP_STEPS) * Math.PI * 2
    ring.push(Math.cos(angle) * half, Math.sin(angle) * half)
  }

  const vertices: number[] = []
  const push = (x: number, y: number): void => {
    vertices.push(x, topZ, y)
  }
  const pushCap = (centerX: number, centerY: number): void => {
    for (let step = 0; step < KERF_BAND_CAP_STEPS; step += 1) {
      const next = (step + 1) % KERF_BAND_CAP_STEPS
      push(centerX, centerY)
      push(centerX + ring[step * 2], centerY + ring[step * 2 + 1])
      push(centerX + ring[next * 2], centerY + ring[next * 2 + 1])
    }
  }

  for (const segment of segments) {
    const dx = segment.toX - segment.fromX
    const dy = segment.toY - segment.fromY
    const length = Math.hypot(dx, dy)
    if (length > 0) {
      // In-plane normal of the segment, scaled to the half width.
      const normalX = (-dy / length) * half
      const normalY = (dx / length) * half
      push(segment.fromX + normalX, segment.fromY + normalY)
      push(segment.fromX - normalX, segment.fromY - normalY)
      push(segment.toX + normalX, segment.toY + normalY)
      push(segment.fromX - normalX, segment.fromY - normalY)
      push(segment.toX - normalX, segment.toY - normalY)
      push(segment.toX + normalX, segment.toY + normalY)
    }
    pushCap(segment.fromX, segment.fromY)
    if (length > 0) {
      pushCap(segment.toX, segment.toY)
    }
  }
  return new Float32Array(vertices)
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
  showContour: boolean
  showLeads: boolean
  showPierces: boolean
}

/**
 * One kerf band: a flat mesh in the sheet-top plane. The mesh owns its geometry
 * (nothing shares it), so `clearToolpathObjects` disposes it with the object;
 * `userData.plasmaKerfBand` marks it for that.
 */
function buildPlasmaKerfBand(
  segments: readonly PlasmaKerfSegment[],
  color: number,
  stencilRef: number,
  options: PlasmaKerfObjectOptions,
): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(
    plasmaKerfBandPositions(segments, options.width, options.topZ),
    3,
  ))
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: toolpathOverlayOpacity(0.98, options.emphasized, options.muted) * PLASMA_KERF_BAND_ALPHA,
    // The band is a zero-thickness sheet in the plane of the stock: from below,
    // or after an orbit past edge-on, the back face must paint too.
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    // Paint each band pixel once: a fragment survives only while the stencil
    // does not already hold this band kind's ref, and the passing fragment
    // writes the ref so overlapping caps and quads of the same kind are
    // discarded instead of adding their alpha up.
    stencilWrite: true,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilRef,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.userData.plasmaKerfBand = true
  return mesh
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
    objects.push(buildPlasmaKerfBand(geometry.contour, options.cutColor, PLASMA_KERF_CONTOUR_STENCIL_REF, options))
  }
  if (options.showLeads && geometry.leads.length > 0) {
    objects.push(buildPlasmaKerfBand(geometry.leads, options.leadColor, PLASMA_KERF_LEAD_STENCIL_REF, options))
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
