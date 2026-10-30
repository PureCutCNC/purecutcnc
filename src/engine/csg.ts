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
import { buildChuckGeometry } from './chuckGeometry'
import ManifoldModule, { type Manifold as ManifoldSolid, type ManifoldToplevel } from 'manifold-3d'
import { getStockBounds, isRoundStock, rectProfile, roundStockCentre, roundStockDiameter, roundStockLength } from '../types/project'
import { barCentre, barPivotZ, isBarStock } from '../types/barStock'
import type { BarStock, Clamp, DimensionRef, MachineOrigin, Matrix2D, Project, RoundStock, SketchFeature, SketchProfile, Segment, SquareStock, Stock, Tab } from '../types/project'
import { expandFeatureGeometry } from '../text'
import { cannedShapeIsModel } from '../cannedShapes'
import { modelFeatures } from '../store/helpers/featureRoles'
import { aroundFeaturesActive, barSeedsModel } from '../store/helpers/projectType'
import { resolvedProjectFeatures } from '../store/helpers/resolveFeatures'
import { loadPersistedBufferGeometryChunks, loadPersistedTriangleMesh, orientImportedMesh } from './importedMesh'
import {
  importedModelInstanceTransform,
  importedModelMatrix4,
  importedModelTransformKey,
  isIdentityModelOrientation,
  isModelTurnedOver,
  modelOrientationKey,
  modelOrientationAroundBoundsMatrix4,
  transformImportedModelPoint,
} from './importedModelTransform'
import type { MeshSliceIndex } from './toolpaths/meshSlicing'
import { expandedClampBounds, worstCaseClampCheckToolRadius, type ExpandedClampBounds } from './toolpaths/clamps'
import { buildBatchedLines, type BatchLineMeta } from './lineBatcher'
import type { ThreeThemePalette } from '../theme/palette'
import { convertLength, type Units } from '../utils/units'
import { profileToPolygon } from './profilePolyline'
import { buildAroundFeatureSolid, type AroundSlabOptions } from './aroundFeatureSolid'

export { closeLinePolygonIfNeeded, profileToPolygon } from './profilePolyline'
import { DEFAULT_ARC_STEP_RADIANS } from './profilePolyline'

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

/** 0.01 mm, the smallest height the 3D view needs to keep a shape drawable. */
const MIN_RENDER_HEIGHT_MM = 0.01

/**
 * The smallest height the 3D view draws for a feature, wall, clamp or imported
 * model, in the project's own units.
 *
 * This exists only so a zero-height shape still produces drawable geometry. It
 * must never inflate a height the user entered: a bare `0.1` is 0.1 in in an
 * inch project — thicker than a 0.0625 in feature's stock — which is issue
 * #1009. 0.01 mm is ~0.0004 in, far below any height a person draws.
 */
