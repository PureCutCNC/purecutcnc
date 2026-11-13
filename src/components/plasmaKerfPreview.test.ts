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
 * The plasma kerf-preview model (issue #961, slice A).
 *
 * The two properties that matter are pinned against a *real* generated plasma
 * toolpath, not a hand-built one: the kerf width equals the torch diameter, and
 * the band's edge (the contour centre path offset by half the width) lands on
 * the drawn part line — the same coincidence `plasma.test.ts` pins for the
 * generator, so a preview that drifted from the engine would fail here.
 *
 * Mutations these assertions were checked against:
 * - halving the width in `plasmaKerfWidth` → every width assertion fails;
 * - dropping the `lead_in`/`lead_out` branch from `plasmaKerfGeometry` → the
 *   torch-on count and the band's lead geometry fail;
 * - dropping the `plasma_profile` guard from `plasmaKerfWidth` → a milling
 *   operation no longer reads null.
 *
 * Run with: npx tsx src/components/plasmaKerfPreview.test.ts
 */

import assert from 'node:assert/strict'
import { generatePlasmaProfileToolpath } from '../engine/toolpaths/plasma'
import type { ToolpathMove, ToolpathResult } from '../engine/toolpaths/types'
import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { defaultPlasmaTool } from '../toolPolicy'
import { projectWithFeatures } from '../test/projectFixtures'
import { defaultTool, newProject, type Operation, type Project, type SketchFeature, type SketchProfile } from '../types/project'
import { convertLength, convertToolUnits } from '../utils/units'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import { plasmaKerfGeometry, plasmaKerfWidth } from './plasmaKerfPreview'

interface PointLike { x: number; y: number }

function square(x: number, y: number, w: number, h = w): SketchProfile {
  return {
    start: { x, y },
    segments: [
      { type: 'line', to: { x: x + w, y } },
      { type: 'line', to: { x: x + w, y: y + h } },
      { type: 'line', to: { x, y: y + h } },
      { type: 'line', to: { x, y } },
    ],
    closed: true,
  }
}

function feature(id: string, operation: SketchFeature['operation'], profile: SketchProfile = square(20, 20, 60)): SketchFeature {
  return {
    id, name: id, kind: 'rect', operation, folderId: null, visible: true, locked: false, z_top: 6, z_bottom: 0,
    sketch: { profile, dimensions: [], constraints: [], origin: { x: 0, y: 0 }, orientationAngle: 0 },
  }
}

function fixture(features: SketchFeature[] = [feature('part', 'add')]): Project {
  const project = newProject('Plasma fixture', 'mm')
  project.stock.thickness = 6
  project.tools = [
    { ...defaultPlasmaTool('mm'), id: 'torch', name: 'Torch', diameter: 2, cutHeight: 1.5, defaultFeed: 2200 },
    defaultTool('mm'),
  ]
  return projectWithFeatures(project, features)
}

function op(project: Project, ids = ['part'], patch: Partial<Operation> = {}): Operation {
  return {
    ...defaultOperationForTarget(project, 'plasma_profile', 'rough', { source: 'features', featureIds: ids }, 0),
    ...patch,
  }
}

/** The operation lives in the project for every reader that looks it up by id. */
function withOperation(project: Project, operation: Operation): Project {
  return { ...project, operations: [operation] }
}

function close(a: number, b: number, tolerance = 1e-9): boolean {
  return Math.abs(a - b) <= tolerance
}

function samePoint(a: PointLike, b: PointLike): boolean {
  return close(a.x, b.x) && close(a.y, b.y)
}

// ── Width: the kerf is the torch diameter, in project units ──────────────

{
  const project = fixture()
  const operation = op(project)
  const plasmaProject = withOperation(project, operation)
  const torch = project.tools[0]
  const normalized = normalizeToolForProject(torch, plasmaProject)

  assert.equal(plasmaKerfWidth(plasmaProject, operation.id), 2, 'the mm width is the torch diameter')
  assert.equal(
    plasmaKerfWidth(plasmaProject, operation.id),
    2 * normalized.radius,
    'the mm width equals twice the normalized torch radius — the value plasma.ts offsets by',
  )
  assert.equal(plasmaKerfWidth(plasmaProject, operation.id), normalized.diameter, 'the width is the normalized diameter')

  // An inch project: the same physical torch reads in the project's units.
  const inch = newProject('Plasma inch', 'inch')
  inch.tools = [{ ...defaultPlasmaTool('inch'), id: 'torch', name: 'Torch', diameter: convertLength(2, 'mm', 'inch') }]
  const inchOperation = defaultOperationForTarget(inch, 'plasma_profile', 'rough', { source: 'features', featureIds: [] }, 0)
  const inchProject = withOperation(inch, inchOperation)
  const inchWidth = plasmaKerfWidth(inchProject, inchOperation.id)
  assert.ok(inchWidth !== null, 'an inch project has a kerf width')
  assert.ok(close(inchWidth, convertLength(2, 'mm', 'inch'), 1e-12), `the inch width is 2 mm in inches (got ${inchWidth})`)
  assert.ok(close(inchWidth, inch.tools[0].diameter, 1e-12), 'the inch width is the torch diameter in project units')

  // A torch stored in its own (inch) units still normalizes into the mm project.
  const foreignUnits = withOperation({ ...project, tools: [convertToolUnits(torch, 'inch'), project.tools[1]] }, operation)
  assert.ok(
    close(plasmaKerfWidth(foreignUnits, operation.id) ?? Number.NaN, 2),
    'a torch stored in another unit normalizes into project units',
  )
}

// ── Width: null unless it is a plasma operation with a usable torch ──────

{
  const project = fixture()
  const plasma = withOperation(project, op(project))
  const plasmaOperation = plasma.operations[0]

  const milling = { ...project, operations: [defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: ['part'] }, 1)] }
  assert.equal(plasmaKerfWidth(milling, milling.operations[0].id), null, 'a milling operation has no kerf width')
  assert.equal(plasmaKerfWidth(plasma, 'missing'), null, 'an unknown operation id has no kerf width')
  assert.equal(
    plasmaKerfWidth(withOperation(project, { ...plasmaOperation, toolRef: null }), plasmaOperation.id),
    null,
    'a plasma operation without a tool has no kerf width',
  )
  assert.equal(
    plasmaKerfWidth(withOperation(project, { ...plasmaOperation, toolRef: project.tools[1].id }), plasmaOperation.id),
    null,
    'a milling tool assigned to a plasma operation has no kerf width',
  )
  // The tool-type guard itself (slice B correction): the flat endmill is a
  // real, present tool with a positive diameter, and a plasma_profile
  // operation whose toolRef points at it still reads null.
  const endmill = project.tools[1]
  assert.equal(endmill.type, 'flat_endmill', 'the fixture’s second tool is a flat endmill')
  assert.ok(endmill.diameter > 0, 'the endmill has a positive diameter, so a null is a refusal, not a missing tool')
  assert.equal(
    plasmaKerfWidth(withOperation(project, { ...plasmaOperation, toolRef: endmill.id }), plasmaOperation.id),
    null,
    'a plasma_profile operation whose toolRef is a flat endmill gives null',
  )
  for (const diameter of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    const broken = withOperation({ ...project, tools: [{ ...project.tools[0], diameter }, project.tools[1]] }, plasmaOperation)
    assert.equal(plasmaKerfWidth(broken, plasmaOperation.id), null, `a torch of diameter ${diameter} has no kerf width`)
  }
}

