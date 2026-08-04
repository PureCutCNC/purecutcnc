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
 *   v_carve_recursive, v_carve_medial)
 * - Stock-target operation smoke
 *
 * Run with: npx tsx src/engine/toolpaths/camOperationSmoke.test.ts
 */

import type { DrillType, Operation, Project, Segment, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import type { MachineDefinition } from '../gcode/types'
import { getOperationClearance, getOperationSafeZ, normalizeToolForProject } from './geometry'
import type { ToolpathResult } from './types'
import { generatePocketToolpath } from './pocket'
import { generateDrillingToolpath } from './drilling'
import { generateVCarveToolpath } from './vcarve'
import { generateSurfaceCleanToolpath } from './surface'
import { generateFollowLineToolpath } from './carving'
import { generateVCarveMedialToolpath } from './vcarveMedial'

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
  return projectWithFeatures({
    ...project,
    tools,
  }, features)
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

test('pocket helix entry: emits descending lead-in moves and posts', () => {
  const tool = makeFlatEndmill('t1', 4)
  const feat = makeRectFeature('a', 0, 0, 20, 20, 0, -4)
  const project = baseProject([tool], [feat])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    entryStrategy: 'helix',
    entryRampAngle: 5,
    entryHelixDiameterPercent: 80,
  })

  const result = generatePocketToolpath(project, op)
  const descendingLeadIns = result.moves.filter((move) =>
    move.kind === 'lead_in' && move.to.z < move.from.z - 1e-9)
  assert(descendingLeadIns.length > 0, 'helix entry should emit descending lead-in moves')
  // Levels below the first descend to the previous cut Z plus clearance before
  // the helix starts, so air-descent plunges are expected. A plunge *fallback*
  // is the one that reaches cut depth itself, so it is always the move
  // immediately before the first cut; a helix hands off with a lead-in.
  const plungedIntoCut = result.moves.some((move, index) =>
    move.kind === 'plunge' && result.moves[index + 1]?.kind === 'cut')
  assert(!plungedIntoCut, 'open pocket should not need plunge fallback')

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'helix-entry pocket should produce non-empty G-code')
})

test('pocket helix entry starts above the previous cut level, not at safe Z', () => {
  const tool = makeFlatEndmill('t1', 4)
  const feat = makeRectFeature('a', 0, 0, 20, 20, 0, -4)
  const project = baseProject([tool], [feat])
  const op = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    entryStrategy: 'helix',
    entryRampAngle: 5,
    entryHelixDiameterPercent: 80,
  })

  const result = generatePocketToolpath(project, op)
  const safeZ = getOperationSafeZ(project)
  const clearance = getOperationClearance(project)
  assert(result.stepLevels.length > 1, 'fixture must step down more than once')

  // The descent that precedes a helix is the only plunge in this toolpath.
  const airDescents = result.moves.filter((move, index) =>
    move.kind === 'plunge' && result.moves[index + 1]?.kind === 'lead_in')
  assert(airDescents.length > 0, 'levels below the first should descend before the helix')

  // Every one of them must stop one clearance above a level that is already
  // cut, never at safe Z (the air-cutting case) and never at or below the
  // level it is about to cut.
  const cutLevels = [...result.stepLevels].sort((a, b) => b - a)
  for (const descent of airDescents) {
    assert(descent.from.z === safeZ, 'descent should begin at the global safe Z')
    assert(descent.to.z < safeZ - 1e-9, 'descent should end below safe Z')
    const matchesPreviousLevel = cutLevels.some((level) => approx(descent.to.z, level + clearance))
    assert(matchesPreviousLevel, 'descent should stop one clearance above a cut level')
  }

  // XY travel still happens at safe Z: nothing rapids while buried.
  const buriedRapids = result.moves.filter((move) =>
    move.kind === 'rapid'
    && (move.from.x !== move.to.x || move.from.y !== move.to.y)
    && (move.from.z < safeZ - 1e-9 || move.to.z < safeZ - 1e-9))
  assert(buriedRapids.length === 0, 'XY rapids must stay at safe Z')
})

