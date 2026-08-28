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

import type { Operation, Point, Project, SketchFeature, Tool } from '../../types/project'
import { defaultTool, newProject } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import type { ToolpathMove } from './types'
import { generateFollowLineToolpath } from './carving'

// ---------------------------------------------------------------------------
// Minimal helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-9): boolean {
  return Math.abs(left - right) <= epsilon
}

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((m) => m.kind === 'cut')
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
    type: 'v_bit' as const,
    diameter: 6,
    vBitAngle: 60,
    defaultStepdown: 2,
    defaultStepover: 0.4,
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
        segments: [{ type: 'line' as const, to: { x: x2, y: y2 } }],
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

function makeClosedRectFeature(id: string, x: number, y: number, w: number, h: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: {
        start: { x, y },
        segments: [
          { type: 'line' as const, to: { x: x + w, y } },
          { type: 'line' as const, to: { x: x + w, y: y + h } },
          { type: 'line' as const, to: { x, y: y + h } },
          { type: 'line' as const, to: { x, y } },
        ],
        closed: true,
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

function makeRegionFeature(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  regionMaskMode?: 'include' | 'exclude',
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: {
        start: { x, y },
        segments: [
          { type: 'line' as const, to: { x: x + w, y } },
          { type: 'line' as const, to: { x: x + w, y: y + h } },
          { type: 'line' as const, to: { x, y: y + h } },
          { type: 'line' as const, to: { x, y } },
        ],
        closed: true,
      },
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

function baseProject(tools: Tool[], features: SketchFeature[]): Project {
  const project = newProject('test', 'mm')
  return projectWithFeatures({
    ...project,
    tools,
  }, features)
}

function makeCarveOp(
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

/** Signed area of an XY polygon (positive = CCW in screen coords). */
function signedArea(points: Point[]): number {
  let area = 0
  for (let i = 0; i < points.length; i += 1) {
    const j = (i + 1) % points.length
    area += points[i].x * points[j].y - points[j].x * points[i].y
  }
  return area / 2
}

/** Minimum distance from point p to any segment on the polyline. */
function pointToPolylineDist(p: Point, polyline: Point[], closed: boolean): number {
  let minDist = Infinity
  const n = closed ? polyline.length : polyline.length - 1
  for (let i = 0; i < n; i += 1) {
    const a = polyline[i]
    const b = polyline[(i + 1) % polyline.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const closestX = a.x + t * dx
    const closestY = a.y + t * dy
    const dist = Math.hypot(p.x - closestX, p.y - closestY)
    if (dist < minDist) minDist = dist
  }
  return minDist
}

/** Collect all unique XY points from cut moves (order preserved). */
function cutPoints(moves: ToolpathMove[]): Point[] {
  const cuts = cutMoves(moves)
  if (cuts.length === 0) return []
  const points: Point[] = [{ x: cuts[0].from.x, y: cuts[0].from.y }]
  for (const move of cuts) {
    points.push({ x: move.to.x, y: move.to.y })
  }
  return points
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testDirectModeRegression(): void {
  console.log('Testing direct-mode regression...')

  const tool = makeFlatEndmill('t1', 4)
  const line = makeLineFeature('line1', 0, 0, 20, 0)
  const project = baseProject([tool], [line])

  // carveStrategy unset (normalizes to 'direct')
  const opUnset = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1'] },
    toolRef: 't1',
    carveDepth: 1,
  })
  const resultUnset = generateFollowLineToolpath(project, opUnset)

  // carveStrategy explicitly 'direct'
  const opDirect = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1'] },
    toolRef: 't1',
    carveDepth: 1,
    carveStrategy: 'direct',
  })
  const resultDirect = generateFollowLineToolpath(project, opDirect)

  assert(resultUnset.moves.length === resultDirect.moves.length,
    `move count mismatch: ${resultUnset.moves.length} vs ${resultDirect.moves.length}`)
  assert(resultUnset.moves.length > 0, 'direct mode must produce moves')

  // Byte-identical: same moves, same order
  for (let i = 0; i < resultUnset.moves.length; i += 1) {
    const a = resultUnset.moves[i]
    const b = resultDirect.moves[i]
    assert(a.kind === b.kind,
      `move ${i} kind mismatch: ${a.kind} vs ${b.kind}`)
    assert(approx(a.from.x, b.from.x) && approx(a.from.y, b.from.y) && approx(a.from.z, b.from.z),
      `move ${i} from mismatch`)
    assert(approx(a.to.x, b.to.x) && approx(a.to.y, b.to.y) && approx(a.to.z, b.to.z),
      `move ${i} to mismatch`)
  }

  // The cut centreline matches the guide (tool follows the path at radius offset)
  const cuts = cutMoves(resultUnset.moves)
  assert(cuts.length > 0, 'direct mode must have cut moves')
  for (const move of cuts) {
    // Tool centre stays on the line y=0
    assert(approx(move.from.y, 0, 1e-6) && approx(move.to.y, 0, 1e-6),
      `direct mode cut must stay on guide centreline, got y=${move.from.y}`)
  }

  console.log('direct-mode regression: PASSED')
}

function testOpenGuideEntryAndExitOrbits(): void {
  console.log('Testing open-guide entry and exit orbits...')

  const tool = makeFlatEndmill('t1', 4)
  const line = makeLineFeature('line1', 0, 0, 20, 0)
  const project = baseProject([tool], [line])
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1'] },
    toolRef: 't1',
    carveDepth: 1,
    carveStrategy: 'trochoidal',
    trochoidalCutWidth: 6,
    trochoidalAdvance: 0.2,
  })

  const result = generateFollowLineToolpath(project, op)
  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'trochoidal open guide must produce cuts')

  const allPoints = cutPoints(result.moves)

  // Entry orbit: first several points should be within orbitRadius of the start
  const orbitRadius = (6 - 4) / 2 // (W - D) / 2 = 1
  const startX = 0
  const startY = 0
  const endX = 20
  const endY = 0

  // Find points near start (entry orbit) and near end (exit orbit)
  let entryOrbitPoints = 0
  let exitOrbitPoints = 0
  let midPoints = 0

  for (const p of allPoints) {
    const distToStart = Math.hypot(p.x - startX, p.y - startY)
    const distToEnd = Math.hypot(p.x - endX, p.y - endY)
    if (distToStart <= orbitRadius + 0.1) {
      entryOrbitPoints += 1
    } else if (distToEnd <= orbitRadius + 0.1) {
      exitOrbitPoints += 1
    } else {
      midPoints += 1
    }
  }

  assert(entryOrbitPoints >= 10, `expected >=10 entry orbit points, got ${entryOrbitPoints}`)
  assert(exitOrbitPoints >= 10, `expected >=10 exit orbit points, got ${exitOrbitPoints}`)
  assert(midPoints > 0, 'expected moving-orbit points along the guide')

  console.log('open-guide entry and exit orbits: PASSED')
}

