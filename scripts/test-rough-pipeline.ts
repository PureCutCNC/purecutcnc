/**
 * Rough Surface — Pipeline Diagnostic v3
 *
 * Loads the real cat STL via Three.js (no Manifold required), implements
 * the same custom mesh-slicing algorithm as roughSurface.ts, and verifies
 * that different Z levels produce different cross-sections.
 *
 * Run: npx tsx scripts/test-rough-pipeline.ts "/Users/frankp/Projects/purecutcnc/work/springycat-keyring.stl"
 */

import fs from 'node:fs'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// ── Custom mesh slicer (same as roughSurface.ts) ────────────────────────

const Z_EPS = 1e-8
const PT_EPS = 1e-6

interface Vec3 { x: number; y: number; z: number }

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

function edgeCrossZ(a: Vec3, b: Vec3, z: number): Vec3 | null {
  const dzA = a.z - z
  const dzB = b.z - z
  if (Math.abs(dzA) < Z_EPS) return a
  if (Math.abs(dzB) < Z_EPS) return b
  if (dzA * dzB > 0) return null
  const t = -dzA / (dzB - dzA)
  return lerp(a, b, t)
}

function sliceMeshAtZ(positions: Float32Array, index: Uint32Array, z: number): Array<Array<[number, number]>> {
  const segments: Array<[[number, number], [number, number]]> = []

  for (let i = 0; i < index.length; i += 3) {
    const i0 = index[i]; const i1 = index[i + 1]; const i2 = index[i + 2]
    const p0: Vec3 = { x: positions[i0 * 3], y: positions[i0 * 3 + 1], z: positions[i0 * 3 + 2] }
    const p1: Vec3 = { x: positions[i1 * 3], y: positions[i1 * 3 + 1], z: positions[i1 * 3 + 2] }
    const p2: Vec3 = { x: positions[i2 * 3], y: positions[i2 * 3 + 1], z: positions[i2 * 3 + 2] }

    const dz = [p0.z - z, p1.z - z, p2.z - z]
    const above = dz.filter(d => d > Z_EPS).length
    const below = dz.filter(d => d < -Z_EPS).length
    if (above === 0 || below === 0) continue

    const pts: Array<[number, number]> = []
    const e01 = edgeCrossZ(p0, p1, z); if (e01) pts.push([e01.x, e01.y])
    const e12 = edgeCrossZ(p1, p2, z); if (e12) pts.push([e12.x, e12.y])
    const e20 = edgeCrossZ(p2, p0, z); if (e20) pts.push([e20.x, e20.y])
    if (pts.length >= 2) segments.push([pts[0], pts[1]])
  }

  return chainSegments(segments)
}

function ptKey(x: number, y: number): string { return `${x.toFixed(6)},${y.toFixed(6)}` }

function chainSegments(segments: Array<[[number, number], [number, number]]>): Array<Array<[number, number]>> {
  if (segments.length === 0) return []
  const graph = new Map<string, { pt: [number, number]; neighbors: Array<{ key: string; pt: [number, number] }> }>()
  function ensureNode(x: number, y: number): string {
    const key = ptKey(x, y)
    if (!graph.has(key)) graph.set(key, { pt: [x, y], neighbors: [] })
    return key
  }
  for (const [a, b] of segments) {
    const ka = ensureNode(a[0], a[1]); const kb = ensureNode(b[0], b[1])
    graph.get(ka)!.neighbors.push({ key: kb, pt: b })
    graph.get(kb)!.neighbors.push({ key: ka, pt: a })
  }

  const visited = new Set<string>()
  const polygons: Array<Array<[number, number]>> = []
  for (const [startKey] of graph) {
    if (visited.has(startKey)) continue
    const poly: Array<[number, number]> = []
    let currentKey = startKey
    let prevKey: string | null = null
    while (true) {
      if (visited.has(currentKey)) break
      visited.add(currentKey)
      const node = graph.get(currentKey)!
      if (poly.length === 0) poly.push(node.pt)
      let next: { key: string; pt: [number, number] } | null = null
      for (const n of node.neighbors) { if (n.key !== prevKey) { next = n; break } }
      if (!next) break
      if (next.key === startKey) break
      poly.push(next.pt)
      prevKey = currentKey; currentKey = next.key
      if (poly.length > segments.length * 2) break
    }
    if (poly.length >= 3) {
      const first = poly[0]; const last = poly[poly.length - 1]
      if (Math.abs(last[0] - first[0]) > PT_EPS || Math.abs(last[1] - first[1]) > PT_EPS) poly.push(first)
      polygons.push(poly)
    }
  }
  return polygons
}