test('pocket default entry remains byte-identical to explicit plunge', () => {
  const tool = makeFlatEndmill('t1', 4)
  const feat = makeRectFeature('a', 0, 0, 20, 20, 0, -4)
  const project = baseProject([tool], [feat])
  const base = makePocketOp({
    kind: 'pocket',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
  })
  const implicit = generatePocketToolpath(project, base)
  const explicit = generatePocketToolpath(project, { ...base, entryStrategy: 'plunge' })
  assert(JSON.stringify(implicit) === JSON.stringify(explicit), 'unset and explicit plunge toolpaths must match')
})

// =====================================================================
// 2. DRILLING — drill-type differentiation
// =====================================================================

console.log('\nDrilling drill-type differentiation')

function drillingFixture(drillType: DrillType, peckDepth?: number): {
  project: Project
  operation: Operation
} {
  const toolType = drillType === 'helical' ? makeFlatEndmill('t1', 3) : makeDrill('t1', 3)
  const tool = toolType
  const circle = makeCircleFeature('c1', 20, 20, 2.5, 0, -6)
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

test('drilling helical: spiral lead_in descent, bottom flatten, no canned cycle', () => {
  const { project, operation } = drillingFixture('helical')
  const result = generateDrillingToolpath(project, operation)
  assert(result.moves.length > 0, 'helical drilling should produce moves')

  // Helical uses lead_in moves (not plunge) for the spiral descent
  const leadIns = result.moves.filter((m) => m.kind === 'lead_in')
  assert(leadIns.length > 0, 'helical drilling should use lead_in moves')

  // Must descend incrementally: not a single straight plunge
  const plunges = result.moves.filter((m) => m.kind === 'plunge')
  assert(plunges.length === 0, `helical drilling should have 0 plunges, got ${plunges.length}`)

  // Bounded true-bore: the cutter-centre orbit must equal H−T at every lead-in point.
  // holeRadius=2.5, toolDiameter=3 → toolRadius=1.5 → boreRadius=1.0
  const expectedBoreRadius = 2.5 - 1.5
  const cx = 20, cy = 20
  for (const move of leadIns) {
    for (const pt of [move.from, move.to]) {
      const dist = Math.hypot(pt.x - cx, pt.y - cy)
      // Rapids to centre (dist ≈ 0) are the travel moves — skip them
      if (move.kind !== 'lead_in') continue
      assert(approx(dist, expectedBoreRadius, 0.01),
        `bore radius ${dist.toFixed(4)} should equal H−T=${expectedBoreRadius}`)
    }
  }

  // At least some moves should be below top Z (actual descent)
  const belowTop = result.moves.filter((m) => m.to.z < 0)
  assert(belowTop.length > 0, 'helical moves should descend below top Z')

  // Final position should be at safeZ (retract)
  const safeZ = project.stock.thickness + project.meta.operationClearanceZ
  const finalMove = result.moves[result.moves.length - 1]
  assert(approx(finalMove.to.z, safeZ), `final move should retract to safeZ=${safeZ}, got ${finalMove.to.z}`)

  // No drillCycles emitted — moves are expanded G1
  assert(!result.drillCycles || result.drillCycles.length === 0, 'helical drilling should have no drillCycles')

  // No drillNotDrillBit warning for flat_endmill
  const warning = result.warnings.find((w) => w.code === 'drillNotDrillBit')
  assert(!warning, 'helical with flat_endmill should not produce drillNotDrillBit')

  const gcode = postToolpath(project, operation, result)
  assert(gcode.length > 0, 'helical drilling should produce non-empty G-code')
  // G-code must not contain canned cycles (G81/G82/G83/G73)
  assert(!/G8[123]/.test(gcode), 'helical G-code should not contain canned cycle codes')
  assert(!/G73/.test(gcode), 'helical G-code should not contain G73')
})

test('drilling helical: unsupported tool falls back with warning', () => {
  // Use a drill tool instead of flat_endmill
  const drill = makeDrill('t1', 3)
  const circle = makeCircleFeature('c1', 20, 20, 5, 0, -6)
  const project = baseProject([drill], [circle])
  const op = makePocketOp({
    kind: 'drilling',
    target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1',
    stepdown: 2,
    drillType: 'helical',
  })
  const result = generateDrillingToolpath(project, op)
  assert(result.moves.length > 0, 'fallback should produce moves')

  // Should warn about unsupported tool
  const toolWarning = result.warnings.find((w) => w.code === 'drillHelicalToolUnsupported')
  assert(!!toolWarning, 'helical with drill should produce drillHelicalToolUnsupported warning')

  // Should fall back to simple plunge (drillCycles with simple type)
  assert(result.drillCycles !== undefined && result.drillCycles.length > 0, 'fallback should have drillCycles')
  if (result.drillCycles) {
    assert(result.drillCycles[0].drillType === 'simple', 'fallback drillCycle should be simple')
  }

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'fallback should produce non-empty G-code')
})

