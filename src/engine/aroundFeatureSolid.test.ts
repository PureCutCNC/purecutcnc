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

/// <reference types="node" />

/**
 * The wrapped Around slab in numbers (issue #395 slice G1).
 *
 * A feature on the unrolled sheet becomes a solid on the bar with the frozen
 * wrap; these assertions check it against the wrap's own numbers rather than
 * against a recorded result:
 * - the vertex radii, the mean angle at a quarter turn and the bar's axis sides
 * - the volume against the annular sector it stands for
 * - no edge on the slab's curved faces — its outer and inner surfaces at a
 *   constant radius — spans more than 5° of turn, on either bar axis; a long
 *   edge across a flat end or side wall is harmless and does not count
 * - a shape across the seam is one connected solid at the mid-sheet volume
 * - a whole turn further along is the same solid; 1.5 turns is one full ring
 * - an open profile, a line and an STL give no slab
 *
 * Mutations checked against these assertions (one at a time):
 * - sine and cosine swapped in the warp: testQuarterTurn (radius/angle)
 * - the sign of the angle flipped: testQuarterTurn (mean angle)
 * - the quarter-turn banding removed: testNoEdgeOverFiveDegrees / testMultiTurnRing
 * - the refine step removed: testNoEdgeOverFiveDegrees
 * - the curved-face filter relaxed to every edge: testNoEdgeOverFiveDegrees
 *   (the 1.5-turn ring's 7.37° end-wall edge)
 * - the Y-bar branch using the X-bar axes: testYAxisBar
 *
 * Run with: npx tsx src/engine/aroundFeatureSolid.test.ts
 */

import type { Manifold as ManifoldSolid } from 'manifold-3d'
import { newProject, rectProfile, roundStock, type Project, type RoundStock, type SketchFeature, type SketchProfile } from '../types/project'
import { aroundFrame } from './aroundFrame'
import { buildAroundFeatureSolid } from './aroundFeatureSolid'
import { getManifoldModule, minRenderHeight } from './csg'

