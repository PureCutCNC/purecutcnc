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
import type { PersistedImportedMesh } from '../types/project'

export type ImportedModelFormat = 'stl' | 'obj'
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

export type ImportedSourceData = string | ArrayBuffer

interface CachedGeometryEntry {
  sourceData: ImportedSourceData
  geometry: THREE.BufferGeometry
}

interface CachedTriangleMeshEntry {
  sourceData: ImportedSourceData
  mesh: ImportedTriangleMesh
}

interface CachedPersistedTriangleMeshEntry {
  positionsData: string
  indicesData: string
  mesh: ImportedTriangleMesh
}

interface CachedPersistedGeometryEntry {
  positionsData: string
  indicesData: string
  geometry: THREE.BufferGeometry
}

interface CachedPersistedGeometryChunksEntry {
  positionsData: string
  indicesData: string
  geometries: THREE.BufferGeometry[]
}

/**
 * Maximum index value representable in a Uint16Array. Chunks must stay at or
 * below this vertex count so their index buffers can be Uint16 — Chrome on
 * macOS mis-renders Uint32-indexed BufferGeometry, so we mirror the chunking
 * pattern used by simulation/gpuMesh.ts.
 */
export const MAX_UINT16_INDEX = 65535

const GEOMETRY_CACHE_LIMIT = 6
const TRIANGLE_MESH_CACHE_LIMIT = 6
const geometryCache = new Map<string, CachedGeometryEntry>()
const triangleMeshCache = new Map<string, CachedTriangleMeshEntry>()
const persistedTriangleMeshCache = new Map<string, CachedPersistedTriangleMeshEntry>()
const persistedGeometryCache = new Map<string, CachedPersistedGeometryEntry>()
const persistedGeometryChunksCache = new Map<string, CachedPersistedGeometryChunksEntry>()

export function clearImportedSourceCaches(): void {
  for (const entry of geometryCache.values()) {
    entry.geometry.dispose()
  }
  geometryCache.clear()
  triangleMeshCache.clear()
}

export function clearImportedModelCaches(): void {
  clearImportedSourceCaches()
  persistedTriangleMeshCache.clear()
  for (const entry of persistedGeometryCache.values()) {
    entry.geometry.dispose()
  }
  persistedGeometryCache.clear()
  for (const entry of persistedGeometryChunksCache.values()) {
    for (const geometry of entry.geometries) {
      geometry.dispose()
    }
  }
  persistedGeometryChunksCache.clear()
}

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

function encodeBytesToBase64(bytes: Uint8Array): string {
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    const CHUNK_SIZE = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE)
      for (let j = 0; j < chunk.length; j += 1) {
        binary += String.fromCharCode(chunk[j])
      }
    }
    return window.btoa(binary)
  }

  const maybeBuffer = (globalThis as {
    Buffer?: { from: (data: Uint8Array) => { toString: (encoding: 'base64') => string } }
  }).Buffer
  if (maybeBuffer) {
    return maybeBuffer.from(bytes).toString('base64')
  }

  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let output = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    output += chars[a >> 2]
    output += chars[((a & 3) << 4) | (b >> 4)]
    output += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '='
    output += i + 2 < bytes.length ? chars[c & 63] : '='
  }
  return output
}

function decodeSourceData(data: ImportedSourceData): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data
  return decodeBase64Data(data)
}

function decodeSourceText(data: ImportedSourceData): string | null {
  const buffer = decodeSourceData(data)
  if (!buffer) return null

  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  } catch {
    return null
  }
}

export function normalizeImportedMeshForStorage(mesh: ImportedTriangleMesh, scale: number): ImportedTriangleMesh {
  const positions = new Float32Array(mesh.positions.length)
  for (let i = 0; i < mesh.positions.length; i += 1) {
    positions[i] = mesh.positions[i] * scale
  }
  const index = new Uint32Array(mesh.index)
  return { positions, index, bounds: computeMeshBounds(positions) }
}

