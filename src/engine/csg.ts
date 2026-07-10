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

import * as THREE from 'three'
import ManifoldModule, { type Manifold as ManifoldSolid, type ManifoldToplevel } from 'manifold-3d'
import { bezierPoint, rectProfile } from '../types/project'
import type { Clamp, DimensionRef, MachineOrigin, Project, SketchFeature, SketchProfile, Segment, Stock, Tab } from '../types/project'
import { expandFeatureGeometry, getFeatureGeometryProfiles } from '../text'
import { modelFeatures } from '../store/helpers/featureRoles'
import { loadPersistedBufferGeometryChunks, loadPersistedTriangleMesh } from './importedMesh'
import type { MeshSliceIndex } from './toolpaths/meshSlicing'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

const ARC_STEP_RADIANS = Math.PI / 18

/** Default 10° per arc segment — matches the 3D viewport tessellation. */
export const DEFAULT_ARC_STEP_RADIANS = ARC_STEP_RADIANS
/** Default 18 segments per bezier — derived from the default arc step. */
const DEFAULT_BEZIER_SEGMENTS = 18

let manifoldModulePromise: Promise<ManifoldToplevel> | null = null
let manifoldModuleInstance: ManifoldToplevel | null = null

/**
 * Returns the Manifold module synchronously if already loaded, or null if not yet initialized.
 * The module is loaded during the first viewport render, so by the time a user creates
 * a CAM operation it should always be available.
 */
export function getManifoldModuleSync(): ManifoldToplevel | null {
  return manifoldModuleInstance
}

function resolveDimension(ref: DimensionRef, project: Project): number {
  if (typeof ref === 'number') {
    return ref
  }

  const namedDimension = project.dimensions[ref]
  if (namedDimension) {
    return namedDimension.value
  }

  const parsed = Number.parseFloat(ref)
  return Number.isFinite(parsed) ? parsed : 0
}

export async function getManifoldModule(): Promise<ManifoldToplevel> {
  if (!manifoldModulePromise) {
    manifoldModulePromise = ManifoldModule().then((module) => {
      module.setup()
      manifoldModuleInstance = module
      return module
    }).catch((error) => {
      manifoldModulePromise = null
      manifoldModuleInstance = null
      throw error
    })
  }

  return manifoldModulePromise
}

// ── Profile → Three.js Shape ─────────────────────────────────────────────────

export function profileToShape(profile: SketchProfile): THREE.Shape {
  const shape = new THREE.Shape()
  shape.moveTo(profile.start.x, profile.start.y)

  for (const seg of profile.segments) {
    if (seg.type === 'line') {
      shape.lineTo(seg.to.x, seg.to.y)
    } else if (seg.type === 'bezier') {
      shape.bezierCurveTo(
        seg.control1.x,
        seg.control1.y,
        seg.control2.x,
        seg.control2.y,
        seg.to.x,
        seg.to.y,
      )
    } else {
      const { type, to, center, clockwise } = seg as Extract<Segment, { type: 'arc' | 'circle' }>
      const startAngle = Math.atan2(
        shape.currentPoint.y - center.y,
        shape.currentPoint.x - center.x
      )
      const endAngle = Math.atan2(to.y - center.y, to.x - center.x)
      const radius = Math.hypot(
        shape.currentPoint.x - center.x,
        shape.currentPoint.y - center.y
      )

      let sweep = endAngle - startAngle
      if (type === 'circle') {
        sweep = clockwise ? -Math.PI * 2 : Math.PI * 2
      } else {
        if (clockwise && sweep > 0) sweep -= Math.PI * 2
        else if (!clockwise && sweep < 0) sweep += Math.PI * 2
      }

      shape.absarc(center.x, center.y, radius, startAngle, startAngle + sweep, clockwise)
    }
  }

  if (profile.closed) {
    shape.closePath()
  }
  return shape
}

