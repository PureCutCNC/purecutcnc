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
 * An imported model enclosed by an outside route's target (issue #1225).
 *
 * `routeObstacleCandidates` gives every imported model its whole top-down
 * silhouette as a keep-out. When the target encloses the model, the target's
 * wall IS that silhouette, so a zero-stock finish pass put its contour exactly
 * on the keep-out edge and the mask removed the wall path: no moves, and an
 * `edgeRouteBlockedByParts` warning. The rough pass only survived because its
 * radial stock sat just outside the keep-out.
 *
 * A model is now clipped by the outlines of the route's own closed targets
 * before it becomes an obstacle; a model that is itself one of those targets is
 * left whole, so #179's target-cut-at still lets it stand in another target's
 * way. Only models change: an `add` obstacle, the subtract holes, clamps and
 * the multi-target rules stay exactly as they are, and a model that sticks out
 * past the target keeps the part that sticks out.
 *
 * Every assertion on the cutter is on its body — the tool centre plus its
 * radius — not on the centre alone.
 *
 * Mutation check: replacing the clipped model paths with the candidate's
 * original `paths` (`clipModelToTargets` returning the candidate unchanged)
 * fails block 1 — the finish route emits no moves and warns
 * `edgeRouteBlockedByParts`. Dropping the "not one of this route's targets"
 * guard fails block 5 with a 2 mm gouge into a deeper model target.
 *
 * Run with: npx tsx src/engine/toolpaths/edgeModelEnclosed.test.ts
 */

import { generateEdgeRouteToolpath } from './edge'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  defaultTool,
  newProject,
  rectProfile,
  type Operation,
  type Point,
  type Project,
  type SketchFeature,
} from '../../types/project'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

const TOOL_DIAMETER = 6
const R = TOOL_DIAMETER / 2
const TOLERANCE = 1e-3
/** A model whose outline is the target's wall, and the target's own span. */
const TARGET = { minX: 0, minY: 0, maxX: 40, maxY: 30 }
const TOP_Z = 20
const BOTTOM_Z = 0

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * A drawn rectangle. A model carries the same outline as its silhouette, which
 * is what `routeObstacleCandidates` reads; its mesh never reaches the route.
 */
function rectFeature(
  id: string,
  box: Box,
  operation: 'add' | 'model',
  topZ: number,
  bottomZ: number,
): SketchFeature {
  const width = box.maxX - box.minX
  const height = box.maxY - box.minY
  const base = {
    id,
    name: id,
    folderId: null,
    sketch: {
      profile: rectProfile(box.minX, box.minY, width, height),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: topZ,
    z_bottom: bottomZ,
    visible: true,
    locked: false,
  }
  if (operation === 'add') {
    return { ...base, kind: 'rect' } as unknown as SketchFeature
  }
  return {
    ...base,
    kind: 'stl',
    stl: {
      format: 'stl',
      meshAssetId: 'model-mesh',
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: box.minX, y: box.minY },
        { x: box.maxX, y: box.minY },
        { x: box.maxX, y: box.maxY },
        { x: box.minX, y: box.maxY },
      ]],
    },
  } as unknown as SketchFeature
}

function project(features: SketchFeature[]): Project {
  const tool = { ...defaultTool('mm', 1), id: 't1', name: 't1', diameter: TOOL_DIAMETER, defaultStepdown: 2 }
  return projectWithFeatures({ ...newProject('edge-model-enclosed', 'mm'), tools: [tool] }, features)
}

function outsideOperation(
  target: string,
  pass: 'rough' | 'finish',
  stockToLeaveRadial: number,
): Operation {
  return {
    id: 'op1', name: 'op', kind: 'edge_route_outside', pass, enabled: true, showToolpath: true,
    debugToolpath: false, target: { source: 'features', featureIds: [target] }, toolRef: 't1',
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial, stockToLeaveAxial: 0,
    finishWalls: false, finishFloor: false, carveDepth: 6, maxCarveDepth: 6,
    cutDirection: 'conventional', machiningOrder: 'feature_first', entryStrategy: 'plunge',
  } as Operation
}

const codes = (result: { warnings: { code: string }[] }) => result.warnings.map((warning) => warning.code)

