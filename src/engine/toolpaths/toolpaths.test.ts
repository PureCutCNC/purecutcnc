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
 * Unit tests for toolpath generation — machiningOrder (level_first vs
 * feature_first), perFeatureOperations, mergeToolpathResults, and a
 * per-kind regression check that single-feature operations produce
 * identical output in both modes.
 *
 * Run with: npx tsx src/engine/toolpaths/toolpaths.test.ts
 */

import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject, polygonProfile, rectProfile } from '../../types/project'
import type { ToolpathBounds, ToolpathMove, ToolpathResult } from './types'
import { mergePocketToolpathResults, mergeToolpathResults, perFeatureOperations } from './multiFeature'
import { generatePocketToolpath } from './pocket'
import { generateEdgeRouteToolpath } from './edge'
import { generateVCarveToolpath } from './vcarve'
import { generateFinishSurfaceCleanupToolpath } from './finishSurfaceCleanup'
import { generateSurfaceCleanToolpath } from './surface'
import { generateFollowLineToolpath } from './carving'
import { generateDrillingToolpath } from './drilling'
import { generatePocketRestRegionDrafts } from './restRegions'
import { buildMaskFromClipperPaths, clipToolpathResultToRegionMask } from './regions'
import { DEFAULT_CLIPPER_SCALE } from './geometry'
import type { ClipperPath } from './types'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6) {
  return Math.abs(a - b) < epsilon
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makePocketFeature(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeModelFeature(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'stl',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    stl: {
      format: 'stl',
      fileData: 'data:model/stl;base64,',
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ]],
    },
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeRegionFeature(id: string, x: number, y: number, w: number, h: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'region',
    z_top: 0,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeLineFeature(id: string, x1: number, y1: number, x2: number, y2: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: {
        start: { x: x1, y: y1 },
        segments: [{ type: 'line', to: { x: x2, y: y2 } }],
        closed: false,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeFlatEndmill(id: string, diameter = 4): Tool {
  const base = defaultTool('mm', 1)
  return {
    ...base,
    id,
    name: `${diameter} mm endmill`,
    diameter,
    defaultStepdown: 2,
    defaultStepover: 0.4,
  }
}

function makeVBit(id: string): Tool {
  const base = defaultTool('mm', 1)
  return {
    ...base,
    id,
    name: 'V-bit 60',
    type: 'v_bit',
    diameter: 6,
    vBitAngle: 60,
    defaultStepdown: 2,
    defaultStepover: 0.4,
  }
}

function baseProject(tools: Tool[], features: SketchFeature[]): Project {
  const project = newProject('test', 'mm')
  // Stock large enough to fit the pockets; thickness doesn't matter here.
  return {
    ...project,
    tools,
    features,
  }
}

function makePocketOp(
  overrides: Partial<Operation> & Pick<Operation, 'kind' | 'target' | 'toolRef'>,
): Operation {
  const base: Operation = {
    id: 'op1',
    name: 'op',
    kind: overrides.kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: overrides.target,
    toolRef: overrides.toolRef,
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
  }
  return { ...base, ...overrides }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((m) => m.kind === 'cut')
}

/** Dedup consecutive equal Z values in the sequence of cut-move Zs. */
function cutZTransitions(moves: ToolpathMove[]): number[] {
  const transitions: number[] = []
  for (const move of cutMoves(moves)) {
    const z = move.to.z
    const previous = transitions[transitions.length - 1]
    if (previous === undefined || !approx(previous, z)) transitions.push(z)
  }
  return transitions
}

/** Group cut-move Z values into disjoint XY clusters (by feature). */
function cutZsByFeatureCluster(moves: ToolpathMove[], pivotX: number): { leftZs: number[]; rightZs: number[] } {
  const leftZs: number[] = []
  const rightZs: number[] = []
  for (const move of cutMoves(moves)) {
    // Take the midpoint X so a pivot that barely nicks the boundary still lands each
    // move on the correct side.
    const midX = (move.from.x + move.to.x) / 2
    if (midX < pivotX) leftZs.push(move.to.z)
    else rightZs.push(move.to.z)
  }
  return { leftZs, rightZs }
}

function cutClusterSequence(moves: ToolpathMove[], classifyX: (x: number) => string): string[] {
  const sequence: string[] = []
  for (const move of cutMoves(moves)) {
    const cluster = classifyX((move.from.x + move.to.x) / 2)
    const previous = sequence[sequence.length - 1]
    if (previous !== cluster) sequence.push(cluster)
  }
  return sequence
}

interface ClosedCutLoop {
  points: { x: number; y: number }[]
  bounds: XYBounds
  signedArea: number
}

interface XYBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function pointEquals(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return approx(a.x, b.x) && approx(a.y, b.y)
}

function pointsBounds(points: { x: number; y: number }[]): XYBounds {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  return { minX, minY, maxX, maxY }
}

function polygonSignedArea(points: { x: number; y: number }[]): number {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area / 2
}

function closedCutLoopsAtZ(moves: ToolpathMove[], z: number): ClosedCutLoop[] {
  const loops: ClosedCutLoop[] = []
  let run: ToolpathMove[] = []

  const emitLoop = (loopMoves: ToolpathMove[]) => {
    const points = loopMoves.map((move) => ({ x: move.from.x, y: move.from.y }))
    loops.push({
      points,
      bounds: pointsBounds(points),
      signedArea: polygonSignedArea(points),
    })
  }

  const flushRun = () => {
    if (run.length > 0 && pointEquals(run[0].from, run[run.length - 1].to)) {
      emitLoop(run)
    }
    run = []
  }

  for (const move of moves) {
    if (move.kind === 'cut' && approx(move.to.z, z)) {
      run.push(move)
      for (let startIndex = run.length - 1; startIndex >= 0; startIndex -= 1) {
        if (run.length - startIndex >= 3 && pointEquals(run[startIndex].from, move.to)) {
          emitLoop(run.slice(startIndex))
          run = []
          break
        }
      }
    } else {
      flushRun()
    }
  }
  flushRun()

  return loops
}

function movesEqual(a: ToolpathMove[], b: ToolpathMove[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const ma = a[i]
    const mb = b[i]
    if (ma.kind !== mb.kind) return false
    if (!approx(ma.from.x, mb.from.x) || !approx(ma.from.y, mb.from.y) || !approx(ma.from.z, mb.from.z)) return false
    if (!approx(ma.to.x, mb.to.x) || !approx(ma.to.y, mb.to.y) || !approx(ma.to.z, mb.to.z)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// perFeatureOperations unit tests
// ---------------------------------------------------------------------------

function testPerFeatureOperations() {
  console.log('Testing perFeatureOperations...')

  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a', 'b', 'c'] },
    toolRef: 't1',
  })

  const split = perFeatureOperations(op)
  assert(split.length === 3, '3 features split into 3 ops')
  assert(split[0].target.source === 'features' && split[0].target.featureIds.length === 1, 'each op has one feature')
  assert(split[0].target.source === 'features' && split[0].target.featureIds[0] === 'a', 'order preserved: a')
  assert(split[1].target.source === 'features' && split[1].target.featureIds[0] === 'b', 'order preserved: b')
  assert(split[2].target.source === 'features' && split[2].target.featureIds[0] === 'c', 'order preserved: c')
  assert(split.every((o) => o.stepdown === op.stepdown && o.pass === op.pass && o.kind === op.kind), 'other fields carried over')

  const single = perFeatureOperations({ ...op, target: { source: 'features', featureIds: ['a'] } })
  assert(single.length === 1, 'single-feature op is not split')

  const stock = perFeatureOperations({ ...op, target: { source: 'stock' } })
  assert(stock.length === 1, 'stock target is not split')

  const project = baseProject([], [
    makePocketFeature('a', 0, 0, 10, 10, 4, 0),
    makePocketFeature('b', 20, 0, 10, 10, 4, 0),
    makeRegionFeature('r1', 0, 0, 5, 5),
  ])
  const splitWithRegion = perFeatureOperations({
    ...op,
    target: { source: 'features', featureIds: ['a', 'b', 'r1'] },
  }, project)
  assert(splitWithRegion.length === 2, 'feature-first split ignores region-only targets')
  assert(splitWithRegion.every((entry) => entry.target.source === 'features' && entry.target.featureIds.includes('r1')), 'region target is preserved on each split op')

  console.log('perFeatureOperations: PASSED')
}

// ---------------------------------------------------------------------------
// mergeToolpathResults unit tests
// ---------------------------------------------------------------------------

function testMergeToolpathResults() {
  console.log('Testing mergeToolpathResults / mergePocketToolpathResults...')

  const bounds1: ToolpathBounds = { minX: 0, minY: 0, minZ: -4, maxX: 10, maxY: 5, maxZ: 0 }
  const bounds2: ToolpathBounds = { minX: 20, minY: -2, minZ: -6, maxX: 30, maxY: 4, maxZ: 1 }
  const partA: ToolpathResult = {
    operationId: 'sub1',
    moves: [{ kind: 'cut', from: { x: 0, y: 0, z: -2 }, to: { x: 10, y: 0, z: -2 } }],
    warnings: ['warn A'],
    bounds: bounds1,
    collidingClampIds: ['c1'],
  }
  const partB: ToolpathResult = {
    operationId: 'sub2',
    moves: [{ kind: 'rapid', from: { x: 10, y: 0, z: 5 }, to: { x: 20, y: 0, z: 5 } }],
    warnings: [],
    bounds: bounds2,
    collidingClampIds: ['c1', 'c2'],
  }

  const merged = mergeToolpathResults('op-parent', [partA, partB])
  assert(merged.operationId === 'op-parent', 'operationId comes from parent')
  assert(merged.moves.length === 2, 'moves concatenated')
  assert(merged.moves[0].from.x === 0 && merged.moves[1].from.x === 10, 'move order preserved')
  assert(merged.warnings.length === 1 && merged.warnings[0] === 'warn A', 'warnings concatenated')
  assert(merged.bounds !== null, 'bounds present')
  assert(merged.bounds!.minX === 0 && merged.bounds!.maxX === 30, 'bounds X unioned')
  assert(merged.bounds!.minZ === -6 && merged.bounds!.maxZ === 1, 'bounds Z unioned')
  assert((merged.collidingClampIds ?? []).sort().join(',') === 'c1,c2', 'collidingClampIds deduped')

  const empty = mergeToolpathResults('op', [])
  assert(empty.moves.length === 0 && empty.bounds === null, 'empty parts -> empty merge')

  const mergedPocket = mergePocketToolpathResults('op-parent', [
    { ...partA, stepLevels: [-2, -4] },
    { ...partB, stepLevels: [-4, -6] },
  ])
  assert(mergedPocket.stepLevels.length === 3, 'stepLevels deduped')
  assert(mergedPocket.stepLevels[0] === -2 && mergedPocket.stepLevels[2] === -6, 'stepLevels sorted descending')

  const partNear: ToolpathResult = {
    operationId: 'sub-near',
    moves: [
      { kind: 'rapid', from: { x: 12, y: 0, z: 5 }, to: { x: 12, y: 0, z: 5 } },
      { kind: 'cut', from: { x: 12, y: 0, z: -2 }, to: { x: 14, y: 0, z: -2 } },
    ],
    warnings: [],
    bounds: null,
  }
  const partFar: ToolpathResult = {
    operationId: 'sub-far',
    moves: [
      { kind: 'rapid', from: { x: 100, y: 0, z: 5 }, to: { x: 100, y: 0, z: 5 } },
      { kind: 'cut', from: { x: 100, y: 0, z: -2 }, to: { x: 110, y: 0, z: -2 } },
    ],
    warnings: [],
    bounds: null,
  }
  const ordered = mergeToolpathResults('op-parent', [partA, partFar, partNear], { orderBlocks: 'nearest' })
  assert(ordered.moves.length === 5, 'nearest merge concatenates all moves')
  assert(ordered.moves[1].kind === 'rapid' && ordered.moves[1].to.x === 12, 'nearest merge chooses near block before far block')
  assert(ordered.moves[1].from.x === 10, 'nearest merge normalizes next block rapid from previous endpoint')

  const tieLeft: ToolpathResult = {
    operationId: 'sub-left',
    moves: [{ kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 0, y: 0, z: 5 } }],
    warnings: [],
    bounds: null,
  }
  const tieRight: ToolpathResult = {
    operationId: 'sub-right',
    moves: [{ kind: 'rapid', from: { x: 20, y: 0, z: 5 }, to: { x: 20, y: 0, z: 5 } }],
    warnings: [],
    bounds: null,
  }
  const tieAnchor: ToolpathResult = {
    operationId: 'sub-anchor',
    moves: [{ kind: 'cut', from: { x: 9, y: 0, z: -2 }, to: { x: 10, y: 0, z: -2 } }],
    warnings: [],
    bounds: null,
  }
  const tied = mergeToolpathResults('op-parent', [tieAnchor, tieRight, tieLeft], { orderBlocks: 'nearest' })
  assert(tied.moves[1].to.x === 20, 'nearest merge preserves original order for equal-distance ties')

  console.log('mergeToolpathResults: PASSED')
}

// ---------------------------------------------------------------------------
// Pocket: level_first vs feature_first ordering
// ---------------------------------------------------------------------------

function pocketSetupTwoDisjoint(machiningOrder: 'level_first' | 'feature_first'): {
  project: Project
  operation: Operation
} {
  const tool = makeFlatEndmill('t1', 4)
  // Two 10x10 rectangles at Z [0, -4], stepdown 2 → 2 levels per feature
  const featA = makePocketFeature('a', 0, 0, 10, 10, 0, -4)
  const featB = makePocketFeature('b', 30, 0, 10, 10, 0, -4)
  const project = baseProject([tool], [featA, featB])
  const operation = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a', 'b'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    machiningOrder,
  })
  return { project, operation }
}

function testPocketLevelFirstOrder() {
  console.log('Testing pocket level_first ordering...')

  const { project, operation } = pocketSetupTwoDisjoint('level_first')
  const result = generatePocketToolpath(project, operation)
  assert(result.moves.length > 0, 'moves generated')

  const transitions = cutZTransitions(result.moves)
  // Level first → we cut one depth across both features, then step to the
  // next depth.  Across 2 levels at Z=-2, -4 this means exactly two
  // transitions: -2, -4.
  assert(transitions.length === 2, `expected 2 Z transitions, got ${transitions.length} (${transitions.join(',')})`)
  assert(approx(transitions[0], -2) && approx(transitions[1], -4), `expected [-2, -4] got [${transitions.join(',')}]`)

  const { leftZs, rightZs } = cutZsByFeatureCluster(result.moves, 20)
  // Each feature must be cut at both depths.
  assert(leftZs.some((z) => approx(z, -2)) && leftZs.some((z) => approx(z, -4)), 'left feature cut at both depths')
  assert(rightZs.some((z) => approx(z, -2)) && rightZs.some((z) => approx(z, -4)), 'right feature cut at both depths')

  console.log('pocket level_first: PASSED')
}

function testPocketFeatureFirstOrder() {
  console.log('Testing pocket feature_first ordering...')

  const { project, operation } = pocketSetupTwoDisjoint('feature_first')
  const result = generatePocketToolpath(project, operation)
  assert(result.moves.length > 0, 'moves generated')

  const transitions = cutZTransitions(result.moves)
  // Feature first → within feature A we descend -2 then -4, then jump to
  // feature B and descend -2 then -4 again.  So Z transitions repeat: -2, -4, -2, -4.
  assert(transitions.length === 4, `expected 4 Z transitions, got ${transitions.length} (${transitions.join(',')})`)
  assert(
    approx(transitions[0], -2) && approx(transitions[1], -4)
    && approx(transitions[2], -2) && approx(transitions[3], -4),
    `expected [-2, -4, -2, -4] got [${transitions.join(',')}]`,
  )

  // Inside each feature's contiguous move block, cuts should appear for
  // both depths.  Verify by bisecting the move list at the midpoint: first
  // half is one feature, second half the other.
  const halves = [
    result.moves.slice(0, Math.floor(result.moves.length / 2)),
    result.moves.slice(Math.floor(result.moves.length / 2)),
  ]
  for (const half of halves) {
    const zs = cutMoves(half).map((m) => m.to.z)
    assert(zs.some((z) => approx(z, -2)), 'half contains z=-2')
    assert(zs.some((z) => approx(z, -4)), 'half contains z=-4')
  }

  console.log('pocket feature_first: PASSED')
}

function testPocketFeatureFirstNearestBlockOrder() {
  console.log('Testing pocket feature_first nearest block ordering...')

  const tool = makeFlatEndmill('t1', 4)
  const featA = makePocketFeature('a', 0, 0, 10, 10, 0, -4)
  const featB = makePocketFeature('b', 30, 0, 10, 10, 0, -4)
  const featC = makePocketFeature('c', 200, 0, 10, 10, 0, -4)
  const project = baseProject([tool], [featA, featB, featC])
  const operation = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a', 'c', 'b'] },
    toolRef: 't1',
    stepdown: 2,
    machiningOrder: 'feature_first',
  })

  const result = generatePocketToolpath(project, operation)
  const sequence = cutClusterSequence(result.moves, (x) => {
    if (x < 20) return 'a'
    if (x < 100) return 'b'
    return 'c'
  })

  assert(sequence.join(',') === 'a,b,c', `expected nearest feature block order a,b,c, got ${sequence.join(',')}`)
  assert(cutZTransitions(result.moves).length === 6, 'three feature blocks retain two depth passes each')

  console.log('pocket feature_first nearest block ordering: PASSED')
}

