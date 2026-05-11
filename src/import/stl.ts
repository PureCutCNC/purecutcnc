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

import { getManifoldModule } from '../engine/csg'
import {
  loadImportedTriangleMesh,
  normalizeImportedMeshForStorage,
  type ImportedSourceData,
  type ImportedModelFormat,
  type ImportedTriangleMesh,
  type ModelAxisOrientation,
} from '../engine/importedMesh'
import { DEFAULT_CLIPPER_SCALE, normalizeWinding, toClipperPath } from '../engine/toolpaths/geometry'
import { getMeshSliceIndex, sliceMeshAtZ } from '../engine/toolpaths/meshSlicing'
import { clipperPathsToPointContours, unionClipperPaths } from '../engine/toolpaths/modelProtection'
import { significantSilhouettePaths } from '../engine/toolpaths/silhouette'
import type { ClipperPath } from '../engine/toolpaths/types'
import { polygonProfile, type Point, type SketchProfile } from '../types/project'

const MAX_TOP_VIEW_PX = 1024
const DEFAULT_IMPORT_SILHOUETTE_Z_STEPS = 96
const MIN_IMPORT_SILHOUETTE_Z_STEPS = 8
const MAX_IMPORT_SILHOUETTE_Z_STEPS = 512
const MANIFOLD_PROJECT_TRIANGLE_LIMIT = 200_000

export interface ImportedMeshProfileOptions {
  silhouetteZSteps?: number
}

export function clampImportedMeshSilhouetteZSteps(steps: number): number {
  if (!Number.isFinite(steps)) return DEFAULT_IMPORT_SILHOUETTE_Z_STEPS
  return Math.max(
    MIN_IMPORT_SILHOUETTE_Z_STEPS,
    Math.min(MAX_IMPORT_SILHOUETTE_Z_STEPS, Math.round(steps)),
  )
}

function slicePolygonsToClipperPaths(slicePolygons: Array<Array<[number, number]>>): ClipperPath[] {
  return slicePolygons
    .filter((poly) => poly.length >= 3)
    .map((poly) => toClipperPath(
      normalizeWinding(poly.map(([x, y]) => ({ x, y })), false),
      DEFAULT_CLIPPER_SCALE,
    ))
}

