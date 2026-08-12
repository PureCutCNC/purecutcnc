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
 * Corner relief — dogbone / T-bone / longest-edge (issue #203).
 *
 * The central assertion is **coverage of the emitted motion**, not "the region
 * changed". That distinction is the whole reason this feature is a separate pass:
 * unioning the relief lobe into the cleared region produces a tool path
 * byte-identical to no relief at all, so a region-level assertion passes on a
 * silent no-op. Every geometry test here builds the swept envelope of the fed
 * moves — a capsule of cutter radius around each one — and asks whether the
 * corner wedge is inside it.
 *
 * `sweptCovers` is also what makes the touch-the-corner rule falsifiable: the
 * same coverage model run with the excursion ending at `1.2r` must leave the
 * corner uncut. Ending short is the failure direction, so a test that only
 * checked "ending at r clears" would pass for any endpoint at or past the
 * corner.
 *
 * Run with: npx tsx src/engine/toolpaths/cornerRelief.test.ts
 */

import type {
  Operation,
  Point,
  Project,
  SketchFeature,
  SketchProfile,
  Tab,
  Tool,
} from '../../types/project'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { convertLength } from '../../utils/units'
import {
  RELIEF_MIN_CORNER_TURN_RADIANS,
  collectReliefCorners,
  generateCornerReliefPass,
  mainPathCutsAt,
  reliefExcursionEnd,
  resolveReliefStepdown,
  type CornerGeometry,
} from './cornerRelief'
import { generateEdgeRouteToolpath } from './edge'
import { normalizeToolForProject } from './geometry'
import { optimizeLinearMoves } from './linearMoveOptimization'
import { generatePocketToolpath } from './pocket'
import type { NormalizedTool, ToolpathMove, ToolpathResult } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon
}

// ── Coverage model ───────────────────────────────────────────────────

const FED_KINDS = new Set<ToolpathMove['kind']>(['cut', 'lead_in', 'lead_out'])

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared < 1e-18) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
}

/**
 * True when a flat cutter of `radius` sweeping the given fed moves removes the
 * material at `point`.
 *
 * A move at Z removes everything above it too — the shank sweeps the column — so
 * a move is counted whenever it cuts at or below `z`.
 */
function sweptCovers(
  point: Point,
  moves: Array<{ from: Point & { z: number }; to: Point & { z: number }; kind: ToolpathMove['kind'] }>,
  radius: number,
  z: number,
): boolean {
  const tolerance = radius * 1e-6
  for (const move of moves) {
    if (!FED_KINDS.has(move.kind)) continue
    if (move.from.z > z + 1e-9 || move.to.z > z + 1e-9) continue
    if (distanceToSegment(point, move.from, move.to) <= radius + tolerance) return true
  }
  return false
}

/**
 * Sample the corner wedge: every point strictly inside the two adjacent walls
 * and within `radius` of the corner. Those are exactly the points a mating
 * square part needs removed, and exactly what an unrelieved cutter leaves.
 */
function wedgeSamples(geometry: CornerGeometry, radius: number): Point[] {
  const baseAngle = Math.atan2(geometry.edgeA.y, geometry.edgeA.x)
  const sweep = geometry.interiorAngle
  // The wedge lies on the bisector side, so sweep from edgeA towards edgeB the
  // short way — which is the side `bisector` points into.
  const towardsB = Math.sign(
    geometry.edgeA.x * geometry.bisector.y - geometry.edgeA.y * geometry.bisector.x,
  ) || 1
  const samples: Point[] = []
  for (let fraction = 0.02; fraction <= 0.98; fraction += 0.06) {
    const angle = baseAngle + towardsB * sweep * fraction
    for (let depth = 0.1; depth <= 1.0001; depth += 0.1) {
      samples.push({
        x: geometry.corner.x + Math.cos(angle) * radius * depth,
        y: geometry.corner.y + Math.sin(angle) * radius * depth,
      })
    }
  }
  return samples
}

// ── Synthetic corner geometry ────────────────────────────────────────

/**
 * A corner of the cleared region at the origin, opening symmetrically about +X,
 * with the wall contour that a Clipper miter offset by `radius` would produce.
 */
function syntheticCorner(interiorAngleDegrees: number, radius: number, edgeLength = 40): {
  geometry: CornerGeometry
  /** The main path: the two wall-contour legs meeting at P. */
  wallMoves: Array<{ from: Point & { z: number }; to: Point & { z: number }; kind: 'cut' }>
  descend: Point
} {
  const theta = (interiorAngleDegrees * Math.PI) / 180
  const half = theta / 2
  const edgeA = { x: Math.cos(half), y: Math.sin(half) }
  const edgeB = { x: Math.cos(half), y: -Math.sin(half) }
  const geometry: CornerGeometry = {
    corner: { x: 0, y: 0 },
    edgeA,
    edgeB,
    lengthA: edgeLength,
    lengthB: edgeLength,
    bisector: { x: 1, y: 0 },
    interiorAngle: theta,
  }
  const descend = { x: radius / Math.sin(half), y: 0 }
  // Each leg of the wall contour runs parallel to its wall, `radius` inside it.
  const legEnd = (edge: Point) => ({
    x: descend.x + edge.x * edgeLength,
    y: descend.y + edge.y * edgeLength,
  })
  const z = 0
  return {
    geometry,
    wallMoves: [
      { kind: 'cut', from: { ...legEnd(edgeA), z }, to: { ...descend, z } },
      { kind: 'cut', from: { ...descend, z }, to: { ...legEnd(edgeB), z } },
    ],
    descend,
  }
}

const TEST_ANGLES = [150, 120, 90, 75, 60, 45, 30]

// ── Project fixtures ─────────────────────────────────────────────────

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'tool-1',
    name: '4 mm endmill',
    diameter: 4,
    defaultStepdown: 2,
    defaultStepover: 0.4,
    ...overrides,
  }
}

function polygonProfile(points: Array<[number, number]>): SketchProfile {
  return {
    start: { x: points[0][0], y: points[0][1] },
    segments: points.slice(1).map(([x, y]) => ({ type: 'line' as const, to: { x, y } })),
    closed: true,
  }
}