export function serializeImportedMesh(
  mesh: ImportedTriangleMesh,
  sourceFormat?: ImportedModelFormat,
): PersistedImportedMesh {
  return {
    storage: 'mesh-v1',
    sourceFormat,
    vertexCount: mesh.positions.length / 3,
    triangleCount: mesh.index.length / 3,
    positions: encodeBytesToBase64(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength)),
    indices: encodeBytesToBase64(new Uint8Array(mesh.index.buffer, mesh.index.byteOffset, mesh.index.byteLength)),
    bounds: { ...mesh.bounds },
  }
}

export function deserializeImportedMesh(mesh: PersistedImportedMesh): ImportedTriangleMesh | null {
  if (mesh.storage !== 'mesh-v1') return null

  const positionBuffer = decodeBase64Data(mesh.positions)
  const indexBuffer = decodeBase64Data(mesh.indices)
  if (!positionBuffer || !indexBuffer) return null
  if (positionBuffer.byteLength !== mesh.vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT) return null
  if (indexBuffer.byteLength !== mesh.triangleCount * 3 * Uint32Array.BYTES_PER_ELEMENT) return null

  return {
    positions: new Float32Array(positionBuffer),
    index: new Uint32Array(indexBuffer),
    bounds: { ...mesh.bounds },
  }
}

function cacheKey(
  format: ImportedModelFormat,
  sourceData: ImportedSourceData,
  axisOrientation: ModelAxisOrientation,
  mergeVertices: boolean,
): string {
  return [
    format,
    axisOrientation,
    mergeVertices ? 'merged' : 'raw',
    sourceDataLength(sourceData),
  ].join('|')
}

function sourceDataLength(sourceData: ImportedSourceData): number {
  return typeof sourceData === 'string' ? sourceData.length : sourceData.byteLength
}

