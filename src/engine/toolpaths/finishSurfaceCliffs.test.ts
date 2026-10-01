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
 * 3D finish passes across a cliff (issue #938).
 *
 * A surface-following pass places each vertex on the cutter-location surface,
 * and the straight move between two of them cut across a cliff they straddle:
 * on a guitar top, parallel cut 0.2" and waterline 0.45" into a cavity's edge.
 * A link between passes did the same.
 *
 * - A step, 3 high for x < 20 and 8 beyond: every parallel scanline at 0
 *   degrees crosses it, up and down in turn, and at 90 degrees the links do.
 * - A cone with a cavity cut into its side: a waterline ring on the cone runs
 *   across the cavity, and its projected Z drops in, the guitar top's case.
 * - Two touching models of different heights finished together, the case
 *   issue #934 had to set apart.
 *
 * Constant scallop is not here. Its passes follow the geodesic distance from
 * the domain edge, so they run along a cliff rather than across it, and it
 * measured the same with the refinement and without: about 0.07 mm, a ball
 * beside a wall's top edge at the part boundary, which is height-map
 * resolution and not this issue. It takes the refinement all the same.
 *
 * Every assertion is on the cutter body against the true surface: how far the
 * underside of the flat endmill sits below the surface anywhere under it. The height map locates a wall to within one of its cells,
 * so the footprint is pulled in by a cell and a half before it is measured;
 * the cliff moves cut far past that.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceCliffs.test.ts
 */

import { serializeImportedMesh } from '../importedMesh'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { projectWithFeatures } from '../../test/projectFixtures'
import { slopeTestMesh, surfaceTestProject } from '../../test/surfaceSlopeFixtures'
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
const STEPOVER = 0.25
/** The finish's height-map cell: `min(R / 3, stepover distance / 2)`. */
const CELL = Math.min(R / 3, STEPOVER * TOOL_DIAMETER / 2)
/** How far under the true surface the cutter may sit, for float and facet noise. */
const DEPTH_TOLERANCE = 0.05

type Strategy = 'parallel' | 'waterline'
type Surface = (x: number, y: number) => number

/** A heightfield exists over its 40 x 40 square only; nothing stands past it. */
const within = (surface: Surface): Surface => (x, y) =>
  (x >= 0 && x <= 40 && y >= 0 && y <= 40 ? surface(x, y) : Number.NEGATIVE_INFINITY)
const step = within((x) => (x < 20 ? 3 : 8))
const cone: Surface = (x, y) => 8 - 0.15 * Math.hypot(x - 20, y - 20)
const coneWithCavity = within((x, y) => (x > 22 && x < 30 && y > 14 && y < 26 ? 2 : cone(x, y)))

function finishOperation(project: Project, strategy: Strategy, ids: string[], pocketAngle: number): Operation {
  return {
    ...defaultOperationForTarget(project, 'finish_surface', 'finish', { source: 'features', featureIds: ids }, 0),
    stepdown: 1,
    stepover: STEPOVER,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    pocketPattern: strategy,
    pocketAngle,
  }
}

function finishHeightfield(surface: Surface, strategy: Strategy, pocketAngle = 0): ToolpathMove[] {
  const { project } = surfaceTestProject(slopeTestMesh(surface, 40, 40, 0.25), TOOL_DIAMETER)
  project.tools[0] = { ...project.tools[0], type: 'flat_endmill' }
  const operation = finishOperation(project, strategy, [project.features[0].id], pocketAngle)
  return generateFinishSurfaceToolpath({ ...project, operations: [operation] }, operation).moves
}

// ── Two touching models ──────────────────────────────────────────────

interface Box { x0: number; y0: number; x1: number; y1: number; bottom: number; top: number }

const LOW: Box = { x0: 0, y0: 0, x1: 20, y1: 10, bottom: 0, top: 3 }
const TALL: Box = { x0: 0, y0: 10, x1: 20, y1: 14, bottom: 2, top: 8 }

function boxMesh({ x0, y0, x1, y1, bottom, top }: Box): PersistedImportedMesh {
  return serializeImportedMesh({
    positions: new Float32Array([
      x0, y0, bottom, x1, y0, bottom, x1, y1, bottom, x0, y1, bottom,
      x0, y0, top, x1, y0, top, x1, y1, top, x0, y1, top,
    ]),
    index: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]),
    bounds: { minX: x0, maxX: x1, minY: y0, maxY: y1, minZ: bottom, maxZ: top },
  }, 'stl')
}