async function extractWaterlineShadowSilhouette(
  mesh: ImportedTriangleMesh,
  zSteps: number,
  onProgress?: (percent: number) => void,
): Promise<Point[][]> {
  const { positions, index, bounds } = mesh
  const height = bounds.maxZ - bounds.minZ
  if (!(height > 1e-9)) return []

  const stepCount = clampImportedMeshSilhouetteZSteps(zSteps)
  const sliceIndex = getMeshSliceIndex({ positions, index })
  const zEpsilon = Math.max(height * 1e-6, 1e-6)
  const lowZ = bounds.minZ + zEpsilon
  const highZ = bounds.maxZ - zEpsilon
  const span = Math.max(0, highZ - lowZ)
  let shadowPaths: ClipperPath[] = []

  onProgress?.(5)
  for (let step = 0; step < stepCount; step += 1) {
    const t = stepCount === 1 ? 0.5 : step / (stepCount - 1)
    const z = highZ - span * t
    const slicePaths = unionClipperPaths(slicePolygonsToClipperPaths(sliceMeshAtZ(sliceIndex, z)))
    if (slicePaths.length > 0) {
      shadowPaths = shadowPaths.length === 0
        ? slicePaths
        : unionClipperPaths([...shadowPaths, ...slicePaths])
    }

    onProgress?.(5 + Math.round(((step + 1) / stepCount) * 90))
    if (step % 8 === 7) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  onProgress?.(100)
  return clipperPathsToPointContours(shadowPaths)
}

async function extractTriangleProjectionSilhouette(
  mesh: ImportedTriangleMesh,
  onProgress?: (percent: number) => void,
): Promise<Point[][]> {
  const { positions, index: triVerts } = mesh
  const paths: ClipperPath[] = []

  for (let i = 0; i < triVerts.length; i += 3) {
    const a = triVerts[i] * 3
    const b = triVerts[i + 1] * 3
    const c = triVerts[i + 2] * 3

    const p1 = { X: Math.round(positions[a] * DEFAULT_CLIPPER_SCALE), Y: Math.round(positions[a + 1] * DEFAULT_CLIPPER_SCALE) }
    const p2 = { X: Math.round(positions[b] * DEFAULT_CLIPPER_SCALE), Y: Math.round(positions[b + 1] * DEFAULT_CLIPPER_SCALE) }
    const p3 = { X: Math.round(positions[c] * DEFAULT_CLIPPER_SCALE), Y: Math.round(positions[c + 1] * DEFAULT_CLIPPER_SCALE) }

    const crossProduct = (p2.X - p1.X) * (p3.Y - p1.Y) - (p2.Y - p1.Y) * (p3.X - p1.X)
    if (crossProduct === 0) continue
    paths.push(crossProduct > 0 ? [p1, p2, p3] : [p1, p3, p2])
  }

  onProgress?.(10)

  const batchSize = 20000
  let unionedPaths: ClipperPath[] = []
  for (let i = 0; i < paths.length; i += batchSize) {
    const batchUnion = unionClipperPaths(paths.slice(i, i + batchSize))
    unionedPaths = unionedPaths.length === 0
      ? batchUnion
      : unionClipperPaths([...unionedPaths, ...batchUnion])

    onProgress?.(Math.min(95, 10 + Math.floor((i / paths.length) * 85)))
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  onProgress?.(100)
  return clipperPathsToPointContours(unionedPaths)
}

async function extractWaterlineOrTriangleProjectionSilhouette(
  mesh: ImportedTriangleMesh,
  zSteps: number,
  onProgress?: (percent: number) => void,
): Promise<Point[][]> {
  const polys = await extractWaterlineShadowSilhouette(mesh, zSteps, onProgress)
  if (polys.length > 0) return polys

  console.warn('Waterline silhouette projection returned no contours, falling back to triangle projection.')
  return extractTriangleProjectionSilhouette(mesh, onProgress)
}

export async function extractImportedMeshProfileAndBounds(
  mesh: ImportedTriangleMesh,
  onProgress?: (percent: number) => void,
  options: ImportedMeshProfileOptions = {},
): Promise<{ profile: SketchProfile, silhouettePaths: Point[][], z_bottom: number, z_top: number } | null> {
  const { positions, index: triVerts, bounds } = mesh
  const z_bottom = Number.isFinite(bounds.minZ) ? bounds.minZ : 0
  const z_top = Number.isFinite(bounds.maxZ) ? bounds.maxZ : 5

  let polys: Point[][] = []
  const zSteps = clampImportedMeshSilhouetteZSteps(options.silhouetteZSteps ?? DEFAULT_IMPORT_SILHOUETTE_Z_STEPS)
  const triangleCount = triVerts.length / 3

  if (triangleCount > MANIFOLD_PROJECT_TRIANGLE_LIMIT) {
    polys = await extractWaterlineOrTriangleProjectionSilhouette(mesh, zSteps, onProgress)
  } else {
    const module = await getManifoldModule()
    const manifoldMesh = new module.Mesh({
      numProp: 3,
      vertProperties: new Float32Array(positions),
      triVerts: triVerts,
      halfedgeTangent: new Float32Array(0),
      runIndex: new Uint32Array([0]),
      runOriginalID: new Uint32Array([0]),
      runTransform: new Float32Array(12).fill(0),
      faceID: new Uint32Array(triVerts.length / 3).fill(0),
    })

    try {
      const solid = new module.Manifold(manifoldMesh)
      const crossSection = solid.project()
      polys = crossSection.toPolygons().map(poly =>
        poly.map(([x, y]) => ({ x, y }))
      )

      solid.delete()
      crossSection.delete()
    } catch (error) {
      console.warn('Imported model is not manifold, falling back to waterline silhouette projection...', error)
      polys = await extractWaterlineOrTriangleProjectionSilhouette(mesh, zSteps, onProgress)
    }
  }

  if (!polys || polys.length === 0) {
    return null
  }

  // Find the largest polygon (outer boundary)
  let maxArea = -1
  let outerPoly = polys[0]
  
  for (const poly of polys) {
    // Simple area approximation to find the outer shell
    let area = 0
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i]
      const p2 = poly[(i + 1) % poly.length]
      area += (p1.x * p2.y - p2.x * p1.y)
    }
    area = Math.abs(area / 2)
    if (area > maxArea) {
      maxArea = area
      outerPoly = poly
    }
  }

  const silhouettePaths = significantSilhouettePaths(
    polys.map((poly) => poly.map((p) => ({ x: p.x, y: p.y }))),
  )
  const points: Point[] = outerPoly.map(p => ({ x: p.x, y: p.y }))
  const profile = polygonProfile(points)

  return { profile, silhouettePaths, z_bottom, z_top }
}

