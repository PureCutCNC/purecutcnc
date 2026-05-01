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

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { getManifoldModule } from '../engine/csg'
import { polygonProfile, profileVertices, type Point, type SketchProfile } from '../types/project'
import { unionClipperPaths } from '../store/helpers/clipping'

/** Cross-platform base64-to-binary-string decoder (works in browser and Node) */
function base64ToBinaryString(data: string): string {
  if (typeof window !== 'undefined') {
    return window.atob(data)
  }
  // Node.js fallback using a pure-JS approach
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
  let result = ''
  const blocks = data.replace(/[^A-Za-z0-9+/=]/g, '')
  for (let i = 0; i < blocks.length; i += 4) {
    const a = chars.indexOf(blocks[i])
    const b = chars.indexOf(blocks[i + 1])
    const c = chars.indexOf(blocks[i + 2])
    const d = chars.indexOf(blocks[i + 3])
    result += String.fromCharCode((a << 2) | (b >> 4))
    if (c !== 64) result += String.fromCharCode(((b & 15) << 4) | (c >> 2))
    if (d !== 64) result += String.fromCharCode(((c & 3) << 6) | d)
  }
  return result
}

function applyAxisSwapToPositions(
  positions: ArrayLike<number> & { [index: number]: number },
  axisSwap: 'none' | 'yz' | 'xz' | 'xy',
): void {
  if (axisSwap === 'none') return

  for (let i = 0; i < positions.length; i += 3) {
    if (axisSwap === 'yz') {
      const tmp = positions[i + 1]
      positions[i + 1] = positions[i + 2]
      positions[i + 2] = tmp
    } else if (axisSwap === 'xz') {
      const tmp = positions[i]
      positions[i] = positions[i + 2]
      positions[i + 2] = tmp
    } else if (axisSwap === 'xy') {
      const tmp = positions[i]
      positions[i] = positions[i + 1]
      positions[i + 1] = tmp
    }
  }
}

export async function extractStlProfileAndBounds(
  base64Data: string,
  scale: number,
  axisSwap: 'none' | 'yz' | 'xz' | 'xy' = 'none',
  onProgress?: (percent: number) => void
): Promise<{ profile: SketchProfile, z_bottom: number, z_top: number } | null> {
  const binaryString = base64ToBinaryString(base64Data)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  const loader = new STLLoader()
  let geometry = loader.parse(bytes.buffer)
  
  // Critical: STLLoader returns non-indexed triangle soup.
  // Manifold requires an indexed mesh to identify shared edges.
  geometry = BufferGeometryUtils.mergeVertices(geometry, 1e-5)
  
  // Compute Z bounds
  geometry.computeBoundingBox()
  const bbox = geometry.boundingBox
  const z_bottom = bbox ? bbox.min.z * scale : 0
  const z_top = bbox ? bbox.max.z * scale : 5

  const positions = geometry.attributes.position.array
  const numVerts = positions.length / 3
  let triVerts: Uint32Array

  if (geometry.index) {
    triVerts = new Uint32Array(geometry.index.array)
  } else {
    triVerts = new Uint32Array(numVerts)
    for (let i = 0; i < numVerts; i++) {
      triVerts[i] = i
    }
  }

  // Apply axis swap if requested
  applyAxisSwapToPositions(positions as any, axisSwap)

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
      
      // Compute 2D cross product to determine winding
      const crossProduct = (p2.X - p1.X) * (p3.Y - p1.Y) - (p2.Y - p1.Y) * (p3.X - p1.X)
      
      // Skip completely flat/degenerate triangles in 2D projection
      // Also skip "backfaces" (CW triangles) to cut work in half; the silhouette is typically 
      // defined by the boundary of the front faces anyway.
      if (crossProduct <= 0) {
        continue
      }
      
      paths.push([p1, p2, p3])
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
  axisSwap: 'none' | 'yz' | 'xz' | 'xy' = 'none',
): string | null {
  let canvas: HTMLCanvasElement | undefined
  try {
    canvas = document.createElement('canvas')
  } catch {
    return null
  }

  const binaryString = base64ToBinaryString(base64Data)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  const loader = new STLLoader()
  const geometry = loader.parse(bytes.buffer)
  const positions = geometry.attributes.position.array
  applyAxisSwapToPositions(positions as any, axisSwap)

  const index = geometry.index
    ? Array.from(geometry.index.array as ArrayLike<number>)
    : Array.from({ length: positions.length / 3 }, (_, i) => i)

  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] * scale
    const y = positions[i + 1] * scale
    const z = positions[i + 2] * scale
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }

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

/**
 * Render a silhouette SketchProfile (from STL import) to a PNG data URL using
 * an offscreen canvas, and return positioning info for use as a backdrop.
 *
 * Returns null if the silhouette is degenerate or canvas is unavailable.
 */
export function renderSilhouetteToDataUrl(
  profile: SketchProfile,
): string | null {
  const verts = profileVertices(profile)
  if (verts.length < 3) return null

  // ── Bounding box ────────────────────────────────────────────────────────
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  for (const v of verts) {
    if (v.x < minX) minX = v.x
    if (v.x > maxX) maxX = v.x
    if (v.y < minY) minY = v.y
    if (v.y > maxY) maxY = v.y
  }
  const bboxW = maxX - minX
  const bboxH = maxY - minY
  if (bboxW < 1e-9 || bboxH < 1e-9) return null

  // ── Canvas dimensions (max 1024 on longest side) ──────────────────────
  const MAX_PX = 1024
  let canvasW: number
  let canvasH: number
  if (bboxW >= bboxH) {
    canvasW = MAX_PX
    canvasH = Math.max(1, Math.round(MAX_PX * (bboxH / bboxW)))
  } else {
    canvasH = MAX_PX
    canvasW = Math.max(1, Math.round(MAX_PX * (bboxW / bboxH)))
  }

  let canvas: HTMLCanvasElement | undefined
  try {
    canvas = document.createElement('canvas')
  } catch {
    return null // canvas not available
  }
  canvas.width = canvasW
  canvas.height = canvasH

  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // ── Scale: map bounding box to canvas pixels (no padding) ────────────
  const scale = canvasW / bboxW
  const originX = -minX
  const originY = -minY

  function sx(x: number): number { return (x + originX) * scale }
  // Model Y increases in the same direction as canvas Y, so no flip needed.
  function sy(y: number): number { return (y + originY) * scale }

  // ── Draw filled silhouette ──────────────────────────────────────────────
  // Saturated steel-blue fill — clearly visible against the dark sketch canvas
  ctx.fillStyle = '#4a7fa8'
  ctx.beginPath()
  ctx.moveTo(sx(verts[0].x), sy(verts[0].y))
  for (let i = 1; i < verts.length; i++) {
    ctx.lineTo(sx(verts[i].x), sy(verts[i].y))
  }
  ctx.closePath()
  ctx.fill()

  // Slightly brighter outline for edge definition
  ctx.strokeStyle = '#6b9fcb'
  ctx.lineWidth = 2
  ctx.stroke()

  return canvas.toDataURL('image/png')
}
