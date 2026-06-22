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
 * CAM Operation Smoke Tests — Phase 3 audit-and-fill (Area A).
 *
 * Fills holes not covered by existing suites:
 * - Pocket parallel + waterline pattern smokes
 * - Drilling drill-type differentiation (simple/peck/dwell/chip_breaking)
 * - Post smoke for thin operations (v_carve, surface_clean, follow_line,
 *   v_carve_recursive)
 * - Stock-target operation smoke
 *
 * Run with: npx tsx src/engine/toolpaths/camOperationSmoke.test.ts
 */

import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import type { MachineDefinition } from '../gcode/types'
import { normalizeToolForProject } from './geometry'
import type { ToolpathResult } from './types'
import { generatePocketToolpath } from './pocket'
import { generateDrillingToolpath } from './drilling'
import { generateVCarveToolpath } from './vcarve'
import { generateSurfaceCleanToolpath } from './surface'
import { generateFollowLineToolpath } from './carving'
import { generateVCarveRecursiveToolpath } from './vcarveRecursive'

// ── Helpers ──────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon
}

// ── Test runner ──────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────

function testMachineDefinition(): MachineDefinition {
  return validateMachineDefinition({
    id: 'test',
    name: 'Test',
    description: 'Test controller',
    builtin: false,
    fileExtension: 'nc',
    coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
    numberFormat: {
      decimalPlaces: { mm: 3, inch: 4 },
      trailingZeros: false,
      leadingZero: true,
    },
    units: { mmCommand: 'G21', inchCommand: 'G20' },
    program: {
      header: ['; {programName}'],
      footer: [],
      commentPrefix: ';',
      commentSuffix: '',
      lineNumbers: false,
      lineNumberIncrement: 10,
    },
    workCoordinates: { selectCommand: null },
    motion: {
      rapidCommand: 'G0',
      linearCommand: 'G1',
      cwArcCommand: 'G2',
      ccwArcCommand: 'G3',
      arcFormat: 'ij',
      modalMotion: true,
    },
    feedSpeed: {
      feedCommand: 'F',
      rpmCommand: 'S',
      spindleOnCW: 'M3',
      spindleOnCCW: 'M4',
      spindleOff: 'M5',
      inlineWithMotion: true,
      modalFeedSpeed: true,
    },
    toolChange: {
      commands: ['M0 ; Tool change: {toolName}'],
      stopSpindleFirst: true,
      pauseAfterChange: false,
      pauseCommand: 'M0',
    },
    cannedCycles: null,
    coolant: null,
    stop: { programEndCommand: 'M30' },
  })
}

function makeFlatEndmill(id: string, diameter = 4): Tool {
  const base = defaultTool('mm', 1)
  return {
    ...base,
    id,
    name: `${diameter} mm endmill`,
    diameter,
    defaultStepdown: 2,
    defaultStepover: 0.4,
  }
}

function makeVBit(id: string): Tool {
  const base = defaultTool('mm', 1)
  return {
    ...base,
    id,
    name: 'V-bit 60',
    type: 'v_bit',
    diameter: 6,
    vBitAngle: 60,
    defaultStepdown: 2,
    defaultStepover: 0.4,
  }
}

function makeDrill(id: string, diameter = 3): Tool {
  const base = defaultTool('mm', 1)
  return {
    ...base,
    id,
    name: `${diameter} mm drill`,
    type: 'drill' as const,
    diameter,
    defaultStepdown: 5,
    defaultStepover: 0,
  }
}

