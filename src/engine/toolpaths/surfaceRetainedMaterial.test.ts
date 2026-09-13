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
 * Retained 2.5D material around an imported model (issue #773).
 *
 * A dome on a flat skirt, placed three ways against 2D features that contain
 * its whole silhouette — the shape every surface operation's containment test
 * used to drop as "base geometry" and then ignore:
 *
 * - on a plate whose top sits part-way up the dome;
 * - in a pocket sunk into a block, with the silhouette crossing all four walls;
 * - in an L-shaped pocket, whose inside corner leaves a convex block of
 *   material standing next to the dome.
 *
 * The oracle is independent of the code under test: the retained material is
 * written out here as axis-aligned boxes, and every move is sampled against the
 * exact ball or flat cutter body. It asks about the cutter, not the tool centre,
 * because a centre held off a wall is exactly what gouged it.
 *
 * Run with: npx tsx src/engine/toolpaths/surfaceRetainedMaterial.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rectProfile, type Operation, type PocketPattern, type Project, type SketchFeature } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { slopeTestMesh, surfaceTestProject } from '../../test/surfaceSlopeFixtures'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { generateFinishSurfaceCleanupToolpath } from './finishSurfaceCleanup'
import { generateRoughSurfaceToolpath } from './roughSurface'
import { DEFAULT_CLIPPER_SCALE, normalizeToolForProject } from './geometry'
import { calculateClipperArea } from './modelProtection'
import { buildRetainedMaterial, buildRetainedMaterialCheck, containingAddFeatures } from './retainedMaterial'
import type { ClipperPath, ToolpathMove } from './types'

const TOOL_DIAMETER = 6
const RADIUS = TOOL_DIAMETER / 2
const TOLERANCE = 1e-3
const SAMPLE_SPACING = 0.1

const domeAt = (cx: number, cy: number) => (x: number, y: number): number =>
  6 * Math.max(0, 1 - ((x - cx) ** 2 + (y - cy) ** 2) / 64)

interface Box { x0: number; y0: number; x1: number; y1: number; top: number }

function prism(
  id: string,
  operation: 'add' | 'subtract',
  x0: number, y0: number, x1: number, y1: number,
  zBottom: number, zTop: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x0, y0, x1 - x0, y1 - y0),
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

interface Fixture {
  project: Project
  operation: Operation
  material: Box[]
  /** The lowest Z the dome is machined at, for the anti-vacuity check. */
  surfaceAbove: number
}

function fixture(
  features: SketchFeature[],
  material: Box[],
  surfaceAbove: number,
  toolType: 'ball_endmill' | 'flat_endmill',
  surface = domeAt(20, 12),
): Fixture {
  const { project: base, operation } = surfaceTestProject(slopeTestMesh(surface, 40, 24, 0.5), TOOL_DIAMETER)
  const project = projectWithFeatures(base, [...base.features, ...features])
  project.tools[0] = { ...project.tools[0], type: toolType }
  return {
    project,
    operation: { ...operation, stepdown: 1, stepover: 0.25, stockToLeaveAxial: 0, stockToLeaveRadial: 0 },
    material,
    surfaceAbove,
  }
}

// The silhouette is the mesh bounding box, 0..40 x 0..24; everything below contains it.
const BLOCK = { x0: -30, y0: -30, x1: 70, y1: 54 }

function plateUnderModel(toolType: 'ball_endmill' | 'flat_endmill' = 'ball_endmill'): Fixture {
  return fixture(
    [prism('plate', 'add', BLOCK.x0, BLOCK.y0, BLOCK.x1, BLOCK.y1, -4, 2)],
    [{ ...BLOCK, top: 2 }],
    2.5,
    toolType,
  )
}

/** Four boxes of block standing around a rectangular pocket, plus the floor under it. */
function frame(x0: number, y0: number, x1: number, y1: number, top: number, floor: number): Box[] {
  return [
    { x0: BLOCK.x0, y0: BLOCK.y0, x1: x0, y1: BLOCK.y1, top },
    { x0: x1, y0: BLOCK.y0, x1: BLOCK.x1, y1: BLOCK.y1, top },
    { x0, y0: BLOCK.y0, x1, y1: y0, top },
    { x0, y0: y1, x1, y1: BLOCK.y1, top },
    { ...BLOCK, top: floor },
  ]
}

function pocketCrossingWalls(toolType: 'ball_endmill' | 'flat_endmill' = 'ball_endmill'): Fixture {
  return fixture(
    [
      prism('block', 'add', BLOCK.x0, BLOCK.y0, BLOCK.x1, BLOCK.y1, -4, 6),
      prism('pocket', 'subtract', 3, 3, 37, 21, -1, 6),
    ],
    frame(3, 3, 37, 21, 6, -1),
    -0.5,
    toolType,
  )
}

