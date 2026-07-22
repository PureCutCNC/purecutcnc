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

import type { Operation, Project, RegionMaskMode, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject, polygonProfile, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
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
import {
  buildMaskFromClipperPaths,
  buildRegionMask,
  clipToolpathResultToRegionMask,
  splitFeatureTargets,
} from './regions'
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

function makeRegionFeature(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  regionMaskMode?: RegionMaskMode,
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
    operation: 'region',
    regionMaskMode,
    z_top: 0,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makePolygonRegionFeature(id: string, points: Array<{ x: number; y: number }>, regionMaskMode?: RegionMaskMode): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: polygonProfile(points),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'region',
    regionMaskMode,
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
  return projectWithFeatures({
    ...project,
    tools,
  }, features)
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
    roundOutsideCorners: false,
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

function cutMoveGroups(moves: ToolpathMove[]): ToolpathMove[][] {
  const groups: ToolpathMove[][] = []
  let current: ToolpathMove[] = []
  for (const move of moves) {
    if (move.kind === 'cut') {
      current.push(move)
    } else if (current.length > 0) {
      groups.push(current)
      current = []
    }
  }
  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}

function toolpathMoveSignature(moves: ToolpathMove[]): string[] {
  const fmt = (value: number) => Number(value.toFixed(6))
  return moves.map((move) => JSON.stringify({
    kind: move.kind,
    from: { x: fmt(move.from.x), y: fmt(move.from.y), z: fmt(move.from.z) },
    to: { x: fmt(move.to.x), y: fmt(move.to.y), z: fmt(move.to.z) },
  }))
}

function hasUndirectedCutMoveNear(
  moves: ToolpathMove[],
  a: { x: number; y: number },
  b: { x: number; y: number },
  epsilon = 0.01,
): boolean {
  const near = (point: { x: number; y: number }, expected: { x: number; y: number }) =>
    approx(point.x, expected.x, epsilon) && approx(point.y, expected.y, epsilon)
  return moves.some((move) =>
    (near(move.from, a) && near(move.to, b))
    || (near(move.from, b) && near(move.to, a)))
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
    warnings: [{ code: 'debug' as const, params: { text: 'warn A' } }],
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
  assert(merged.warnings.length === 1 && merged.warnings[0].params?.text === 'warn A', 'warnings concatenated')
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
  assert(result.warnings.some((warning) => warning.code === 'resolverNoValidSubtracts'
    || (warning.code === 'resolverNoValidKindTargets' && String(warning.params?.kind ?? '').includes('subtract'))), 'region-only pocket should warn about missing subtract targets')
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

function testRegionMaskHonorsOrderedIncludeExcludeNesting() {
  console.log('Testing ordered include/exclude region-mask nesting...')
  const mask = buildRegionMask([
    makeRegionFeature('outer-include', 0, 0, 10, 10, 'include'),
    makeRegionFeature('middle-exclude', 2, 2, 6, 6, 'exclude'),
    makeRegionFeature('inner-include', 4, 4, 2, 2, 'include'),
  ])

  assert(mask !== null, 'expected ordered region mask')
  if (!mask) throw new Error('expected ordered region mask')
  assert(mask.containsPoint({ x: 1, y: 1 }), 'outer include should be active')
  assert(!mask.containsPoint({ x: 3, y: 3 }), 'exclude region should cut a hole')
  assert(mask.containsPoint({ x: 5, y: 5 }), 'later include should add an island back inside the hole')
  console.log('ordered include/exclude region-mask nesting: PASSED')
}

function testRegionMaskExcludeOnlyPreservesOutsideArea() {
  console.log('Testing exclude-only region mask preserves outside area...')
  const mask = buildRegionMask([
    makeRegionFeature('exclude-only', 0, 0, 10, 10, 'exclude'),
  ])
  assert(mask !== null, 'exclude-only region masks should create an outside-area mask')
  if (!mask) throw new Error('expected exclude-only region mask')
  assert(mask.containsPoint({ x: 20, y: 20 }), 'exclude-only mask should keep points outside the excluded region')
  assert(!mask.containsPoint({ x: 5, y: 5 }), 'exclude-only mask should reject points inside the excluded region')
  console.log('exclude-only region mask: PASSED')
}

function testRegionMaskLeadingExcludeCanBeReincluded() {
  console.log('Testing leading exclude region can be re-included...')
  const mask = buildRegionMask([
    makeRegionFeature('outer-exclude', 0, 0, 10, 10, 'exclude'),
    makeRegionFeature('inner-include', 4, 4, 2, 2, 'include'),
  ])
  assert(mask !== null, 'expected leading exclude region mask')
  if (!mask) throw new Error('expected leading exclude region mask')
  assert(mask.containsPoint({ x: -1, y: -1 }), 'leading exclude should keep subject area outside the excluded region')
  assert(!mask.containsPoint({ x: 2, y: 2 }), 'leading exclude should remove the excluded region')
  assert(mask.containsPoint({ x: 5, y: 5 }), 'later include should add an island back inside the excluded region')
  console.log('leading exclude region re-include: PASSED')
}

function testSplitFeatureTargetsOrdersRegionsByProjectSequence() {
  console.log('Testing selected region targets follow project order...')
  const tool = makeFlatEndmill('t1', 2)
  const pocket = makePocketFeature('pocket', 0, 0, 24, 12, 4, 0)
  const outerInclude = makeRegionFeature('outer-include', 0, 0, 24, 12, 'include')
  const middleExclude = makeRegionFeature('middle-exclude', 4, 2, 16, 8, 'exclude')
  const innerInclude = makeRegionFeature('inner-include', 8, 4, 8, 4, 'include')
  const finalExclude = makeRegionFeature('final-exclude', 10, 5, 4, 2, 'exclude')
  const project = baseProject([tool], [
    pocket,
    outerInclude,
    middleExclude,
    innerInclude,
    finalExclude,
  ])
  const split = splitFeatureTargets(project, [
    'pocket',
    'middle-exclude',
    'inner-include',
    'final-exclude',
    'outer-include',
  ])

  assert(
    split.machiningFeatures.map((feature) => feature.id).join(',') === 'pocket',
    'machining targets should stay in selected target order',
  )
  assert(
    split.regionFeatures.map((feature) => feature.id).join(',')
      === 'outer-include,middle-exclude,inner-include,final-exclude',
    `region targets should follow project order, got ${split.regionFeatures.map((feature) => feature.id).join(',')}`,
  )

  const mask = buildRegionMask(split.regionFeatures)
  assert(mask !== null, 'expected project-ordered region mask')
  if (!mask) throw new Error('expected project-ordered region mask')
  assert(mask.containsPoint({ x: 2, y: 2 }), 'outer include should keep the corner area')
  assert(!mask.containsPoint({ x: 5, y: 5 }), 'middle exclude should remove its area')
  assert(mask.containsPoint({ x: 9, y: 5 }), 'inner include should add its area back')
  assert(!mask.containsPoint({ x: 11, y: 6 }), 'final exclude should cut the nested area again')
  console.log('selected region target project ordering: PASSED')
}

function pointInsideRect(point: { x: number; y: number }, x: number, y: number, w: number, h: number): boolean {
  return point.x > x && point.x < x + w && point.y > y && point.y < y + h
}

function pointInsidePolygon(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index]
    const previousPoint = polygon[previous]
    if (((currentPoint.y > point.y) !== (previousPoint.y > point.y))
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y))
        / (previousPoint.y - currentPoint.y) + currentPoint.x) {
      inside = !inside
    }
  }
  return inside
}

