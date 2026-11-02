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
 * The Polygon canned model (issue #1112 slice G).
 *
 * Run with: npx tsx src/cannedShapes/generators/polygon.test.ts
 *
 * The generated mesh must be exactly the old Polygon/hex command's prism for
 * several parameter sets, on a round bar and a square blank; the stored
 * parameters must round-trip through JSON and regenerate byte-identical
 * vertices; unit conversion must convert lengths and leave sides/rotation.
 */

import assert from 'node:assert/strict'
import { buildRotaryPolygonPrism } from '../../engine/rotaryPrism'
import { computeMeshBounds } from '../../engine/importedMesh'
import {
  rotarySolidFrameStock,
  type RotarySolidFrame,
} from './rotarySolidParams'
import {
  MAX_POLYGON_SIDES,
  normalizePolygonCannedParams,
  polygonCannedShape,
} from './polygon'
import type { CannedShapeParams } from '../../types/project'

const ROUND: RotarySolidFrame = {
  axis: 'x',
  thickness: 40,
  alongMin: 10,
  alongMax: 210,
  acrossCentre: 50,
}

const SQUARE: RotarySolidFrame = {
  axis: 'x',
  thickness: 25,
  alongMin: 0,
  alongMax: 120,
  acrossCentre: 12.5,
}

const Y_BAR: RotarySolidFrame = {
  axis: 'y',
  thickness: 40,
  alongMin: 30,
  alongMax: 230,
  acrossCentre: 30,
}

function params(
  frame: RotarySolidFrame,
  start: number,
  length: number,
  sides: number,
  acrossFlats: number,
  rotation: number,
) {
  return {
    start,
    length,
    sides,
    acrossFlats,
    rotation,
    frame,
  } as unknown as CannedShapeParams
}

function meshOf(raw: CannedShapeParams) {
  const normalized = normalizePolygonCannedParams(raw)
  assert.ok(normalized, 'the parameters normalize')
  const mesh = polygonCannedShape.generateMesh!(normalized)
  assert.ok(mesh, 'the Polygon generates a mesh')
  return { normalized, mesh }
}

assert.equal(polygonCannedShape.capabilities?.expandable, false, 'a Polygon model is not expandable')
assert.equal(polygonCannedShape.labelKey, 'canned.polygon.name', 'the label names the shape')

for (const [label, frame, sets] of [
  ['round', ROUND, [[0, 40, 6, 15, 0], [10, 25, 8, 10, 22.5], [50, 60, 3, 20, -15]]],
  ['square', SQUARE, [[0, 40, 6, 10, 0], [10, 30, 4, 8, 45]]],
] as const) {
  for (const [start, length, sides, acrossFlats, rotation] of sets) {
    const raw = params(frame, start, length, sides, acrossFlats, rotation)
    const { mesh } = meshOf(raw)
    const old = buildRotaryPolygonPrism(rotarySolidFrameStock(frame), {
      sides,
      acrossFlats,
      rotationDeg: rotation,
      alongStart: frame.alongMin + start,
      alongEnd: frame.alongMin + start + length,
    })
    assert.deepEqual(Array.from(mesh.positions), Array.from(old.positions), `${label} ${sides}/${acrossFlats}: vertices equal the old builder`)
    assert.deepEqual(Array.from(mesh.indices), Array.from(old.index), `${label} ${sides}/${acrossFlats}: triangles equal the old builder`)

    // JSON round-trip: the stored parameters regenerate the same mesh.
    const roundTripped = normalizePolygonCannedParams(JSON.parse(JSON.stringify(normalizePolygonCannedParams(raw)!)))
    assert.ok(roundTripped, `${label} ${sides}: stored parameters normalize again`)
    const regenerated = polygonCannedShape.generateMesh!(roundTripped)
    assert.ok(regenerated)
    assert.deepEqual(Array.from(regenerated.positions), Array.from(mesh.positions), `${label} ${sides}: JSON round trip is exact`)
    assert.deepEqual(Array.from(regenerated.indices), Array.from(mesh.indices), `${label} ${sides}: JSON triangles are exact`)
  }
}

// A Y bar's chuck end is maxY: start 10 with length 20 is y 200..220.
const yMesh = meshOf(params(Y_BAR, 10, 20, 6, 10, 0)).mesh
const yBounds = computeMeshBounds(yMesh.positions)
assert.equal(yBounds.minY, 200, 'the Y band starts from the chuck end')
assert.equal(yBounds.maxY, 220, 'the Y band ends 20 along the bar')

// The summary names every property.
const summary = polygonCannedShape.summary(normalizePolygonCannedParams(params(ROUND, 10, 30, 6, 15, 22.5))!)
assert.equal(summary.key, 'canned.polygon.summary')
assert.deepEqual(summary.values, { start: 10, length: 30, sides: 6, acrossFlats: 15, rotation: 22.5 })

// Unit conversion converts lengths only; sides and rotation stay.
const converted = polygonCannedShape.convertParams!(
  normalizePolygonCannedParams(params(ROUND, 25.4, 50.8, 6, 25.4, 30))!,
  (value) => value / 25.4,
) as ReturnType<typeof normalizePolygonCannedParams>
assert.ok(converted)
assert.equal(converted.start, 1, 'start converts')
assert.equal(converted.length, 2, 'length converts')
assert.equal(converted.acrossFlats, 1, 'across flats converts')
assert.equal(converted.sides, 6, 'the side count stays')
assert.equal(converted.rotation, 30, 'the rotation stays')
assert.equal(converted.frame.thickness, 40 / 25.4, 'the frame thickness converts')

// Refusals: a corrupt file cannot draw a different solid.
const base = params(ROUND, 10, 30, 6, 15, 0)
const bad = [
  ['two sides', { ...base, sides: 2 }],
  ['a fractional side count', { ...base, sides: 6.5 }],
  ['too many sides', { ...base, sides: MAX_POLYGON_SIDES + 1 }],
  ['zero across flats', { ...base, acrossFlats: 0 }],
  ['a polygon wider than the bar', { ...base, acrossFlats: 41 }],
  ['a band past the bar', { ...base, start: 190, length: 30 }],
  ['a non-finite rotation', { ...base, rotation: Number.NaN }],
  ['a missing frame', { ...base, frame: undefined }],
]
for (const [label, raw] of bad) {
  assert.equal(normalizePolygonCannedParams(raw as CannedShapeParams), null, `${label} is refused`)
}

// A model draws only its placement frame, never a sketch outline.
const outlines = polygonCannedShape.generate(normalizePolygonCannedParams(base)!)
assert.equal(outlines.length, 1, 'one placement frame')
assert.equal(outlines[0].profile.closed, true, 'the frame is a closed rectangle')

console.log('polygon generator: all assertions passed.')