// ── Geometry on a real generated plasma cut ──────────────────────────────

const p = fixture()
const outsideOperation = op(p)
const outside = generatePlasmaProfileToolpath(p, outsideOperation)
assert.ok(outside.moves.length > 0, 'the outside square generates')
const outsideGeometry = plasmaKerfGeometry(outside)

{
  const cutMoves = outside.moves.filter((move) => move.kind === 'cut')
  const leadMoves = outside.moves.filter((move) => move.kind === 'lead_in' || move.kind === 'lead_out')
  assert.equal(outsideGeometry.contour.length, cutMoves.length, 'every cut move is a contour segment')
  assert.equal(outsideGeometry.leads.length, leadMoves.length, 'every lead move is a lead segment')
  assert.equal(
    outsideGeometry.contour.length + outsideGeometry.leads.length,
    cutMoves.length + leadMoves.length,
    'the band covers exactly the torch-on moves (cut, lead_in, lead_out)',
  )

  // One pierce per cut block, equal to that cut's first lead-in point.
  const blocks: ToolpathMove[][] = []
  let current: ToolpathMove[] = []
  for (const move of outside.moves) {
    if (move.kind === 'rapid') {
      if (current.length > 0) blocks.push(current)
      current = []
      continue
    }
    current.push(move)
  }
  if (current.length > 0) blocks.push(current)
  const cutBlocks = blocks.filter((block) => block.some((move) => move.kind === 'cut'))
  assert.ok(cutBlocks.length > 0, 'the outside square has a cut block')
  assert.equal(outsideGeometry.pierces.length, cutBlocks.length, 'one pierce per cut')
  for (let index = 0; index < cutBlocks.length; index += 1) {
    const plunge = cutBlocks[index].find((move) => move.kind === 'plunge')
    const leadIn = cutBlocks[index].find((move) => move.kind === 'lead_in')
    assert.ok(plunge, `cut block ${index} pierces`)
    assert.ok(samePoint(outsideGeometry.pierces[index], plunge.to), `pierce ${index} is the plunge target`)
    if (leadIn) {
      assert.ok(samePoint(outsideGeometry.pierces[index], leadIn.from), `pierce ${index} is the first lead-in point`)
    }
  }

  // Rapids contribute nothing at all.
  const rapidOnly: ToolpathResult = {
    operationId: 'op1',
    moves: [
      { kind: 'rapid', from: { x: 0, y: 0, z: 10 }, to: { x: 50, y: 50, z: 10 } },
      { kind: 'rapid', from: { x: 50, y: 50, z: 10 }, to: { x: 0, y: 0, z: 10 } },
    ],
    warnings: [],
    bounds: null,
  }
  assert.deepEqual(plasmaKerfGeometry(rapidOnly), { contour: [], leads: [], pierces: [] }, 'rapids contribute nothing')

  // A milling toolpath (the fixture's refused milling result) has no band geometry.
  const millingToolpath: ToolpathResult = { operationId: 'mill', moves: [], warnings: [], bounds: null }
  assert.deepEqual(
    plasmaKerfGeometry(millingToolpath),
    { contour: [], leads: [], pierces: [] },
    'a milling toolpath gives empty arrays',
  )

  // Same object in, same cached object out.
  assert.ok(plasmaKerfGeometry(outside) === outsideGeometry, 'the same toolpath object returns the same cached geometry')
  assert.ok(plasmaKerfGeometry(outside).contour === outsideGeometry.contour, 'the cached contour array is the same reference')
}