function makeRectFeature(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeCircleFeature(
  id: string,
  cx: number,
  cy: number,
  r: number,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: circleProfile(cx, cy, r),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeLineFeature(id: string, x1: number, y1: number, x2: number, y2: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: {
        start: { x: x1, y: y1 },
        segments: [{ type: 'line', to: { x: x2, y: y2 } }],
        closed: false,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makePocketOp(
  overrides: Partial<Operation> & Pick<Operation, 'kind' | 'target' | 'toolRef'>,
): Operation {
  const base: Operation = {
    id: 'op1',
    name: 'op',
    kind: overrides.kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: overrides.target,
    toolRef: overrides.toolRef,
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
  return { ...base, ...overrides }
}

function baseProject(tools: Tool[], features: SketchFeature[]): Project {
  const project = newProject('test', 'mm')
  return {
    ...project,
    tools,
    features,
  }
}

/** Post a toolpath through the real postprocessor and return the G-code string. */
function postToolpath(
  project: Project,
  operation: Operation,
  toolpath: ToolpathResult,
): string {
  const toolRecord = project.tools.find((t) => t.id === operation.toolRef!)!
  const result = runPostProcessor({
    project,
    definition: testMachineDefinition(),
    operations: [{
      operation,
      tool: normalizeToolForProject(toolRecord, project),
      toolpath,
    }],
    options: {
      emitToolChanges: true,
      emitCoolant: false,
      programName: project.meta.name,
    },
  })
  return result.gcode
}

// =====================================================================
// 1. POCKET — parallel + waterline pattern smokes
// =====================================================================

console.log('\nPocket parallel + waterline patterns')

test('pocket parallel pattern: generates non-empty toolpath + posts', () => {
  const tool = makeFlatEndmill('t1', 4)
  const feat = makeRectFeature('a', 0, 0, 20, 20, 0, -4)
  const project = baseProject([tool], [feat])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    pocketPattern: 'parallel',
    pocketAngle: 45,
  })

  const result = generatePocketToolpath(project, op)
  assert(result.moves.length > 0, 'parallel pocket should produce moves')
  // Parallel pattern should produce cut moves (not just warnings)
  const cuts = result.moves.filter((m) => m.kind === 'cut')
  assert(cuts.length > 0, 'parallel pocket should produce cut moves')

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'parallel pocket should produce non-empty G-code')
  assert(gcode.includes('M30'), 'G-code should include program end')
})

test('pocket waterline pattern: generates non-empty toolpath + posts', () => {
  const tool = makeFlatEndmill('t1', 4)
  const feat = makeRectFeature('a', 0, 0, 20, 20, 0, -4)
  const project = baseProject([tool], [feat])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    pocketPattern: 'waterline',
  })

  const result = generatePocketToolpath(project, op)
  assert(result.moves.length > 0, 'waterline pocket should produce moves')
  const cuts = result.moves.filter((m) => m.kind === 'cut')
  assert(cuts.length > 0, 'waterline pocket should produce cut moves')

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'waterline pocket should produce non-empty G-code')
})

// =====================================================================
// 2. DRILLING — drill-type differentiation
// =====================================================================

console.log('\nDrilling drill-type differentiation')

function drillingFixture(drillType: 'simple' | 'peck' | 'dwell' | 'chip_breaking', peckDepth?: number): {
  project: Project
  operation: Operation
} {
  const tool = makeDrill('t1', 3)
  const circle = makeCircleFeature('c1', 20, 20, 5, 0, -6)
  const project = baseProject([tool], [circle])
  const op = makePocketOp({
    kind: 'drilling',
    target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1',
    stepdown: 2,
    drillType,
    peckDepth,
  })
  return { project, operation: op }
}

test('drilling simple: single plunge + rapid retract', () => {
  const { project, operation } = drillingFixture('simple')
  const result = generateDrillingToolpath(project, operation)
  assert(result.moves.length > 0, 'simple drilling should produce moves')

  const plunges = result.moves.filter((m) => m.kind === 'plunge')
  assert(plunges.length === 1, `simple drilling should have 1 plunge, got ${plunges.length}`)

  const gcode = postToolpath(project, operation, result)
  assert(gcode.length > 0, 'simple drilling should produce non-empty G-code')
})

test('drilling peck: multiple plunges with full retracts', () => {
  const { project, operation } = drillingFixture('peck', 2)
  const result = generateDrillingToolpath(project, operation)
  assert(result.moves.length > 0, 'peck drilling should produce moves')

  const plunges = result.moves.filter((m) => m.kind === 'plunge')
  // With z_top=0, z_bottom=-6, peckDepth=2 → at least 3 pecks
  assert(plunges.length >= 3, `peck drilling should have >= 3 plunges, got ${plunges.length}`)

  // Peck drilling uses full retract to safeZ between pecks
  const rapids = result.moves.filter((m) => m.kind === 'rapid')
  const safeZ = project.stock.thickness + project.meta.operationClearanceZ
  const retractToSafe = rapids.filter((m) => approx(m.to.z, safeZ))
  assert(retractToSafe.length >= 2, `peck should have >= 2 full retracts to safeZ=${safeZ}, got ${retractToSafe.length}`)

  const gcode = postToolpath(project, operation, result)
  assert(gcode.length > 0, 'peck drilling should produce non-empty G-code')
})

test('drilling dwell: single plunge (same as simple at toolpath level)', () => {
  const { project, operation } = drillingFixture('dwell')
  const result = generateDrillingToolpath(project, operation)
  assert(result.moves.length > 0, 'dwell drilling should produce moves')

  // Dwell is the same as simple at the toolpath level — one plunge, one retract
  const plunges = result.moves.filter((m) => m.kind === 'plunge')
  assert(plunges.length === 1, `dwell drilling should have 1 plunge, got ${plunges.length}`)

  const gcode = postToolpath(project, operation, result)
  assert(gcode.length > 0, 'dwell drilling should produce non-empty G-code')
})