function profileToPolygon(
  profile: SketchProfile,
  arcStepRadians: number = ARC_STEP_RADIANS,
): [number, number][] {
  const points: [number, number][] = [[profile.start.x, profile.start.y]]
  let current = profile.start

  // Scale bezier subdivision the same way arcs scale, so curve quality is consistent.
  const bezierSegments = Math.max(
    8,
    Math.round(DEFAULT_BEZIER_SEGMENTS * (ARC_STEP_RADIANS / arcStepRadians)),
  )

  for (const seg of profile.segments) {
    if (seg.type === 'line') {
      points.push([seg.to.x, seg.to.y])
      current = seg.to
      continue
    }

    if (seg.type === 'bezier') {
      for (let index = 1; index <= bezierSegments; index += 1) {
        const point = bezierPoint(current, seg.control1, seg.control2, seg.to, index / bezierSegments)
        points.push([point.x, point.y])
      }
      current = seg.to
      continue
    }

    const { type, to, center, clockwise } = seg as Extract<Segment, { type: 'arc' | 'circle' }>
    const startAngle = Math.atan2(current.y - center.y, current.x - center.x)
    const endAngle = Math.atan2(to.y - center.y, to.x - center.x)
    const radius = Math.hypot(current.x - center.x, current.y - center.y)

    let sweep = endAngle - startAngle
    if (type === 'circle') {
      sweep = clockwise ? -Math.PI * 2 : Math.PI * 2
    } else {
      if (clockwise && sweep > 0) sweep -= Math.PI * 2
      else if (!clockwise && sweep < 0) sweep += Math.PI * 2
    }

    const segmentCount = Math.max(8, Math.ceil(Math.abs(sweep) / arcStepRadians))
    for (let index = 1; index <= segmentCount; index += 1) {
      const angle = startAngle + (sweep * index) / segmentCount
      points.push([
        center.x + Math.cos(angle) * radius,
        center.y + Math.sin(angle) * radius,
      ])
    }
    current = to
  }

  const first = points[0]
  const last = points.at(-1)
  if (last && Math.hypot(last[0] - first[0], last[1] - first[1]) < 1e-6) {
    points.pop()
  }

  return points
}


// ── Stock mesh ───────────────────────────────────────────────────────────────

export function buildStockMesh(stock: Stock): THREE.Mesh {
  const shape = profileToShape(stock.profile)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: stock.thickness,
    bevelEnabled: false,
  })
  // Rotate so Z is up (Three.js extrudes along Z by default, we want Y-up world)
  geometry.rotateX(-Math.PI / 2)

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(stock.color ?? '#8899aa'),
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.scale.z = -1
  return mesh
}

// ── Feature mesh ─────────────────────────────────────────────────────────────

/**
 * Build a hollow wall geometry for region features — semi-transparent walls
 * with no top or bottom faces, rendered as a thin box outline in 3D.
 */