function testPocketFinishExcludeOnlyRegionRemovesMachiningArea() {
  console.log('Testing pocket finish honors exclude-only region masks...')
  const tool = makeFlatEndmill('t1', 2)
  const pocket = makePocketFeature('p1', 0, 0, 30, 16, 4, 0)
  const exclude = makeRegionFeature('r-exclude', 10, 5, 10, 6, 'exclude')
  const project = baseProject([tool], [pocket, exclude])
  const op = makePocketOp({
    kind: 'pocket',
    pass: 'finish',
    target: { source: 'features', featureIds: ['p1', 'r-exclude'] },
    toolRef: 't1',
    pocketPattern: 'parallel',
    pocketAngle: 0,
  })
  const result = generatePocketToolpath(project, op)
  const cuts = cutMoves(result.moves)

  assert(cuts.length > 0, 'expected pocket finish cuts')
  for (const move of cuts) {
    const samples = [0.25, 0.5, 0.75].map((t) => ({
      x: move.from.x + (move.to.x - move.from.x) * t,
      y: move.from.y + (move.to.y - move.from.y) * t,
    }))
    assert(
      samples.every((point) => !pointInsideRect(point, 10, 5, 10, 6)),
      `exclude-only region should remove pocket finish cuts inside the excluded area, got move ${JSON.stringify(move)}`,
    )
  }
  console.log('pocket finish exclude-only region mask: PASSED')
}

function testPocketOffsetFinishExcludeOnlyRegionStillGeneratesToolpath() {
  console.log('Testing pocket offset finish honors exclude-only region masks...')
  const tool = makeFlatEndmill('t1', 0.25)
  const pocket = makePocketFeature('p1', 0.5, 0.5, 3, 2, 0.75, 0)
  const excludePoints = [
    { x: 0.5, y: 0.9 },
    { x: 0.9, y: 0.5 },
    { x: 3.1, y: 0.5 },
    { x: 3.5, y: 0.9 },
    { x: 3.5, y: 2.1 },
    { x: 3.1, y: 2.5 },
    { x: 0.9, y: 2.5 },
    { x: 0.5, y: 2.1 },
  ]
  const exclude = makePolygonRegionFeature('r-exclude', excludePoints, 'exclude')
  const project = baseProject([tool], [pocket, exclude])
  const op = makePocketOp({
    kind: 'pocket',
    pass: 'finish',
    target: { source: 'features', featureIds: ['p1', 'r-exclude'] },
    toolRef: 't1',
    pocketPattern: 'offset',
    stepdown: 0.125,
    stepover: 0.32,
    machiningOrder: 'feature_first',
  })
  const result = generatePocketToolpath(project, op)
  const cuts = cutMoves(result.moves)

  assert(cuts.length > 0, `expected offset finish cuts outside excluded region, warnings: ${result.warnings.join(', ')}`)
  for (const move of cuts) {
    const samples = [0.1, 0.25, 0.5, 0.75, 0.9].map((t) => ({
      x: move.from.x + (move.to.x - move.from.x) * t,
      y: move.from.y + (move.to.y - move.from.y) * t,
    }))
    assert(
      samples.every((point) => !pointInsidePolygon(point, excludePoints)),
      `exclude-only region should remove offset finish cuts inside the excluded area, got move ${JSON.stringify(move)}`,
    )
  }
  console.log('pocket offset finish exclude-only region mask: PASSED')
}

function testPocketOffsetFinishLeadingExcludeWithInnerInclude() {
  console.log('Testing pocket offset finish honors leading exclude with inner include...')
  const tool = makeFlatEndmill('t1', 0.25)
  const pocket = makePocketFeature('p1', 0.5, 0.5, 3, 2, 0.75, 0)
  const excludePoints = [
    { x: 0.5, y: 0.9 },
    { x: 0.9, y: 0.5 },
    { x: 3.1, y: 0.5 },
    { x: 3.5, y: 0.9 },
    { x: 3.5, y: 2.1 },
    { x: 3.1, y: 2.5 },
    { x: 0.9, y: 2.5 },
    { x: 0.5, y: 2.1 },
  ]
  const includePoints = [
    { x: 1.5, y: 1 },
    { x: 2.5, y: 1 },
    { x: 2.5, y: 1.875 },
    { x: 1.5, y: 1.875 },
  ]
  const exclude = makePolygonRegionFeature('r-exclude', excludePoints, 'exclude')
  const include = makePolygonRegionFeature('r-include', includePoints, 'include')
  const project = baseProject([tool], [pocket, exclude, include])
  const op = makePocketOp({
    kind: 'pocket',
    pass: 'finish',
    target: { source: 'features', featureIds: ['p1', 'r-exclude', 'r-include'] },
    toolRef: 't1',
    pocketPattern: 'offset',
    stepdown: 0.125,
    stepover: 0.32,
    machiningOrder: 'feature_first',
  })
  const result = generatePocketToolpath(project, op)
  const cuts = cutMoves(result.moves)
  let hasCornerCut = false
  let hasInnerCut = false

  assert(cuts.length > 0, `expected offset finish cuts, warnings: ${result.warnings.join(', ')}`)
  for (const move of cuts) {
    const samples = [0.1, 0.25, 0.5, 0.75, 0.9].map((t) => ({
      x: move.from.x + (move.to.x - move.from.x) * t,
      y: move.from.y + (move.to.y - move.from.y) * t,
    }))
    hasCornerCut ||= samples.some((point) => point.x < 0.9 && point.y < 0.9)
    hasInnerCut ||= samples.some((point) => pointInsidePolygon(point, includePoints))
    assert(
      samples.every((point) => !pointInsidePolygon(point, excludePoints) || pointInsidePolygon(point, includePoints)),
      `exclude/include region mask should keep only outside-exclude or inner-include cuts, got move ${JSON.stringify(move)}`,
    )
  }
  assert(hasCornerCut, 'expected cuts in the corner area outside the excluded region')
  assert(hasInnerCut, 'expected cuts inside the re-included inner region')
  console.log('pocket offset finish leading exclude with inner include: PASSED')
}

