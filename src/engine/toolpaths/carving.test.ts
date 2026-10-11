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
import { getOperationSafeZ, resolveFeatureZSpan } from './geometry'

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

function testDegenerateAdvance(): void {
  console.log('Testing a degenerate advance refuses by naming the advance...')

  const tool = makeFlatEndmill('t1', 4)

  // 0.000001 x D is 0.000004 mm of progress per orbit — the same arc traced over
  // and over. This is a defective parameter, and issue #662 separates it from the
  // point ceiling: on a 20 mm line it never comes close to the ceiling, so before
  // the degeneracy cap existed the only thing that could catch it was the guard
  // firing for the wrong reason with the wrong message.
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
  assert(result.moves.length === 0, 'a degenerate advance must produce zero moves')

  const warning = result.warnings.find((w) => w.code === 'carveTrochoidalAdvanceDegenerate')
  assert(warning !== undefined,
    `must name the advance, got [${result.warnings.map((w) => w.code).join(', ') || 'none'}]`)
  assert(!result.warnings.some((w) => w.code === 'carveTrochoidalMoveBudget'),
    'a degenerate advance must not be reported as an exhausted point ceiling')
  assert(typeof warning!.params?.x === 'number' && typeof warning!.params?.y === 'number',
    `degeneracy warning must carry numeric x,y params, got ${JSON.stringify(warning!.params)}`)
  assert(Number.isFinite(warning!.params!.x) && Number.isFinite(warning!.params!.y),
    'degeneracy warning params must be finite numbers')

  console.log('degenerate advance: PASSED')
}

function testBudgetExhaustion(): void {
  console.log('Testing budget exhaustion...')

  const tool = makeFlatEndmill('t1', 4)

  // A big job rather than a bad parameter: the advance is a legal 0.02 x D and
  // the channel is wide, so the orbit is finely stepped and a 400 mm line asks
  // for more points than one operation may hold. This is the branch the ceiling
  // is for, and it must stay distinct from the degeneracy cap above.
  const line = makeLineFeature('line1', 0, 0, 400, 0)
  const project = baseProject([tool], [line])
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1'] },
    toolRef: 't1',
    carveDepth: 1,
    carveStrategy: 'trochoidal',
    trochoidalCutWidth: 40,
    trochoidalAdvance: 0.02,
  })

  const result = generateFollowLineToolpath(project, op)
  assert(result.moves.length === 0, 'budget exhaustion must produce zero moves')

  const budgetWarning = result.warnings.find((w) =>
    w.code === 'carveTrochoidalMoveBudget' || w.code === 'carveTrochoidalEntryBudget')
  assert(budgetWarning !== undefined,
    `must emit a budget warning, got [${result.warnings.map((w) => w.code).join(', ') || 'none'}]`)
  assert(!result.warnings.some((w) => w.code === 'carveTrochoidalAdvanceDegenerate'),
    'a job that is merely too big must not be reported as a degenerate advance')
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

/**
 * Level sharing in the carve branch (issue #661).
 *
 * The carve guide is fragmented by the region mask alone, outside the level
 * loop, so nothing here is Z-dependent and every level is generated from the
 * identical guide. That is exactly the case the path store collapses, and the
 * consequence to guard is that every level still cuts the same XY: a signature
 * that handed back the wrong path would show up here as one level's geometry
 * differing from the rest.
 */
function testTrochoidalLevelsAreIdentical(): void {
  console.log('Testing multi-level trochoidal carve emits one path per level...')

  // Two guides, so the store has something to tell apart. With one guide every
  // level is identical whether or not sharing works, and the test proves
  // nothing.
  const tool = makeFlatEndmill('t1', 4)
  const project = baseProject([tool], [
    makeLineFeature('line1', 0, 0, 20, 0),
    makeLineFeature('line2', 0, 20, 20, 20),
  ])
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1', 'line2'] },
    toolRef: 't1',
    carveDepth: 4,
    maxCarveDepth: 4,
    stepdown: 0.5,
    carveStrategy: 'trochoidal',
    trochoidalCutWidth: 6,
    trochoidalAdvance: 0.2,
    entryStrategy: 'helix',
    entryRampAngle: 5,
  })

  const result = generateFollowLineToolpath(project, op)
  assert(result.warnings.length === 0,
    `multi-level carve warned: ${result.warnings.map((w) => w.code).join(', ')}`)

  const byLevel = new Map<string, string>()
  for (const move of cutMoves(result.moves)) {
    const key = move.to.z.toFixed(6)
    const step = `${move.from.x},${move.from.y}->${move.to.x},${move.to.y}`
    byLevel.set(key, `${byLevel.get(key) ?? ''}${step};`)
  }
  const levels = [...byLevel.keys()]
  assert(levels.length >= 5, `expected a multi-level carve, got ${levels.length} levels`)

  const first = byLevel.get(levels[0])!
  assert(first.length > 0, 'the first level must cut something')
  for (const level of levels.slice(1)) {
    assert(byLevel.get(level) === first,
      `level ${level} cut different XY from level ${levels[0]} — a shared path reached the wrong level`)
  }

  // Both guides must still be cut where they are. A key that cannot tell the
  // two apart machines one of them twice and never touches the other.
  const orbitRadius = (6 - 4) / 2
  const cutY = cutMoves(result.moves).map((move) => move.to.y)
  assert(cutY.some((y) => Math.abs(y) <= orbitRadius + 1e-6),
    'the guide at y=0 must be cut')
  assert(cutY.some((y) => Math.abs(y - 20) <= orbitRadius + 1e-6),
    'the guide at y=20 must be cut — a collided signature would cut y=0 twice instead')

  console.log('multi-level trochoidal carve: PASSED')
}

