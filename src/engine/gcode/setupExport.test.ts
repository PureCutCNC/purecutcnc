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
 * The setup turn in the export pipeline (issue #944): the machine-coordinate
 * transform with a setup frame, the shared origin, arc direction, drill
 * cycles, and legacy parity for Top.
 *
 * The stock is 100 × 80 × 20 at (0, 0), so its centre is (50, 40) and the
 * default origin sits at the front-left corner of the top face: (0, 80, 20).
 *
 * Mutations these assertions were checked against:
 * - the frame dropped in `planOperationMotion` (moves, or the no-arc branch)
 *   → "a Bottom operation exports turned" fails for the arc and no-arc machine;
 * - the frame dropped in `planDrillCycles` → "Bottom drill cycles" fails;
 * - the turn applied after the origin offset instead of before
 *   → "Bottom about X/Y" and "the shared origin" fail;
 * - `setupFrameForOperation` returning a frame for a 0° setup *and* the half
 *   turn applied at 0° → "Top with setups is byte-identical" fails;
 * - the inverse leaving the turn in → "machine → project round trip" fails;
 * - the arc flag ignoring the setup → "debug arc direction" fails.
 *
 * Run with: npx tsx src/engine/gcode/setupExport.test.ts
 */

import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { MachineOrigin, Operation, Project, SetupOrientation } from '../../types/project'
import { BOTTOM_SETUP_ID, withBottomSetup, withoutSetupFields } from '../../test/projectFixtures'
import { canonicalToSetupPoint, setupFrame } from '../setupOrientation'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { DrillCycle, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { createArcEmitOptions, planDrillCycles, planOperationMotion } from './motionPipeline'
import { runPostProcessor } from './postprocessor'
import { validateMachineDefinition } from './types'
import type { MachineDefinition } from './types'
import { machineToProjectFlipsArcDirection, machineToProjectPoint, projectToMachinePoint } from './utils'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

// ── Fixtures ──────────────────────────────────────────────────

function bundled(id: string, overrides?: Partial<MachineDefinition>): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  if (!found) throw new Error(`Fixture error: no bundled definition "${id}"`)
  return validateMachineDefinition({ ...structuredClone(found), ...overrides })
}

const GRBL = bundled('grbl')
const SHOPBOT = bundled('shopbot')
const BOTTOM_X: SetupOrientation = { axis: 'x', angleDeg: 180 }
const BOTTOM_Y: SetupOrientation = { axis: 'y', angleDeg: 180 }

function makeOperation(id: string, overrides?: Partial<Operation>): Operation {
  return {
    id,
    name: `Op ${id}`,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.4,
    feed: 600,
    plungeFeed: 180,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    ...overrides,
  }
}

/** A project with one operation per id, all in the default Top setup. */
function makeProject(operationIds: string[], overrides?: Partial<Operation>): Project {
  const project = newProject('Setup Export', 'mm')
  project.stock = { ...project.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  project.origin = { name: 'Origin', x: 0, y: 80, z: 20, visible: true }
  project.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Tool 1' }]
  project.operations = operationIds.map((id) => makeOperation(id, { setupId: project.activeSetupId, ...overrides }))
  return project
}

/** A Top pocket pass at stock Z 5, cleared 5 above the top face (stock Z 25). */
const MOVES: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 0, y: 0, z: 25 }, to: { x: 10, y: 70, z: 25 } },
  { kind: 'plunge', from: { x: 10, y: 70, z: 25 }, to: { x: 10, y: 70, z: 5 } },
  { kind: 'cut', from: { x: 10, y: 70, z: 5 }, to: { x: 30, y: 70, z: 5 } },
  { kind: 'cut', from: { x: 30, y: 70, z: 5 }, to: { x: 30, y: 60, z: 5 } },
  { kind: 'rapid', from: { x: 30, y: 60, z: 5 }, to: { x: 30, y: 60, z: 25 } },
]

/**
 * The same pass as a Bottom operation holds it in stock space: the cutter
 * comes from below the stock, so its clearance is 5 *under* the bottom face
 * (stock Z −5) and it cuts up to stock Z 5.
 */
const BOTTOM_MOVES: ToolpathMove[] = MOVES.map((move) => ({
  ...move,
  from: { ...move.from, z: move.from.z === 25 ? -5 : move.from.z },
  to: { ...move.to, z: move.to.z === 25 ? -5 : move.to.z },
}))

function toolpathOf(operation: Operation, moves: ToolpathMove[], drillCycles?: DrillCycle[]): ToolpathResult {
  return { operationId: operation.id, warnings: [], bounds: null, moves, drillCycles }
}