function testPocketRestRegionsEmitHoleCapableMaskModes() {
  console.log('Testing pocket rest-region generation emits include/exclude mask modes...')
  const tool = makeFlatEndmill('t1', 4)
  const pocket = makePocketFeature('p1', 0, 0, 40, 24, 4, 0)
  const island = makeIslandFeature('i1', 12, 6, 16, 12, 4, 0)
  const project = baseProject([tool], [pocket, island])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    stockToLeaveRadial: 100,
  })
  const result = generatePocketRestRegionDrafts(project, op)

  assert(result.drafts.some((draft) => (draft.regionMaskMode ?? 'include') === 'include'), 'expected at least one include rest region')
  assert(result.drafts.some((draft) => draft.regionMaskMode === 'exclude'), 'expected at least one exclude rest region for the island hole')

  const regionFeatures = result.drafts.map((draft, index): SketchFeature => ({
    ...makeRegionFeature(`rest-${index}`, 0, 0, 1, 1, draft.regionMaskMode ?? 'include'),
    sketch: {
      profile: draft.profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }))
  const mask = buildRegionMask(regionFeatures)
  assert(mask !== null, 'expected rest-region mask')
  if (!mask) throw new Error('expected rest-region mask')
  assert(mask.containsPoint({ x: 4, y: 4 }), 'rest mask should include pocket area')
  assert(!mask.containsPoint({ x: 20, y: 12 }), 'rest mask should exclude the island hole')
  console.log('pocket rest-region include/exclude mask modes: PASSED')
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
    !result.warnings.some((warning) => warning.code === 'targetsMissingOrWrongRole' && String(warning.params?.roles ?? '').includes('add/model/region')),
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

function testEdgeOutsideRoundCornersOptIn() {
  console.log('Testing edge_route_outside round outside corners opt-in...')

  const tool = makeFlatEndmill('t1', 4)
  const feature = makeAddFeature('a', 0, 0, 20, 12, 2, 0)
  const project = baseProject([tool], [feature])
  const baseOp = makePocketOp({
    kind: 'edge_route_outside',
    pass: 'finish',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
  })

  const miter = generateEdgeRouteToolpath(project, baseOp)
  const rounded = generateEdgeRouteToolpath(project, { ...baseOp, roundOutsideCorners: true })
  const miterCuts = cutMoves(miter.moves)
  const roundedCuts = cutMoves(rounded.moves)

  assert(miterCuts.length === 4, 'disabled outside route should keep four mitered rectangle cuts')
  assert(roundedCuts.length > miterCuts.length, 'enabled outside route should emit rounded multi-segment corners')
  assert(roundedCuts.length < 100, `rounded outside route should stay coarsely tessellated, got ${roundedCuts.length} cuts`)
  console.log('edge_route_outside round outside corners opt-in: PASSED')
}

function testEdgeOutsideCombinedRoundCorners() {
  console.log('Testing combined edge_route_outside respects round outside corners...')

  const tool = makeFlatEndmill('t1', 4)
  const featureA = makeAddFeature('a', 0, 0, 20, 12, 2, 0)
  const featureB = makeAddFeature('b', 30, 0, 20, 12, 2, 0)
  const project = baseProject([tool], [featureA, featureB])
  const baseOp = makePocketOp({
    kind: 'edge_route_outside',
    pass: 'finish',
    target: { source: 'features', featureIds: ['a', 'b'] },
    toolRef: 't1',
  })

  const miter = generateEdgeRouteToolpath(project, baseOp)
  const rounded = generateEdgeRouteToolpath(project, { ...baseOp, roundOutsideCorners: true })
  const miterCuts = cutMoves(miter.moves)
  const roundedCuts = cutMoves(rounded.moves)

  assert(miterCuts.length === 8, 'disabled combined outside route should keep two four-corner contours')
  assert(roundedCuts.length > miterCuts.length, 'enabled combined outside route should round both contours')
  assert(roundedCuts.length < 200, `combined rounded outside route should stay coarsely tessellated, got ${roundedCuts.length} cuts`)
  console.log('combined edge_route_outside round outside corners: PASSED')
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

  const project = projectWithFeatures({
    ...newProject('surface-test', 'inch'),
    tools: [tool],
  }, [circA, circB])
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

function testSurfaceCleanRegionMaskClipsGeneratedToolpathOnly() {
  console.log('Testing surface_clean applies region mask after generating the base toolpath...')
  const tool = makeFlatEndmill('t1', 2)
  const boss = makeAddFeature('boss', 0, 0, 24, 12, 4, 0)
  const include = makeRegionFeature('include-region', 8, 3, 8, 5, 'include')
  const project = baseProject([tool], [boss, include])
  project.stock = { ...project.stock, thickness: 6 }
  const baseOp = makePocketOp({
    kind: 'surface_clean',
    target: { source: 'features', featureIds: ['boss'] },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.4,
  })
  const regionOp = {
    ...baseOp,
    target: { source: 'features' as const, featureIds: ['boss', 'include-region'] },
  }
  const fullResult = generateSurfaceCleanToolpath(project, baseOp)
  const mask = buildRegionMask([include])
  assert(mask !== null, 'expected include region mask')
  const expected = clipToolpathResultToRegionMask(project, fullResult, mask)
  const actual = generateSurfaceCleanToolpath(project, regionOp)

  assert(cutMoves(actual.moves).length > 0, 'expected surface_clean cuts inside include region')
  assert(
    toolpathMoveSignature(actual.moves).join('\n') === toolpathMoveSignature(expected.moves).join('\n'),
    'surface_clean region target should match clipping the generated full toolpath',
  )
  console.log('surface_clean post-generation region clipping: PASSED')
}

function testSurfaceCleanHonorsOrderedRegionMaskModes() {
  console.log('Testing surface_clean honors ordered include/exclude region masks...')
  const tool = makeFlatEndmill('t1', 2)
  const boss = makeAddFeature('boss', 0, 0, 24, 12, 4, 0)
  const excludeMiddle = makeRegionFeature('middle-exclude', 4, 2, 16, 8, 'exclude')
  const includeInner = makeRegionFeature('inner-include', 10, 5, 4, 2, 'include')
  const project = baseProject([tool], [boss, excludeMiddle, includeInner])
  project.stock = { ...project.stock, thickness: 6 }
  const op = makePocketOp({
    kind: 'surface_clean',
    target: { source: 'features', featureIds: ['boss', 'middle-exclude', 'inner-include'] },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.4,
  })

  const result = generateSurfaceCleanToolpath(project, op)
  const cuts = cutMoves(result.moves)
  let hasOuterCut = false
  let hasInnerCut = false

  assert(cuts.length > 0, `expected surface_clean cuts, warnings: ${result.warnings.join(', ')}`)
  for (const move of cuts) {
    const samples = [0.1, 0.25, 0.5, 0.75, 0.9].map((t) => ({
      x: move.from.x + (move.to.x - move.from.x) * t,
      y: move.from.y + (move.to.y - move.from.y) * t,
    }))
    hasOuterCut ||= samples.some((point) => point.x < 4 && point.y < 4)
    hasInnerCut ||= samples.some((point) => pointInsideRect(point, 10, 5, 4, 2))
    assert(
      samples.every((point) => !pointInsideRect(point, 4, 2, 16, 8) || pointInsideRect(point, 10, 5, 4, 2)),
      `surface_clean should remove excluded cut fragments except the later include, got move ${JSON.stringify(move)}`,
    )
  }
  assert(hasOuterCut, 'expected surface_clean cuts outside the leading excluded region')
  assert(hasInnerCut, 'expected surface_clean cuts in the later included inner region')
  console.log('surface_clean ordered region mask modes: PASSED')
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
  assert(result.warnings.some((warning) => warning.code === 'finishNotMesh' || warning.code === 'surface3dNotMesh'), 'region-only cleanup should warn about the missing imported model target')
  console.log('finish_surface_cleanup region-only rejection: PASSED')
}

// ---------------------------------------------------------------------------
// Pocket slot feed (pocketSlotFeedPercent) tests
// ---------------------------------------------------------------------------

function makeIslandFeature(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return { ...makePocketFeature(id, x, y, w, h, zTop, zBottom), operation: 'add' }
}

function makePolygonIslandFeature(
  id: string,
  points: Array<{ x: number; y: number }>,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: polygonProfile(points),
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

function stampedCutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return cutMoves(moves).filter((move) => move.feedScale !== undefined)
}

function unstampedCutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return cutMoves(moves).filter((move) => move.feedScale === undefined)
}

/** Horizontal cut moves longer than minLength (parallel fill lines at angle 0). */
function horizontalFillMoves(moves: ToolpathMove[], boundaryYs: number[], minLength = 1): ToolpathMove[] {
  return cutMoves(moves).filter((move) =>
    approx(move.from.y, move.to.y)
    && Math.abs(move.to.x - move.from.x) > minLength
    && !boundaryYs.some((y) => approx(move.from.y, y)))
}

function testPocketFinishRoundsIslandWallsOnly() {
  console.log('Testing pocket finish rounds island walls while keeping the main boundary mitered...')
  const tool = makeFlatEndmill('t1', 4)
  const pocket = makePocketFeature('p1', 0, 0, 40, 24, 2, 0)
  const island = makePolygonIslandFeature('i1', [
    { x: 13.75, y: 10 },
    { x: 27.5, y: 10 },
    { x: 25, y: 16.25 },
    { x: 12.5, y: 20 },
  ], 2, 0)
  const project = baseProject([tool], [pocket, island])
  const baseOp = makePocketOp({
    kind: 'pocket',
    pass: 'finish',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    finishFloor: false,
  })

  const miter = generatePocketToolpath(project, baseOp)
  const rounded = generatePocketToolpath(project, { ...baseOp, roundOutsideCorners: true })
  const roundedGroups = cutMoveGroups(rounded.moves)
  const miterCuts = cutMoves(miter.moves)
  const roundedCuts = cutMoves(rounded.moves)

  assert(roundedGroups.length >= 2, `expected rounded wall contours, got ${roundedGroups.length}`)
  assert(roundedGroups[0].length === 4, 'rounded setting should keep the main pocket boundary mitered')
  assert(
    !hasUndirectedCutMoveNear(roundedCuts, { x: 26.499, y: 17.889 }, { x: 10.135, y: 22.798 }),
    'enabled island wall should not include a full mitered cleanup edge that makes the rounded finish look sharp',
  )
  assert(
    !hasUndirectedCutMoveNear(roundedCuts, { x: 13.75, y: 6.4 }, { x: 27.5, y: 6.4 }),
    'enabled island wall should not include a full outer cleanup contour on non-acute edges',
  )
  assert(
    hasUndirectedCutMoveNear(roundedCuts, { x: 31.014, y: 10.78 }, { x: 31.091, y: 10.249 }, 0.02),
    'enabled island wall should include localized rounded cleanup at acute island corners',
  )
  assert(roundedCuts.length > miterCuts.length + 20, 'enabled island wall should finish with multi-segment rounded corners')
  assert(roundedCuts.length < 120, `rounded island wall pass should stay coarsely tessellated, got ${roundedCuts.length} cuts`)

  const squareIsland = makeIslandFeature('i2', 12, 6, 16, 12, 2, 0)
  const squareRounded = generatePocketToolpath(baseProject([tool], [pocket, squareIsland]), { ...baseOp, roundOutsideCorners: true })
  assert(
    !hasUndirectedCutMoveNear(cutMoves(squareRounded.moves), { x: 12, y: 2.4 }, { x: 28, y: 2.4 }, 0.02),
    'right-angle island corners should not receive the acute-corner cleanup contour',
  )
  console.log('pocket finish rounded island walls only: PASSED')
}

// ---------------------------------------------------------------------------
// Corner smoothing (round corners) of inner clearing rings
// ---------------------------------------------------------------------------

function totalCutLength(moves: ToolpathMove[]): number {
  return cutMoves(moves).reduce((sum, move) => sum + Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y), 0)
}

