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
 * The Turn canned model (issue #1112 slice G).
 *
 * Run with: npx tsx src/cannedShapes/generators/turn.test.ts
 *
 * The generated mesh must be exactly the old command's cylinder for several
 * parameter sets, on a round bar and a square blank; the stored parameters must
 * round-trip through JSON and regenerate byte-identical vertices; unit
 * conversion must convert lengths and keep the stored segment count.
 */

import assert from 'node:assert/strict'
import { buildRotaryCylinderMesh, rotaryCylinderSegments } from '../../engine/rotaryCylinder'
import {
  rotarySolidFrameStock,
  type RotarySolidFrame,
} from './rotarySolidParams'
import { normalizeTurnCannedParams, turnCannedShape } from './turn'
import { computeMeshBounds } from '../../engine/importedMesh'
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

function params(frame: RotarySolidFrame, start: number, length: number, diameter: number) {
  return {
    start,
    length,
    diameter,
    segments: rotaryCylinderSegments(diameter / 2, 'mm'),
    frame,
  } as unknown as CannedShapeParams
}

function meshOf(raw: CannedShapeParams) {
  const normalized = normalizeTurnCannedParams(raw)
  assert.ok(normalized, 'the parameters normalize')
  const mesh = turnCannedShape.generateMesh!(normalized)
  assert.ok(mesh, 'the Turn generates a mesh')
  return { normalized, mesh }
}

assert.equal(turnCannedShape.capabilities?.expandable, false, 'a Turn model is not expandable')
assert.equal(turnCannedShape.labelKey, 'canned.turn.name', 'the label names the shape')

for (const [label, frame, sets] of [
  ['round', ROUND, [[0, 40, 20], [25, 60, 32], [100, 30, 8]]],
  ['square', SQUARE, [[10, 30, 20], [0, 100, 10]]],
] as const) {
  for (const [start, length, diameter] of sets) {
    const raw = params(frame, start, length, diameter)
    const { normalized, mesh } = meshOf(raw)
    const old = buildRotaryCylinderMesh(rotarySolidFrameStock(frame), {
      diameter,
      alongStart: frame.alongMin + start,
      alongEnd: frame.alongMin + start + length,
    }, normalized.segments)
    assert.deepEqual(Array.from(mesh.positions), Array.from(old.positions), `${label} ${diameter}: vertices equal the old builder`)
    assert.deepEqual(Array.from(mesh.indices), Array.from(old.index), `${label} ${diameter}: triangles equal the old builder`)
    assert.equal(
      normalized.segments,
      rotaryCylinderSegments(diameter / 2, 'mm'),
      `${label} ${diameter}: the segment count is the builder's own`,
    )

    // JSON round-trip: the stored parameters regenerate the same mesh.
    const roundTripped = normalizeTurnCannedParams(JSON.parse(JSON.stringify(normalized)))
    assert.ok(roundTripped, `${label} ${diameter}: stored parameters normalize again`)
    const regenerated = turnCannedShape.generateMesh!(roundTripped)
    assert.ok(regenerated)
    assert.deepEqual(Array.from(regenerated.positions), Array.from(mesh.positions), `${label} ${diameter}: JSON round trip is exact`)
    assert.deepEqual(Array.from(regenerated.indices), Array.from(mesh.indices), `${label} ${diameter}: JSON triangles are exact`)
  }
}

// A Turn on the square blank is the old Square to round cylinder on its pivot.
const squareTurn = meshOf(params(SQUARE, 10, 30, 20)).mesh
const squareOld = buildRotaryCylinderMesh(rotarySolidFrameStock(SQUARE), {
  diameter: 20,
  alongStart: 10,
  alongEnd: 40,
}, rotaryCylinderSegments(10, 'mm'))
assert.deepEqual(Array.from(squareTurn.positions), Array.from(squareOld.positions), 'Turn on square equals Square to round')

// The summary names every property.
const summary = turnCannedShape.summary(normalizeTurnCannedParams(params(ROUND, 10, 30, 20))!)
assert.equal(summary.key, 'canned.turn.summary')
assert.deepEqual(summary.values, { start: 10, length: 30, diameter: 20 })

// Unit conversion converts lengths only; the segment count and frame axis stay.
const converted = turnCannedShape.convertParams!(
  normalizeTurnCannedParams(params(ROUND, 25.4, 50.8, 25.4))!,
  (value) => value / 25.4,
) as ReturnType<typeof normalizeTurnCannedParams> & { segments: number }
assert.ok(converted)
assert.equal(converted.start, 1, 'start converts')
assert.equal(converted.length, 2, 'length converts')
assert.equal(converted.diameter, 1, 'diameter converts')
assert.equal(converted.segments, rotaryCylinderSegments(12.7, 'mm'), 'the segment count is preserved')
assert.equal(converted.frame.thickness, 40 / 25.4, 'the frame thickness converts')
assert.equal(converted.frame.alongMin, 10 / 25.4, 'the frame start converts')

// Refusals: a corrupt file cannot draw a different solid.
const base = params(ROUND, 10, 30, 20)
const bad = [
  ['a diameter past the bar', { ...base, diameter: 41 }],
  ['a zero diameter', { ...base, diameter: 0 }],
  ['a band past the bar', { ...base, start: 190, length: 30 }],
  ['a negative start', { ...base, start: -1 }],
  ['a zero length', { ...base, length: 0 }],
  ['a fractional segment count', { ...base, segments: 8.5 }],
  ['a missing frame', { ...base, frame: undefined }],
  ['a non-finite rotation-like field', { ...base, length: Number.NaN }],
]
for (const [label, raw] of bad) {
  assert.equal(normalizeTurnCannedParams(raw as CannedShapeParams), null, `${label} is refused`)
}

// A model draws only its placement frame, never a sketch outline.
const outlines = turnCannedShape.generate(normalizeTurnCannedParams(base)!)
assert.equal(outlines.length, 1, 'one placement frame')
assert.equal(outlines[0].profile.closed, true, 'the frame is a closed rectangle')

// ── a copied side profile revolves about the bar axis ─────────

const PROFILE = {
  sourceFeatureId: 'f-half-profile',
  sourceName: 'Half profile',
  contours: [{
    closed: false,
    points: [
      { along: 20, radius: 0 },
      { along: 30, radius: 5 },
      { along: 60, radius: 10 },
      { along: 60, radius: 0 },
    ],
  }],
}

/** The largest radius among the mesh vertices on one along station. */
function radiusAt(positions: Float32Array, along: number, tolerance = 1e-3): number {
  let radius = 0
  for (let index = 0; index < positions.length / 3; index += 1) {
    const x = positions[index * 3]
    if (Math.abs(x - along) > tolerance) continue
    const across = positions[index * 3 + 1] - ROUND.acrossCentre
    const up = positions[index * 3 + 2] - ROUND.thickness / 2
    radius = Math.max(radius, Math.hypot(across, up))
  }
  return radius
}

const profiledRaw = {
  ...params(ROUND, 0, 1, 1),
  profile: PROFILE,
} as unknown as CannedShapeParams
const profiled = normalizeTurnCannedParams(profiledRaw)
assert.ok(profiled, 'the stored profile normalizes')
assert.equal(profiled.start, 10, 'the profile start is derived from its own extent')
assert.equal(profiled.length, 40, 'the profile length is derived from its own extent')
assert.equal(profiled.diameter, 20, 'the profile diameter is twice its largest radius')
assert.equal(profiled.profile?.sourceFeatureId, 'f-half-profile', 'the source id is stored')
assert.equal(profiled.profile?.sourceName, 'Half profile', 'the source name is stored')

const profiledMesh = turnCannedShape.generateMesh!(profiled)
assert.ok(profiledMesh, 'the profiled Turn generates a mesh')
assert.ok(Math.abs(radiusAt(profiledMesh.positions, 30) - 5) <= 1e-3, 'the cone station radius matches')
assert.ok(Math.abs(radiusAt(profiledMesh.positions, 60) - 10) <= 1e-3, 'the cylinder station radius matches')
const profileBounds = computeMeshBounds(profiledMesh.positions)
assert.ok(Math.abs(profileBounds.minX - 20) <= 1e-3, 'the profile keeps its own along start')
assert.ok(Math.abs(profileBounds.maxX - 60) <= 1e-3, 'the profile keeps its own along end')
assert.ok(Math.abs((profileBounds.minZ + profileBounds.maxZ) / 2 - 20) <= 0.1, 'the profile is centred on the bar pivot')

// Stored JSON regenerates the same vertices and triangles.
const profiledRoundTrip = normalizeTurnCannedParams(JSON.parse(JSON.stringify(profiled)))
assert.ok(profiledRoundTrip, 'the profile parameters normalize again')
const regenerated = turnCannedShape.generateMesh!(profiledRoundTrip)
assert.ok(regenerated)
assert.deepEqual(Array.from(regenerated.positions), Array.from(profiledMesh.positions), 'profile vertices round-trip')
assert.deepEqual(Array.from(regenerated.indices), Array.from(profiledMesh.indices), 'profile triangles round-trip')

// Unit conversion converts the profile points as lengths.
const convertedProfile = turnCannedShape.convertParams!(
  profiled,
  (value) => value / 25.4,
) as ReturnType<typeof normalizeTurnCannedParams> & { profile?: { contours: Array<{ points: Array<{ along: number; radius: number }> }> } }
assert.ok(convertedProfile?.profile)
assert.ok(Math.abs((convertedProfile.profile.contours[0].points[1].along ?? 0) - 30 / 25.4) < 1e-9, 'profile along converts')
assert.ok(Math.abs((convertedProfile.profile.contours[0].points[2].radius ?? 0) - 10 / 25.4) < 1e-9, 'profile radius converts')

// A closed profile on one side is accepted and revolved as a ring/solid.
const closedProfile = {
  sourceFeatureId: 'f-closed',
  contours: [{
    closed: true,
    points: [
      { along: 20, radius: 2 },
      { along: 20, radius: 6 },
      { along: 50, radius: 6 },
      { along: 50, radius: 2 },
    ],
  }],
}
const closedParams = normalizeTurnCannedParams({ ...params(ROUND, 0, 1, 1), profile: closedProfile } as unknown as CannedShapeParams)
assert.ok(closedParams, 'a closed off-axis profile is accepted')
const closedMesh = turnCannedShape.generateMesh!(closedParams)
assert.ok(closedMesh, 'the closed profile generates a mesh')
assert.ok(Math.abs(radiusAt(closedMesh.positions, 50) - 6) <= 1e-3, 'the closed profile outer radius')

// Refusals: a corrupt profile copy cannot draw a different Turn.
const profileRefusals: Array<[string, unknown]> = [
  ['crossing the axis', {
    sourceFeatureId: 'f',
    contours: [{ closed: false, points: [{ along: 20, radius: 0 }, { along: 30, radius: -2 }] }],
  }],
  ['doubling back', {
    sourceFeatureId: 'f',
    contours: [{ closed: false, points: [{ along: 20, radius: 2 }, { along: 40, radius: 4 }, { along: 30, radius: 3 }] }],
  }],
  ['past the bar surface', {
    sourceFeatureId: 'f',
    contours: [{ closed: false, points: [{ along: 20, radius: 0 }, { along: 30, radius: 25 }] }],
  }],
  ['past the bar ends', {
    sourceFeatureId: 'f',
    contours: [{ closed: false, points: [{ along: 5, radius: 0 }, { along: 30, radius: 5 }] }],
  }],
  ['an empty outline', {
    sourceFeatureId: 'f',
    contours: [{ closed: false, points: [{ along: 20, radius: 0 }, { along: 20, radius: 0 }] }],
  }],
  ['no source id', { contours: [] }],
]
for (const [label, profile] of profileRefusals) {
  assert.equal(
    normalizeTurnCannedParams({ ...params(ROUND, 0, 1, 1), profile } as unknown as CannedShapeParams),
    null,
    `${label} is refused`,
  )
}

console.log('turn generator: all assertions passed.')
