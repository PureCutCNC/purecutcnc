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
 * Tests that addOperation auto-selects/imports a proper tool.
 *
 * Run with: npx tsx src/store/addOperationTool.test.ts
 */

import { useProjectStore } from './projectStore'
import {
  newProject,
  rectProfile,
  type Project,
  type SketchFeature,
  type Tool,
} from '../types/project'
import type { ToolLibraryEntry } from '../toolLibrary'
import { projectWithFeatures } from '../test/projectFixtures'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeFeature(id: string, operation: SketchFeature['operation'], w: number, h: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function flatTool(id: string, diameter: number): Tool {
  return {
    id,
    name: id,
    units: 'inch',
    type: 'flat_endmill',
    diameter,
    vBitAngle: null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 30,
    defaultPlungeFeed: 12,
    defaultStepdown: 0.1,
    defaultStepover: 0.4,
    maxCutDepth: 0,
  }
}

const vBitLibraryEntry: ToolLibraryEntry = {
  key: 'lib-vbit',
  name: '60° V-Bit',
  units: 'inch',
  type: 'v_bit',
  diameter: 0.5,
  vBitAngle: 60,
  flutes: 1,
  material: 'carbide',
  defaultRpm: 18000,
  defaultFeed: 30,
  defaultPlungeFeed: 12,
  defaultStepdown: 0.1,
  defaultStepover: 0.4,
  maxCutDepth: 0.5,
}

function seed(project: Project): void {
  useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null } })
}

function testAddVCarveImportsVBit(): void {
  // Project has only a flat endmill; adding a V-carve must import + reference a v_bit.
  const base = newProject('t', 'inch')
  const project = projectWithFeatures({
    ...base,
    tools: [flatTool('t-flat', 0.25)],
  }, [makeFeature('f', 'subtract', 2, 2)])
  seed(project)

  const opId = useProjectStore.getState().addOperation(
    'v_carve',
    'rough',
    { source: 'features', featureIds: ['f'] },
    [vBitLibraryEntry],
  )
  assert(opId !== null, 'expected v_carve operation to be created')

  const next = useProjectStore.getState().project
  assert(next.tools.length === 2, `expected the v_bit to be imported, got ${next.tools.length} tools`)
  const importedVBit = next.tools.find((tool) => tool.type === 'v_bit')
  assert(importedVBit !== undefined, 'expected an imported v_bit tool')

  const op = next.operations.find((operation) => operation.id === opId)
  assert(op !== undefined, 'expected the operation to exist')
  assert(op.toolRef === importedVBit.id, 'operation should reference the imported v_bit')
  // Max carve depth should come from the tool's max cut depth (0.5"), not the 1 mm engrave default.
  assert(Math.abs(op.maxCarveDepth - 0.5) < 1e-6, `expected maxCarveDepth 0.5 from tool, got ${op.maxCarveDepth}`)
}

function testVCarveDepthFallsBackToStockThickness(): void {
  // A v-bit with no max cut depth → maxCarveDepth defaults to the stock thickness.
  const base = newProject('t', 'inch')
  const project = projectWithFeatures({
    ...base,
    tools: [{ ...flatTool('t-vbit', 0.5), type: 'v_bit', vBitAngle: 60, maxCutDepth: 0 }],
  }, [makeFeature('f', 'subtract', 2, 2)])
  seed(project)

  const opId = useProjectStore.getState().addOperation('v_carve_recursive', 'rough', { source: 'features', featureIds: ['f'] }, [])
  const next = useProjectStore.getState().project
  const op = next.operations.find((operation) => operation.id === opId)
  assert(op !== undefined, 'expected the operation to exist')
  assert(
    Math.abs(op.maxCarveDepth - project.stock.thickness) < 1e-6,
    `expected maxCarveDepth to fall back to stock thickness ${project.stock.thickness}, got ${op.maxCarveDepth}`,
  )
}

function testEngraveKeepsShallowDefault(): void {
  // follow_line (engrave) should keep the 1 mm carve/max-carve default.
  const base = newProject('t', 'mm')
  const project = projectWithFeatures({
    ...base,
    tools: [flatTool('t-flat', 3)],
  }, [makeFeature('f', 'subtract', 40, 40)])
  seed(project)

  const opId = useProjectStore.getState().addOperation('follow_line', 'rough', { source: 'features', featureIds: ['f'] }, [])
  const next = useProjectStore.getState().project
  const op = next.operations.find((operation) => operation.id === opId)
  assert(op !== undefined, 'expected the engrave operation to exist')
  assert(Math.abs(op.carveDepth - 1) < 1e-6, `engrave carveDepth should stay 1 mm, got ${op.carveDepth}`)
  assert(Math.abs(op.maxCarveDepth - 1) < 1e-6, `engrave maxCarveDepth should stay 1 mm, got ${op.maxCarveDepth}`)
}

function testAddPocketReusesExistingFlatNoImport(): void {
  // A flat endmill already covers a pocket — no new tool should be added.
  const base = newProject('t', 'inch')
  const project = projectWithFeatures({
    ...base,
    tools: [flatTool('t-flat', 0.125)],
  }, [makeFeature('f', 'subtract', 2, 2)])
  seed(project)

  const opId = useProjectStore.getState().addOperation(
    'pocket',
    'rough',
    { source: 'features', featureIds: ['f'] },
    [vBitLibraryEntry],
  )
  const next = useProjectStore.getState().project
  assert(next.tools.length === 1, 'pocket should reuse the existing flat endmill, not import')
  const op = next.operations.find((operation) => operation.id === opId)
  assert(op?.toolRef === 't-flat', 'pocket should reference the existing flat endmill')
}

testAddVCarveImportsVBit()
testAddPocketReusesExistingFlatNoImport()
testVCarveDepthFallsBackToStockThickness()
testEngraveKeepsShallowDefault()

console.log('addOperationTool tests passed')