/** Turn angles (degrees) at junctions where two cut moves actually connect. */
function connectedCutTurns(moves: ToolpathMove[]): number[] {
  const cuts = cutMoves(moves)
  const turns: number[] = []
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const a = cuts[index]
    const b = cuts[index + 1]
    if (!approx(a.to.x, b.from.x) || !approx(a.to.y, b.from.y)) continue
    const inX = a.to.x - a.from.x
    const inY = a.to.y - a.from.y
    const outX = b.to.x - b.from.x
    const outY = b.to.y - b.from.y
    const inLen = Math.hypot(inX, inY)
    const outLen = Math.hypot(outX, outY)
    if (inLen < 1e-9 || outLen < 1e-9) continue
    const cos = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLen * outLen)))
    turns.push((Math.acos(cos) * 180) / Math.PI)
  }
  return turns
}

function sharpTurnCount(moves: ToolpathMove[], thresholdDeg = 60): number {
  return connectedCutTurns(moves).filter((turn) => turn > thresholdDeg).length
}

function testPocketRoughRoundsInnerRings() {
  console.log('Testing pocket rough offset rounds the inner clearing-ring corners when enabled...')
  const tool = makeFlatEndmill('t1', 4)
  const pocket = makePocketFeature('p1', 0, 0, 30, 30, 2, 0)
  const project = baseProject([tool], [pocket])
  const baseOp = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
  })

  const disabled = generatePocketToolpath(project, baseOp)
  const enabled = generatePocketToolpath(project, { ...baseOp, roundOutsideCorners: true })

  // Disabled: concentric square rings keep their sharp 90° corners.
  assert(sharpTurnCount(disabled.moves) >= 8, `disabled rough rings should keep sharp corners, got ${sharpTurnCount(disabled.moves)}`)
  // Enabled: the ring corners become arcs, so far fewer sharp junctions remain
  // (only ring-to-ring links, never the ring corners themselves).
  assert(
    sharpTurnCount(enabled.moves) * 3 < sharpTurnCount(disabled.moves),
    `enabling round corners should remove most sharp ring corners (disabled ${sharpTurnCount(disabled.moves)}, enabled ${sharpTurnCount(enabled.moves)})`,
  )
  // Arc tessellation adds points; cutting the corners shortens the path.
  assert(cutMoves(enabled.moves).length > cutMoves(disabled.moves).length, 'rounded rings should tessellate into more cut moves')
  assert(totalCutLength(enabled.moves) < totalCutLength(disabled.moves), 'rounded rings should shorten the total cut path')

  // Disabled parity: false and undefined must be byte-identical (no-op when off).
  const undefinedFlag = generatePocketToolpath(project, { ...baseOp, roundOutsideCorners: undefined })
  assert(movesEqual(disabled.moves, undefinedFlag.moves), 'roundOutsideCorners false vs undefined must produce identical moves')
  console.log('pocket rough rounds inner rings: PASSED')
}