function testClosedGuideSeam(): void {
  console.log('Testing closed-guide seam...')

  const tool = makeFlatEndmill('t1', 4)
  const rect = makeClosedRectFeature('rect1', 0, 0, 10, 10)
  const project = baseProject([tool], [rect])
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['rect1'] },
    toolRef: 't1',
    carveDepth: 1,
    carveStrategy: 'trochoidal',
    trochoidalCutWidth: 6,
    trochoidalAdvance: 0.2,
  })

  const result = generateFollowLineToolpath(project, op)
  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'trochoidal closed guide must produce cuts')

  // The first and last cut points must coincide (closed seam)
  const firstPoint = { x: cuts[0].from.x, y: cuts[0].from.y }
  const lastPoint = { x: cuts.at(-1)!.to.x, y: cuts.at(-1)!.to.y }
  assert(approx(firstPoint.x, lastPoint.x) && approx(firstPoint.y, lastPoint.y),
    `closed guide seam must close: first (${firstPoint.x}, ${firstPoint.y}) != last (${lastPoint.x}, ${lastPoint.y})`)

  console.log('closed-guide seam: PASSED')
}

function testSweptEnvelope(): void {
  console.log('Testing swept envelope...')

  const toolDiameter = 4
  const cutWidth = 7
  const orbitRadius = (cutWidth - toolDiameter) / 2 // 1.5
  const tool = makeFlatEndmill('t1', toolDiameter)
  const line = makeLineFeature('line1', 0, 0, 20, 0)
  const project = baseProject([tool], [line])
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1'] },
    toolRef: 't1',
    carveDepth: 1,
    carveStrategy: 'trochoidal',
    trochoidalCutWidth: cutWidth,
    trochoidalAdvance: 0.15,
  })

  const result = generateFollowLineToolpath(project, op)
  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'trochoidal must produce cuts')

  // Every cut point must be within cutWidth/2 of the guide
  const halfWidth = cutWidth / 2
  const guidePoints: Point[] = [{ x: 0, y: 0 }, { x: 20, y: 0 }]

  for (const move of cuts) {
    for (const p of [move.from, move.to]) {
      const dist = pointToPolylineDist(p, guidePoints, false)
      assert(dist <= halfWidth + 1e-6,
        `point (${p.x.toFixed(4)}, ${p.y.toFixed(4)}) is ${dist.toFixed(4)} from guide, max allowed ${halfWidth}`)
    }
  }

  // At least some points must be near the full orbit radius from the guide
  // (not just riding the centreline)
  let maxDist = 0
  for (const move of cuts) {
    for (const p of [move.from, move.to]) {
      const dist = pointToPolylineDist(p, guidePoints, false)
      if (dist > maxDist) maxDist = dist
    }
  }
  assert(maxDist >= orbitRadius - 0.1,
    `expected max distance ${orbitRadius} from guide, got ${maxDist.toFixed(4)}`)

  console.log('swept envelope: PASSED')
}