function sameSourceData(a: ImportedSourceData, b: ImportedSourceData): boolean {
  return a === b
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

function getCachedGeometry(key: string, sourceData: ImportedSourceData): THREE.BufferGeometry | null {
  const entry = geometryCache.get(key)
  if (!entry || !sameSourceData(entry.sourceData, sourceData)) return null

  geometryCache.delete(key)
  geometryCache.set(key, entry)
  return entry.geometry.clone()
}

function setCachedGeometry(key: string, sourceData: ImportedSourceData, geometry: THREE.BufferGeometry): void {
  geometryCache.set(key, { sourceData, geometry: geometry.clone() })
  while (geometryCache.size > GEOMETRY_CACHE_LIMIT) {
    const oldestKey = geometryCache.keys().next().value
    if (!oldestKey) break
    const entry = geometryCache.get(oldestKey)
    entry?.geometry.dispose()
    geometryCache.delete(oldestKey)
  }
}

function persistedMeshCacheKey(mesh: PersistedImportedMesh, mergeVertices?: boolean): string {
  return [
    mesh.storage,
    mesh.sourceFormat ?? 'unknown',
    mesh.vertexCount,
    mesh.triangleCount,
    mesh.positions.length,
    mesh.indices.length,
    mergeVertices ? 'merged' : 'raw',
  ].join('|')
}

function getCachedPersistedTriangleMesh(key: string, mesh: PersistedImportedMesh): ImportedTriangleMesh | null {
  const entry = persistedTriangleMeshCache.get(key)
  if (!entry || entry.positionsData !== mesh.positions || entry.indicesData !== mesh.indices) return null

  persistedTriangleMeshCache.delete(key)
  persistedTriangleMeshCache.set(key, entry)
  return entry.mesh
}

function setCachedPersistedTriangleMesh(key: string, persisted: PersistedImportedMesh, mesh: ImportedTriangleMesh): void {
  persistedTriangleMeshCache.set(key, {
    positionsData: persisted.positions,
    indicesData: persisted.indices,
    mesh,
  })
  while (persistedTriangleMeshCache.size > TRIANGLE_MESH_CACHE_LIMIT) {
    const oldestKey = persistedTriangleMeshCache.keys().next().value
    if (!oldestKey) break
    persistedTriangleMeshCache.delete(oldestKey)
  }
}

function getCachedPersistedGeometry(key: string, mesh: PersistedImportedMesh): THREE.BufferGeometry | null {
  const entry = persistedGeometryCache.get(key)
  if (!entry || entry.positionsData !== mesh.positions || entry.indicesData !== mesh.indices) return null

  persistedGeometryCache.delete(key)
  persistedGeometryCache.set(key, entry)
  return entry.geometry.clone()
}

function setCachedPersistedGeometry(key: string, persisted: PersistedImportedMesh, geometry: THREE.BufferGeometry): void {
  persistedGeometryCache.set(key, {
    positionsData: persisted.positions,
    indicesData: persisted.indices,
    geometry: geometry.clone(),
  })
  while (persistedGeometryCache.size > GEOMETRY_CACHE_LIMIT) {
    const oldestKey = persistedGeometryCache.keys().next().value
    if (!oldestKey) break
    const entry = persistedGeometryCache.get(oldestKey)
    entry?.geometry.dispose()
    persistedGeometryCache.delete(oldestKey)
  }
}

export function loadPersistedTriangleMesh(mesh: PersistedImportedMesh): ImportedTriangleMesh | null {
  const key = persistedMeshCacheKey(mesh)
  const cached = getCachedPersistedTriangleMesh(key, mesh)
  if (cached) return cached

  const decoded = deserializeImportedMesh(mesh)
  if (!decoded) return null

  setCachedPersistedTriangleMesh(key, mesh, decoded)
  return decoded
}

export function triangleMeshToBufferGeometry(
  mesh: ImportedTriangleMesh,
  mergeVertices: boolean,
): THREE.BufferGeometry {
  let geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.positions), 3))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.index), 1))

  if (mergeVertices) {
    geometry = BufferGeometryUtils.mergeVertices(geometry, 1e-5)
  }

  geometry.computeVertexNormals()
  return geometry
}

/**
 * Build a list of render-safe BufferGeometry chunks from a triangle mesh. Each
 * chunk has a Uint16Array index buffer and at most MAX_UINT16_INDEX vertices.
 *
 * For meshes that fit in one chunk this returns a single-element array. For
 * larger meshes triangles are walked in order and assigned to chunks greedily:
 * when adding the next triangle would push the chunk's unique-vertex count over
 * MAX_UINT16_INDEX, the current chunk is finalised and a new one is started.
 * Vertices referenced from triangles in two chunks are duplicated — that is
 * the price of the Uint16 invariant.
 */
