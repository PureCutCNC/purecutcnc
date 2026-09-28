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
 * An outside edge route's frame (issue #909).
 *
 * Every retained feature was an obstacle to every outside route, and the lead
 * and entry domain was boxed around all of them. Nested 15 times, a six-letter
 * sheet took minutes to generate: each part paid for every other part, and the
 * helix placement search gridded a box the size of the whole sheet. A route is
 * now framed by its own wall, so nothing outside that frame can change it —
 * which is both what makes it fast and what makes dropping far parts safe.
 *
 * Run with: npx tsx src/engine/toolpaths/edgeObstacleFrame.test.ts
 */

import { generateEdgeRouteToolpath } from './edge'
import { projectWithFeatures } from '../../test/projectFixtures'
import { cpuRatio } from '../../test/cpuRatio'
import {
  circleProfile,
  defaultTool,
  newProject,
  type Clamp,
  type Operation,
  type Point,
  type Project,
  type SketchFeature,
} from '../../types/project'

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error('Assertion failed: ' + message)
}

const TOOL_DIAMETER = 6
const BOSS = { x: 40, y: 40, r: 15 }
/**
 * A ring of small parts around the boss, the way a nest packs neighbours in.
 * Grown to tool-centre distance they stop 5 mm outside the wall path, which is
 * less than a full-radius helix or a 1 x D lead needs — so wherever the route
 * enters, a near part decides what fits.
 */
const NEAR = Array.from({ length: 12 }, (_, index) => ({
  x: BOSS.x + 29 * Math.cos(index * 2 * Math.PI / 12),
  y: BOSS.y + 29 * Math.sin(index * 2 * Math.PI / 12),
  r: 3,
}))

