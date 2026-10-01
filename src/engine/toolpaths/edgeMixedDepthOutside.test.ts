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
 * Outside routes over targets with different depth spans (issue #179).
 *
 * Two parts that touch, the way a guitar top and the binding wrapped round it
 * do: the top stands 0 to -6, the binding -2 to -9. Level-first used to route
 * each one alone, blind to the other, so each cut straight through the other
 * along the shared wall. Feature-first steered each round the other only
 * inside the other's own span, so the binding's passes below -6 ran under the
 * top and the cutter's flutes cut up into it.
 *
 * Every assertion on the cutter is on its body — the tool centre plus its
 * radius — against every part still standing at that level.
 *
 * Run with: npx tsx src/engine/toolpaths/edgeMixedDepthOutside.test.ts
 */

import { generateEdgeRouteToolpath } from './edge'
import { edgeLevelRuns } from './edgeLevelRuns'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  defaultTool,
  newProject,
  rectProfile,
  type Operation,
  type OperationPass,
  type Project,
  type SketchFeature,
} from '../../types/project'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

const TOOL_DIAMETER = 6
const R = TOOL_DIAMETER / 2
const TOLERANCE = 0.01

interface Box { id: string; x0: number; y0: number; x1: number; y1: number; top: number; bottom: number }

/** The top, and the binding along its far edge: they share the wall y = 30. */
const TOP: Box = { id: 'top', x0: 0, y0: 0, x1: 40, y1: 30, top: 0, bottom: -6 }
const BINDING: Box = { id: 'binding', x0: 0, y0: 30, x1: 40, y1: 40, top: -2, bottom: -9 }

function feature(box: Box): SketchFeature {
  return {
    id: box.id, name: box.id, kind: 'rect', folderId: null,
    sketch: {
      profile: rectProfile(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'add', z_top: box.top, z_bottom: box.bottom, visible: true, locked: false,
  }
}

function project(boxes: Box[]): Project {
  const tool = { ...defaultTool('mm', 1), id: 't1', name: 't1', diameter: TOOL_DIAMETER, defaultStepdown: 2 }
  return projectWithFeatures({ ...newProject('mixed-depth', 'mm'), tools: [tool] }, boxes.map(feature))
}

function outsideOperation(targets: string[], overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op1', name: 'op', kind: 'edge_route_outside', pass: 'rough', enabled: true, showToolpath: true,
    debugToolpath: false, target: { source: 'features', featureIds: targets }, toolRef: 't1',
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: false, finishFloor: false, carveDepth: 6, maxCarveDepth: 6,
    cutDirection: 'conventional', machiningOrder: 'level_first', entryStrategy: 'plunge',
    ...overrides,
  } as Operation
}

/** Every tool-centre point of a cutting move, sampled every 0.25 mm. */
function cutSamples(moves: ToolpathMove[]): Array<{ x: number; y: number; z: number }> {
  return moves
    .filter((move) => move.kind !== 'rapid')
    .flatMap((move) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) / 0.25))
      return Array.from({ length: steps + 1 }, (_, step) => ({
        x: move.from.x + (move.to.x - move.from.x) * step / steps,
        y: move.from.y + (move.to.y - move.from.y) * step / steps,
        z: move.from.z + (move.to.z - move.from.z) * step / steps,
      }))
    })
    .filter((point) => point.z < 0)
}

/** Signed distance from a point to a box: negative inside. */
function boxDistance(point: { x: number; y: number }, box: Box): number {
  const dx = Math.max(box.x0 - point.x, point.x - box.x1)
  const dy = Math.max(box.y0 - point.y, point.y - box.y1)
  if (dx <= 0 && dy <= 0) return Math.max(dx, dy)
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
}

/**
 * The deepest the cutter body reaches into a part that stands at its level.
 * A part stands wherever the tip is below its top: it is either being cut
 * there, when the body may touch it but not enter, or it stands above the tip
 * and the flutes would cut it.
 */
function deepestGouge(moves: ToolpathMove[], boxes: Box[]): { depth: number; where: string } {
  let worst = { depth: 0, where: 'nowhere' }
  for (const point of cutSamples(moves)) {
    for (const box of boxes) {
      if (point.z >= box.top - 1e-6) continue
      const depth = R - boxDistance(point, box)
      if (depth > worst.depth) {
        worst = { depth, where: `${box.id} at (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, z ${point.z.toFixed(2)})` }
      }
    }
  }
  return worst
}

const cutLevels = (moves: ToolpathMove[]) =>
  [...new Set(moves.filter((move) => move.kind === 'cut').map((move) => Number(move.to.z.toFixed(6))))]
    .sort((a, b) => b - a)

// ── The schedule ─────────────────────────────────────────────────────

