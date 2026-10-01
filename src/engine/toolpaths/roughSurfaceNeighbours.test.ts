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
 * 3D rough surface over several models, and beside models it does not target
 * (issue #933).
 *
 * A carved top and the binding along its edge: the top stands 2 to 8, the
 * binding 0 to 5. Level-first used to slice only the first target model and
 * cut straight through the second. Any model the operation did not target was
 * protected by its stored silhouette, and only inside its own span, so a level
 * below its bottom cleared under it and the flutes cut up into it.
 *
 * Every assertion on the cutter is on its body: a flat endmill at a level
 * removes the whole column above its tip, so it cuts a part wherever its disc
 * overlaps the part's footprint and the part's top is above the tip.
 *
 * Run with: npx tsx src/engine/toolpaths/roughSurfaceNeighbours.test.ts
 */

import { serializeImportedMesh } from '../importedMesh'
import { generateRoughSurfaceToolpath } from './roughSurface'
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

const TOP: Box = { id: 'top', x0: 0, y0: 0, x1: 20, y1: 20, bottom: 2, top: 8 }
const BINDING: Box = { id: 'binding', x0: 0, y0: 20, x1: 20, y1: 24, bottom: 0, top: 5 }
/** A plain add standing on raised ground beside the top: 3 to 8. */
const RAISED_ADD: Box = { id: 'raised', x0: 21, y0: 4, x1: 26, y1: 16, bottom: 3, top: 8 }

function boxMesh(box: Box): PersistedImportedMesh {
  const { x0, y0, x1, y1, bottom, top } = box
  const vertices = [
    x0, y0, bottom, x1, y0, bottom, x1, y1, bottom, x0, y1, bottom,
    x0, y0, top, x1, y0, top, x1, y1, top, x0, y1, top,
  ]
  const indices = [
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ]
  return serializeImportedMesh({
    positions: new Float32Array(vertices),
    index: new Uint32Array(indices),
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

function addFeature(box: Box): SketchFeature {
  return {
    id: box.id, name: box.id, kind: 'rect', folderId: null,
    sketch: {
      profile: rectProfile(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'add', z_top: box.top, z_bottom: box.bottom, visible: true, locked: false,
  }
}

function project(models: Box[], adds: Box[] = []): Project {
  const tool: Tool = {
    ...defaultTool('mm', 1), id: 't1', name: 't1', type: 'flat_endmill',
    diameter: TOOL_DIAMETER, defaultStepdown: 1, defaultStepover: 0.5, maxCutDepth: 20,
  }
  const built = projectWithFeatures({
    ...newProject('rough-neighbours', 'mm'),
    tools: [tool],
    modelAssets: Object.fromEntries(models.map((box) => [`mesh-${box.id}`, boxMesh(box)])),
  }, [...models.map(modelFeature), ...adds.map(addFeature)])
  built.stock.thickness = STOCK_TOP
  return built
}

function roughOperation(targets: string[], overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'rough1', name: 'Rough surface', kind: 'rough_surface', pass: 'rough', enabled: true,
    showToolpath: true, debugToolpath: false, target: { source: 'features', featureIds: targets },
    toolRef: 't1', stepdown: 1, stepover: 0.5, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: true, finishFloor: true, carveDepth: 1, maxCarveDepth: 1,
    cutDirection: 'conventional', machiningOrder: 'level_first',
    ...overrides,
  } as Operation
}

/** Every tool-centre point of a cutting move, sampled every 0.1 mm. */
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

/** Signed distance from a point to a box's footprint: negative inside. */
function boxDistance(point: { x: number; y: number }, box: Box): number {
  const dx = Math.max(box.x0 - point.x, point.x - box.x1)
  const dy = Math.max(box.y0 - point.y, point.y - box.y1)
  if (dx <= 0 && dy <= 0) return Math.max(dx, dy)
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
}

/** The deepest the cutter's disc reaches into a part standing above its tip. */
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

// ── Both models, roughed together or one at a time ───────────────────

for (const machiningOrder of ['level_first', 'feature_first'] as const) {
  const result = generateRoughSurfaceToolpath(
    project([TOP, BINDING]),
    roughOperation(['top', 'binding'], { machiningOrder }),
  )
  const gouge = deepestGouge(result.moves, [TOP, BINDING])
  assert(gouge.depth <= TOLERANCE, `${machiningOrder}: the cutter reached ${gouge.depth.toFixed(3)} mm into ${gouge.where}`)

  // Both are roughed: the stock over the binding is cleared above its top,
  // and the binding's own outer wall is reached at its bottom.
  const samples = cutSamples(result.moves)
  assert(
    samples.some((point) => Math.abs(point.z - 6) < 1e-6 && point.y > 20 + R - TOLERANCE && point.y < 24 && point.x > 2 && point.x < 18),
    `${machiningOrder}: the stock standing over the binding must be cleared above its top`,
  )
  assert(
    samples.some((point) => Math.abs(point.z - BINDING.bottom) < 1e-6 && point.y > BINDING.y1 && point.x > 2 && point.x < 18),
    `${machiningOrder}: the binding's outer wall must be roughed down to its bottom`,
  )
  console.log(`  ✓ ${machiningOrder}: both models roughed, no gouge (deepest ${gouge.depth.toFixed(4)} mm)`)
}

// ── A model the operation does not target, from its top down ────────

{
  // The binding alone, with the top beside it: at levels 1 and 0 the top's
  // material is above the tip, so the binding's shared wall is not reached.
  const result = generateRoughSurfaceToolpath(project([TOP, BINDING]), roughOperation(['binding']))
  const gouge = deepestGouge(result.moves, [TOP, BINDING])
  assert(gouge.depth <= TOLERANCE, `binding alone: the cutter reached ${gouge.depth.toFixed(3)} mm into ${gouge.where}`)
  assert(
    cutSamples(result.moves).some((point) => Math.abs(point.z - BINDING.bottom) < 1e-6 && point.y > BINDING.y1),
    'binding alone: its free outer wall must still be roughed to its bottom',
  )
  console.log(`  ✓ a neighbouring model blocks every level below its top (deepest ${gouge.depth.toFixed(4)} mm)`)
}

{
  const result = generateRoughSurfaceToolpath(project([TOP, BINDING]), roughOperation(['top']))
  const gouge = deepestGouge(result.moves, [TOP, BINDING])
  assert(gouge.depth <= TOLERANCE, `top alone: the cutter reached ${gouge.depth.toFixed(3)} mm into ${gouge.where}`)
  console.log(`  ✓ the deeper neighbour is left alone below its top (deepest ${gouge.depth.toFixed(4)} mm)`)
}

// ── A plain add on raised ground beside the model ────────────────────

{
  // The top roughs down to 2; the add's bottom is at 3, so the level at 2
  // passes under it. Its whole column still stands above the tip.
  const result = generateRoughSurfaceToolpath(project([TOP], [RAISED_ADD]), roughOperation(['top']))
  const gouge = deepestGouge(result.moves, [TOP, RAISED_ADD])
  assert(gouge.depth <= TOLERANCE, `raised add: the cutter reached ${gouge.depth.toFixed(3)} mm into ${gouge.where}`)
  assert(
    cutSamples(result.moves).some((point) => Math.abs(point.z - TOP.bottom) < 1e-6),
    'raised add: the top must still be roughed to its bottom',
  )
  console.log(`  ✓ an add blocks every level below its top (deepest ${gouge.depth.toFixed(4)} mm)`)
}