// ---------------------------------------------------------------------------
// Travel order (issue #1005)
// ---------------------------------------------------------------------------

/**
 * Two clusters of three short open lines, far enough apart that travel order
 * cannot mix them, listed the interleaved way a copy or nest adds its features:
 * A1, B1, A2, B2, A3, B3.
 */
function travelOrderFixture(): { project: Project; features: SketchFeature[]; ids: string[] } {
  const tool = makeFlatEndmill('t1', 4)
  const a = [
    makeLineFeature('a1', 0, 0, 10, 0),
    makeLineFeature('a2', 0, 10, 10, 10),
    makeLineFeature('a3', 0, 20, 10, 20),
  ]
  const b = [
    makeLineFeature('b1', 200, 0, 210, 0),
    makeLineFeature('b2', 200, 10, 210, 10),
    makeLineFeature('b3', 200, 20, 210, 20),
  ]
  const features = [a[0], b[0], a[1], b[1], a[2], b[2]]
  return { project: baseProject([tool], features), features, ids: features.map((f) => f.id) }
}

function travelOrderOp(ids: string[], strategy: 'direct' | 'trochoidal'): Operation {
  return makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ids },
    toolRef: 't1',
    carveDepth: 1,
    carveStrategy: strategy,
    ...(strategy === 'trochoidal' ? { trochoidalCutWidth: 6, trochoidalAdvance: 0.2 } : {}),
  })
}

/** Which cluster a cut belongs to, from its coordinates. */
function cutCluster(move: ToolpathMove): 'A' | 'B' {
  return move.from.x < 100 ? 'A' : 'B'
}

/** Cluster A must be finished before the first cut in cluster B. */
function assertClusterOrder(moves: ToolpathMove[], label: string): void {
  const cuts = cutMoves(moves)
  assert(cuts.length > 0, `${label}: expected cuts`)
  let seenB = false
  for (const move of cuts) {
    if (cutCluster(move) === 'B') {
      seenB = true
    } else {
      assert(!seenB, `${label}: cluster A must be finished before cluster B is touched`)
    }
  }
}

function moveKey(move: ToolpathMove): string {
  return JSON.stringify([
    move.kind,
    move.from.x, move.from.y, move.from.z,
    move.to.x, move.to.y, move.to.z,
    move.source ?? null,
  ])
}