function circleFeature(id: string, centre: { x: number; y: number; r: number }): SketchFeature {
  return {
    id, name: id, kind: 'circle', folderId: null,
    sketch: {
      profile: circleProfile(centre.x, centre.y, centre.r),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    operation: 'add', z_top: 0, z_bottom: -6, visible: true, locked: false,
  }
}

/** A sheet of parts well away from the boss, the way a nest fills the rest of the stock. */
function farParts(count: number): SketchFeature[] {
  return Array.from({ length: count }, (_, index) => circleFeature(
    `far${index}`,
    { x: 200 + (index % 10) * 40, y: 20 + Math.floor(index / 10) * 40, r: 15 },
  ))
}

/**
 * Parts just beyond the outside domain's box but inside the obstacle frame, so
 * they survive the frame filter and reach the domain builder. The boss's wall
 * keep-out spans 22..58 and the box reaches 3.5 x D = 21 past it, to 1..79;
 * these sit with their keep-out (grown by the tool radius) wholly outside that.
 * They are what proves the box is set by the wall: box every keep-out loop and
 * they stretch it, and the helix search grids a different box.
 */
const EDGE_PARTS = [{ x: 85, y: 40 }, { x: -5, y: 40 }, { x: 40, y: 85 }, { x: 40, y: -5 }]
  .map((centre, index) => circleFeature(`edge${index}`, { ...centre, r: 2 }))

function edgeProject(features: SketchFeature[]): Project {
  const tool = { ...defaultTool('mm', 1), id: 't1', name: 't1', diameter: TOOL_DIAMETER, defaultStepdown: 2 }
  return projectWithFeatures({ ...newProject('edge-frame', 'mm'), tools: [tool] }, features)
}

const withNear = (extra: SketchFeature[] = []): Project => edgeProject([
  circleFeature('boss', BOSS),
  ...NEAR.map((centre, index) => circleFeature(`near${index}`, centre)),
  ...extra,
])

function outsideOperation(overrides: Partial<Operation>): Operation {
  return {
    id: 'op1', name: 'op', kind: 'edge_route_outside', pass: 'rough', enabled: true, showToolpath: true,
    debugToolpath: false, target: { source: 'features', featureIds: ['boss'] }, toolRef: 't1',
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: false, finishFloor: false, carveDepth: 6, maxCarveDepth: 6,
    cutDirection: 'conventional', machiningOrder: 'feature_first',
    ...overrides,
  } as Operation
}

const CASES: Array<{ name: string; overrides: Partial<Operation> }> = [
  { name: 'helix entry', overrides: { entryStrategy: 'helix' } },
  { name: 'helix entry + arc XY lead', overrides: { entryStrategy: 'helix', xyLeadStrategy: 'arc' } },
  { name: 'ramp entry + arc XY lead', overrides: { entryStrategy: 'ramp', xyLeadStrategy: 'arc' } },
]

const serialize = (project: Project, operation: Operation): string => {
  const result = generateEdgeRouteToolpath(project, operation)
  return JSON.stringify({ moves: result.moves, warnings: result.warnings })
}

// ── Far parts change nothing; near parts still shape the route ────────

for (const { name, overrides } of CASES) {
  const operation = outsideOperation(overrides)
  const nearOnly = serialize(withNear(), operation)
  const withFar = serialize(withNear([...EDGE_PARTS, ...farParts(40)]), operation)
  const bossAlone = serialize(edgeProject([circleFeature('boss', BOSS)]), operation)
  const entries = (JSON.parse(nearOnly) as { moves: { kind: string }[] }).moves
    .filter((move) => move.kind === 'lead_in').length

  assert(entries > 0, `${name}: the fixture must actually place entries (found none)`)
  // A route framed by all keep-out loops grids its helix search over a box that
  // grows with the far parts, and the placement moves with it.
  assert(
    withFar === nearOnly,
    `${name}: parts outside the route's frame changed its moves — `
    + 'the outside domain must be boxed by the wall it follows, not by every obstacle',
  )
  // And the frame must not be so tight that it drops what matters.
  assert(
    nearOnly !== bossAlone,
    `${name}: the parts beside the boss no longer shape its route — `
    + 'the obstacle frame is dropping obstacles that reach the wall path or its entries',
  )
  console.log(`  ✓ ${name}: far parts change nothing, near parts still shape it (${entries} entry moves)`)
}

// ── Every obstacle is grown, whichever stands highest ────────────────
//
// Feature and clamp obstacles are offset in one Clipper call, and Clipper
// orients the whole set by its topmost path. Features used to arrive wound one
// way and clamps the other, so a clamp standing highest shrank every
// neighbouring part and a part standing highest shrank every clamp. The
// cutter centre must stay a tool radius off each, in both arrangements.

function clamp(id: string, box: { x: number; y: number; w: number; h: number }): Clamp {
  return { id, name: id, type: 'step_clamp', ...box, height: 10, visible: true }
}

/** Cutting moves below the top, sampled every 0.25 mm. */
function cutSamples(project: Project): Point[] {
  const result = generateEdgeRouteToolpath(project, outsideOperation({ entryStrategy: 'plunge' }))
  return result.moves
    .filter((move) => move.kind === 'cut' && Math.max(move.from.z, move.to.z) < 0)
    .flatMap((move) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) / 0.25))
      return Array.from({ length: steps + 1 }, (_, step) => ({
        x: move.from.x + (move.to.x - move.from.x) * step / steps,
        y: move.from.y + (move.to.y - move.from.y) * step / steps,
      }))
    })
}

