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
 * Clamps are avoided at generation time, not warned about afterwards (#458).
 *
 * Two assertions per generator, and the geometric one is the real test:
 *
 *  - **no cut or plunge move penetrates the checked keep-out**, measured by
 *    sampling each segment. A warning count alone would pass for a generator
 *    that emitted nothing at all.
 *  - **no `clampCrossed*` warning names a `cut` or `plunge` move.** This one is
 *    reachable only because generation clears the checked footprint by
 *    `CLAMP_KEEPOUT_EPSILON`: `segmentIntersectsRect2D` is inclusive on the
 *    boundary, so a path that stops exactly at the keep-out still counts as
 *    crossing it.
 *
 * Pre-fix penetrations on these fixtures, measured on main @ 055c1b4 — the
 * numbers any change to the keep-out has to keep moving off:
 *
 *   pocket 13.60mm · edge outside contour 12.00mm · edge outside trochoidal
 *   11.96mm · edge inside contour 12.00mm · edge inside trochoidal 11.96mm ·
 *   surface_clean 13.40mm · follow_line 13.90mm · v_carve 12.60mm ·
 *   v_carve_medial 13.00mm · drilling plunged straight into the hole.
 *
 * Run with: npx tsx src/engine/toolpaths/clampAvoidance.test.ts
 */

import type { Clamp, Operation, Project, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import type { ToolpathMove, ToolpathResult } from './types'
import { applyClampWarnings, clampCheckToolRadius, expandedClampBounds, worstCaseClampCheckToolRadius } from './clamps'
import { clampKeepOutPaths } from './modelProtection'
import { generatePocketToolpath } from './pocket'
import { generateEdgeRouteToolpath } from './edge'
import { generateVCarveToolpath } from './vcarve'
import { generateVCarveMedialToolpath } from './vcarveMedial'
import { generateSurfaceCleanToolpath } from './surface'
import { generateFollowLineToolpath } from './carving'
import { generateDrillingToolpath } from './drilling'
import { generateRoughSurfaceToolpath } from './roughSurface'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { hillsWaterlineProject } from '../../test/waterlineHillsFixture'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOOL_DIAMETER = 4

function endmill(): Tool {
  return { ...defaultTool('mm', 1), id: 't1', name: '4mm endmill', diameter: TOOL_DIAMETER, defaultStepdown: 2, defaultStepover: 0.4 }
}

function vbit(): Tool {
  return { ...defaultTool('mm', 1), id: 'v1', name: 'V-bit 60', type: 'v_bit', diameter: 6, vBitAngle: 60 }
}

function drill(): Tool {
  return { ...defaultTool('mm', 1), id: 'd1', name: '6mm drill', type: 'drill', diameter: 6 }
}

function rectFeature(
  id: string,
  operation: SketchFeature['operation'],
  x: number, y: number, w: number, h: number,
  zTop: number, zBottom: number,
): SketchFeature {
  return {
    id, name: id, kind: 'rect', folderId: null,
    sketch: { profile: rectProfile(x, y, w, h), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation, z_top: zTop, z_bottom: zBottom, visible: true, locked: false,
  }
}

function lineFeature(id: string, x1: number, y1: number, x2: number, y2: number): SketchFeature {
  return {
    id, name: id, kind: 'polygon', folderId: null,
    sketch: {
      profile: { start: { x: x1, y: y1 }, segments: [{ type: 'line', to: { x: x2, y: y2 } }], closed: false },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'subtract', z_top: 4, z_bottom: 0, visible: true, locked: false,
  }
}

function holeFeature(id: string, cx: number, cy: number, r: number): SketchFeature {
  return {
    id, name: id, kind: 'circle', folderId: null,
    sketch: { profile: circleProfile(cx, cy, r), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract', z_top: 0, z_bottom: -5, visible: true, locked: false,
  }
}

/** Tall enough that every cut level in these fixtures sits below its required Z. */
function clamp(id: string, name: string, x: number, y: number, w: number, h: number, height = 12): Clamp {
  return { id, name, type: 'step_clamp', x, y, w, h, height, visible: true }
}

function makeProject(features: SketchFeature[], tools: Tool[], clamps: Clamp[]): Project {
  const project = projectWithFeatures({ ...newProject('clamp-avoidance', 'mm'), tools }, features)
  project.clamps = clamps
  return project
}

function makeOperation(
  overrides: Partial<Operation> & Pick<Operation, 'kind' | 'target' | 'toolRef'>,
): Operation {
  return {
    id: 'op1', name: 'op', pass: 'rough', enabled: true, showToolpath: true,
    debugToolpath: false,
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, roundOutsideCorners: false,
    stockToLeaveRadial: 0, stockToLeaveAxial: 0, finishWalls: true, finishFloor: true,
    carveDepth: 1, maxCarveDepth: 1, cutDirection: 'conventional', machiningOrder: 'level_first',
    ...overrides,
  } as Operation
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Cut and plunge alike: `clamps.ts` can lift neither, so both are unfixable. */
function isCuttingMove(move: ToolpathMove): boolean {
  return move.kind !== 'rapid'
}

/**
 * The deepest any cutting move reaches INSIDE the checked keep-out, sampled
 * along each segment. Negative means the closest approach never reached it.
 *
 * Sampled rather than tested at the endpoints: a single long contour move can
 * pass clean through a clamp with both of its endpoints outside, which is
 * exactly what an endpoint-only check would score as zero.
 */
function deepestPenetration(project: Project, operation: Operation, moves: ToolpathMove[]): number {
  // The operation's own radius, which is the one `applyClampWarnings` checks
  // with. Measuring against anything else lets a generator whose only clearance
  // IS the tool radius pass a test that never applied it.
  const bounds = expandedClampBounds(project, clampCheckToolRadius(project, operation))
  let deepest = Number.NEGATIVE_INFINITY

  for (const move of moves) {
    if (!isCuttingMove(move)) continue
    for (const rect of bounds) {
      if (Math.min(move.from.z, move.to.z) >= rect.requiredZ) continue
      const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
      const steps = Math.max(2, Math.min(400, Math.ceil(length / 0.05)))
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps
        const x = move.from.x + (move.to.x - move.from.x) * t
        const y = move.from.y + (move.to.y - move.from.y) * t
        const inward = Math.min(x - rect.minX, rect.maxX - x, y - rect.minY, rect.maxY - y)
        if (inward > deepest) deepest = inward
      }
    }
  }
  return deepest
}

function crossingWarningsOnCuttingMoves(result: ToolpathResult): string[] {
  return result.warnings
    .filter((warning) => warning.code === 'clampCrossedOne' || warning.code === 'clampCrossedMany')
    .filter((warning) => warning.params?.moveKindId !== 'rapid')
    .map((warning) => `${warning.code} ${JSON.stringify(warning.params)}`)
}

function expectAvoidsClamps(
  label: string,
  project: Project,
  operation: Operation,
  raw: ToolpathResult,
): void {
  const result = applyClampWarnings(project, raw, operation)
  const cuts = result.moves.filter(isCuttingMove)
  assert(cuts.length > 0, `${label}: expected cutting moves, warnings ${JSON.stringify(result.warnings)}`)

  const crossings = crossingWarningsOnCuttingMoves(result)
  assert(crossings.length === 0, `${label}: clampCrossed on a cutting move — ${crossings.join('; ')}`)

  const deepest = deepestPenetration(project, operation, result.moves)
  assert(
    deepest < 0,
    `${label}: a cutting move reached ${deepest.toFixed(4)} inside the checked clamp keep-out`,
  )

  // Avoiding the clamp silently is its own defect: the user sees a gap in the
  // floor and no reason for it. Every fixture here puts the clamp ON the cut, so
  // every one of them must say so.
  const blocked = result.warnings.filter((warning) => warning.code === 'clampBlockedCut')
  assert(blocked.length === 1, `${label}: expected one clampBlockedCut, got ${JSON.stringify(result.warnings)}`)
  assert(blocked[0].params?.name === 'Clamp 1', `${label}: the warning must name the clamp`)

  console.log(`  ${label.padEnd(32)} ${cuts.length} cutting moves, closest approach ${(-deepest).toFixed(4)} clear, reported`)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testGeneratorsAvoidClamps(): void {
  console.log('Testing generators avoid clamps at generation time...')

  {
    const project = makeProject(
      [rectFeature('pk', 'subtract', 10, 10, 100, 100, 0, -6)],
      [endmill()],
      [clamp('c1', 'Clamp 1', 40, 50, 20, 20)],
    )
    const operation = makeOperation({ kind: 'pocket', target: { source: 'features', featureIds: ['pk'] }, toolRef: 't1' })
    expectAvoidsClamps('pocket', project, operation, generatePocketToolpath(project, operation))
  }

  {
    // The clamp straddles the right wall of the boss the route runs around.
    const project = makeProject(
      [rectFeature('boss', 'add', 30, 30, 60, 60, 0, -6)],
      [endmill()],
      [clamp('c1', 'Clamp 1', 80, 50, 20, 20)],
    )
    const contour = makeOperation({
      kind: 'edge_route_outside', target: { source: 'features', featureIds: ['boss'] },
      toolRef: 't1', edgeStrategy: 'contour',
    })
    expectAvoidsClamps('edge_route_outside contour', project, contour, generateEdgeRouteToolpath(project, contour))

    const trochoidal = makeOperation({
      kind: 'edge_route_outside', target: { source: 'features', featureIds: ['boss'] },
      toolRef: 't1', edgeStrategy: 'trochoidal', trochoidalCutWidth: 6, trochoidalAdvance: 0.1, entryStrategy: 'helix',
    })
    expectAvoidsClamps('edge_route_outside trochoidal', project, trochoidal, generateEdgeRouteToolpath(project, trochoidal))
  }

  {
    // The clamp straddles the right wall of the cavity the route runs around.
    const project = makeProject(
      [rectFeature('cav', 'subtract', 10, 10, 100, 100, 0, -6)],
      [endmill()],
      [clamp('c1', 'Clamp 1', 100, 50, 20, 20)],
    )
    const contour = makeOperation({
      kind: 'edge_route_inside', target: { source: 'features', featureIds: ['cav'] },
      toolRef: 't1', edgeStrategy: 'contour',
    })
    expectAvoidsClamps('edge_route_inside contour', project, contour, generateEdgeRouteToolpath(project, contour))

    const trochoidal = makeOperation({
      kind: 'edge_route_inside', target: { source: 'features', featureIds: ['cav'] },
      toolRef: 't1', edgeStrategy: 'trochoidal', trochoidalCutWidth: 6, trochoidalAdvance: 0.1, entryStrategy: 'helix',
    })
    expectAvoidsClamps('edge_route_inside trochoidal', project, trochoidal, generateEdgeRouteToolpath(project, trochoidal))
  }

  {
    const project = makeProject(
      [rectFeature('sc', 'add', 5, 5, 110, 110, 0, -2)],
      [endmill()],
      [clamp('c1', 'Clamp 1', 40, 50, 20, 20)],
    )
    const operation = makeOperation({ kind: 'surface_clean', target: { source: 'features', featureIds: ['sc'] }, toolRef: 't1' })
    expectAvoidsClamps('surface_clean', project, operation, generateSurfaceCleanToolpath(project, operation))
  }

  {
    const project = makeProject(
      [lineFeature('ln', 5, 60, 115, 60)],
      [endmill()],
      [clamp('c1', 'Clamp 1', 40, 50, 20, 20)],
    )
    const operation = makeOperation({
      kind: 'follow_line', target: { source: 'features', featureIds: ['ln'] }, toolRef: 't1', carveDepth: 3,
    })
    expectAvoidsClamps('follow_line', project, operation, generateFollowLineToolpath(project, operation))
  }

  {
    // The clamp straddles the carved boundary at x = 20.
    const project = makeProject(
      [rectFeature('vc', 'subtract', 20, 20, 80, 80, 0, -3)],
      [vbit()],
      [clamp('c1', 'Clamp 1', 12, 40, 16, 20)],
    )
    const offset = makeOperation({
      kind: 'v_carve', target: { source: 'features', featureIds: ['vc'] }, toolRef: 'v1',
      carveDepth: 2, maxCarveDepth: 2,
    })
    expectAvoidsClamps('v_carve', project, offset, generateVCarveToolpath(project, offset))

  }

  {
    // The medial route needs its own clamp: a true medial axis runs down the
    // shape's spine, so a clamp at the edge the offset V-carve hits is one the
    // medial path never approaches even unprotected — the test would pass
    // without testing anything. On the spine it reaches 13.0mm in unprotected.
    const project = makeProject(
      [rectFeature('vc', 'subtract', 20, 20, 80, 80, 0, -3)],
      [vbit()],
      [clamp('c1', 'Clamp 1', 52, 52, 16, 16)],
    )
    const medial = makeOperation({
      kind: 'v_carve_medial', target: { source: 'features', featureIds: ['vc'] }, toolRef: 'v1',
      carveDepth: 2, maxCarveDepth: 2,
    })
    expectAvoidsClamps('v_carve_medial', project, medial, generateVCarveMedialToolpath(project, medial))
  }

  console.log('generators avoid clamps: PASSED')
}

function testMeshGeneratorsAvoidClamps(): void {
  console.log('Testing the mesh generators avoid clamps...')

  // These two were already clamp-aware through `buildProtectedFootprintPaths`
  // before #458 — they are here because #458 changed what that keep-out is:
  // it now clears the checked footprint by CLAMP_KEEPOUT_EPSILON, and it is
  // filtered by Z. Before the epsilon, a waterline finish whose deepest
  // penetration was 0.0000 still raised 840 `clampCrossed*` warnings by running
  // exactly along the boundary of an inclusive test.
  const hillsClamp = clamp('c1', 'Clamp 1', 20, 20, 15, 15, 30)

  {
    const { project, operation } = hillsWaterlineProject({ cell: 3, toolDiameter: 3 })
    project.clamps = [hillsClamp]
    expectAvoidsClamps('finish_surface waterline', project, operation, generateFinishSurfaceToolpath(project, operation))
  }

  {
    const { project, operation } = hillsWaterlineProject({ cell: 3, toolDiameter: 3 })
    project.clamps = [hillsClamp]
    const rough: Operation = {
      ...operation, id: 'rough', kind: 'rough_surface', pass: 'rough',
      pocketPattern: 'offset', stepdown: 2, stepover: 0.4,
    }
    project.operations = [rough]
    expectAvoidsClamps('rough_surface', project, rough, generateRoughSurfaceToolpath(project, rough))
  }

  console.log('mesh generators avoid clamps: PASSED')
}

function testDrillingSkipsHoleUnderClamp(): void {
  console.log('Testing drilling skips a hole under a clamp...')

  const project = makeProject(
    [holeFeature('hole', 50, 60, 3)],
    [drill()],
    [clamp('c1', 'Clamp 1', 40, 50, 20, 20)],
  )
  const operation = makeOperation({ kind: 'drilling', target: { source: 'features', featureIds: ['hole'] }, toolRef: 'd1' })
  const result = applyClampWarnings(project, generateDrillingToolpath(project, operation), operation)

  // Every move drilling emits is a rapid, a plunge or a retract, and clamps.ts
  // can lift only a rapid — so the hole has to be dropped before generation,
  // not warned about after it.
  assert(
    result.moves.every((move) => !isCuttingMove(move)),
    'a hole under a clamp must not be plunged',
  )
  const skipped = result.warnings.find((warning) => warning.code === 'drillSkippedUnderClamp')
  assert(skipped !== undefined, `expected drillSkippedUnderClamp, got ${JSON.stringify(result.warnings)}`)
  assert(skipped?.params?.clamp === 'Clamp 1', 'the warning names the clamp that blocked the hole')

  console.log('drilling skips a hole under a clamp: PASSED')
}

function testClampBelowTheCutLevelDoesNotConstrain(): void {
  console.log('Testing a clamp shorter than the cut level does not constrain it...')

  // requiredZ = height 1 + clearanceZ. A pocket floor at z = 8 is above it, so
  // the clamp is not in the way and the domain must be untouched.
  const project = makeProject([rectFeature('pk', 'subtract', 10, 10, 100, 100, 10, 8)], [endmill()], [])
  const shortClamp = clamp('c1', 'Short clamp', 40, 50, 20, 20, 1)
  const operation = makeOperation({ kind: 'pocket', target: { source: 'features', featureIds: ['pk'] }, toolRef: 't1' })

  const withoutClamp = generatePocketToolpath(project, operation)
  project.clamps = [shortClamp]
  const withClamp = generatePocketToolpath(project, operation)

  assert(
    JSON.stringify(withClamp.moves) === JSON.stringify(withoutClamp.moves),
    'a clamp entirely below the cut level must not change the toolpath',
  )
  assert(
    clampKeepOutPaths(project, { z: 8, expansion: 2 }).length === 0,
    'the keep-out is empty at a level above the clamp',
  )
  assert(
    clampKeepOutPaths(project, { z: 0, expansion: 2 }).length > 0,
    'the keep-out is present at a level below the clamp',
  )

  console.log('clamp below the cut level does not constrain: PASSED')
}

function testDistantClampIsNotReported(): void {
  console.log('Testing a clamp clear of the cut is not reported...')

  // Same pocket, clamp moved well outside it. A warning here would be worse than
  // no warning: "material is left uncut" about material that was fully cut
  // teaches the user to ignore the message.
  const project = makeProject(
    [rectFeature('pk', 'subtract', 10, 10, 100, 100, 0, -6)],
    [endmill()],
    [clamp('c1', 'Clamp 1', 200, 200, 20, 20)],
  )
  const operation = makeOperation({ kind: 'pocket', target: { source: 'features', featureIds: ['pk'] }, toolRef: 't1' })
  const result = applyClampWarnings(project, generatePocketToolpath(project, operation), operation)

  assert(
    !result.warnings.some((warning) => warning.code === 'clampBlockedCut'),
    `a clamp clear of the cut must not be reported, got ${JSON.stringify(result.warnings)}`,
  )
  assert(result.moves.filter(isCuttingMove).length > 0, 'the pocket still cuts')

  console.log('distant clamp is not reported: PASSED')
}

function testNoClampsCostsNothing(): void {
  console.log('Testing a project with no visible clamp is untouched...')

  const project = makeProject([rectFeature('pk', 'subtract', 10, 10, 100, 100, 0, -6)], [endmill()], [])
  assert(clampKeepOutPaths(project, { expansion: 2 }).length === 0, 'no clamps means no keep-out')

  project.clamps = [{ ...clamp('c1', 'Hidden', 40, 50, 20, 20), visible: false }]
  assert(clampKeepOutPaths(project, { expansion: 2 }).length === 0, 'a hidden clamp means no keep-out')

  console.log('no clamps costs nothing: PASSED')
}

function testTravelLimitStillWarns(): void {
  console.log('Testing clampTravelLimitExceeded still warns...')

  // Driven straight at `applyClampWarnings` rather than through a generator: now
  // that generation avoids clamps, a generator no longer produces a move that
  // reaches this path, and the point of the test is that the path is still there
  // for the case generation cannot fix — a rapid over a clamp the machine cannot
  // travel above.
  const project = makeProject([rectFeature('pk', 'subtract', 10, 10, 100, 100, 0, -6)], [endmill()], [])
  project.clamps = [clamp('c1', 'Tall clamp', 40, 50, 20, 20, 500)]
  project.meta = { ...project.meta, maxTravelZ: 10 }

  const operation = makeOperation({ kind: 'pocket', target: { source: 'features', featureIds: ['pk'] }, toolRef: 't1' })
  const crossing: ToolpathMove = {
    kind: 'rapid',
    from: { x: 0, y: 60, z: 5 },
    to: { x: 120, y: 60, z: 5 },
  }
  const result = applyClampWarnings(
    project,
    { operationId: operation.id, moves: [crossing], warnings: [], bounds: null },
    operation,
  )

  const travelLimit = result.warnings.find((warning) => warning.code === 'clampTravelLimitExceeded')
  assert(travelLimit !== undefined, `expected clampTravelLimitExceeded, got ${JSON.stringify(result.warnings)}`)
  assert(travelLimit?.params?.maxZ === '10.000', 'the warning reports the machine travel limit')
  assert(
    result.moves.every((move) => move.to.z <= 10 + 1e-9 && move.from.z <= 10 + 1e-9),
    'no move is emitted above the machine travel limit to clear the clamp',
  )

  console.log('clampTravelLimitExceeded still warns: PASSED')
}

function testCheckedFootprintIsBiggerThanTheClamp(): void {
  console.log('Testing the drawn footprint matches the checked one...')

  const project = makeProject([rectFeature('pk', 'subtract', 10, 10, 100, 100, 0, -6)], [endmill()], [clamp('c1', 'Clamp 1', 40, 50, 20, 20)])
  project.operations = [makeOperation({ kind: 'pocket', target: { source: 'features', featureIds: ['pk'] }, toolRef: 't1' })]

  const radius = worstCaseClampCheckToolRadius(project)
  assert(radius === TOOL_DIAMETER / 2, `worst-case radius should be the widest enabled tool's, got ${radius}`)

  const [bounds] = expandedClampBounds(project, radius)
  const grown = project.meta.clampClearanceXY + radius
  assert(Math.abs(bounds.minX - (40 - grown)) < 1e-9, 'checked footprint carries clearance + tool radius')
  assert(bounds.maxX - bounds.minX > 20, 'the checked footprint is visibly larger than the 20mm clamp')

  project.operations = [{ ...project.operations[0], enabled: false }]
  assert(worstCaseClampCheckToolRadius(project) === 0, 'a disabled operation is never checked, so it sets no radius')

  console.log('drawn footprint matches the checked one: PASSED')
}

testGeneratorsAvoidClamps()
testMeshGeneratorsAvoidClamps()
testDrillingSkipsHoleUnderClamp()
testClampBelowTheCutLevelDoesNotConstrain()
testDistantClampIsNotReported()
testNoClampsCostsNothing()
testTravelLimitStillWarns()
testCheckedFootprintIsBiggerThanTheClamp()

console.log('clamp avoidance tests passed')