function buildWallGeometry(shape: THREE.Shape, depth: number): THREE.BufferGeometry {
  const points = shape.getPoints()
  if (points.length < 2 || depth < 0.01) return new THREE.BufferGeometry()

  const positions: number[] = []
  const indices: number[] = []

  for (let i = 0; i < points.length; i++) {
    const next = (i + 1) % points.length
    const p0 = points[i]
    const p1 = points[next]
    const off = positions.length / 3

    // Two triangles per wall quad (bottom-left, bottom-right, top-left, top-right)
    positions.push(p0.x, p0.y, 0)
    positions.push(p1.x, p1.y, 0)
    positions.push(p0.x, p0.y, depth)
    positions.push(p1.x, p1.y, depth)

    // CCW winding for outward-facing normals (ExtrudeGeometry convention)
    indices.push(off, off + 2, off + 1)
    indices.push(off + 1, off + 2, off + 3)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export interface STLTransformedData {
  /** Transformed vertex positions (interleaved xyz). */
  positions: Float32Array
  /** Triangle index array. */
  index: Uint32Array
  /** Raw Z range information (before transform). */
  rawMinZ: number
  /** Mesh height after uniform scale. */
  meshHeight: number
  /** Lazily-created slice acceleration/caching data for CAM operations. */
  sliceIndex?: MeshSliceIndex
}

const STL_TRANSFORM_CACHE_LIMIT = 6

interface STLTransformedCacheEntry {
  positionsData: string
  indicesData: string
  data: STLTransformedData
}

const stlTransformedGeometryCache = new Map<string, STLTransformedCacheEntry>()

export function clearSTLTransformedGeometryCache(): void {
  stlTransformedGeometryCache.clear()
}

function featureModelAsset(project: Project, feature: SketchFeature) {
  const assetId = feature.stl?.meshAssetId
  return assetId ? project.modelAssets?.[assetId] ?? null : null
}

function stlTransformedGeometryCacheKey(
  feature: SketchFeature,
  project: Project,
): string {
  const stl = feature.stl
  const asset = featureModelAsset(project, feature)
  const zTop = resolveDimension(feature.z_top, project)
  const zBottom = resolveDimension(feature.z_bottom, project)
  return [
    feature.id,
    stl?.format ?? 'stl',
    stl?.axisSwap ?? 'none',
    stl?.scale ?? 1,
    feature.sketch.origin.x,
    feature.sketch.origin.y,
    feature.sketch.orientationAngle ?? 0,
    zTop,
    zBottom,
    stl?.meshAssetId ?? 'missing',
    asset?.storage ?? 'missing',
    asset?.sourceFormat ?? 'unknown',
    asset?.vertexCount ?? 0,
    asset?.triangleCount ?? 0,
    asset?.positions.length ?? 0,
    asset?.indices.length ?? 0,
  ].join('|')
}

function getCachedSTLTransformedGeometry(
  key: string,
  positionsData: string,
  indicesData: string,
): STLTransformedData | null {
  const entry = stlTransformedGeometryCache.get(key)
  if (!entry || entry.positionsData !== positionsData || entry.indicesData !== indicesData) {
    return null
  }

  // Refresh insertion order for a small LRU cache.
  stlTransformedGeometryCache.delete(key)
  stlTransformedGeometryCache.set(key, entry)
  return entry.data
}

function setCachedSTLTransformedGeometry(
  key: string,
  positionsData: string,
  indicesData: string,
  data: STLTransformedData,
): void {
  stlTransformedGeometryCache.set(key, { positionsData, indicesData, data })
  while (stlTransformedGeometryCache.size > STL_TRANSFORM_CACHE_LIMIT) {
    const oldestKey = stlTransformedGeometryCache.keys().next().value
    if (!oldestKey) break
    stlTransformedGeometryCache.delete(oldestKey)
  }
}

/**
 * Load an STL feature and apply all design-space transformations
 * (axis swap, scale, zScale, rotate, translate to origin).
 *
 * Does NOT apply render-only transforms (rotateX(-PI/2), scale.z = -1).
 * Returns the raw position/index data needed for mesh slicing.
 *
 * Shares the same transformation logic as buildFeatureMesh, so the 3D
 * preview matches the toolpath geometry.
 */
export function loadSTLTransformedGeometry(
  feature: SketchFeature,
  project: Project
): STLTransformedData | null {
  const asset = feature.kind === 'stl' ? featureModelAsset(project, feature) : null
  if (!asset) return null

  const cacheKey = stlTransformedGeometryCacheKey(feature, project)
  const cached = getCachedSTLTransformedGeometry(cacheKey, asset.positions, asset.indices)
  if (cached) return cached

  const sourceMesh = loadPersistedTriangleMesh(asset)
  if (!sourceMesh) return null
  const stl = feature.stl

  const rawPos = sourceMesh.positions
  const numVerts = rawPos.length / 3

  // Compute raw Z bounds
  const rawMinZ = sourceMesh.bounds.minZ
  const rawMaxZ = sourceMesh.bounds.maxZ

  const meshHeight = rawMaxZ - rawMinZ
  if (meshHeight < 0.001) return null

  // BuildFeatureSolid-style transformations (same as buildFeatureMesh)
  const scale = stl?.scale ?? 1
  const angleDeg = feature.sketch.orientationAngle ?? 0
  const zTop = resolveDimension(feature.z_top, project)
  const zBottom = resolveDimension(feature.z_bottom, project)
  const targetHeight = Math.max(0.1, Math.abs(zTop - zBottom))
  const zScale = targetHeight / ((meshHeight || 1) * scale)
  const angleRad = (angleDeg * Math.PI) / 180
  const cosA = Math.cos(angleRad)
  const sinA = Math.sin(angleRad)
  const originX = feature.sketch.origin.x
  const originY = feature.sketch.origin.y
  const bottomZ = Math.min(zTop, zBottom)

  // Apply transforms to vertex positions
  const positions = new Float32Array(rawPos.length)
  for (let i = 0; i < numVerts; i++) {
    const ix = i * 3
    const iy = i * 3 + 1
    const iz = i * 3 + 2

    // Uniform scale
    let x = rawPos[ix] * scale
    let y = rawPos[iy] * scale
    let z = rawPos[iz] * scale

    // Translate bottom to Z=0, then Z-only scale, then translate to target
    z -= rawMinZ * scale
    z *= zScale
    z += bottomZ

    // Rotate around Z
    const rx = x * cosA - y * sinA
    const ry = x * sinA + y * cosA
    x = rx
    y = ry

    // Translate to sketch origin
    x += originX
    y += originY

    positions[ix] = x
    positions[iy] = y
    positions[iz] = z
  }

  const index = new Uint32Array(sourceMesh.index)

  const data = { positions, index, rawMinZ: rawMinZ * scale, meshHeight: meshHeight * scale }
  setCachedSTLTransformedGeometry(cacheKey, asset.positions, asset.indices, data)
  return data
}

export function buildFeatureMesh(
  project: Project,
  feature: SketchFeature,
  selected = false,
  hovered = false,
  stockThickness?: number,
): THREE.Object3D {
  const asset = feature.kind === 'stl' ? featureModelAsset(project, feature) : null
  if (asset) {
    const stl = feature.stl
    const chunks = loadPersistedBufferGeometryChunks(asset, false)
    const material = new THREE.MeshStandardMaterial({
      color: selected ? 0xffaa00 : hovered ? 0x44aaff : 0xb7c2cf,
      roughness: 0.82,
      metalness: 0.05,
      side: THREE.DoubleSide,
    })
    if (!chunks || chunks.length === 0) {
      return new THREE.Mesh(new THREE.BufferGeometry(), material)
    }

    const userScale = stl?.scale ?? 1
    const angleRad = (feature.sketch.orientationAngle ?? 0) * (Math.PI / 180)

    // Resolve z dimensions (DimensionRef → number).
    // STL features always store numeric z values, but the type allows DimensionRef.
    const zTop = Number(feature.z_top) || 0
    const zBottom = Number(feature.z_bottom) || 0

    // Use the persisted mesh bounds directly — they're already in mesh-local
    // space, untransformed. Apply userScale to derive the post-uniform-scale
    // mesh height for the z-fit step. (Previously this was done via
    // geometry.computeBoundingBox() after baking userScale into the geometry.)
    const meshHeight = (asset.bounds.maxZ - asset.bounds.minZ) * userScale
    const targetHeight = Math.max(0.1, Math.abs(zTop - zBottom))
    const zScaleFactor = targetHeight / (meshHeight || 1)
    const minZAfterScale = asset.bounds.minZ * userScale

    // The original geometry-level transform sequence (applied in order):
    //   1. scale(userScale)              → uniform scale
    //   2. translate(0,0,-minZ)          → move bottom of mesh to z=0
    //   3. scale(1,1,zScaleFactor)       → stretch Z to targetHeight
    //   4. translate(0,0,min(zTop,zBot)) → move bottom to feature's bottom plane
    //   5. rotateZ(angleRad)
    //   6. translate(origin.x, origin.y, 0)
    //   7. rotateX(-π/2)                 → swap Y/Z for viewport convention
    //   8. mesh.scale.z = -1             → flip Z (final mesh-local axis flip)
    //
    // We reproduce that as an Object3D hierarchy so each chunk shares it
    // without baking transforms into per-chunk geometry. Read from outer (last
    // applied) to inner (first applied):
    //
    //   group (rotateX(-π/2), translate(origin), rotateZ(angleRad))
    //     └── inner (scale Z, translate -minZ*userScale, scale userScale, then
    //                translate by min(zTop,zBot) along Z BEFORE rotateX)
    //
    // The clearest way to assemble this without juggling matrices is two
    // nested groups: an inner that handles the mesh-local scale/translate, and
    // an outer that handles the world-space rotate/translate. We also fold
    // mesh.scale.z = -1 into the inner.

    // Inner Z transform reproduces steps 1–4 in mesh-local space:
    //   z' = (z * userScale - minZAfterScale) * zScaleFactor + min(zTop,zBot)
    // As an affine transform on (x,y,z): scale (userScale, userScale, userScale*zScaleFactor),
    // then translate (0, 0, -minZAfterScale * zScaleFactor + min(zTop,zBot)).
    const innerGroup = new THREE.Group()
    innerGroup.scale.set(userScale, userScale, userScale * zScaleFactor)
    innerGroup.position.set(0, 0, -minZAfterScale * zScaleFactor + Math.min(zTop, zBottom))
    for (const chunk of chunks) {
      innerGroup.add(new THREE.Mesh(chunk, material))
    }

    // Each subsequent step in the original sequence (5–7, then mesh.scale.z = -1)
    // is wrapped as its own group, outer = applied later. Three.js composes a
    // node's local transform as T * R * S; the inner group already uses both
    // scale and translation, so all subsequent ops use one transform per node
    // to avoid combined-order surprises.
    const rotateZGroup = new THREE.Group()
    rotateZGroup.rotation.z = angleRad
    rotateZGroup.add(innerGroup)

    const translateGroup = new THREE.Group()
    translateGroup.position.set(feature.sketch.origin.x, feature.sketch.origin.y, 0)
    translateGroup.add(rotateZGroup)

    const rotateXGroup = new THREE.Group()
    rotateXGroup.rotation.x = -Math.PI / 2
    rotateXGroup.add(translateGroup)

    // Outermost — the equivalent of the original `mesh.scale.z = -1` applied
    // AFTER the geometry's rotateX, so this must live in its own group.
    const scaleZGroup = new THREE.Group()
    scaleZGroup.scale.z = -1
    scaleZGroup.add(rotateXGroup)

    return scaleZGroup
  }

  // Line features are flat path geometry rendered as line overlays — never extrude.
  if (feature.operation === 'line') {
    return new THREE.Group()
  }

  const shape = profileToShape(feature.sketch.profile)
  const isRegion = feature.operation === 'region'
  const zTop = isRegion
    ? stockThickness ?? (typeof feature.z_top === 'number' ? feature.z_top : 0)
    : typeof feature.z_top === 'number' ? feature.z_top : 0
  const zBottom = isRegion
    ? 0
    : typeof feature.z_bottom === 'number' ? feature.z_bottom : 5
  const yStart = Math.min(zTop, zBottom)
  const depth = Math.abs(zBottom - zTop)

  const geometry = isRegion
    ? buildWallGeometry(shape, Math.max(depth, 0.1))
    : new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(depth, 0.1),
        bevelEnabled: false,
      })

  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, yStart, 0)

  const color =
    selected ? 0xffaa00
    : hovered ? 0x44aaff
    : isRegion ? 0x9966cc
    : feature.operation === 'subtract' ? 0x3366cc
    : 0x33aa66

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.78,
    metalness: 0.08,
    side: isRegion ? THREE.DoubleSide : THREE.FrontSide,
    ...(isRegion && {
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  })

  const mesh = new THREE.Mesh(geometry, material)
  if (isRegion) mesh.renderOrder = 1
  mesh.scale.z = -1
  return mesh
}

