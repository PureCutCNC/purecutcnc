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

/// <reference types="node" />

/**
 * One Verify run end to end (issue #1269), on a 60 × 40 × 10 mm block with a
 * 20 × 20 × 4 mm pocket cut by a 4 mm flat endmill: the exported items are
 * the posted program read back, every comparison reports every covered
 * operation, an operation without a path is listed unverified (and its cells
 * marked), an exported comparison without a machine is refused, and a
 * cancelled run resolves null.
 *
 * Run with: npx tsx src/app/verify/verifyRun.test.ts
 */

import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import { exportOperationMotion } from '../../engine/gcode/exportedMotion'
import { validateMachineDefinition, type MachineDefinition } from '../../engine/gcode/types'
import { MODEL_DEVIATION_UNINTENDED_LEFTOVER } from '../../engine/simulation/modelDeviation'
import type { ToolpathMove, ToolpathResult } from '../../engine/toolpaths/types'
import { activeSetup } from '../../store/helpers/activeFace'
import { syncProjectSetups } from '../../store/helpers/setups'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature } from '../../types/project'
import { exportedReplayItem, internalReplayItem, motionReasons, runVerification, VERIFY_CELL_UNVERIFIED, type VerifyRunResult } from './verifyRun'
import type { VerifyComparison, VerifyRequest } from './verifyRequest'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const POCKET = { minX: 20, minY: 10, maxX: 40, maxY: 30, floor: 6 }

function feature(id: string, operation: SketchFeature['operation'], minX: number, minY: number, w: number, h: number, zBottom: number): SketchFeature {
  return {
    id, name: id, kind: 'rect', folderId: null,
    sketch: { profile: rectProfile(minX, minY, w, h), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation, z_top: 10, z_bottom: zBottom, authoringFace: 'top', visible: true, locked: false,
  }
}

function op(id: string): Operation {
  return {
    id, name: `Op ${id}`, kind: 'pocket', pass: 'rough', enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds: ['pocket'] }, toolRef: 't1', stepdown: 2, stepover: 0.4,
    feed: 600, plungeFeed: 180, rpm: 12000, pocketPattern: 'offset', pocketAngle: 0,
    stockToLeaveRadial: 0, stockToLeaveAxial: 0, finishWalls: false, finishFloor: false, carveDepth: 0, maxCarveDepth: 0,
  }
}

function project(): Project {
  const base = newProject('Verify run', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 60, 40), thickness: 10 }
  base.origin = { name: 'Origin', x: 0, y: 40, z: 10, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', diameter: 4 }]
  const withFeatures = projectWithFeatures(base, [
    feature('base', 'add', 0, 0, 60, 40, 0),
    feature('pocket', 'subtract', POCKET.minX, POCKET.minY, 20, 20, POCKET.floor),
  ])
  const setupId = withFeatures.activeSetupId
  return syncProjectSetups({ ...withFeatures, operations: [{ ...op('clear'), setupId }, { ...op('missing'), setupId }] })
}

/** A raster that clears the pocket floor to size with a 2 mm radius tool. */
function clearPath(): ToolpathResult {
  const inset = 2
  const z = POCKET.floor
  const moves: ToolpathMove[] = []
  let at = { x: POCKET.minX + inset, y: POCKET.minY + inset, z: 12 }
  const to = (x: number, y: number, kind: ToolpathMove['kind'] = 'cut', toZ = z) => {
    const next = { x, y, z: toZ }
    moves.push({ kind, from: at, to: next })
    at = next
  }
  // A real path starts with a rapid to its first point; the program does too.
  moves.push({ kind: 'rapid', from: { x: 0, y: 0, z: 12 }, to: at })
  to(at.x, at.y, 'plunge')
  let forward = true
  for (let y = POCKET.minY + inset; y <= POCKET.maxY - inset + 1e-9; y += 1.5) {
    to(at.x, Math.min(y, POCKET.maxY - inset))
    to(forward ? POCKET.maxX - inset : POCKET.minX + inset, at.y)
    forward = !forward
  }
  to(POCKET.minX + inset, POCKET.maxY - inset)
  to(POCKET.minX + inset, POCKET.minY + inset)
  to(POCKET.maxX - inset, POCKET.minY + inset)
  to(POCKET.maxX - inset, POCKET.maxY - inset)
  to(POCKET.minX + inset, POCKET.maxY - inset)
  to(at.x, at.y, 'rapid', 12)
  return { operationId: 'clear', moves, warnings: [], bounds: null }
}

function grbl(): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')
  assert(found, 'the bundled GRBL definition')
  return validateMachineDefinition(structuredClone(found))
}