export function minRenderHeight(units: Units): number {
  return convertLength(MIN_RENDER_HEIGHT_MM, 'mm', units)
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

// ── Stock mesh ───────────────────────────────────────────────────────────────

/** Chords around a round bar — 64 reads as round without a visible facet. */
const ROUND_BAR_SEGMENTS = 64

/**
 * A round bar's cylinder in project coordinates: `diameter` across, lying along
 * `axis` on the centreline, centred at Z = diameter / 2. The bar occupies Z from
 * 0 to the diameter, so that is the centreline (#392).
 *
 * Exported so `csgAroundFace.test.ts` can assert the boolean model's bar solid
 * (`roundBarSolid`) samples its circle at these very vertices (issue #395 G3).
 * Its positions are compared exactly by `csgRoundStock.test.ts`, so its own
 * output must not change.
 */
export function roundBarGeometry(stock: RoundStock): THREE.CylinderGeometry {
  const diameter = roundStockDiameter(stock)
  const bounds = getStockBounds(stock)
  const centre = roundStockCentre(stock)
  const geometry = new THREE.CylinderGeometry(
    diameter / 2,
    diameter / 2,
    roundStockLength(stock),
    ROUND_BAR_SEGMENTS,
  )
  // CylinderGeometry is Y-aligned. Axis 'y' is already right; axis 'x' turns it
  // onto X. Both then move to the bar's centre on the centreline.
  if (stock.axis === 'x') {
    geometry.rotateZ(-Math.PI / 2)
    geometry.translate((bounds.minX + bounds.maxX) / 2, centre, diameter / 2)
  } else {
    geometry.translate(centre, (bounds.minY + bounds.maxY) / 2, diameter / 2)
  }
  return geometry
}

export function buildStockMesh(stock: Stock, threePalette: ThreeThemePalette): THREE.Mesh {
  let geometry: THREE.BufferGeometry
  if (isRoundStock(stock)) {
    geometry = roundBarGeometry(stock)
  } else {
    const shape = profileToShape(stock.profile)
    geometry = new THREE.ExtrudeGeometry(shape, {
      depth: stock.thickness,
      bevelEnabled: false,
    })
  }
  // Rotate so Z is up (Three.js extrudes along Z by default, we want Y-up world)
  geometry.rotateX(-Math.PI / 2)

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(stock.color ?? threePalette.stockMeshFallback),
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
  // The caller floors `depth` at minRenderHeight(units), so a zero-height
  // region arrives here at the guard height and must still draw. A unit-blind
  // `0.01` here discarded that guard in an inch project (issue #1009).
  if (points.length < 2 || depth <= 0) return new THREE.BufferGeometry()

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

/**
 * The transformed-mesh path only needs the model identity, its resolved
 * placement and its Z range.  Keeping that boundary structural lets CAM read
 * a resolved feature instance without falling back to definition-local data.
 */
type STLTransformFeature = Pick<SketchFeature, 'id' | 'kind' | 'stl' | 'z_top' | 'z_bottom' | 'authoringFace'> & {
  transform?: Matrix2D
}

export function clearSTLTransformedGeometryCache(): void {
  stlTransformedGeometryCache.clear()
}

function featureModelAsset(project: Project, feature: STLTransformFeature) {
  const assetId = feature.stl?.meshAssetId
  return assetId ? project.modelAssets?.[assetId] ?? null : null
}

function stlTransformedGeometryCacheKey(
  feature: STLTransformFeature,
  project: Project,
): string {
  const stl = feature.stl
  const asset = featureModelAsset(project, feature)
  const zTop = resolveDimension(feature.z_top, project)
  const zBottom = resolveDimension(feature.z_bottom, project)
  const transform = importedModelInstanceTransform(feature)
  return [
    feature.id,
    stl?.format ?? 'stl',
    stl?.axisSwap ?? 'none',
    // Post-import 3D orientation changes every vertex, so omitting it here
    // would serve stale, un-rotated geometry to CAM and export (issue #241).
    modelOrientationKey(stl?.orientation),
    stl?.scale ?? 1,
    importedModelTransformKey(transform),
    // The same model turned over is other geometry at the same placement.
    isModelTurnedOver(stl) ? 'turned-over' : 'as-placed',
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
  feature: STLTransformFeature,
  project: Project
): STLTransformedData | null {
  if (feature.authoringFace === 'around') return null
  const asset = feature.kind === 'stl' ? featureModelAsset(project, feature) : null
  if (!asset) return null

  const cacheKey = stlTransformedGeometryCacheKey(feature, project)
  const cached = getCachedSTLTransformedGeometry(cacheKey, asset.positions, asset.indices)
  if (cached) return cached

  const persistedMesh = loadPersistedTriangleMesh(asset)
  if (!persistedMesh) return null
  const stl = feature.stl

  // Post-import 3D orientation is a rigid rotation of the definition-local
  // mesh, applied before scale and the Z fit. Bounds come from the rotated
  // mesh, so the Z fit below stretches to the rotated height and the model
  // keeps its true aspect ratio (issue #241).
  const sourceMesh = orientImportedMesh(persistedMesh, stl?.orientation, stl?.meshAssetId)

  const rawPos = sourceMesh.positions
  const numVerts = rawPos.length / 3

  // Compute raw Z bounds
  const rawMinZ = sourceMesh.bounds.minZ
  const rawMaxZ = sourceMesh.bounds.maxZ

  const meshHeight = rawMaxZ - rawMinZ
  if (meshHeight < 0.001) return null

  // BuildFeatureSolid-style transformations (same as buildFeatureMesh)
  const scale = stl?.scale ?? 1
  const transform = importedModelInstanceTransform(feature)
  const zTop = resolveDimension(feature.z_top, project)
  const zBottom = resolveDimension(feature.z_bottom, project)
  const targetHeight = Math.max(minRenderHeight(project.meta.units), Math.abs(zTop - zBottom))
  const zScale = targetHeight / ((meshHeight || 1) * scale)
  const bottomZ = Math.min(zTop, zBottom)
  // A model in a project turned into a Bottom setup's frame (issue #946): its
  // transform already mirrors it in plan and its span is already reflected,
  // so reflecting the mesh inside that span completes the half turn — the
  // model's back face is the one the cutter now meets.
  const turnedOver = isModelTurnedOver(stl)
  const spanSum = zTop + zBottom

  // Apply transforms to vertex positions
  const positions = new Float32Array(rawPos.length)
  for (let i = 0; i < numVerts; i++) {
    const ix = i * 3
    const iy = i * 3 + 1
    const iz = i * 3 + 2

    // Uniform scale
    const xy = transformImportedModelPoint(transform, rawPos[ix] * scale, rawPos[iy] * scale)
    let z = rawPos[iz] * scale

    // Translate bottom to Z=0, then Z-only scale, then translate to target
    z -= rawMinZ * scale
    z *= zScale
    z += bottomZ

    positions[ix] = xy.x
    positions[iy] = xy.y
    positions[iz] = turnedOver ? spanSum - z : z
  }

  const index = new Uint32Array(sourceMesh.index)

  const data = { positions, index, rawMinZ: rawMinZ * scale, meshHeight: meshHeight * scale }
  setCachedSTLTransformedGeometry(cacheKey, asset.positions, asset.indices, data)
  return data
}

/** The neutral colour a feature mesh is built in, before selection or hover. */
function featureMeshBaseColor(feature: SketchFeature, isRegion: boolean, threePalette?: ThreeThemePalette): number {
  return isRegion
    ? (threePalette?.meshFeatureRegion ?? 0x9966cc) // theme-exempt: dark fallback
    : feature.operation === 'subtract'
      ? (threePalette?.meshFeatureSubtract ?? 0x3366cc) // theme-exempt: dark fallback
      : (threePalette?.meshFeatureAdd ?? 0x33aa66) // theme-exempt: dark fallback
}

/**
 * Materials remember the colour they were built with, so clearing a highlight
 * restores the built appearance exactly instead of guessing it back from the
 * feature (which cannot tell an imported mesh from an extrusion, issue #1112 F5).
 */
interface FeatureMaterialUserData {
  featureBaseColor?: number
}

function markFeatureBaseColor(material: THREE.Material, color: number): void {
  (material.userData as FeatureMaterialUserData).featureBaseColor = color
}

export function buildFeatureMesh(
  project: Project,
  feature: SketchFeature,
  selected = false,
  hovered = false,
  stockThickness?: number,
  threePalette?: ThreeThemePalette,
): THREE.Object3D {
  const asset = feature.kind === 'stl' ? featureModelAsset(project, feature) : null
  if (asset) {
    const stl = feature.stl
    const chunks = loadPersistedBufferGeometryChunks(asset, false)
    const baseColor = threePalette?.meshFeatureDefault ?? 0xb7c2cf // theme-exempt: dark fallback
    const material = new THREE.MeshStandardMaterial({
      color: selected
        ? (threePalette?.meshFeatureSelected ?? 0xffaa00) // theme-exempt: dark fallback
        : hovered
          ? (threePalette?.meshFeatureHovered ?? 0x44aaff) // theme-exempt: dark fallback
          : baseColor,
      roughness: 0.82,
      metalness: 0.05,
      side: THREE.DoubleSide,
      // A canned model's surface is also the bar model's surface: the bar fold
      // turns the stock down to this very mesh (#1112 rt4-c item 36), so the two
      // are coincident and their faces would flicker against each other. Pull
      // the model's faces a hair forward, like an Around region's display-only
      // slab, so the selection/hover tint this mesh carries stays visible. This
      // mesh is only the uncut model's drawing — once the fold cuts into the
      // model, `buildFoldedModelMeshes` draws the cut from the fold instead.
      ...(cannedShapeIsModel(feature.canned)
        ? { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }
        : {}),
    })
    markFeatureBaseColor(material, baseColor)
    if (!chunks || chunks.length === 0) {
      return new THREE.Mesh(new THREE.BufferGeometry(), material)
    }

    const userScale = stl?.scale ?? 1
    const transform = importedModelInstanceTransform(feature)
    const orientation = stl?.orientation
    const oriented = !isIdentityModelOrientation(orientation)

    // Resolve z dimensions (DimensionRef → number).
    // STL features always store numeric z values, but the type allows DimensionRef.
    const zTop = Number(feature.z_top) || 0
    const zBottom = Number(feature.z_bottom) || 0

    // Use the persisted mesh bounds directly — they're already in mesh-local
    // space, untransformed. Apply userScale to derive the post-uniform-scale
    // mesh height for the z-fit step. (Previously this was done via
    // geometry.computeBoundingBox() after baking userScale into the geometry.)
    //
    // A rotated model needs the ROTATED Z extent instead, and it has to be the
    // exact bounds of the rotated vertices — rotating the eight AABB corners
    // over-estimates, which would put the preview's Z fit slightly out of step
    // with loadSTLTransformedGeometry and desync the preview from the toolpath.
    // orientImportedMesh caches per (asset, orientation), so this costs one
    // vertex pass on the first rebuild after a rotation and nothing after.
    const persistedMesh = oriented ? loadPersistedTriangleMesh(asset) : null
    const zBounds = persistedMesh
      ? orientImportedMesh(persistedMesh, orientation, stl?.meshAssetId).bounds
      : asset.bounds
    const meshHeight = (zBounds.maxZ - zBounds.minZ) * userScale
    const targetHeight = Math.max(minRenderHeight(project.meta.units), Math.abs(zTop - zBottom))
    const zScaleFactor = targetHeight / (meshHeight || 1)
    const minZAfterScale = zBounds.minZ * userScale

    // The original geometry-level transform sequence (applied in order):
    //   1. scale(userScale)              → uniform scale
    //   1b. post-import orientation      → rigid rotation of the model (#241)
    //   2. translate(0,0,-minZ)          → move bottom of mesh to z=0
    //   3. scale(1,1,zScaleFactor)       → stretch Z to targetHeight
    //   4. translate(0,0,min(zTop,zBot)) → move bottom to feature's bottom plane
    //   5. apply the strict instance's full 2D affine transform
    //   6. rotateX(-π/2)                 → swap Y/Z for viewport convention
    //   7. mesh.scale.z = -1             → flip Z (final mesh-local axis flip)
    //
    // We reproduce that as an Object3D hierarchy so each chunk shares it
    // without baking transforms into per-chunk geometry. Read from outer (last
    // applied) to inner (first applied):
    //
    //   group (rotateX(-π/2), instance affine transform)
    //     └── inner (scale Z, translate -minZ*userScale, orientation, scale
    //                userScale, then translate by min(zTop,zBot) along Z
    //                BEFORE rotateX)
    //
    // The clearest way to assemble this without juggling matrices is nested
    // groups: an inner that handles the mesh-local scale/rotate/translate, and
    // an outer that handles the world-space affine placement. We also fold
    // mesh.scale.z = -1 into the inner.

    // Inner Z transform reproduces steps 1–4 in mesh-local space:
    //   z' = (z * userScale - minZAfterScale) * zScaleFactor + min(zTop,zBot)
    // As an affine transform on (x,y,z): scale (userScale, userScale, userScale*zScaleFactor),
    // then translate (0, 0, -minZAfterScale * zScaleFactor + min(zTop,zBot)).
    //
    // With an orientation the non-uniform Z scale must land AFTER the rotation,
    // so the two cannot share a node (Three composes a node as T·R·S). The
    // rotation gets its own group between the uniform scale and the Z fit;
    // uniform scale commutes with rotation, so the result is identical to the
    // per-vertex path in loadSTLTransformedGeometry.
    const innerGroup = new THREE.Group()
    if (orientation && persistedMesh) {
      innerGroup.scale.set(1, 1, zScaleFactor)
      innerGroup.position.set(0, 0, -minZAfterScale * zScaleFactor + Math.min(zTop, zBottom))

      const orientGroup = new THREE.Group()
      orientGroup.matrixAutoUpdate = false
      orientGroup.matrix.fromArray(modelOrientationAroundBoundsMatrix4(orientation, persistedMesh.bounds))
      orientGroup.matrix.scale(new THREE.Vector3(userScale, userScale, userScale))
      innerGroup.add(orientGroup)
      for (const chunk of chunks) {
        orientGroup.add(new THREE.Mesh(chunk, material))
      }
    } else {
      innerGroup.scale.set(userScale, userScale, userScale * zScaleFactor)
      innerGroup.position.set(0, 0, -minZAfterScale * zScaleFactor + Math.min(zTop, zBottom))
      for (const chunk of chunks) {
        innerGroup.add(new THREE.Mesh(chunk, material))
      }
    }

    // Each subsequent step in the original sequence (5–6, then mesh.scale.z = -1)
    // is wrapped as its own group, outer = applied later. Three.js composes a
    // node's local transform as T * R * S; the inner group already uses both
    // scale and translation, so all subsequent ops use one transform per node
    // to avoid combined-order surprises.
    const affineGroup = new THREE.Group()
    affineGroup.matrixAutoUpdate = false
    affineGroup.matrix.fromArray(importedModelMatrix4(transform))
    affineGroup.add(innerGroup)

    const rotateXGroup = new THREE.Group()
    rotateXGroup.rotation.x = -Math.PI / 2
    rotateXGroup.add(affineGroup)

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

  // A canned model draws from its mesh alone (issue #1112 F5). Reaching here
  // means its generated mesh asset was missing, and its outline is only the
  // placement frame — extruding it would draw the box around the shape.
  if (cannedShapeIsModel(feature.canned)) {
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
    ? buildWallGeometry(shape, Math.max(depth, minRenderHeight(project.meta.units)))
    : new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(depth, minRenderHeight(project.meta.units)),
        bevelEnabled: false,
      })

  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, yStart, 0)

  const baseColor = featureMeshBaseColor(feature, isRegion, threePalette)
  const color =
    selected ? (threePalette?.meshFeatureSelected ?? 0xffaa00) // theme-exempt: dark fallback
    : hovered ? (threePalette?.meshFeatureHovered ?? 0x44aaff) // theme-exempt: dark fallback
    : baseColor

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
  markFeatureBaseColor(material, baseColor)

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
export function applyClampHighlight(mesh: THREE.Mesh, selected: boolean, colliding: boolean, threePalette: ThreeThemePalette): void {
  const material = mesh.material
  if (!(material instanceof THREE.MeshStandardMaterial)) return
  material.color.set(
    colliding
      ? (selected ? threePalette.clampCollidingSelected : threePalette.clampColliding)
      : (selected ? threePalette.clampSelected : threePalette.clampDefault),
  )
  material.opacity = colliding ? (selected ? 0.8 : 0.68) : (selected ? 0.72 : 0.58)
}

/** Update a tab mesh's highlight to reflect selection state (see {@link applyClampHighlight}). */
export function applyTabHighlight(mesh: THREE.Mesh, selected: boolean, threePalette: ThreeThemePalette): void {
  const material = mesh.material
  if (!(material instanceof THREE.MeshStandardMaterial)) return
  material.color.set(selected ? threePalette.tabSelected : threePalette.tabDefault)
  material.opacity = selected ? 0.72 : 0.56
}

/**
 * True when a drawn mesh belongs to the feature `featureId`. `buildScene` keys
 * the meshes it generates for text and canned shapes by their source row
 * (`<id>:canned:0`, `<id>:text:2`), so a selected or hovered feature has to
 * claim those too — the colon keeps one feature's id from matching another's.
 */
function drawnForFeature(drawnId: string, featureId: string | null): boolean {
  if (!featureId) return false
  return drawnId === featureId || drawnId.startsWith(`${featureId}:`)
}

/**
 * Update one feature mesh's highlight to reflect selection or hover.
 *
 * Selection and hover change only the colour, never the geometry, so this
 * recolors the material the mesh was already built with rather than rebuilding
 * it (the same rule clamps and tabs follow, issue #261). A canned model — a
 * Turn or a Polygon — is drawn from its own mesh (issue #1112 F5), so this is
 * the only thing that can highlight it; the colour it was built in is recorded
 * on the material, which is what clearing the highlight restores.
 */
export function applyFeatureHighlight(object: THREE.Object3D, selected: boolean, hovered: boolean, threePalette: ThreeThemePalette): void {
  object.traverse((entry) => {
    if (!(entry instanceof THREE.Mesh)) return
    const materials = Array.isArray(entry.material) ? entry.material : [entry.material]
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue
      const baseColor = (material.userData as FeatureMaterialUserData).featureBaseColor
      material.color.set(
        selected
          ? threePalette.meshFeatureSelected
          : hovered
            ? threePalette.meshFeatureHovered
            : baseColor ?? threePalette.meshFeatureDefault,
      )
    }
  })
}

/**
 * Recolor every drawn feature mesh for the current selection and hover, in
 * place. `buildScene` builds them unhighlighted — it takes no selection, so a
 * selection change can never rebuild the CSG model — and the viewport calls
 * this again whenever the selection or hover changes.
 */
export function applyFeatureHighlights(
  featureMeshes: ReadonlyMap<string, THREE.Object3D>,
  selection: { selectedFeatureIds: readonly string[]; hoveredFeatureId: string | null },
  threePalette: ThreeThemePalette,
): void {
  for (const [drawnId, object] of featureMeshes) {
    const selected = selection.selectedFeatureIds.some((featureId) => drawnForFeature(drawnId, featureId))
    applyFeatureHighlight(object, selected, drawnForFeature(drawnId, selection.hoveredFeatureId), threePalette)
  }
}

/**
 * A chuck or tailstock on a bar, as a cylinder about the bar's axis. Its
 * diameter is the clamp's own — the clamp's size across the axis (`h` for axis
 * `'x'`, `w` for axis `'y'`) — its length is the clamp rectangle's extent along
 * the axis, and its centre sits on the bar's centreline at the **true turning
 * pivot**, `barPivotZ` = half the thickness. On a round bar that is the old
 * radius; on a square blank it must stay `side/2`, never the corner radius
 * `side/√2`, or the physical chuck would float off the blank (#1016 C2-R2V).
 * `src/store/helpers/roundWorkholding.ts` is what keeps that rectangle centred
 * on the centreline and `height` = bar radius + own radius.
 */
function roundWorkholdingGeometry(clamp: Clamp, stock: BarStock): THREE.CylinderGeometry {
  const diameter = stock.axis === 'x' ? clamp.h : clamp.w
  const length = stock.axis === 'x' ? clamp.w : clamp.h
  const geometry = new THREE.CylinderGeometry(
    diameter / 2,
    diameter / 2,
    length,
    ROUND_BAR_SEGMENTS,
  )
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  if (stock.axis === 'x') {
    geometry.rotateZ(-Math.PI / 2)
    geometry.translate(clamp.x + clamp.w / 2, centre, pivot)
  } else {
    geometry.translate(centre, clamp.y + clamp.h / 2, pivot)
  }
  return geometry
}

/** True for the two round workholding types, which draw round on a round bar. */
function isRoundWorkholdingClamp(clamp: Clamp): boolean {
  return clamp.type === 'chuck' || clamp.type === 'tailstock'
}

export function buildClampMesh(clamp: Clamp, selected = false, colliding = false, units: Units, threePalette?: ThreeThemePalette, stock?: Stock): THREE.Mesh {
  const geometry: THREE.BufferGeometry = stock && isBarStock(stock) && isRoundWorkholdingClamp(clamp)
    ? (clamp.type === 'chuck' && clamp.chuck ? buildChuckGeometry(clamp, stock) : roundWorkholdingGeometry(clamp, stock))
    : new THREE.ExtrudeGeometry(profileToShape(rectProfile(clamp.x, clamp.y, clamp.w, clamp.h)), {
        depth: Math.max(clamp.height, minRenderHeight(units)),
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
  if (threePalette) applyClampHighlight(mesh, selected, colliding, threePalette)
  mesh.scale.z = -1
  return mesh
}


/**
 * The volume a clamp is actually checked against, drawn as a wireframe box: the
 * clamp grown by `clampClearanceXY + tool radius` in XY, and standing to the Z a
 * move has to reach to clear it.
 *
 * A wireframe rather than a solid on purpose — this is the constraint, not an
 * object, and it must not hide the part it surrounds. It is visibly larger than
 * the clamp beside it, which is the whole point: the gap between the two is
 * exactly what made issue #458 look like a false alarm.
 */
export function buildClampClearanceBox(
  bounds: ExpandedClampBounds,
  threePalette: ThreeThemePalette,
): THREE.Object3D {
  const width = Math.max(bounds.maxX - bounds.minX, 0.1)
  const depth = Math.max(bounds.maxY - bounds.minY, 0.1)
  const height = Math.max(bounds.requiredZ, 0.1)
  const geometry = new THREE.BoxGeometry(width, height, depth)
  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({
      color: threePalette.clampClearance,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    }),
  )
  geometry.dispose()
  // Three's Y is the project's Z, and the viewport mirrors Z to put the
  // project's +Y away from the camera — the same `scale.z = -1` every fixture
  // mesh carries.
  box.position.set((bounds.minX + bounds.maxX) / 2, height / 2, (bounds.minY + bounds.maxY) / 2)
  box.scale.z = -1
  return box
}

export function buildTabMesh(tab: Tab, units: Units, selected = false, threePalette?: ThreeThemePalette): THREE.Mesh {
  const shape = profileToShape(rectProfile(tab.x, tab.y, tab.w, tab.h))
  const zStart = Math.min(tab.z_top, tab.z_bottom)
  const depth = Math.max(Math.abs(tab.z_top - tab.z_bottom), minRenderHeight(units))
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
  if (threePalette) applyTabHighlight(mesh, selected, threePalette)
  mesh.scale.z = -1
  return mesh
}

export function buildOriginTriad(origin: MachineOrigin, size: number, threePalette?: ThreeThemePalette): THREE.Group {
  const group = new THREE.Group()
  group.position.set(origin.x, origin.z, origin.y)

  const axisData = [
    { direction: new THREE.Vector3(1, 0, 0), color: threePalette?.originAxisX ?? 0xe35b5b }, // theme-exempt: dark fallback
    { direction: new THREE.Vector3(0, 0, -1), color: threePalette?.originAxisY ?? 0x63c07a }, // theme-exempt: dark fallback
    { direction: new THREE.Vector3(0, 1, 0), color: threePalette?.originAxisZ ?? 0x5b90e3 }, // theme-exempt: dark fallback
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
    color: threePalette?.originCenter ?? 0xe6edf5, // theme-exempt: dark fallback
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
  arcStepRadians: number = DEFAULT_ARC_STEP_RADIANS,
): ManifoldSolid | null {
  const asset = feature.kind === 'stl' ? featureModelAsset(project, feature) : null
  if (asset) {
    try {
      const persistedMesh = loadPersistedTriangleMesh(asset)
      if (!persistedMesh) return null
      const stl = feature.stl
      // Orient before building the solid so `solid.boundingBox()` below is the
      // rotated Z extent — the Z fit must stretch to the rotated height, not
      // the import-orientation one, or rotation would squash the model.
      const mesh = orientImportedMesh(persistedMesh, stl?.orientation, stl?.meshAssetId)

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
      const transform = importedModelInstanceTransform(feature)
      
      // Resolve z dimensions (DimensionRef → number)
      const zTop = resolveDimension(feature.z_top, project)
      const zBottom = resolveDimension(feature.z_bottom, project)
      
      // Compute vertical scale and translation to match z_bottom/z_top
      const bbox = solid.boundingBox()
      const meshHeight = bbox.max[2] - bbox.min[2]
      const targetHeight = Math.max(minRenderHeight(project.meta.units), Math.abs(zTop - zBottom))
      // bbox is computed BEFORE uniform scale, so meshHeight = originalHeight.
      // After .scale([scale, scale, scale]), height = originalHeight * scale.
      // We want final height = targetHeight, so zScale = targetHeight / (originalHeight * scale).
      const zScale = targetHeight / ((meshHeight || 1) * scale)

      return solid
        .scale([scale, scale, scale]) // Apply uniform scale first
        .translate([0, 0, -bbox.min[2] * scale]) // Move to 0 (accounting for uniform scale)
        .scale([1, 1, zScale]) // Scale Z to match target height
        .translate([0, 0, Math.min(zTop, zBottom)]) // Move to target bottom
        .transform(importedModelMatrix4(transform))
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
      const depth = Math.max(Math.abs(zBottom - zTop), minRenderHeight(project.meta.units))

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
  // Floors at the unit-aware guard so a 0.0625 in feature on 0.0625 in stock is
  // not inflated to the old unit-blind 0.1 in (issue #1009).
  const depth = Math.max(Math.abs(zBottom - zTop), minRenderHeight(project.meta.units))

  const crossSection = module.CrossSection.ofPolygons([contour], 'EvenOdd')
  try {
    return crossSection.extrude(depth).translate(0, 0, yStart)
  } finally {
    crossSection.delete()
  }
}

/**
 * The bar as a Manifold cylinder in project coordinates (issue #395): the
 * diameter across, `ROUND_BAR_SEGMENTS` around, lying along its axis on the
 * centreline at Z = diameter / 2. The same dimensions and faceting as
 * `roundBarGeometry`, so the model's uncut surface sits on the stock mesh drawn
 * over it.
 */
export function roundBarSolid(module: ManifoldToplevel, stock: RoundStock): ManifoldSolid {
  const diameter = roundStockDiameter(stock)
  const radius = diameter / 2
  const bounds = getStockBounds(stock)
  const centre = roundStockCentre(stock)
  const cylinder = module.Manifold.cylinder(
    roundStockLength(stock),
    radius,
    radius,
    ROUND_BAR_SEGMENTS,
    true,
  )
  let rotated: ManifoldSolid | null = null
  try {
    if (stock.axis === 'x') {
      rotated = cylinder.rotate([0, 90, 0])
      return rotated.translate([(bounds.minX + bounds.maxX) / 2, centre, radius])
    }
    rotated = cylinder.rotate([-90, 0, 0])
    return rotated.translate([centre, (bounds.minY + bounds.maxY) / 2, radius])
  } finally {
    // The caller owns the translated solid; the cylinder and its rotation are
    // WASM-backed and would otherwise leak on every Around model rebuild.
    rotated?.delete()
    cylinder.delete()
  }
}

/**
 * The square blank as a Manifold prism in project coordinates (#1054 slice 1):
 * the blank's box, `thickness` up, lying along its axis. Its box is the stock's
 * own, so the uncut prism sits exactly on the stock mesh drawn over it, and its
 * pivot is the same true turning pivot as the round bar's (`barPivotZ` =
 * side / 2, the box centre across).
 */
export function squareBarSolid(module: ManifoldToplevel, stock: SquareStock): ManifoldSolid {
  const bounds = getStockBounds(stock)
  const cube = module.Manifold.cube(
    [
      bounds.maxX - bounds.minX,
      bounds.maxY - bounds.minY,
      stock.thickness,
    ],
    true,
  )
  try {
    return cube.translate([
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      stock.thickness / 2,
    ])
  } finally {
    // The caller owns the translated solid; the cube is WASM-backed.
    cube.delete()
  }
}

/**
 * The bar as the part's own material on every face (#1054 slice 1): the round
 * cylinder or the square prism, about the true turning pivot and the bar's
 * length. Both shapes share one box, so a round bar and a square blank of the
 * same stock differ only in the shape of their surface.
 */
export function barStockSolid(module: ManifoldToplevel, stock: BarStock): ManifoldSolid {
  return isRoundStock(stock) ? roundBarSolid(module, stock) : squareBarSolid(module, stock)
}

/** `base ∪ (solid ∩ bar)`; added material never stands outside the bar. */
function unionClippedToBar(
  module: ManifoldToplevel,
  base: ManifoldSolid,
  solid: ManifoldSolid,
  bar: ManifoldSolid,
): ManifoldSolid {
  const island = module.Manifold.intersection(solid, bar)
  try {
    return module.Manifold.union(base, island)
  } finally {
    island.delete()
  }
}

/**
 * The material the raw bar loses to one turning model (#1112 rt4-c item 36).
 *
 * A canned model on a bar is the finished surface of the stock over its own
 * length: turning the blank down leaves the model and takes away the rest of
 * the cross-section there. That "rest" is this solid — a box over the bar's own
 * bounding cross-section, as long as the model's axial span, minus the model —
 * so the fold's `difference(current, removal)` leaves the turned surface itself
 * and nothing around it. Material before and after the model keeps the bar's
 * diameter, which is what a partially turned bar looks like.
 *
 * The box comes from the bar's bounding box rather than its surface, so it
 * covers every vertex of a round bar and the square blank's own corners, and
 * the model's bounding box gives the length on either bar axis. The model's
 * ends are coplanar with the box's end faces, which is deliberate: a longer box
 * would leave a hairline gap between the bar and the turned section.
 */
function barTurningRemoval(
  module: ManifoldToplevel,
  bar: ManifoldSolid,
  model: ManifoldSolid,
  axis: 'x' | 'y',
): ManifoldSolid {
  const barBox = bar.boundingBox()
  const modelBox = model.boundingBox()
  const along = axis === 'x' ? 0 : 1
  const min = [barBox.min[0], barBox.min[1], barBox.min[2]]
  const max = [barBox.max[0], barBox.max[1], barBox.max[2]]
  min[along] = modelBox.min[along]
  max[along] = modelBox.max[along]
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  const centre: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ]
  const cube = module.Manifold.cube(size, true)
  let window: ManifoldSolid | null = null
  try {
    window = cube.translate(centre)
    return module.Manifold.difference(window, model)
  } finally {
    window?.delete()
    cube.delete()
  }
}

/**
 * The part's solid in a rotary project (#1054 slice 1): the bar each face cuts
 * into.
 *
 * The bar is the material, so there is no base add. A Top or Bottom subtract
 * cuts the bar directly and an add unions material back, clipped to the bar.
 * The Around sheet's wrapped slabs run on that **same** solid, so one model
 * shows every face. Every feature — flat and Around — is applied in the
 * project's own feature order (#1054 fix 1, finding 6): a feature's position in
 * the tree is the order the user expects the material to change, and applying
 * one face's features as a later batch would let an earlier Around add restore
 * a cut a later Top/Bottom subtract had made. An Around add alone still leaves
 * the bar as it was.
 *
 * The Around slabs are built before the fold, and a failure to wrap one is
 * caught so it cannot take the flat faces down with it (the previous fallback).
 * Groups of features expanded from one project row (text shapes) keep that
 * row's position and their own order.
 *
 * Returns `null` for a non-bar stock. Block projects never call this: their
 * flat model is built exactly as it always was.
 *
 * Also returns `null` when no Add or Subtract solid applies: a band of sheet
 * work that only draws something (a Thread/Flutes line, an Around region) or
 * only holds models leaves the bar exactly as the stock. The bar solid is
 * opaque and the stock mesh is translucent, so handing the unchanged bar back
 * as the model painted over every model and line inside it — a visible Thread
 * hid the Turn and the Hex it ran over, and hiding the Thread brought them
 * back (#1112 rt3-c item 29). A models-only project already builds no boolean
 * mesh (issue #1112 F5); this is the same rule for a fold that changes nothing.
 *
 * A canned model (Turn, Polygon) is part of the bar, not an overlay on it
 * (#1112 rt4-c item 36): the stock is turned down to that model over the
 * model's own length, so the fold applies it in tree order — before or after a
 * sheet cut, wherever the user put the row. Folding the models is what makes
 * them visible beside sheet work: while they were left out, an opaque bar was
 * drawn over them and both Turns in Frank's file disappeared the moment the
 * Around pocket was shown.
 */
export function buildBarModelSolid(
  module: ManifoldToplevel,
  project: Project,
  visibleFeatures: SketchFeature[],
  visibleAroundFeatures: SketchFeature[],
  arcStepRadians: number = DEFAULT_ARC_STEP_RADIANS,
): ManifoldSolid | null {
  if (!isBarStock(project.stock)) return null
  const bar = barStockSolid(module, project.stock)
  let current: ManifoldSolid = bar
  let handedOver = false
  let applied = false
  // Replacing `current` releases the previous solid, unless it is still the
  // bar: that stays whole for every add's intersection until the end.
  const replace = (next: ManifoldSolid): void => {
    if (current !== bar) current.delete()
    current = next
  }

  // One ordered list of the boolean and model features, flat and Around alike.
  // A row's position comes from the project's own feature list; its expanded
  // shapes stay together, in their own order, because the sort is stable.
  interface BarStage {
    index: number
    around: boolean
    feature: SketchFeature
    /** A canned model that shapes the bar's surface rather than cutting it. */
    turningModel: boolean
  }
  const rowIndex = new Map(project.features.map((feature, index) => [feature.id, index]))
  const stages: BarStage[] = []
  for (const around of [false, true] as const) {
    for (const source of around ? visibleAroundFeatures : visibleFeatures) {
      const index = rowIndex.get(source.id) ?? Number.MAX_SAFE_INTEGER
      // A Turn or Polygon is folded as the model feature itself, not as the
      // shapes `expandFeatureGeometry` yields for it: those are only its
      // placement frame (issue #1112 F5), while the feature owns the generated
      // mesh that is the bar's finished surface. A model whose mesh asset is
      // missing draws nothing rather than its frame, so it shapes nothing.
      if (!around && source.operation === 'model' && cannedShapeIsModel(source.canned)) {
        if (featureModelAsset(project, source)) {
          stages.push({ index, around, feature: source, turningModel: true })
        }
        continue
      }
      for (const feature of expandFeatureGeometry(source, false)) {
        stages.push({ index, around, feature, turningModel: false })
      }
    }
  }
  stages.sort((a, b) => a.index - b.index)

  // With no Add or Subtract stage there is no model mesh at all (#1112 F5,
  // rt3-c): the stock mesh already draws the bar, translucently, so the model
  // meshes and wrapped lines inside it stay visible. A turning model alone does
  // not need a bar: it is drawn as its own mesh, exactly as before.
  const hasBooleanStage = stages.some(
    (stage) => !stage.turningModel && (stage.feature.operation === 'add' || stage.feature.operation === 'subtract'),
  )
  if (!hasBooleanStage) {
    bar.delete()
    return null
  }

  // The Around sheet's slabs are wrapped up front. A failure here is caught so
  // it cannot take the flat faces down with it.
  const options: AroundSlabOptions = { minHeight: minRenderHeight(project.meta.units), arcStepRadians }
  const slabs = new Map<SketchFeature, ManifoldSolid>()
  let aroundFailed = false
  try {
    for (const stage of stages) {
      if (!stage.around) continue
      const { feature } = stage
      if (feature.operation !== 'add' && feature.operation !== 'subtract') continue
      const slab = buildAroundFeatureSolid(module, project, feature, options)
      if (slab) slabs.set(feature, slab)
    }
  } catch (error) {
    aroundFailed = true
    console.error('Failed to apply the Around features to the bar model, showing the flat faces only.', error)
  }

  try {
    for (const stage of stages) {
      const { feature, around, turningModel } = stage
      if (around && aroundFailed) continue

      // A turning model replaces the bar's cross-section with the finished
      // surface it generated, over its own length (#1112 rt4-c item 36). The
      // removal is built from the whole bar, not from `current`, so a later
      // model wins its span and an earlier sheet cut inside that span is still
      // under the model it cut before.
      if (turningModel) {
        const model = buildFeatureSolid(module, project, feature)
        if (!model) continue
        let removal: ManifoldSolid | null = null
        try {
          removal = barTurningRemoval(module, bar, model, project.stock.axis)
          replace(module.Manifold.difference(current, removal))
        } finally {
          removal?.delete()
          model.delete()
        }
        continue
      }

      if (feature.operation !== 'add' && feature.operation !== 'subtract') continue
      // A wrapped slab is owned by `slabs`; a flat solid is built and released
      // here. Neither is deleted before the boolean that consumes it returns.
      const solid = around ? slabs.get(feature) ?? null : buildFeatureSolid(module, project, feature)
      if (!solid) continue
      try {
        const next = feature.operation === 'subtract'
          ? module.Manifold.difference(current, solid)
          : unionClippedToBar(module, current, solid, bar)
        replace(next)
        applied = true
      } finally {
        if (!around) solid.delete()
      }
    }

    // Nothing cut or added: the fold's result is the bare bar, which the stock
    // mesh already draws (translucently, so the models and lines inside it stay
    // visible). Returning it would draw an opaque bar over them.
    if (!applied) return null

    handedOver = true
    return current
  } finally {
    for (const slab of slabs.values()) slab.delete()
    if (handedOver) {
      // The returned solid owns its own object; only the seed is released.
      if (current !== bar) bar.delete()
    } else {
      if (current !== bar) current.delete()
      bar.delete()
    }
  }
}

/**
 * The wrapped slab of an Around region as a display-only mesh (issue #395):
 * the same slab the boolean model uses, with the region material the flat
 * regions draw with.
 *
 * The material records its base colour like every other feature mesh, because
 * the viewport recolors these meshes in place right after a build and on every
 * selection/hover change (issue #1112 F5). Without it, clearing the highlight
 * reset an unselected region to the default model grey instead of its purple —
 * and the viewport applies the highlight immediately after every build, so
 * that happened on an empty selection too.
 */
export function buildAroundRegionMesh(
  module: ManifoldToplevel,
  project: Project,
  feature: SketchFeature,
  threePalette: ThreeThemePalette,
): THREE.Mesh | null {
  const solid = buildAroundFeatureSolid(module, project, feature, {
    minHeight: minRenderHeight(project.meta.units),
  })
  if (!solid) return null
  try {
    const geometry = manifoldMeshToGeometry(solid.getMesh())
    const baseColor = featureMeshBaseColor(feature, true, threePalette)
    const material = new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: 0.78,
      metalness: 0.08,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
    markFeatureBaseColor(material, baseColor)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.renderOrder = 1
    mesh.scale.z = -1
    return mesh
  } finally {
    solid.delete()
  }
}

/** The flat (Top/Bottom) model solid, built exactly as it always was. */
function buildFlatModelSolid(
  module: ManifoldToplevel,
  project: Project,
  visibleFeatures: SketchFeature[],
): ManifoldSolid | null {
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

    return current
  } catch (error) {
    current?.delete()
    throw error
  }
}

/** A built solid as the viewport's one model mesh. */
function solidToModelMesh(solid: ManifoldSolid, threePalette: ThreeThemePalette): THREE.Mesh {
  const manifoldMesh = solid.getMesh()
  const geometry = manifoldMeshToGeometry(manifoldMesh)
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(threePalette.meshFeatureDefault),
    roughness: 0.82,
    metalness: 0.05,
    flatShading: true,
    side: THREE.FrontSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.scale.z = -1
  return mesh
}

/**
 * How much of a model's own volume the fold may remove before the model counts
 * as cut, as a fraction. An untouched model comes back from
 * `intersection(bar, model)` with its own volume to rounding; anything a user
 * can see is orders of magnitude larger.
 */
const FOLDED_MODEL_VOLUME_EPSILON = 1e-6

/**
 * A canned model's own drawn mesh, built from the fold instead of from its mesh
 * (#1112 rt4-c fix 1).
 *
 * A model is drawn from its generated mesh so selecting its row can tint it
 * (`buildFeatureMesh`, issue #1112 F5). That mesh is the model as authored, so
 * wherever a feature cut into the model — an Around pocket overlapping the
 * Turn's span, or a turning model that follows it — the bar mesh carried the
 * cut while this uncut mesh covered the opening: the pocket's 1.05 in floor was
 * rendered shut at the Turn's 1.25 in crown. Drawing the fold's share of the
 * model instead keeps the highlight on the geometry that respects every cut.
 *
 * The material records its base colour like every other feature mesh, because
 * the viewport recolors model meshes in place on every selection change.
 */
function solidToModelFeatureMesh(solid: ManifoldSolid, threePalette: ThreeThemePalette): THREE.Mesh {
  const geometry = manifoldMeshToGeometry(solid.getMesh())
  const baseColor = threePalette.meshFeatureDefault
  const material = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 0.82,
    metalness: 0.05,
    flatShading: true,
    side: THREE.FrontSide,
    // Where nothing cut the model its surface is the bar's own surface, so the
    // two are coincident and would flicker against each other. Pull the model a
    // hair forward, exactly as the mesh `buildFeatureMesh` draws does.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  markFeatureBaseColor(material, baseColor)

  const mesh = new THREE.Mesh(geometry, material)
  mesh.scale.z = -1
  return mesh
}

/**
 * The canned models the bar fold cut, as drawn meshes (#1112 rt4-c fix 1).
 *
 * A model the fold cut is drawn from its share of the bar — `intersection(bar,
 * model)` — so every cut through it stays open. A model nothing cut keeps
 * `buildFeatureMesh` and its own generated mesh: that mesh carries the smooth
 * normals of a revolved surface, which redrawing it from the fold's faceted
 * geometry would lose for no visible gain.
 */
function buildFoldedModelMeshes(
  module: ManifoldToplevel,
  project: Project,
  visibleFeatures: SketchFeature[],
  barSolid: ManifoldSolid,
  threePalette: ThreeThemePalette,
): Map<string, THREE.Mesh> {
  const meshes = new Map<string, THREE.Mesh>()
  for (const feature of visibleFeatures) {
    if (feature.kind !== 'stl' || !cannedShapeIsModel(feature.canned)) continue
    if (!featureModelAsset(project, feature)) continue
    const model = buildFeatureSolid(module, project, feature)
    if (!model) continue
    let cut: ManifoldSolid | null = null
    try {
      const volume = model.volume()
      if (!(volume > 0)) continue
      cut = module.Manifold.intersection(barSolid, model)
      if (volume - cut.volume() <= volume * FOLDED_MODEL_VOLUME_EPSILON) continue
      meshes.set(feature.id, solidToModelFeatureMesh(cut, threePalette))
    } catch (error) {
      // One model the fold cannot trim must not take the bar down with it: it
      // stays on its own mesh, exactly as it would without this step.
      console.error(`Failed to draw the folded model ${feature.id}, showing its own mesh.`, error)
    } finally {
      cut?.delete()
      model.delete()
    }
  }
  return meshes
}

/** What a boolean model build yields: the bar mesh and the model meshes cut from it. */
interface BooleanModel {
  modelMesh: THREE.Mesh | null
  /** The canned models the bar fold cut, drawn from the fold (#1112 rt4-c fix 1). */
  modelFeatureMeshes: Map<string, THREE.Mesh>
}

/**
 * The scene's one model mesh.
 *
 * In a rotary project the bar is the material on every face (#1054 slice 1), so
 * the flat and Around features build one solid seeded from the bar itself. Any
 * other project — a block for milling or plasma — takes the flat path exactly
 * as it always did, with no bar seed, no clipping and no Around content
 * (issue #395's rule that only a rotary round bar models Around features still
 * holds).
 *
 * A bar fold also hands back the drawing of each canned model it cut, so the
 * model's own highlight mesh cannot cover a cut the bar carries (#1112 rt4-c
 * fix 1). Only the bar path can cut a model, so only it yields those meshes.
 */
async function buildBooleanModel(
  project: Project,
  visibleFeatures: SketchFeature[],
  aroundFeatures: SketchFeature[],
  threePalette: ThreeThemePalette,
): Promise<BooleanModel> {
  const module = await getManifoldModule()
  let combined: ManifoldSolid | null
  let barFolded = false
  if (barSeedsModel(project)) {
    try {
      combined = buildBarModelSolid(module, project, visibleFeatures, aroundFeatures)
      barFolded = combined !== null
    } catch (error) {
      console.error('Failed to build the rotary 3D model from the bar, showing the flat model only.', error)
      combined = buildFlatModelSolid(module, project, visibleFeatures)
    }
  } else {
    combined = buildFlatModelSolid(module, project, visibleFeatures)
  }

  if (!combined) return { modelMesh: null, modelFeatureMeshes: new Map() }
  try {
    return {
      modelMesh: solidToModelMesh(combined, threePalette),
      modelFeatureMeshes: barFolded
        ? buildFoldedModelMeshes(module, project, visibleFeatures, combined, threePalette)
        : new Map(),
    }
  } finally {
    combined.delete()
  }
}

// ── Wireframe outline for stock ──────────────────────────────────────────────

/**
 * A round bar's wireframe in project coordinates: its two end circles plus four
 * lines along it (top, bottom and the two sides). Built explicitly — running
 * `EdgesGeometry` over the faceted cylinder would draw every chord (#392).
 */
function roundBarWireframeGeometry(stock: RoundStock): THREE.BufferGeometry {
  const radius = roundStockDiameter(stock) / 2
  const bounds = getStockBounds(stock)
  const centre = roundStockCentre(stock)
  const alongMin = stock.axis === 'x' ? bounds.minX : bounds.minY
  const alongMax = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  const positions: number[] = []
  // `along` runs down the bar; `across` is the centreline's own axis (Y for
  // axis 'x', X for axis 'y'); `z` is height. The centreline is at z = radius.
  const push = (along: number, across: number, z: number): void => {
    if (stock.axis === 'x') positions.push(along, across, z)
    else positions.push(across, along, z)
  }

  for (const along of [alongMin, alongMax]) {
    for (let i = 0; i < ROUND_BAR_SEGMENTS; i++) {
      const a = (i / ROUND_BAR_SEGMENTS) * Math.PI * 2
      const b = ((i + 1) / ROUND_BAR_SEGMENTS) * Math.PI * 2
      push(along, centre + radius * Math.cos(a), radius + radius * Math.sin(a))
      push(along, centre + radius * Math.cos(b), radius + radius * Math.sin(b))
    }
  }

  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2
    const across = centre + radius * Math.cos(angle)
    const z = radius + radius * Math.sin(angle)
    push(alongMin, across, z)
    push(alongMax, across, z)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

export function buildStockWireframe(stock: Stock, threePalette: ThreeThemePalette): THREE.LineSegments {
  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(stock.color ?? threePalette.stockWireframeFallback),
    linewidth: 1,
  })

  let geometry: THREE.BufferGeometry
  if (isRoundStock(stock)) {
    geometry = roundBarWireframeGeometry(stock)
    geometry.rotateX(-Math.PI / 2)
    const bar = new THREE.LineSegments(geometry, material)
    bar.scale.z = -1
    return bar
  }

  const shape = profileToShape(stock.profile)
  geometry = new THREE.ExtrudeGeometry(shape, {
    depth: stock.thickness,
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)
  const edges = new THREE.EdgesGeometry(geometry)
  const lines = new THREE.LineSegments(edges, material)
  lines.scale.z = -1
  return lines
}

// ── Full scene builder ───────────────────────────────────────────────────────

export interface SceneObjects {
  stockMesh: THREE.Mesh
  stockWireframe: THREE.LineSegments
  modelMesh: THREE.Mesh | null
  featureMeshes: Map<string, THREE.Object3D>
  /** Batched line overlays — a small array of LineSegments2 objects, not per-feature. */
  batchedLines: THREE.Object3D[]
  /** Per-batch metadata for value-level assertions (segment/vertex count, object count). */
  batchedLinesMeta: BatchLineMeta
  tabMeshes: Map<string, THREE.Mesh>
  clampMeshes: Map<string, THREE.Mesh>
  /**
   * The keep-out each clamp is actually checked against, one wireframe box per
   * visible clamp. Static: it carries no selection or collision state, so
   * Viewport3D adds and disposes it but never recolors it.
   */
  clampClearanceBoxes: THREE.Object3D[]
}

export async function buildScene(project: Project, threePalette: ThreeThemePalette): Promise<SceneObjects> {
  // Construction geometry is sketch-only — it never reaches the 3D model,
  // feature meshes, or open-feature lines (issue #199). Regions stay: they
  // render display-only walls below.
  //
  // Fixtures and feature meshes are built unhighlighted: selection and
  // collision only tint them, which Viewport3D recolors via applyClampHighlight
  // / applyTabHighlight / applyFeatureHighlights without rebuilding this
  // (expensive) CSG model (issues #261, #1112 F5). A canned model is drawn under
  // its own feature id — from its authored mesh, or from its share of the fold
  // when the fold cut it (`buildFoldedModelMeshes`) — so that last one is what
  // highlights a Turn/Polygon.
  // Around features are wrapped onto the bar (issue #395): a subtract cuts the
  // round solid, an add is an island standing inside a cut. Top and Bottom
  // features draw exactly as before, and a project with no visible Around
  // feature is untouched.
  const sceneFeatures = resolvedProjectFeatures(project).filter((feature) => feature.authoringFace !== 'around')
  const visibleFeatures = modelFeatures(sceneFeatures).filter((feature) => feature.visible)
  // The same model filter for the Around half. Only a round bar can wrap, and
  // only a rotary project works the Around face at all (issue #1028): in any
  // other type the features stay in the project and the tree but are not
  // modelled.
  const aroundFeatures = isRoundStock(project.stock) && aroundFeaturesActive(project)
    ? modelFeatures(resolvedProjectFeatures(project).filter((feature) => feature.authoringFace === 'around'))
      .filter((feature) => feature.visible)
    : []
  const visibleTabs = project.tabs.filter((tab) => tab.visible)
  const visibleClamps = project.clamps.filter((clamp) => clamp.visible)
  const stockMesh = buildStockMesh(project.stock, threePalette)
  const stockWireframe = buildStockWireframe(project.stock, threePalette)
  const featureMeshes = new Map<string, THREE.Object3D>()
  const batchedLineObjects: THREE.Object3D[] = []
  let batchedLinesMeta: BatchLineMeta = { objectCount: 0, vertexCount: 0, segmentCount: 0 }
  const tabMeshes = new Map<string, THREE.Mesh>()
  const clampMeshes = new Map<string, THREE.Mesh>()
  const clampClearanceBoxes: THREE.Object3D[] = []
  let modelMesh: THREE.Mesh | null = null
  // The canned models the bar fold cut, drawn from the fold itself (#1112 rt4-c
  // fix 1). Empty unless the fold both ran and cut into a model.
  const foldedModelMeshes = new Map<string, THREE.Mesh>()

  if (visibleFeatures.length > 0 || aroundFeatures.length > 0) {
    const booleanFeatures = visibleFeatures.filter(
      (feature) => feature.operation === 'add' || feature.operation === 'subtract',
    )
    if (booleanFeatures.length > 0 || aroundFeatures.length > 0) {
      try {
        // Every visible feature, not only the Add/Subtract ones: a canned model
        // is part of the bar the fold builds (#1112 rt4-c item 36), so the model
        // rows have to reach `buildBarModelSolid`.
        const booleanModel = await buildBooleanModel(project, visibleFeatures, aroundFeatures, threePalette)
        modelMesh = booleanModel.modelMesh
        for (const [id, mesh] of booleanModel.modelFeatureMeshes) foldedModelMeshes.set(id, mesh)
      } catch (error) {
        console.error('Failed to build boolean 3D preview, falling back to feature meshes.', error)
      }
    }

    // Always include STL meshes for visual detail, even if boolean model succeeded.
    // This ensures non-manifold STLs show their real mesh instead of just the 2.5D extrusion fallback.
    // Region features also get their own mesh since they are visual-only (not part of boolean model).
    for (const feature of visibleFeatures) {
      if (feature.kind === 'stl' || feature.operation === 'region') {
        // A canned model the bar fold cut is drawn from its share of the fold:
        // its own authored mesh would cover the cut the bar carries (#1112 rt4-c
        // fix 1). Every other STL keeps its real mesh for detail.
        const folded = foldedModelMeshes.get(feature.id)
        featureMeshes.set(
          feature.id,
          folded ?? buildFeatureMesh(project, feature, false, false, project.stock.thickness, threePalette),
        )
      }
      
      // If buildBooleanModel failed, we need the rest of the meshes too.
      // Open features (polylines) are skipped — they're rendered as lines via buildOpenFeatureLine.
      if (!modelMesh) {
        // A canned model (Turn, Polygon) is drawn from its mesh alone (issue
        // #1112 F5). Expanding it yields its generated outline, which is only
        // the placement frame, so the fallback's extrusion painted a second,
        // box-shaped solid around every Turn and Polygon that flickered
        // through the real shape. Outline kinds keep their extruded solids.
        if (cannedShapeIsModel(feature.canned)) continue
        for (const expanded of expandFeatureGeometry(feature)) {
          if (expanded.kind !== 'stl' && expanded.operation !== 'region') {
            if (!expanded.sketch.profile.closed || expanded.operation === 'line') continue
            featureMeshes.set(expanded.id, buildFeatureMesh(project, expanded, false, false, project.stock.thickness, threePalette))
          }
        }
      }
    }

    // An Around region gets the same wrapped slab as a display-only mesh. The
    // manifold module is loaded by the model build above; without it there is
    // nothing to wrap with.
    const module = getManifoldModuleSync()
    if (module) {
      for (const feature of aroundFeatures) {
        if (feature.operation !== 'region') continue
        const mesh = buildAroundRegionMesh(module, project, feature, threePalette)
        if (mesh) featureMeshes.set(feature.id, mesh)
      }
    }

    // Build batched line overlays for open profiles and closed Line features.
    // One independent-segment batch per base colour — no per-feature objects
    // and no connector segments between contours. Around lines are wrapped onto
    // the bar by the batcher (issue #395).
    const lineResult = buildBatchedLines(project, [...visibleFeatures, ...aroundFeatures], threePalette)
    for (const line of lineResult.lines) {
      batchedLineObjects.push(line)
    }
    batchedLinesMeta = lineResult.meta
  }

  const showStockReference = project.stock.visible ?? true

  stockMesh.visible = showStockReference
  stockWireframe.visible = showStockReference

  for (const tab of visibleTabs) {
    tabMeshes.set(tab.id, buildTabMesh(tab, project.meta.units, false, threePalette))
  }

  for (const clamp of visibleClamps) {
    clampMeshes.set(clamp.id, buildClampMesh(clamp, false, false, project.meta.units, threePalette, project.stock))
  }

  for (const bounds of expandedClampBounds(project, worstCaseClampCheckToolRadius(project))) {
    clampClearanceBoxes.push(buildClampClearanceBox(bounds, threePalette))
  }

  return { stockMesh, stockWireframe, modelMesh, featureMeshes, batchedLines: batchedLineObjects, batchedLinesMeta, tabMeshes, clampMeshes, clampClearanceBoxes }
}
