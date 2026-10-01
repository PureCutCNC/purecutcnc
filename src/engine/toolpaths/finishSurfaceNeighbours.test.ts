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
 * 3D finish and cleanup over several models, and beside models they do not
 * target (issue #934).
 *
 * A low part, 0 to 3, and a tall one standing on raised ground beside it, 2 to
 * 8, sharing the wall y = 10: the shape of a carved top and the binding round
 * it. Finishing the low part alone, waterline and cleanup used to cut under
 * the tall one at every level below its bottom, and the flutes cut up into
 * it: a neighbour was a 2D footprint, and only inside its own span. Finish and
 * cleanup also took exactly one model.
 *
 * Every assertion on the cutter is on its body against each part's mesh: a
 * flat endmill's disc, a ball's sphere, and the column above either.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceNeighbours.test.ts
 */

import { serializeImportedMesh } from '../importedMesh'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { generateFinishSurfaceCleanupToolpath } from './finishSurfaceCleanup'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  defaultTool,
  newProject,
  rectProfile,
  type Operation,
  type PersistedImportedMesh,
  type Project,
  type SketchFeature,
  type Tool,
  type ToolType,
} from '../../types/project'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

const TOOL_DIAMETER = 2
const R = TOOL_DIAMETER / 2
const TOLERANCE = 0.01
const STOCK_TOP = 8

interface Box { id: string; x0: number; y0: number; x1: number; y1: number; bottom: number; top: number }

const LOW: Box = { id: 'low', x0: 0, y0: 0, x1: 20, y1: 10, bottom: 0, top: 3 }
const TALL: Box = { id: 'tall', x0: 0, y0: 10, x1: 20, y1: 14, bottom: 2, top: 8 }
/** A second part finished with LOW, apart from it by more than the tool. */
const APART: Box = { id: 'apart', x0: 0, y0: 18, x1: 20, y1: 24, bottom: 0, top: 6 }
const BOXES = [LOW, TALL, APART]

function boxMesh(box: Box): PersistedImportedMesh {
  const { x0, y0, x1, y1, bottom, top } = box
  return serializeImportedMesh({
    positions: new Float32Array([
      x0, y0, bottom, x1, y0, bottom, x1, y1, bottom, x0, y1, bottom,
      x0, y0, top, x1, y0, top, x1, y1, top, x0, y1, top,
    ]),
    index: new Uint32Array([
      0, 1, 2, 0, 2, 3,
      4, 6, 5, 4, 7, 6,
      0, 4, 5, 0, 5, 1,
      1, 5, 6, 1, 6, 2,
      2, 6, 7, 2, 7, 3,
      3, 7, 4, 3, 4, 0,
    ]),
    bounds: { minX: x0, maxX: x1, minY: y0, maxY: y1, minZ: bottom, maxZ: top },
  }, 'stl')
}

function modelFeature(box: Box): SketchFeature {
  return {
    id: box.id, name: box.id, kind: 'stl', folderId: null,
    stl: {
      format: 'stl', meshAssetId: `mesh-${box.id}`, scale: 1, axisSwap: 'none',
      silhouettePaths: [[
        { x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 },
      ]],
    },
    sketch: {
      profile: rectProfile(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'model', z_top: box.top, z_bottom: box.bottom, visible: true, locked: false,
  }
}

function project(toolType: ToolType): Project {
  const tool: Tool = {
    ...defaultTool('mm', 1), id: 't1', name: 't1', type: toolType,
    diameter: TOOL_DIAMETER, defaultStepdown: 1, defaultStepover: 0.25, maxCutDepth: 20,
  }
  const built = projectWithFeatures({
    ...newProject('finish-neighbours', 'mm'),
    tools: [tool],
    modelAssets: Object.fromEntries(BOXES.map((box) => [`mesh-${box.id}`, boxMesh(box)])),
  }, BOXES.map(modelFeature))
  built.stock.thickness = STOCK_TOP
  return built
}

type Strategy = 'parallel' | 'waterline' | 'constant_scallop' | 'cleanup'

function generate(strategy: Strategy, targets: string[]): { moves: ToolpathMove[]; warnings: { code: string }[] } {
  const built = project(strategy === 'constant_scallop' ? 'ball_endmill' : 'flat_endmill')
  const kind = strategy === 'cleanup' ? 'finish_surface_cleanup' : 'finish_surface'
  const operation: Operation = {
    ...defaultOperationForTarget(built, kind, 'finish', { source: 'features', featureIds: targets }, 0),
    stepdown: 1,
    stepover: 0.25,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    ...(strategy === 'cleanup' ? {} : { pocketPattern: strategy }),
  }
  const run = strategy === 'cleanup' ? generateFinishSurfaceCleanupToolpath : generateFinishSurfaceToolpath
  return run({ ...built, operations: [operation] }, operation)
}

/** Every tool-tip point of a cutting move, sampled every 0.1 mm. */
function cutSamples(moves: ToolpathMove[]): Array<{ x: number; y: number; z: number }> {
  return moves
    .filter((move) => move.kind !== 'rapid')
    .flatMap((move) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) / 0.1))
      return Array.from({ length: steps + 1 }, (_, step) => ({
        x: move.from.x + (move.to.x - move.from.x) * step / steps,
        y: move.from.y + (move.to.y - move.from.y) * step / steps,
        z: move.from.z + (move.to.z - move.from.z) * step / steps,
      }))
    })
    .filter((point) => point.z < STOCK_TOP)
}