function pocketOffsetLoops(direction: NonNullable<Operation['cutDirection']>): ClosedCutLoop[] {
  const tool = makeFlatEndmill('t1', 4)
  const feature = makePocketFeature('a', 0, 0, 20, 20, 0, -2)
  const project = baseProject([tool], [feature])
  const operation = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.5,
    cutDirection: direction,
  })

  const result = generatePocketToolpath(project, operation)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)

  const loops = closedCutLoopsAtZ(result.moves, -2)
  assert(loops.length >= 3, `expected multiple offset loops, got ${loops.length}`)
  return loops
}

function assertPocketLoopsCutInnerFirst(loops: ClosedCutLoop[], label: string) {
  const first = loops[0]
  const last = loops[loops.length - 1]
  const firstArea = Math.abs(first.signedArea)
  const lastArea = Math.abs(last.signedArea)

  assert(firstArea < lastArea, `${label}: expected first loop area ${firstArea} to be smaller than last loop area ${lastArea}`)
  assert(first.bounds.minX > last.bounds.minX, `${label}: expected first loop to be inset from final loop on minX`)
  assert(first.bounds.minY > last.bounds.minY, `${label}: expected first loop to be inset from final loop on minY`)
  assert(first.bounds.maxX < last.bounds.maxX, `${label}: expected first loop to be inset from final loop on maxX`)
  assert(first.bounds.maxY < last.bounds.maxY, `${label}: expected first loop to be inset from final loop on maxY`)
  assert(last.bounds.minX <= 2.1 && last.bounds.minY <= 2.1, `${label}: expected final loop to reach wall-adjacent inset`)
  assert(last.bounds.maxX >= 17.9 && last.bounds.maxY >= 17.9, `${label}: expected final loop to reach wall-adjacent inset`)
}