export function triangleMeshToBufferGeometryChunks(
  mesh: ImportedTriangleMesh,
  mergeVertices: boolean,
): THREE.BufferGeometry[] {
  const positions = mesh.positions
  const index = mesh.index
  const triangleCount = index.length / 3
  const vertexCount = positions.length / 3

  if (vertexCount <= MAX_UINT16_INDEX) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(index), 1))
    const finalized = mergeVertices ? BufferGeometryUtils.mergeVertices(geometry, 1e-5) : geometry
    finalized.computeVertexNormals()
    return [finalized]
  }

  const chunks: THREE.BufferGeometry[] = []
  let chunkPositions: number[] = []
  let chunkIndices: number[] = []
  let oldToNew = new Map<number, number>()

  const finalizeChunk = (): void => {
    if (chunkIndices.length === 0) return
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(chunkPositions), 3))
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(chunkIndices), 1))
    const finalized = mergeVertices ? BufferGeometryUtils.mergeVertices(geometry, 1e-5) : geometry
    finalized.computeVertexNormals()
    chunks.push(finalized)
    chunkPositions = []
    chunkIndices = []
    oldToNew = new Map<number, number>()
  }

  for (let t = 0; t < triangleCount; t += 1) {
    const a = index[t * 3]
    const b = index[t * 3 + 1]
    const c = index[t * 3 + 2]

    // Count how many distinct new vertices this triangle would add.
    const needsA = !oldToNew.has(a)
    const needsB = !oldToNew.has(b) && b !== a
    const needsC = !oldToNew.has(c) && c !== a && c !== b
    let newVerts = 0
    if (needsA) newVerts += 1
    if (needsB) newVerts += 1
    if (needsC) newVerts += 1

    if (oldToNew.size + newVerts > MAX_UINT16_INDEX && chunkIndices.length > 0) {
      finalizeChunk()
    }

    const remap = (orig: number): number => {
      let mapped = oldToNew.get(orig)
      if (mapped === undefined) {
        mapped = oldToNew.size
        oldToNew.set(orig, mapped)
        const base = orig * 3
        chunkPositions.push(positions[base], positions[base + 1], positions[base + 2])
      }
      return mapped
    }

    chunkIndices.push(remap(a), remap(b), remap(c))
  }

  finalizeChunk()
  return chunks
}

function getCachedPersistedGeometryChunks(
  key: string,
  mesh: PersistedImportedMesh,
): THREE.BufferGeometry[] | null {
  const entry = persistedGeometryChunksCache.get(key)
  if (!entry || entry.positionsData !== mesh.positions || entry.indicesData !== mesh.indices) return null

  persistedGeometryChunksCache.delete(key)
  persistedGeometryChunksCache.set(key, entry)
  return entry.geometries.map((g) => g.clone())
}

function setCachedPersistedGeometryChunks(
  key: string,
  persisted: PersistedImportedMesh,
  geometries: THREE.BufferGeometry[],
): void {
  persistedGeometryChunksCache.set(key, {
    positionsData: persisted.positions,
    indicesData: persisted.indices,
    geometries: geometries.map((g) => g.clone()),
  })
  while (persistedGeometryChunksCache.size > GEOMETRY_CACHE_LIMIT) {
    const oldestKey = persistedGeometryChunksCache.keys().next().value
    if (!oldestKey) break
    const entry = persistedGeometryChunksCache.get(oldestKey)
    if (entry) {
      for (const geometry of entry.geometries) geometry.dispose()
    }
    persistedGeometryChunksCache.delete(oldestKey)
  }
}

export function loadPersistedBufferGeometry(
  mesh: PersistedImportedMesh,
  mergeVertices: boolean,
): THREE.BufferGeometry | null {
  const key = persistedMeshCacheKey(mesh, mergeVertices)
  const cached = getCachedPersistedGeometry(key, mesh)
  if (cached) return cached

  const triangleMesh = loadPersistedTriangleMesh(mesh)
  if (!triangleMesh) return null

  const geometry = triangleMeshToBufferGeometry(triangleMesh, mergeVertices)
  setCachedPersistedGeometry(key, mesh, geometry)
  return geometry
}

export function loadPersistedBufferGeometryChunks(
  mesh: PersistedImportedMesh,
  mergeVertices: boolean,
): THREE.BufferGeometry[] | null {
  const key = `${persistedMeshCacheKey(mesh, mergeVertices)}|chunks`
  const cached = getCachedPersistedGeometryChunks(key, mesh)
  if (cached) return cached

  const triangleMesh = loadPersistedTriangleMesh(mesh)
  if (!triangleMesh) return null

  const chunks = triangleMeshToBufferGeometryChunks(triangleMesh, mergeVertices)
  setCachedPersistedGeometryChunks(key, mesh, chunks)
  return chunks
}

