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
 * Trochoidal Edge Route emission past the engine's argument limit — issue #668.
 *
 * One trochoidal fragment is emitted as a whole array of cut moves, and its
 * size is bounded only by `DEFAULT_TROCHOIDAL_POINT_BUDGET`. Splicing it in
 * with `moves.push(...cutMoves)` therefore threw `RangeError: Maximum call
 * stack size exceeded` on a real 60 x 40 in outside route — no toolpath, no
 * warning, a thrown generator. This asserts the emitted fragment really does
 * exceed the limit and that generation survives it.
 *
 * Run with: npx tsx src/engine/toolpaths/edgeTrochoidalEmission.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { maxSpreadableLength } from '../../test/spreadLimit'
import { generateEdgeRouteToolpath } from './edge'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const TOOL_DIAMETER = 6
// 60 x 40 in, the reported job, in mm.
const PART_WIDTH = 60 * 25.4
const PART_HEIGHT = 40 * 25.4
const DEPTH = 4
const STOCK_TOP = DEPTH + 2

function bigPartProject(): Project {
  const base = newProject('oversize', 'mm')
  const project: Project = {
    ...base,
    meta: { ...base.meta, units: 'mm' },
    stock: {
      ...base.stock,
      profile: rectProfile(-50, -50, PART_WIDTH + 100, PART_HEIGHT + 100),
      thickness: STOCK_TOP,
    },
    tools: [{ ...defaultTool('mm', 1), id: 't1', name: 'em6', diameter: TOOL_DIAMETER, units: 'mm' }],
  }
  return projectWithFeatures(project, [
    {
      id: 'part',
      name: 'Part',
      kind: 'rect',
      folderId: null,
      sketch: {
        profile: rectProfile(0, 0, PART_WIDTH, PART_HEIGHT),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'add',
      z_top: STOCK_TOP,
      z_bottom: STOCK_TOP - DEPTH,
      visible: true,
      locked: false,
    },
  ])
}

/** Trochoidal outside route, one Z level, so a single fragment carries the whole path. */
function trochoidalOutsideOperation(): Operation {
  return {
    id: 'op1',
    name: 'Edge',
    kind: 'edge_route_outside',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['part'] },
    toolRef: 't1',
    stepdown: DEPTH,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: DEPTH,
    maxCarveDepth: DEPTH,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    edgeStrategy: 'trochoidal',
    trochoidalCutWidth: TOOL_DIAMETER * 1.5,
    trochoidalAdvance: 0.1,
  }
}

const started = Date.now()
const result = generateEdgeRouteToolpath(bigPartProject(), trochoidalOutsideOperation())
const elapsed = Date.now() - started

const cuts = result.moves.filter((move) => move.kind === 'cut')
const limit = maxSpreadableLength()

assert(cuts.length > 0, `oversize trochoidal route emitted no cuts (warnings: ${
  result.warnings.map((w) => w.code).join(', ') || 'none'})`)
assert(cuts.length > limit,
  `fixture emits ${cuts.length} cut moves, which no longer exceeds this engine's spread limit (${limit}) — grow the part`)

const budgetWarnings = result.warnings.filter((warning) => (
  warning.code === 'edgeTrochoidalMoveBudget'
  || warning.code === 'edgeTrochoidalEntryBudget'
  || warning.code === 'edgeTrochoidalInvalidGuide'
  || warning.code === 'edgeTrochoidalSafetyCheck'
))
assert(budgetWarnings.length === 0,
  `oversize route must be generated, not refused: ${budgetWarnings.map((w) => w.code).join(', ')}`)

console.log(`   ✓ emitted ${cuts.length} cut moves past the ${limit}-argument spread limit in ${elapsed} ms`)
console.log('\nedgeTrochoidalEmission: 1 passed, 0 failed')