/** A square with all four corners filleted by `radius` — real arcs, not corners. */
function filletedSquareProfile(size: number, radius: number): SketchProfile {
  const min = 0
  const max = size
  return {
    start: { x: min + radius, y: min },
    segments: [
      { type: 'line', to: { x: max - radius, y: min } },
      { type: 'arc', to: { x: max, y: min + radius }, center: { x: max - radius, y: min + radius }, clockwise: false },
      { type: 'line', to: { x: max, y: max - radius } },
      { type: 'arc', to: { x: max - radius, y: max }, center: { x: max - radius, y: max - radius }, clockwise: false },
      { type: 'line', to: { x: min + radius, y: max } },
      { type: 'arc', to: { x: min, y: max - radius }, center: { x: min + radius, y: max - radius }, clockwise: false },
      { type: 'line', to: { x: min, y: min + radius } },
      { type: 'arc', to: { x: min + radius, y: min }, center: { x: min + radius, y: min + radius }, clockwise: false },
    ],
    closed: true,
  }
}

function makeFeature(
  id: string,
  profile: SketchProfile,
  zTop: number,
  zBottom: number,
  operation: 'subtract' | 'add' = 'subtract',
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  const base = {
    id: 'op-1',
    name: 'op',
    kind: 'pocket' as const,
    pass: 'rough' as const,
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features' as const, featureIds: ['pocket'] },
    toolRef: 'tool-1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset' as const,
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional' as const,
    machiningOrder: 'level_first' as const,
    edgeStrategy: 'contour' as const,
  }
  return { ...base, ...overrides } as Operation
}

function makeProject(
  features: SketchFeature[],
  tools: Tool[] = [makeTool()],
  units: 'mm' | 'inch' = 'mm',
  tabs: Tab[] = [],
): Project {
  const base = newProject('corner relief', units)
  return projectWithFeatures({ ...base, tools, tabs }, features)
}

function rectTab(x: number, y: number, size: number, zTop: number, zBottom: number): Tab {
  return {
    id: `tab-${x}-${y}`,
    name: 'tab',
    x,
    y,
    w: size,
    h: size,
    z_top: zTop,
    z_bottom: zBottom,
  } as unknown as Tab
}

/** Cut moves the relief pass added, as out-and-back pairs. */
function reliefExcursions(withRelief: ToolpathResult, withoutRelief: ToolpathResult): Array<{ from: Point; to: Point; z: number }> {
  return withRelief.moves
    .slice(withoutRelief.moves.length)
    .filter((move) => move.kind === 'cut')
    .map((move) => ({ from: move.from, to: move.to, z: move.from.z }))
}

function warningCodes(result: ToolpathResult): string[] {
  return result.warnings.map((warning) => warning.code)
}

// ── Test runner ──────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 1. The endpoint rule ─────────────────────────────────────────────

console.log('\ncornerRelief — endpoint rule')

test('dogbone ends on the bisector at exactly the cutter radius', () => {
  const radius = 3
  for (const angle of TEST_ANGLES) {
    const { geometry } = syntheticCorner(angle, radius)
    const end = reliefExcursionEnd(geometry, 'dogbone', radius)
    assert(approx(Math.hypot(end.x, end.y), radius), `dogbone at ${angle}° should end r from the corner`)
    assert(approx(end.y, 0, 1e-9), `dogbone at ${angle}° should end on the bisector`)
  }
})

test('t-bone ends on an adjacent edge, biting exactly r past that wall', () => {
  const radius = 3
  for (const angle of TEST_ANGLES) {
    const { geometry } = syntheticCorner(angle, radius)
    const end = reliefExcursionEnd(geometry, 't_bone', radius)
    assert(approx(Math.hypot(end.x, end.y), radius), `t-bone at ${angle}° should end r from the corner`)
    // On the edge means the cross product with that edge direction vanishes, and
    // the cutter centred there reaches exactly r past the wall it sits on.
    const onA = approx(geometry.edgeA.x * end.y - geometry.edgeA.y * end.x, 0, 1e-9)
    const onB = approx(geometry.edgeB.x * end.y - geometry.edgeB.y * end.x, 0, 1e-9)
    assert(onA || onB, `t-bone at ${angle}° should end on an adjacent edge`)
  }
})

test('t-bone takes the X-parallel edge; longest_edge takes the longer one', () => {
  const radius = 2
  // Corner at the origin: one edge runs +X (short), one runs +Y (long).
  const geometry: CornerGeometry = {
    corner: { x: 0, y: 0 },
    edgeA: { x: 1, y: 0 },
    edgeB: { x: 0, y: 1 },
    lengthA: 10,
    lengthB: 40,
    bisector: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
    interiorAngle: Math.PI / 2,
  }
  const tBone = reliefExcursionEnd(geometry, 't_bone', radius)
  assert(approx(tBone.x, radius) && approx(tBone.y, 0), 't_bone should slot along the X-parallel edge')
  const longest = reliefExcursionEnd(geometry, 'longest_edge', radius)
  assert(approx(longest.x, 0) && approx(longest.y, radius), 'longest_edge should slot along the longer edge')
})

test('notch depth past the wall is r(1 − sin(θ/2)) for a dogbone, r for a t-bone', () => {
  const radius = 3
  for (const angle of TEST_ANGLES) {
    const { geometry } = syntheticCorner(angle, radius)
    const half = geometry.interiorAngle / 2
    // Distance from the excursion end to a wall line through the corner; the
    // cutter reaches `radius` beyond that, so the bite is radius − distance.
    const biteFrom = (end: Point, edge: Point) => radius - Math.abs(edge.x * end.y - edge.y * end.x)

    const dogbone = reliefExcursionEnd(geometry, 'dogbone', radius)
    assert(
      approx(biteFrom(dogbone, geometry.edgeA), radius * (1 - Math.sin(half)), 1e-9),
      `dogbone notch depth at ${angle}° should be r(1 − sin(θ/2))`,
    )

    const tBone = reliefExcursionEnd(geometry, 't_bone', radius)
    const onA = approx(geometry.edgeA.x * tBone.y - geometry.edgeA.y * tBone.x, 0, 1e-9)
    const chosen = onA ? geometry.edgeA : geometry.edgeB
    const other = onA ? geometry.edgeB : geometry.edgeA
    assert(approx(biteFrom(tBone, chosen), radius, 1e-9), `t-bone at ${angle}° should bite a full r into its own wall`)
    // v6 measured the T-bone's "confined to one face" guarantee at θ = 90°,
    // where it is exact. Away from the right angle the endpoint sits `r sin θ`
    // from the other wall, so the guarantee degrades as `r(1 − sin θ)` — real
    // geometry, not a defect, and the reason the panel text says the T-bone
    // costs a slot rather than promising an untouched neighbouring face.
    assert(
      approx(biteFrom(tBone, other), Math.max(0, radius * (1 - Math.sin(geometry.interiorAngle))), 1e-9),
      `t-bone at ${angle}° should bite r(1 − sin θ) into the perpendicular wall`,
    )
  }
})