/** Whether `needle` appears as a contiguous run inside `haystack`. */
function containsContiguous(haystack: ToolpathMove[], needle: ToolpathMove[]): boolean {
  if (needle.length === 0) return false
  const haystackKeys = haystack.map(moveKey)
  const needleKeys = needle.map(moveKey)
  for (let start = 0; start + needleKeys.length <= haystackKeys.length; start += 1) {
    let matches = true
    for (let index = 0; index < needleKeys.length; index += 1) {
      if (haystackKeys[start + index] !== needleKeys[index]) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}

function testEngraveOrdersTargetsByTravel(): void {
  console.log('Testing Engrave cuts targets in travel order (direct)...')

  const { project, ids } = travelOrderFixture()
  const result = generateFollowLineToolpath(project, travelOrderOp(ids, 'direct'))

  assert(result.warnings.length === 0,
    `unexpected warnings: ${result.warnings.map((w) => w.code).join(', ')}`)
  assertClusterOrder(result.moves, 'direct travel order')

  console.log('Engrave travel order (direct): PASSED')
}

function testEngraveOrdersTargetsByTravelTrochoidal(): void {
  console.log('Testing Engrave cuts targets in travel order (trochoidal)...')

  const { project, ids } = travelOrderFixture()
  const result = generateFollowLineToolpath(project, travelOrderOp(ids, 'trochoidal'))

  assert(result.warnings.length === 0,
    `unexpected warnings: ${result.warnings.map((w) => w.code).join(', ')}`)
  assertClusterOrder(result.moves, 'trochoidal travel order')

  console.log('Engrave travel order (trochoidal): PASSED')
}

function testEachTargetBlockMatchesStandalone(): void {
  console.log('Testing each target block matches its standalone generation...')

  const { project, ids } = travelOrderFixture()

  for (const strategy of ['direct', 'trochoidal'] as const) {
    const op = travelOrderOp(ids, strategy)
    const mergedCuts = cutMoves(generateFollowLineToolpath(project, op).moves)

    let total = 0
    for (const id of ids) {
      const singleCuts = cutMoves(generateFollowLineToolpath(project, {
        ...op,
        target: { source: 'features', featureIds: [id] },
      }).moves)
      assert(singleCuts.length > 0, `${strategy}/${id}: standalone generation must cut`)
      assert(containsContiguous(mergedCuts, singleCuts),
        `${strategy}/${id}: its cut moves must appear contiguously and unchanged in the merged result`)
      total += singleCuts.length
    }

    assert(total === mergedCuts.length,
      `${strategy}: merged cut count ${mergedCuts.length} must equal the sum of standalone targets ${total}`)
  }

  console.log('per-target block identity: PASSED')
}

function testTravelRapidsStayAtSafeZ(): void {
  console.log('Testing cross-target rapids stay at safe Z...')

  const { project, features, ids } = travelOrderFixture()
  const safeZ = getOperationSafeZ(project, features.map((f) => resolveFeatureZSpan(project, f)))

  for (const strategy of ['direct', 'trochoidal'] as const) {
    const result = generateFollowLineToolpath(project, travelOrderOp(ids, strategy))
    const travels = result.moves.filter((move) =>
      move.kind === 'rapid' && (move.from.x !== move.to.x || move.from.y !== move.to.y))
    assert(travels.length > 0, `${strategy}: expected XY rapids between targets`)
    for (const rapid of travels) {
      assert(rapid.from.z === safeZ && rapid.to.z === safeZ,
        `${strategy}: an XY rapid must start and end at safe Z ${safeZ}, got ${rapid.from.z} -> ${rapid.to.z}`)
    }
    // A trochoidal target has no closing retract: the next target emits it. A
    // target started from nowhere would leave a jump out of the cut instead of
    // an unsafe rapid, so the stream itself has to be unbroken.
    for (let index = 1; index < result.moves.length; index += 1) {
      const previous = result.moves[index - 1].to
      const next = result.moves[index].from
      assert(approx(previous.x, next.x) && approx(previous.y, next.y) && approx(previous.z, next.z),
        `${strategy}: move ${index} must start where move ${index - 1} ended`)
    }
  }

  console.log('cross-target rapids at safe Z: PASSED')
}

function testTargetWarningsKeepTargetOrder(): void {
  console.log('Testing per-target warnings keep target order when travel order differs...')

  const tool = makeFlatEndmill('t1', 4)
  // Target order is a1, far, near; travel order is a1, near, far. Both `far`
  // and `near` clamp, so the warnings prove which order they were harvested in.
  const features = [
    makeLineFeature('a1', 0, 0, 10, 0),
    makeLineFeature('far', 400, 0, 410, 0),
    makeLineFeature('near', 200, 0, 210, 0),
  ]
  const project = baseProject([tool], features)
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['a1', 'far', 'near'] },
    toolRef: 't1',
    carveDepth: 6, // deeper than z_top, so every target clamps at Z0
  })

  const result = generateFollowLineToolpath(project, op)
  const clamped = result.warnings
    .filter((warning) => warning.code === 'carveDepthClamped')
    .map((warning) => warning.params?.name)
  assert(clamped.length === 3, `expected three clamped targets, got [${clamped.join(', ')}]`)
  assert(clamped.join(',') === 'a1,far,near',
    `warnings must stay in target order, got [${clamped.join(', ')}]`)

  const cutOrder: string[] = []
  for (const move of cutMoves(result.moves)) {
    const id = move.from.x < 50 ? 'a1' : (move.from.x < 300 ? 'near' : 'far')
    if (cutOrder.at(-1) !== id) cutOrder.push(id)
  }
  assert(cutOrder.join(',') === 'a1,near,far',
    `cuts must be in travel order, got [${cutOrder.join(', ')}]`)

  console.log('per-target warning order: PASSED')
}