function testPocketRoughKeepsBoundaryRingSharpEveryLevel() {
  console.log('Testing rounded rough keeps the wall-adjacent ring sharp at every Z level (no corner column)...')
  const tool = makeFlatEndmill('t1', 4)
  // 6 mm deep, stepdown 2 => rough levels at z = 4, 2, 0.
  const pocket = makePocketFeature('p1', 0, 0, 40, 40, 6, 0)
  const project = baseProject([tool], [pocket])
  const result = generatePocketToolpath(project, makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    finishWalls: false,
    finishFloor: false,
    roundOutsideCorners: true,
  }))

  // The wall-adjacent ring corner sits one tool radius in from the pocket
  // corner, at (2, 2). If the outermost ring were rounded away, no cut would
  // reach it — and the uncut crescent would stack into a tall chip. With walls
  // and floor finish OFF, only the rough pass runs, so reaching (2, 2) at every
  // level proves the boundary ring stays sharp per level.
  const corner = { x: 2, y: 2 }
  const near = (p: { x: number; y: number }) => Math.hypot(p.x - corner.x, p.y - corner.y) < 0.3
  for (const z of [4, 2, 0]) {
    const reached = cutMoves(result.moves).some((move) => approx(move.to.z, z) && (near(move.to) || near(move.from)))
    assert(reached, `rough level z=${z} must reach the wall-adjacent corner (boundary ring must not be rounded away)`)
  }
  console.log('pocket rough keeps boundary ring sharp every level: PASSED')
}

function testPocketRoughRoundsIslandRings() {
  console.log('Testing pocket rough wraps islands with rounded (non-gouging) rings when enabled...')
  const tool = makeFlatEndmill('t1', 4) // radius 2
  const pocket = makePocketFeature('p1', 0, 0, 50, 40, 2, 0)
  const island = makeIslandFeature('i1', 16, 12, 18, 16, 2, 0) // rect island 16..34 x 12..28
  const project = baseProject([tool], [pocket, island])
  const baseOp = makePocketOp({ kind: 'pocket', target: { source: 'features', featureIds: ['p1'] }, toolRef: 't1' })

  const off = generatePocketToolpath(project, baseOp)
  const on = generatePocketToolpath(project, { ...baseOp, roundOutsideCorners: true })

  const distIsland = (x: number, y: number) =>
    Math.hypot(Math.max(16 - x, 0, x - 34), Math.max(12 - y, 0, y - 28))
  const minToolDistToIsland = (moves: ToolpathMove[]) =>
    Math.min(...cutMoves(moves).flatMap((move) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) / 0.2))
      const distances: number[] = []
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps
        distances.push(distIsland(move.from.x + (move.to.x - move.from.x) * t, move.from.y + (move.to.y - move.from.y) * t))
      }
      return distances
    }))

  // Rounded island rings must never pull the tool into the island. The tool
  // radius is 2; allow only the jtRound arc-tessellation tolerance (~0.01 mm).
  assert(
    minToolDistToIsland(on.moves) > 2 - 0.05,
    `rounded island rings must not gouge the island (min tool-center distance ${minToolDistToIsland(on.moves).toFixed(3)} vs radius 2)`,
  )

  // The island-hugging ring (~2 mm off the island) is a sharp rectangle when
  // off (corners sit at ~2.8 mm, no vertices in the band) and a tessellated
  // rounded rectangle when on (many arc vertices land in the band).
  const hugRingVertices = (moves: ToolpathMove[]) =>
    cutMoves(moves).filter((move) => Math.abs(distIsland(move.to.x, move.to.y) - 2) < 0.25).length
  assert(
    hugRingVertices(on.moves) > hugRingVertices(off.moves) + 8,
    `enabled island ring should be tessellated into arcs (${hugRingVertices(off.moves)} -> ${hugRingVertices(on.moves)})`,
  )

  const undefinedFlag = generatePocketToolpath(project, { ...baseOp, roundOutsideCorners: undefined })
  assert(movesEqual(off.moves, undefinedFlag.moves), 'off vs undefined must be identical around islands')
  console.log('pocket rough rounds island rings: PASSED')
}

function testPocketFinishFloorRoundsWhenEnabled() {
  console.log('Testing pocket finish-floor clearing rings round when enabled, exact when off...')
  const tool = makeFlatEndmill('t1', 4)
  const pocket = makePocketFeature('p1', 0, 0, 30, 30, 2, 0)
  const project = baseProject([tool], [pocket])
  const baseOp = makePocketOp({
    kind: 'pocket',
    pass: 'finish',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    finishWalls: false,
    finishFloor: true,
  })

  const disabled = generatePocketToolpath(project, baseOp)
  const enabled = generatePocketToolpath(project, { ...baseOp, roundOutsideCorners: true })

  // The floor is cleared with concentric rings; enabling rounds their corners.
  assert(sharpTurnCount(disabled.moves) >= 4, `disabled finish floor should keep sharp corners, got ${sharpTurnCount(disabled.moves)}`)
  assert(
    sharpTurnCount(enabled.moves) * 2 < sharpTurnCount(disabled.moves),
    `enabling round corners should smooth the finish-floor rings (disabled ${sharpTurnCount(disabled.moves)}, enabled ${sharpTurnCount(enabled.moves)})`,
  )
  assert(!movesEqual(disabled.moves, enabled.moves), 'finish-floor moves should change when round corners is enabled')

  // Disabled parity holds.
  const undefinedFlag = generatePocketToolpath(project, { ...baseOp, roundOutsideCorners: undefined })
  assert(movesEqual(disabled.moves, undefinedFlag.moves), 'finish-floor false vs undefined must produce identical moves')
  console.log('pocket finish-floor rounds when enabled: PASSED')
}

function testSurfaceCleanRoughRoundsInnerRings() {
  console.log('Testing surface_clean rough offset rounds inner clearing rings when enabled...')
  const tool = makeFlatEndmill('t1', 4)
  const boss = { ...makePocketFeature('b1', 4, 4, 30, 30, 6, 0), operation: 'add' as const }
  const project = baseProject([tool], [boss])
  project.stock = { ...project.stock, thickness: 8 }
  const baseOp = makePocketOp({
    kind: 'surface_clean',
    target: { source: 'features', featureIds: ['b1'] },
    toolRef: 't1',
  })

  const disabled = generateSurfaceCleanToolpath(project, baseOp)
  const enabled = generateSurfaceCleanToolpath(project, { ...baseOp, roundOutsideCorners: true })
  assert(cutMoves(disabled.moves).length > 0, 'expected surface_clean cuts')
  assert(sharpTurnCount(enabled.moves) < sharpTurnCount(disabled.moves), 'surface_clean should smooth rings when enabled')

  const undefinedFlag = generateSurfaceCleanToolpath(project, { ...baseOp, roundOutsideCorners: undefined })
  assert(movesEqual(disabled.moves, undefinedFlag.moves), 'surface_clean false vs undefined must produce identical moves')
  console.log('surface_clean rough rounds inner rings: PASSED')
}

