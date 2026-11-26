/**
 * Copyright 2026 Franja (Frank) Povazanj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { deepStrictEqual, ok } from 'node:assert/strict'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, SketchProfile } from '../../types/project'
import { generateEdgeRouteToolpath } from '../toolpaths/edge'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { optimizeLinearMoves } from '../toolpaths/linearMoveOptimization'
import { BUNDLED_DEFINITIONS } from './definitions'
import { parseGcodeMotion } from './gcodeMotionParser'
import { runPostProcessor } from './postprocessor'
import { parseSbpMotion } from './sbpMotionParser'

// The opening from #1253 in project coordinates. With a 6.35 mm tool and
// 1 mm radial stock to leave, its 4 mm fillet leaves two tiny chords between
// the long straight cuts. The finish pass still has room to follow the fillet.
const opening: SketchProfile = {
  start: { x: 86.9220516, y: 82.4812851 },
  closed: true,
  segments: [
    { type: 'line', to: { x: 50.5841916, y: 252.7006206 } },
    { type: 'arc', to: { x: 54.4960485, y: 257.5357109 }, center: { x: 54.4960485, y: 253.5357109 }, clockwise: true },
    { type: 'line', to: { x: 311.4644548, y: 257.5357109 } },
    { type: 'arc', to: { x: 315.4644548, y: 253.5357109 }, center: { x: 311.4644548, y: 253.5357109 }, clockwise: true },
    { type: 'line', to: { x: 315.4644548, y: 31.5357109 } },
    { type: 'arc', to: { x: 311.4644548, y: 27.5357109 }, center: { x: 311.4644548, y: 31.5357109 }, clockwise: true },
    { type: 'line', to: { x: 208.1617833, y: 27.5357109 } },
    { type: 'arc', to: { x: 206.546743, y: 27.8762512 }, center: { x: 208.1617833, y: 31.5357109 }, clockwise: true },
    { type: 'line', to: { x: 89.2188682, y: 79.6569158 } },
    { type: 'arc', to: { x: 86.9220516, y: 82.4812851 }, center: { x: 90.8339085, y: 83.3163754 }, clockwise: true },
  ],
}

const tool = { ...defaultTool('mm', 1), id: 't1', diameter: 6.35 }
const base = newProject('Inside edge route', 'mm')
const project = projectWithFeatures({
  ...base,
  stock: {
    profile: rectProfile(0, 0, 344, 285),
    thickness: 19,
    material: 'aluminum_6061',
    color: '#b9a83c',
    visible: true,
    origin: { x: 0, y: 0 },
  },
  origin: { name: 'Origin', x: 0, y: 285, z: 20, visible: true },
  tools: [tool],
  meta: { ...base.meta, operationClearanceZ: 4 },
}, [{
  id: 'opening',
  name: 'Opening',
  kind: 'composite',
  folderId: null,
  sketch: { profile: opening, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  operation: 'subtract',
  z_top: 20,
  z_bottom: 0,
  visible: true,
  locked: false,
}])

const rough: Operation = {
  id: 'rough',
  name: 'Inside rough',
  kind: 'edge_route_inside',
  pass: 'rough',
  enabled: true,
  showToolpath: true,
  debugToolpath: false,
  target: { source: 'features', featureIds: ['opening'] },
  toolRef: tool.id,
  stepdown: 4,
  stepover: 0.32,
  feed: 2000,
  plungeFeed: 200,
  rpm: 18000,
  pocketPattern: 'offset',
  pocketAngle: 0,
  roundOutsideCorners: true,
  stockToLeaveRadial: 1,
  stockToLeaveAxial: 1,
  finishWalls: true,
  finishFloor: true,
  carveDepth: 1,
  maxCarveDepth: 1,
  cutDirection: 'climb',
  machiningOrder: 'feature_first',
  edgeStrategy: 'contour',
  entryStrategy: 'plunge',
  arcFittingEnabled: true,
}
const finish: Operation = {
  ...rough,
  id: 'finish',
  name: 'Inside finish',
  pass: 'finish',
  stockToLeaveRadial: 0,
  stockToLeaveAxial: 0,
  cutDirection: 'conventional',
}

function postedMoves(operation: Operation, machineId: 'grbl' | 'shopbot') {
  const definition = BUNDLED_DEFINITIONS.find(machine => machine.id === machineId)
  ok(definition, `missing bundled ${machineId} definition`)
  const toolpath = generateEdgeRouteToolpath(project, operation)
  deepStrictEqual(toolpath.warnings, [], `${operation.name} should generate without warnings`)
  const result = runPostProcessor({
    project,
    definition,
    operations: [{
      operation,
      tool: normalizeToolForProject(tool, project),
      toolpath: optimizeLinearMoves(toolpath),
    }],
    options: { emitToolChanges: false, emitCoolant: false },
  })
  deepStrictEqual(result.warnings, [], `${machineId}: ${operation.name} should export without warnings`)
  const parsed = machineId === 'shopbot'
    ? parseSbpMotion(result.gcode)
    : parseGcodeMotion(result.gcode, 'ij', ';', '')
  deepStrictEqual(parsed.status, 'verified', parsed.warnings.join('\n'))
  return parsed.moves
}

for (const machineId of ['grbl', 'shopbot'] as const) {
  const fitted = postedMoves(rough, machineId)
  const linear = postedMoves({ ...rough, arcFittingEnabled: false }, machineId)
  const planarCuts = linear.filter(move => move.kind === 'linear' && move.from.z === move.to.z)
  const depths = new Set(planarCuts.map(move => move.to.z))
  deepStrictEqual([...depths], [-4, -8, -12, -16, -19],
    `${machineId}: the linear reference must cut all five roughing depths`)
  ok(fitted.every(move => move.kind !== 'arc'), `${machineId}: inside roughing must preserve the two straight sides`)
  deepStrictEqual(fitted, linear, `${machineId}: preserve the complete roughing path, including both corner chords`)

  const finished = postedMoves(finish, machineId)
  ok(finished.some(move => move.kind === 'arc' && move.radius < 1),
    `${machineId}: the finish pass must still fit the real fillets`)
}
console.log('Inside edge roughing preserves straight moves while finishing fits fillets (#1253): PASSED')