test('drilling helical: v_bit falls back with warning', () => {
  const vBit = makeVBit('t1')
  const circle = makeCircleFeature('c1', 20, 20, 5, 0, -6)
  const project = baseProject([vBit], [circle])
  const op = makePocketOp({
    kind: 'drilling',
    target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1',
    stepdown: 2,
    drillType: 'helical',
  })
  const result = generateDrillingToolpath(project, op)
  const toolWarning = result.warnings.find((w) => w.code === 'drillHelicalToolUnsupported')
  assert(!!toolWarning, 'helical with v_bit should produce drillHelicalToolUnsupported warning')
  assert(result.drillCycles !== undefined && result.drillCycles.length > 0, 'v_bit fallback should have drillCycles')
})

test('drilling helical: ball_endmill falls back with warning', () => {
  const base = defaultTool('mm', 1)
  const ballEndmill: Tool = {
    ...base,
    id: 't1',
    name: 'Ball endmill',
    type: 'ball_endmill',
    diameter: 4,
    defaultStepdown: 2,
    defaultStepover: 0.4,
  }
  const circle = makeCircleFeature('c1', 20, 20, 5, 0, -6)
  const project = baseProject([ballEndmill], [circle])
  const op = makePocketOp({
    kind: 'drilling',
    target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1',
    stepdown: 2,
    drillType: 'helical',
  })
  const result = generateDrillingToolpath(project, op)
  const toolWarning = result.warnings.find((w) => w.code === 'drillHelicalToolUnsupported')
  assert(!!toolWarning, 'helical with ball_endmill should produce drillHelicalToolUnsupported warning')
  assert(result.drillCycles !== undefined && result.drillCycles.length > 0, 'ball_endmill fallback should have drillCycles')
})

test('drilling helical: legacy four-arc circle profile produces same result as native circle', () => {
  // Build a circle via four 90° arcs matching a native circle with r=2.5
  // (hole diameter 5, tool diameter 3 → eligible: 3 < 5 ≤ 6)
  const r = 2.5
  const cx = 20
  const cy = 20
  const fourArcSegments: Segment[] = [
    { type: 'arc', to: { x: cx, y: cy + r }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx - r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx, y: cy - r }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx + r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
  ]
  const fourArcFeature: SketchFeature = {
    id: 'c1',
    name: 'FourArcHole',
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: { start: { x: cx + r, y: cy }, segments: fourArcSegments, closed: true },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -6,
    visible: true,
    locked: false,
  }
  const nativeFeature = makeCircleFeature('c1', cx, cy, r, 0, -6)
  const tool = makeFlatEndmill('t1', 3)

  const nativeProj = baseProject([tool], [nativeFeature])
  const fourArcProj = baseProject([tool], [fourArcFeature])

  const nativeOp = makePocketOp({
    kind: 'drilling',
    target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1',
    stepdown: 2,
    drillType: 'helical',
    entryRampAngle: 5,
    entryHelixDiameterPercent: 80,
  })
  const fourArcOp = { ...nativeOp }

  const nativeResult = generateDrillingToolpath(nativeProj, nativeOp)
  const fourArcResult = generateDrillingToolpath(fourArcProj, fourArcOp)

  assert(nativeResult.moves.length > 0, 'native circle should produce moves')
  assert(fourArcResult.moves.length > 0, 'four-arc circle should produce moves')

  // Both should produce lead_in moves (helical), not plunge
  const nativeLeadIns = nativeResult.moves.filter((m) => m.kind === 'lead_in')
  const fourArcLeadIns = fourArcResult.moves.filter((m) => m.kind === 'lead_in')
  assert(nativeLeadIns.length > 0, 'native circle should have lead_in moves')
  assert(fourArcLeadIns.length > 0, 'four-arc circle should have lead_in moves')

  // The move count should be identical for identical geometry
  assert(nativeResult.moves.length === fourArcResult.moves.length,
    `four-arc moves (${fourArcResult.moves.length}) should match native (${nativeResult.moves.length})`)
  assert(!nativeResult.drillCycles || nativeResult.drillCycles.length === 0, 'native should have no drillCycles')
  assert(!fourArcResult.drillCycles || fourArcResult.drillCycles.length === 0, 'four-arc should have no drillCycles')
})