/** How far a point is from a box's material: 0 inside it, positive outside. */
function distanceToBox(point: Point, box: Box): number {
  const dx = Math.max(box.minX - point.x, 0, point.x - box.maxX)
  const dy = Math.max(box.minY - point.y, 0, point.y - box.maxY)
  return Math.hypot(dx, dy)
}

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'cut')
}

/** Every tool-centre point along `moves`, sampled every 0.25 mm. */
function samplesAlong(moves: ToolpathMove[]): Point[] {
  return moves.flatMap((move) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) / 0.25))
    return Array.from({ length: steps + 1 }, (_, step) => ({
      x: move.from.x + (move.to.x - move.from.x) * step / steps,
      y: move.from.y + (move.to.y - move.from.y) * step / steps,
    }))
  })
}

function bounds(moves: ToolpathMove[]) {
  return moves.reduce((acc, move) => ({
    minX: Math.min(acc.minX, move.from.x, move.to.x),
    maxX: Math.max(acc.maxX, move.from.x, move.to.x),
    minY: Math.min(acc.minY, move.from.y, move.to.y),
    maxY: Math.max(acc.maxY, move.from.y, move.to.y),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
}

/** The closest the cutter body comes to `box`'s material along every cut. */
function closestCut(moves: ToolpathMove[], box: Box): number {
  return Math.min(...samplesAlong(cutMoves(moves)).map((point) => distanceToBox(point, box)))
}

// ── 1. The model's outline is the target's wall: the finish still cuts it ──

{
  const result = generateEdgeRouteToolpath(
    project([
      rectFeature('model', TARGET, 'model', TOP_Z, BOTTOM_Z),
      rectFeature('target', TARGET, 'add', TOP_Z, BOTTOM_Z),
    ]),
    outsideOperation('target', 'finish', 0),
  )
  assert(cutMoves(result.moves).length > 0,
    `a finish whose target encloses a model must cut; warnings ${JSON.stringify(codes(result))}`)
  assert(!codes(result).includes('edgeRouteBlockedByParts'),
    `the enclosed model must not block its own target's route; warnings ${JSON.stringify(codes(result))}`)
  const cut = closestCut(result.moves, TARGET)
  assert(cut >= R - TOLERANCE,
    `the cutter body reached ${(R - cut).toFixed(3)} mm into the enclosed model`)
  assert(cut <= R + 0.05,
    `the contour stopped ${cut.toFixed(3)} mm from the wall, short of the ${R} mm tool-centre offset`)
  // And the contour goes all the way round the wall, not just near it once.
  const box = bounds(cutMoves(result.moves))
  const sides: Array<[keyof typeof box, number]> = [
    ['minX', TARGET.minX - R], ['maxX', TARGET.maxX + R],
    ['minY', TARGET.minY - R], ['maxY', TARGET.maxY + R],
  ]
  for (const [side, expected] of sides) {
    assert(Math.abs(box[side] - expected) <= 0.05,
      `the finish contour's ${side} is ${box[side].toFixed(3)}, not the wall offset ${expected}`)
  }
  console.log(`  ✓ shared outline, finish: ${cutMoves(result.moves).length} cut moves, cutter body ${(cut - R).toFixed(3)} mm off the model`)
}

// ── 2. The same target's rough pass, with its radial stock (guard) ─────────

{
  const result = generateEdgeRouteToolpath(
    project([
      rectFeature('model', TARGET, 'model', TOP_Z, BOTTOM_Z),
      rectFeature('target', TARGET, 'add', TOP_Z, BOTTOM_Z),
    ]),
    outsideOperation('target', 'rough', 0.005),
  )
  assert(cutMoves(result.moves).length > 0,
    `the rough pass that already worked must keep cutting; warnings ${JSON.stringify(codes(result))}`)
  assert(!codes(result).includes('edgeRouteBlockedByParts'),
    `the enclosed model must not block the rough pass; warnings ${JSON.stringify(codes(result))}`)
  console.log(`  ✓ shared outline, rough: ${cutMoves(result.moves).length} cut moves`)
}

// ── 3. A model sticking out past the target keeps its protruding part ──────

{
  const STICKING = { minX: 0, minY: 0, maxX: 55, maxY: 30 }
  const OUTSIDE = { minX: TARGET.maxX, minY: TARGET.minY, maxX: STICKING.maxX, maxY: STICKING.maxY }
  const result = generateEdgeRouteToolpath(
    project([
      rectFeature('model', STICKING, 'model', TOP_Z, BOTTOM_Z),
      rectFeature('target', TARGET, 'add', TOP_Z, BOTTOM_Z),
    ]),
    outsideOperation('target', 'finish', 0),
  )
  // Whether the route cuts on that side is the router's existing behaviour:
  // only the safety property is asserted, on every cut past the target's wall.
  // That the protruding part is still an obstacle at all shows in the warning —
  // dropping the model whole would route the wall straight through it.
  assert(cutMoves(result.moves).length > 0, 'the route must still cut the walls the model does not stand over')
  assert(codes(result).includes('edgeRouteBlockedByParts'),
    `the part the model sticks out past the target must still block that wall; warnings ${JSON.stringify(codes(result))}`)
  const beyond = samplesAlong(cutMoves(result.moves))
    .filter((point) => point.x > TARGET.maxX)
  for (const point of beyond) {
    const clearance = distanceToBox(point, OUTSIDE)
    assert(clearance >= R - TOLERANCE,
      `the cutter body reached ${(R - clearance).toFixed(3)} mm into the model's protruding part at (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`)
  }
  console.log(`  ✓ model sticking out: ${beyond.length} cut points past the wall, all clear of the protruding part`)
}

// ── 4. No model: the route is unchanged by an unrelated far part ───────────

{
  const FAR = { minX: 200, minY: 200, maxX: 230, maxY: 230 }
  const alone = generateEdgeRouteToolpath(
    project([rectFeature('target', TARGET, 'add', TOP_Z, BOTTOM_Z)]),
    outsideOperation('target', 'finish', 0),
  )
  const withFarPart = generateEdgeRouteToolpath(
    project([
      rectFeature('target', TARGET, 'add', TOP_Z, BOTTOM_Z),
      rectFeature('far', FAR, 'add', TOP_Z, BOTTOM_Z),
    ]),
    outsideOperation('target', 'finish', 0),
  )
  assert(cutMoves(alone.moves).length > 0, 'the no-model control must actually cut')
  assert(JSON.stringify(alone.moves) === JSON.stringify(withFarPart.moves),
    'a part outside the route frame changed its moves, so clipping the model disturbed the no-model path')
  console.log(`  ✓ no model: ${cutMoves(alone.moves).length} cut moves, unchanged by a far part`)
}

// ── 5. A model that is itself a target keeps #179's neighbour protection ──

{
  // Two models selected on one level_first route. A is deeper, so at B's finish
  // level it is not being cut and must still stand in B's way; clipping a model
  // against this route's whole target set would erase it (its own outline is in
  // the union) and let B's cutter body 2 mm into A.
  const DEEP = { minX: 0, minY: 0, maxX: 20, maxY: 20 }
  const SHALLOW = { minX: 24, minY: 0, maxX: 44, maxY: 20 }
  const operation: Operation = { ...outsideOperation('shallow', 'finish', 0), machiningOrder: 'level_first' }
  operation.target = { source: 'features', featureIds: ['deep', 'shallow'] }
  const result = generateEdgeRouteToolpath(
    project([
      rectFeature('deep', DEEP, 'model', 0, -10),
      rectFeature('shallow', SHALLOW, 'model', 0, -5),
    ]),
    operation,
  )
  const levels = [...new Set(cutMoves(result.moves).map((move) => move.to.z))]
  assert(levels.includes(-5) && levels.includes(-10),
    `the fixture must finish both targets; cut levels ${JSON.stringify(levels)}`)
  const nearDeep = samplesAlong(cutMoves(result.moves)).filter((point) => point.x > DEEP.maxX)
  assert(nearDeep.length > 0, 'the fixture must cut beside the deeper model')
  const closest = Math.min(...nearDeep.map((point) => distanceToBox(point, DEEP)))
  // 0.02, not 1e-3: the round-joined keep-out is approximated to 0.01 mm
  // (`MAX_ROUND_JOIN_ARC_TOLERANCE`), and this is a boundary sample.
  assert(closest >= R - 0.02,
    `the shallower model's route reached ${(R - closest).toFixed(3)} mm into the deeper model it is next to`)
  console.log(`  ✓ model target as neighbour: cutter body ${(closest - R).toFixed(3)} mm off the deeper model`)
}

console.log('edgeModelEnclosed: all blocks passed')