function testPocketOffsetCutsInnerFirst() {
  console.log('Testing pocket offset cuts inner loops before wall-adjacent loops...')

  const conventionalLoops = pocketOffsetLoops('conventional')
  const climbLoops = pocketOffsetLoops('climb')

  assertPocketLoopsCutInnerFirst(conventionalLoops, 'conventional')
  assertPocketLoopsCutInnerFirst(climbLoops, 'climb')
  assert(
    conventionalLoops[0].signedArea * climbLoops[0].signedArea < 0,
    'expected climb and conventional loops to keep opposite winding after order reversal',
  )

  console.log('pocket offset inner-first ordering: PASSED')
}

function testPocketLevelTransitionsPlungeVerticallyFromSafeZ() {
  console.log('Testing pocket level transitions rapid at safe Z before plunging...')

  const tool = makeFlatEndmill('t1', 4)
  const feature = makePocketFeature('a', 0, 0, 20, 20, 0, -4)
  const project = baseProject([tool], [feature])
  const operation = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.5,
  })

  const result = generatePocketToolpath(project, operation)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)

  const firstDeepCutIndex = result.moves.findIndex((move) => move.kind === 'cut' && approx(move.to.z, -4))
  assert(firstDeepCutIndex > 0, 'expected a cut at the second pocket level')

  const plunge = result.moves[firstDeepCutIndex - 1]
  const firstDeepCut = result.moves[firstDeepCutIndex]
  assert(plunge.kind === 'plunge', `expected plunge before first deep-level cut, got ${plunge.kind}`)
  assert(approx(plunge.from.x, plunge.to.x) && approx(plunge.from.y, plunge.to.y), 'deep-level entry plunge should be vertical')
  assert(approx(plunge.to.x, firstDeepCut.from.x) && approx(plunge.to.y, firstDeepCut.from.y), 'plunge should end at the first deep-level cut start')
  assert(approx(plunge.to.z, firstDeepCut.from.z) && approx(firstDeepCut.from.z, -4), 'first deep-level cut should start at cut depth')

  console.log('pocket level transition vertical plunge: PASSED')
}