function boxModel(id: string, box: Box): SketchFeature {
  return {
    id, name: id, kind: 'stl', folderId: null,
    stl: {
      format: 'stl', meshAssetId: `mesh-${id}`, scale: 1, axisSwap: 'none',
      silhouettePaths: [[{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 }]],
    },
    sketch: {
      profile: rectProfile(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'model', z_top: box.top, z_bottom: box.bottom, visible: true, locked: false,
  }
}

function finishPair(strategy: Strategy): ToolpathMove[] {
  const tool: Tool = {
    ...defaultTool('mm', 1), id: 't1', name: 't1', type: 'flat_endmill',
    diameter: TOOL_DIAMETER, defaultStepdown: 1, defaultStepover: STEPOVER, maxCutDepth: 20,
  }
  const project = projectWithFeatures({
    ...newProject('finish-cliffs-pair', 'mm'),
    tools: [tool],
    modelAssets: { 'mesh-low': boxMesh(LOW), 'mesh-tall': boxMesh(TALL) },
  }, [boxModel('low', LOW), boxModel('tall', TALL)])
  project.stock.thickness = 10
  const operation = finishOperation(project, strategy, ['low', 'tall'], 0)
  return generateFinishSurfaceToolpath({ ...project, operations: [operation] }, operation).moves
}

const pairSurface: Surface = (x, y) => [LOW, TALL]
  .filter((box) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1)
  .reduce((top, box) => Math.max(top, box.top), Number.NEGATIVE_INFINITY)

// ── The measure ──────────────────────────────────────────────────────

/** How far the cutter body sits below `surface` anywhere under its footprint. */
function deepestCut(moves: ToolpathMove[], surface: Surface): { depth: number; where: string } {
  const footprint = R - CELL * 1.5
  const probes: Array<[number, number]> = [[0, 0]]
  for (const radius of [footprint / 2, footprint]) {
    for (let k = 0; k < 24; k += 1) probes.push([radius * Math.cos(k * Math.PI / 12), radius * Math.sin(k * Math.PI / 12)])
  }
  let worst = { depth: 0, where: 'nowhere' }
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    const steps = Math.max(1, Math.ceil(Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) / 0.05))
    for (let s = 0; s <= steps; s += 1) {
      const x = move.from.x + (move.to.x - move.from.x) * s / steps
      const y = move.from.y + (move.to.y - move.from.y) * s / steps
      const z = move.from.z + (move.to.z - move.from.z) * s / steps
      for (const [dx, dy] of probes) {
        const ground = surface(x + dx, y + dy)
        if (!Number.isFinite(ground)) continue
        if (ground - z > worst.depth) {
          worst = { depth: ground - z, where: `(${x.toFixed(2)}, ${y.toFixed(2)}, z ${z.toFixed(2)})` }
        }
      }
    }
  }
  return worst
}

function check(label: string, moves: ToolpathMove[], surface: Surface): void {
  assert(moves.some((move) => move.kind === 'cut'), `${label}: no cut emitted`)
  const cut = deepestCut(moves, surface)
  assert(cut.depth <= DEPTH_TOLERANCE, `${label}: the cutter went ${cut.depth.toFixed(3)} mm under the surface at ${cut.where}`)
  console.log(`  ✓ ${label}: never under the surface (deepest ${cut.depth.toFixed(4)} mm)`)
}

// ── The cases ────────────────────────────────────────────────────────

for (const pocketAngle of [0, 90]) {
  check(`parallel at ${pocketAngle} degrees over a step`, finishHeightfield(step, 'parallel', pocketAngle), step)
}
check('waterline over a step', finishHeightfield(step, 'waterline'), step)

check('waterline on a cone with a cavity in its side', finishHeightfield(coneWithCavity, 'waterline'), coneWithCavity)
check('parallel on a cone with a cavity in its side', finishHeightfield(coneWithCavity, 'parallel'), coneWithCavity)

for (const strategy of ['parallel', 'waterline'] as const) {
  check(`${strategy} on two touching models`, finishPair(strategy), pairSurface)
}