/**
 * Update a clamp mesh's highlight to reflect selection/collision state.
 *
 * Selection and collision only change the fixture's color + opacity, never its
 * geometry, so this is a cheap recolor that can run without rebuilding the CSG
 * model (issue #261). `buildClampMesh` calls it for the initial appearance and
 * Viewport3D calls it again on selection/collision changes.
 */
export function applyClampHighlight(mesh: THREE.Mesh, selected: boolean, colliding: boolean): void {
  const material = mesh.material
  if (!(material instanceof THREE.MeshStandardMaterial)) return
  material.color.set(
    colliding
      ? (selected ? '#ff9c9c' : '#d46b6b')
      : (selected ? '#9db9ff' : '#6c89d1'),
  )
  material.opacity = colliding ? (selected ? 0.8 : 0.68) : (selected ? 0.72 : 0.58)
}

/** Update a tab mesh's highlight to reflect selection state (see {@link applyClampHighlight}). */
export function applyTabHighlight(mesh: THREE.Mesh, selected: boolean): void {
  const material = mesh.material
  if (!(material instanceof THREE.MeshStandardMaterial)) return
  material.color.set(selected ? '#c7ef94' : '#9ccd67')
  material.opacity = selected ? 0.72 : 0.56
}

export function buildClampMesh(clamp: Clamp, selected = false, colliding = false): THREE.Mesh {
  const shape = profileToShape(rectProfile(clamp.x, clamp.y, clamp.w, clamp.h))
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(clamp.height, 0.1),
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)

  const material = new THREE.MeshStandardMaterial({
    transparent: true,
    roughness: 0.72,
    metalness: 0.08,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  applyClampHighlight(mesh, selected, colliding)
  mesh.scale.z = -1
  return mesh
}

export function buildTabMesh(tab: Tab, selected = false): THREE.Mesh {
  const shape = profileToShape(rectProfile(tab.x, tab.y, tab.w, tab.h))
  const zStart = Math.min(tab.z_top, tab.z_bottom)
  const depth = Math.max(Math.abs(tab.z_top - tab.z_bottom), 0.1)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, zStart, 0)

  const material = new THREE.MeshStandardMaterial({
    transparent: true,
    roughness: 0.74,
    metalness: 0.06,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  applyTabHighlight(mesh, selected)
  mesh.scale.z = -1
  return mesh
}

export function buildOriginTriad(origin: MachineOrigin, size: number): THREE.Group {
  const group = new THREE.Group()
  group.position.set(origin.x, origin.z, origin.y)

  const axisData = [
    { direction: new THREE.Vector3(1, 0, 0), color: 0xe35b5b },
    { direction: new THREE.Vector3(0, 0, -1), color: 0x63c07a },
    { direction: new THREE.Vector3(0, 1, 0), color: 0x5b90e3 },
  ]
  const shaftRadius = Math.max(size * 0.025, 0.005)
  const tipRadius = Math.max(size * 0.055, shaftRadius * 1.5)
  const tipLength = Math.max(size * 0.18, shaftRadius * 4)
  const shaftLength = Math.max(size - tipLength, size * 0.55)

  for (const axis of axisData) {
    const material = new THREE.MeshStandardMaterial({
      color: axis.color,
      roughness: 0.38,
      metalness: 0.08,
      transparent: true,
      opacity: 0.98,
    })

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 12),
      material.clone(),
    )
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(tipRadius, tipLength, 12),
      material.clone(),
    )

    // The cylinder and cone are Y-aligned by default.
    // We rotate them to align with the axis direction.
    const direction = axis.direction.clone().normalize()
    const up = new THREE.Vector3(0, 1, 0)
    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction)

    shaft.quaternion.copy(quaternion)
    tip.quaternion.copy(quaternion)

    shaft.position.copy(direction).multiplyScalar(shaftLength / 2)
    tip.position.copy(direction).multiplyScalar(shaftLength + tipLength / 2)

    group.add(shaft)
    group.add(tip)
  }

  const centerGeometry = new THREE.SphereGeometry(Math.max(size * 0.1, shaftRadius * 1.2), 14, 14)
  const centerMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6edf5,
    roughness: 0.4,
    metalness: 0.1,
  })
  group.add(new THREE.Mesh(centerGeometry, centerMaterial))

  return group
}