function testPocketSingleFeatureParity() {
  console.log('Testing single-feature pocket parity across modes...')

  const tool = makeFlatEndmill('t1', 4)
  const featA = makePocketFeature('a', 0, 0, 10, 10, 0, -4)
  const project = baseProject([tool], [featA])

  const opLevel = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    machiningOrder: 'level_first',
  })
  const opFeature = { ...opLevel, machiningOrder: 'feature_first' as const }

  const rLevel = generatePocketToolpath(project, opLevel)
  const rFeature = generatePocketToolpath(project, opFeature)
  assert(movesEqual(rLevel.moves, rFeature.moves), 'single-feature op: both modes produce identical moves')

  console.log('pocket single-feature parity: PASSED')
}

function testPocketRejectsRegionOnlyTarget() {
  console.log('Testing pocket rejects region-only target...')
  const tool = makeFlatEndmill('t1', 1)
  const region = makeRegionFeature('r1', 0, 0, 10, 10)
  const project = baseProject([tool], [region])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['r1'] },
    toolRef: 't1',
  })
  const result = generatePocketToolpath(project, op)

  assert(cutMoves(result.moves).length === 0, 'region-only pocket should generate no cuts')
  assert(result.warnings.some((warning) => warning.includes('No valid subtract features')), 'region-only pocket should warn about missing subtract targets')
  console.log('pocket region-only rejection: PASSED')
}

function testPocketRegionClipsMachiningArea() {
  console.log('Testing pocket region clips machining area...')
  const tool = makeFlatEndmill('t1', 1)
  const pocket = makePocketFeature('p1', 0, 0, 10, 10, 4, 0)
  const region = makeRegionFeature('r1', 0, 0, 5, 10)
  const project = baseProject([tool], [pocket, region])
  const unrestricted = generatePocketToolpath(project, makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
  }))
  const clipped = generatePocketToolpath(project, makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1', 'r1'] },
    toolRef: 't1',
  }))

  const unrestrictedBounds = unrestricted.bounds
  const clippedBounds = clipped.bounds
  assert(unrestrictedBounds !== null && clippedBounds !== null, 'expected pocket bounds')
  if (!unrestrictedBounds || !clippedBounds) throw new Error('expected pocket bounds')
  assert(unrestrictedBounds.maxX > 8, `expected unrestricted pocket to reach right side, got ${unrestrictedBounds.maxX}`)
  assert(clippedBounds.maxX <= 5 + 1e-6, `expected region-clipped pocket maxX <= 5, got ${clippedBounds.maxX}`)
  assert(clippedBounds.maxX > 4.9, `expected region clipping to cut at region boundary instead of offsetting inward, got ${clippedBounds.maxX}`)
  assert(cutMoves(clipped.moves).length > 0, 'expected clipped pocket cuts')
  console.log('pocket region clipping: PASSED')
}

function testPocketRestRegionsFindUnreachableArea() {
  console.log('Testing pocket rest-region generation finds unreachable area...')
  const tool = makeFlatEndmill('t1', 4)
  const pocket = makePocketFeature('p1', 0, 0, 10, 2, 4, 0)
  const project = baseProject([tool], [pocket])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
  })
  const result = generatePocketRestRegionDrafts(project, op)

  assert(result.drafts.length > 0, 'expected rest-region drafts for pocket narrower than tool')
  assert(result.drafts.every((draft) => draft.profile.closed), 'rest-region drafts should be closed')
  assert(result.drafts.every((draft) => draft.profile.segments.length >= 3), 'rest-region drafts should have polygon geometry')
  console.log('pocket rest-region generation: PASSED')
}

function testPocketRestRegionsFindCornerCusps() {
  console.log('Testing pocket rest-region generation finds rectangular corner cusps...')
  const tool = makeFlatEndmill('t1', 4)
  const pocket = makePocketFeature('p1', 0, 0, 20, 12, 4, 0)
  const project = baseProject([tool], [pocket])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
  })
  const result = generatePocketRestRegionDrafts(project, op)
  const restPoints = result.drafts.flatMap((draft) => [
    draft.profile.start,
    ...draft.profile.segments.map((segment) => segment.to),
  ])

  assert(result.drafts.length > 0, 'expected rest-region drafts for rectangular pocket corners')
  assert(result.drafts.every((draft) => draft.profile.closed), 'corner rest-region drafts should be closed')
  assert(restPoints.some((point) => point.x < 2.1 && point.y < 2.1), 'expected rest geometry near lower-left corner')
  assert(restPoints.some((point) => point.x > 17.9 && point.y < 2.1), 'expected rest geometry near lower-right corner')
  assert(restPoints.some((point) => point.x > 17.9 && point.y > 9.9), 'expected rest geometry near upper-right corner')
  assert(restPoints.some((point) => point.x < 2.1 && point.y > 9.9), 'expected rest geometry near upper-left corner')
  console.log('pocket corner rest-region generation: PASSED')
}

function draftArea(draft: { profile: { start: { x: number; y: number }; segments: Array<{ to: { x: number; y: number } }> } }): number {
  const pts = [draft.profile.start, ...draft.profile.segments.map((segment) => segment.to)]
  let area = 0
  for (let index = 0; index < pts.length; index += 1) {
    const current = pts[index]
    const next = pts[(index + 1) % pts.length]
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area / 2)
}

function testRegionMaskVisitsNearestRegionFirst() {
  // Regression: a region-masked toolpath (e.g. a rest operation) used to machine
  // its regions in whatever arbitrary order the mask paths happened to be in, so
  // the tool zig-zagged across the part. It should instead hop to the nearest
  // unvisited region each time.
  console.log('Testing region-mask clipping visits the nearest region first...')
  const project = newProject('region-order', 'mm')

  // One left-to-right cut pass crossing three boxes laid out along X.
  const result: ToolpathResult = {
    operationId: 'op',
    moves: [{ kind: 'cut', from: { x: -1, y: 1, z: -1 }, to: { x: 31, y: 1, z: -1 } }],
    warnings: [],
    bounds: null,
  }
  const box = (x0: number, x1: number): ClipperPath => [
    { X: x0 * DEFAULT_CLIPPER_SCALE, Y: -1 * DEFAULT_CLIPPER_SCALE },
    { X: x1 * DEFAULT_CLIPPER_SCALE, Y: -1 * DEFAULT_CLIPPER_SCALE },
    { X: x1 * DEFAULT_CLIPPER_SCALE, Y: 3 * DEFAULT_CLIPPER_SCALE },
    { X: x0 * DEFAULT_CLIPPER_SCALE, Y: 3 * DEFAULT_CLIPPER_SCALE },
  ]
  // Mask paths deliberately out of travel order: left, RIGHT, middle.
  const mask = buildMaskFromClipperPaths([box(0, 5), box(25, 30), box(10, 15)])
  const clipped = clipToolpathResultToRegionMask(project, result, mask)

  const cutStarts = cutMoves(clipped.moves).map((move) => Math.round(move.from.x))
  // Nearest-first from the first box (0–5) should give left→middle→right: 0,10,25.
  // The old arbitrary order would have been 0,25,10.
  assert(
    cutStarts.length === 3,
    `expected one cut fragment per region, got ${cutStarts.length} [${cutStarts.join(',')}]`,
  )
  assert(
    cutStarts[0] < cutStarts[1] && cutStarts[1] < cutStarts[2],
    `expected nearest-first region order (ascending X), got [${cutStarts.join(',')}]`,
  )
  console.log('region-mask nearest-region ordering: PASSED')
}