export function loadStlBufferGeometry(
  fileData: ImportedSourceData,
  axisOrientation: ModelAxisOrientation,
  mergeVertices: boolean,
): THREE.BufferGeometry | null {
  const key = cacheKey('stl', fileData, axisOrientation, mergeVertices)
  const cached = getCachedGeometry(key, fileData)
  if (cached) return cached

  const buffer = decodeSourceData(fileData)
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

function parseObjVertexIndex(token: string, vertexCount: number): number | null {
  const slashIndex = token.indexOf('/')
  const rawVertexIndex = slashIndex >= 0 ? token.slice(0, slashIndex) : token
  if (!rawVertexIndex) return null

  const parsedIndex = Number.parseInt(rawVertexIndex, 10)
  if (!Number.isInteger(parsedIndex) || parsedIndex === 0) return null

  const resolvedIndex = parsedIndex > 0 ? parsedIndex - 1 : vertexCount + parsedIndex
  return resolvedIndex >= 0 && resolvedIndex < vertexCount ? resolvedIndex : null
}

function forEachObjLogicalLine(text: string, callback: (line: string) => boolean | void): boolean {
  let start = 0
  let continuedLine = ''

  while (start <= text.length) {
    const newlineIndex = text.indexOf('\n', start)
    const end = newlineIndex >= 0 ? newlineIndex : text.length
    let line = text.slice(start, end)
    if (line.endsWith('\r')) line = line.slice(0, -1)

    const trimmedRight = line.trimEnd()
    if (trimmedRight.endsWith('\\')) {
      continuedLine += `${trimmedRight.slice(0, -1)} `
    } else {
      const logicalLine = continuedLine ? continuedLine + line : line
      continuedLine = ''
      if (callback(logicalLine) === false) return false
    }

    if (newlineIndex < 0) break
    start = newlineIndex + 1
  }

  if (continuedLine && callback(continuedLine) === false) return false
  return true
}

function uncommentAndTrimObjLine(line: string): string {
  const commentIndex = line.indexOf('#')
  const uncommented = commentIndex >= 0 ? line.slice(0, commentIndex) : line
  return uncommented.trim()
}

function countObjFaceTriangles(parts: string[], vertexCount: number): number {
  if (parts.length < 4) return 0

  let faceVertexCount = 0
  for (let i = 1; i < parts.length; i += 1) {
    const vertexIndex = parseObjVertexIndex(parts[i], vertexCount)
    if (vertexIndex === null) return 0
    faceVertexCount += 1
  }

  return faceVertexCount >= 3 ? faceVertexCount - 2 : 0
}

function parseObjTriangleMesh(objText: string): ImportedTriangleMesh | null {
  let vertexCount = 0
  let triangleCount = 0

  const counted = forEachObjLogicalLine(objText, (line) => {
    const uncommentedLine = uncommentAndTrimObjLine(line)
    if (!uncommentedLine) return

    const parts = uncommentedLine.split(/\s+/)
    const keyword = parts[0]

    if (keyword === 'v') {
      vertexCount += 1
      return
    }

    if (keyword !== 'f') return
    triangleCount += countObjFaceTriangles(parts, vertexCount)
  })

  if (!counted || vertexCount === 0 || triangleCount === 0) return null

  const positions = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(triangleCount * 3)
  const faceIndices: number[] = []
  let positionOffset = 0
  let indexOffset = 0
  let currentVertexCount = 0

  const filled = forEachObjLogicalLine(objText, (line) => {
    const uncommentedLine = uncommentAndTrimObjLine(line)
    if (!uncommentedLine) return

    const parts = uncommentedLine.split(/\s+/)
    const keyword = parts[0]

    if (keyword === 'v') {
      if (parts.length < 4) return false
      const x = Number.parseFloat(parts[1])
      const y = Number.parseFloat(parts[2])
      const z = Number.parseFloat(parts[3])
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
      positions[positionOffset] = x
      positions[positionOffset + 1] = y
      positions[positionOffset + 2] = z
      positionOffset += 3
      currentVertexCount += 1
      return
    }

    if (keyword !== 'f' || parts.length < 4) return

    faceIndices.length = 0
    for (let i = 1; i < parts.length; i += 1) {
      const vertexIndex = parseObjVertexIndex(parts[i], currentVertexCount)
      if (vertexIndex === null) {
        faceIndices.length = 0
        break
      }
      faceIndices.push(vertexIndex)
    }

    if (faceIndices.length < 3) return

    const firstIndex = faceIndices[0]
    for (let i = 1; i < faceIndices.length - 1; i += 1) {
      indices[indexOffset] = firstIndex
      indices[indexOffset + 1] = faceIndices[i]
      indices[indexOffset + 2] = faceIndices[i + 1]
      indexOffset += 3
    }
  })

  if (!filled || positionOffset !== positions.length || indexOffset === 0) return null

  return {
    positions,
    index: indexOffset === indices.length ? indices : indices.slice(0, indexOffset),
    bounds: computeMeshBounds(positions),
  }
}

export function loadObjTriangleMesh(
  fileData: ImportedSourceData,
  axisOrientation: ModelAxisOrientation,
): ImportedTriangleMesh | null {
  const key = cacheKey('obj', fileData, axisOrientation, true)
  const cached = getCachedTriangleMesh(key, fileData)
  if (cached) return cached

  const text = decodeSourceText(fileData)
  if (!text) return null

  const mesh = parseObjTriangleMesh(text)
  if (!mesh) return null

  applyAxisOrientationToPositions(mesh.positions, axisOrientation)
  mesh.bounds = computeMeshBounds(mesh.positions)
  setCachedTriangleMesh(key, fileData, mesh)
  return mesh
}

export function loadObjBufferGeometry(
  fileData: ImportedSourceData,
  axisOrientation: ModelAxisOrientation,
  mergeVertices: boolean,
): THREE.BufferGeometry | null {
  const key = cacheKey('obj', fileData, axisOrientation, mergeVertices)
  const cached = getCachedGeometry(key, fileData)
  if (cached) return cached

  const mesh = loadObjTriangleMesh(fileData, axisOrientation)
  if (!mesh) return null

  const geometry = triangleMeshToBufferGeometry(mesh, mergeVertices)
  setCachedGeometry(key, fileData, geometry)
  return geometry
}

export function loadImportedBufferGeometry(
  format: ImportedModelFormat,
  fileData: ImportedSourceData,
  axisOrientation: ModelAxisOrientation,
  mergeVertices: boolean,
): THREE.BufferGeometry | null {
  switch (format) {
    case 'stl':
      return loadStlBufferGeometry(fileData, axisOrientation, mergeVertices)
    case 'obj':
      return loadObjBufferGeometry(fileData, axisOrientation, mergeVertices)
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

function getCachedTriangleMesh(key: string, fileData: ImportedSourceData): ImportedTriangleMesh | null {
  const entry = triangleMeshCache.get(key)
  if (!entry || !sameSourceData(entry.sourceData, fileData)) return null

  triangleMeshCache.delete(key)
  triangleMeshCache.set(key, entry)
  return entry.mesh
}

function setCachedTriangleMesh(key: string, fileData: ImportedSourceData, mesh: ImportedTriangleMesh): void {
  triangleMeshCache.set(key, { sourceData: fileData, mesh })
  while (triangleMeshCache.size > TRIANGLE_MESH_CACHE_LIMIT) {
    const oldestKey = triangleMeshCache.keys().next().value
    if (!oldestKey) break
    triangleMeshCache.delete(oldestKey)
  }
}

export function loadStlTriangleMesh(
  fileData: ImportedSourceData,
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
  fileData: ImportedSourceData,
  axisOrientation: ModelAxisOrientation,
): ImportedTriangleMesh | null {
  switch (format) {
    case 'stl':
      return loadStlTriangleMesh(fileData, axisOrientation)
    case 'obj':
      return loadObjTriangleMesh(fileData, axisOrientation)
  }
}