export async function extractImportedModelProfileAndBounds(
  format: ImportedModelFormat,
  base64Data: ImportedSourceData,
  scale: number,
  axisSwap: ModelAxisOrientation = 'none',
  onProgress?: (percent: number) => void,
  options: ImportedMeshProfileOptions = {},
): Promise<{ profile: SketchProfile, silhouettePaths: Point[][], z_bottom: number, z_top: number } | null> {
  const mesh = loadImportedTriangleMesh(format, base64Data, axisSwap)
  if (!mesh) return null
  return extractImportedMeshProfileAndBounds(normalizeImportedMeshForStorage(mesh, scale), onProgress, options)
}

export async function extractStlProfileAndBounds(
  base64Data: string,
  scale: number,
  axisSwap: ModelAxisOrientation = 'none',
  onProgress?: (percent: number) => void
): Promise<{ profile: SketchProfile, silhouettePaths: Point[][], z_bottom: number, z_top: number } | null> {
  return extractImportedModelProfileAndBounds('stl', base64Data, scale, axisSwap, onProgress)
}

export function renderImportedMeshTopViewToDataUrl(
  mesh: ImportedTriangleMesh,
): string | null {
  let canvas: HTMLCanvasElement | undefined
  try {
    canvas = document.createElement('canvas')
  } catch {
    return null
  }

  const { positions, index, bounds } = mesh
  const minX = bounds.minX
  const maxX = bounds.maxX
  const minY = bounds.minY
  const maxY = bounds.maxY
  const minZ = bounds.minZ
  const maxZ = bounds.maxZ

  const widthWorld = maxX - minX
  const heightWorld = maxY - minY
  const depthWorld = maxZ - minZ
  if (!(widthWorld > 1e-9) || !(heightWorld > 1e-9)) return null

  const imageScale = MAX_TOP_VIEW_PX / Math.max(widthWorld, heightWorld)
  const canvasW = Math.max(1, Math.round(widthWorld * imageScale))
  const canvasH = Math.max(1, Math.round(heightWorld * imageScale))
  canvas.width = canvasW
  canvas.height = canvasH

  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, canvasW, canvasH)

  const pixelCount = canvasW * canvasH
  const zBuffer = new Float32Array(pixelCount)
  const shadeBuffer = new Float32Array(pixelCount)
  zBuffer.fill(-Infinity)

  function px(vertexIndex: number): number {
    return (positions[vertexIndex * 3] - minX) * imageScale
  }

  function py(vertexIndex: number): number {
    return (positions[vertexIndex * 3 + 1] - minY) * imageScale
  }

  function pz(vertexIndex: number): number {
    return positions[vertexIndex * 3 + 2]
  }

  for (let i = 0; i < index.length; i += 3) {
    const ia = index[i]
    const ib = index[i + 1]
    const ic = index[i + 2]
    const ax = px(ia), ay = py(ia), az = pz(ia)
    const bx = px(ib), by = py(ib), bz = pz(ib)
    const cx = px(ic), cy = py(ic), cz = pz(ic)
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(area) < 1e-8) continue

    const ux = positions[ib * 3] - positions[ia * 3]
    const uy = positions[ib * 3 + 1] - positions[ia * 3 + 1]
    const uz = positions[ib * 3 + 2] - positions[ia * 3 + 2]
    const vx = positions[ic * 3] - positions[ia * 3]
    const vy = positions[ic * 3 + 1] - positions[ia * 3 + 1]
    const vz = positions[ic * 3 + 2] - positions[ia * 3 + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const normalLength = Math.hypot(nx, ny, nz) || 1
    const topLight = Math.max(0, nz / normalLength)
    const sideLight = Math.max(0, (-0.35 * nx - 0.45 * ny + 0.82 * nz) / normalLength)
    const shade = Math.max(0.18, Math.min(1, 0.35 + topLight * 0.45 + sideLight * 0.2))

    const minPx = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 1))
    const maxPx = Math.min(canvasW - 1, Math.ceil(Math.max(ax, bx, cx) + 1))
    const minPy = Math.max(0, Math.floor(Math.min(ay, by, cy) - 1))
    const maxPy = Math.min(canvasH - 1, Math.ceil(Math.max(ay, by, cy) + 1))
    const areaSign = area > 0 ? 1 : -1
    const edgeTolerance = 0.35 * (
      Math.hypot(bx - ax, by - ay)
      + Math.hypot(cx - bx, cy - by)
      + Math.hypot(ax - cx, ay - cy)
    )

    let touchedPixel = false
    for (let pyIndex = minPy; pyIndex <= maxPy; pyIndex += 1) {
      const sampleY = pyIndex + 0.5
      for (let pxIndex = minPx; pxIndex <= maxPx; pxIndex += 1) {
        const sampleX = pxIndex + 0.5
        const wA = ((bx - sampleX) * (cy - sampleY) - (by - sampleY) * (cx - sampleX)) * areaSign
        const wB = ((cx - sampleX) * (ay - sampleY) - (cy - sampleY) * (ax - sampleX)) * areaSign
        const wC = ((ax - sampleX) * (by - sampleY) - (ay - sampleY) * (bx - sampleX)) * areaSign
        if (wA < -edgeTolerance || wB < -edgeTolerance || wC < -edgeTolerance) continue

        const baryA = (wA * areaSign) / area
        const baryB = (wB * areaSign) / area
        const baryC = (wC * areaSign) / area
        const z = baryA * az + baryB * bz + baryC * cz
        const pixelIndex = pyIndex * canvasW + pxIndex
        if (z <= zBuffer[pixelIndex]) continue
        zBuffer[pixelIndex] = z
        shadeBuffer[pixelIndex] = shade
        touchedPixel = true
      }
    }

    if (!touchedPixel) {
      const pxIndex = Math.max(0, Math.min(canvasW - 1, Math.round((ax + bx + cx) / 3)))
      const pyIndex = Math.max(0, Math.min(canvasH - 1, Math.round((ay + by + cy) / 3)))
      const pixelIndex = pyIndex * canvasW + pxIndex
      const z = (az + bz + cz) / 3
      if (z > zBuffer[pixelIndex]) {
        zBuffer[pixelIndex] = z
        shadeBuffer[pixelIndex] = shade
      }
    }
  }

  const imageData = ctx.createImageData(canvasW, canvasH)
  const data = imageData.data
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const z = zBuffer[pixelIndex]
    const hasDepth = Number.isFinite(z)
    const zT = hasDepth && depthWorld > 1e-9 ? (z - minZ) / depthWorld : 0.35
    const shade = hasDepth ? shadeBuffer[pixelIndex] : 0.34
    const base = pixelIndex * 4
    data[base] = Math.round((52 + zT * 72) * shade)
    data[base + 1] = Math.round((92 + zT * 80) * shade)
    data[base + 2] = Math.round((118 + zT * 88) * shade)
    data[base + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

export function renderImportedModelTopViewToDataUrl(
  format: ImportedModelFormat,
  base64Data: ImportedSourceData,
  scale: number,
  axisSwap: ModelAxisOrientation = 'none',
): string | null {
  const mesh = loadImportedTriangleMesh(format, base64Data, axisSwap)
  if (!mesh) return null
  return renderImportedMeshTopViewToDataUrl(normalizeImportedMeshForStorage(mesh, scale))
}

export function renderStlTopViewToDataUrl(
  base64Data: string,
  scale: number,
  axisSwap: ModelAxisOrientation = 'none',
): string | null {
  return renderImportedModelTopViewToDataUrl('stl', base64Data, scale, axisSwap)
}