function testPocketRestRegionsUniformCorners() {
  // Regression: corner rest regions are built analytically from each pocket
  // vertex (apex + tangent points sized by the tool radius), so every equal
  // corner comes out identical regardless of the pocket's orientation. The old
  // sliver-derived approach produced wedges (hundreds of mm²) for hex/oct pockets
  // and, once those were split, left the axis-aligned corners 2-3x larger than
  // the diagonal ones. Each corner must now be one small, uniform region.
  console.log('Testing pocket rest-region generation builds uniform corners...')
  const tool = makeFlatEndmill('t1', 4)

  // Same hexagon at two orientations + an octagon. Each must yield exactly one
  // region per corner, all near-identical in area, none ballooned into a wedge.
  // The tight (radius 6) cases guard the merge regression: with a tool that
  // large relative to the pocket, the extended corners used to grow into each
  // other and union into a single ring (emitted as inside+outside regions).
  const cases: Array<{ sides: number; phase: number; radius: number }> = [
    { sides: 6, phase: Math.PI / 2, radius: 20 }, // pointy-top
    { sides: 6, phase: 0, radius: 20 },           // flat-top
    { sides: 8, phase: Math.PI / 8, radius: 20 },
    { sides: 6, phase: Math.PI / 2, radius: 6 },  // tight pocket (Ø4 tool)
    { sides: 8, phase: Math.PI / 8, radius: 7 },
  ]

  for (const { sides, phase, radius } of cases) {
    const points = Array.from({ length: sides }, (_, index) => {
      const angle = phase + (index * 2 * Math.PI) / sides
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }
    })
    const feature: SketchFeature = {
      id: 'p1',
      name: 'p1',
      kind: 'polygon',
      folderId: null,
      sketch: {
        profile: polygonProfile(points),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'subtract',
      z_top: 0,
      z_bottom: -4,
      visible: true,
      locked: false,
    }
    const project = baseProject([tool], [feature])
    const op = makePocketOp({
      kind: 'pocket',
      target: { source: 'features', featureIds: ['p1'] },
      toolRef: 't1',
    })
    const result = generatePocketRestRegionDrafts(project, op)

    assert(
      result.drafts.length === sides,
      `expected exactly ${sides} corner rest regions for a ${sides}-gon (phase ${phase.toFixed(2)}), got ${result.drafts.length}`,
    )

    const areas = result.drafts.map(draftArea)
    const minArea = Math.min(...areas)
    const maxArea = Math.max(...areas)
    // No wedge: the bug produced regions in the hundreds of mm² (>40% of pocket).
    assert(maxArea < 100, `corner rest region ballooned to ${maxArea.toFixed(1)} mm² for a ${sides}-gon`)
    // Uniformity: identical corners must come out the same size (the reported
    // "top/bottom bigger than the sides" symptom had a ~2.5x spread).
    assert(
      maxArea / minArea < 1.2,
      `corner rest regions should be uniform, got ${minArea.toFixed(2)}..${maxArea.toFixed(2)} mm² for a ${sides}-gon`,
    )
  }
  console.log('pocket uniform corner rest-region generation: PASSED')
}

// ---------------------------------------------------------------------------
// Inside edge-route ordering (same band-driven code path as pocket)
// ---------------------------------------------------------------------------

function testEdgeInsideLevelFirstVsFeatureFirst() {
  console.log('Testing edge_route_inside level_first vs feature_first...')

  const tool = makeFlatEndmill('t1', 4)
  const featA = makePocketFeature('a', 0, 0, 20, 20, 0, -4)
  const featB = makePocketFeature('b', 40, 0, 20, 20, 0, -4)
  const project = baseProject([tool], [featA, featB])

  const opLevel = makePocketOp({
    kind: 'edge_route_inside',
    target: { source: 'features', featureIds: ['a', 'b'] },
    toolRef: 't1',
    machiningOrder: 'level_first',
  })
  const opFeature = { ...opLevel, machiningOrder: 'feature_first' as const }

  const rLevel = generateEdgeRouteToolpath(project, opLevel)
  const rFeature = generateEdgeRouteToolpath(project, opFeature)
  assert(rLevel.moves.length > 0, 'level_first produces moves')
  assert(rFeature.moves.length > 0, 'feature_first produces moves')

  const tLevel = cutZTransitions(rLevel.moves)
  const tFeature = cutZTransitions(rFeature.moves)
  assert(tLevel.length === 2, `level_first: expected 2 Z transitions, got ${tLevel.length} (${tLevel.join(',')})`)
  assert(tFeature.length === 4, `feature_first: expected 4 Z transitions, got ${tFeature.length} (${tFeature.join(',')})`)

  console.log('edge_route_inside ordering: PASSED')
}

function testEdgeInsideFeatureFirstNearestBlockOrder() {
  console.log('Testing edge_route_inside feature_first nearest block ordering...')

  const tool = makeFlatEndmill('t1', 4)
  const featA = makePocketFeature('a', 0, 0, 20, 20, 0, -4)
  const featB = makePocketFeature('b', 40, 0, 20, 20, 0, -4)
  const featC = makePocketFeature('c', 200, 0, 20, 20, 0, -4)
  const project = baseProject([tool], [featA, featB, featC])
  const operation = makePocketOp({
    kind: 'edge_route_inside',
    target: { source: 'features', featureIds: ['a', 'c', 'b'] },
    toolRef: 't1',
    machiningOrder: 'feature_first',
  })

  const result = generateEdgeRouteToolpath(project, operation)
  const sequence = cutClusterSequence(result.moves, (x) => {
    if (x < 30) return 'a'
    if (x < 100) return 'b'
    return 'c'
  })

  assert(sequence.join(',') === 'a,b,c', `expected nearest feature block order a,b,c, got ${sequence.join(',')}`)
  assert(cutZTransitions(result.moves).length === 6, 'three edge feature blocks retain two depth passes each')

  console.log('edge_route_inside feature_first nearest block ordering: PASSED')
}

function testEdgeInsideRegionClipsAtBoundary() {
  console.log('Testing edge_route_inside region clips at region boundary...')
  const tool = makeFlatEndmill('t1', 2)
  const pocket = makePocketFeature('p1', 0, 0, 10, 10, 4, 0)
  const region = makeRegionFeature('r1', 0, 0, 5, 10)
  const project = baseProject([tool], [pocket, region])
  const result = generateEdgeRouteToolpath(project, makePocketOp({
    kind: 'edge_route_inside',
    target: { source: 'features', featureIds: ['p1', 'r1'] },
    toolRef: 't1',
    machiningOrder: 'level_first',
  }))

  const bounds = result.bounds
  assert(bounds !== null, 'expected edge inside bounds')
  if (!bounds) throw new Error('expected edge inside bounds')
  assert(bounds.maxX <= 5 + 1e-6, `expected edge route clipped to region maxX <= 5, got ${bounds.maxX}`)
  assert(bounds.maxX > 4.9, `expected edge route to clip at region boundary, not offset inward, got ${bounds.maxX}`)
  const lastMove = result.moves[result.moves.length - 1]
  assert(lastMove !== undefined, 'expected edge route moves')
  const safeZ = project.stock.thickness + project.meta.operationClearanceZ
  assert(lastMove.to.z === safeZ, `expected clipped edge route to end at safe Z ${safeZ}, got ${lastMove.to.z}`)
  console.log('edge_route_inside region boundary clipping: PASSED')
}

