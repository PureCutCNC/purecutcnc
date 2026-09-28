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
 * Holes in an outside route's keep-outs (issue #914).
 *
 * A retained part was its outer outline: a subtract through it (a text
 * counter, a hole in a plate) never opened it, so a part the nester placed in
 * that hole had its whole wall path masked away and was silently never cut
 * free. And the lead and entry domain took every keep-out loop as a solid
 * island, so the hole of a closed ring of parts walled off the open air round
 * a route inside it and a helix fell back to a plunge with room to spare.
 *
 * Every assertion on the cutter is on its body — the tool centre plus its
 * radius — not on the centre alone.
 *
 * Run with: npx tsx src/engine/toolpaths/edgeKeepOutHoles.test.ts
 */

import { generateEdgeRouteToolpath } from './edge'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  circleProfile,
  defaultTool,
  polygonProfile,
  newProject,
  type Clamp,
  type Operation,
  type Point,
  type Project,
  type SketchFeature,
} from '../../types/project'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

const TOOL_DIAMETER = 6
const R = TOOL_DIAMETER / 2
const TOLERANCE = 0.01
const CENTRE = { x: 50, y: 50 }
/** A plate, a through-hole in it, and a part the nester put in the hole. */
const PLATE_R = 45
const HOLE_R = 30
const PART_R = 10

function circle(
  id: string,
  centre: { x: number; y: number },
  r: number,
  extra: Partial<SketchFeature> = {},
): SketchFeature {
  return {
    id, name: id, kind: 'circle', folderId: null,
    sketch: {
      profile: circleProfile(centre.x, centre.y, r),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'add', z_top: 0, z_bottom: -6, visible: true, locked: false,
    ...extra,
  }
}

function project(features: SketchFeature[], clamps: Clamp[] = []): Project {
  const tool = { ...defaultTool('mm', 1), id: 't1', name: 't1', diameter: TOOL_DIAMETER, defaultStepdown: 2 }
  return { ...projectWithFeatures({ ...newProject('keep-out-holes', 'mm'), tools: [tool] }, features), clamps }
}

function outsideOperation(target: string, overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op1', name: 'op', kind: 'edge_route_outside', pass: 'rough', enabled: true, showToolpath: true,
    debugToolpath: false, target: { source: 'features', featureIds: [target] }, toolRef: 't1',
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: false, finishFloor: false, carveDepth: 6, maxCarveDepth: 6,
    cutDirection: 'conventional', machiningOrder: 'feature_first', entryStrategy: 'plunge',
    ...overrides,
  } as Operation
}

const plate = () => circle('plate', CENTRE, PLATE_R)
const hole = (extra: Partial<SketchFeature> = {}) => circle('hole', CENTRE, HOLE_R, { operation: 'subtract', ...extra })
const part = () => circle('part', CENTRE, PART_R)

/** Every tool-centre point of a move below the top, sampled every 0.25 mm. */
function samplesBelowTop(moves: ToolpathMove[]): Array<Point & { z: number }> {
  return moves
    .filter((move) => move.kind !== 'rapid' && Math.min(move.from.z, move.to.z) < 0)
    .flatMap((move) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) / 0.25))
      return Array.from({ length: steps + 1 }, (_, step) => ({
        x: move.from.x + (move.to.x - move.from.x) * step / steps,
        y: move.from.y + (move.to.y - move.from.y) * step / steps,
        z: move.from.z + (move.to.z - move.from.z) * step / steps,
      }))
    })
    .filter((point) => point.z < 0)
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const codes = (result: { warnings: { code: string }[] }) => result.warnings.map((warning) => warning.code)
const cutCount = (moves: ToolpathMove[]) => moves.filter((move) => move.kind === 'cut').length

/** How far the cutter body stays inside the hole and off the part: both must be >= 0. */
function annulusClearance(samples: Point[]): { plate: number; part: number } {
  return {
    plate: Math.min(...samples.map((p) => HOLE_R - (distance(p, CENTRE) + R))),
    part: Math.min(...samples.map((p) => distance(p, CENTRE) - R - PART_R)),
  }
}

// ── A part in a through-hole is routed, off both walls ───────────────

for (const entryStrategy of ['plunge', 'helix'] as const) {
  const result = generateEdgeRouteToolpath(
    project([plate(), hole(), part()]),
    outsideOperation('part', { entryStrategy }),
  )
  const samples = samplesBelowTop(result.moves)
  assert(cutCount(result.moves) > 0, `${entryStrategy}: a part in a through-hole must be routed (no cut moves)`)
  const clearance = annulusClearance(samples)
  assert(
    clearance.plate >= -TOLERANCE,
    `${entryStrategy}: the cutter body reached ${(-clearance.plate).toFixed(3)} mm into the plate round the hole`,
  )
  assert(
    clearance.part >= -TOLERANCE,
    `${entryStrategy}: the cutter body reached ${(-clearance.part).toFixed(3)} mm into the part`,
  )
  assert(
    !codes(result).includes('edgeRouteBlockedByParts') && !codes(result).includes('entryStrategyFallback'),
    `${entryStrategy}: an unobstructed route warned ${JSON.stringify(codes(result))}`,
  )
  console.log(`  ✓ ${entryStrategy}: part in a hole routed, ${clearance.plate.toFixed(2)} mm off the plate`)
}