async function run(p: Project, comparison: VerifyComparison, definition: MachineDefinition | null = grbl(), signal?: AbortSignal): Promise<VerifyRunResult | null> {
  const setup = activeSetup(p)
  const request: VerifyRequest = { project: p, setupId: setup.id, comparison, uptoOperationId: 'missing', detailCells: 240 }
  return runVerification({
    request, setup, operations: p.operations, toolpaths: new Map([['clear', clearPath()]]), definition,
  }, { signal, yieldNow: () => Promise.resolve() })
}

function testExportedItems(): void {
  console.log('Testing an exported item cuts the program read back...')
  const p = project()
  const internal = internalReplayItem(p, p.operations[0], clearPath())
  assert(internal && internal.toolRadius === 2 && internal.toolType === 'flat_endmill', 'the internal item carries the operation\'s tool')
  const motion = exportOperationMotion({ project: p, operation: p.operations[0], toolpath: clearPath(), definition: grbl() })
  assert(motion.status === 'verified', `the GRBL program reads back, got ${motion.status}`)
  const exported = exportedReplayItem(internal, motion)
  assert(exported.toolpath.moves === motion.moves && exported.toolRadius === 2, 'the exported item replays the read-back moves with the same tool')
  assert(internalReplayItem(p, { ...p.operations[0], toolRef: 'none' }, clearPath()) === null, 'no tool, no item')
  assert(motionReasons([
    { code: 'machineCoordinateRetract', severity: 'info', count: 1 },
    { code: 'unsupportedCommand', severity: 'unsupported', count: 2, line: 7, command: 'G91' },
  ]).map((reason) => `${reason.code}:${reason.line}:${reason.command}`).join() === 'unsupportedCommand:7:G91', 'only reasons that change the status are listed')
}

async function testModelComparisons(): Promise<void> {
  for (const comparison of ['modelInternal', 'modelExported'] as const) {
    console.log(`Testing ${comparison}: the corners are unintended, the missing path is unverified...`)
    const result = await run(project(), comparison)
    assert(result && result.status === 'verified', `${comparison} compares`)
    assert(result.operations.map((entry) => entry.operationId).join() === 'clear,missing', 'every covered operation is listed')
    const [clear, missing] = result.operations
    assert(missing.verdict === 'unverified' && missing.reasons[0]?.code === 'noToolpath', 'a missing path is listed unverified with its reason')
    assert(clear.verdict === 'deviation', `the square corners are a deviation of the clear, got ${clear.verdict}`)
    const corners = clear.findings.filter((finding) => finding.kind === 'unintendedLeftover')
    assert(corners.length === 4, `four corner regions, got ${corners.length}`)
    assert(clear.findings.every((finding) => finding.kind !== 'gouge'), 'nothing is gouged')
    assert(result.display !== null, 'the cumulative stock is shown')
    const codes = result.display.cellCodes
    assert(codes.includes(MODEL_DEVIATION_UNINTENDED_LEFTOVER), 'corner cells carry their class')
    assert(!codes.includes(VERIFY_CELL_UNVERIFIED), 'no unverified operation cut anything')
  }
}

async function testInternalExported(): Promise<void> {
  console.log('Testing Internal ↔ Exported reports the parity verdict per operation...')
  const result = await run(project(), 'internalExported')
  assert(result && result.status === 'verified', 'the comparison runs')
  const [clear, missing] = result.operations
  assert(clear.verdict === 'verified' && clear.findings.length === 0, `the program cuts the toolpath, got ${clear.verdict} with ${clear.findings.length} deviations`)
  assert(missing.verdict === 'unverified', 'the missing path is unverified')
  assert(result.display !== null && result.display.grid.topZ.some((z) => z < 10), 'the internal stock is shown')
}

async function testRefusals(): Promise<void> {
  console.log('Testing a run without a machine or a model, and a cancelled run...')
  const noMachine = await run(project(), 'modelExported', null)
  assert(noMachine?.status === 'unverified' && noMachine.reason?.code === 'noMachine', 'an exported comparison needs a machine')
  assert(noMachine.operations.every((entry) => entry.verdict === 'unverified'), 'every operation is still listed, unverified')
  const internalOnly = await run(project(), 'modelInternal', null)
  assert(internalOnly?.status === 'verified', 'Model ↔ Internal needs no machine')

  const bare = project()
  const noModel = await run({ ...bare, features: bare.features.filter(() => false) }, 'modelInternal')
  assert(noModel?.status === 'unverified' && noModel.reason?.code === 'noModel', `no model is unverified, got ${noModel?.reason?.code}`)
  assert(noModel.operations.length === 2 && noModel.display === null, 'listed, nothing to show')

  const controller = new AbortController()
  controller.abort()
  assert(await run(project(), 'modelInternal', grbl(), controller.signal) === null, 'a cancelled run resolves null')
}

testExportedItems()
await testModelComparisons()
await testInternalExported()
await testRefusals()
console.log('verifyRun tests passed')