function testEdgeOutsideAcceptsModelSilhouette() {
  console.log('Testing edge_route_outside accepts model silhouette...')

  const tool = makeFlatEndmill('t1', 4)
  const model = makeModelFeature('model', 10, 10, 20, 10, 6, 0)
  const project = baseProject([tool], [model])

  const op = makePocketOp({
    kind: 'edge_route_outside',
    target: { source: 'features', featureIds: ['model'] },
    toolRef: 't1',
  })

  const result = generateEdgeRouteToolpath(project, op)
  assert(result.moves.length > 0, 'outside edge route produces moves for model silhouette')
  assert(
    !result.warnings.some((warning) => warning.includes('not add/model/region')),
    `model target should be accepted; warnings: ${result.warnings.join(', ')}`,
  )

  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'outside edge route produces cut moves for model silhouette')
  assert(
    cuts.some((move) => move.to.x < 10 || move.to.x > 30 || move.to.y < 10 || move.to.y > 20),
    'outside edge route offsets around the model silhouette, not through the original outline',
  )

  console.log('edge_route_outside model silhouette: PASSED')
}

function testEdgeOutsideUsesStoredModelSilhouettePaths() {
  console.log('Testing edge_route_outside uses stored model silhouette paths...')

  const tool = makeFlatEndmill('t1', 2)
  const model = makeModelFeature('model', 0, 0, 10, 10, 4, 0)
  model.stl!.silhouettePaths = [
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    [
      { x: 30, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 10 },
      { x: 30, y: 10 },
    ],
  ]
  const project = baseProject([tool], [model])

  const op = makePocketOp({
    kind: 'edge_route_outside',
    target: { source: 'features', featureIds: ['model'] },
    toolRef: 't1',
  })

  const result = generateEdgeRouteToolpath(project, op)
  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'outside edge route produces cut moves')
  assert(
    cuts.some((move) => move.to.x > 40),
    'expected outside edge route to include the second stored silhouette island',
  )

  console.log('edge_route_outside stored silhouette paths: PASSED')
}

function testEdgeOutsideIgnoresTinyStoredModelSilhouetteArtifacts() {
  console.log('Testing edge_route_outside ignores tiny stored model silhouette artifacts...')

  const tool = makeFlatEndmill('t1', 2)
  const model = makeModelFeature('model', 0, 0, 20, 10, 4, 0)
  model.stl!.silhouettePaths = [
    [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ],
    [
      { x: 10, y: 5 },
      { x: 10.002, y: 5 },
      { x: 10.002, y: 5.002 },
      { x: 10, y: 5.002 },
    ],
  ]
  const project = baseProject([tool], [model])

  const op = makePocketOp({
    kind: 'edge_route_outside',
    target: { source: 'features', featureIds: ['model'] },
    toolRef: 't1',
  })

  const result = generateEdgeRouteToolpath(project, op)
  const artifactCuts = cutMoves(result.moves).filter((move) => (
    Math.abs(move.to.x - 10) < 2 && Math.abs(move.to.y - 5) < 2
  ))

  assert(result.moves.length > 0, 'outside edge route produces moves')
  assert(artifactCuts.length === 0, `expected no edge cuts around tiny interior artifact path, got ${artifactCuts.length}`)

  console.log('edge_route_outside tiny stored silhouette artifacts: PASSED')
}

// ---------------------------------------------------------------------------
// Edge outside: obstacle avoidance — toolpath must not cut into other add features
// ---------------------------------------------------------------------------

function makeAddFeature(id: string, x: number, y: number, w: number, h: number, zTop: number, zBottom: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function testEdgeOutsideClipsAroundNonSelectedAddFeatures() {
  console.log('Testing edge_route_outside clips moves around non-selected add features...')

  const tool = makeFlatEndmill('t1', 4)
  // featureA at x=0..10, featureB at x=12..22. Gap = 2mm < tool diameter (4mm).
  // Edge out routes around featureA only, but moves that enter featureB's
  // keep-away zone (featureB expanded by tool.radius = 2, so x >= 10) are clipped.
  const featureA = makeAddFeature('a', 0, 0, 10, 10, 6, 0)
  const featureB = makeAddFeature('b', 12, 0, 10, 10, 6, 0)
  const project = baseProject([tool], [featureA, featureB])

  const op = makePocketOp({
    kind: 'edge_route_outside',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
  })

  const result = generateEdgeRouteToolpath(project, op)
  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'outside edge route produces cut moves')

  // Tool center must not enter featureB's keep-away zone. FeatureB spans
  // x=[12..22], expanded by tool.radius (2) means keep-away starts at x=10.
  // A cut move's tool center landing strictly inside that zone (x>10) would
  // have the tool overlap featureB's material. Tool center exactly on the
  // boundary (x=10) puts the cutting edge exactly at featureB's left edge
  // (x=12) — that's the optimal safe stopping position, not a violation.
  const violatingCuts = cuts.filter((move) => {
    const inKeepAwayY = move.to.y >= -2 && move.to.y <= 12
    const inKeepAwayX = move.to.x > 10 && move.to.x < 24
    return inKeepAwayX && inKeepAwayY
  })

  assert(
    violatingCuts.length === 0,
    `expected no cuts inside featureB keep-away zone, got ${violatingCuts.length} (first at x=${violatingCuts[0]?.to.x.toFixed(2)}, y=${violatingCuts[0]?.to.y.toFixed(2)})`,
  )

  console.log('edge_route_outside obstacle clipping (non-selected): PASSED')
}

// ---------------------------------------------------------------------------
// V-carve: feature_first emits independent per-feature toolpath
// ---------------------------------------------------------------------------

function testVCarveDisjointFeaturesAreMachiningOrderInvariant() {
  console.log('Testing v_carve disjoint features are machiningOrder invariant...')

  // V-carve of two disjoint identical features must produce the SAME output
  // in both `level_first` and `feature_first` modes — same move count, same
  // moves, same order. (V-carve emits per-feature contiguous blocks naturally
  // for disjoint clusters, so the two modes converge to identity for this
  // fixture. Asserting full move equality is the strongest invariant the
  // fixture can support: a regression that emits the same number of moves
  // with wrong XY/Z values, or that interleaves features incorrectly, would
  // both be caught.)
  const tool = makeVBit('t1')
  const featA = makePocketFeature('a', 0, 0, 10, 10, 0, -2)
  const featB = makePocketFeature('b', 30, 0, 10, 10, 0, -2)
  const project = baseProject([tool], [featA, featB])

  const opLevel = makePocketOp({
    kind: 'v_carve',
    target: { source: 'features', featureIds: ['a', 'b'] },
    toolRef: 't1',
    maxCarveDepth: 2,
    stepover: 0.3,
    machiningOrder: 'level_first',
  })
  const opFeature = { ...opLevel, machiningOrder: 'feature_first' as const }

  const rLevel = generateVCarveToolpath(project, opLevel)
  const rFeature = generateVCarveToolpath(project, opFeature)
  assert(rLevel.moves.length > 0 && rFeature.moves.length > 0, 'both modes produce moves')

  // Fast pre-condition: equal cut-move counts. Gives a clearer failure
  // message when the multisets are obviously different sizes before we get
  // to the per-cut diff.
  const levelCuts = cutMoves(rLevel.moves)
  const featureCuts = cutMoves(rFeature.moves)
  assert(
    levelCuts.length === featureCuts.length,
    `expected equal cut-move counts between modes (level_first=${levelCuts.length}, feature_first=${featureCuts.length})`,
  )

  // Strong invariant: full cut-move sequence equality, including ordering.
  // Compares cuts only — not rapids/plunges — because rapid scaffolding can
  // legitimately vary between modes (e.g. one mode emitting a redundant
  // zero-length rapid when it transitions between feature blocks) without
  // affecting the actual material removal. Cut moves are the meaningful CAM
  // output. If either mode ever starts emitting different cut content or
  // ordering, find the first divergence so the failure message points at
  // the exact regression.
  assert(
    movesEqual(levelCuts, featureCuts),
    `v_carve cut sequences diverge between modes. ${describeFirstMoveDiff(levelCuts, featureCuts)}`,
  )

  console.log('v_carve disjoint features are machiningOrder invariant: PASSED')
}