function testRegionIncludeExcludePolarity(): void {
  console.log('Testing region include/exclude polarity...')

  const toolDiameter = 4
  const cutWidth = 7
  const halfWidth = cutWidth / 2 // 3.5
  const tool = makeFlatEndmill('t1', toolDiameter)

  // A long horizontal line crossing through regions
  const line = makeLineFeature('line1', 0, 0, 30, 0)

  // Include region: x in [5, 15], y in [-10, 10]
  const includeRegion = makeRegionFeature('r_include', 5, -5, 10, 10, 'include')
  // Exclude region: x in [20, 25], y in [-10, 10]
  const excludeRegion = makeRegionFeature('r_exclude', 20, -5, 5, 10, 'exclude')

  const project = baseProject([tool], [line, includeRegion, excludeRegion])

  // Trochoidal with regions
  const opT = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1', 'r_include', 'r_exclude'] },
    toolRef: 't1',
    carveDepth: 1,
    carveStrategy: 'trochoidal',
    trochoidalCutWidth: cutWidth,
    trochoidalAdvance: 0.2,
  })
  const resultT = generateFollowLineToolpath(project, opT)
  const cutsT = cutMoves(resultT.moves)
  assert(cutsT.length > 0, 'trochoidal with regions must produce cuts')

  // Polarity check: trochoidal cuts must exist inside the include region
  // (proving the region didn't become an exclude), and must stay clear of
  // the exclude region (proving it didn't become an include).
  const hasCutsInInclude = cutsT.some((m) =>
    (m.from.x > 5 && m.from.x < 15) || (m.to.x > 5 && m.to.x < 15))
  assert(hasCutsInInclude, 'trochoidal cuts must exist inside include region [5, 15]')

  const hasCutsInExclude = cutsT.some((m) =>
    (m.from.x > 20 && m.from.x < 25) || (m.to.x > 20 && m.to.x < 25))
  assert(!hasCutsInExclude, 'trochoidal cuts must not enter exclude region [20, 25]')

  // The assertions that actually pin the region clearance, and the reason this
  // test exists.  A one-sided "stays roughly inside" bound is far too loose to
  // notice a wrong inset magnitude, so pin the tool centre on BOTH sides.
  //
  // A region bounds the guide, undilated, so:
  //
  //   include [5, 15] clips the guide at exactly 5 and 15
  //   the orbit carries the tool centre orbitRadius (1.5) past each end
  //     -> tool centre spans [3.5, 16.5]
  //   the cutter body reaches toolRadius (2.0) further -> [1.5, 18.5]
  //
  // so the cut overhangs the region by exactly the swept half-width, W/2 = 3.5,
  // the same way a pocket's tool sweeps its radius past the line it was clipped
  // to.  Dilate the region by the swept half-width instead and the tool centre
  // runs to 18.0 and the body to 20.0 — a full cut width past the boundary, and
  // the overhang that was visibly wrong on screen.
  //
  // The tolerance is the orbit sagitta, not an epsilon.  An orbit is emitted as
  // a polyline, so an extreme of the swept envelope is only hit exactly when a
  // step happens to land on it — under the old 36-step floor every orbit had a
  // step at phase pi, and this read exactly 3.5.  Issue #660 replaced that floor
  // with the sagitta bound the design contracts for (0.0022 x D, here 0.0088),
  // and at this fixture's radius the orbit takes an odd number of steps, so the
  // leftmost emitted point sits one sagitta inside the circle: 3.5088.
  //
  // Chords always fall *inside* the orbit, so this can only ever shorten the
  // reach past the region edge, never extend it.  A wrong inset magnitude — the
  // regression this test exists for — is off by the swept half-width, 3.5 mm,
  // some 400x this bound.
  const orbitRadius = (cutWidth - toolDiameter) / 2 // 1.5
  const toolRadius = toolDiameter / 2
  const sagitta = toolDiameter * 0.0022
  const centreMaxT = Math.max(...cutsT.flatMap((m) => [m.from.x, m.to.x]))
  const centreMinT = Math.min(...cutsT.flatMap((m) => [m.from.x, m.to.x]))
  assert(centreMaxT <= 15 + orbitRadius + 1e-6 && centreMaxT >= 15 + orbitRadius - sagitta,
    `trochoidal tool centre must stop at ${15 + orbitRadius} (include edge + orbit radius), got ${centreMaxT.toFixed(4)}`)
  assert(centreMinT >= 5 - orbitRadius - 1e-6 && centreMinT <= 5 - orbitRadius + sagitta,
    `trochoidal tool centre must start at ${5 - orbitRadius} (include edge − orbit radius), got ${centreMinT.toFixed(4)}`)
  assert(Math.abs((centreMaxT + toolRadius) - (15 + halfWidth)) <= sagitta + 1e-6,
    `trochoidal cutter body must overhang the include region by exactly the swept half-width ${halfWidth}`)

  // The exclude region is far enough away that the include edge binds first, so
  // the cut must not come near it at all.
  assert(centreMaxT + toolRadius <= 20 + 1e-6,
    `trochoidal cutter body reaches x=${(centreMaxT + toolRadius).toFixed(4)}, inside the exclude region starting at 20`)

  // Direct mode contrast: same fixture, should have different cut extent
  const opD = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1', 'r_include', 'r_exclude'] },
    toolRef: 't1',
    carveDepth: 1,
    carveStrategy: 'direct',
  })
  const resultD = generateFollowLineToolpath(project, opD)
  const cutsD = cutMoves(resultD.moves)
  assert(cutsD.length > 0, 'direct with regions must produce cuts')

  // Direct has no orbit, so its tool centre stops ON the region boundary and the
  // cut overhangs by exactly tool.radius. Same rule as trochoidal, different
  // swept half-width — which is the point: one region contract, two cut widths.
  const centreMaxD = Math.max(...cutsD.flatMap((m) => [m.from.x, m.to.x]))
  const centreMinD = Math.min(...cutsD.flatMap((m) => [m.from.x, m.to.x]))
  assert(Math.abs(centreMaxD - 15) <= 1e-6,
    `direct tool centre must stop on the include boundary 15, got ${centreMaxD.toFixed(4)}`)
  assert(Math.abs(centreMinD - 5) <= 1e-6,
    `direct tool centre must start on the include boundary 5, got ${centreMinD.toFixed(4)}`)
  assert(Math.abs((centreMaxD + toolRadius) - (15 + toolRadius)) <= 1e-6,
    'direct cutter body must overhang the include region by exactly the tool radius')

  // Trochoidal still sweeps wider than direct — the orbit, not the region clearance.
  assert(centreMaxT - centreMinT > centreMaxD - centreMinD,
    `trochoidal X span (${(centreMaxT - centreMinT).toFixed(4)}) must exceed direct (${(centreMaxD - centreMinD).toFixed(4)})`)

  console.log('region include/exclude polarity: PASSED')
}

