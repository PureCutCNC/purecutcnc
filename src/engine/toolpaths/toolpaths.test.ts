/**
 * Unit tests for toolpath generation — machiningOrder (level_first vs
 * feature_first), perFeatureOperations, mergeToolpathResults, and a
 * per-kind regression check that single-feature operations produce
 * identical output in both modes.
 *
 * Run with: npx tsx src/engine/toolpaths/toolpaths.test.ts
 */

import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import type { ToolpathBounds, ToolpathMove, ToolpathResult } from './types'
import { mergePocketToolpathResults, mergeToolpathResults, perFeatureOperations } from './multiFeature'
import { generatePocketToolpath } from './pocket'
import { generateEdgeRouteToolpath } from './edge'
import { generateVCarveToolpath } from './vcarve'
import { generateSurfaceCleanToolpath } from './surface'

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

// ---------------------------------------------------------------------------
// V-carve: feature_first emits independent per-feature toolpath
// ---------------------------------------------------------------------------

function testVCarveFeatureFirstProducesSameMoveCount() {
  console.log('Testing v_carve machiningOrder move-count parity...')

  // V-carve of disjoint features in level_first vs feature_first should
  // produce the same *number* of cut moves — only ordering differs.
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
  assert(
    cutMoves(rLevel.moves).length === cutMoves(rFeature.moves).length,
    `expected equal cut-move counts between modes (level_first=${cutMoves(rLevel.moves).length}, feature_first=${cutMoves(rFeature.moves).length})`,
  )

  console.log('v_carve move-count parity: PASSED')
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

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

try {
  testPerFeatureOperations()
  testMergeToolpathResults()
  testPocketLevelFirstOrder()
  testPocketFeatureFirstOrder()
  testPocketSingleFeatureParity()
  testEdgeInsideLevelFirstVsFeatureFirst()
  testVCarveFeatureFirstProducesSameMoveCount()
  testSurfaceCleanMultiTargetProtectsTallerTarget()
  console.log('\nAll toolpath tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