/** First-divergence description used in the v-carve mode-parity failure msg. */
function describeFirstMoveDiff(a: ToolpathMove[], b: ToolpathMove[]): string {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const ma = a[i]
    const mb = b[i]
    const diffKind = ma.kind !== mb.kind
    const diff = diffKind
      || !approx(ma.from.x, mb.from.x) || !approx(ma.from.y, mb.from.y) || !approx(ma.from.z, mb.from.z)
      || !approx(ma.to.x, mb.to.x) || !approx(ma.to.y, mb.to.y) || !approx(ma.to.z, mb.to.z)
    if (diff) {
      const fmt = (m: ToolpathMove) => `${m.kind}(${m.from.x.toFixed(3)},${m.from.y.toFixed(3)},${m.from.z.toFixed(3)})→(${m.to.x.toFixed(3)},${m.to.y.toFixed(3)},${m.to.z.toFixed(3)})`
      return `First divergence at move #${i}: level_first=${fmt(ma)} feature_first=${fmt(mb)}`
    }
  }
  if (a.length !== b.length) return `Lengths differ: level_first=${a.length} feature_first=${b.length}`
  return 'No per-move divergence detected (movesEqual returned false unexpectedly)'
}

// ---------------------------------------------------------------------------
// Surface clean: multi-target with stepped heights protects taller targets
// ---------------------------------------------------------------------------

function makeCircleBoss(id: string, cx: number, cy: number, r: number, zTop: number, zBottom: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: circleProfile(cx, cy, r),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function testSurfaceCleanMultiTargetProtectsTallerTarget() {
  console.log('Testing surface_clean multi-target protects taller target (issue #54)...')

  // Repro distilled from issue #54: two adjacent boss circles cleaned in one op
  // at stepped heights. Without the fix, the deeper band's expanded subject
  // sweeps over the still-tall neighbour because the neighbour is filtered out
  // of the protected set just for being a target.
  const baseTool = defaultTool('inch', 1)
  const tool: Tool = {
    ...baseTool,
    id: 't1',
    name: '1/4 endmill',
    diameter: 0.25,
    defaultStepdown: 0.125,
    defaultStepover: 0.32,
  }

  const circA = makeCircleBoss('a', 0, 0, 0.5, 0.5, 0)
  const circB = makeCircleBoss('b', 1, 0, 0.5, 0.4, 0)

  const project: Project = {
    ...newProject('surface-test', 'inch'),
    tools: [tool],
    features: [circA, circB],
  }
  project.stock = { ...project.stock, thickness: 0.75 }

  const op = makePocketOp({
    kind: 'surface_clean',
    target: { source: 'features', featureIds: ['a', 'b'] },
    toolRef: 't1',
    stepdown: 0.05,
    stepover: 0.1,
  })

  const result = generateSurfaceCleanToolpath(project, op)
  assert(result.moves.length > 0, 'moves generated')

  // Any cut move below z=0.5 (i.e., in the deeper band) whose XY lies inside
  // circA's footprint means the tool is plowing through the taller boss.
  const tallerRadius = 0.5
  const violations = cutMoves(result.moves).filter((m) => {
    if (m.to.z >= 0.5 - 1e-6) return false
    const dx = m.to.x
    const dy = m.to.y
    return Math.hypot(dx, dy) < tallerRadius - 1e-3
  })

  assert(
    violations.length === 0,
    `expected no cut moves below z=0.5 inside the taller boss; got ${violations.length}`
      + (violations[0] ? ` (e.g. ${JSON.stringify(violations[0])})` : ''),
  )

  console.log('surface_clean multi-target protects taller target: PASSED')
}

function testFollowLineRegionClipsOpenPath() {
  console.log('Testing follow_line region clips open path...')
  const tool = makeFlatEndmill('t1', 1)
  const line = makeLineFeature('line1', 0, 5, 10, 5)
  const region = makeRegionFeature('r1', 2, 0, 4, 10)
  const project = baseProject([tool], [line, region])
  const op = makePocketOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1', 'r1'] },
    toolRef: 't1',
    carveDepth: 1,
  })
  const result = generateFollowLineToolpath(project, op)
  const cuts = cutMoves(result.moves)

  assert(cuts.length > 0, 'expected clipped follow-line cuts')
  assert(cuts.every((move) => move.from.x >= 2 - 1e-6 && move.to.x <= 6 + 1e-6), 'expected follow-line cuts inside region X bounds')
  assert(result.bounds !== null && result.bounds.minX >= 2 - 1e-6 && result.bounds.maxX <= 6 + 1e-6, 'expected clipped follow-line bounds')
  console.log('follow_line region clipping: PASSED')
}

function testDrillingRegionFiltersHolePoints() {
  console.log('Testing drilling region filters hole points...')
  const tool = makeFlatEndmill('t1', 1)
  const inside = makeCircleBoss('inside', 2, 2, 0.5, 4, 0)
  const outside = makeCircleBoss('outside', 8, 2, 0.5, 4, 0)
  const region = makeRegionFeature('r1', 0, 0, 4, 4)
  const project = baseProject([tool], [inside, outside, region])
  const op = makePocketOp({
    kind: 'drilling',
    target: { source: 'features', featureIds: ['inside', 'outside', 'r1'] },
    toolRef: 't1',
    stepdown: 1,
  })
  const result = generateDrillingToolpath(project, op)
  const drillingMoves = result.moves.filter((move) => move.kind === 'plunge' || move.kind === 'cut')

  assert(drillingMoves.length > 0, 'expected drilling moves for inside hole')
  assert(drillingMoves.every((move) => move.from.x < 4 + 1e-6 && move.to.x < 4 + 1e-6), 'expected drilling moves only inside region')
  console.log('drilling region filtering: PASSED')
}