function testCutWidthTooSmallFailsClosed(): void {
  console.log('Testing cutWidth < 1.15 * D fails closed...')

  const tool = makeFlatEndmill('t1', 4)
  const line = makeLineFeature('line1', 0, 0, 20, 0)
  const project = baseProject([tool], [line])
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1'] },
    toolRef: 't1',
    carveDepth: 1,
    carveStrategy: 'trochoidal',
    trochoidalCutWidth: 4.5, // < 4 * 1.15 = 4.6
    trochoidalAdvance: 0.1,
  })

  const result = generateFollowLineToolpath(project, op)
  assert(result.moves.length === 0, 'width too small must produce zero moves')
  assert(result.bounds === null, 'width too small must produce null bounds')
  assert(result.warnings.some((w) => w.code === 'carveTrochoidalWidthTooSmall'),
    'must warn carveTrochoidalWidthTooSmall')

  console.log('cutWidth too small fails closed: PASSED')
}

function testVBitFailsClosed(): void {
  console.log('Testing V-bit fails closed...')

  const vbit = makeVBit('v1')
  const line = makeLineFeature('line1', 0, 0, 20, 0)
  const project = baseProject([vbit], [line])

  // Trochoidal with V-bit → must fail
  const opT = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1'] },
    toolRef: 'v1',
    carveDepth: 1,
    carveStrategy: 'trochoidal',
    trochoidalCutWidth: 9,
    trochoidalAdvance: 0.1,
  })
  const resultT = generateFollowLineToolpath(project, opT)
  assert(resultT.moves.length === 0, 'V-bit trochoidal must produce zero moves')
  assert(resultT.warnings.some((w) => w.code === 'carveTrochoidalNeedsConstantDiameterTool'),
    'must warn carveTrochoidalNeedsConstantDiameterTool')

  // Same fixture in direct mode → must still generate moves
  const opD = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1'] },
    toolRef: 'v1',
    carveDepth: 1,
    carveStrategy: 'direct',
  })
  const resultD = generateFollowLineToolpath(project, opD)
  assert(resultD.moves.length > 0, 'V-bit direct mode must still produce moves')
  assert(!resultD.warnings.some((w) => w.code === 'carveTrochoidalNeedsConstantDiameterTool'),
    'direct mode must not emit trochoidal V-bit warning')

  console.log('V-bit fails closed: PASSED')
}