function manifoldMeshToGeometry(mesh: import('manifold-3d').Mesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array(mesh.numVert * 3)

  for (let index = 0; index < mesh.numVert; index += 1) {
    const sourceOffset = index * mesh.numProp
    const targetOffset = index * 3
    positions[targetOffset] = mesh.vertProperties[sourceOffset]
    positions[targetOffset + 1] = mesh.vertProperties[sourceOffset + 1]
    positions[targetOffset + 2] = mesh.vertProperties[sourceOffset + 2]
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(Array.from(mesh.triVerts))

  const nonIndexed = geometry.toNonIndexed()
  geometry.dispose()
  nonIndexed.computeVertexNormals()
  nonIndexed.rotateX(-Math.PI / 2)
  nonIndexed.computeBoundingSphere()

  return nonIndexed
}

export function buildFeatureSolid(
  module: ManifoldToplevel,
  project: Project,
  feature: SketchFeature,
  arcStepRadians: number = ARC_STEP_RADIANS,
): ManifoldSolid | null {
  const asset = feature.kind === 'stl' ? featureModelAsset(project, feature) : null
  if (asset) {
    try {
      const mesh = loadPersistedTriangleMesh(asset)
      if (!mesh) return null
      const stl = feature.stl
      
      const manifoldMesh = new module.Mesh({
        numProp: 3,
        vertProperties: new Float32Array(mesh.positions),
        triVerts: new Uint32Array(mesh.index),
        halfedgeTangent: new Float32Array(0),
        runIndex: new Uint32Array([0]),
        runOriginalID: new Uint32Array([0]),
        runTransform: new Float32Array(12).fill(0),
        faceID: new Uint32Array(mesh.index.length / 3).fill(0),
      })
      
      const solid = new module.Manifold(manifoldMesh)
      const scale = stl?.scale ?? 1
      const angleDeg = feature.sketch.orientationAngle ?? 0
      
      // Resolve z dimensions (DimensionRef → number)
      const zTop = resolveDimension(feature.z_top, project)
      const zBottom = resolveDimension(feature.z_bottom, project)
      
      // Compute vertical scale and translation to match z_bottom/z_top
      const bbox = solid.boundingBox()
      const meshHeight = bbox.max[2] - bbox.min[2]
      const targetHeight = Math.max(0.1, Math.abs(zTop - zBottom))
      // bbox is computed BEFORE uniform scale, so meshHeight = originalHeight.
      // After .scale([scale, scale, scale]), height = originalHeight * scale.
      // We want final height = targetHeight, so zScale = targetHeight / (originalHeight * scale).
      const zScale = targetHeight / ((meshHeight || 1) * scale)

      return solid
        .scale([scale, scale, scale]) // Apply uniform scale first
        .translate([0, 0, -bbox.min[2] * scale]) // Move to 0 (accounting for uniform scale)
        .scale([1, 1, zScale]) // Scale Z to match target height
        .translate([0, 0, Math.min(zTop, zBottom)]) // Move to target bottom
        .rotate(0, 0, angleDeg)
        .translate(feature.sketch.origin.x, feature.sketch.origin.y, 0)
    } catch (error) {
      console.warn('STL is non-manifold, falling back to 2.5D silhouette extrusion for boolean model.', error)
      
      // Treat as a 2.5D composite feature by extruding the silhouette.
      // This allows non-manifold STLs to participate in boolean operations (like pockets/cuts)
      // based on their footprint.
      const contour = profileToPolygon(feature.sketch.profile, arcStepRadians)
      if (contour.length < 3) {
        return null
      }

      const zTop = resolveDimension(feature.z_top, project)
      const zBottom = resolveDimension(feature.z_bottom, project)
      const yStart = Math.min(zTop, zBottom)
      const depth = Math.max(Math.abs(zBottom - zTop), 0.1)

      const crossSection = module.CrossSection.ofPolygons([contour], 'EvenOdd')
      try {
        return crossSection.extrude(depth).translate(0, 0, yStart)
      } finally {
        crossSection.delete()
      }
    }
  }

  if (!feature.sketch.profile.closed || feature.operation === 'line') {
    return null
  }

  const contour = profileToPolygon(feature.sketch.profile, arcStepRadians)
  if (contour.length < 3) {
    return null
  }

  const zTop = resolveDimension(feature.z_top, project)
  const zBottom = resolveDimension(feature.z_bottom, project)
  const yStart = Math.min(zTop, zBottom)
  const depth = Math.max(Math.abs(zBottom - zTop), 0.1)

  const crossSection = module.CrossSection.ofPolygons([contour], 'EvenOdd')
  try {
    return crossSection.extrude(depth).translate(0, 0, yStart)
  } finally {
    crossSection.delete()
  }
}

async function buildBooleanModel(
  project: Project,
  visibleFeatures: SketchFeature[]
): Promise<THREE.Mesh | null> {
  const module = await getManifoldModule()
  let current: ManifoldSolid | null = null
  const expandedFeatures = visibleFeatures.flatMap((feature) => expandFeatureGeometry(feature, false))

  try {
    for (const feature of expandedFeatures) {
      let solid: ManifoldSolid | null = null

      try {
        solid = buildFeatureSolid(module, project, feature)
        if (!solid) {
          continue
        }

        // For STL 'add' operations, we skip including them in the boolean model
        // because we render the high-resolution mesh as an overlay. This prevents
        // non-manifold STLs from showing their blocky 2.5D fallback extrusion
        // while still allowing 'subtract' STLs to cut holes in the stock.
        if (feature.operation === 'model' || feature.operation === 'region' || feature.operation === 'line') {
          continue
        }

        if (!current) {
          if (feature.operation === 'add') {
            current = solid
            solid = null
          }
          continue
        }

        const next = feature.operation === 'subtract'
          ? module.Manifold.difference(current, solid)
          : module.Manifold.union(current, solid)

        current.delete()
        current = next
      } finally {
        solid?.delete()
      }
    }

    if (!current) {
      return null
    }

    const manifoldMesh = current.getMesh()
    const geometry = manifoldMeshToGeometry(manifoldMesh)
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#b7c2cf'),
      roughness: 0.82,
      metalness: 0.05,
      flatShading: true,
      side: THREE.FrontSide,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.scale.z = -1
    return mesh
  } finally {
    current?.delete()
  }
}

// ── Wireframe outline for stock ──────────────────────────────────────────────

export function buildStockWireframe(stock: Stock): THREE.LineSegments {
  const shape = profileToShape(stock.profile)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: stock.thickness,
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)
  const edges = new THREE.EdgesGeometry(geometry)
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(stock.color ?? '#aabbcc'),
    linewidth: 1,
  })
  const lines = new THREE.LineSegments(edges, material)
  lines.scale.z = -1
  return lines
}