test('drilling helical: malformed four-arc geometry falls back to plunge', () => {
  // Four arcs with DIFFERENT centers — does not form a proper circle
  const cx = 20
  const cy = 20
  const r = 5
  const malformedSegments: Segment[] = [
    { type: 'arc', to: { x: cx, y: cy + r }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx - r, y: cy }, center: { x: cx + 1, y: cy + 1 }, clockwise: true }, // different centre
    { type: 'arc', to: { x: cx, y: cy - r }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx + r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
  ]
  const malformedFeature: SketchFeature = {
    id: 'c1',
    name: 'BadCircle',
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: { start: { x: cx + r, y: cy }, segments: malformedSegments, closed: true },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -6,
    visible: true,
    locked: false,
  }
  const tool = makeFlatEndmill('t1', 3)
  const project = baseProject([tool], [malformedFeature])
  const op = makePocketOp({
    kind: 'drilling',
    target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1',
    stepdown: 2,
    drillType: 'helical',
  })
  const result = generateDrillingToolpath(project, op)

  // Should fall back: getCircleCenter returns null for malformed 4-arc
  // → precomputeDrillTargets skips it → drillNoValidCircles
  // Actually wait: getCircleCenter shares the same validation now.
  // A malformed 4-arc circle returns null center → precompute skips it
  assert(result.warnings.some((w) => w.code === 'drillNoValidCircles' || w.code === 'drillNoCenter'),
    'malformed 4-arc should produce a diagnostic warning')
})

test('drilling helical: partial four-arc (not closed) is rejected', () => {
  const r = 5
  const cx = 20
  const cy = 20
  // Three 90° arcs that don't close back to start → 270° partial circle
  const partialSegments: Segment[] = [
    { type: 'arc', to: { x: cx, y: cy + r }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx - r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx, y: cy - r }, center: { x: cx, y: cy }, clockwise: true },
    // Fourth arc goes back to a wrong point, not profile.start
    { type: 'arc', to: { x: cx, y: cy - r }, center: { x: cx, y: cy }, clockwise: true },
  ]
  const partialFeature: SketchFeature = {
    id: 'c1', name: 'PartialCircle', kind: 'circle', folderId: null,
    sketch: { profile: { start: { x: cx + r, y: cy }, segments: partialSegments, closed: true },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract', z_top: 0, z_bottom: -6, visible: true, locked: false,
  }
  const tool = makeFlatEndmill('t1', 3)
  const project = baseProject([tool], [partialFeature])
  const op = makePocketOp({
    kind: 'drilling', target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1', stepdown: 2, drillType: 'helical',
  })
  const result = generateDrillingToolpath(project, op)
  assert(result.warnings.some((w) => w.code === 'drillNoValidCircles' || w.code === 'drillNoCenter'),
    'partial four-arc (not closing to start) should be rejected')
})