test('at a right angle the t-bone leaves the perpendicular wall untouched', () => {
  const radius = 3
  const { geometry } = syntheticCorner(90, radius)
  const end = reliefExcursionEnd(geometry, 't_bone', radius)
  const onA = approx(geometry.edgeA.x * end.y - geometry.edgeA.y * end.x, 0, 1e-9)
  const other = onA ? geometry.edgeB : geometry.edgeA
  const bite = radius - Math.abs(other.x * end.y - other.y * end.x)
  assert(bite <= 1e-9, 'this is the measured guarantee the style exists for, and it is exact at 90°')
})

// ── 2. Coverage: touch clears, ending short does not ─────────────────

console.log('\ncornerRelief — the cutter reaches the corner')

for (const style of ['dogbone', 't_bone'] as const) {
  test(`${style} at r clears the whole wedge at every angle`, () => {
    const radius = 3
    for (const angle of TEST_ANGLES) {
      const { geometry, wallMoves, descend } = syntheticCorner(angle, radius)
      const end = reliefExcursionEnd(geometry, style, radius)
      const moves = [
        ...wallMoves,
        { kind: 'cut' as const, from: { ...descend, z: 0 }, to: { ...end, z: 0 } },
        { kind: 'cut' as const, from: { ...end, z: 0 }, to: { ...descend, z: 0 } },
      ]
      for (const sample of wedgeSamples(geometry, radius)) {
        assert(
          sweptCovers(sample, moves, radius, 0),
          `${style} at ${angle}° left (${sample.x.toFixed(4)}, ${sample.y.toFixed(4)}) uncut`,
        )
      }
    }
  })

  // Ending short is the failure direction, and `r` is a limit rather than a
  // conservative choice — so the same coverage model must *fail* at 1.2r.
  //
  // The angle sets differ by style because the endpoint distance is not always
  // what binds. A dogbone ends on the bisector, so 1.2r really is 0.2r short of
  // the corner at every angle v5 tested. A T-bone ends on a wall, so as the
  // corner opens out its excursion runs more and more across the bisector than
  // along it, and past about 105° the capsule *body* sweeps over the corner
  // whatever the endpoint distance. Below that the probe bites, and those are
  // the angles where a T-bone is worth cutting at all.
  const shortProbeAngles = style === 'dogbone' ? TEST_ANGLES : TEST_ANGLES.filter((angle) => angle <= 90)

  test(`${style} stopping short at 1.2r leaves the corner uncut (${shortProbeAngles.join('°, ')}°)`, () => {
    const radius = 3
    for (const angle of shortProbeAngles) {
      const { geometry, wallMoves, descend } = syntheticCorner(angle, radius)
      const short = reliefExcursionEnd(geometry, style, radius * 1.2)
      const moves = [
        ...wallMoves,
        { kind: 'cut' as const, from: { ...descend, z: 0 }, to: { ...short, z: 0 } },
        { kind: 'cut' as const, from: { ...short, z: 0 }, to: { ...descend, z: 0 } },
      ]
      const uncut = wedgeSamples(geometry, radius).some((sample) => !sweptCovers(sample, moves, radius, 0))
      assert(uncut, `${style} at ${angle}° should NOT clear the wedge when it stops 1.2r out`)
    }
  })
}

test('a very obtuse t-bone clears even when short, because its excursion crosses the corner', () => {
  // Recorded rather than hidden: it is why the short probe above is split by
  // style, and it is a statement about coverage, never a licence to end short.
  const radius = 3
  const { geometry, wallMoves, descend } = syntheticCorner(150, radius)
  const short = reliefExcursionEnd(geometry, 't_bone', radius * 1.2)
  const moves = [
    ...wallMoves,
    { kind: 'cut' as const, from: { ...descend, z: 0 }, to: { ...short, z: 0 } },
    { kind: 'cut' as const, from: { ...short, z: 0 }, to: { ...descend, z: 0 } },
  ]
  assert(
    wedgeSamples(geometry, radius).every((sample) => sweptCovers(sample, moves, radius, 0)),
    'at 150° the endpoint distance is not what determines coverage for a t-bone',
  )
})

test('without relief the wall contour alone always leaves the corner uncut', () => {
  const radius = 3
  for (const angle of TEST_ANGLES) {
    const { geometry, wallMoves } = syntheticCorner(angle, radius)
    const uncut = wedgeSamples(geometry, radius).some((sample) => !sweptCovers(sample, wallMoves, radius, 0))
    assert(uncut, `the ${angle}° corner should be uncut before relief — otherwise the coverage test proves nothing`)
  }
})

// ── 3. Corner detection ──────────────────────────────────────────────

console.log('\ncornerRelief — corner detection')

test('the turn threshold is derived from the flattening constants, above 5°', () => {
  assert(
    RELIEF_MIN_CORNER_TURN_RADIANS > Math.PI / 36,
    'the threshold must exceed the arc sampling step, or every tessellation vertex reads as a corner',
  )
  assert(
    RELIEF_MIN_CORNER_TURN_RADIANS < Math.PI / 6,
    'the threshold must stay well below 30°, or real obtuse corners are missed',
  )
})

test('a square boundary yields four corners; its wall path yields the descend points', () => {
  const radius = 2
  const square = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 40 },
    { x: 0, y: 40 },
  ]
  const inset = [
    { x: radius, y: radius },
    { x: 40 - radius, y: radius },
    { x: 40 - radius, y: 40 - radius },
    { x: radius, y: 40 - radius },
  ]
  const found = collectReliefCorners({
    style: 'dogbone',
    toolRadius: radius,
    clearedLoops: [{ points: square, clearedInside: true }],
    wallLoops: [inset],
  })
  assert(found.corners.length === 4, `expected 4 corners, got ${found.corners.length}`)
  assert(found.warnings.length === 0, `expected no warnings, got ${JSON.stringify(found.warnings)}`)
  for (const corner of found.corners) {
    const offset = radius / Math.sin(corner.interiorAngle / 2)
    assert(
      approx(Math.hypot(corner.descend.x - corner.corner.x, corner.descend.y - corner.corner.y), offset, 1e-6),
      'the descend point should sit at the miter distance along the bisector',
    )
  }
})