// ── Line rendering helpers ──────────────────────────────────────────

/**
 * Prepare a 2D polygon for Line2 rendering. Open profiles return the
 * polygon unchanged; closed profiles append the first point so Line2
 * draws the closing edge (Line2 does not implicitly close strips).
 *
 * Pure helper — exported for direct value-level testing.
 */
export function closeLinePolygonIfNeeded(
  polygon: [number, number][],
  shouldClose: boolean,
): [number, number][] {
  if (!shouldClose || polygon.length === 0) return polygon
  const result = polygon.slice()
  result.push([...polygon[0]])
  return result
}

// ── Open feature (polyline) line builder ────────────────────────────

export function buildOpenFeatureLine(
  project: Project,
  feature: SketchFeature,
  selected = false,
  hovered = false,
): Line2 {
  const profile = feature.sketch.profile
  const zTop = resolveDimension(feature.z_top, project)

  // Subdivide the profile into polyline points (handles arcs, beziers).
  // profileToPolygon removes the duplicate final point for solid-polygon use;
  // for closed Line profiles we must append the first point so Line2 draws
  // the closing edge (Line2 does not implicitly close strips).
  const rawPolygon = profileToPolygon(profile)
  const polygon = closeLinePolygonIfNeeded(
    rawPolygon,
    profile.closed && feature.operation === 'line',
  )

  // Build positions in world space, applying the same transform pipeline as other geometry:
  //   rotateX(-PI/2): (x, y, 0) → (x, 0, -y)
  //   translate(0, zTop, 0): (x, 0, -y) → (x, zTop, -y)
  //   scale.z = -1 (Object3D): (x, zTop, -y) → (x, zTop, y)
  // Since Line2 bakes transforms into geometry, we produce the final world position directly.
  const positions: number[] = []
  for (const [px, py] of polygon) {
    positions.push(px, zTop, py)
  }

  const geometry = new LineGeometry()
  geometry.setPositions(positions)

  const color =
    selected ? 0xffaa00
    : hovered ? 0x44aaff
    : feature.operation === 'subtract' ? 0x3366cc
    : 0x33aa66

  // Use LineMaterial with screen-pixel linewidth for consistent visibility
  const material = new LineMaterial({
    color,
    linewidth: 4,
    worldUnits: false,
    resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
  })

  const line = new Line2(geometry, material)
  line.computeLineDistances()

  return line
}

