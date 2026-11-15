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
 * Pocket on a drawn hole, with the model still in the project (issue #1206
 * slice 2). This is the measurement the plan asked for before deciding how the
 * drawn shapes meet #964.
 *
 * A drawn hole is the designed circle. The mesh it came from is that circle's
 * facets, which lie inside it by up to the facet sagitta. Pocket keeps out of
 * every model's section (#819), so with the model present the wall pass
 * follows the facets and the cutter body stays inside the mesh's cavity. Take
 * the model away and the same operation cuts to the true circle, past the
 * facets by the sagitta.
 *
 * So today a pocket on a drawn shape is as accurate as the mesh, never worse
 * and never a gouge. Cutting the true circle while the model is present is
 * what #964 adds (a subtract after a model carves it); nothing here works
 * around that.
 *
 * The plate's circles have 12 facets so the sagitta (0.102 on the radius-3
 * hole) is far larger than any slicing or flattening tolerance.
 *
 * Mutation check: with the model filtered out of the "with model" project the
 * first block fails.
 *
 * Run with: npx tsx src/store/modelRecognitionPocket.test.ts
 */

import { loadSTLTransformedGeometry } from '../engine/csg'
import { candidatesFromResult, recognizeCavities } from '../engine/modelRecognition'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { defaultCheckedIds, shapesToDraw } from '../components/modelRecognition/candidateRows'
import { PLATE_MODEL_ID, plateModelProject } from '../test/modelPlateFixture'
import { defaultTool, type Operation, type Point, type Project } from '../types/project'
import { planRecognizedFeatures } from './helpers/recognizedFeatures'
import { resolveFeatureInstance, resolvedProjectFeatures } from './helpers/resolveFeatures'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const TOOL_RADIUS = 1.5
const HOLE_RADIUS = 3
const FACETS = 12
const SAGITTA = HOLE_RADIUS * (1 - Math.cos(Math.PI / FACETS))
/** Slicing, decimation and arc flattening together stay well under this. */
const TOLERANCE = 0.02

const base = await plateModelProject({ segments: FACETS })
const mesh = loadSTLTransformedGeometry(resolveFeatureInstance(base, PLATE_MODEL_ID)!, base)!
const candidates = candidatesFromResult(recognizeCavities(mesh), 'top', 'mm')
const hole = candidates.find((candidate) => candidate.kind === 'throughHole' && candidate.circle?.radius === HOLE_RADIUS)
assert(hole !== undefined, 'the radius-3 through hole is found as a circle on a 12-facet mesh')

let counter = 0
const plan = planRecognizedFeatures(
  base,
  {
    modelFeatureId: PLATE_MODEL_ID,
    folderName: 'Shapes',
    shapes: shapesToDraw(candidates, new Set(defaultCheckedIds(candidates)), (candidate) => candidate.id),
  },
  (prefix) => `${prefix}${counter++}`,
  (name) => name,
  (name) => name,
)
assert(plan !== null, 'the shapes are drawn')
const tool = { ...defaultTool('mm', 1), id: 't1', name: '3 mm endmill', diameter: TOOL_RADIUS * 2, defaultStepdown: 2, defaultStepover: 0.4 }
const withModel: Project = { ...plan!.project, tools: [tool] }
const withoutModel: Project = { ...withModel, features: withModel.features.filter((feature) => feature.id !== PLATE_MODEL_ID) }
const drawnHole = resolvedProjectFeatures(withModel).find((feature) => feature.name === hole!.id)
assert(drawnHole !== undefined && drawnHole.kind === 'circle', 'the drawn hole is a circle feature')

const operation = {
  id: 'pocket-drawn-hole',
  name: 'Pocket drawn hole',
  kind: 'pocket',
  pass: 'finish',
  enabled: true,
  showToolpath: true,
  debugToolpath: false,
  target: { source: 'features', featureIds: [drawnHole!.id] },
  toolRef: 't1',
  stepdown: 2,
  stepover: 0.4,
  feed: 800,
  plungeFeed: 300,
  rpm: 18000,
  pocketPattern: 'offset',
  pocketAngle: 0,
  stockToLeaveRadial: 0,
  stockToLeaveAxial: 0,
  finishWalls: true,
  finishFloor: true,
  carveDepth: 1,
  maxCarveDepth: 1,
  cutDirection: 'conventional',
  machiningOrder: 'level_first',
} as unknown as Operation

/** Distance from a point inside a polygon to its nearest edge. */
function clearance(point: Point, polygon: readonly Point[]): number {
  let best = Infinity
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)))
  }
  return best
}

/** How far the cutter body goes past the mesh's own cavity wall; negative when it never does. */
function deepestOvercut(project: Project): { overcut: number; cuts: number; lowest: number } {
  const moves = computeOperationToolpath(project, operation)?.result.moves ?? []
  let overcut = -Infinity
  let cuts = 0
  let lowest = Infinity
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    cuts += 1
    for (const point of [move.from, move.to]) {
      lowest = Math.min(lowest, point.z)
      overcut = Math.max(overcut, TOOL_RADIUS - clearance(point, hole!.outline))
    }
  }
  return { overcut, cuts, lowest }
}

// With the model: the cutter body stays inside the mesh's cavity.
{
  const { overcut, cuts, lowest } = deepestOvercut(withModel)
  assert(cuts > 0, 'with the model: the pocket generates')
  assert(Math.abs(lowest) < 1e-6, `with the model: it reaches the bottom of the hole, got ${lowest}`)
  assert(overcut <= TOLERANCE, `with the model: the cutter body stays inside the mesh cavity, overcut ${overcut}`)
}

// Without the model: the same operation cuts the true circle, past the facets.
{
  const { overcut, cuts } = deepestOvercut(withoutModel)
  assert(cuts > 0, 'without the model: the pocket generates')
  assert(
    overcut > SAGITTA - TOLERANCE && overcut < SAGITTA + TOLERANCE,
    `without the model: the wall is cut to the designed circle, ${SAGITTA.toFixed(4)} past the facets; got ${overcut}`,
  )
}

console.log('store/modelRecognitionPocket.test.ts: all assertions passed')