function testBudgetExhaustion(): void {
  console.log('Testing budget exhaustion...')

  const tool = makeFlatEndmill('t1', 4)

  // Create a very long line with tiny advance to blow the budget.
  // At 0.000001 advance and D=4, advance = 0.000004 mm per loop.
  // A 20mm line needs 5,000,000 loops → well past 500,000.
  const line = makeLineFeature('line1', 0, 0, 20, 0)
  const project = baseProject([tool], [line])
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1'] },
    toolRef: 't1',
    carveDepth: 1,
    carveStrategy: 'trochoidal',
    trochoidalCutWidth: 6,
    trochoidalAdvance: 0.000001,
  })

  const result = generateFollowLineToolpath(project, op)
  assert(result.moves.length === 0, 'budget exhaustion must produce zero moves')

  const budgetWarning = result.warnings.find((w) =>
    w.code === 'carveTrochoidalMoveBudget' || w.code === 'carveTrochoidalEntryBudget')
  assert(budgetWarning !== undefined, 'must emit a budget warning')
  assert(typeof budgetWarning!.params?.x === 'number' && typeof budgetWarning!.params?.y === 'number',
    `budget warning must carry numeric x,y params, got ${JSON.stringify(budgetWarning!.params)}`)
  assert(Number.isFinite(budgetWarning!.params!.x) && Number.isFinite(budgetWarning!.params!.y),
    'budget warning params must be finite numbers')

  console.log('budget exhaustion: PASSED')
}