function testPocketOffsetSlotFeedSimple() {
  console.log('Testing pocket offset slot feed marks only the innermost loop...')
  const tool = makeFlatEndmill('t1')
  const pocket = makePocketFeature('p1', 0, 0, 20, 20, 2, 0)
  const project = baseProject([tool], [pocket])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    pocketSlotFeedPercent: 50,
  })

  const result = generatePocketToolpath(project, op)
  const stamped = stampedCutMoves(result.moves)
  const unstamped = unstampedCutMoves(result.moves)

  assert(stamped.length > 0, 'expected a stamped innermost loop')
  assert(unstamped.length > 0, 'expected outer loops at normal feed')
  assert(stamped.every((move) => approx(move.feedScale ?? 0, 0.5)), 'stamped moves should carry feedScale 0.5')

  // 20x20 pocket, 4mm tool, 1.6 stepover: the innermost ring sits at
  // 8.4..11.6. It is the only fully engaged loop — every other ring runs one
  // stepover from its already-cut child, so any stamped move outside the
  // innermost box can only be a short link fragment plowing into virgin
  // material, never a ring edge.
  const moveLen = (move: ToolpathMove) => Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
  for (const move of stamped) {
    const inInnermostBox = [move.from.x, move.from.y, move.to.x, move.to.y]
      .every((value) => value > 8 && value < 12)
    assert(
      inInnermostBox || moveLen(move) < 2.4,
      `stamped move outside the innermost ring should only be a short link fragment (len=${moveLen(move).toFixed(2)})`,
    )
  }
  // Ring edges of the outer loops (long moves outside the innermost box) all
  // run at normal feed.
  for (const move of unstamped.concat(stamped)) {
    const outsideInnermost = [move.from.x, move.from.y, move.to.x, move.to.y]
      .some((value) => value < 8 || value > 12)
    if (outsideInnermost && moveLen(move) > 3) {
      assert(move.feedScale === undefined, `long outer ring edge should be unstamped (len=${moveLen(move).toFixed(2)})`)
    }
  }

  const allCuts = cutMoves(result.moves)
  assert(allCuts[0].feedScale !== undefined, 'first cut at the level (innermost loop) should be stamped')
  assert(allCuts[allCuts.length - 1].feedScale === undefined, 'last cut (wall-adjacent loop) should be unstamped')
  console.log('pocket offset slot feed simple: PASSED')
}

function testPocketOffsetSlotFeedIslandSections() {
  console.log('Testing pocket offset slot feed with island-split sections and pinch corridors...')
  const tool = makeFlatEndmill('t1')
  const pocket = makePocketFeature('p1', 0, 0, 40, 24, 2, 0)
  const island = makeIslandFeature('i1', 12, 6, 16, 12, 2, 0)
  const project = baseProject([tool], [pocket, island])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    pocketSlotFeedPercent: 50,
  })

  const result = generatePocketToolpath(project, op)
  const stamped = stampedCutMoves(result.moves)
  assert(stamped.length > 0, 'expected stamped moves')

  // The island splits the first inset into left and right sections; each
  // section's own innermost start must run at slot feed. (With self-clearing
  // awareness only the sliver's first pass is stamped — the back pass runs
  // one stepover from its own kerf — so expect at least one per section.)
  const stampedLeft = stamped.filter((move) => (move.from.x + move.to.x) / 2 < 10)
  const stampedRight = stamped.filter((move) => (move.from.x + move.to.x) / 2 > 30)
  assert(stampedLeft.length >= 1, 'left section innermost start should be stamped')
  assert(stampedRight.length >= 1, 'right section innermost start should be stamped')

  // The island ring's top edge (y=20) is the first pass through the virgin
  // pinch corridor above the island — a true slot cut. Its middle fragment
  // must be stamped and split from the ends that run within a tool width of
  // the already-cleared left/right sections.
  const containsX = (move: ToolpathMove, x: number) =>
    Math.min(move.from.x, move.to.x) <= x && Math.max(move.from.x, move.to.x) >= x
  const islandTopMoves = cutMoves(result.moves).filter((move) => approx(move.from.y, 20, 1e-3) && approx(move.to.y, 20, 1e-3))
  assert(
    islandTopMoves.some((move) => move.feedScale !== undefined && containsX(move, 20)),
    'island ring top edge over the corridor should be stamped',
  )
  assert(
    islandTopMoves.some((move) => move.feedScale === undefined),
    'island ring top edge next to the cleared sections should be unstamped',
  )

  // The outermost ring's top edge (y=22) is cut after the island ring already
  // slotted the corridor: it runs within a kerf's reach of that pass (and of
  // the sections at its ends), so none of it is fully engaged.
  const topEdgeMoves = cutMoves(result.moves).filter((move) => approx(move.from.y, 22, 1e-3) && approx(move.to.y, 22, 1e-3))
  assert(topEdgeMoves.length > 0, 'expected the outer ring top edge')
  assert(
    topEdgeMoves.every((move) => move.feedScale === undefined),
    'outer top edge should run at normal feed once the island ring cleared the corridor',
  )
  console.log('pocket offset slot feed island sections: PASSED')
}

function testPocketOffsetSlotFeedPerLevel() {
  console.log('Testing pocket offset slot feed applies at every Z level...')
  const tool = makeFlatEndmill('t1')
  const pocket = makePocketFeature('p1', 0, 0, 20, 20, 2, 0)
  const project = baseProject([tool], [pocket])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    stepdown: 1,
    pocketSlotFeedPercent: 50,
  })

  const result = generatePocketToolpath(project, op)
  const stamped = stampedCutMoves(result.moves)
  assert(stamped.some((move) => approx(move.to.z, 1)), 'first level should have stamped moves')
  assert(stamped.some((move) => approx(move.to.z, 0)), 'second level should have stamped moves')
  console.log('pocket offset slot feed per level: PASSED')
}

function testPocketParallelSlotFeed() {
  console.log('Testing pocket parallel slot feed marks boundary and first fill line per region...')
  const tool = makeFlatEndmill('t1')
  const left = makePocketFeature('p1', 0, 0, 20, 20, 2, 0)
  const right = makePocketFeature('p2', 40, 0, 20, 20, 2, 0)
  const project = baseProject([tool], [left, right])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1', 'p2'] },
    toolRef: 't1',
    pocketPattern: 'parallel',
    pocketSlotFeedPercent: 50,
  })

  const result = generatePocketToolpath(project, op)
  const allCuts = cutMoves(result.moves)
  assert(allCuts[0].feedScale !== undefined, 'first boundary cut should be stamped')
  assert(allCuts[allCuts.length - 1].feedScale === undefined, 'last fill line should be unstamped')

  // Boundary rings sit at the tool-radius inset: y=2 and y=18 for both rects.
  const boundaryYs = [2, 18]
  const fills = horizontalFillMoves(result.moves, boundaryYs)
  assert(fills.length > 4, 'expected parallel fill lines')

  // For this geometry every fill line runs within one stepover of an earlier
  // kerf (the first line is 0.8 from the boundary pass, later lines 1.6 from
  // their neighbour), so no fill line is fully engaged.
  assert(fills.every((move) => move.feedScale === undefined), 'fill lines adjacent to cleared kerf should be unstamped')

  // The boundary pass slots into virgin material — each region's boundary
  // ring must carry stamped moves (the closing stretch next to the ring's own
  // start may legitimately run at normal feed).
  for (const [regionName, minX, maxX] of [['left', 0, 20], ['right', 40, 60]] as const) {
    const regionBoundary = cutMoves(result.moves).filter((move) =>
      boundaryYs.some((y) => approx(move.from.y, y) && approx(move.to.y, y))
      && Math.abs(move.to.x - move.from.x) > 1
      && move.from.x >= minX && move.from.x <= maxX)
    assert(regionBoundary.length > 0, `expected ${regionName} boundary ring moves`)
    assert(
      regionBoundary.some((move) => move.feedScale !== undefined),
      `${regionName} boundary ring should carry stamped slotting moves`,
    )
  }
  console.log('pocket parallel slot feed: PASSED')
}

