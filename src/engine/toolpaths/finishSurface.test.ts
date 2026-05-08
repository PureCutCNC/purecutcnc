/**
 * Integration tests for finish surface toolpath generation.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurface.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { generateFinishSurfaceToolpath, maxContourGap } from './finishSurface'
import { toClipperPath, normalizeWinding, DEFAULT_CLIPPER_SCALE } from './geometry'
import type { ClipperPath, ToolpathMove } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function addBoxFaces(
  lines: string[],
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  const vertices = {
    b0: [minX, minY, minZ],
    b1: [maxX, minY, minZ],
    b2: [maxX, maxY, minZ],
    b3: [minX, maxY, minZ],
    t0: [minX, minY, maxZ],
    t1: [maxX, minY, maxZ],
    t2: [maxX, maxY, maxZ],
    t3: [minX, maxY, maxZ],
  } as const

  const faces: Array<[keyof typeof vertices, keyof typeof vertices, keyof typeof vertices]> = [
    ['b0', 'b2', 'b1'], ['b0', 'b3', 'b2'],
    ['t0', 't1', 't2'], ['t0', 't2', 't3'],
    ['b0', 'b1', 't1'], ['b0', 't1', 't0'],
    ['b1', 'b2', 't2'], ['b1', 't2', 't1'],
    ['b2', 'b3', 't3'], ['b2', 't3', 't2'],
    ['b3', 'b0', 't0'], ['b3', 't0', 't3'],
  ]

  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const key of face) {
      lines.push(`      vertex ${vertices[key].join(' ')}`)
    }
    lines.push('    endloop')
    lines.push('  endfacet')
  }
}

function makeSteppedStlDataUrl(): string {
  const lines = ['solid stepped']
  addBoxFaces(lines, 0, 0, 0, 20, 10, 1)
  addBoxFaces(lines, 8, 3, 1, 12, 7, 4)
  lines.push('endsolid stepped')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makeTaperedStlDataUrl(): string {
  const lines = ['solid tapered']
  const vertices = {
    b0: [0, 0, 0],
    b1: [20, 0, 0],
    b2: [20, 10, 0],
    b3: [0, 10, 0],
    t0: [8, 3, 4],
    t1: [12, 3, 4],
    t2: [12, 7, 4],
    t3: [8, 7, 4],
  } as const
  const faces: Array<[keyof typeof vertices, keyof typeof vertices, keyof typeof vertices]> = [
    ['b0', 'b2', 'b1'], ['b0', 'b3', 'b2'],
    ['t0', 't1', 't2'], ['t0', 't2', 't3'],
    ['b0', 'b1', 't1'], ['b0', 't1', 't0'],
    ['b1', 'b2', 't2'], ['b1', 't2', 't1'],
    ['b2', 'b3', 't3'], ['b2', 't3', 't2'],
    ['b3', 'b0', 't0'], ['b3', 't0', 't3'],
  ]

  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const key of face) {
      lines.push(`      vertex ${vertices[key].join(' ')}`)
    }
    lines.push('    endloop')
    lines.push('  endfacet')
  }

  lines.push('endsolid tapered')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'tool1',
    name: '1 mm ball endmill',
    type: 'ball_endmill',
    diameter: 1,
    defaultStepdown: 1,
    defaultStepover: 1,
    maxCutDepth: 10,
  }
}

function makeModelFeature(): SketchFeature {
  return {
    id: 'model1',
    name: 'Stepped STL',
    kind: 'stl',
    stl: {
      format: 'stl',
      fileData: makeSteppedStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ]],
    },
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 20, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeTaperedModelFeature(): SketchFeature {
  return {
    ...makeModelFeature(),
    id: 'model1',
    name: 'Tapered STL',
    stl: {
      format: 'stl',
      fileData: makeTaperedStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ]],
    },
  }
}

function makeOperation(): Operation {
  return {
    id: 'finish1',
    name: 'Finish Surface',
    kind: 'finish_surface',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['model1'] },
    toolRef: 'tool1',
    stepdown: 1,
    stepover: 1,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'parallel',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'feature_first',
  }
}

function makeProject(): { project: Project; operation: Operation } {
  const project = {
    ...newProject('finish-surface-test', 'mm'),
    tools: [makeTool()],
    features: [makeModelFeature()],
  }
  return { project, operation: makeOperation() }
}

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'cut')
}

function makeProtectedAddFeature(): SketchFeature {
  return {
    id: 'boss1',
    name: 'Protected boss',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(2, 2, 4, 6),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeContainingSubtractFeature(): SketchFeature {
  return {
    id: 'pocket1',
    name: 'Containing pocket',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(-1, -1, 22, 12),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 4,
    z_bottom: 2,
    visible: true,
    locked: false,
  }
}

function makeRightHalfSubtractFeature(): SketchFeature {
  return {
    id: 'pocket2',
    name: 'Deeper right pocket',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, -1, 11, 12),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 4,
    z_bottom: 1,
    visible: true,
    locked: false,
  }
}

function pointInsideProtectedBoss(point: { x: number; y: number }): boolean {
  return point.x > 1.55 && point.x < 6.45 && point.y > 1.55 && point.y < 8.45
}

function testFinishSurfaceCoversLowerTopPlateau(): void {
  console.log('Testing finish_surface covers lower top plateau...')
  const { project, operation } = makeProject()
  const result = generateFinishSurfaceToolpath(project, operation)
  const lowPlateauCuts = cutMoves(result.moves).filter((move) => {
    const point = move.to
    return point.x > 1 && point.x < 7 && point.y > 1 && point.y < 9 && point.z <= 1.5
  })

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected finish surface cut moves')
  assert(lowPlateauCuts.length > 0, 'expected finish cuts on lower top plateau outside the high boss')
}

function testFinishSurfaceRepeatGenerationIsStable(): void {
  console.log('Testing finish_surface repeat generation is stable...')
  const { project, operation } = makeProject()
  const first = generateFinishSurfaceToolpath(project, operation)
  const second = generateFinishSurfaceToolpath(project, operation)

  assert(first.warnings.length === 0, `unexpected first warnings: ${first.warnings.join(', ')}`)
  assert(second.warnings.length === 0, `unexpected second warnings: ${second.warnings.join(', ')}`)
  assert(first.moves.length === second.moves.length, `expected repeat move count ${first.moves.length}, got ${second.moves.length}`)
  assert(cutMoves(second.moves).length > 0, 'expected repeated finish surface cut moves')
}

function testFinishSurfaceAvoidsSurroundingAddFeature(): void {
  console.log('Testing finish_surface avoids surrounding add feature footprints...')
  const { project, operation } = makeProject()
  project.features = [...project.features, makeProtectedAddFeature()]
  const result = generateFinishSurfaceToolpath(project, operation)
  const protectedCuts = cutMoves(result.moves).filter((move) => (
    pointInsideProtectedBoss(move.from) || pointInsideProtectedBoss(move.to)
  ))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected finish surface cut moves')
  assert(protectedCuts.length === 0, `expected no finish cuts inside protected add feature, got ${protectedCuts.length}`)
}

function testFinishSurfaceRespectsContainingPocketDepth(): void {
  console.log('Testing finish_surface respects containing subtract pocket depth...')
  const { project, operation } = makeProject()
  project.features = [makeContainingSubtractFeature(), ...project.features]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const minCutZ = Math.min(...cuts.map((move) => move.to.z))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected finish surface cut moves above containing pocket bottom')
  assert(minCutZ >= 2 - 1e-9, `expected no finish cuts below containing pocket bottom, got min Z ${minCutZ}`)
}

function testFinishSurfaceRespectsSplitPocketDepths(): void {
  console.log('Testing finish_surface respects split subtract pocket depths...')
  const { project, operation } = makeProject()
  project.features = [makeContainingSubtractFeature(), makeRightHalfSubtractFeature(), ...project.features]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const leftCutsBelowShallow = cuts.filter((move) => (
    (move.from.x < 10 - 1e-9 || move.to.x < 10 - 1e-9) &&
    (move.from.z < 2 - 1e-9 || move.to.z < 2 - 1e-9)
  ))
  const rightCutsBelowShallow = cuts.filter((move) => (
    move.from.x > 10 + 1e-9 && move.to.x > 10 + 1e-9 &&
    (move.from.z < 2 - 1e-9 || move.to.z < 2 - 1e-9)
  ))
  const minCutZ = Math.min(...cuts.map((move) => move.to.z))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected finish surface cut moves')
  assert(minCutZ >= 1 - 1e-9, `expected no finish cuts below deeper pocket bottom, got min Z ${minCutZ}`)
  assert(rightCutsBelowShallow.length > 0, 'expected finish cuts below shallow pocket bottom in deeper right pocket')
  assert(leftCutsBelowShallow.length === 0, `expected no finish cuts below shallow pocket bottom on left side, got ${leftCutsBelowShallow.length}`)
}

// ── Waterline tests ──────────────────────────────────────────────────────

function makeSquareContour(cx: number, cy: number, halfSize: number): ClipperPath {
  const points = [
    { x: cx - halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy + halfSize },
    { x: cx - halfSize, y: cy + halfSize },
  ]
  return toClipperPath(normalizeWinding(points, false), DEFAULT_CLIPPER_SCALE)
}

function testMaxContourGapIdenticalContours(): void {
  console.log('Testing maxContourGap with identical contours...')
  const contour = makeSquareContour(10, 10, 5)
  const gap = maxContourGap([contour], [contour])
  assert(gap < 0.01, `expected near-zero gap for identical contours, got ${gap}`)
}

function testMaxContourGapDifferentContours(): void {
  console.log('Testing maxContourGap with offset contours...')
  const contourA = makeSquareContour(10, 10, 5)
  const contourB = makeSquareContour(10, 10, 3)
  const gap = maxContourGap([contourA], [contourB])
  assert(gap > 1, `expected significant gap for different-size contours, got ${gap}`)
}

function testMaxContourGapEmptyReturnsThickness(): void {
  console.log('Testing maxContourGap with one empty path set...')
  const contour = makeSquareContour(10, 10, 5)
  const gap = maxContourGap([], [contour])
  // area = 10*10=100, perimeter = 40. gap = 2*100/40 = 5.
  assert(Math.abs(gap - 5) < 0.1, `expected thickness (~5) for one empty path, got ${gap}`)
}

function testWaterlineCumulativeShadowProtectsUpperLevels(): void {
  console.log('Testing waterline cumulative shadow protects upper levels...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)

  assert(cuts.length > 0, 'expected waterline cut moves')

  for (const move of cuts) {
    const minX = Math.min(move.from.x, move.to.x)
    const maxX = Math.max(move.from.x, move.to.x)
    const minY = Math.min(move.from.y, move.to.y)
    const maxY = Math.max(move.from.y, move.to.y)
    const z = move.to.z

    if (z < 1 - 1e-9) {
      const insideHighBoss = minX > 7.5 && maxX < 12.5 && minY > 2.5 && maxY < 7.5
      assert(!insideHighBoss,
        `waterline at z=${z.toFixed(3)} cuts inside the high boss area — cumulative shadow should prevent this`)
    }
  }
}

function makeWaterlineOperation(): Operation {
  return {
    ...makeOperation(),
    pocketPattern: 'waterline',
    stepover: 0.5,
  }
}

function testWaterlineGeneratesContourMoves(): void {
  console.log('Testing waterline generates contour cut moves...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected waterline contour cut moves')
}

function testWaterlineStepLevelsDescend(): void {
  console.log('Testing waterline step levels are descending...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  assert(result.stepLevels.length > 0, 'expected step levels')
  for (let i = 1; i < result.stepLevels.length; i += 1) {
    assert(result.stepLevels[i] <= result.stepLevels[i - 1],
      `expected descending step levels, got ${result.stepLevels[i - 1]} -> ${result.stepLevels[i]}`)
  }
}

function testWaterlineRepeatIsStable(): void {
  console.log('Testing waterline repeat generation is stable...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const first = generateFinishSurfaceToolpath(project, operation)
  const second = generateFinishSurfaceToolpath(project, operation)
  assert(first.moves.length === second.moves.length,
    `expected stable move count, first=${first.moves.length}, second=${second.moves.length}`)
}

function testWaterlineRespectsContainingPocketDepth(): void {
  console.log('Testing waterline respects containing subtract pocket depth...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.features = [makeContainingSubtractFeature(), ...project.features]
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const minCutZ = Math.min(...cuts.map((move) => Math.min(move.from.z, move.to.z)))
  assert(cuts.length > 0, 'expected waterline cut moves')
  assert(minCutZ >= 1.5 - 1e-9, `expected ball-endmill centerline no lower than pocket bottom minus radius, got min Z ${minCutZ}`)
}

function testWaterlineProjectedOffsetsProduceIntermediateRings(): void {
  console.log('Testing waterline projected offsets produce intermediate rings on sloped model...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.3,
    debugToolpath: true,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const coarseLevelCount = 4
  assert(result.stepLevels.length > coarseLevelCount,
    `projected offsets should produce more levels (${result.stepLevels.length}) than coarse Z levels (${coarseLevelCount}) — debug: ${result.warnings.join('; ')}`)
}

function testWaterlineIntermediateRingsHaveInterpolatedZ(): void {
  console.log('Testing waterline intermediate rings have Z values between coarse levels...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const coarseZs = new Set([2.5, 1.5, 0.5, -0.5])
  const intermediateZs = result.stepLevels.filter((z) => !coarseZs.has(z))
  assert(intermediateZs.length > 0, 'expected intermediate Z levels between coarse levels')
  for (const z of intermediateZs) {
    assert(z > -0.5 - 1e-9 && z < 3.5 + 1e-9,
      `intermediate centerline Z ${z} should be between bottom and top contact levels minus ball radius`)
  }
}

function testWaterlineBallEndmillUsesSideContactZ(): void {
  console.log('Testing waterline ball-endmill centerline Z is below waterline contact Z...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const cutZs = cuts.map((move) => move.to.z)
  const maxCutZ = Math.max(...cutZs)
  const minCutZ = Math.min(...cutZs)

  assert(cuts.length > 0, 'expected waterline cut moves')
  assert(Math.abs(maxCutZ - 2.5) < 1e-9, `expected top emitted centerline Z 2.5 for 3.0 contact Z and 0.5 radius, got ${maxCutZ}`)
  assert(Math.abs(minCutZ - -0.5) < 1e-9, `expected bottom emitted centerline Z -0.5 for 0.0 contact Z and 0.5 radius, got ${minCutZ}`)
}

function testWaterlineReachesModelTop(): void {
  console.log('Testing waterline reaches model top...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  operation.stepdown = 1
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const maxZ = Math.max(...result.stepLevels)
  const modelTopZ = 4.0

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  // With R=0.5, if we slice at 3.0, cutZ is 2.5.
  // If we don't slice at 4.0, the highest cut is 2.5.
  assert(maxZ >= modelTopZ - 0.1, `expected waterline to reach near model top ${modelTopZ}, got ${maxZ}`)
}

// ── Run all tests ────────────────────────────────────────────────────────

testFinishSurfaceCoversLowerTopPlateau()
testFinishSurfaceRepeatGenerationIsStable()
testFinishSurfaceAvoidsSurroundingAddFeature()
testFinishSurfaceRespectsContainingPocketDepth()
testFinishSurfaceRespectsSplitPocketDepths()

testMaxContourGapIdenticalContours()
testMaxContourGapDifferentContours()
testMaxContourGapEmptyReturnsThickness()
testWaterlineCumulativeShadowProtectsUpperLevels()

testWaterlineGeneratesContourMoves()
testWaterlineStepLevelsDescend()
testWaterlineRepeatIsStable()
testWaterlineRespectsContainingPocketDepth()
testWaterlineProjectedOffsetsProduceIntermediateRings()
testWaterlineIntermediateRingsHaveInterpolatedZ()
testWaterlineBallEndmillUsesSideContactZ()
testWaterlineReachesModelTop()

console.log('finishSurface tests passed')