test('drilling chip_breaking: multiple plunges with small retracts', () => {
  const { project, operation } = drillingFixture('chip_breaking', 2)
  const result = generateDrillingToolpath(project, operation)
  assert(result.moves.length > 0, 'chip_breaking drilling should produce moves')

  const plunges = result.moves.filter((m) => m.kind === 'plunge')
  // With z_top=0, z_bottom=-6, peckDepth=2 → at least 3 pecks
  assert(plunges.length >= 3, `chip_breaking should have >= 3 plunges, got ${plunges.length}`)

  // Chip breaking uses small retracts (0.5mm), NOT full retract to safeZ
  const rapids = result.moves.filter((m) => m.kind === 'rapid')
  const safeZ = project.stock.thickness + project.meta.operationClearanceZ
  const retractToSafe = rapids.filter((m) => approx(m.to.z, safeZ))
  // Chip-breaking should end with a final safeZ retract
  assert(retractToSafe.length >= 1, 'chip_breaking should have at least the final safeZ retract')
  // Between pecks, retracts should be small (~0.5mm chip-break clearance), not full safeZ
  const chipBreakRetracts = rapids.filter(
    (m) => !approx(m.to.z, safeZ) && m.to.z < safeZ,
  )
  assert(chipBreakRetracts.length >= 2, `chip_breaking should have >= 2 small chip-break retracts (not at safeZ), got ${chipBreakRetracts.length}`)

  const gcode = postToolpath(project, operation, result)
  assert(gcode.length > 0, 'chip_breaking should produce non-empty G-code')
})

// ---------------------------------------------------------------------
// NOTE: Canned cycles (G81/G82/G83/G73) are NOT currently emitted by the
// postprocessor. The drill-type differentiation lives at the toolpath
// generation level only. The postprocessor emits all moves as G0/G1.
// The MachineDefinition.cannedCycles schema exists but is not wired into
// runPostProcessor. This is a known deferred feature, not a regression.
// ---------------------------------------------------------------------

// =====================================================================
// 3. POST SMOKE for thin operations
// =====================================================================

console.log('\nPost smoke — thin operations')

test('v_carve: generates toolpath + posts to non-empty G-code', () => {
  const tool = makeVBit('t1')
  const feat = makeRectFeature('a', 0, 0, 10, 10, 0, -2)
  const project = baseProject([tool], [feat])
  const op = makePocketOp({
    kind: 'v_carve',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    maxCarveDepth: 2,
    stepover: 0.3,
  })

  const result = generateVCarveToolpath(project, op)
  assert(result.moves.length > 0, 'v_carve should produce moves')
  const cuts = result.moves.filter((m) => m.kind === 'cut')
  assert(cuts.length > 0, 'v_carve should produce cut moves')

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'v_carve should produce non-empty G-code')
})

test('surface_clean: generates toolpath + posts to non-empty G-code', () => {
  const tool = makeFlatEndmill('t1', 4)
  // surface_clean requires add features (cleans around bosses/pads)
  const feat: SketchFeature = {
    ...makeRectFeature('a', 0, 0, 20, 20, 4, 0),
    operation: 'add',
  }
  const project = baseProject([tool], [feat])
  const op = makePocketOp({
    kind: 'surface_clean',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.4,
  })

  const result = generateSurfaceCleanToolpath(project, op)
  assert(result.moves.length > 0, 'surface_clean should produce moves')
  const cuts = result.moves.filter((m) => m.kind === 'cut')
  assert(cuts.length > 0, 'surface_clean should produce cut moves')

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'surface_clean should produce non-empty G-code')
})

test('follow_line: generates toolpath + posts to non-empty G-code', () => {
  const tool = makeFlatEndmill('t1', 1)
  const line = makeLineFeature('line1', 0, 5, 10, 5)
  const project = baseProject([tool], [line])
  const op = makePocketOp({
    kind: 'follow_line',
    target: { source: 'features', featureIds: ['line1'] },
    toolRef: 't1',
    carveDepth: 1,
  })

  const result = generateFollowLineToolpath(project, op)
  assert(result.moves.length > 0, 'follow_line should produce moves')
  const cuts = result.moves.filter((m) => m.kind === 'cut')
  assert(cuts.length > 0, 'follow_line should produce cut moves')

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'follow_line should produce non-empty G-code')
})

test('v_carve_recursive: generates toolpath + posts to non-empty G-code', () => {
  const tool = makeVBit('t1')
  const feat = makeRectFeature('a', 0, 0, 10, 10, 0, -2)
  const project = baseProject([tool], [feat])
  const op = makePocketOp({
    kind: 'v_carve_recursive',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    maxCarveDepth: 2,
    stepover: 0.3,
  })

  const result = generateVCarveRecursiveToolpath(project, op)
  assert(result.moves.length > 0, 'v_carve_recursive should produce moves')

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'v_carve_recursive should produce non-empty G-code')
})

// =====================================================================
// 4. STOCK TARGET — discovered gap (no resolver supports stock target)
// =====================================================================
//
// AUDIT FINDING: `resolvePocketRegions` (resolver.ts:235) requires
// `target.source === 'features'` and rejects stock targets with
// "Pocket operation has no feature targets". Similarly, the other
// resolvers (edge, drilling, surface) do not accept stock-source
// targets. Stock-target operations are a deferred feature — the
// OperationTarget model accepts `source: 'stock'` but no toolpath
// resolver implements it. Deferred to a future planning cycle.
// =====================================================================

// =====================================================================
// Summary
// =====================================================================

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