function testDrillingOrdersByNearestNeighbor() {
  console.log('Testing drilling orders holes by nearest-neighbor travel...')
  const tool = makeFlatEndmill('t1', 1)
  // Three circles at x=10, 50, 30 (spatially shuffled)
  const circle1 = makeCircleBoss('c1', 10, 10, 0.5, 0, -5)
  const circle2 = makeCircleBoss('c2', 50, 10, 0.5, 0, -5)
  const circle3 = makeCircleBoss('c3', 30, 10, 0.5, 0, -5)
  const project = baseProject([tool], [circle1, circle2, circle3])
  const op = makePocketOp({
    kind: 'drilling',
    target: { source: 'features', featureIds: ['c1', 'c2', 'c3'] },
    toolRef: 't1',
    stepdown: 1,
  })

  const result = generateDrillingToolpath(project, op)
  const plunges = result.moves.filter((move) => move.kind === 'plunge')

  assert(plunges.length === 3, `expected 3 plunge moves, got ${plunges.length}`)

  // Extract X coordinates of plunge destinations to infer visit order
  const visitXs = plunges.map((m) => Math.round(m.to.x))

  // Nearest-neighbor from origin: c1 (10) is closest, then c3 (30), then c2 (50)
  const expectedXOrder = [10, 30, 50]
  assert(
    visitXs.every((x, i) => approx(x, expectedXOrder[i], 0.5)),
    `expected nearest-neighbor X order [${expectedXOrder}], got [${visitXs}]`,
  )

  console.log('drilling nearest-neighbor ordering: PASSED')
}

function testDrillingTieBreaksByOriginalOrder() {
  console.log('Testing drilling tie-breaks equidistant holes by original feature order...')
  const tool = makeFlatEndmill('t1', 1)
  // Two circles at equal distance from origin; c1 should be visited before c2 due to original order
  const circle1 = makeCircleBoss('c1', 5, 5, 0.5, 0, -5)
  const circle2 = makeCircleBoss('c2', 5, 5, 0.5, 0, -5) // same position as c1
  const circle3 = makeCircleBoss('c3', -10, 0, 0.5, 0, -5) // farther away
  const project = baseProject([tool], [circle1, circle2, circle3])
  const op = makePocketOp({
    kind: 'drilling',
    target: { source: 'features', featureIds: ['c1', 'c3', 'c2'] }, // c1 and c2 equidistant from c1 at origin
    toolRef: 't1',
    stepdown: 1,
  })

  const result = generateDrillingToolpath(project, op)
  const plunges = result.moves.filter((move) => move.kind === 'plunge')

  assert(plunges.length === 3, `expected 3 plunge moves, got ${plunges.length}`)
  // We expect c1 or c2 to be visited before c3 (they're closer)
  const firstPlungeX = plunges[0].to.x
  assert(
    approx(firstPlungeX, 5),
    `expected first hole near x=5 (c1 or c2), got x=${firstPlungeX}`,
  )

  console.log('drilling tie-breaking by original order: PASSED')
}

function testDrillingMinimizesSafeZTravelDistance() {
  console.log('Testing drilling minimizes safe-Z travel distance across holes...')
  const tool = makeFlatEndmill('t1', 1)
  // Extreme case: 4 holes in a line at x=0, 10, 20, 30
  // If ordered by feature list [0, 30, 10, 20], nearest-neighbor should reorder to ~[0, 10, 20, 30]
  const c0 = makeCircleBoss('c0', 0, 0, 0.5, 0, -5)
  const c30 = makeCircleBoss('c30', 30, 0, 0.5, 0, -5)
  const c10 = makeCircleBoss('c10', 10, 0, 0.5, 0, -5)
  const c20 = makeCircleBoss('c20', 20, 0, 0.5, 0, -5)
  const project = baseProject([tool], [c0, c30, c10, c20])
  const op = makePocketOp({
    kind: 'drilling',
    target: { source: 'features', featureIds: ['c0', 'c30', 'c10', 'c20'] },
    toolRef: 't1',
    stepdown: 1,
  })

  const result = generateDrillingToolpath(project, op)
  const rapidMoves = result.moves.filter((move) => move.kind === 'rapid')

  // Sum up XY distances of rapid moves (excluding Z-only moves)
  let totalRapidDist = 0
  for (const move of rapidMoves) {
    const dx = move.to.x - move.from.x
    const dy = move.to.y - move.from.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist > 1e-6) {
      totalRapidDist += dist
    }
  }

  // For nearest-neighbor [0, 10, 20, 30], total travel is ~30 units
  // For bad order [0, 30, 10, 20], we'd traverse 0→30→10→20 = 30 + 20 + 10 = 60 units
  // Nearest neighbor should be significantly better
  assert(
    totalRapidDist <= 35, // some slack for floating point and retract moves
    `expected total rapid distance <= 35 (nearest order), got ${totalRapidDist.toFixed(1)}`,
  )

  console.log('drilling minimizes safe-Z travel: PASSED')
}

function testFinishSurfaceCleanupRejectsRegionOnlyTarget() {
  console.log('Testing finish_surface_cleanup rejects region-only target...')
  const tool = makeFlatEndmill('t1', 1)
  const region = makeRegionFeature('r1', 0, 0, 10, 10)
  const project = baseProject([tool], [region])
  const op = makePocketOp({
    kind: 'finish_surface_cleanup',
    pass: 'finish',
    target: { source: 'features', featureIds: ['r1'] },
    toolRef: 't1',
  })
  const result = generateFinishSurfaceCleanupToolpath(project, op)

  assert(cutMoves(result.moves).length === 0, 'region-only cleanup should generate no cuts')
  assert(result.warnings.some((warning) => warning.includes('imported mesh model')), 'region-only cleanup should warn about the missing imported model target')
  console.log('finish_surface_cleanup region-only rejection: PASSED')
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

try {
  testPerFeatureOperations()
  testMergeToolpathResults()
  testPocketLevelFirstOrder()
  testPocketFeatureFirstOrder()
  testPocketFeatureFirstNearestBlockOrder()
  testPocketOffsetCutsInnerFirst()
  testPocketLevelTransitionsPlungeVerticallyFromSafeZ()
  testPocketSingleFeatureParity()
  testPocketRejectsRegionOnlyTarget()
  testPocketRegionClipsMachiningArea()
  testPocketRestRegionsFindUnreachableArea()
  testPocketRestRegionsFindCornerCusps()
  testPocketRestRegionsUniformCorners()
  testRegionMaskVisitsNearestRegionFirst()
  testEdgeInsideLevelFirstVsFeatureFirst()
  testEdgeInsideFeatureFirstNearestBlockOrder()
  testEdgeInsideRegionClipsAtBoundary()
  testEdgeOutsideAcceptsModelSilhouette()
  testEdgeOutsideUsesStoredModelSilhouettePaths()
  testEdgeOutsideIgnoresTinyStoredModelSilhouetteArtifacts()
  testEdgeOutsideClipsAroundNonSelectedAddFeatures()
  testVCarveDisjointFeaturesAreMachiningOrderInvariant()
  testSurfaceCleanMultiTargetProtectsTallerTarget()
  testFollowLineRegionClipsOpenPath()
  testDrillingRegionFiltersHolePoints()
  testDrillingOrdersByNearestNeighbor()
  testDrillingTieBreaksByOriginalOrder()
  testDrillingMinimizesSafeZTravelDistance()
  testFinishSurfaceCleanupRejectsRegionOnlyTarget()
  console.log('\nAll toolpath tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
