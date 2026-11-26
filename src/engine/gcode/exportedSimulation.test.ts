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
 * Tests for exported G-code / ShopBot simulation reconstruction (issue #1261).
 *
 * Run with: npx tsx src/engine/gcode/exportedSimulation.test.ts
 */

import assert from 'node:assert/strict'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SketchFeature } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import type { ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { buildExportedSimulationPaths } from './exportedSimulation'

function makeCircleProject(): { project: Project; operation: Operation; planned: ToolpathResult } {
  const tool = { ...defaultTool('mm', 1), id: 't1', name: '6 mm Endmill', diameter: 6, defaultStepdown: 2 }
  const circle: SketchFeature = {
    id: 'circle-1',
    name: 'Disc',
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: circleProfile(60, 50, 20),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 0,
    z_bottom: -2,
    visible: true,
    locked: false,
  }
  const base = newProject('Export Sim Test', 'mm')
  const project = projectWithFeatures(
    {
      ...base,
      origin: { ...base.origin, x: 10, y: 15, z: 0 },
      tools: [tool],
    },
    [circle],
  )
  const operation: Operation = {
    id: 'op1',
    name: 'Edge Outside',
    description: '',
    kind: 'edge_route_outside',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['circle-1'] },
    toolRef: tool.id,
    stepdown: 2,
    stepover: 0.4,
    feed: 1000,
    plungeFeed: 400,
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
    arcFittingEnabled: true,
  }
  project.operations = [operation]
  const planned = computeOperationToolpath(project, operation)?.result
  assert.ok(planned, 'circle planned toolpath is non-null')
  return { project, operation, planned }
}

function testGrblAndShopBotRoundTrip(): void {
  console.log('Testing exported simulation round-trip for GRBL (G2/G3) and ShopBot (CG)...')
  const { project, operation, planned } = makeCircleProject()
  const plannedPaths = new Map([[operation.id, planned]])

  for (const machineId of ['grbl', 'shopbot'] as const) {
    const definition = BUNDLED_DEFINITIONS.find((d) => d.id === machineId)
    assert.ok(definition, `bundled ${machineId} definition exists`)
    const exported = buildExportedSimulationPaths({
      project,
      operations: [operation],
      plannedPaths,
      definition,
    })

    assert.equal(exported.status, 'verified', `${machineId} parse status is verified`)
    assert.deepEqual(exported.warnings, [], `${machineId} emits no warnings`)

    const reconstructed = exported.paths.get(operation.id)
    assert.ok(reconstructed, `${machineId} produces reconstructed toolpath`)
    const cuts = reconstructed.moves.filter((m) => m.kind === 'cut')
    assert.ok(cuts.length > 0, `${machineId} has reconstructed cut moves`)

    // Tool center radius around (60, 50) for outside finish on R=20 with D=6 tool is 23 mm.
    for (const cut of cuts) {
      const dist = Math.hypot(cut.to.x - 60, cut.to.y - 50)
      assert.ok(
        Math.abs(dist - 23) <= 0.05,
        `${machineId} reconstructed cut point (${cut.to.x.toFixed(3)}, ${cut.to.y.toFixed(3)}) sits on R=23 circle (got ${dist.toFixed(4)})`,
      )
    }
  }
}

function testUnsupportedConstructAlertsUser(): void {
  console.log('Testing unsupported G-code construct surfaces warning and non-verified status...')
  const tool = { ...defaultTool('mm', 1), id: 't1', name: '6 mm Endmill', diameter: 6, defaultStepdown: 2 }
  const rect: SketchFeature = {
    id: 'rect-1',
    name: 'Rect',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, 10, 40, 30),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 0,
    z_bottom: -2,
    visible: true,
    locked: false,
  }
  const project = projectWithFeatures({ ...newProject('Unsupported Test', 'mm'), tools: [tool] }, [rect])
  const operation: Operation = {
    id: 'op1',
    name: 'Pocket Op',
    description: '',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['rect-1'] },
    toolRef: tool.id,
    stepdown: 2,
    stepover: 0.4,
    feed: 1000,
    plungeFeed: 400,
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
  }
  project.operations = [operation]
  const planned = computeOperationToolpath(project, operation)?.result
  assert.ok(planned, 'pocket planned toolpath is non-null')

  const grbl = BUNDLED_DEFINITIONS.find((d) => d.id === 'grbl')!
  const withUnsupportedHeader = {
    ...grbl,
    program: {
      ...grbl.program,
      operationHeader: ['G68 X0 Y0 R0'],
    },
  }

  const exported = buildExportedSimulationPaths({
    project,
    operations: [operation],
    plannedPaths: new Map([[operation.id, planned]]),
    definition: withUnsupportedHeader,
  })
  assert.notEqual(exported.status, 'verified', 'rejected or unsupported G-code construct is never reported as verified')
  assert.ok(
    exported.warnings.length > 0 || exported.postWarnings.length > 0,
    'rejected or unsupported G-code construct emits warning',
  )
}

testGrblAndShopBotRoundTrip()
testUnsupportedConstructAlertsUser()
console.log('exportedSimulation tests passed')