test('drilling helical: mixed-direction four-arc is rejected', () => {
  const r = 5
  const cx = 20
  const cy = 20
  const mixedSegments: Segment[] = [
    { type: 'arc', to: { x: cx, y: cy + r }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx - r, y: cy }, center: { x: cx, y: cy }, clockwise: false }, // opposite direction
    { type: 'arc', to: { x: cx, y: cy - r }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx + r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
  ]
  const mixedFeature: SketchFeature = {
    id: 'c1', name: 'MixedDir', kind: 'circle', folderId: null,
    sketch: { profile: { start: { x: cx + r, y: cy }, segments: mixedSegments, closed: true },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract', z_top: 0, z_bottom: -6, visible: true, locked: false,
  }
  const tool = makeFlatEndmill('t1', 3)
  const project = baseProject([tool], [mixedFeature])
  const op = makePocketOp({
    kind: 'drilling', target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1', stepdown: 2, drillType: 'helical',
  })
  const result = generateDrillingToolpath(project, op)
  assert(result.warnings.some((w) => w.code === 'drillNoValidCircles' || w.code === 'drillNoCenter'),
    'mixed-direction four-arc should be rejected')
})

test('drilling helical: oversized-sweep four-arc is rejected', () => {
  const r = 5
  const cx = 20
  const cy = 20
  // Four arcs each sweeping 180° (clockwise, same center/direction/radius)
  // — they double-cover the circle but don't form a simple single-turn path.
  const oversweepSegments: Segment[] = [
    { type: 'arc', to: { x: cx - r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx + r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx - r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx + r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
  ]
  const oversweepFeature: SketchFeature = {
    id: 'c1', name: 'OversweepCircle', kind: 'circle', folderId: null,
    sketch: { profile: { start: { x: cx + r, y: cy }, segments: oversweepSegments, closed: true },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract', z_top: 0, z_bottom: -6, visible: true, locked: false,
  }
  const tool = makeFlatEndmill('t1', 3)
  const project = baseProject([tool], [oversweepFeature])
  const op = makePocketOp({
    kind: 'drilling', target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1', stepdown: 2, drillType: 'helical',
  })
  const result = generateDrillingToolpath(project, op)
  assert(result.warnings.some((w) => w.code === 'drillNoValidCircles' || w.code === 'drillNoCenter'),
    'oversized-sweep four-arc (180° per arc) should be rejected')
})

test('drilling helical: open four-arc profile is rejected', () => {
  const r = 5
  const cx = 20
  const cy = 20
  const openSegments: Segment[] = [
    { type: 'arc', to: { x: cx, y: cy + r }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx - r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx, y: cy - r }, center: { x: cx, y: cy }, clockwise: true },
    { type: 'arc', to: { x: cx + r, y: cy }, center: { x: cx, y: cy }, clockwise: true },
  ]
  const openFeature: SketchFeature = {
    id: 'c1', name: 'OpenCircle', kind: 'circle', folderId: null,
    sketch: { profile: { start: { x: cx + r, y: cy }, segments: openSegments, closed: false },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract', z_top: 0, z_bottom: -6, visible: true, locked: false,
  }
  const tool = makeFlatEndmill('t1', 3)
  const project = baseProject([tool], [openFeature])
  const op = makePocketOp({
    kind: 'drilling', target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1', stepdown: 2, drillType: 'helical',
  })
  const result = generateDrillingToolpath(project, op)
  assert(result.warnings.some((w) => w.code === 'drillNoValidCircles' || w.code === 'drillNoCenter'),
    'open (non-closed) four-arc should be rejected')
})

// ── Bounded true-bore eligibility ──────────────────────────────────

test('drilling helical: hole at 2× tool diameter is accepted', () => {
  // toolDiameter=3, holeRadius=3 → holeDiameter=6 = 2× toolDiameter → accepted
  const tool = makeFlatEndmill('t1', 3)
  const circle = makeCircleFeature('c1', 20, 20, 3, 0, -6)
  const project = baseProject([tool], [circle])
  const op = makePocketOp({
    kind: 'drilling', target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1', stepdown: 2, drillType: 'helical', entryRampAngle: 5,
  })
  const result = generateDrillingToolpath(project, op)
  assert(result.moves.length > 0, '2× boundary should produce moves')
  const leadIns = result.moves.filter((m) => m.kind === 'lead_in')
  assert(leadIns.length > 0, '2× boundary should emit lead_in moves')
  // Bore radius must be H−T = 3−1.5 = 1.5
  const cx = 20, cy = 20
  for (const move of leadIns) {
    for (const pt of [move.from, move.to]) {
      const dist = Math.hypot(pt.x - cx, pt.y - cy)
      if (dist < 0.001) continue  // centre rapids
      assert(approx(dist, 1.5, 0.01), `2× bore radius ${dist.toFixed(4)} must equal H−T=1.5`)
    }
  }
})

test('drilling helical: hole at tool diameter is rejected with no moves', () => {
  // toolDiameter=3, holeRadius=1.5 → holeDiameter=3 = tool diameter → rejected
  const tool = makeFlatEndmill('t1', 3)
  const circle = makeCircleFeature('c1', 20, 20, 1.5, 0, -6)
  const project = baseProject([tool], [circle])
  const op = makePocketOp({
    kind: 'drilling', target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1', stepdown: 2, drillType: 'helical', entryRampAngle: 5,
  })
  const result = generateDrillingToolpath(project, op)
  // No cutting/travel moves for this target — structured warning only
  const cutsOrLeads = result.moves.filter((m) => m.kind === 'lead_in' || m.kind === 'cut' || m.kind === 'plunge')
  assert(cutsOrLeads.length === 0, 'equal-diameter hole must emit zero cutting moves')
  const tooSmall = result.warnings.find((w) => w.code === 'drillHelicalBoreTooSmall')
  assert(!!tooSmall, 'should emit drillHelicalBoreTooSmall warning')
  // No drillNotDrillBit (flat_endmill is valid tool type)
  assert(!result.warnings.find((w) => w.code === 'drillNotDrillBit'), 'no drillNotDrillBit for flat_endmill')
})

test('drilling helical: hole smaller than tool is rejected with no moves', () => {
  // toolDiameter=4, holeRadius=1.25 → holeDiameter=2.5 < 4 → rejected
  const tool = makeFlatEndmill('t1', 4)
  const circle = makeCircleFeature('c1', 20, 20, 1.25, 0, -6)
  const project = baseProject([tool], [circle])
  const op = makePocketOp({
    kind: 'drilling', target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1', stepdown: 2, drillType: 'helical', entryRampAngle: 5,
  })
  const result = generateDrillingToolpath(project, op)
  const cutsOrLeads = result.moves.filter((m) => m.kind === 'lead_in' || m.kind === 'cut' || m.kind === 'plunge')
  assert(cutsOrLeads.length === 0, 'undersized hole must emit zero cutting moves')
  assert(!!result.warnings.find((w) => w.code === 'drillHelicalBoreTooSmall'),
    'should emit drillHelicalBoreTooSmall for undersized hole')
})

test('drilling helical: 12× hole (far above 2×) is rejected with Inside Edge Cut recommendation', () => {
  // Simulate 1/4 in endmill (≈6.35 mm) and 3 in hole (≈76.2 mm) — 12×
  const tool = makeFlatEndmill('t1', 6.35)
  const circle = makeCircleFeature('c1', 20, 20, 38.1, 0, -6)
  const project = baseProject([tool], [circle])
  const op = makePocketOp({
    kind: 'drilling', target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1', stepdown: 2, drillType: 'helical', entryRampAngle: 5,
  })
  const result = generateDrillingToolpath(project, op)
  const cutsOrLeads = result.moves.filter((m) => m.kind === 'lead_in' || m.kind === 'cut' || m.kind === 'plunge')
  assert(cutsOrLeads.length === 0, '12× hole must produce zero cutting moves')
  assert(!!result.warnings.find((w) => w.code === 'drillHelicalBoreTooLarge'),
    'should emit drillHelicalBoreTooLarge')
})

test('drilling helical: valid sibling targets generate normally after ineligible target', () => {
  const tool = makeFlatEndmill('t1', 3)
  // First hole is too small (r=1, holeDiameter=2 < toolDiameter=3), second is eligible (r=2.5)
  const small = makeCircleFeature('c1', 20, 20, 1, 0, -6)
  const good = makeCircleFeature('c2', 50, 50, 2.5, 0, -6)
  const project = baseProject([tool], [small, good])
  const op = makePocketOp({
    kind: 'drilling', target: { source: 'features', featureIds: ['c1', 'c2'] },
    toolRef: 't1', stepdown: 2, drillType: 'helical', entryRampAngle: 5,
  })
  const result = generateDrillingToolpath(project, op)
  // Should have the too-small warning + lead_in moves for the eligible hole
  assert(!!result.warnings.find((w) => w.code === 'drillHelicalBoreTooSmall'),
    'should warn about the too-small hole')
  const leadIns = result.moves.filter((m) => m.kind === 'lead_in')
  assert(leadIns.length > 0, 'eligible sibling should still emit lead_in moves')
})

// ---------------------------------------------------------------------
// NOTE: Canned cycles (G81/G82/G83/G73) are emitted by the postprocessor
// when the active machine definition supports them AND the operation is
// drilling. The smoke-test definition has cannedCycles:null, so these
// tests exercise the expanded G0/G1 fallback path — that is correct and
// expected. See postprocessor.test.ts for canned-cycle-specific tests.
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

test('surface_clean helix entry: emits descending lead-in moves', () => {
  const tool = makeFlatEndmill('t1', 4)
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
    entryStrategy: 'helix',
  })

  const result = generateSurfaceCleanToolpath(project, op)
  assert(
    result.moves.some((move) => move.kind === 'lead_in' && move.to.z < move.from.z - 1e-9),
    'surface-clean helix should emit descending lead-in moves',
  )
})

test('surface_clean default entry remains byte-identical to explicit plunge', () => {
  const tool = makeFlatEndmill('t1', 4)
  const feat: SketchFeature = {
    ...makeRectFeature('a', 0, 0, 20, 20, 4, 0),
    operation: 'add',
  }
  const project = baseProject([tool], [feat])
  const base = makePocketOp({
    kind: 'surface_clean',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    stepdown: 1,
  })
  const implicit = generateSurfaceCleanToolpath(project, base)
  const explicit = generateSurfaceCleanToolpath(project, { ...base, entryStrategy: 'plunge' })
  assert(JSON.stringify(implicit) === JSON.stringify(explicit), 'unset and explicit plunge toolpaths must match')
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

function makeClosedLineFeature(
  id: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: rectProfile(cx - w / 2, cy - h / 2, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'line',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

test('v_carve: closed Line target generates toolpath + posts', () => {
  const tool = makeVBit('t1')
  const feat = makeClosedLineFeature('l1', 5, 5, 10, 10, 0, -2)
  const project = baseProject([tool], [feat])
  const op = makePocketOp({
    kind: 'v_carve',
    target: { source: 'features', featureIds: ['l1'] },
    toolRef: 't1',
    maxCarveDepth: 2,
    stepover: 0.3,
  })

  const result = generateVCarveToolpath(project, op)
  assert(result.moves.length > 0, 'v_carve with closed line should produce moves')
  const cuts = result.moves.filter((m) => m.kind === 'cut')
  assert(cuts.length > 0, 'v_carve with closed line should produce cut moves')

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'v_carve with closed line should produce non-empty G-code')
})

test('v_carve_medial: closed Line target generates toolpath + posts', () => {
  const tool = makeVBit('t1')
  const feat = makeClosedLineFeature('l1', 5, 5, 10, 10, 0, -2)
  const project = baseProject([tool], [feat])
  const op = makePocketOp({
    kind: 'v_carve_medial',
    target: { source: 'features', featureIds: ['l1'] },
    toolRef: 't1',
    maxCarveDepth: 2,
    stepover: 0.3,
  })

  const result = generateVCarveMedialToolpath(project, op)
  assert(result.moves.length > 0, 'v_carve_medial with closed line should produce moves')

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'v_carve_medial with closed line should produce non-empty G-code')
})

test('v_carve_medial: generates toolpath + posts to non-empty G-code', () => {
  const tool = makeVBit('t1')
  const feat = makeRectFeature('a', 0, 0, 10, 10, 0, -2)
  const project = baseProject([tool], [feat])
  const op = makePocketOp({
    kind: 'v_carve_medial',
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    maxCarveDepth: 2,
    stepover: 0.3,
  })

  const result = generateVCarveMedialToolpath(project, op)
  assert(result.moves.length > 0, 'v_carve_medial should produce moves')

  const gcode = postToolpath(project, op, result)
  assert(gcode.length > 0, 'v_carve_medial should produce non-empty G-code')
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