function testCutDirectionParityOnOpenGuide(): void {
  console.log('Testing cut-direction parity on open guide...')

  const tool = makeFlatEndmill('t1', 4)
  const line = makeLineFeature('line1', 0, 0, 20, 0)
  const project = baseProject([tool], [line])

  function makeOp(dir: 'climb' | 'conventional'): Operation {
    return makeCarveOp({
      kind: 'follow_line',
      target: { source: 'features', featureIds: ['line1'] },
      toolRef: 't1',
      carveDepth: 1,
      carveStrategy: 'trochoidal',
      trochoidalCutWidth: 6,
      trochoidalAdvance: 0.2,
      cutDirection: dir,
    })
  }

  const resultClimb = generateFollowLineToolpath(project, makeOp('climb'))
  const resultConv = generateFollowLineToolpath(project, makeOp('conventional'))

  const climbPoints = cutPoints(resultClimb.moves)
  const convPoints = cutPoints(resultConv.moves)

  assert(climbPoints.length > 30, `climb needs enough points for orbit analysis, got ${climbPoints.length}`)
  assert(convPoints.length > 30, `conventional needs enough points for orbit analysis, got ${convPoints.length}`)

  // Extract the entry orbit (first ~36 points around the start).
  // An open guide's entry orbit is a full stationary circle at the start.
  // Points 0..35 should be the entry orbit.
  const entryOrbitLen = 36
  const climbEntry = climbPoints.slice(0, entryOrbitLen)
  const convEntry = convPoints.slice(0, entryOrbitLen)

  // Compute signed area of the entry orbit polygon.  Opposite cut directions
  // must produce opposite-signed entry orbits.
  const climbArea = signedArea(climbEntry)
  const convArea = signedArea(convEntry)

  assert(climbArea !== 0, 'climb entry orbit must have non-zero signed area')
  assert(convArea !== 0, 'conventional entry orbit must have non-zero signed area')
  assert(Math.sign(climbArea) !== Math.sign(convArea),
    `climb (${climbArea.toFixed(4)}) and conventional (${convArea.toFixed(4)}) must have opposite signs`)

  // The two paths must differ (not just the same path in reverse)
  const climbStr = JSON.stringify(climbPoints.slice(0, 5))
  const convStr = JSON.stringify(convPoints.slice(0, 5))
  assert(climbStr !== convStr, 'climb and conventional must produce different paths')

  console.log('cut-direction parity on open guide: PASSED')
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testDirectModeRegression()
testOpenGuideEntryAndExitOrbits()
testClosedGuideSeam()
testSweptEnvelope()
testRegionIncludeExcludePolarity()
testCutWidthTooSmallFailsClosed()
testVBitFailsClosed()
testBudgetExhaustion()
testCutDirectionParityOnOpenGuide()

console.log('\ncarving tests passed.')