{
  const runs = edgeLevelRuns(
    [{ id: 'top', topZ: 0, bottomZ: -6 }, { id: 'binding', topZ: -2, bottomZ: -9 }],
    'rough',
    2,
  )
  const shape = runs.map((run) => `${run.targets.map((target) => target.id).join('+')}:${run.levels.join(',')}@${run.topZ}`)
  assert(
    JSON.stringify(shape) === JSON.stringify(['top:-2@0', 'top+binding:-4,-6@-2', 'binding:-8,-9@-6']),
    `rough runs step from the highest top, cut each target from below its top to its bottom; got ${JSON.stringify(shape)}`,
  )

  const finish = edgeLevelRuns(
    [{ id: 'top', topZ: 0, bottomZ: -6 }, { id: 'binding', topZ: -2, bottomZ: -9 }],
    'finish',
    2,
  ).map((run) => `${run.targets.map((target) => target.id).join('+')}:${run.levels.join(',')}@${run.topZ}`)
  assert(
    JSON.stringify(finish) === JSON.stringify(['top:-6@0', 'binding:-9@-2']),
    `a finish pass cuts each target once, at its own bottom; got ${JSON.stringify(finish)}`,
  )

  const shared = edgeLevelRuns(
    [{ id: 'a', topZ: 0, bottomZ: -5 }, { id: 'b', topZ: 0, bottomZ: -5 }],
    'rough',
    2,
  )
  assert(
    shared.length === 1 && JSON.stringify(shared[0].levels) === JSON.stringify([-2, -4, -5]) && shared[0].topZ === 0,
    `targets sharing one span make the single run a lone target would get; got ${JSON.stringify(shared)}`,
  )

  const apart = edgeLevelRuns(
    [{ id: 'a', topZ: 0, bottomZ: -1 }, { id: 'b', topZ: -5, bottomZ: -6 }],
    'rough',
    2,
  ).map((run) => `${run.targets.map((target) => target.id).join('+')}:${run.levels.join(',')}`)
  assert(
    JSON.stringify(apart) === JSON.stringify(['a:-1', 'b:-6']),
    `levels between disjoint spans cut nothing; got ${JSON.stringify(apart)}`,
  )
  console.log('  ✓ level runs: mixed rough, finish, shared span, disjoint spans')
}

// ── Neither part is cut by the other's route ─────────────────────────

for (const machiningOrder of ['level_first', 'feature_first'] as const) {
  for (const pass of ['rough', 'finish'] as OperationPass[]) {
    const result = generateEdgeRouteToolpath(
      project([TOP, BINDING]),
      outsideOperation(['top', 'binding'], { machiningOrder, pass }),
    )
    const gouge = deepestGouge(result.moves, [TOP, BINDING])
    assert(
      gouge.depth <= TOLERANCE,
      `${machiningOrder}/${pass}: the cutter reached ${gouge.depth.toFixed(3)} mm into ${gouge.where}`,
    )

    // Both parts are still cut free where nothing stands in the way: the
    // top's own far wall down to its bottom, and the binding's below it.
    const samples = cutSamples(result.moves)
    const reaches = (y: number, z: number) => samples.some((point) =>
      Math.abs(point.y - y) < TOLERANCE && Math.abs(point.z - z) < 1e-6 && point.x > 5 && point.x < 35)
    assert(reaches(TOP.y0 - R, TOP.bottom), `${machiningOrder}/${pass}: the top's open wall must be cut at its bottom`)
    assert(
      reaches(BINDING.y1 + R, BINDING.bottom),
      `${machiningOrder}/${pass}: the binding's open wall must be cut at its bottom`,
    )
    assert(
      !samples.some((point) => Math.abs(point.y - (TOP.y0 - R)) < TOLERANCE && point.z < TOP.bottom - 1e-6),
      `${machiningOrder}/${pass}: the top's wall must not be cut below the top's own bottom`,
    )
    console.log(`  ✓ ${machiningOrder}/${pass}: no gouge (deepest ${gouge.depth.toFixed(4)} mm), both parts cut free`)
  }
}

// ── Level-first cuts one outline where both parts are cut ────────────

{
  const result = generateEdgeRouteToolpath(project([TOP, BINDING]), outsideOperation(['top', 'binding']))
  assert(
    JSON.stringify(cutLevels(result.moves)) === JSON.stringify([-2, -4, -6, -8, -9]),
    `level-first steps once through both parts, ending at each bottom; got ${JSON.stringify(cutLevels(result.moves))}`,
  )
  const sharedWall = cutSamples(result.moves).filter((point) =>
    point.z <= -4 + 1e-6 && point.z >= -6 - 1e-6 && Math.abs(point.y - 30) < R && point.x > 5 && point.x < 35)
  assert(
    sharedWall.length === 0,
    `where both parts are cut the route follows their joint outline, never the wall they share; ${sharedWall.length} samples on it`,
  )
  // At -2 the tip is on the binding's top face, which it only touches: the
  // top's wall standing above the binding still has to be cut free there.
  const aboveBinding = cutSamples(result.moves).filter((point) =>
    Math.abs(point.z + 2) < 1e-6 && Math.abs(point.y - (TOP.y1 + R)) < TOLERANCE && point.x > 5 && point.x < 35)
  assert(aboveBinding.length > 0, 'the top\'s wall above the binding must be cut at the binding\'s top')
  console.log('  ✓ level-first: one joint outline at -4 and -6, levels -2 to -9')
}

// ── A part stands in the way below its own bottom ────────────────────

{
  // A lone route round the binding, with the top left as a neighbour: at -8
  // and -9 the top's material is above the tip, so the binding's shared wall
  // is left rather than cut under it.
  const result = generateEdgeRouteToolpath(project([TOP, BINDING]), outsideOperation(['binding']))
  const gouge = deepestGouge(result.moves, [TOP, BINDING])
  assert(gouge.depth <= TOLERANCE, `the cutter reached ${gouge.depth.toFixed(3)} mm into ${gouge.where}`)
  assert(
    result.warnings.some((warning) => warning.code === 'edgeRouteBlockedByParts'),
    'the binding wall left under the top must be reported',
  )
  console.log('  ✓ a neighbour blocks every level below its top, not only its own span')
}