test('a cleared-outside loop relieves its concave corners only', () => {
  const radius = 2
  // An L-shaped part: one concave corner at (30, 30), five convex ones.
  const part = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 60 },
    { x: 30, y: 60 },
    { x: 30, y: 30 },
    { x: 0, y: 30 },
  ]
  // The tool-centre path is the part grown by the radius; only the segments
  // around the concave corner matter for locating the descend point.
  const wall = [
    { x: 28, y: 32 },
    { x: 28, y: 62 },
    { x: 62, y: 62 },
    { x: 62, y: -2 },
    { x: -2, y: -2 },
    { x: -2, y: 32 },
  ]
  const found = collectReliefCorners({
    style: 'dogbone',
    toolRadius: radius,
    clearedLoops: [{ points: part, clearedInside: false }],
    wallLoops: [wall],
  })
  assert(found.corners.length === 1, `expected 1 concave corner, got ${found.corners.length}`)
  assert(
    approx(found.corners[0].corner.x, 30) && approx(found.corners[0].corner.y, 30),
    'the relieved corner should be the concave one',
  )
})

test('a corner whose adjacent edges cannot hold the notch is rejected, with a warning naming it', () => {
  const radius = 4
  // A 3 mm notch step in an otherwise long wall: the short edges are under 2r.
  const loop = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 37, y: 20 },
    { x: 37, y: 23 },
    { x: 0, y: 23 },
  ]
  const found = collectReliefCorners({
    style: 'dogbone',
    toolRadius: radius,
    clearedLoops: [{ points: loop, clearedInside: true }],
    wallLoops: [loop],
  })
  const tooTight = found.warnings.filter((warning) => warning.code === 'cornerReliefCornerTooTight')
  assert(tooTight.length > 0, 'a corner between two short edges should warn')
  assert(
    tooTight.every((warning) => warning.params?.x !== undefined && warning.params?.y !== undefined),
    'the warning must name the corner',
  )
})

test("style 'none' collects nothing at all", () => {
  const found = collectReliefCorners({
    style: 'none',
    toolRadius: 2,
    clearedLoops: [{ points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], clearedInside: true }],
    wallLoops: [[{ x: 2, y: 2 }, { x: 38, y: 2 }, { x: 38, y: 38 }, { x: 2, y: 38 }]],
  })
  assert(found.corners.length === 0 && found.warnings.length === 0, "'none' must be inert")
})

// ── 4. The stepdown and the descend guard ────────────────────────────

console.log('\ncornerRelief — stepdown and guard')

function normalized(overrides: Partial<NormalizedTool>): NormalizedTool {
  return {
    id: 't', name: 't', sourceUnits: 'mm', units: 'mm', type: 'flat_endmill',
    diameter: 4, radius: 2, vBitAngle: null, flutes: 2, material: 'carbide',
    defaultRpm: 18000, defaultFeed: 800, defaultPlungeFeed: 300,
    defaultStepdown: 2, defaultStepover: 0.4, maxCutDepth: 0,
    ...overrides,
  }
}

test('the relief stepdown is min(defaultStepdown, maxCutDepth), and never operation.stepdown', () => {
  assert(resolveReliefStepdown(normalized({ defaultStepdown: 2, maxCutDepth: 0 })) === 2, 'unlimited max keeps the default')
  assert(resolveReliefStepdown(normalized({ defaultStepdown: 5, maxCutDepth: 3 })) === 3, 'max cut depth should clamp')
  assert(resolveReliefStepdown(normalized({ defaultStepdown: 1, maxCutDepth: 9 })) === 1, 'the default should win when smaller')
  assert(resolveReliefStepdown(normalized({ defaultStepdown: 0, maxCutDepth: 9 })) === null, 'no stepdown must fail closed')
})

test('the guard reads fed moves at or below the level, and ignores rapids and plunges', () => {
  const at = (x: number, y: number, z: number) => ({ x, y, z })
  const cut = (from: [number, number, number], to: [number, number, number], kind: ToolpathMove['kind'] = 'cut'): ToolpathMove =>
    ({ kind, from: at(...from), to: at(...to) })

  assert(mainPathCutsAt([cut([0, 0, -5], [10, 0, -5])], { x: 5, y: 0 }, -5), 'a cut at the level should count')
  assert(mainPathCutsAt([cut([0, 0, -6], [10, 0, -6])], { x: 5, y: 0 }, -5), 'a cut below the level should count')
  assert(!mainPathCutsAt([cut([0, 0, -4], [10, 0, -4])], { x: 5, y: 0 }, -5), 'a cut above the level must not count')
  assert(!mainPathCutsAt([cut([0, 0, -5], [10, 0, -5], 'rapid')], { x: 5, y: 0 }, -5), 'a rapid must not count as cutting')
  assert(!mainPathCutsAt([cut([0, 0, 5], [0, 0, -5], 'plunge')], { x: 0, y: 0 }, -5), 'a plunge must not count as cutting')
  assert(!mainPathCutsAt([cut([0, 0, -5], [10, 0, -5])], { x: 5, y: 1 }, -5), 'a cut 1 mm away must not count')
  assert(mainPathCutsAt([cut([0, 0, -5], [10, 0, -5], 'lead_in')], { x: 5, y: 0 }, -5), 'a lead-in is a fed move')
})

test('a corner the main path never cut emits no motion and one warning', () => {
  const radius = 2
  const found = collectReliefCorners({
    style: 'dogbone',
    toolRadius: radius,
    clearedLoops: [{ points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }], clearedInside: true }],
    wallLoops: [[{ x: 2, y: 2 }, { x: 38, y: 2 }, { x: 38, y: 38 }, { x: 2, y: 38 }]],
  })
  const pass = generateCornerReliefPass(null, {
    corners: found.corners,
    levels: [-2, -4],
    safeZ: 5,
    mainPathMoves: [],
  })
  assert(pass.moves.length === 0, 'no main path means no relief')
  assert(
    pass.warnings.length === 4 && pass.warnings.every((warning) => warning.code === 'cornerReliefCornerNotCut'),
    `expected four guard warnings, got ${JSON.stringify(pass.warnings)}`,
  )
})