function testPocketFinishFloorSlotFeedOffset() {
  console.log('Testing pocket finish floor slot feed (offset): first floor loop only, walls untouched...')
  const tool = makeFlatEndmill('t1')
  const pocket = makePocketFeature('p1', 0, 0, 30, 30, 2, 0)
  const project = baseProject([tool], [pocket])
  const op = makePocketOp({
    kind: 'pocket',
    pass: 'finish',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    pocketSlotFeedPercent: 50,
  })

  const result = generatePocketToolpath(project, op)
  const stamped = stampedCutMoves(result.moves)
  assert(stamped.length >= 1, 'expected the floor entry to be stamped')

  // The floor is cut inner-first like the rough pass: the very first floor
  // cut is the innermost loop near the pocket centre.
  const firstCut = cutMoves(result.moves)[0]
  for (const value of [firstCut.from.x, firstCut.from.y, firstCut.to.x, firstCut.to.y]) {
    assert(value > 13 && value < 17, `first floor cut coordinate ${value} should be at the innermost loop near the centre`)
  }
  assert(firstCut.feedScale !== undefined, 'the innermost floor loop should be stamped')

  // Wall contour runs at the tool-radius inset (x/y = 2 or 28) and must stay
  // at normal feed; floor loops start one stepover further in.
  for (const move of stamped) {
    for (const value of [move.from.x, move.from.y, move.to.x, move.to.y]) {
      assert(value > 3 && value < 27, `stamped floor move coordinate ${value} should be inside the wall contour`)
    }
  }

  // Later floor loops run at normal feed.
  const unstampedFloor = unstampedCutMoves(result.moves).filter((move) =>
    [move.from.x, move.from.y, move.to.x, move.to.y].every((value) => value > 3 && value < 27))
  assert(unstampedFloor.length > 0, 'expected later floor loops at normal feed')

  // Walls only + slot feed => nothing stamped.
  const wallsOnly = generatePocketToolpath(project, { ...op, finishFloor: false })
  assert(stampedCutMoves(wallsOnly.moves).length === 0, 'walls-only finish should have no stamped moves')

  // Floor cuts before walls: if roughing left axial stock, a wall pass at
  // final depth would slot through the uncleared floor skin at full feed, so
  // the floor (whose first pass runs at slot feed) must clear it first.
  const allCuts = cutMoves(result.moves)
  const isWallMove = (move: ToolpathMove) =>
    [move.from.x, move.from.y, move.to.x, move.to.y].some((value) => approx(value, 2) || approx(value, 28))
  const firstWallIndex = allCuts.findIndex(isWallMove)
  const lastFloorIndex = allCuts.reduce((last, move, index) => (!isWallMove(move) ? index : last), -1)
  assert(firstWallIndex > lastFloorIndex, 'wall contour should be cut after all floor cuts')
  console.log('pocket finish floor slot feed offset: PASSED')
}

function testPocketFinishFloorSlotFeedParallel() {
  console.log('Testing pocket finish floor slot feed (parallel): first fill line only...')
  const tool = makeFlatEndmill('t1')
  const pocket = makePocketFeature('p1', 0, 0, 20, 20, 2, 0)
  const project = baseProject([tool], [pocket])
  const op = makePocketOp({
    kind: 'pocket',
    pass: 'finish',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    pocketPattern: 'parallel',
    finishWalls: false,
    pocketSlotFeedPercent: 50,
  })

  const result = generatePocketToolpath(project, op)
  const allCuts = cutMoves(result.moves)
  assert(allCuts.length > 2, 'expected floor fill lines')
  assert(allCuts[0].feedScale !== undefined, 'first floor fill line should be stamped')
  assert(allCuts[allCuts.length - 1].feedScale === undefined, 'last floor fill line should be unstamped')

  const stampedYs = new Set(stampedCutMoves(result.moves)
    .filter((move) => approx(move.from.y, move.to.y))
    .map((move) => move.from.y.toFixed(4)))
  assert(stampedYs.size === 1, `exactly one floor fill line should be stamped, got ${stampedYs.size}`)
  console.log('pocket finish floor slot feed parallel: PASSED')
}

function testPocketOffsetSlotFeedPartialDepthIsland() {
  console.log('Testing pocket offset slot feed with an island whose top Z is below the pocket top (two bands)...')
  const tool = makeFlatEndmill('t1')
  // Pocket 4 -> 0, island only rises to z=2: the upper band has no island,
  // the lower band is split into left/right sections by the island.
  const pocket = makePocketFeature('p1', 0, 0, 40, 24, 4, 0)
  const island = makeIslandFeature('i1', 12, 6, 16, 12, 2, 0)
  const project = baseProject([tool], [pocket, island])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['p1'] },
    toolRef: 't1',
    pocketSlotFeedPercent: 50,
  })

  const result = generatePocketToolpath(project, op)
  const cutsAt = (z: number) => cutMoves(result.moves).filter((move) => approx(move.to.z, z) && approx(move.from.z, z))

  // Upper band (z=2, island absent): behaves like a plain pocket — the
  // stamped innermost loop sits near the centre; any stamped move elsewhere
  // can only be a short link fragment, never a ring edge.
  const upperStamped = cutsAt(2).filter((move) => move.feedScale !== undefined)
  assert(upperStamped.length >= 1, 'upper band should stamp its innermost loop')
  for (const move of upperStamped) {
    const isLong = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) > 3
    if (isLong) {
      for (const value of [move.from.y, move.to.y]) {
        assert(value > 4 && value < 20, `upper band stamped ring edge y ${value} should be near the pocket centre`)
      }
    }
  }

  // Lower band (z=0, island present): each section's innermost start is
  // stamped, and the island ring's first pass through the virgin pinch
  // corridor (y=20) is a stamped slot cut.
  const lowerStamped = cutsAt(0).filter((move) => move.feedScale !== undefined)
  assert(lowerStamped.some((move) => (move.from.x + move.to.x) / 2 < 10), 'lower band left section should be stamped')
  assert(lowerStamped.some((move) => (move.from.x + move.to.x) / 2 > 30), 'lower band right section should be stamped')
  const lowerIslandTop = cutsAt(0).filter((move) => approx(move.from.y, 20, 1e-3) && approx(move.to.y, 20, 1e-3))
  assert(
    lowerIslandTop.some((move) =>
      move.feedScale !== undefined
      && Math.min(move.from.x, move.to.x) <= 20 && Math.max(move.from.x, move.to.x) >= 20),
    'lower band island ring should be stamped over the corridor',
  )

  // Disabled parity holds across bands too.
  const legacy = generatePocketToolpath(project, { ...op, pocketSlotFeedPercent: undefined })
  const explicit100 = generatePocketToolpath(project, { ...op, pocketSlotFeedPercent: 100 })
  assert(legacy.moves.every((move) => move.feedScale === undefined), 'disabled two-band pocket should have no feedScale')
  assert(movesEqual(legacy.moves, explicit100.moves), 'percent=100 must not change the two-band move stream')
  console.log('pocket offset slot feed partial-depth island: PASSED')
}