function exportProgram(project: Project, definition: MachineDefinition, moves: ToolpathMove[] = MOVES): string {
  const tool = normalizeToolForProject(project.tools[0], project)
  return runPostProcessor({
    project,
    definition,
    operations: project.operations.map((operation) => ({ operation, tool, toolpath: toolpathOf(operation, moves) })),
    options: { emitToolChanges: true, emitCoolant: false },
  }).gcode
}

function planSteps(project: Project, definition: MachineDefinition, moves: ToolpathMove[] = MOVES): ToolpathPoint[] {
  const operation = project.operations[0]
  return planOperationMotion({
    project,
    definition,
    operation,
    toolpath: toolpathOf(operation, moves),
    arcEmitOptions: createArcEmitOptions(definition, 'mm', 'ij'),
    startPosition: null,
    captureTrace: false,
  }).steps.map((step) => (step.kind === 'linear' ? step.point : step.endPoint))
}

/** A full circle of radius 10 about (50, 40), as short cuts, turning one way in stock space. */
function circleMoves(z: number, segments = 72): ToolpathMove[] {
  const at = (index: number): ToolpathPoint => {
    const angle = (index / segments) * Math.PI * 2
    return { x: 50 + 10 * Math.cos(angle), y: 40 + 10 * Math.sin(angle), z }
  }
  const moves: ToolpathMove[] = [{ kind: 'plunge', from: { ...at(0), z: 25 }, to: at(0) }]
  for (let index = 0; index < segments; index += 1) {
    moves.push({ kind: 'cut', from: at(index), to: at(index + 1) })
  }
  return moves
}

// ── The machine transform ─────────────────────────────────────

function testMachineTransform(): void {
  console.log('Testing the machine transform with a setup frame...')
  const project = makeProject(['op1'])
  const point = { x: 10, y: 70, z: 5 }
  const aboutX = setupFrame(BOTTOM_X, project.stock)
  const aboutY = setupFrame(BOTTOM_Y, project.stock)

  // Top: (x − ox, oy − y, z − oz), as it always was.
  const top = projectToMachinePoint(point, project.origin, GRBL)
  assertEqual(top, { x: 10, y: 10, z: -15 }, 'Top without a frame')
  assertEqual(projectToMachinePoint(point, project.origin, GRBL, setupFrame({ axis: 'x', angleDeg: 0 }, project.stock)), top, 'Top with a 0° frame')

  // Bottom about X: local = (10, 80 − 70, 20 − 5) = (10, 10, 15) → machine
  // (10, 80 − 10, 15 − 20). The cut 5 above the bottom face is 5 below the
  // face that is now up.
  assertEqual(projectToMachinePoint(point, project.origin, GRBL, aboutX), { x: 10, y: 70, z: -5 }, 'Bottom about X')
  // Bottom about Y: local = (100 − 10, 70, 15) → machine (90, 10, −5).
  assertEqual(projectToMachinePoint(point, project.origin, GRBL, aboutY), { x: 90, y: 10, z: -5 }, 'Bottom about Y')

  console.log('Testing machine → project round trip...')
  const mirroredMachine = bundled('grbl', { coordinateSystem: { xAxis: '-X', yAxis: 'Y', zAxis: 'Z' } })
  for (const definition of [GRBL, mirroredMachine]) {
    for (const frame of [undefined, aboutX, aboutY]) {
      const machine = projectToMachinePoint(point, project.origin, definition, frame)
      assertEqual(machineToProjectPoint(machine, project.origin, definition, frame), point, `machine → project round trip (${definition.coordinateSystem.xAxis}, ${frame?.orientation.axis ?? 'top'})`)
    }
  }
  // Without the frame the inverse lands on the setup-local point, not the stock one.
  assertEqual(
    machineToProjectPoint(projectToMachinePoint(point, project.origin, GRBL, aboutX), project.origin, GRBL),
    { x: 10, y: 10, z: 15 },
    'machine → project without the frame is setup-local',
  )

  console.log('Testing debug arc direction...')
  assert(!machineToProjectFlipsArcDirection(GRBL), 'identity axes, Top: no flip')
  assert(machineToProjectFlipsArcDirection(GRBL, aboutX), 'identity axes, Bottom: flip')
  assert(machineToProjectFlipsArcDirection(mirroredMachine), 'mirrored X, Top: flip')
  assert(!machineToProjectFlipsArcDirection(mirroredMachine, aboutY), 'mirrored X, Bottom: the two mirrors cancel')
}