// ── 5. Pocket integration ────────────────────────────────────────────

console.log('\ncornerRelief — pocket integration')

const STOCK_TOP = newProject('probe', 'mm').stock.thickness

function pocketResults(
  features: SketchFeature[],
  overrides: Partial<Operation>,
  tools: Tool[] = [makeTool()],
  units: 'mm' | 'inch' = 'mm',
  tabs: Tab[] = [],
): { withRelief: ToolpathResult; withoutRelief: ToolpathResult; project: Project; tool: NormalizedTool } {
  const project = makeProject(features, tools, units, tabs)
  const operation = makeOperation(overrides)
  return {
    withRelief: generatePocketToolpath(project, operation),
    withoutRelief: generatePocketToolpath(project, { ...operation, cornerRelief: 'none' }),
    project,
    tool: normalizeToolForProject(tools[0], project),
  }
}

function squarePocket(size = 40, depth = 2): SketchFeature[] {
  return [makeFeature('pocket', rectProfile(0, 0, size, size), STOCK_TOP, STOCK_TOP - depth)]
}

for (const style of ['dogbone', 't_bone', 'longest_edge'] as const) {
  test(`${style} on a square pocket clears all four corners of the emitted motion`, () => {
    const { withRelief, withoutRelief, tool } = pocketResults(squarePocket(), { cornerRelief: style })
    assert(warningCodes(withRelief).length === 0, `unexpected warnings: ${JSON.stringify(withRelief.warnings)}`)
    const excursions = reliefExcursions(withRelief, withoutRelief)
    assert(excursions.length === 8, `expected 4 out-and-back pairs, got ${excursions.length} cut moves`)

    const bottom = STOCK_TOP - 2
    for (const corner of [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]) {
      const inward = { x: corner.x === 0 ? 1 : -1, y: corner.y === 0 ? 1 : -1 }
      const geometry: CornerGeometry = {
        corner,
        edgeA: { x: inward.x, y: 0 },
        edgeB: { x: 0, y: inward.y },
        lengthA: 40,
        lengthB: 40,
        bisector: { x: inward.x * Math.SQRT1_2, y: inward.y * Math.SQRT1_2 },
        interiorAngle: Math.PI / 2,
      }
      for (const sample of wedgeSamples(geometry, tool.radius)) {
        assert(
          sweptCovers(sample, withRelief.moves, tool.radius, bottom),
          `${style} left (${sample.x.toFixed(3)}, ${sample.y.toFixed(3)}) uncut near corner (${corner.x}, ${corner.y})`,
        )
      }
    }
  })
}

test('acute, right and obtuse corners of one pocket are all relieved', () => {
  // (0,0) is 90°, (60,0) is ~22.6°, (0,25) is ~67.4°.
  const features = [makeFeature('pocket', polygonProfile([[0, 0], [60, 0], [0, 25]]), STOCK_TOP, STOCK_TOP - 2)]
  const { withRelief, withoutRelief, tool } = pocketResults(features, { cornerRelief: 'dogbone' })
  const excursions = reliefExcursions(withRelief, withoutRelief)
  assert(excursions.length === 6, `expected 3 relieved corners, got ${excursions.length / 2}`)
  // The acute corner needs the longest excursion — r(1/sin(θ/2) − 1) grows as θ shrinks.
  const lengths = excursions
    .filter((_, index) => index % 2 === 0)
    .map((move) => Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y))
    .sort((a, b) => a - b)
  const acuteHalf = Math.atan2(25, 60) / 2
  assert(
    approx(lengths[2], tool.radius * (1 / Math.sin(acuteHalf) - 1), 1e-3),
    `the acute corner's excursion should be r(1/sin(θ/2) − 1), got ${lengths[2]}`,
  )
  assert(approx(lengths[0], tool.radius * (Math.SQRT2 - 1), 1e-3), "the 90° corner's excursion should be r(√2 − 1)")
})

test('reflex island corners are relieved and convex island corners are not', () => {
  const features = [
    makeFeature('pocket', rectProfile(0, 0, 60, 60), STOCK_TOP, STOCK_TOP - 2),
    makeFeature('island', polygonProfile([[20, 20], [40, 20], [40, 40], [30, 40], [30, 30], [20, 30]]), STOCK_TOP, STOCK_TOP - 2, 'add'),
  ]
  const { withRelief, withoutRelief } = pocketResults(features, { cornerRelief: 'dogbone' })
  const excursions = reliefExcursions(withRelief, withoutRelief).filter((_, index) => index % 2 === 0)
  assert(excursions.length === 5, `expected 4 boundary + 1 reflex island corner, got ${excursions.length}`)
  const nearIsland = excursions.filter((move) => Math.hypot(move.from.x - 30, move.from.y - 30) < 5)
  assert(nearIsland.length === 1, "the island's reflex corner at (30, 30) should be the only island corner relieved")
})

test('tessellated arcs and existing fillets produce zero relief', () => {
  const circle = [makeFeature('pocket', circleProfile(0, 0, 20), STOCK_TOP, STOCK_TOP - 2)]
  const circleRun = pocketResults(circle, { cornerRelief: 'dogbone' })
  assert(
    circleRun.withRelief.moves.length === circleRun.withoutRelief.moves.length,
    'a circular pocket must emit no relief',
  )
  assert(warningCodes(circleRun.withRelief).length === 0, 'a circular pocket must not warn about corners either')

  for (const filletRadius of [1, 5, 12]) {
    const filleted = [makeFeature('pocket', filletedSquareProfile(40, filletRadius), STOCK_TOP, STOCK_TOP - 2)]
    const run = pocketResults(filleted, { cornerRelief: 'dogbone' })
    assert(
      run.withRelief.moves.length === run.withoutRelief.moves.length,
      `a square filleted at ${filletRadius} mm must emit no relief`,
    )
  }
})

