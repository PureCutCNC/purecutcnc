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
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export type ImportedModelFormat = 'stl'
export type ModelAxisOrientation = 'none' | 'yz' | 'xz' | 'xy'

export interface ImportedMeshBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

export interface ImportedTriangleMesh {
  positions: Float32Array
  index: Uint32Array
  bounds: ImportedMeshBounds
}

interface CachedGeometryEntry {
  fileData: string
  geometry: THREE.BufferGeometry
}

interface CachedTriangleMeshEntry {
  fileData: string
  mesh: ImportedTriangleMesh
}

const GEOMETRY_CACHE_LIMIT = 6
const TRIANGLE_MESH_CACHE_LIMIT = 6
const geometryCache = new Map<string, CachedGeometryEntry>()
const triangleMeshCache = new Map<string, CachedTriangleMeshEntry>()

function decodeBase64Data(data: string): ArrayBuffer | null {
  const base64 = data.includes(',') ? data.split(',')[1] : data
  if (!base64) return null

  if (typeof window !== 'undefined' && typeof window.atob === 'function') {
    const binaryString = window.atob(base64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    return bytes.buffer
  }

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '')
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 4) {
    const a = chars.indexOf(clean[i])
    const b = chars.indexOf(clean[i + 1])
    const c = chars.indexOf(clean[i + 2])
    const d = chars.indexOf(clean[i + 3])
    if (a < 0 || b < 0) continue
    bytes.push((a << 2) | (b >> 4))
    if (c >= 0 && c !== 64) bytes.push(((b & 15) << 4) | (c >> 2))
    if (d >= 0 && d !== 64) bytes.push(((c & 3) << 6) | d)
  }

  return new Uint8Array(bytes).buffer
}

function cacheKey(
  format: 'stl',
  fileData: string,
  axisOrientation: ModelAxisOrientation,
  mergeVertices: boolean,
): string {
  return [
    format,
    axisOrientation,
    mergeVertices ? 'merged' : 'raw',
    fileData.length,
  ].join('|')
}

export function applyAxisOrientationToPositions(
  positions: ArrayLike<number> & { [index: number]: number },
  axisOrientation: ModelAxisOrientation,
): void {
  if (axisOrientation === 'none') return

  for (let i = 0; i < positions.length; i += 3) {
    if (axisOrientation === 'yz') {
      const tmp = positions[i + 1]
      positions[i + 1] = positions[i + 2]
      positions[i + 2] = tmp
    } else if (axisOrientation === 'xz') {
      const tmp = positions[i]
      positions[i] = positions[i + 2]
      positions[i + 2] = tmp
    } else if (axisOrientation === 'xy') {
      const tmp = positions[i]
      positions[i] = positions[i + 1]
      positions[i + 1] = tmp
    }
  }
}

function getCachedGeometry(key: string, fileData: string): THREE.BufferGeometry | null {
  const entry = geometryCache.get(key)
  if (!entry || entry.fileData !== fileData) return null

  geometryCache.delete(key)
  geometryCache.set(key, entry)
  return entry.geometry.clone()
}

function setCachedGeometry(key: string, fileData: string, geometry: THREE.BufferGeometry): void {
  geometryCache.set(key, { fileData, geometry: geometry.clone() })
  while (geometryCache.size > GEOMETRY_CACHE_LIMIT) {
    const oldestKey = geometryCache.keys().next().value
    if (!oldestKey) break
    const entry = geometryCache.get(oldestKey)
    entry?.geometry.dispose()
    geometryCache.delete(oldestKey)
  }
}

export function loadStlBufferGeometry(
  fileData: string,
  axisOrientation: ModelAxisOrientation,
  mergeVertices: boolean,
): THREE.BufferGeometry | null {
  const key = cacheKey('stl', fileData, axisOrientation, mergeVertices)
  const cached = getCachedGeometry(key, fileData)
  if (cached) return cached

  const buffer = decodeBase64Data(fileData)
  if (!buffer) return null

  const loader = new STLLoader()
  let geometry = loader.parse(buffer)
  applyAxisOrientationToPositions(geometry.attributes.position.array, axisOrientation)

  if (mergeVertices) {
    geometry = BufferGeometryUtils.mergeVertices(geometry, 1e-5)
  }

  setCachedGeometry(key, fileData, geometry)
  return geometry
}

export function loadImportedBufferGeometry(
  format: ImportedModelFormat,
  fileData: string,
  axisOrientation: ModelAxisOrientation,
  mergeVertices: boolean,
): THREE.BufferGeometry | null {
  switch (format) {
    case 'stl':
      return loadStlBufferGeometry(fileData, axisOrientation, mergeVertices)
  }
}

export function computeMeshBounds(positions: Float32Array): ImportedMeshBounds {
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }

  return { minX, maxX, minY, maxY, minZ, maxZ }
}

function getCachedTriangleMesh(key: string, fileData: string): ImportedTriangleMesh | null {
  const entry = triangleMeshCache.get(key)
  if (!entry || entry.fileData !== fileData) return null

  triangleMeshCache.delete(key)
  triangleMeshCache.set(key, entry)
  return entry.mesh
}

function setCachedTriangleMesh(key: string, fileData: string, mesh: ImportedTriangleMesh): void {
  triangleMeshCache.set(key, { fileData, mesh })
  while (triangleMeshCache.size > TRIANGLE_MESH_CACHE_LIMIT) {
    const oldestKey = triangleMeshCache.keys().next().value
    if (!oldestKey) break
    triangleMeshCache.delete(oldestKey)
  }
}

export function loadStlTriangleMesh(
  fileData: string,
  axisOrientation: ModelAxisOrientation,
): ImportedTriangleMesh | null {
  const key = cacheKey('stl', fileData, axisOrientation, true)
  const cached = getCachedTriangleMesh(key, fileData)
  if (cached) return cached

  const geometry = loadStlBufferGeometry(fileData, axisOrientation, true)
  if (!geometry) return null

  const rawPositions = geometry.attributes.position.array as ArrayLike<number>
  const positions = new Float32Array(rawPositions.length)
  for (let i = 0; i < rawPositions.length; i += 1) {
    positions[i] = rawPositions[i]
  }

  const numVerts = positions.length / 3
  let index: Uint32Array
  if (geometry.index) {
    index = new Uint32Array(geometry.index.array)
  } else {
    index = new Uint32Array(numVerts)
    for (let i = 0; i < numVerts; i += 1) {
      index[i] = i
    }
  }

  const mesh = { positions, index, bounds: computeMeshBounds(positions) }
  setCachedTriangleMesh(key, fileData, mesh)
  return mesh
}

export function loadImportedTriangleMesh(
  format: ImportedModelFormat,
  fileData: string,
  axisOrientation: ModelAxisOrientation,
): ImportedTriangleMesh | null {
  switch (format) {
    case 'stl':
      return loadStlTriangleMesh(fileData, axisOrientation)
  }
}