function testFirstTargetAndTieOrder(): void {
  console.log('Testing the first target stays first and exact ties keep target order...')

  const tool = makeFlatEndmill('t1', 4)
  // The first target is far from the origin, so passing an explicit start would
  // pick a follower first. The two followers are an exact tie from its end.
  const first = makeLineFeature('first', 200, 0, 210, 0)
  const second = makeLineFeature('second', 10, 20, 20, 20)
  const third = makeLineFeature('third', 10, -20, 20, -20)
  assert((200 ** 2 + 20 ** 2) === (200 ** 2 + (-20) ** 2),
    'the two followers must tie exactly for this test to mean anything')

  const project = baseProject([tool], [first, second, third])
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['first', 'second', 'third'] },
    toolRef: 't1',
    carveDepth: 1,
  })

  const order: string[] = []
  for (const move of cutMoves(generateFollowLineToolpath(project, op).moves)) {
    const id = move.from.x > 100 ? 'first' : (move.from.y > 0 ? 'second' : 'third')
    if (order.at(-1) !== id) order.push(id)
  }
  assert(order.join(',') === 'first,second,third',
    `first target must stay first and a tie must keep target order, got [${order.join(', ')}]`)

  console.log('first target and tie order: PASSED')
}

function testTargetWithNothingToCutKeepsOrder(): void {
  console.log('Testing a target with nothing to cut keeps order and still warns...')

  const tool = makeFlatEndmill('t1', 4)
  const a = makeLineFeature('a', 0, 0, 10, 0)
  const empty = makeLineFeature('empty', 50, 50, 50, 50)
  empty.sketch.profile.segments = []
  const b = makeLineFeature('b', 200, 0, 210, 0)

  const project = baseProject([tool], [a, empty, b])
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['a', 'empty', 'b'] },
    toolRef: 't1',
    carveDepth: 1,
  })

  const result = generateFollowLineToolpath(project, op)
  const emptyWarnings = result.warnings.filter((warning) => warning.code === 'carveNotEnoughGeometry')
  assert(emptyWarnings.length === 1 && emptyWarnings[0].params?.name === 'empty',
    `the empty target must still report carveNotEnoughGeometry, got [${result.warnings.map((w) => w.code).join(', ') || 'none'}]`)

  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'the two cutting targets must be cut')
  let seenB = false
  for (const move of cuts) {
    if (move.from.x > 100) {
      seenB = true
    } else {
      assert(!seenB, 'the two cutting targets must still be cut in travel order')
    }
  }

  console.log('empty target keeps order: PASSED')
}

function testOrderUsesBlockExit(): void {
  console.log('Testing the next target is chosen from the block exit, not its entry...')

  const tool = makeFlatEndmill('t1', 4)
  // `long` runs 200 mm to the right. `nearExit` is closer to its END than to
  // its start; `nearEntry` is the reverse. Ordering by start alone would pick
  // `nearEntry` after `long`.
  const long = makeLineFeature('long', 0, 0, 200, 0)
  const nearExit = makeLineFeature('nearExit', 190, 50, 200, 50)
  const nearEntry = makeLineFeature('nearEntry', 0, 50, 10, 50)

  const project = baseProject([tool], [long, nearExit, nearEntry])
  const op = makeCarveOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['long', 'nearExit', 'nearEntry'] },
    toolRef: 't1',
    carveDepth: 1,
  })

  const order: string[] = []
  for (const move of cutMoves(generateFollowLineToolpath(project, op).moves)) {
    const id = move.from.y > 0 ? (move.from.x > 100 ? 'nearExit' : 'nearEntry') : 'long'
    if (order.at(-1) !== id) order.push(id)
  }
  assert(order.join(',') === 'long,nearExit,nearEntry',
    `the block exit must choose the next target, got [${order.join(', ')}]`)

  console.log('order follows block exit: PASSED')
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
testDegenerateAdvance()
testBudgetExhaustion()
testCutDirectionParityOnOpenGuide()
testTrochoidalLevelsAreIdentical()
testEngraveOrdersTargetsByTravel()
testEngraveOrdersTargetsByTravelTrochoidal()
testEachTargetBlockMatchesStandalone()
testTravelRapidsStayAtSafeZ()
testTargetWarningsKeepTargetOrder()
testFirstTargetAndTieOrder()
testTargetWithNothingToCutKeepsOrder()
testOrderUsesBlockExit()

console.log('\ncarving tests passed.')