test("'none' and a legacy operation with the field absent are identical to today", () => {
  const project = makeProject(squarePocket())
  const legacy = makeOperation()
  assert(!('cornerRelief' in legacy), 'the fixture must not carry the field')
  const baseline = generatePocketToolpath(project, legacy)
  const explicitNone = generatePocketToolpath(project, makeOperation({ cornerRelief: 'none' }))
  assert(
    JSON.stringify(baseline) === JSON.stringify(explicitNone),
    "'none' must produce the identical toolpath — same moves, bounds, warnings and step levels",
  )
  const relieved = generatePocketToolpath(project, makeOperation({ cornerRelief: 'dogbone' }))
  assert(
    JSON.stringify(baseline) !== JSON.stringify(relieved),
    'a real style must change the toolpath — otherwise this test proves nothing',
  )
  assert(
    JSON.stringify(relieved.moves.slice(0, baseline.moves.length)) === JSON.stringify(baseline.moves),
    'relief must be appended after the main path, leaving it untouched',
  )
})

test('the relief pass steps down at the tool stepdown, not at operation.stepdown', () => {
  const tool = makeTool({ defaultStepdown: 1.5 })
  const { withRelief, withoutRelief } = pocketResults(
    squarePocket(40, 6),
    // A deliberately coarse operation stepdown: if relief used it there would be
    // two levels rather than four.
    { cornerRelief: 'dogbone', stepdown: 6 },
    [tool],
  )
  const levels = [...new Set(reliefExcursions(withRelief, withoutRelief).map((move) => Number(move.z.toFixed(6))))]
    .sort((a, b) => b - a)
  assert(levels.length === 4, `expected 4 relief levels at 1.5 mm over 6 mm, got ${levels.length}`)
  for (let index = 1; index < levels.length; index += 1) {
    assert(levels[index - 1] - levels[index] <= 1.5 + 1e-9, 'no relief step may exceed the tool stepdown')
  }
  assert(approx(levels[levels.length - 1], STOCK_TOP - 6), 'the deepest relief level should be the band bottom')
})

test('maxCutDepth clamps the relief stepdown', () => {
  const tool = makeTool({ defaultStepdown: 4, maxCutDepth: 1 })
  const { withRelief, withoutRelief } = pocketResults(squarePocket(40, 4), { cornerRelief: 'dogbone' }, [tool])
  const levels = [...new Set(reliefExcursions(withRelief, withoutRelief).map((move) => Number(move.z.toFixed(6))))]
  assert(levels.length === 4, `expected 4 relief levels at the 1 mm max cut depth, got ${levels.length}`)
})

test('a tool with no stepdown fails the relief closed with a warning', () => {
  const tool = makeTool({ defaultStepdown: 0 })
  const { withRelief, withoutRelief } = pocketResults(squarePocket(), { cornerRelief: 'dogbone' }, [tool])
  assert(withRelief.moves.length === withoutRelief.moves.length, 'no stepdown must emit no relief')
  assert(warningCodes(withRelief).includes('cornerReliefNoStepdown'), 'and must say why')
})

test('a pocket finish with finishWalls off skips every corner and says which', () => {
  const off = pocketResults(squarePocket(), {
    cornerRelief: 'dogbone', pass: 'finish', finishWalls: false, finishFloor: true,
  })
  assert(off.withRelief.moves.length === off.withoutRelief.moves.length, 'no wall contour means no descend point')
  const skipped = off.withRelief.warnings.filter((warning) => warning.code === 'cornerReliefCornerNotCut')
  assert(skipped.length === 4, `expected all four corners skipped, got ${skipped.length}`)
  assert(
    skipped.every((warning) => warning.params?.x !== undefined),
    'each skipped corner must be named',
  )

  const on = pocketResults(squarePocket(), {
    cornerRelief: 'dogbone', pass: 'finish', finishWalls: true, finishFloor: true,
  })
  assert(
    reliefExcursions(on.withRelief, on.withoutRelief).length === 8,
    'with the wall pass on, all four corners are relieved',
  )
})

test('radial stock sizes the relief to the wall the pass actually leaves', () => {
  const radialLeave = 0.5
  const { withRelief, withoutRelief, tool } = pocketResults(squarePocket(), {
    cornerRelief: 'dogbone', stockToLeaveRadial: radialLeave,
  })
  const excursions = reliefExcursions(withRelief, withoutRelief).filter((_, index) => index % 2 === 0)
  assert(excursions.length === 4, 'four corners')
  // The cleared corner sits `radialLeave / sin(θ/2)` inside the nominal one, and
  // the excursion still ends one cutter radius from it.
  const clearedCorner = { x: 40 - radialLeave, y: 40 - radialLeave }
  const nearest = excursions.reduce((best, move) => (
    Math.hypot(move.to.x - clearedCorner.x, move.to.y - clearedCorner.y)
      < Math.hypot(best.to.x - clearedCorner.x, best.to.y - clearedCorner.y) ? move : best
  ))
  assert(
    approx(Math.hypot(nearest.to.x - clearedCorner.x, nearest.to.y - clearedCorner.y), tool.radius, 1e-3),
    'the excursion should end one radius from the corner of the region this pass clears',
  )
})

test('rough big with stock and no relief, then finish small with relief, clears the corner', () => {
  // The workflow the design exists for: the lobe must be sized to the tool that
  // defines the final wall, so relief belongs on the finish pass.
  const roughTool = makeTool({ id: 'rough', name: '10 mm', diameter: 10, defaultStepdown: 3 })
  const finishTool = makeTool({ id: 'finish', name: '3 mm', diameter: 3, defaultStepdown: 1 })
  const project = makeProject(squarePocket(40, 4), [roughTool, finishTool])
  const rough = generatePocketToolpath(project, makeOperation({
    toolRef: 'rough', pass: 'rough', stockToLeaveRadial: 0.4, stepdown: 3, cornerRelief: 'none',
  }))
  const finish = generatePocketToolpath(project, makeOperation({
    toolRef: 'finish', pass: 'finish', stockToLeaveRadial: 0, stepdown: 1, cornerRelief: 'dogbone',
  }))
  assert(warningCodes(finish).length === 0, `finish pass warned: ${JSON.stringify(finish.warnings)}`)

  const finishRadius = 1.5
  const combined = [...rough.moves, ...finish.moves]
  const corner = { x: 40, y: 40 }
  const geometry: CornerGeometry = {
    corner,
    edgeA: { x: -1, y: 0 },
    edgeB: { x: 0, y: -1 },
    lengthA: 40,
    lengthB: 40,
    bisector: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
    interiorAngle: Math.PI / 2,
  }
  for (const sample of wedgeSamples(geometry, finishRadius)) {
    assert(
      sweptCovers(sample, combined, finishRadius, STOCK_TOP - 4),
      `rough+finish left (${sample.x.toFixed(3)}, ${sample.y.toFixed(3)}) uncut`,
    )
  }
  // And nothing is cut more than the notch depth past the wall.
  const overshoot = finish.moves
    .filter((move) => FED_KINDS.has(move.kind))
    .reduce((most, move) => Math.max(most, move.to.x - 40, move.to.y - 40), -Infinity)
  const notchDepth = finishRadius * (1 - Math.sin(Math.PI / 4))
  assert(
    overshoot <= notchDepth + 1e-6,
    `the tool centre should stay within the notch depth of the wall, overshot by ${overshoot}`,
  )
})