{
  // A part beside the boss whose grown outline crosses the wall path, and a
  // clamp standing far above everything: the clamp is the topmost path.
  const neighbour = { x: 61, y: 40, r: 3 }
  const project = {
    ...edgeProject([circleFeature('boss', BOSS), circleFeature('neighbour', neighbour)]),
    clamps: [clamp('high', { x: 30, y: 200, w: 20, h: 10 })],
  }
  const samples = cutSamples(project)
  const closest = Math.min(...samples.map((p) => Math.hypot(p.x - neighbour.x, p.y - neighbour.y) - neighbour.r))
  assert(samples.length > 0, 'the boss route must cut something')
  assert(
    closest >= TOOL_DIAMETER / 2 - 0.01,
    `with a clamp standing highest, the route came ${closest.toFixed(3)} mm from a neighbouring part `
    + `(tool radius ${TOOL_DIAMETER / 2}) — its keep-out was offset inward, not outward`,
  )
  console.log(`  ✓ clamp topmost: neighbouring part kept ${closest.toFixed(3)} mm off`)
}

{
  // A clamp beside the boss, across its wall path, and a part standing above
  // it inside the route's frame: that part is the topmost path.
  const box = { x: 56, y: 38, w: 4, h: 4 }
  const project = {
    ...edgeProject([circleFeature('boss', BOSS), circleFeature('above', { x: 40, y: 80, r: 2 })]),
    clamps: [clamp('beside', box)],
  }
  const samples = cutSamples(project)
  const outside = (p: Point) => Math.hypot(
    Math.max(box.x - p.x, 0, p.x - (box.x + box.w)),
    Math.max(box.y - p.y, 0, p.y - (box.y + box.h)),
  )
  const closest = Math.min(...samples.map(outside))
  assert(samples.length > 0, 'the boss route must cut something')
  assert(
    closest >= TOOL_DIAMETER / 2 - 0.01,
    `with a part standing highest, the route came ${closest.toFixed(3)} mm from a clamp `
    + `(tool radius ${TOOL_DIAMETER / 2}) — its keep-out was offset inward, not outward`,
  )
  console.log(`  ✓ part topmost: clamp kept ${closest.toFixed(3)} mm off`)
}

// ── Per-route cost does not grow with far parts ──────────────────────
//
// Subject: the boss beside its two near parts on a sheet of 80 far parts.
// Reference: the same route without the sheet — the far parts are the only
// difference, so the frame is the only thing that can close the gap.
//
// Measured on the development machine (plunge entry, six runs and three):
//   with the frame filter:     ratio 0.95-1.49
//   filter removed (mutation): ratio 7.90-8.96, reference column unchanged —
//                              every far part offset and split against at every level
//
// Re-measured after #914 boxed the guide split, which cut the route's own cost
// (the reference) by about half and so left the once-per-operation listing of
// the far parts a larger share of the subject:
//   with the frame filter:     ratio 0.93-2.33 standalone (ten runs), 3.85 once
//                              inside the parallel `npm run build` pool
//   filter removed (mutation): ratio 12.64-15.37 (three runs), reference 3.4-3.5ms
// Threshold at the geometric mid-point of the worst pair, sqrt(3.85 * 12.64) ~= 7.0.
{
  const operation = outsideOperation({ entryStrategy: 'plunge' })
  const subject = withNear(farParts(80))
  const reference = withNear()
  generateEdgeRouteToolpath(subject, operation)
  generateEdgeRouteToolpath(reference, operation)
  const { ratio, subjectMs, referenceMs } = cpuRatio(
    { run: () => { generateEdgeRouteToolpath(subject, operation) } },
    { run: () => { generateEdgeRouteToolpath(reference, operation) } },
  )
  console.log(
    `  80 far parts: ${subjectMs.toFixed(1)}ms CPU vs ${referenceMs.toFixed(1)}ms without them `
    + `(ratio ${ratio.toFixed(2)})`,
  )
  assert(
    ratio < 7.0,
    `an outside route on a sheet of 80 far parts costs ${ratio.toFixed(2)}x the same route alone `
    + `(limit 7.0x; ${subjectMs.toFixed(1)}ms vs ${referenceMs.toFixed(1)}ms CPU) — `
    + 'check that obstacles outside the route frame are dropped before the mask and domain are built',
  )
  console.log('  ✓ per-route cost does not grow with far parts')
}