function lShapedPocket(toolType: 'ball_endmill' | 'flat_endmill' = 'ball_endmill'): Fixture {
  return fixture(
    [
      prism('block', 'add', BLOCK.x0, BLOCK.y0, BLOCK.x1, BLOCK.y1, -4, 6),
      prism('pocket-long', 'subtract', 3, 3, 37, 10, -1, 6),
      prism('pocket-tall', 'subtract', 3, 3, 18, 21, -1, 6),
    ],
    [...frame(3, 3, 37, 21, 6, -1), { x0: 18, y0: 10, x1: 37, y1: 21, top: 6 }],
    -0.5,
    toolType,
    // The dome sits in the tall arm, clear of the inside corner at (18, 10), so
    // the ground round that corner is flat: the mesh link check passes every
    // keep-down link there, and only the retained check can refuse one that
    // cuts across the corner.
    domeAt(10, 16),
  )
}

interface Intrusion { count: number; worst: number; at: string }

/** How far below the lowest safe tip Z each sampled position of the cutter sits. */
function intrusions(moves: ToolpathMove[], material: Box[], ball: boolean): Intrusion {
  const found: Intrusion = { count: 0, worst: 0, at: '' }
  for (const move of moves) {
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y, move.to.z - move.from.z)
    const steps = Math.max(1, Math.ceil(length / SAMPLE_SPACING))
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps
      const x = move.from.x + (move.to.x - move.from.x) * t
      const y = move.from.y + (move.to.y - move.from.y) * t
      const z = move.from.z + (move.to.z - move.from.z) * t
      let required = -Infinity
      for (const box of material) {
        const d = Math.hypot(Math.max(box.x0 - x, 0, x - box.x1), Math.max(box.y0 - y, 0, y - box.y1))
        if (d >= RADIUS - TOLERANCE) continue
        required = Math.max(required, ball ? box.top - RADIUS + Math.sqrt(RADIUS * RADIUS - d * d) : box.top)
      }
      const depth = required - z
      if (depth > TOLERANCE) {
        found.count += 1
        if (depth > found.worst) {
          found.worst = depth
          found.at = `(${x.toFixed(3)}, ${y.toFixed(3)}, Z ${z.toFixed(3)}) on a ${move.kind} move`
        }
      }
    }
  }
  return found
}

function cutLengthAbove(moves: ToolpathMove[], z: number): number {
  return moves
    .filter((move) => move.kind === 'cut' && move.from.z >= z && move.to.z >= z)
    .reduce((total, move) => total + Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y), 0)
}

function assertClear(moves: ToolpathMove[], built: Fixture, ball: boolean): void {
  const found = intrusions(moves, built.material, ball)
  assert.equal(
    found.count, 0,
    `${found.count} sampled cutter positions enter retained material, worst ${found.worst.toFixed(4)} mm at ${found.at}`,
  )
  // Anti-vacuity: an empty toolpath would pass the check above.
  assert(
    cutLengthAbove(moves, built.surfaceAbove) > 20,
    `the dome above Z ${built.surfaceAbove} is no longer machined`,
  )
}

const SHAPES: Array<[string, (toolType?: 'ball_endmill' | 'flat_endmill') => Fixture]> = [
  ['a plate under the model', plateUnderModel],
  ['a pocket whose walls the silhouette crosses', pocketCrossingWalls],
  ['an L-shaped pocket with a standing inside corner', lShapedPocket],
]

for (const [shape, build] of SHAPES) {
  for (const pattern of ['parallel', 'waterline', 'constant_scallop'] as PocketPattern[]) {
    test(`finish ${pattern}: the ball stays out of ${shape}`, () => {
      const built = build()
      const result = generateFinishSurfaceToolpath(built.project, { ...built.operation, pocketPattern: pattern })
      assertClear(result.moves, built, true)
    })
  }

  test(`rough: a flat cutter stays out of ${shape}`, () => {
    const built = build('flat_endmill')
    const result = generateRoughSurfaceToolpath(built.project, {
      ...built.operation, kind: 'rough_surface', pass: 'rough', pocketPattern: 'offset', stepover: 0.4,
    })
    assertClear(result.moves, built, false)
  })

  test(`cleanup: a flat cutter stays out of ${shape}`, () => {
    const built = build('flat_endmill')
    const result = generateFinishSurfaceCleanupToolpath(built.project, {
      ...built.operation, kind: 'finish_surface_cleanup', pass: 'rough', pocketPattern: 'offset', stepover: 0.4,
    })
    assertClear(result.moves, built, false)
  })
}

test('finish parallel at 45 degrees: a keep-down link does not cut across a standing inside corner', () => {
  // At 0 degrees every zigzag link on this fixture falls on the dome side, away
  // from the corner, so the tests above cannot see the link check. At 45 the
  // scanline ends step round the corner block and consecutive ends are linked
  // at depth: with only the mesh link check, 16 sampled cutter positions land
  // inside the block, worst 0.419 mm, all on link moves.
  const built = lShapedPocket()
  const result = generateFinishSurfaceToolpath(built.project, { ...built.operation, pocketPattern: 'parallel', pocketAngle: 45 })
  assertClear(result.moves, built, true)
})