function testSharedOrigin(): void {
  console.log('Testing the shared origin: centreline stays put, off-centre mirrors...')
  const project = makeProject(['op1'])
  const aboutX = setupFrame(BOTTOM_X, project.stock)
  const originAt = (x: number, y: number): MachineOrigin => ({ name: 'Origin', x, y, z: 20, visible: true })
  /** The stock-space XY that reads as machine (0, 0). */
  const zeroPoint = (origin: MachineOrigin, frame?: ReturnType<typeof setupFrame>) => {
    const stock = machineToProjectPoint({ x: 0, y: 0, z: 0 }, origin, GRBL, frame)
    return { x: stock.x, y: stock.y }
  }

  // On the flip centreline (y = 40) machine zero is the same spot on the part.
  assertEqual(zeroPoint(originAt(0, 40)), { x: 0, y: 40 }, 'centreline origin, Top')
  assertEqual(zeroPoint(originAt(0, 40), aboutX), { x: 0, y: 40 }, 'centreline origin, Bottom')
  // Off it, machine zero moves to the mirrored corner.
  assertEqual(zeroPoint(originAt(0, 80)), { x: 0, y: 80 }, 'off-centre origin, Top')
  assertEqual(zeroPoint(originAt(0, 80), aboutX), { x: 0, y: 0 }, 'off-centre origin, Bottom')

  // Machine Z zero is the top of whichever face is up: stock Z 20 for Top, 0 for Bottom.
  assertEqual(machineToProjectPoint({ x: 0, y: 0, z: 0 }, originAt(0, 80), GRBL).z, 20, 'Z zero, Top')
  assertEqual(machineToProjectPoint({ x: 0, y: 0, z: 0 }, originAt(0, 80), GRBL, aboutX).z, 0, 'Z zero, Bottom')
}

// ── The pipeline ──────────────────────────────────────────────

function testBottomOperationExportsTurned(): void {
  console.log('Testing a Bottom operation exports turned...')
  const noArcs = bundled('grbl', { motion: { ...GRBL.motion, arcInterpolation: false } })
  for (const orientation of [BOTTOM_X, BOTTOM_Y]) {
    const project = withBottomSetup(makeProject(['op1']), { axis: orientation.axis, operationIds: ['op1'] })
    assertEqual(project.operations[0].setupId, BOTTOM_SETUP_ID, 'fixture: the operation is in the Bottom setup')
    const frame = setupFrame(orientation, project.stock)
    const expected = MOVES.map((move) => projectToMachinePoint(move.to, project.origin, GRBL, frame))
    // Both branches of the planner: with arc fitting and without.
    assertEqual(planSteps(project, GRBL), expected, `a Bottom operation exports turned about ${orientation.axis} (arc machine)`)
    assertEqual(planSteps(project, noArcs), expected, `a Bottom operation exports turned about ${orientation.axis} (no-arc machine)`)
  }

  // Spelled out once, so the expectation does not lean on the function under
  // test. Local = (x, 80 − y, 20 − z), machine = (x, 80 − localY, localZ − 20):
  // the cut 5 above the bottom face is 5 below the face that is now up, and
  // the clearance under the stock is above it.
  const aboutX = withBottomSetup(makeProject(['op1']), { operationIds: ['op1'] })
  assertEqual(planSteps(aboutX, GRBL, BOTTOM_MOVES), [
    { x: 10, y: 70, z: 5 },
    { x: 10, y: 70, z: -5 },
    { x: 30, y: 70, z: -5 },
    { x: 30, y: 60, z: -5 },
    { x: 30, y: 60, z: 5 },
  ], 'Bottom about X, in numbers')

  // A Bottom operation is the same program as a Top one whose toolpath was
  // turned by hand — for every dialect, since the turn is not theirs to make.
  const turnedByHand = MOVES.map((move) => ({
    ...move,
    from: canonicalToSetupPoint(move.from, setupFrame(BOTTOM_X, aboutX.stock)),
    to: canonicalToSetupPoint(move.to, setupFrame(BOTTOM_X, aboutX.stock)),
  }))
  for (const definition of [GRBL, SHOPBOT]) {
    const bottom = exportProgram(aboutX, definition)
    assertEqual(bottom, exportProgram(makeProject(['op1']), definition, turnedByHand), `${definition.id}: Bottom equals a hand-turned Top program`)
    assert(bottom !== exportProgram(makeProject(['op1']), definition), `${definition.id}: Bottom differs from the unturned program`)
  }
}

