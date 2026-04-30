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
import { polygonProfile, type Point, type SketchProfile } from '../types/project'
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
  if (axisSwap !== 'none') {
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
