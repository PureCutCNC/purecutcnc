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

/**
 * STEP tessellation against the real Open CASCADE WASM (issue #784).
 *
 * Fixtures are generated, so each case states the geometry it relies on. The
 * assertions are on what reaches the project — how many bodies, where they
 * sit, how far the mesh strays from the true surface — rather than on OCCT's
 * internal meshing choices.
 *
 * Run with: npx tsx src/import/stepTessellation.test.ts
 */

import occtimportjs from 'occt-import-js'
import {
  computeMeshBounds,
  concatenateTriangleMeshes,
  splitMeshByConnectedComponents,
  type ImportedMeshBounds,
  type ImportedTriangleMesh,
} from '../engine/importedMesh'
import { stepFile, stepWireframeFile, type StepFixtureSolid } from '../test/stepFixtures'
import { StepImportError, type StepImportErrorCode, type StepTessellationBody } from './stepProtocol'
import { occtDiagnostic, tessellateStep, type StepTessellationOptions } from './stepTessellation'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

const diagnostics: string[] = []
const occt = await occtimportjs({
  print: (line) => diagnostics.push(line),
  printErr: (line) => diagnostics.push(line),
})

const MM: StepTessellationOptions = { outputUnit: 'mm', linearDeflection: 0.01, maxTriangles: 1_000_000 }

/** Positions are stored as Float32: 50.8 comes back as 50.79999923706055. */
const FLOAT32_EPSILON = 1e-4

function tessellate(text: string, options: StepTessellationOptions = MM): StepTessellationBody[] {
  return tessellateStep(occt, new TextEncoder().encode(text), options, diagnostics)
}

function meshOf(body: StepTessellationBody): ImportedTriangleMesh {
  return { positions: body.positions, index: body.index, bounds: computeMeshBounds(body.positions) }
}

function box(min: [number, number, number], max: [number, number, number]): StepFixtureSolid {
  return { kind: 'box', min, max }
}

function boundsEqual(bounds: ImportedMeshBounds, min: readonly number[], max: readonly number[]): boolean {
  const actual = [bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ]
  const expected = [...min, ...max]
  return actual.every((value, i) => Math.abs(value - expected[i]) < FLOAT32_EPSILON)
}

