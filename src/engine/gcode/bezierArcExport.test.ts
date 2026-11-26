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

// Bézier geometry (SVG circles, ellipses, text glyphs) has no source arc, but
// each sampled chord still bows from the curve by its own sagitta. Export
// must allow that bow so near-circular Béziers fit as arcs again, while a
// Bézier with straight control polygons stays linear (#1253 review).

import assert from 'node:assert/strict'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultTool, ellipseProfile, newProject, rectProfile } from '../../types/project'
import type { Point, SketchProfile } from '../../types/project'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import { DEFAULT_FLATTEN_CURVE_SAMPLES, normalizeToolForProject } from '../toolpaths/geometry'
import { BUNDLED_DEFINITIONS } from './definitions'
import { parseGcodeMotion } from './gcodeMotionParser'
import { runPostProcessor } from './postprocessor'
import { parseSbpMotion } from './sbpMotionParser'

const radius = 25
// SVG's four-Bézier circle, the shape an imported <circle> produces.
const circle = ellipseProfile(80, 70, radius, radius)
assert(circle.segments.every(segment => segment.type === 'bezier'))
assert(radius * (1 - Math.cos(Math.PI / 4 / DEFAULT_FLATTEN_CURVE_SAMPLES)) > 0.01,
  'each sampled chord must bow more than the strict linear error budget')

// A square drawn with Bézier sides whose controls sit on the side.
const corners: Point[] = [{ x: 40, y: 30 }, { x: 120, y: 30 }, { x: 120, y: 110 }, { x: 40, y: 110 }]
const straight: SketchProfile = {
  start: corners[0],
  closed: true,
  segments: corners.map((from, index) => {
    const to = corners[(index + 1) % corners.length]
    const at = (t: number): Point => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    return { type: 'bezier' as const, control1: at(0.25), control2: at(0.7), to }
  }),
}

const tool = { ...defaultTool('mm', 1), id: 't1', diameter: 6.35 }
const base = newProject('Bézier arc export', 'mm')

function post(profile: SketchProfile, kind: 'edge_route_outside' | 'pocket', machineId: 'grbl' | 'shopbot', arcFittingEnabled: boolean) {
  const project = projectWithFeatures({
    ...base,
    stock: { ...base.stock, thickness: 18, profile: rectProfile(0, 0, 160, 140) },
    tools: [tool],
    origin: { name: 'Origin', x: 0, y: 140, z: 18, visible: true },
  }, [{
    id: 'target', name: 'Target', folderId: null, kind: 'composite',
    operation: kind === 'pocket' ? 'subtract' : 'add',
    z_top: 18, z_bottom: 12, locked: false, visible: true,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  }])
  const operation = {
    ...defaultOperationForTarget(project, kind, 'finish', { source: 'features', featureIds: ['target'] }, 0),
    entryStrategy: 'plunge' as const,
    arcFittingEnabled,
    // Square corners, so only the sampled Bézier sides can produce arcs.
    roundOutsideCorners: false,
  }
  const envelope = computeOperationToolpath(project, operation)
  assert(envelope, 'toolpath missing')
  const definition = BUNDLED_DEFINITIONS.find(machine => machine.id === machineId)
  assert(definition)
  const result = runPostProcessor({
    project, definition,
    operations: [{ operation, toolpath: envelope.result, tool: normalizeToolForProject(tool, project) }],
    options: { emitToolChanges: false, emitCoolant: false },
  })
  assert.deepEqual(result.warnings, [])
  const parsed = machineId === 'shopbot' ? parseSbpMotion(result.gcode) : parseGcodeMotion(result.gcode, 'ij', ';', '')
  assert.equal(parsed.status, 'verified', parsed.warnings.join('\n'))
  return { program: result.gcode, moves: parsed.moves }
}

for (const machineId of ['grbl', 'shopbot'] as const) {
  for (const kind of ['edge_route_outside', 'pocket'] as const) {
    const label = `${machineId} ${kind}`
    const fitted = post(circle, kind, machineId, true)
    const linear = post(circle, kind, machineId, false)
    const arcs = fitted.moves.filter(move => move.kind === 'arc' && move.radius > 15)
    assert(arcs.length >= 4, `${label}: the Bézier circle must post as arcs (got ${arcs.length})`)
    assert(fitted.moves.length < linear.moves.length / 4, `${label}: expected a substantial reduction in moves`)

    const square = post(straight, kind, machineId, true)
    // A pocket smooths its clearing-ring corners with sub-cutter arcs. No arc
    // may span a straight side.
    assert(square.moves.every(move => move.kind !== 'arc' || move.radius < tool.diameter / 2),
      `${label}: straight Bézier sides must stay linear`)
    if (kind === 'edge_route_outside') {
      assert.equal(square.program, post(straight, kind, machineId, false).program,
        `${label}: arc fitting must preserve the straight Bézier program`)
    }
  }
}
console.log('Near-circular Béziers fit arcs and straight Béziers stay linear: PASSED')
