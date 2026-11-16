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
 * The look from below, and the one list the two looks add up to (issue #1206
 * slice 4). Each block is a 60 x 40 x 20 plate cut by Manifold, run twice: the
 * detector on the mesh, and on `meshSeenFromBelow(mesh)` with the result mapped
 * back to stock space.
 *
 * Mutation checks (each made the named block fail, then was reverted):
 * - `faces.ts`, the result's spans not converted back             -> pocket in the underside
 * - `faces.ts`, rule 1 (Top wins a tie) removed                   -> through hole
 * - `faces.ts`, rule 2 (what one face draws is not reported) gone -> pocket in the underside
 * - `faces.ts`, rule 3 (one report per void) removed              -> drafted pocket
 * - `faces.ts`, an island kept with no parent                     -> through pocket with a pillar
 * - `faces.ts`, `meshSeenFromBelow` negating in place             -> the mesh copy
 *
 * Run with: npx tsx src/engine/modelRecognition/faces.test.ts
 */

import type { Manifold } from 'manifold-3d'
import { getManifoldModule } from '../csg'
import type { FlatFace } from '../../types/project'
import { candidatesFromResult } from './candidates'
import {
  combineFaces,
  meshSeenFromBelow,
  resultFromBelowToStock,
  type CombinedRecognition,
  type FaceRun,
} from './faces'
import { recognizeCavities } from './recognize'
import type { ModelRecognitionResult, RecognitionMesh, RecognizedCircle } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertNear(actual: number, expected: number, message: string, tolerance = 1e-3): void {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`)
}

const module = await getManifoldModule()
const { Manifold: M } = module

function plate(): Manifold {
  return M.cube([60, 40, 20])
}

function box(x: number, y: number, z: number, w: number, d: number, h: number): Manifold {
  return M.cube([w, d, h]).translate([x, y, z])
}

function cylinder(x: number, y: number, z: number, radius: number, height: number, segments = 32): Manifold {
  return M.cylinder(height, radius, radius, segments).translate([x, y, z])
}

/** A cone frustum, `radiusBottom` at `z` and `radiusTop` at `z + height`. */
function frustum(
  x: number, y: number, z: number,
  radiusBottom: number, radiusTop: number, height: number, segments = 32,
): Manifold {
  return M.cylinder(height, radiusBottom, radiusTop, segments).translate([x, y, z])
}

function toMesh(solid: Manifold): RecognitionMesh {
  const mesh = solid.getMesh()
  assert(mesh.numProp === 3 && mesh.triVerts.length > 0, 'fixture solid must not be empty')
  return { positions: new Float32Array(mesh.vertProperties), index: new Uint32Array(mesh.triVerts) }
}

/** One face's run, as `recognizeModelFaces` builds it. */
function runOf(mesh: RecognitionMesh, face: FlatFace): FaceRun {
  const result = recognizeCavities(mesh)
  const stockSpace: ModelRecognitionResult = face === 'bottom' ? resultFromBelowToStock(result) : result
  return {
    candidates: candidatesFromResult(stockSpace, face, 'mm', face === 'bottom' ? 'b-' : ''),
    skipped: stockSpace.skipped,
    skippedSolids: stockSpace.skippedSolids,
    meshOpen: stockSpace.meshOpen,
    levelsTruncated: stockSpace.levelsTruncated,
  }
}

/** Both looks at one part, combined: what the dialog would show. */
function recognizeBothFaces(solid: Manifold): CombinedRecognition {
  const mesh = toMesh(solid)
  return combineFaces(runOf(mesh, 'top'), runOf(meshSeenFromBelow(mesh), 'bottom'))
}

/** Just the look from above, for the comparison the slices must keep. */
function recognizeTopOnly(solid: Manifold): CombinedRecognition {
  return combineFaces(runOf(toMesh(solid), 'top'), null)
}

function cavitiesOf(result: CombinedRecognition): CombinedRecognition['candidates'] {
  return result.candidates.filter((candidate) => candidate.operation === 'subtract')
}

function solidsOf(result: CombinedRecognition): CombinedRecognition['candidates'] {
  return result.candidates.filter((candidate) => candidate.kind === 'solid')
}

function outlineBounds(entry: { outline: { x: number; y: number }[] }): {
  minX: number; maxX: number; minY: number; maxY: number
} {
  const xs = entry.outline.map((point) => point.x)
  const ys = entry.outline.map((point) => point.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

function assertSpan(entry: { zBottom: number; zTop: number }, zBottom: number, zTop: number, label: string): void {
  assertNear(entry.zBottom, zBottom, `${label}: bottom`)
  assertNear(entry.zTop, zTop, `${label}: top`)
}

/** A fitted circle, read the way the detector fitted it from the mesh's facets. */
function assertCircle(entry: { circle: RecognizedCircle | null }, x: number, y: number, radius: number, label: string): void {
  assert(entry.circle !== null, `${label}: is a circle`)
  assertNear(entry.circle!.center.x, x, `${label}: centre X`)
  assertNear(entry.circle!.center.y, y, `${label}: centre Y`)
  assertNear(entry.circle!.radius, radius, `${label}: radius`)
}

// ---------------------------------------------------------------------------
// A pocket in the underside is found from below, in stock space
// ---------------------------------------------------------------------------
{
  const combined = recognizeBothFaces(plate().subtract(box(5, 5, 0, 20, 10, 6)))
  const cavities = cavitiesOf(combined)
  assert(cavities.length === 1, `underside pocket: one cavity, got ${cavities.length}`)
  const [pocket] = cavities
  assert(pocket.face === 'bottom', 'underside pocket: the cavity is on Bottom')
  assertSpan(pocket, 0, 6, 'underside pocket')
  assert(pocket.bottom === 'flat', 'underside pocket: the walls end on a flat floor as the tool sees it')
  const bounds = outlineBounds(pocket)
  assertNear(bounds.minX, 5, 'underside pocket: min X')
  assertNear(bounds.maxX, 25, 'underside pocket: max X')
  assertNear(bounds.minY, 5, 'underside pocket: min Y')
  assertNear(bounds.maxY, 15, 'underside pocket: max Y')
  // What the look from above saw (a void covered by material) is not reported:
  // Bottom draws it.
  assert(combined.skipped.length === 0, `underside pocket: nothing skipped, got ${combined.skipped.length}`)
}

// ---------------------------------------------------------------------------
// A pocket in the top is drawn once; the look from below does not report it
// ---------------------------------------------------------------------------
{
  const combined = recognizeBothFaces(plate().subtract(box(5, 5, 12, 20, 10, 8)))
  const cavities = cavitiesOf(combined)
  assert(cavities.length === 1, `top pocket: one cavity, got ${cavities.length}`)
  assert(cavities[0].face === 'top', 'top pocket: on Top')
  assertSpan(cavities[0], 12, 20, 'top pocket')
  assert(combined.skipped.length === 0, `top pocket: nothing skipped, got ${combined.skipped.length}`)
}

// ---------------------------------------------------------------------------
// A through hole is found from both sides and drawn once, on Top
// ---------------------------------------------------------------------------
{
  const combined = recognizeBothFaces(plate().subtract(cylinder(40, 10, -5, 3, 30)))
  const cavities = cavitiesOf(combined)
  assert(cavities.length === 1, `through hole: exactly one candidate, got ${cavities.length}`)
  assert(cavities[0].face === 'top', 'through hole: drawn on Top')
  assertSpan(cavities[0], 0, 20, 'through hole')
}

// ---------------------------------------------------------------------------
// A counterbore from the top: both steps on Top, not one from each side
// ---------------------------------------------------------------------------
{
  const solid = plate()
    .subtract(cylinder(30, 20, 14, 5.5, 10, 48))
    .subtract(cylinder(30, 20, -5, 3.3, 30, 48))
  const combined = recognizeBothFaces(solid)
  const cavities = cavitiesOf(combined)
  assert(cavities.length === 2, `counterbore from the top: two cavities, got ${cavities.length}`)
  assert(cavities.every((cavity) => cavity.face === 'top'), 'counterbore from the top: both on Top')
  assert(combined.skipped.length === 0, 'counterbore from the top: nothing skipped')
}

// ---------------------------------------------------------------------------
// A counterbore from the underside: the wide part is Bottom's, the bolt hole Top's
// ---------------------------------------------------------------------------
{
  const solid = plate()
    .subtract(cylinder(30, 20, -5, 3.3, 30, 48))
    .subtract(cylinder(30, 20, 0, 5.5, 6, 48))
  const combined = recognizeBothFaces(solid)
  const cavities = cavitiesOf(combined)
  assert(cavities.length === 2, `counterbore from the underside: two cavities, got ${cavities.length}`)
  const wide = cavities.find((cavity) => (cavity.circle?.radius ?? 0) > 4)!
  const bolt = cavities.find((cavity) => (cavity.circle?.radius ?? 0) < 4)!
  assert(wide !== undefined && bolt !== undefined, 'counterbore from the underside: both steps are found')
  assert(wide.face === 'bottom', 'counterbore from the underside: the wide part is on Bottom')
  assertSpan(wide, 0, 6, 'counterbore from the underside, wide part')
  assertCircle(wide, 30, 20, 5.5, 'counterbore from the underside, wide part')
  assert(bolt.face === 'top', 'counterbore from the underside: the bolt hole is on Top')
  assertSpan(bolt, 6, 20, 'counterbore from the underside, bolt hole')
}

// ---------------------------------------------------------------------------
// The plate itself is drawn once, on Top
// ---------------------------------------------------------------------------
{
  const combined = recognizeBothFaces(plate())
  const solids = solidsOf(combined)
  assert(solids.length === 1, `plate itself: exactly one solid, got ${solids.length}`)
  assert(solids[0].face === 'top', 'plate itself: on Top')
  assertSpan(solids[0], 0, 20, 'plate itself')
}

// ---------------------------------------------------------------------------
// A boss on the underside stands on the mesh's underside, and the plate on Bottom
// ---------------------------------------------------------------------------
{
  const solid = plate().translate([0, 0, 5]).add(box(20, 10, 0, 20, 20, 5))
  const combined = recognizeBothFaces(solid)
  const solids = solidsOf(combined)
  assert(solids.length === 2, `boss on the underside: two solids, got ${solids.length}`)
  const boss = solids.find((entry) => entry.face === 'top')!
  const base = solids.find((entry) => entry.face === 'bottom')!
  assert(boss !== undefined && base !== undefined, 'boss on the underside: one solid per face')
  assertSpan(boss, 0, 5, 'boss on the underside, the boss')
  assertSpan(base, 5, 25, 'boss on the underside, the plate')
  // The plate was an undercut from above and a body from below: Bottom draws
  // it, so it is not also reported as not drawn.
  assert(
    combined.skippedSolids.length === 0,
    `boss on the underside: no skipped body survives, got ${combined.skippedSolids.length}`,
  )
}

// ---------------------------------------------------------------------------
// A drafted pocket in the top is reported once, not once per face
// ---------------------------------------------------------------------------
{
  const combined = recognizeBothFaces(plate().subtract(frustum(30, 20, 12, 5, 6, 8, 48)))
  assert(
    combined.skipped.length === 1 && combined.skipped[0].reason === 'taperedWalls',
    `drafted pocket: reported once, got ${combined.skipped.length}`,
  )
  assertSpan(combined.skipped[0], 12, 20, 'drafted pocket')
  assert(cavitiesOf(combined).length === 0, 'drafted pocket: nothing drawn')
}

// ---------------------------------------------------------------------------
// The mesh from below: a copy, not a change to the caller's mesh
// ---------------------------------------------------------------------------
{
  const mesh = toMesh(plate().subtract(box(5, 5, 0, 20, 10, 6)))
  const before = Array.from(mesh.positions)
  const fromBelow = meshSeenFromBelow(mesh)
  assert(
    Array.from(mesh.positions).every((value, i) => value === before[i]),
    'mesh from below: the input mesh is not changed',
  )
  assert(
    fromBelow.positions.every((value, i) => (
      i % 3 === 2 ? value === -before[i] || (value === 0 && before[i] === 0) : value === before[i]
    )),
    'mesh from below: X and Y are the same, Z is negated',
  )
  assert(
    fromBelow.index.length === mesh.index.length
      && fromBelow.index.every((value, i) => (
        i % 3 === 1 ? value === mesh.index[i + 1] : i % 3 === 2 ? value === mesh.index[i - 1] : value === mesh.index[i]
      )),
    'mesh from below: every triangle is wound the other way, so the faces still point outward',
  )
  const twice = meshSeenFromBelow(fromBelow)
  assert(
    twice.positions.every((value, i) => value === before[i]),
    'mesh from below: applying it twice gives the original positions',
  )
}

// ---------------------------------------------------------------------------
// Ids: Bottom's rows are prefixed, and an island belongs to its Bottom cavity
// ---------------------------------------------------------------------------
{
  // The pillar stands on the pocket's floor, so from below it is an island.
  const pocket = box(10, 8, 0, 40, 24, 10).subtract(cylinder(30, 20, 0, 4, 10))
  const combined = recognizeBothFaces(plate().subtract(pocket))
  const bottom = combined.candidates.filter((candidate) => candidate.face === 'bottom')
  assert(bottom.length > 0, 'ids: Bottom has rows')
  assert(bottom.every((candidate) => candidate.id.startsWith('b-')), 'ids: every Bottom id starts with b-')
  const parent = bottom.find((candidate) => candidate.parentId === null && candidate.kind !== 'solid')!
  const island = bottom.find((candidate) => candidate.parentId !== null)!
  assert(parent !== undefined && island !== undefined, 'ids: the Bottom pocket and its boss are both found')
  assert(parent.id === 'b-c0', `ids: the first Bottom cavity is b-c0, got ${parent.id}`)
  assert(island.parentId === parent.id, `ids: the island names its Bottom cavity, got ${island.parentId}`)
  assert(island.id === `${parent.id}.i0`, `ids: the island is ${parent.id}.i0, got ${island.id}`)
}

// ---------------------------------------------------------------------------
// An island goes with the cavity it stands in, on either face
// ---------------------------------------------------------------------------
{
  // A through pocket with a pillar through it: found from both sides, so the
  // Bottom cavity is dropped — and its island with it.
  const throughPocket = box(10, 8, -5, 40, 24, 30).subtract(cylinder(30, 20, -5, 4, 30))
  const combined = recognizeBothFaces(plate().subtract(throughPocket))
  const cavities = cavitiesOf(combined)
  assert(cavities.length === 1, `through pocket with a pillar: one cavity, got ${cavities.length}`)
  assert(cavities[0].face === 'top', 'through pocket with a pillar: on Top')
  const islands = combined.candidates.filter((candidate) => candidate.parentId !== null)
  assert(islands.length === 1, `through pocket with a pillar: one island, got ${islands.length}`)
  assert(islands[0].face === 'top', 'through pocket with a pillar: the island is on Top')
  const ids = new Set(combined.candidates.map((candidate) => candidate.id))
  assert(
    combined.candidates.every((candidate) => candidate.parentId === null || ids.has(candidate.parentId)),
    'through pocket with a pillar: no row names a parent that was dropped',
  )
}

// ---------------------------------------------------------------------------
// Top alone is exactly what the dialog showed before this slice
// ---------------------------------------------------------------------------
{
  const solid = plate().subtract(box(5, 5, 12, 20, 10, 8)).subtract(cylinder(40, 10, -5, 3, 30))
  const combined = recognizeTopOnly(solid)
  const candidates = candidatesFromResult(recognizeCavities(toMesh(solid)), 'top', 'mm')
  assert(combined.candidates.length === candidates.length, 'top alone: the same number of rows')
  combined.candidates.forEach((candidate, i) => {
    const expected = candidates[i]
    assert(candidate.id === expected.id && candidate.face === expected.face, `top alone: row ${i} is unchanged`)
    assertNear(candidate.zTop, expected.zTop, `top alone: row ${i} top`)
    assertNear(candidate.zBottom, expected.zBottom, `top alone: row ${i} bottom`)
  })
  assert(combined.skipped.length === 0 && combined.skippedSolids.length === 0, 'top alone: the same skipped lists')
  assert(!combined.meshOpen && !combined.levelsTruncated, 'top alone: the same warnings')
}

console.log('modelRecognition/faces.test.ts: all assertions passed')