test('linearMoveOptimization preserves the out-and-back excursion', () => {
  const { withRelief, withoutRelief } = pocketResults(squarePocket(), { cornerRelief: 'dogbone' })
  const before = reliefExcursions(withRelief, withoutRelief)
  const optimized = optimizeLinearMoves(withRelief)
  // The relief pass survives only because the collinear merge requires dot > 0.
  // A plausible future tidy-up that dropped that would silently delete every
  // relief excursion, which is why this is asserted rather than assumed.
  const optimizedReliefCuts = optimized.moves.filter((move) => (
    move.kind === 'cut'
    && before.some((excursion) => (
      approx(move.from.x, excursion.from.x, 1e-9)
      && approx(move.from.y, excursion.from.y, 1e-9)
      && approx(move.to.x, excursion.to.x, 1e-9)
      && approx(move.to.y, excursion.to.y, 1e-9)
    ))
  ))
  assert(
    optimizedReliefCuts.length === before.length,
    `expected all ${before.length} excursion moves to survive optimization, got ${optimizedReliefCuts.length}`,
  )
})

test('relief composes with roundOutsideCorners on a pocket', () => {
  for (const roundOutsideCorners of [false, true]) {
    const { withRelief, withoutRelief } = pocketResults(squarePocket(), { cornerRelief: 'dogbone', roundOutsideCorners })
    assert(
      reliefExcursions(withRelief, withoutRelief).length === 8,
      `roundOutsideCorners=${roundOutsideCorners} should still relieve all four corners`,
    )
    assert(
      warningCodes(withRelief).length === 0,
      `roundOutsideCorners=${roundOutsideCorners} warned: ${JSON.stringify(withRelief.warnings)}`,
    )
  }
})

test('the parallel pocket pattern relieves the same corners as the offset pattern', () => {
  const offset = pocketResults(squarePocket(), { cornerRelief: 'dogbone', pocketPattern: 'offset' })
  const parallel = pocketResults(squarePocket(), { cornerRelief: 'dogbone', pocketPattern: 'parallel' })
  const ends = (run: { withRelief: ToolpathResult; withoutRelief: ToolpathResult }) =>
    reliefExcursions(run.withRelief, run.withoutRelief)
      .filter((_, index) => index % 2 === 0)
      .map((move) => `${move.to.x.toFixed(4)},${move.to.y.toFixed(4)}`)
      .sort()
  assert(
    JSON.stringify(ends(offset)) === JSON.stringify(ends(parallel)),
    'the pattern changes how the floor is cleared, never where the relief goes',
  )
})

test('the excursion carries the slot feed scale', () => {
  const { withRelief, withoutRelief } = pocketResults(squarePocket(), {
    cornerRelief: 'dogbone', pocketSlotFeedPercent: 60,
  })
  const excursions = withRelief.moves.slice(withoutRelief.moves.length).filter((move) => move.kind === 'cut')
  assert(excursions.length === 8, 'four out-and-back pairs')
  assert(
    excursions.every((move) => move.feedScale === 0.6),
    'the excursion averages 2r of chip width — it is a slotting cut',
  )
})

// ── 6. Units ─────────────────────────────────────────────────────────

console.log('\ncornerRelief — units')

test('an inch project relieves at the inch cutter radius', () => {
  const size = 1.6
  const depth = 0.1
  const inchTool = makeTool({ units: 'inch', diameter: 0.25, defaultStepdown: 0.08, maxCutDepth: 0 })
  const project = makeProject(
    [makeFeature('pocket', rectProfile(0, 0, size, size), 0.5, 0.5 - depth)],
    [inchTool],
    'inch',
  )
  const operation = makeOperation({ cornerRelief: 'dogbone', stepdown: 0.08 })
  const withRelief = generatePocketToolpath(project, operation)
  const withoutRelief = generatePocketToolpath(project, { ...operation, cornerRelief: 'none' })
  const excursions = reliefExcursions(withRelief, withoutRelief).filter((_, index) => index % 2 === 0)
  // 0.1" of depth at the tool's 0.08" stepdown is two relief levels, so count
  // distinct endpoints rather than excursions.
  const endpoints = new Set(excursions.map((move) => `${move.to.x.toFixed(6)},${move.to.y.toFixed(6)}`))
  assert(endpoints.size === 4, `expected 4 relieved corners in an inch project, got ${endpoints.size}`)
  assert(excursions.length === 8, `expected 2 relief levels over 0.1" at 0.08", got ${excursions.length / 4}`)
  const radius = 0.125
  const nearest = excursions.reduce((best, move) => (
    Math.hypot(move.to.x - size, move.to.y - size) < Math.hypot(best.to.x - size, best.to.y - size) ? move : best
  ))
  assert(
    approx(Math.hypot(nearest.to.x - size, nearest.to.y - size), radius, 1e-6),
    'the excursion should end one inch-radius from the corner',
  )
})