/** Distance from a point to a box's footprint, zero inside. */
function boxDistance(point: { x: number; y: number }, box: Box): number {
  const dx = Math.max(box.x0 - point.x, 0, point.x - box.x1)
  const dy = Math.max(box.y0 - point.y, 0, point.y - box.y1)
  return Math.hypot(dx, dy)
}

/**
 * The deepest the cutter body reaches into a box. Nearest the box, a flat
 * endmill's underside is at the tip and a ball's at `tip + R - sqrt(R^2 - d^2)`;
 * a box standing above that is cut.
 */
function deepestGouge(moves: ToolpathMove[], boxes: Box[], ball: boolean): { depth: number; where: string } {
  let worst = { depth: 0, where: 'nowhere' }
  for (const point of cutSamples(moves)) {
    for (const box of boxes) {
      const d = boxDistance(point, box)
      if (d >= R - TOLERANCE) continue
      const underside = ball ? point.z + R - Math.sqrt(R * R - d * d) : point.z
      const depth = box.top - underside
      if (depth > worst.depth) {
        worst = { depth, where: `${box.id} at (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, z ${point.z.toFixed(2)})` }
      }
    }
  }
  return worst
}

const STRATEGIES: Strategy[] = ['parallel', 'waterline', 'constant_scallop', 'cleanup']

// ── One model, beside one it does not target ─────────────────────────

for (const strategy of STRATEGIES) {
  for (const target of [LOW, TALL]) {
    const result = generate(strategy, [target.id])
    assert(result.moves.some((move) => move.kind === 'cut'), `${strategy} on ${target.id}: no cut emitted`)
    // The neighbour only: how close a pass comes to the part it finishes is
    // #938's question, not this one's.
    const gouge = deepestGouge(result.moves, BOXES.filter((box) => box !== target), strategy === 'constant_scallop')
    assert(
      gouge.depth <= TOLERANCE,
      `${strategy} on ${target.id}: the cutter reached ${gouge.depth.toFixed(3)} mm into ${gouge.where}`,
    )
    console.log(`  ✓ ${strategy} on ${target.id}: its neighbour is never entered (deepest ${gouge.depth.toFixed(4)} mm)`)
  }
}

// ── Two models finished together ─────────────────────────────────────

// Apart, not touching: two targets meeting at a step are one surface with a
// cliff in it, and how a height-map pass crosses a cliff is #938's question.
for (const strategy of STRATEGIES) {
  const result = generate(strategy, [LOW.id, APART.id])
  assert(
    !result.warnings.some((warning) => warning.code === 'finishNotMesh' || warning.code === 'surface3dNotMesh'),
    `${strategy}: two models must be accepted, got ${JSON.stringify(result.warnings.map((w) => w.code))}`,
  )
  const gouge = deepestGouge(result.moves, [TALL], strategy === 'constant_scallop')
  assert(gouge.depth <= TOLERANCE, `${strategy} on both: the cutter reached ${gouge.depth.toFixed(3)} mm into ${gouge.where}`)
  const samples = cutSamples(result.moves)
  const finishes = (box: Box) => samples.some((point) =>
    point.x > box.x0 + 2 && point.x < box.x1 - 2 && point.y > box.y0 && point.y < box.y1)
  assert(finishes(LOW) && finishes(APART), `${strategy} on both: each model must be finished`)
  console.log(`  ✓ ${strategy} on both: both finished, the neighbour between never entered (deepest ${gouge.depth.toFixed(4)} mm)`)
}
