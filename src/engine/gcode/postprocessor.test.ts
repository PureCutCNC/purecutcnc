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
 * Tests for machine-definition G-code postprocessing.
 *
 * Run with: npx tsx src/engine/gcode/postprocessor.test.ts
 */

import type { ToolpathWarning } from '../toolpaths/warningCodes'
import { circleProfile, defaultTool, newProject } from '../../types/project'
import type { Operation, SketchFeature } from '../../types/project'
import { replaceProjectFeatures } from '../../test/projectFixtures'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { generateDrillingToolpath } from '../toolpaths/drilling'
import type { ToolpathResult, ToolpathMove } from '../toolpaths/types'
import { runPostProcessor } from './postprocessor'
import { validateMachineDefinition } from './types'
import type { MachineDefinition } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function testDefinition(operationHeader?: string[]): MachineDefinition {
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
      header: ['; {programName}', '{unitsCommand}'],
      ...(operationHeader ? { operationHeader } : {}),
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

function fixture(description = 'Pocket the screw bosses'): {
  operation: Operation
  toolpath: ToolpathResult
  tool: ReturnType<typeof normalizeToolForProject>
} {
  const project = newProject('Post Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }
  project.tools = [toolRecord]
  const operation: Operation = {
    id: 'op1',
    name: 'Boss Pocket',
    description,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef: toolRecord.id,
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
  }
  return {
    operation,
    tool: normalizeToolForProject(toolRecord, project),
    toolpath: {
      operationId: operation.id,
      warnings: [],
      bounds: null,
      moves: [
        { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 1, y: 1, z: 5 } },
        { kind: 'cut', from: { x: 1, y: 1, z: 5 }, to: { x: 2, y: 1, z: 0 } },
      ],
    },
  }
}

function runFixture(definition: MachineDefinition, operation: Operation): string {
  const project = newProject('Post Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }
  project.tools = [toolRecord]
  const toolpath: ToolpathResult = {
    operationId: operation.id,
    warnings: [],
    bounds: null,
    moves: [
      { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 1, y: 1, z: 5 } },
      { kind: 'cut', from: { x: 1, y: 1, z: 5 }, to: { x: 2, y: 1, z: 0 } },
    ],
  }
  return runPostProcessor({
    project,
    definition,
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
  }).gcode
}

function testOperationHeaderDescription(): void {
  console.log('Testing operation header description template...')
  const { operation } = fixture('Clean the inner pocket before finishing')
  const gcode = runFixture(testDefinition([
    '; Operation {operationIndex}: {operationName}',
    '; Description: {operationDescription}',
    '; Tool {toolNumber}: {toolName}',
  ]), operation)
  assert(gcode.includes('; Operation 1: Boss Pocket'), 'operation header should include operation name')
  assert(gcode.includes('; Description: Clean the inner pocket before finishing'), 'operation header should include description')
  assert(gcode.includes('; Tool 1:'), 'operation header should include tool number')
}

function testEmptyDescriptionIsSkipped(): void {
  console.log('Testing empty operation description header line is skipped...')
  const { operation } = fixture('')
  const gcode = runFixture(testDefinition([
    '; Operation {operationIndex}: {operationName}',
    '; Description: {operationDescription}',
  ]), operation)
  assert(gcode.includes('; Operation 1: Boss Pocket'), 'operation header should still include operation name')
  assert(!gcode.includes('; Description:'), 'empty description line should not be emitted')
}

function testMultilineDescription(): void {
  console.log('Testing multiline operation description header expansion...')
  const { operation } = fixture('Face datum edge\nLeave tabs untouched (final trim)')
  const gcode = runFixture(testDefinition([
    '; Operation {operationIndex}: {operationName}',
    '; Description: {operationDescription}',
  ]), operation)
  assert(gcode.includes('; Description: Face datum edge'), 'first description line should be emitted')
  assert(gcode.includes('; Description: Leave tabs untouched final trim'), 'second description line should be emitted and sanitized')
}

function testLegacyDefinitionFallback(): void {
  console.log('Testing machine definitions without operationHeader still work...')
  const { operation } = fixture('Ignored by legacy fallback')
  const gcode = runFixture(testDefinition(), operation)
  assert(gcode.includes('; Operation: Boss Pocket'), 'legacy fallback should emit operation comment')
}

function testSlotFeedScaleEmitsReducedThenFullFeed(): void {
  console.log('Testing feedScale cut moves emit reduced F then restore the full feed...')
  const { operation, tool } = fixture('')
  const project = newProject('Post Test', 'mm')
  project.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }]
  const toolpath: ToolpathResult = {
    operationId: operation.id,
    warnings: [],
    bounds: null,
    moves: [
      { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 1, y: 1, z: 5 } },
      { kind: 'plunge', from: { x: 1, y: 1, z: 5 }, to: { x: 1, y: 1, z: 0 } },
      { kind: 'cut', from: { x: 1, y: 1, z: 0 }, to: { x: 2, y: 1, z: 0 }, feedScale: 0.5 },
      { kind: 'cut', from: { x: 2, y: 1, z: 0 }, to: { x: 3, y: 1, z: 0 }, feedScale: 0.5 },
      { kind: 'cut', from: { x: 3, y: 1, z: 0 }, to: { x: 4, y: 1, z: 0 } },
    ],
  }
  const gcode = runPostProcessor({
    project,
    definition: testDefinition(),
    operations: [{ operation, tool, toolpath }],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode

  // operation.feed = 600, plungeFeed = 180: plunge F180, scaled cuts F300, restore F600.
  assert(gcode.includes('F180'), 'plunge should use the unscaled plunge feed')
  const f300Count = (gcode.match(/F300\b/g) ?? []).length
  assert(f300Count === 1, `reduced feed should be emitted once (modal), got ${f300Count}`)
  assert(gcode.includes('F600'), 'full feed should be re-emitted after the scaled cuts')
  assert(gcode.indexOf('F300') < gcode.indexOf('F600'), 'reduced feed should come before the restored full feed')
}

testOperationHeaderDescription()
testEmptyDescriptionIsSkipped()
testMultilineDescription()
testLegacyDefinitionFallback()
testSlotFeedScaleEmitsReducedThenFullFeed()

// ── Canned cycle tests ────────────────────────────────────────────────

function cannedCycleDefinition(): MachineDefinition {
  return validateMachineDefinition({
    id: 'test-canned',
    name: 'TestCanned',
    description: 'Test controller with canned cycles',
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
    cannedCycles: {
      drillCommand: 'G81',
      drillWithDwellCommand: 'G82',
      peckDrillCommand: 'G83',
      chipBreakDrillCommand: 'G73',
      peckStepWord: 'Q',
      retractMode: 'G98',
      cancelCommand: 'G80',
    },
    coolant: null,
    stop: { programEndCommand: 'M30' },
  })
}

function grblDefinition(): MachineDefinition {
  return validateMachineDefinition({
    id: 'test-grbl',
    name: 'TestGRBL',
    description: 'Test GRBL controller (no canned cycles)',
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

function runDrillingFixture(
  definition: MachineDefinition,
  drillType: 'simple' | 'peck' | 'dwell' | 'chip_breaking',
  overrides?: { peckDepth?: number; dwellTime?: number },
): { gcode: string; warnings: ToolpathWarning[] } {
  const project = newProject('Canned Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: '3 mm Drill', type: 'drill' as const, diameter: 3, defaultPlungeFeed: 150 }
  project.tools = [toolRecord]

  const circle: SketchFeature = {
    id: 'c1',
    name: 'Hole',
    kind: 'circle',
    folderId: null,
    sketch: {
      profile: circleProfile(20, 20, 5),
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
  replaceProjectFeatures(project, [circle])

  const operation: Operation = {
    id: 'op1',
    name: 'Drill Op',
    kind: 'drilling',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['c1'] },
    toolRef: 't1',
    stepdown: 2,
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
    drillType,
    peckDepth: overrides?.peckDepth,
    dwellTime: overrides?.dwellTime,
  }

  const toolpath = generateDrillingToolpath(project, operation)
  if (!toolpath.drillCycles || toolpath.drillCycles.length === 0) {
    throw new Error('Fixture error: drillCycles missing or empty')
  }

  const result = runPostProcessor({
    project,
    definition,
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
  return { gcode: result.gcode, warnings: result.warnings }
}

function testCannedSimpleG81(): void {
  console.log('Testing canned cycle G81 (simple)...')
  const { gcode } = runDrillingFixture(cannedCycleDefinition(), 'simple')
  assert(gcode.includes('G81'), 'G-code should contain G81 for simple drilling')
  assert(gcode.includes('Z'), 'G-code should contain Z depth')
  assert(gcode.includes('R'), 'G-code should contain R retract plane')
  assert(gcode.includes('F'), 'G-code should contain feed rate')
  assert(gcode.includes('G80'), 'G-code should contain G80 cancel')
}

function testCannedDwellG82(): void {
  console.log('Testing canned cycle G82 (dwell)...')
  const { gcode } = runDrillingFixture(cannedCycleDefinition(), 'dwell', { dwellTime: 1.5 })
  assert(gcode.includes('G82'), 'G-code should contain G82 for dwell drilling')
  assert(gcode.includes('P'), 'G-code should contain P dwell time')
  assert(gcode.includes('G80'), 'G-code should contain G80 cancel')
}

function testCannedPeckG83(): void {
  console.log('Testing canned cycle G83 (peck)...')
  const { gcode } = runDrillingFixture(cannedCycleDefinition(), 'peck', { peckDepth: 2 })
  assert(gcode.includes('G83'), 'G-code should contain G83 for peck drilling')
  assert(gcode.includes('Q'), 'G-code should contain Q peck step')
  assert(gcode.includes('G80'), 'G-code should contain G80 cancel')
}

function testCannedChipBreakingG73(): void {
  console.log('Testing canned cycle G73 (chip breaking)...')
  const { gcode } = runDrillingFixture(cannedCycleDefinition(), 'chip_breaking', { peckDepth: 2 })
  assert(gcode.includes('G73'), 'G-code should contain G73 for chip breaking')
  assert(gcode.includes('Q'), 'G-code should contain Q peck step')
  assert(gcode.includes('G80'), 'G-code should contain G80 cancel')
}

function testRegressionGrblNoCannedCycles(): void {
  console.log('Testing regression: GRBL (cannedCycles null) still expands to G0/G1...')
  const { gcode } = runDrillingFixture(grblDefinition(), 'simple')
  assert(!gcode.includes('G81'), 'GRBL G-code should NOT contain G81')
  assert(!gcode.includes('G80'), 'GRBL G-code should NOT contain G80')
  assert(gcode.includes('G0'), 'GRBL G-code should contain G0 rapid moves')
  assert(gcode.includes('G1'), 'GRBL G-code should contain G1 linear moves')
  assert(gcode.includes('M30'), 'GRBL G-code should contain program end')
}

function testLegacyCannedCycleDefaults(): void {
  console.log('Testing legacy canned-cycle definition defaults (missing chipBreakDrillCommand + cancelCommand)...')
  const legacyDef = {
    id: 'test-legacy',
    name: 'TestLegacy',
    description: 'Legacy controller',
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
    cannedCycles: {
      drillCommand: 'G81',
      drillWithDwellCommand: 'G82',
      peckDrillCommand: 'G83',
      peckStepWord: 'Q',
      retractMode: 'G98',
    },
    coolant: null,
    stop: { programEndCommand: 'M30' },
  }

  let validated: MachineDefinition
  try {
    validated = validateMachineDefinition(legacyDef)
  } catch (err) {
    throw new Error(`Legacy definition should not throw: ${String(err)}`)
  }
  assert(validated.cannedCycles !== null, 'cannedCycles should not be null')
  assert(validated.cannedCycles!.chipBreakDrillCommand === null, 'chipBreakDrillCommand should default to null')
  assert(validated.cannedCycles!.cancelCommand === 'G80', 'cancelCommand should default to G80')
}

testCannedSimpleG81()
testCannedDwellG82()
testCannedPeckG83()
testCannedChipBreakingG73()
testRegressionGrblNoCannedCycles()
testLegacyCannedCycleDefaults()

// ── Arc fitting tests ──────────────────────────────────────────

function arcTestDefinition(overrides?: Partial<MachineDefinition>): MachineDefinition {
  return validateMachineDefinition({
    id: 'arc-test',
    name: 'ArcTest',
    description: 'Arc-capable test controller',
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
      arcInterpolation: true,
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
    ...overrides,
  })
}

function circularCutMoves(): ToolpathMove[] {
  // 8 chord segments (= 9 points) on a circle of radius 10 at Z=0,
  // forming a full 360° CCW circle in project coords (Y-down).
  // After Y inversion to machine coords, this becomes CW (G2).
  const r = 10
  const n = 8
  const projectPoints: Array<{ x: number; y: number; z: number }> = []
  for (let i = 0; i <= n; i++) {
    const angle = (Math.PI * 2 * i) / n
    // Screen space Y-down: CCW = increasing angle
    projectPoints.push({ x: r * Math.cos(angle), y: r * Math.sin(angle), z: 0 })
  }
  const moves: ToolpathMove[] = []
  for (let i = 0; i < n; i++) {
    moves.push({
      kind: 'cut',
      from: { ...projectPoints[i] },
      to: { ...projectPoints[i + 1] },
    })
  }
  return moves
}

function runArcFixture(
  definition: MachineDefinition,
  operationOverrides?: Partial<Operation>,
): { gcode: string; warnings: ToolpathWarning[] } {
  const project = newProject('Arc Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: '6 mm Endmill' }
  project.tools = [toolRecord]
  const tool = normalizeToolForProject(toolRecord, project)
  const operation: Operation = {
    id: 'op1',
    name: 'Arc Op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef: toolRecord.id,
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
    ...operationOverrides,
  }
  const toolpath: ToolpathResult = {
    operationId: operation.id,
    warnings: [],
    bounds: null,
    moves: circularCutMoves(),
  }
  return runPostProcessor({
    project,
    definition,
    operations: [{ operation, tool, toolpath }],
    options: {
      emitToolChanges: true,
      emitCoolant: false,
      programName: project.meta.name,
    },
  })
}

// ── I/J arc output ─────────────────────────────────────────────

function testArcOutputIJ(): void {
  console.log('Testing G2/G3 I/J arc output...')
  const def = arcTestDefinition({ motion: { ...arcTestDefinition().motion, arcFormat: 'ij' } })
  const { gcode, warnings } = runArcFixture(def)
  // All nodes in project space (Y-down, CCW) invert to machine space (Y-up).
  // In machine space the 360° CCW circle becomes 360° CW → G2.
  // It splits into 4 × 90° sub-arcs → 4 G2 blocks.
  const g2Count = (gcode.match(/\bG2\b/g) ?? []).length
  assert(g2Count >= 1, `expected at least one G2, got ${g2Count}`)
  assert(/\bI-?[\d.]/.test(gcode), 'G-code should contain I offsets')
  assert(/\bJ-?[\d.]/.test(gcode), 'G-code should contain J offsets')
  assert(!/\bG3\b/.test(gcode), 'should not contain G3 for CW arcs in machine coords')
  // No arc capability warnings when machine supports arcs.
  const arcWarnings = warnings.filter((w) => w.code === 'postArcNoCapability')
  assert(arcWarnings.length === 0, `expected no arc capability warning, got ${arcWarnings.length}`)
}

// ── R arc output ───────────────────────────────────────────────

function testArcOutputR(): void {
  console.log('Testing G2/G3 R arc output...')
  const def = arcTestDefinition({ motion: { ...arcTestDefinition().motion, arcFormat: 'r' } })
  const { gcode, warnings } = runArcFixture(def)
  const g2Count = (gcode.match(/\bG2\b/g) ?? []).length
  assert(g2Count >= 1, `expected at least one G2, got ${g2Count}`)
  assert(/\bR-?[\d.]/.test(gcode), 'G-code should contain R radius word')
  assert(!/\bI-?[\d.]/.test(gcode), 'should not contain I when using R format')
  assert(!/\bJ-?[\d.]/.test(gcode), 'should not contain J when using R format')
  const arcWarnings = warnings.filter((w) => w.code === 'postArcNoCapability')
  assert(arcWarnings.length === 0, `expected no arc capability warning, got ${arcWarnings.length}`)
}

// ── Disabled operation fallback ────────────────────────────────

function testArcDisabledLinearFallback(): void {
  console.log('Testing arc fitting disabled → linear output...')
  const def = arcTestDefinition()
  const { gcode, warnings } = runArcFixture(def, { arcFittingEnabled: false })
  // Use word-boundary match — G21 (units) contains 'G2' as substring.
  assert(!/\bG2\b/.test(gcode), 'should not contain G2 when arc fitting is disabled')
  assert(!/\bG3\b/.test(gcode), 'should not contain G3 when arc fitting is disabled')
  assert(/\bG1\b/.test(gcode), 'should contain G1 linear moves')
  const arcWarnings = warnings.filter((w) => w.code === 'postArcNoCapability')
  assert(arcWarnings.length === 0, `expected no arc capability warning when disabled, got ${arcWarnings.length}`)
}

// ── Unsupported machine fallback + warning ─────────────────────

function testArcUnsupportedMachineWarning(): void {
  console.log('Testing unsupported machine arc warning...')
  const def = arcTestDefinition({
    motion: { ...arcTestDefinition().motion, arcInterpolation: false },
  })
  const { gcode, warnings } = runArcFixture(def)
  // Machine doesn't support arcs → output must be linear.
  assert(!/\bG2\b/.test(gcode), 'should not contain G2 on unsupported machine')
  assert(!/\bG3\b/.test(gcode), 'should not contain G3 on unsupported machine')
  assert(/\bG1\b/.test(gcode), 'should contain G1 linear moves')
  // Warning expected.
  const arcWarnings = warnings.filter((w) => w.code === 'postArcNoCapability')
  assert(arcWarnings.length === 1, `expected 1 arc capability warning, got ${arcWarnings.length}`)
  if (arcWarnings[0]) {
    assert(
      arcWarnings[0].params?.operation === 'Arc Op',
      `warning should reference the operation, got ${JSON.stringify(arcWarnings[0].params)}`,
    )
  }
}

// ── No regression on existing linear output ────────────────────

function testArcNoRegressionLinear(): void {
  console.log('Testing that non-circular linear moves are unchanged...')
  const def = arcTestDefinition()
  const project = newProject('Linear Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: '6 mm Endmill' }
  project.tools = [toolRecord]
  const tool = normalizeToolForProject(toolRecord, project)
  const operation: Operation = {
    id: 'op1',
    name: 'Linear Op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef: toolRecord.id,
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
  }
  const toolpath: ToolpathResult = {
    operationId: operation.id,
    warnings: [],
    bounds: null,
    moves: [
      { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 10, y: 0, z: 5 } },
      { kind: 'plunge', from: { x: 10, y: 0, z: 5 }, to: { x: 10, y: 0, z: 0 } },
      { kind: 'cut', from: { x: 10, y: 0, z: 0 }, to: { x: 10, y: 20, z: 0 } },
      { kind: 'cut', from: { x: 10, y: 20, z: 0 }, to: { x: 20, y: 20, z: 0 } },
    ],
  }
  const result = runPostProcessor({
    project,
    definition: def,
    operations: [{ operation, tool, toolpath }],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  })
  // Should contain G1 moves for the linear cuts, no G2/G3.
  assert(/\bG1\b/.test(result.gcode), 'linear toolpath should contain G1')
  assert(!/\bG2\b/.test(result.gcode), 'linear toolpath should not contain G2')
  assert(!/\bG3\b/.test(result.gcode), 'linear toolpath should not contain G3')
  const arcWarnings = result.warnings.filter((w) => w.code === 'postArcNoCapability')
  assert(arcWarnings.length === 0, 'linear toolpath should not produce arc capability warning')
}

// ── Mixed rapid and cut with arcs ──────────────────────────────

function testArcMixedRapidAndCut(): void {
  console.log('Testing mixed rapid and cut moves with arc fitting...')
  const def = arcTestDefinition()
  const project = newProject('Mixed Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: '6 mm Endmill' }
  project.tools = [toolRecord]
  const tool = normalizeToolForProject(toolRecord, project)

  // A 90° arc in project space (Y-down, CCW) at Z=0.
  const r = 10
  const arcPoints: Array<{ x: number; y: number; z: number }> = []
  for (let i = 0; i <= 4; i++) {
    const angle = (Math.PI / 2 * i) / 4
    arcPoints.push({ x: r * Math.cos(angle), y: r * Math.sin(angle), z: 0 })
  }
  const arcMoves: ToolpathMove[] = []
  for (let i = 0; i < 4; i++) {
    arcMoves.push({
      kind: 'cut',
      from: { ...arcPoints[i] },
      to: { ...arcPoints[i + 1] },
    })
  }

  const operation: Operation = {
    id: 'op1',
    name: 'Mixed Op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef: toolRecord.id,
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
  }
  const toolpath: ToolpathResult = {
    operationId: operation.id,
    warnings: [],
    bounds: null,
    moves: [
      { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: r, y: 0, z: 5 } },
      { kind: 'plunge', from: { x: r, y: 0, z: 5 }, to: { x: r, y: 0, z: 0 } },
      ...arcMoves,
    ],
  }
  const result = runPostProcessor({
    project,
    definition: def,
    operations: [{ operation, tool, toolpath }],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  })
  // Should have G0 for rapid, G2/G3 for the arc.
  assert(/\bG0\b/.test(result.gcode), 'should contain G0 rapid')
  assert(/\bG1\b/.test(result.gcode), 'should contain G1 plunge')
  // In machine coords (Y-up), the CCW circle becomes CW → G2.
  assert(/\bG2\b/.test(result.gcode), 'should contain G2 for the 90° arc')
}

testArcOutputIJ()
testArcOutputR()
testArcDisabledLinearFallback()
testArcUnsupportedMachineWarning()
testArcNoRegressionLinear()
testArcMixedRapidAndCut()

console.log('gcode postprocessor tests passed')