function expectFailure(run: () => unknown, code: StepImportErrorCode): StepImportError {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof StepImportError && error.code === code) return error
    throw new Error(`expected ${code}, got ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  throw new Error(`expected ${code}, but nothing was thrown`)
}

/**
 * The chord error the surface tolerance bounds, measured on a Z-axis cylinder
 * centred on the origin: for every side-wall triangle edge joining two points
 * on the same rim, how far its midpoint sits inside the true radius. Cap
 * triangles are skipped — their interior diagonals are not rim chords.
 */
function maxRimChordError(mesh: ImportedTriangleMesh, radius: number, rimHeights: readonly number[]): number {
  const p = mesh.positions
  const rimOf = (vertex: number): number => {
    if (Math.abs(Math.hypot(p[vertex * 3], p[vertex * 3 + 1]) - radius) > FLOAT32_EPSILON) return -1
    return rimHeights.findIndex((z) => Math.abs(p[vertex * 3 + 2] - z) < FLOAT32_EPSILON)
  }

  let worst = 0
  for (let t = 0; t < mesh.index.length; t += 3) {
    const corners = [mesh.index[t], mesh.index[t + 1], mesh.index[t + 2]]
    const heights = corners.map((vertex) => p[vertex * 3 + 2])
    if (Math.max(...heights) - Math.min(...heights) < FLOAT32_EPSILON) continue
    for (let k = 0; k < 3; k += 1) {
      const a = corners[k]
      const b = corners[(k + 1) % 3]
      const rim = rimOf(a)
      if (rim < 0 || rim !== rimOf(b)) continue
      const midpointRadius = Math.hypot((p[a * 3] + p[b * 3]) / 2, (p[a * 3 + 1] + p[b * 3 + 1]) / 2)
      worst = Math.max(worst, radius - midpointRadius)
    }
  }
  return worst
}

console.log('stepTessellation')

test('one box imports as one body with the box extent', () => {
  const bodies = tessellate(stepFile([box([5, 5, 0], [45, 25, 10])]))
  assert(bodies.length === 1, `bodies: ${bodies.length}`)
  assert(bodies[0].index.length / 3 === 12, `triangles: ${bodies[0].index.length / 3}`)
  const { bounds } = meshOf(bodies[0])
  assert(boundsEqual(bounds, [5, 5, 0], [45, 25, 10]), JSON.stringify(bounds))
})

test('a single solid takes its product name', () => {
  const [body] = tessellate(stepFile([box([0, 0, 0], [10, 10, 10])], { productName: 'Bracket' }))
  assert(body.name === 'Bracket', `name: ${JSON.stringify(body.name)}`)
})

test('two solids are two bodies, in file order', () => {
  const bodies = tessellate(stepFile([box([0, 0, 0], [10, 10, 10]), box([20, 0, 0], [30, 10, 10])]))
  assert(bodies.length === 2, `bodies: ${bodies.length}`)
  assert(boundsEqual(meshOf(bodies[0]).bounds, [0, 0, 0], [10, 10, 10]), JSON.stringify(meshOf(bodies[0]).bounds))
  assert(boundsEqual(meshOf(bodies[1]).bounds, [20, 0, 0], [30, 10, 10]), JSON.stringify(meshOf(bodies[1]).bounds))
})

test('solids that touch stay separate bodies, where connectivity would merge them', () => {
  const bodies = tessellate(stepFile([box([0, 0, 0], [10, 10, 10]), box([10, 0, 0], [20, 10, 10])]))
  assert(bodies.length === 2, `bodies: ${bodies.length}`)
  const components = splitMeshByConnectedComponents(concatenateTriangleMeshes(bodies.map(meshOf)))
  assert(
    components.length === 1,
    `connectivity found ${components.length} components, so this fixture no longer shows why STEP bodies come from the file`,
  )
})

test('an inch file tessellated in inches keeps its numbers; in millimetres OCCT converts them', () => {
  const text = stepFile([box([0, 0, 0], [2, 1, 0.5])], { unit: 'inch' })
  const [inches] = tessellate(text, { ...MM, outputUnit: 'inch' })
  assert(boundsEqual(meshOf(inches).bounds, [0, 0, 0], [2, 1, 0.5]), JSON.stringify(meshOf(inches).bounds))
  const [millimetres] = tessellate(text, MM)
  assert(boundsEqual(meshOf(millimetres).bounds, [0, 0, 0], [50.8, 25.4, 12.7]), JSON.stringify(meshOf(millimetres).bounds))
})

test('a metre file converts to millimetres', () => {
  const [body] = tessellate(stepFile([box([0, 0, 0], [1, 0.5, 0.25])], { unit: 'm' }))
  assert(boundsEqual(meshOf(body).bounds, [0, 0, 0], [1000, 500, 250]), JSON.stringify(meshOf(body).bounds))
})

test('an undeclared file is not converted, whichever unit is requested', () => {
  const text = stepFile([box([0, 0, 0], [10, 10, 10])], { unit: 'none' })
  for (const outputUnit of ['mm', 'inch'] as const) {
    const [body] = tessellate(text, { ...MM, outputUnit })
    assert(boundsEqual(meshOf(body).bounds, [0, 0, 0], [10, 10, 10]), `${outputUnit}: ${JSON.stringify(meshOf(body).bounds)}`)
  }
})

test('the surface tolerance bounds the chord error, and a coarser one changes the mesh', () => {
  const text = stepFile([{ kind: 'cylinder', centre: [0, 0], radius: 10, zMin: 0, zMax: 5 }])
  const [fine] = tessellate(text, { ...MM, linearDeflection: 0.01 })
  const [coarse] = tessellate(text, { ...MM, linearDeflection: 0.5 })
  const fineError = maxRimChordError(meshOf(fine), 10, [0, 5])
  const coarseError = maxRimChordError(meshOf(coarse), 10, [0, 5])
  assert(fineError > 0, 'the fine mesh has rim chords to measure')
  assert(fineError <= 0.01 + 1e-5, `chord error ${fineError} exceeds the 0.01 mm tolerance`)
  assert(coarseError > 0.01, `the 0.5 mm mesh is no coarser than the 0.01 mm mesh (chord error ${coarseError})`)
})

test('tessellating the same file twice gives the same mesh', () => {
  const text = stepFile([{ kind: 'cylinder', centre: [3, 4], radius: 6, zMin: 1, zMax: 9 }])
  const [first] = tessellate(text)
  const [second] = tessellate(text)
  assert(
    first.positions.length === second.positions.length && first.positions.every((value, i) => value === second.positions[i]),
    'positions differ between runs',
  )
  assert(
    first.index.length === second.index.length && first.index.every((value, i) => value === second.index[i]),
    'indices differ between runs',
  )
})

test("text that is not STEP is unreadable, with OCCT's reason", () => {
  const error = expectFailure(() => tessellate('hello, this is not a STEP file'), 'unreadable')
  assert(error.detail?.includes('Incorrect syntax'), `detail: ${error.detail}`)
})

test('an empty file is unreadable', () => {
  expectFailure(() => tessellate(''), 'unreadable')
})

test('a file with only curves has no geometry', () => {
  expectFailure(() => tessellate(stepWireframeFile()), 'no-geometry')
})

test('the triangle cap admits exactly its count and refuses one more', () => {
  const text = stepFile([box([0, 0, 0], [10, 10, 10])])
  assert(tessellate(text, { ...MM, maxTriangles: 12 }).length === 1, 'a 12-triangle box fits a cap of 12')
  const error = expectFailure(() => tessellate(text, { ...MM, maxTriangles: 11 }), 'too-many-triangles')
  assert(error.limit === 11, `limit: ${error.limit}`)
})

test('the triangle cap counts every body together', () => {
  const text = stepFile([box([0, 0, 0], [10, 10, 10]), box([20, 0, 0], [30, 10, 10])])
  expectFailure(() => tessellate(text, { ...MM, maxTriangles: 23 }), 'too-many-triangles')
})

test('a tolerance that is not a positive number is refused before OCCT reads anything', () => {
  for (const linearDeflection of [0, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    // Unreadable text: had OCCT run first, this would fail as `unreadable`.
    expectFailure(() => tessellate('not STEP', { ...MM, linearDeflection }), 'invalid-tolerance')
  }
})

test("occtDiagnostic keeps the last error line without OCCT's decoration", () => {
  const detail = occtDiagnostic([
    'noise',
    '**** ERR StepFile : first ****',
    '**** ERR StepFile : Line 2: second    ****',
    'trailing information',
  ])
  assert(detail === 'Line 2: second', `detail: ${JSON.stringify(detail)}`)
  assert(occtDiagnostic(['nothing wrong']) === undefined, 'no error line, no detail')
})

console.log(`\n${passed} passed, ${failed} failed${failed > 0 ? ' ❌' : ' ✓'}\n`)

if (failed > 0) throw new Error(`${failed} test(s) failed`)
