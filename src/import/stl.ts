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
import { loadImportedTriangleMesh, type ModelAxisOrientation } from '../engine/importedMesh'
import { polygonProfile, type Point, type SketchProfile } from '../types/project'
import { unionClipperPaths } from '../store/helpers/clipping'

export async function extractStlProfileAndBounds(
  base64Data: string,
  scale: number,
  axisSwap: ModelAxisOrientation = 'none',
  onProgress?: (percent: number) => void
): Promise<{ profile: SketchProfile, z_bottom: number, z_top: number } | null> {
  const mesh = loadImportedTriangleMesh('stl', base64Data, axisSwap)
  if (!mesh) return null

  const { positions, index: triVerts, bounds } = mesh
  const z_bottom = Number.isFinite(bounds.minZ) ? bounds.minZ * scale : 0
  const z_top = Number.isFinite(bounds.maxZ) ? bounds.maxZ * scale : 5

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

  let polys: Point[][] = []

  try {
    const solid = new module.Manifold(manifoldMesh)
    const scaledSolid = solid.scale([scale, scale, scale])
    const crossSection = scaledSolid.project()
    polys = crossSection.toPolygons().map(poly =>
      poly.map(([x, y]) => ({ x, y }))
    )
    
    solid.delete()
    scaledSolid.delete()
    crossSection.delete()
  } catch (error) {
    console.warn('STL is not manifold, falling back to ClipperLib 2D projection...', error)
    // Fallback: Project all triangles to 2D and union them using ClipperLib
    const paths: Array<Array<{X: number, Y: number}>> = []
    const clipperScale = 10000 // 0.1 micron precision is plenty for silhouette
    
    for (let i = 0; i < triVerts.length; i += 3) {
      const a = triVerts[i] * 3
      const b = triVerts[i + 1] * 3
      const c = triVerts[i + 2] * 3
      
      const p1 = { X: Math.round(positions[a] * scale * clipperScale), Y: Math.round(positions[a + 1] * scale * clipperScale) }
      const p2 = { X: Math.round(positions[b] * scale * clipperScale), Y: Math.round(positions[b + 1] * scale * clipperScale) }
      const p3 = { X: Math.round(positions[c] * scale * clipperScale), Y: Math.round(positions[c + 1] * scale * clipperScale) }
      
      // Compute 2D cross product to reject degenerate projected triangles and
      // normalize winding. STL triangle winding is not reliable enough to use
      // as a front/back filter for silhouettes.
      const crossProduct = (p2.X - p1.X) * (p3.Y - p1.Y) - (p2.Y - p1.Y) * (p3.X - p1.X)
      
      // Skip completely flat/degenerate triangles in 2D projection.
      if (crossProduct === 0) {
        continue
      }
      
      paths.push(crossProduct > 0 ? [p1, p2, p3] : [p1, p3, p2])
    }
    
    if (onProgress) {
      onProgress(10) // Report initial parsing done
    }
    
    // Batch union to prevent ClipperLib from freezing on huge meshes (O(N log N) complexity)
    // We use a small yield to the event loop to keep the UI responsive during large imports
    const BATCH_SIZE = 20000
    let unionedPaths: Array<Array<{X: number, Y: number}>> = []
    
    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const batch = paths.slice(i, i + BATCH_SIZE)
      const batchUnion = unionClipperPaths(batch)
      if (unionedPaths.length === 0) {
        unionedPaths = batchUnion
      } else {
        unionedPaths = unionClipperPaths([...unionedPaths, ...batchUnion])
      }
      
      if (onProgress) {
        const percent = Math.min(95, 10 + Math.floor((i / paths.length) * 85))
        onProgress(percent)
      }
      
      // Yield to event loop every batch to keep UI responsive
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    
    if (onProgress) {
      onProgress(100)
    }
    
    polys = unionedPaths.map(path => path.map(p => ({ x: p.X / clipperScale, y: p.Y / clipperScale })))
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

  const points: Point[] = outerPoly.map(p => ({ x: p.x, y: p.y }))
  const profile = polygonProfile(points)

  return { profile, z_bottom, z_top }
}

export function renderStlTopViewToDataUrl(
  base64Data: string,
  scale: number,
  axisSwap: ModelAxisOrientation = 'none',
): string | null {
  let canvas: HTMLCanvasElement | undefined
  try {
    canvas = document.createElement('canvas')
  } catch {
    return null
  }

  const mesh = loadImportedTriangleMesh('stl', base64Data, axisSwap)
  if (!mesh) return null

  const { positions, index, bounds } = mesh
  const minX = bounds.minX * scale
  const maxX = bounds.maxX * scale
  const minY = bounds.minY * scale
  const maxY = bounds.maxY * scale
  const minZ = bounds.minZ * scale
  const maxZ = bounds.maxZ * scale

  const widthWorld = maxX - minX
  const heightWorld = maxY - minY
  const depthWorld = maxZ - minZ
  if (!(widthWorld > 1e-9) || !(heightWorld > 1e-9)) return null

  const MAX_PX = 1024
  const imageScale = MAX_PX / Math.max(widthWorld, heightWorld)
  const canvasW = Math.max(1, Math.round(widthWorld * imageScale))
  const canvasH = Math.max(1, Math.round(heightWorld * imageScale))
  canvas.width = canvasW
  canvas.height = canvasH

  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, canvasW, canvasH)

  const triangles: Array<{
    ax: number; ay: number
    bx: number; by: number
    cx: number; cy: number
    z: number
    shade: number
  }> = []

  function px(vertexIndex: number): number {
    return ((positions[vertexIndex * 3] * scale) - minX) * imageScale
  }

  function py(vertexIndex: number): number {
    return ((positions[vertexIndex * 3 + 1] * scale) - minY) * imageScale
  }

  function pz(vertexIndex: number): number {
    return positions[vertexIndex * 3 + 2] * scale
  }

  for (let i = 0; i < index.length; i += 3) {
    const ia = index[i]
    const ib = index[i + 1]
    const ic = index[i + 2]
    const ax = px(ia), ay = py(ia), az = pz(ia)
    const bx = px(ib), by = py(ib), bz = pz(ib)
    const cx = px(ic), cy = py(ic), cz = pz(ic)
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(area) < 0.01) continue

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

    triangles.push({
      ax,
      ay,
      bx,
      by,
      cx,
      cy,
      z: (az + bz + cz) / 3,
      shade,
    })
  }

  triangles.sort((a, b) => a.z - b.z)

  for (const tri of triangles) {
    const zT = depthWorld > 1e-9 ? (tri.z - minZ) / depthWorld : 0.5
    const r = Math.round((52 + zT * 72) * tri.shade)
    const g = Math.round((92 + zT * 80) * tri.shade)
    const b = Math.round((118 + zT * 88) * tri.shade)

    ctx.beginPath()
    ctx.moveTo(tri.ax, tri.ay)
    ctx.lineTo(tri.bx, tri.by)
    ctx.lineTo(tri.cx, tri.cy)
    ctx.closePath()
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`
    ctx.fill()
  }

  return canvas.toDataURL('image/png')
}
