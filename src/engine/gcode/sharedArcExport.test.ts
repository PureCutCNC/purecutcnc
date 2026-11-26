/**
 * Copyright 2026 PureCutCNC Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { projectWithFeatures } from '../../test/projectFixtures'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import type { SketchProfile } from '../../types/project'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import { DEFAULT_FLATTEN_ARC_STEP, flattenProfile, normalizeToolForProject } from '../toolpaths/geometry'
import { BUNDLED_DEFINITIONS } from './definitions'
import { parseGcodeMotion } from './gcodeMotionParser'
import { runPostProcessor } from './postprocessor'

const definition = BUNDLED_DEFINITIONS.find(machine => machine.id === 'grbl')
assert(definition)

for (const units of ['mm', 'inch'] as const) {
  const scale = units === 'mm' ? 1 : 1 / 25.4
  const base = newProject('Curve evidence through CAM', units)
  const tool = { ...defaultTool(units, 1), id: 't1', diameter: 6.35 * scale }
  const circle = circleProfile(110 * scale, 90 * scale, 45 * scale)
  const corners = rectProfile(60 * scale, 35 * scale, 100 * scale, 110 * scale)
  const vertices = flattenProfile(circle).points
  const polygon: SketchProfile = {
    start: vertices[0],
    segments: [...vertices.slice(1), vertices[0]].map(to => ({ type: 'line', to })),
    closed: true,
  }
  assert.deepEqual(flattenProfile(polygon).points, vertices)
  assert(45 * (1 - Math.cos(DEFAULT_FLATTEN_ARC_STEP / 2)) > 0.01,
    'the source chords must exceed the strict linear error budget')

  for (const test of [
    { label: 'circular edge', kind: 'edge_route_outside', mode: 'add', profile: circle, minimumLargeArcs: 4 },
    { label: 'circular pocket', kind: 'pocket', mode: 'subtract', profile: circle, minimumLargeArcs: 16 },
    { label: 'linear polygon', kind: 'edge_route_outside', mode: 'add', profile: polygon, minimumLargeArcs: 0 },
    { label: 'rounded offset corners', kind: 'edge_route_outside', mode: 'add', profile: corners, minimumLargeArcs: 0 },
  ] as const) {
    const label = `${units} ${test.label}`
    const project = projectWithFeatures({
      ...base,
      stock: { ...base.stock, thickness: 18 * scale, profile: rectProfile(0, 0, 230 * scale, 200 * scale) },
      tools: [tool],
      origin: { name: 'Origin', x: 0, y: 200 * scale, z: 18 * scale, visible: true },
    }, [{
      id: 'target', name: 'Target', folderId: null, kind: 'composite', operation: test.mode,
      z_top: 18 * scale, z_bottom: 12 * scale, locked: false, visible: true,
      sketch: {
        profile: test.profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
      },
    }])
    const operation = {
      ...defaultOperationForTarget(project, test.kind, 'finish', { source: 'features', featureIds: ['target'] }, 0),
      entryStrategy: 'plunge' as const,
      arcFittingEnabled: true,
      roundOutsideCorners: test.profile === corners,
    }
    const envelope = computeOperationToolpath(project, operation)
    assert(envelope, `${label}: toolpath missing`)
    const toolpath = envelope.result
    const input = { toolpath, tool: normalizeToolForProject(tool, project) }
    const post = (arcFittingEnabled: boolean): ReturnType<typeof runPostProcessor> => runPostProcessor({
      project, definition, operations: [{ ...input, operation: { ...operation, arcFittingEnabled } }],
      options: { emitToolChanges: false, emitCoolant: false },
    })
    const fitted = post(true)
    assert.deepEqual(fitted.warnings, [], `${label}: unexpected post warning`)
    const parsed = parseGcodeMotion(fitted.gcode, 'ij', ';', '')
    const arcs = parsed.moves.filter(move => move.kind === 'arc')
    const largeArcs = arcs.filter(move => move.radius > 30 * scale)
    if (test.minimumLargeArcs > 0) {
      assert(largeArcs.length >= test.minimumLargeArcs, `${label}: expected arcs from the source circle and its offsets`)
      const linear = parseGcodeMotion(post(false).gcode, 'ij', ';', '')
      assert(parsed.moves.length < linear.moves.length / 4, `${label}: expected a substantial reduction in moves`)
    } else if (test.profile === polygon) {
      assert.equal(arcs.length, 0, `${label}: straight-sided profile must stay linear`)
      assert.equal(fitted.gcode, post(false).gcode, `${label}: arc fitting must preserve the linear program`)
    } else {
      assert.equal(arcs.length, 4, `${label}: each generated round join should fit`)
      for (const arc of arcs) {
        assert(Math.abs(arc.radius / scale - tool.diameter / scale / 2) < 0.01,
          `${label}: round join should use the cutter radius`)
      }
    }
    console.log(`Shared arc export (${label}): PASSED`)
  }
}