// ── Rule 1: the band edge lands on the drawn part line ───────────────────

function pointSegmentDistance(p: PointLike, a: PointLike, b: PointLike): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const length2 = abx * abx + aby * aby
  if (length2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / length2))
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
}

function segmentsIntersect(a1: PointLike, a2: PointLike, b1: PointLike, b2: PointLike): boolean {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x)
  if (Math.abs(d) < 1e-12) return false
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d
  const u = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d
  return t >= -1e-12 && t <= 1 + 1e-12 && u >= -1e-12 && u <= 1 + 1e-12
}

/** Shortest distance between a segment and a closed ring of points. */
function segmentToRingDistance(a1: PointLike, a2: PointLike, ring: readonly PointLike[]): number {
  let min = Number.POSITIVE_INFINITY
  for (let index = 0; index < ring.length; index += 1) {
    const b1 = ring[index]
    const b2 = ring[(index + 1) % ring.length]
    if (segmentsIntersect(a1, a2, b1, b2)) return 0
    min = Math.min(
      min,
      pointSegmentDistance(a1, b1, b2),
      pointSegmentDistance(a2, b1, b2),
      pointSegmentDistance(b1, a1, a2),
      pointSegmentDistance(b2, a1, a2),
    )
  }
  return min
}

{
  const outline = [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }]
  const width = plasmaKerfWidth(withOperation(p, outsideOperation), outsideOperation.id)
  assert.ok(width !== null, 'the outside fixture has a kerf width')
  for (const segment of outsideGeometry.contour) {
    const distance = segmentToRingDistance(
      { x: segment.fromX, y: segment.fromY },
      { x: segment.toX, y: segment.toY },
      outline,
    )
    assert.ok(
      close(distance, width / 2, 1e-6),
      `outside: the band edge lies on the drawn part line (distance ${distance}, half width ${width / 2})`,
    )
  }

  const withHole = fixture([feature('part', 'add'), feature('hole', 'subtract', square(35, 35, 30))])
  const holeOperation = op(withHole, ['hole'])
  const hole = generatePlasmaProfileToolpath(withHole, holeOperation)
  assert.ok(hole.moves.length > 0, 'the hole generates')
  const holeGeometry = plasmaKerfGeometry(hole)
  const holeWidth = plasmaKerfWidth(withOperation(withHole, holeOperation), holeOperation.id)
  assert.ok(holeWidth !== null, 'the hole fixture has a kerf width')
  const holeRing = [{ x: 35, y: 35 }, { x: 65, y: 35 }, { x: 65, y: 65 }, { x: 35, y: 65 }]
  assert.ok(holeGeometry.contour.length > 0, 'the hole has contour segments')
  for (const segment of holeGeometry.contour) {
    const distance = segmentToRingDistance(
      { x: segment.fromX, y: segment.fromY },
      { x: segment.toX, y: segment.toY },
      holeRing,
    )
    assert.ok(
      close(distance, holeWidth / 2, 1e-6),
      `hole: the band edge lies on the drawn hole line (distance ${distance}, half width ${holeWidth / 2})`,
    )
  }
}

console.log('plasmaKerfPreview tests passed')