const module = await getManifoldModule()
const MIN_HEIGHT = minRenderHeight('mm')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual} (tolerance ${tolerance})`,
  )
}

const X_BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })
const Y_BAR = roundStock(40, 200, 'y', { x: 10, y: 30 })

function barProject(bar: RoundStock): Project {
  return { ...newProject('around-solid', 'mm'), stock: bar }
}

function aroundFeature(
  profile: SketchProfile,
  operation: SketchFeature['operation'],
  kind: SketchFeature['kind'] = 'rect',
  zTop = 40,
  zBottom = 32,
  id = 'around',
): SketchFeature {
  return {
    id, name: id, kind, folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation, z_top: zTop, z_bottom: zBottom, authoringFace: 'around', visible: true, locked: false,
  }
}

function slabOf(project: Project, feature: SketchFeature): ManifoldSolid {
  const solid = buildAroundFeatureSolid(module, project, feature, { minHeight: MIN_HEIGHT })
  assert(solid, `fixture: ${feature.id} builds a slab`)
  return solid
}

// The quarter turn's across coordinate: the sheet's zero line (issue #1026)
// plus a quarter of the circumference. A 20 × 10 square centred there, cut 8
// deep from the surface (z 40 → 32, so r 12 → 20 + the 2 % surface margin).
const FRAME = aroundFrame(X_BAR)
const QUARTER_ACROSS = FRAME.zero + FRAME.circumference / 4
const R_BOTTOM = 12
const R_TOP = FRAME.radius * 1.02
const SIDE_LENGTH = 20
const SIDE_ACROSS = 10
const DELTA_THETA = SIDE_ACROSS / FRAME.radius
const SECTOR_VOLUME = SIDE_LENGTH * (DELTA_THETA / 2) * (R_TOP * R_TOP - R_BOTTOM * R_BOTTOM)

function squareAt(acrossCentre: number): SketchProfile {
  return rectProfile(50, acrossCentre - SIDE_ACROSS / 2, SIDE_LENGTH, SIDE_ACROSS)
}

/** The same square in the bar's own sheet coordinates (see `aroundFrame`). */
function squareForBar(bar: RoundStock, acrossCentre: number): SketchProfile {
  return bar.axis === 'x'
    ? squareAt(acrossCentre)
    : rectProfile(acrossCentre - SIDE_ACROSS / 2, 50, SIDE_ACROSS, SIDE_LENGTH)
}

interface VertexReadout {
  radius: number
  angleDegrees: number
}

/** Every mesh vertex of a slab, in project coordinates, as radius and angle. */
function vertices(solid: ManifoldSolid, bar: RoundStock): VertexReadout[] {
  const frame = aroundFrame(bar)
  const mesh = solid.getMesh()
  const readouts: VertexReadout[] = []
  for (let index = 0; index < mesh.numVert; index += 1) {
    const offset = index * mesh.numProp
    const across = (bar.axis === 'x' ? mesh.vertProperties[offset + 1] : mesh.vertProperties[offset]) - frame.centre
    const up = mesh.vertProperties[offset + 2] - frame.radius
    readouts.push({
      radius: Math.hypot(across, up),
      angleDegrees: (Math.atan2(across, up) * 180) / Math.PI,
    })
  }
  return readouts
}

function testQuarterTurn(bar: RoundStock): void {
  const project = barProject(bar)
  const frameForBar = aroundFrame(bar)
  const acrossCentre = frameForBar.zero + frameForBar.circumference / 4
  const solid = slabOf(project, aroundFeature(squareForBar(bar, acrossCentre), 'subtract'))
  try {
    const readouts = vertices(solid, bar)
    assert(readouts.length > 0, `axis ${bar.axis}: the slab has vertices`)
    // Within the 5° chord sag (r·(1 − cos 2.5°) ≈ 0.02 at r = 20.4) plus the
    // Float32 mesh and boolean tolerance; far below any wrong-radius mutation.
    const radiusTolerance = R_TOP * (1 - Math.cos((5 * Math.PI) / 360)) + 1e-3
    for (const { radius } of readouts) {
      assert(radius >= R_BOTTOM - radiusTolerance, `axis ${bar.axis}: radius ${radius} is not below the bottom radius`)
      assert(radius <= R_TOP + radiusTolerance, `axis ${bar.axis}: radius ${radius} is not above the top radius`)
    }
    const meanAngle = readouts.reduce((sum, point) => sum + point.angleDegrees, 0) / readouts.length
    // The shape is symmetric about the quarter turn on the side `wrapPoint` and
    // `stockSpacePoint` agree on: positive across is positive angle.
    assertClose(meanAngle, 90, 0.5, `axis ${bar.axis}: mean angle of a quarter-turn square`)
    assertClose(frameForBar.zero + frameForBar.circumference / 4, acrossCentre, 1e-12, 'fixture: quarter turn')

    assertClose(solid.volume(), SECTOR_VOLUME, SECTOR_VOLUME * 0.005, `axis ${bar.axis}: slab volume`)
  } finally {
    solid.delete()
  }
}

/** The review's off-origin 1.5-turn ring and its Y-bar twin (issue #395 G4). */
function multiTurnProfile(bar: RoundStock): SketchProfile {
  const frame = aroundFrame(bar)
  return bar.axis === 'x'
    ? rectProfile(50, frame.sheetStart + 3, SIDE_LENGTH, 1.5 * frame.circumference)
    : rectProfile(frame.sheetStart + 3, 50, 1.5 * frame.circumference, SIDE_LENGTH)
}

/**
 * Only the slab's curved faces count: an edge whose two endpoints both sit at
 * the same radius and on the outer or inner surface. The flat end walls (a
 * constant along coordinate) and radial side walls (a constant turn) are
 * planes, where a long edge is no chord through the bar — the 1.5-turn ring
 * leaves a 7.37° edge in an end wall that the curved-face rule does not cover
 * (issue #395 G4).
 */
function testNoEdgeOverFiveDegrees(): void {
  const cases: { bar: RoundStock; profile: SketchProfile; label: string }[] = [
    { bar: X_BAR, profile: squareAt(QUARTER_ACROSS), label: 'X bar quarter-turn square' },
    { bar: X_BAR, profile: multiTurnProfile(X_BAR), label: 'X bar 1.5-turn ring' },
    { bar: Y_BAR, profile: multiTurnProfile(Y_BAR), label: 'Y bar 1.5-turn ring' },
  ]
  const relativeTolerance = 1e-6
  const fiveDegrees = (5 * Math.PI) / 180
  for (const { bar, profile, label } of cases) {
    const solid = slabOf(barProject(bar), aroundFeature(profile, 'subtract'))
    try {
      const mesh = solid.getMesh()
      const readouts = vertices(solid, bar)
      const frame = aroundFrame(bar)
      const outerRadius = frame.radius * 1.02
      const innerRadius = R_BOTTOM
      // Wrapped difference: a seam-crossing edge's endpoints are near ±180°.
      const wrappedDifference = (a: number, b: number): number => {
        const difference = ((a - b) * Math.PI) / 180
        return Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference)))
      }
      let longest = 0
      for (let triangle = 0; triangle < mesh.triVerts.length; triangle += 3) {
        for (const [from, to] of [[0, 1], [1, 2], [2, 0]] as const) {
          const a = readouts[mesh.triVerts[triangle + from]]
          const b = readouts[mesh.triVerts[triangle + to]]
          const sameRadius = Math.abs(a.radius - b.radius) <= relativeTolerance * Math.max(a.radius, b.radius)
          const onCurvedFace =
            Math.abs(a.radius - outerRadius) <= relativeTolerance * outerRadius ||
            Math.abs(a.radius - innerRadius) <= relativeTolerance * innerRadius
          if (!sameRadius || !onCurvedFace) continue
          longest = Math.max(longest, wrappedDifference(a.angleDegrees, b.angleDegrees))
        }
      }
      assert(
        longest <= fiveDegrees + 1e-3,
        `${label}: no curved-face edge spans more than 5° of turn; longest is ${(longest * 180) / Math.PI}°`,
      )
    } finally {
      solid.delete()
    }
  }
}

function testAcrossTheSeam(): void {
  const project = barProject(X_BAR)
  const acrossSeam = slabOf(project, aroundFeature(squareAt(FRAME.sheetStart), 'subtract'))
  const midSheet = slabOf(project, aroundFeature(squareAt(QUARTER_ACROSS), 'subtract'))
  try {
    const parts = acrossSeam.decompose()
    try {
      assert(parts.length === 1, `a shape across the seam is one connected solid, got ${parts.length}`)
    } finally {
      for (const part of parts) part.delete()
    }
    assertClose(acrossSeam.volume(), midSheet.volume(), SECTOR_VOLUME * 0.005, 'seam slab keeps the mid-sheet volume')
  } finally {
    acrossSeam.delete()
    midSheet.delete()
  }
}

function testWholeTurnFurther(): void {
  const project = barProject(X_BAR)
  const here = slabOf(project, aroundFeature(squareAt(QUARTER_ACROSS), 'subtract'))
  const oneTurnOn = slabOf(project, aroundFeature(squareAt(QUARTER_ACROSS + FRAME.circumference), 'subtract'))
  try {
    assertClose(oneTurnOn.volume(), here.volume(), here.volume() * 1e-6, 'one turn further keeps the volume')
    const expected = here.boundingBox()
    const actual = oneTurnOn.boundingBox()
    for (const axis of [0, 1, 2] as const) {
      assertClose(actual.min[axis], expected.min[axis], 1e-6, `one turn further bounding box min[${axis}]`)
      assertClose(actual.max[axis], expected.max[axis], 1e-6, `one turn further bounding box max[${axis}]`)
    }
  } finally {
    here.delete()
    oneTurnOn.delete()
  }
}

function testMultiTurnRing(): void {
  const project = barProject(X_BAR)
  const oneAndAHalfTurns: SketchProfile = rectProfile(
    50,
    FRAME.sheetStart,
    SIDE_LENGTH,
    FRAME.circumference * 1.5,
  )
  const solid = slabOf(project, aroundFeature(oneAndAHalfTurns, 'subtract'))
  try {
    const fullRing = SIDE_LENGTH * Math.PI * (R_TOP * R_TOP - R_BOTTOM * R_BOTTOM)
    assertClose(solid.volume(), fullRing, fullRing * 0.005, '1.5 turns is one full ring, not 1.5 rings')
    assert(solid.volume() < fullRing * 1.3, 'the volume is nowhere near 1.5 rings')
  } finally {
    solid.delete()
  }
}

function testNullCases(): void {
  const project = barProject(X_BAR)
  const open: SketchProfile = {
    start: { x: 50, y: 40 },
    segments: [{ type: 'line', to: { x: 70, y: 45 } }, { type: 'line', to: { x: 60, y: 55 } }],
    closed: false,
  }
  assert(
    buildAroundFeatureSolid(module, project, aroundFeature(open, 'subtract'), { minHeight: MIN_HEIGHT }) === null,
    'an open profile gives no slab',
  )
  assert(
    buildAroundFeatureSolid(module, project, aroundFeature(squareAt(QUARTER_ACROSS), 'line'), { minHeight: MIN_HEIGHT }) === null,
    'a line operation gives no slab',
  )
  assert(
    buildAroundFeatureSolid(
      module,
      project,
      aroundFeature(squareAt(QUARTER_ACROSS), 'subtract', 'stl'),
      { minHeight: MIN_HEIGHT },
    ) === null,
    'an imported model gives no slab',
  )
}

function testYAxisVolume(): void {
  const project = barProject(Y_BAR)
  const frame = aroundFrame(Y_BAR)
  const acrossCentre = frame.zero + frame.circumference / 4
  const solid = slabOf(project, aroundFeature(squareForBar(Y_BAR, acrossCentre), 'subtract'))
  try {
    // The Y bar's across is its X, so the same square has the same sector
    // volume; the quarter-turn and edge assertions above already pin the axes.
    assertClose(solid.volume(), SECTOR_VOLUME, SECTOR_VOLUME * 0.005, 'Y bar slab volume')
    const readouts = vertices(solid, Y_BAR)
    const meanAngle = readouts.reduce((sum, point) => sum + point.angleDegrees, 0) / readouts.length
    assertClose(meanAngle, 90, 0.5, 'Y bar mean angle stays at the quarter turn')
  } finally {
    solid.delete()
  }
}

testQuarterTurn(X_BAR)
testQuarterTurn(Y_BAR)
testNoEdgeOverFiveDegrees()
testAcrossTheSeam()
testWholeTurnFurther()
testMultiTurnRing()
testNullCases()
testYAxisVolume()

console.log('aroundFeatureSolid.test.ts passed')