// ── Project order decides: a subtract before the plate is filled back in ──

{
  const result = generateEdgeRouteToolpath(
    project([hole(), plate(), part()]),
    outsideOperation('part'),
  )
  assert(
    cutCount(result.moves) === 0,
    'a plate added after the subtract fills the hole back in, so the part in it cannot be reached',
  )
  assert(
    codes(result).includes('edgeRouteBlockedByParts'),
    `a route the parts block entirely must say so; warnings ${JSON.stringify(codes(result))}`,
  )
  console.log('  ✓ a subtract before the plate opens nothing, and the blocked route warns')
}

// ── A counter shallower than the route opens only down to its floor ──

{
  // Opens the plate from its top to -3: levels -2 are clear, -4 and -6 are not.
  const result = generateEdgeRouteToolpath(
    project([plate(), hole({ z_bottom: -3 }), part()]),
    outsideOperation('part'),
  )
  const cutLevels = [...new Set(result.moves.filter((move) => move.kind === 'cut').map((move) => move.to.z))]
  assert(cutLevels.length > 0, 'the level the shallow hole opens must be cut')
  assert(
    cutLevels.every((z) => z >= -3),
    `the route cut at ${JSON.stringify(cutLevels)} — below the hole's floor at -3 the plate is solid`,
  )
  const deepInHole = samplesBelowTop(result.moves)
    .filter((p) => p.z < -3 - TOLERANCE && distance(p, CENTRE) + R > PART_R + TOLERANCE)
  assert(deepInHole.length === 0, `the cutter went below the hole's floor ${deepInHole.length} times`)
  assert(codes(result).includes('edgeRouteBlockedByParts'), 'the levels the plate still blocks must be reported')
  console.log(`  ✓ shallow hole: cut only at ${JSON.stringify(cutLevels)}`)
}

// ── A buried subtract opens nothing ──────────────────────────────────

{
  // It stops 2 mm below the plate's top, so the shank would pass through the
  // plate above it: the hole is not open to the cutter at any level.
  const result = generateEdgeRouteToolpath(
    project([plate(), hole({ z_top: -2 }), part()]),
    outsideOperation('part'),
  )
  assert(cutCount(result.moves) === 0, 'a subtract below the plate top must not open a path to the part')
  console.log('  ✓ buried subtract opens nothing')
}

// ── A part standing beside it in the same hole is still avoided ──────

{
  const neighbour = { x: CENTRE.x + 19, y: CENTRE.y, r: 4 }
  const result = generateEdgeRouteToolpath(
    project([plate(), hole(), part(), circle('neighbour', neighbour, neighbour.r)]),
    outsideOperation('part'),
  )
  const samples = samplesBelowTop(result.moves)
  assert(cutCount(result.moves) > 0, 'the part beside the neighbour must still be routed where it fits')
  const closest = Math.min(...samples.map((p) => distance(p, neighbour) - neighbour.r - R))
  assert(
    closest >= -TOLERANCE,
    `the cutter body reached ${(-closest).toFixed(3)} mm into a part standing in the same hole`,
  )
  assert(
    codes(result).includes('edgeRouteBlockedByParts'),
    `the span the neighbour blocks must be reported; warnings ${JSON.stringify(codes(result))}`,
  )
  console.log(`  ✓ neighbour in the hole kept ${closest.toFixed(3)} mm off, blocked span reported`)
}

// ── A neighbour's sharp corner keeps the cutter a radius off, no more ──

{
  // A diamond whose 90° tip points at the boss, one tool diameter plus 1 mm
  // from its edge. The cutter fits past it with 1 mm to spare. A mitred
  // keep-out pushed the tip out to r·√2 and cut the wall path short there.
  const boss = { x: 40, y: 40, r: 15 }
  const tipX = boss.x + boss.r + TOOL_DIAMETER + 1
  const diamond: Point[] = [
    { x: tipX, y: boss.y }, { x: tipX + 8, y: boss.y - 8 }, { x: tipX + 16, y: boss.y }, { x: tipX + 8, y: boss.y + 8 },
  ]
  const neighbour: SketchFeature = {
    ...circle('diamond', CENTRE, 1),
    kind: 'polygon',
    sketch: { ...circle('diamond', CENTRE, 1).sketch, profile: polygonProfile(diamond) },
  }
  const result = generateEdgeRouteToolpath(
    project([circle('boss', boss, boss.r), neighbour]),
    outsideOperation('boss'),
  )
  assert(
    !codes(result).includes('edgeRouteBlockedByParts'),
    `a corner the cutter clears must not cut the route short; warnings ${JSON.stringify(codes(result))}`,
  )
  const segmentDistance = (p: Point, a: Point, b: Point) => {
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2)))
    return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)))
  }
  const closest = Math.min(...samplesBelowTop(result.moves).map((p) => Math.min(
    ...diamond.map((a, index) => segmentDistance(p, a, diamond[(index + 1) % diamond.length])),
  ) - R))
  assert(closest >= -TOLERANCE, `the cutter body reached ${(-closest).toFixed(3)} mm into the diamond`)
  console.log(`  ✓ sharp neighbour corner: route whole, cutter body ${closest.toFixed(2)} mm off it`)
}