test('a tool recorded in the other unit system is converted before it sizes the relief', () => {
  // An inch-recorded 1/4" cutter used in an mm project: r = 3.175 mm.
  const inchTool = makeTool({ units: 'inch', diameter: 0.25, defaultStepdown: 0.08, maxCutDepth: 0 })
  const { withRelief, withoutRelief, tool } = pocketResults(squarePocket(40, 2), { cornerRelief: 'dogbone' }, [inchTool])
  assert(approx(tool.radius, convertLength(0.125, 'inch', 'mm'), 1e-9), 'the fixture should normalize to mm')
  const excursions = reliefExcursions(withRelief, withoutRelief).filter((_, index) => index % 2 === 0)
  assert(excursions.length === 4, `expected 4 corners, got ${excursions.length}`)
  const nearest = excursions.reduce((best, move) => (
    Math.hypot(move.to.x - 40, move.to.y - 40) < Math.hypot(best.to.x - 40, best.to.y - 40) ? move : best
  ))
  assert(
    approx(Math.hypot(nearest.to.x - 40, nearest.to.y - 40), tool.radius, 1e-6),
    'the excursion should end one converted radius from the corner',
  )
})

// ── 7. Edge routes ───────────────────────────────────────────────────

console.log('\ncornerRelief — edge routes')

function edgeResults(
  features: SketchFeature[],
  overrides: Partial<Operation>,
  tabs: Tab[] = [],
): { withRelief: ToolpathResult; withoutRelief: ToolpathResult } {
  const project = makeProject(features, [makeTool()], 'mm', tabs)
  const operation = makeOperation(overrides)
  return {
    withRelief: generateEdgeRouteToolpath(project, operation),
    withoutRelief: generateEdgeRouteToolpath(project, { ...operation, cornerRelief: 'none' }),
  }
}

const L_PART: Array<[number, number]> = [[0, 0], [60, 0], [60, 60], [30, 60], [30, 30], [0, 30]]

test('an inside edge route relieves the convex corners of its boundary', () => {
  const run = edgeResults(
    [makeFeature('pocket', rectProfile(0, 0, 40, 40), STOCK_TOP, STOCK_TOP - 2)],
    { kind: 'edge_route_inside', cornerRelief: 'dogbone', target: { source: 'features', featureIds: ['pocket'] } },
  )
  assert(reliefExcursions(run.withRelief, run.withoutRelief).length === 8, 'four corners, out and back')
  assert(warningCodes(run.withRelief).length === 0, `warned: ${JSON.stringify(run.withRelief.warnings)}`)
})

test('an outside edge route relieves concave part corners only', () => {
  const run = edgeResults(
    [makeFeature('part', polygonProfile(L_PART), STOCK_TOP, STOCK_TOP - 2, 'add')],
    { kind: 'edge_route_outside', cornerRelief: 'dogbone', target: { source: 'features', featureIds: ['part'] } },
  )
  const excursions = reliefExcursions(run.withRelief, run.withoutRelief).filter((_, index) => index % 2 === 0)
  assert(excursions.length === 1, `an L part has exactly one concave corner, got ${excursions.length}`)
  assert(
    Math.hypot(excursions[0].from.x - 28, excursions[0].from.y - 32) < 1e-6,
    'the descend point should be the wall path corner outside (30, 30)',
  )

  const square = edgeResults(
    [makeFeature('part', rectProfile(0, 0, 40, 40), STOCK_TOP, STOCK_TOP - 2, 'add')],
    { kind: 'edge_route_outside', cornerRelief: 'dogbone', target: { source: 'features', featureIds: ['part'] } },
  )
  assert(
    square.withRelief.moves.length === square.withoutRelief.moves.length,
    'a convex part has nothing to relieve — the cutter wraps those corners',
  )
})

test('relief and roundOutsideCorners act on disjoint corner sets, so both may be on', () => {
  for (const roundOutsideCorners of [false, true]) {
    const run = edgeResults(
      [makeFeature('part', polygonProfile(L_PART), STOCK_TOP, STOCK_TOP - 2, 'add')],
      {
        kind: 'edge_route_outside',
        cornerRelief: 'dogbone',
        roundOutsideCorners,
        target: { source: 'features', featureIds: ['part'] },
      },
    )
    assert(
      reliefExcursions(run.withRelief, run.withoutRelief).length === 2,
      `roundOutsideCorners=${roundOutsideCorners} should still relieve the concave corner`,
    )
  }
})

test('a corner under a tab is skipped rather than plunged into', () => {
  const run = edgeResults(
    [makeFeature('part', polygonProfile(L_PART), STOCK_TOP, STOCK_TOP - 2, 'add')],
    { kind: 'edge_route_outside', cornerRelief: 'dogbone', target: { source: 'features', featureIds: ['part'] } },
    [rectTab(30, 30, 12, STOCK_TOP - 0.5, STOCK_TOP - 2)],
  )
  assert(run.withRelief.moves.length === run.withoutRelief.moves.length, 'a tabbed corner must emit no relief')
  assert(
    warningCodes(run.withRelief).includes('cornerReliefCornerObstructed'),
    `expected an obstruction warning, got ${JSON.stringify(run.withRelief.warnings)}`,
  )
})

test('a tab clear of the corner leaves the relief in place', () => {
  const run = edgeResults(
    [makeFeature('part', polygonProfile(L_PART), STOCK_TOP, STOCK_TOP - 2, 'add')],
    { kind: 'edge_route_outside', cornerRelief: 'dogbone', target: { source: 'features', featureIds: ['part'] } },
    [rectTab(10, 0, 8, STOCK_TOP - 0.5, STOCK_TOP - 2)],
  )
  assert(reliefExcursions(run.withRelief, run.withoutRelief).length === 2, 'a distant tab must not suppress relief')
})

test('trochoidal roughing is rejected by the guard, not silently relieved', () => {
  const run = edgeResults(
    [makeFeature('pocket', rectProfile(0, 0, 40, 40), STOCK_TOP, STOCK_TOP - 2)],
    {
      kind: 'edge_route_inside',
      cornerRelief: 'dogbone',
      edgeStrategy: 'trochoidal',
      entryStrategy: 'helix',
      target: { source: 'features', featureIds: ['pocket'] },
    },
  )
  assert(run.withRelief.moves.length === run.withoutRelief.moves.length, 'the swept channel may not include the wall path')
  assert(
    warningCodes(run.withRelief).filter((code) => code === 'cornerReliefCornerNotCut').length === 4,
    'each unreached corner should say so',
  )
})

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\ncornerRelief: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  throw new Error(`${failed} cornerRelief test(s) failed`)
}