function testSurfaceCleanFinishCutsFloorBeforeWalls() {
  console.log('Testing surface_clean finish cuts the floor before the walls...')
  const tool = makeFlatEndmill('t1')
  const boss = { ...makePocketFeature('b1', 10, 10, 10, 10, 5, 0), operation: 'add' as const }
  const project = baseProject([tool], [boss])
  project.stock = { ...project.stock, thickness: 8 }
  const op = makePocketOp({
    kind: 'surface_clean',
    pass: 'finish',
    target: { source: 'features', featureIds: ['b1'] },
    toolRef: 't1',
  })

  const combined = generateSurfaceCleanToolpath(project, op)
  const floorOnly = generateSurfaceCleanToolpath(project, { ...op, finishWalls: false })
  const wallsOnly = generateSurfaceCleanToolpath(project, { ...op, finishFloor: false })
  const combinedCuts = cutMoves(combined.moves)
  const floorCuts = cutMoves(floorOnly.moves)
  const wallCuts = cutMoves(wallsOnly.moves)
  assert(combinedCuts.length > 0 && floorCuts.length > 0 && wallCuts.length > 0, 'expected cuts in all three variants')

  // Floors first: the combined pass starts exactly like the floor-only pass.
  assert(
    pointEquals(combinedCuts[0].from, floorCuts[0].from) && pointEquals(combinedCuts[0].to, floorCuts[0].to),
    'combined finish should start with the floor pass',
  )

  // Walls last: the final cut lies on a wall contour (its vertices appear in
  // the walls-only pass) and not on any floor contour.
  const lastCutTo = combinedCuts[combinedCuts.length - 1].to
  const matchesVertex = (cuts: ToolpathMove[]) => cuts.some((move) => pointEquals(move.to, lastCutTo))
  assert(matchesVertex(wallCuts), 'combined finish should end on a wall contour')
  assert(!matchesVertex(floorCuts), 'combined finish should not end on a floor contour')
  console.log('surface_clean finish floor-before-walls: PASSED')
}

function testPocketSlotFeedDisabledParity() {
  console.log('Testing pocket slot feed disabled (undefined / 100) leaves moves untouched...')
  const tool = makeFlatEndmill('t1')
  const pocket = makePocketFeature('p1', 0, 0, 20, 20, 2, 0)
  const island = makeIslandFeature('i1', 6, 6, 8, 8, 2, 0)
  const project = baseProject([tool], [pocket, island])

  for (const pattern of ['offset', 'parallel'] as const) {
    for (const pass of ['rough', 'finish'] as const) {
      const base = makePocketOp({
        kind: 'pocket',
        pass,
        target: { source: 'features', featureIds: ['p1'] },
        toolRef: 't1',
        pocketPattern: pattern,
      })
      const legacy = generatePocketToolpath(project, base)
      const explicit100 = generatePocketToolpath(project, { ...base, pocketSlotFeedPercent: 100 })

      assert(
        legacy.moves.every((move) => move.feedScale === undefined),
        `${pattern}/${pass}: legacy operation should have no feedScale`,
      )
      assert(
        explicit100.moves.every((move) => move.feedScale === undefined),
        `${pattern}/${pass}: percent=100 should have no feedScale`,
      )
      assert(
        movesEqual(legacy.moves, explicit100.moves),
        `${pattern}/${pass}: percent=100 must not change the move stream`,
      )
    }
  }
  console.log('pocket slot feed disabled parity: PASSED')
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
  testRegionMaskHonorsOrderedIncludeExcludeNesting()
  testRegionMaskExcludeOnlyPreservesOutsideArea()
  testRegionMaskLeadingExcludeCanBeReincluded()
  testSplitFeatureTargetsOrdersRegionsByProjectSequence()
  testPocketFinishExcludeOnlyRegionRemovesMachiningArea()
  testPocketOffsetFinishExcludeOnlyRegionStillGeneratesToolpath()
  testPocketOffsetFinishLeadingExcludeWithInnerInclude()
  testPocketRestRegionsEmitHoleCapableMaskModes()
  testRegionMaskVisitsNearestRegionFirst()
  testEdgeInsideLevelFirstVsFeatureFirst()
  testEdgeInsideFeatureFirstNearestBlockOrder()
  testEdgeInsideRegionClipsAtBoundary()
  testEdgeOutsideAcceptsModelSilhouette()
  testEdgeOutsideUsesStoredModelSilhouettePaths()
  testEdgeOutsideIgnoresTinyStoredModelSilhouetteArtifacts()
  testEdgeOutsideClipsAroundNonSelectedAddFeatures()
  testEdgeOutsideRoundCornersOptIn()
  testEdgeOutsideCombinedRoundCorners()
  testVCarveDisjointFeaturesAreMachiningOrderInvariant()
  testSurfaceCleanMultiTargetProtectsTallerTarget()
  testSurfaceCleanRegionMaskClipsGeneratedToolpathOnly()
  testSurfaceCleanHonorsOrderedRegionMaskModes()
  testFollowLineRegionClipsOpenPath()
  testDrillingRegionFiltersHolePoints()
  testDrillingOrdersByNearestNeighbor()
  testDrillingTieBreaksByOriginalOrder()
  testDrillingMinimizesSafeZTravelDistance()
  testFinishSurfaceCleanupRejectsRegionOnlyTarget()
  testPocketFinishRoundsIslandWallsOnly()
  testPocketRoughRoundsInnerRings()
  testPocketRoughKeepsBoundaryRingSharpEveryLevel()
  testPocketRoughRoundsIslandRings()
  testPocketFinishFloorRoundsWhenEnabled()
  testSurfaceCleanRoughRoundsInnerRings()
  testPocketOffsetSlotFeedSimple()
  testPocketOffsetSlotFeedIslandSections()
  testPocketOffsetSlotFeedPerLevel()
  testPocketOffsetSlotFeedPartialDepthIsland()
  testPocketParallelSlotFeed()
  testPocketFinishFloorSlotFeedOffset()
  testPocketFinishFloorSlotFeedParallel()
  testSurfaceCleanFinishCutsFloorBeforeWalls()
  testPocketSlotFeedDisabledParity()
  console.log('\nAll toolpath tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