// ── A clamp that blocks the route is a clamp, not a part ─────────────

{
  const clamp: Clamp = {
    id: 'c1', name: 'c1', type: 'step_clamp', x: CENTRE.x + 20, y: CENTRE.y - 2, w: 6, h: 4, height: 10, visible: true,
  }
  // A part in the route's frame that blocks nothing, so the parts are in play.
  const result = generateEdgeRouteToolpath(
    project([circle('boss', CENTRE, 15), circle('bystander', { x: CENTRE.x, y: CENTRE.y + 35 }, 2)], [clamp]),
    outsideOperation('boss'),
  )
  assert(codes(result).includes('clampBlockedCut'), `the clamp must name itself; ${JSON.stringify(codes(result))}`)
  assert(
    !codes(result).includes('edgeRouteBlockedByParts'),
    'a route only a clamp blocks must not blame the parts',
  )
  console.log('  ✓ clamp-blocked route warns about the clamp only')
}

// ── Trochoidal: orbits stay in the hole ──────────────────────────────

{
  const result = generateEdgeRouteToolpath(
    project([plate(), hole(), part()]),
    outsideOperation('part', { edgeStrategy: 'trochoidal', entryStrategy: 'helix' }),
  )
  const samples = samplesBelowTop(result.moves)
  assert(samples.length > 0, `a trochoidal route in a hole must emit moves; ${JSON.stringify(codes(result))}`)
  const clearance = annulusClearance(samples)
  assert(
    clearance.plate >= -TOLERANCE,
    `a trochoidal orbit reached ${(-clearance.plate).toFixed(3)} mm into the plate round the hole`,
  )
  assert(clearance.part >= -TOLERANCE, `a trochoidal orbit reached ${(-clearance.part).toFixed(3)} mm into the part`)
  console.log(`  ✓ trochoidal in a hole: ${clearance.plate.toFixed(2)} mm off the plate`)
}

{
  // A neighbour across the trochoidal guide: its span is skipped, and said so.
  const neighbour = { x: CENTRE.x + 22, y: CENTRE.y, r: 4 }
  const result = generateEdgeRouteToolpath(
    project([circle('boss', CENTRE, 15), circle('neighbour', neighbour, neighbour.r)]),
    outsideOperation('boss', { edgeStrategy: 'trochoidal', entryStrategy: 'helix' }),
  )
  const samples = samplesBelowTop(result.moves)
  assert(samples.length > 0, `the trochoidal route must still cut where it fits; ${JSON.stringify(codes(result))}`)
  const closest = Math.min(...samples.map((p) => distance(p, neighbour) - neighbour.r - R))
  assert(closest >= -TOLERANCE, `a trochoidal orbit reached ${(-closest).toFixed(3)} mm into the neighbour`)
  assert(
    codes(result).includes('edgeRouteBlockedByParts'),
    `a trochoidal guide a part blocks must be reported; warnings ${JSON.stringify(codes(result))}`,
  )
  console.log(`  ✓ trochoidal beside a neighbour: kept ${closest.toFixed(2)} mm off, blocked span reported`)
}

// ── A helix inside a closed ring of parts ────────────────────────────

{
  // The ring's keep-outs overlap into one loop with a hole. The wall path sits
  // 18 mm from the boss centre; each ring part (r 3) grown by the tool radius
  // is a 6 mm island.
  const boss = { x: 40, y: 40, r: 15 }
  const ring = (gap: number) => {
    const d = 18 + gap + 6
    const count = Math.ceil(2 * Math.PI * d / 10)
    return Array.from({ length: count }, (_, index) => ({
      x: boss.x + d * Math.cos(2 * Math.PI * index / count),
      y: boss.y + d * Math.sin(2 * Math.PI * index / count),
      r: 3,
    }))
  }
  for (const gap of [8, 20]) {
    const parts = ring(gap)
    const result = generateEdgeRouteToolpath(
      project([circle('boss', boss, boss.r), ...parts.map((p, index) => circle(`r${index}`, p, p.r))]),
      outsideOperation('boss', { entryStrategy: 'helix' }),
    )
    const helix = result.moves.filter((move) => move.kind === 'lead_in')
    assert(helix.length > 0, `gap ${gap}: the helix must be placed inside a closed ring with room for it`)
    assert(
      !codes(result).includes('entryStrategyFallback'),
      `gap ${gap}: a closed ring with room must not fall back to a plunge`,
    )
    const closest = Math.min(...samplesBelowTop(helix).flatMap((p) => parts.map((q) => distance(p, q) - q.r - R)))
    assert(closest >= -TOLERANCE, `gap ${gap}: the helix reached ${(-closest).toFixed(3)} mm into a ring part`)
    console.log(`  ✓ closed ring, gap ${gap} mm: helix placed, ${closest.toFixed(2)} mm off the ring`)
  }
}