// ── The model itself ────────────────────────────────────────────────────────

const SILHOUETTE: ClipperPath[] = [[
  { X: 0, Y: 0 },
  { X: 40 * DEFAULT_CLIPPER_SCALE, Y: 0 },
  { X: 40 * DEFAULT_CLIPPER_SCALE, Y: 24 * DEFAULT_CLIPPER_SCALE },
  { X: 0, Y: 24 * DEFAULT_CLIPPER_SCALE },
]]

function pocketMaterial() {
  const { project, operation } = pocketCrossingWalls()
  const targets = new Set(operation.target.source === 'features' ? operation.target.featureIds : [])
  const adds = containingAddFeatures(project, targets, SILHOUETTE, 0)
  const material = buildRetainedMaterial(project, targets, adds)
  assert(material, 'the block and its pocket leave material standing')
  return { project, adds, material }
}

test('a pocket sunk into a block is the block below the floor and the frame above it', () => {
  const { adds, material } = pocketMaterial()
  assert.deepEqual(adds.map((feature) => feature.id), ['block'])
  assert.deepEqual(material.bands.map((band) => [band.bottomZ, band.topZ]), [[-4, -1], [-1, 6]])

  const blockArea = (BLOCK.x1 - BLOCK.x0) * (BLOCK.y1 - BLOCK.y0)
  const frameArea = blockArea - 34 * 18
  const areaAbove = (z: number): number => calculateClipperArea(material.footprintAbove(z))
  assert.equal(areaAbove(-2), blockArea)
  assert.equal(areaAbove(0), frameArea)
  // A tip on the pocket floor, or on the block's top, is touching — not cutting.
  assert.equal(areaAbove(-1), frameArea)
  assert.equal(areaAbove(6), 0)
})

test('a ball clears a wall top at top - r + sqrt(r^2 - d^2), and stock to leave lifts that by exactly itself', () => {
  const { project, material } = pocketMaterial()
  const tool = normalizeToolForProject(project.tools[0], project)
  const check = buildRetainedMaterialCheck(material, tool, 0)
  const near = (actual: number, expected: number): void => assert(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)

  near(check.requiredTipZ(20, 12), -1)                          // mid-pocket: only the floor
  near(check.requiredTipZ(4.5, 12), 6 - RADIUS + Math.sqrt(RADIUS ** 2 - 1.5 ** 2))
  near(check.requiredTipZ(2, 12), 6)                            // over the wall itself
  near(check.requiredTipZ(3 + RADIUS, 12), -1)                  // exactly a radius off: tangent
  near(buildRetainedMaterialCheck(material, tool, 0.5).requiredTipZ(4.5, 12), 6.5 - RADIUS + Math.sqrt(RADIUS ** 2 - 1.5 ** 2))
})

test('a clear pass comes back as its own only run, and a pass into a wall stops a radius short of it', () => {
  const { project, material } = pocketMaterial()
  const check = buildRetainedMaterialCheck(material, normalizeToolForProject(project.tools[0], project), 0)
  const make = (x: number, y: number, z: number) => ({ x, y, z })
  const zOf = (point: { z: number }): number => point.z

  const clear = [make(10, 12, 0), make(30, 12, 0)]
  const clearRuns = check.splitPolyline(clear, false, zOf, make)
  assert.equal(clearRuns.length, 1)
  assert.equal(clearRuns[0].points, clear, 'a clear pass must be passed through untouched')

  const intoWall = check.splitPolyline([make(-2, 12, 0), make(10, 12, 0)], false, zOf, make)
  assert.equal(intoWall.length, 1)
  const start = intoWall[0].points[0]
  assert(start.x >= 3 + RADIUS - TOLERANCE && start.x <= 3 + RADIUS + RADIUS / 16, `run starts at x ${start.x}`)
})

test('a closed ring broken by a wall rejoins across its seam into one open run', () => {
  const { project, material } = pocketMaterial()
  const check = buildRetainedMaterialCheck(material, normalizeToolForProject(project.tools[0], project), 0)
  const make = (x: number, y: number, z: number) => ({ x, y, z })
  // The seam vertex (10, 8) is clear; only the edge along x = 1 is inside the wall.
  const ring = [make(10, 8, 0), make(10, 16, 0), make(1, 16, 0), make(1, 8, 0)]
  const runs = check.splitPolyline(ring, true, (point) => point.z, make)
  assert.equal(runs.length, 1, `expected one run, got ${runs.length}`)
  const [run] = runs
  assert.equal(run.closed, false)
  assert.equal(run.points[0].y, 8)
  assert.equal(run.points[run.points.length - 1].y, 16)
  assert(run.points.includes(ring[0]) && run.points.includes(ring[1]), 'the clear seam vertices are kept')
})