function polygonArea(pts: Array<[number, number]>): number {
  return Math.abs(pts.reduce((sum, p, i) => {
    const next = pts[(i + 1) % pts.length]
    return sum + p[0] * next[1] - next[0] * p[1]
  }, 0) / 2)
}

function polygonSummary(pts: Array<[number, number]>, label: string): void {
  const xs = pts.map(p => p[0]); const ys = pts.map(p => p[1])
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length
  const cy = ys.reduce((a, b) => a + b, 0) / ys.length
  const minX = Math.min(...xs); const maxX = Math.max(...xs)
  const minY = Math.min(...ys); const maxY = Math.max(...ys)
  const area = polygonArea(pts)
  console.log(`  ${label}: verts=${pts.length} center=(${cx.toFixed(4)},${cy.toFixed(4)}) ` +
    `x=[${minX.toFixed(4)}..${maxX.toFixed(4)}] y=[${minY.toFixed(4)}..${maxY.toFixed(4)}] area=${area.toFixed(4)}`)
}

async function run(): Promise<void> {
  console.log('=== Rough Surface — Pipeline Diagnostic v3 (custom mesh slicer) ===\n')

  const stlPath = process.argv[2]
  if (!stlPath || !fs.existsSync(stlPath)) {
    console.error(`STL file not found: ${stlPath}`)
    process.exit(1)
  }

  console.log(`STL: ${stlPath}`)
  const buffer = fs.readFileSync(stlPath)
  console.log(`Size: ${buffer.length} bytes\n`)

  // ── 1. Three.js STL Loader ────────────────────────────────────────────
  console.log('=== Step 1: STL Loader ===')
  const loader = new STLLoader()
  let geometry = loader.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  console.log(`  Raw: ${geometry.attributes.position.count} vertices, ${geometry.attributes.position.count/3} triangles`)

  // ── 2. Merge vertices ─────────────────────────────────────────────────
  console.log('\n=== Step 2: Merge Vertices ===')
  geometry = BufferGeometryUtils.mergeVertices(geometry, 1e-5)
  const mergedVertCount = geometry.attributes.position.count
  const triCount = geometry.index ? geometry.index.count / 3 : 0
  console.log(`  After merge: ${mergedVertCount} vertices, ${triCount} triangles`)

  const rawPos = geometry.attributes.position.array as Float32Array

  // Compute raw Z bounds
  let rawMinX = Infinity, rawMaxX = -Infinity, rawMinY = Infinity, rawMaxY = -Infinity
  let rawMinZ = Infinity, rawMaxZ = -Infinity
  for (let i = 0; i < rawPos.length; i += 3) {
    const x = rawPos[i]; const y = rawPos[i+1]; const z = rawPos[i+2]
    if (x < rawMinX) rawMinX = x; if (x > rawMaxX) rawMaxX = x
    if (y < rawMinY) rawMinY = y; if (y > rawMaxY) rawMaxY = y
    if (z < rawMinZ) rawMinZ = z; if (z > rawMaxZ) rawMaxZ = z
  }
  console.log(`  Raw bbox: x=[${rawMinX.toFixed(4)}..${rawMaxX.toFixed(4)}]`)
  console.log(`            y=[${rawMinY.toFixed(4)}..${rawMaxY.toFixed(4)}]`)
  console.log(`            z=[${rawMinZ.toFixed(4)}..${rawMaxZ.toFixed(4)}] height=${(rawMaxZ - rawMinZ).toFixed(4)}`)

  // ── 3. Apply transformations (simulating buildFeatureSolid) ───────────
  console.log('\n=== Step 3: Transformations ===')
  const scale = 1
  const zTop = 0.75
  const zBottom = 0
  const meshHeight = rawMaxZ - rawMinZ
  const targetHeight = Math.max(0.1, Math.abs(zTop - zBottom))
  const zScale = targetHeight / ((meshHeight || 1) * scale)
  const angleDeg = 0
  const angleRad = (angleDeg * Math.PI) / 180
  const cosA = Math.cos(angleRad); const sinA = Math.sin(angleRad)
  const originX = 0; const originY = 0
  const bottomZ = Math.min(zTop, zBottom)

  console.log(`  scale=${scale}, zScale=${zScale.toFixed(6)}`)
  console.log(`  meshHeight=${meshHeight.toFixed(4)} -> targetHeight=${targetHeight.toFixed(4)}`)
  console.log(`  zTop=${zTop}, zBottom=${zBottom}`)

  const numVerts = rawPos.length / 3
  const transformedPos = new Float32Array(rawPos.length)
  for (let i = 0; i < numVerts; i++) {
    const ix = i * 3; const iy = i * 3 + 1; const iz = i * 3 + 2
    let x = rawPos[ix] * scale
    let y = rawPos[iy] * scale
    let z = rawPos[iz] * scale
    z -= rawMinZ * scale
    z *= zScale
    z += bottomZ
    const rx = x * cosA - y * sinA
    const ry = x * sinA + y * cosA
    x = rx; y = ry
    x += originX; y += originY
    transformedPos[ix] = x; transformedPos[iy] = y; transformedPos[iz] = z
  }

  let modelTopZ = -Infinity; let modelBottomZ = Infinity
  for (let i = 0; i < transformedPos.length; i += 3) {
    const z = transformedPos[i + 2]
    if (z > modelTopZ) modelTopZ = z
    if (z < modelBottomZ) modelBottomZ = z
  }
  console.log(`  Transformed Z: [${modelBottomZ.toFixed(4)}..${modelTopZ.toFixed(4)}]`)

  // ── 4. Slice at multiple Z levels ────────────────────────────────────
  console.log('\n=== Step 4: Custom Mesh Slicing ===')
  const stepdown = 0.1
  const stepLevels: number[] = []
  for (let z = modelTopZ; z > modelBottomZ + 0.001; z -= stepdown) stepLevels.push(z)
  if (stepLevels.length === 0 || stepLevels[stepLevels.length-1] > modelBottomZ) stepLevels.push(modelBottomZ)

  const index = new Uint32Array(geometry.index!.array)
  console.log(`  ${stepLevels.length} levels: ${stepLevels.map(z => z.toFixed(4)).join(', ')}\n`)

  let prevArea = -1
  let sameCount = 0

  for (const z of stepLevels) {
    const polygons = sliceMeshAtZ(transformedPos, index, z)
    if (polygons.length === 0) {
      console.log(`  Z=${z.toFixed(4)}: EMPTY`)
      continue
    }
    console.log(`  Z=${z.toFixed(4)}: ${polygons.length} polygon(s)`)
    polygons.forEach((poly, idx) => polygonSummary(poly, `poly[${idx}]`))

    if (polygons.length > 0) {
      const area = polygonArea(polygons[0])
      if (prevArea >= 0 && Math.abs(area - prevArea) < 0.01) sameCount++
      prevArea = area
    }
  }

  // ── Result ────────────────────────────────────────────────────────────
  console.log(`\n=== RESULT ===`)
  if (sameCount >= stepLevels.length - 1) {
    console.log(`❌ VERTICAL WALL: ${sameCount}/${stepLevels.length-1} adjacent levels same area`)
  } else {
    console.log(`✅ DIFFERENT SHAPES: only ${sameCount} duplicate(s)`)
  }
  console.log('\n=== Done ===')
}

run().catch((err) => { console.error('Script failed:', err); process.exit(1) })