// ── Full scene builder ───────────────────────────────────────────────────────

export interface SceneObjects {
  stockMesh: THREE.Mesh
  stockWireframe: THREE.LineSegments
  modelMesh: THREE.Mesh | null
  featureMeshes: Map<string, THREE.Object3D>
  openFeatureLines: Map<string, THREE.Object3D>
  tabMeshes: Map<string, THREE.Mesh>
  clampMeshes: Map<string, THREE.Mesh>
}

export async function buildScene(project: Project): Promise<SceneObjects> {
  // Construction geometry is sketch-only — it never reaches the 3D model,
  // feature meshes, or open-feature lines (issue #199). Regions stay: they
  // render display-only walls below.
  //
  // Fixtures are built unhighlighted: selection/collision only tint the clamp
  // and tab meshes, which Viewport3D recolors via applyClampHighlight /
  // applyTabHighlight without rebuilding this (expensive) CSG model (issue #261).
  const visibleFeatures = modelFeatures(project.features).filter((feature) => feature.visible)
  const visibleTabs = project.tabs.filter((tab) => tab.visible)
  const visibleClamps = project.clamps.filter((clamp) => clamp.visible)
  const stockMesh = buildStockMesh(project.stock)
  const stockWireframe = buildStockWireframe(project.stock)
  const featureMeshes = new Map<string, THREE.Object3D>()
  const openFeatureLines = new Map<string, THREE.Object3D>()
  const tabMeshes = new Map<string, THREE.Mesh>()
  const clampMeshes = new Map<string, THREE.Mesh>()
  let modelMesh: THREE.Mesh | null = null

  if (visibleFeatures.length > 0) {
    try {
      modelMesh = await buildBooleanModel(project, visibleFeatures)
    } catch (error) {
      console.error('Failed to build boolean 3D preview, falling back to feature meshes.', error)
    }

    // Always include STL meshes for visual detail, even if boolean model succeeded.
    // This ensures non-manifold STLs show their real mesh instead of just the 2.5D extrusion fallback.
    // Region features also get their own mesh since they are visual-only (not part of boolean model).
    for (const feature of visibleFeatures) {
      if (feature.kind === 'stl' || feature.operation === 'region') {
        featureMeshes.set(feature.id, buildFeatureMesh(project, feature, false, false, project.stock.thickness))
      }
      
      // If buildBooleanModel failed, we need the rest of the meshes too.
      // Open features (polylines) are skipped — they're rendered as lines via buildOpenFeatureLine.
      if (!modelMesh) {
        for (const expanded of expandFeatureGeometry(feature)) {
          if (expanded.kind !== 'stl' && expanded.operation !== 'region') {
            if (!expanded.sketch.profile.closed || expanded.operation === 'line') continue
            featureMeshes.set(expanded.id, buildFeatureMesh(project, expanded, false, false, project.stock.thickness))
          }
        }
      }
    }

    // Build line representations for open features (polylines, skeleton text, etc.)
    // and closed Line features — both appear as flat 3D line overlays and never
    // contribute to the solid model.
    for (const feature of visibleFeatures) {
      // Check all geometry profiles (text features may have multiple)
      const profiles = getFeatureGeometryProfiles(feature)
      if (profiles.some((p) => !p.closed) || feature.operation === 'line') {
        openFeatureLines.set(feature.id, buildOpenFeatureLine(project, feature))
      }
    }
  }

  const showStockReference = project.stock.visible ?? true

  stockMesh.visible = showStockReference
  stockWireframe.visible = showStockReference

  for (const tab of visibleTabs) {
    tabMeshes.set(tab.id, buildTabMesh(tab))
  }

  for (const clamp of visibleClamps) {
    clampMeshes.set(clamp.id, buildClampMesh(clamp))
  }

  return { stockMesh, stockWireframe, modelMesh, featureMeshes, openFeatureLines, tabMeshes, clampMeshes }
}