function testTopIsByteIdentical(): void {
  console.log('Testing Top with setups is byte-identical to a project without them...')
  const withSetups = makeProject(['op1', 'op2'])
  // The same project as a pre-setup build held it in memory: no `setups`, no `setupId`.
  const legacy = withoutSetupFields(withSetups) as unknown as Project
  assert(legacy.setups === undefined && legacy.operations[0].setupId === undefined, 'fixture: the legacy project has no setup fields')
  // What the pre-setup pipeline emitted for these moves, in numbers.
  assertEqual(planSteps(withSetups, GRBL), [
    { x: 10, y: 10, z: 5 },
    { x: 10, y: 10, z: -15 },
    { x: 30, y: 10, z: -15 },
    { x: 30, y: 20, z: -15 },
    { x: 30, y: 20, z: 5 },
  ], 'Top with setups is byte-identical: the legacy machine coordinates')
  for (const definition of [GRBL, SHOPBOT]) {
    for (const moves of [MOVES, circleMoves(15)]) {
      assertEqual(exportProgram(withSetups, definition, moves), exportProgram(legacy, definition, moves), `${definition.id}: Top with setups is byte-identical`)
    }
  }
  // A Bottom setup elsewhere in the project changes nothing for a Top operation.
  const mixed = withBottomSetup(makeProject(['op1', 'op2']), { operationIds: ['op2'] })
  assertEqual(planSteps(mixed, GRBL), planSteps(withSetups, GRBL), 'a Top operation beside a Bottom setup is unchanged')
}

function testArcDirectionFlips(): void {
  console.log('Testing XY arc direction flips for a Bottom operation...')
  const count = (program: string, word: string) => program.split('\n').filter((line) => line.startsWith(`${word} `)).length
  const moves = circleMoves(15)
  const top = exportProgram(makeProject(['op1']), GRBL, moves)
  assert(count(top, 'G2') + count(top, 'G3') > 0, 'fixture: the circle is arc-fitted')
  const topWord = count(top, 'G2') > 0 ? 'G2' : 'G3'
  const otherWord = topWord === 'G2' ? 'G3' : 'G2'
  assertEqual(count(top, otherWord), 0, 'fixture: Top arcs all turn one way')

  for (const axis of ['x', 'y'] as const) {
    const bottom = exportProgram(withBottomSetup(makeProject(['op1']), { axis, operationIds: ['op1'] }), GRBL, moves)
    assertEqual(count(bottom, otherWord), count(top, topWord), `flip about ${axis}: every arc turns the other way`)
    assertEqual(count(bottom, topWord), 0, `flip about ${axis}: no arc keeps its direction`)
  }
}

function testDrillCycles(): void {
  console.log('Testing Bottom drill cycles are turned...')
  const cycles: DrillCycle[] = [
    { x: 25, y: 30, clearZ: 30, retractZ: 22, bottomZ: 8, drillType: 'peck', peckDepth: 2 },
  ]
  const top = makeProject(['op1'], { kind: 'drilling' })
  // Top: (25 − 0, 80 − 30), Z − 20.
  assertEqual(
    planDrillCycles(top, GRBL, cycles, top.operations[0]).map(({ at, clear, bottomZ, retractZ }) => ({ at, clear, bottomZ, retractZ })),
    [{ at: { x: 25, y: 50 }, clear: { x: 25, y: 50, z: 10 }, bottomZ: -12, retractZ: 2 }],
    'Top drill cycles',
  )
  // The same hole drilled from below, in stock space: clearance and retract
  // sit under the bottom face and the drill stops 12 into the stock. About X,
  // local Y = 80 − 30 = 50 → machine Y 30, and local Z = 20 − Z puts every
  // height where the Top cycle had it.
  const fromBelow: DrillCycle[] = [
    { x: 25, y: 30, clearZ: -10, retractZ: -2, bottomZ: 12, drillType: 'peck', peckDepth: 2 },
  ]
  const bottom = withBottomSetup(top, { operationIds: ['op1'] })
  assertEqual(
    planDrillCycles(bottom, GRBL, fromBelow, bottom.operations[0]).map(({ at, clear, bottomZ, retractZ }) => ({ at, clear, bottomZ, retractZ })),
    [{ at: { x: 25, y: 30 }, clear: { x: 25, y: 30, z: 10 }, bottomZ: -12, retractZ: 2 }],
    'Bottom drill cycles',
  )
}

function testDanglingSetupIsRefused(): void {
  console.log('Testing an operation in a setup that does not exist is not exported as Top...')
  const project = makeProject(['op1'], { setupId: 'gone' })
  let threw = false
  try {
    planSteps(project, GRBL)
  } catch {
    threw = true
  }
  assert(threw, 'a dangling setup id stops the export')
}

testMachineTransform()
testSharedOrigin()
testBottomOperationExportsTurned()
testTopIsByteIdentical()
testArcDirectionFlips()
testDrillCycles()
testDanglingSetupIsRefused()

console.log('setup export tests passed')
