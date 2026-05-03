import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import ManifoldModule from 'manifold-3d'

async function run() {
  const filePath = '/Users/frankp/Projects/purecutcnc/work/springycat-keyring.stl'
  const buffer = fs.readFileSync(filePath)
  
  console.log(`Loading STL: ${filePath} (${buffer.length} bytes)`)

  const loader = new STLLoader()
  let geometry = loader.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  console.log(`Parsed STL: ${geometry.attributes.position.count} vertices (non-indexed)`)

  geometry = BufferGeometryUtils.mergeVertices(geometry, 1e-5)
  console.log(`Merged Vertices: ${geometry.attributes.position.count} vertices, ${geometry.index?.count ? geometry.index.count / 3 : 0} triangles`)

  const positions = geometry.attributes.position.array
  const numVerts = positions.length / 3
  
  let triVerts: Uint32Array
  if (geometry.index) {
    triVerts = new Uint32Array(geometry.index.array)
  } else {
    triVerts = new Uint32Array(numVerts)
    for (let i = 0; i < numVerts; i++) triVerts[i] = i
  }

  // Filter degenerate triangles
  const validTriangles: number[] = []
  let degenerateCount = 0
  for (let i = 0; i < triVerts.length; i += 3) {
    const a = triVerts[i]
    const b = triVerts[i + 1]
    const c = triVerts[i + 2]
    if (a === b || b === c || a === c) {
      degenerateCount++
    } else {
      validTriangles.push(a, b, c)
    }
  }
  console.log(`Found ${degenerateCount} degenerate triangles. Valid triangles: ${validTriangles.length / 3}`)
  
  const cleanTriVerts = new Uint32Array(validTriangles)

  const mesh = {
    numProp: 3,
    numVert: numVerts,
    numTri: cleanTriVerts.length / 3,
    vertProperties: new Float32Array(positions),
    triVerts: cleanTriVerts,
    halfedgeTangent: new Float32Array(0),
    runIndex: new Uint32Array([0]),
    runOriginalID: new Uint32Array([0]),
    runTransform: new Float32Array(12).fill(0),
    faceID: new Uint32Array(cleanTriVerts.length / 3).fill(0),
  }

  console.log('Initializing Manifold WASM...')
  const module = await ManifoldModule()
  module.setup()

  try {
    console.log('Constructing Manifold solid...')
    const solid = new module.Manifold(mesh)
    console.log('SUCCESS! Manifold constructed.')
    
    // Check if it's empty or valid
    console.log(`Solid bounds:`, solid.boundingBox())
    console.log(`Solid status:`, solid.status())
    
  } catch (error) {
    console.error('ERROR creating Manifold:', error)
  }
}

run().catch(console.error)
