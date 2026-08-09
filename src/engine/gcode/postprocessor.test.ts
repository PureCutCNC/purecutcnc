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
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, SketchFeature } from '../../types/project'
import { replaceProjectFeatures } from '../../test/projectFixtures'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { generateDrillingToolpath } from '../toolpaths/drilling'
import { generatePocketToolpath, optimizeLinearMoves } from '../toolpaths'
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
): {
  gcode: string
  warnings: ToolpathWarning[]
  stats: { lineCount: number; moveCount: number }
  drillCycleCount: number
} {
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
  return {
    gcode: result.gcode,
    warnings: result.warnings,
    stats: result.stats,
    drillCycleCount: toolpath.drillCycles.length,
  }
}

function testCannedSimpleG81(): void {
  console.log('Testing canned cycle G81 (simple)...')
  const { gcode, stats, drillCycleCount } = runDrillingFixture(cannedCycleDefinition(), 'simple')
  assert(gcode.includes('G81'), 'G-code should contain G81 for simple drilling')
  assert(gcode.includes('Z'), 'G-code should contain Z depth')
  assert(gcode.includes('R'), 'G-code should contain R retract plane')
  assert(gcode.includes('F'), 'G-code should contain feed rate')
  assert(gcode.includes('G80'), 'G-code should contain G80 cancel')
  // The initial positioning rapid and each canned cycle emit one motion block.
  // Setup/footer lines stay out of the motion count.
  assert(
    stats.moveCount === drillCycleCount + 1,
    `expected positioning rapid + canned moves (${drillCycleCount + 1}), got ${stats.moveCount}`,
  )
  assert(stats.lineCount > stats.moveCount, 'total G-code lines include non-motion setup/footer lines')
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

// ── Helical drilling postprocessor test ─────────────────────────

function testHelicalDrillingG1NoCannedCycles(): void {
  console.log('Testing helical flat-endmill drilling emits G1, no canned cycles, no G2/G3...')

  const project = newProject('Helical Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: '4 mm Endmill', type: 'flat_endmill' as const, diameter: 4, defaultPlungeFeed: 150 }
  project.tools = [toolRecord]

  const circle: SketchFeature = {
    id: 'c1',
    name: 'Bore',
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProfile(20, 20, 3), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -8,
    visible: true,
    locked: false,
  }
  replaceProjectFeatures(project, [circle])

  const operation: Operation = {
    id: 'op1',
    name: 'Helical Bore Op',
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
    drillType: 'helical',
    entryRampAngle: 5,
    entryHelixDiameterPercent: 80,
  }

  const toolpath = generateDrillingToolpath(project, operation)
  assert(toolpath.moves.length > 0, 'helical drilling should produce moves')
  assert(!toolpath.drillCycles || toolpath.drillCycles.length === 0, 'helical should have no drillCycles')

  const result = runPostProcessor({
    project,
    definition: testDefinition(),
    operations: [{ operation, tool: normalizeToolForProject(toolRecord, project), toolpath }],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  })
  const gcode = result.gcode

  // Must emit G1 linear moves for the helix
  assert(/\bG1\b/.test(gcode), 'helical G-code should contain G1 linear moves')
  // Must NOT contain canned cycle codes
  assert(!/G8[123]/.test(gcode), 'helical G-code should not contain canned cycle codes (G81/G82/G83)')
  assert(!/G73/.test(gcode), 'helical G-code should not contain G73')
  // Must contain program end
  assert(gcode.includes('M30'), 'helical G-code should contain M30 program end')
}

function testHelicalDrillingArcFittingNoG2G3(): void {
  console.log('Testing helical flat-endmill drilling: no G2/G3 even with arc fitting on...')

  const project = newProject('Helical Arc Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: '4 mm Endmill', type: 'flat_endmill' as const, diameter: 4, defaultPlungeFeed: 150 }
  project.tools = [toolRecord]

  const circle: SketchFeature = {
    id: 'c1',
    name: 'Bore',
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProfile(20, 20, 3), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -8,
    visible: true,
    locked: false,
  }
  replaceProjectFeatures(project, [circle])

  const operation: Operation = {
    id: 'op1',
    name: 'Helical Bore Op',
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
    drillType: 'helical',
    entryRampAngle: 5,
    entryHelixDiameterPercent: 80,
    arcFittingEnabled: true,
  }

  const toolpath = generateDrillingToolpath(project, operation)

  // Use an arc-capable machine definition
  const arcDef = arcTestDefinition()
  const result = runPostProcessor({
    project,
    definition: arcDef,
    operations: [{ operation, tool: normalizeToolForProject(toolRecord, project), toolpath }],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  })
  const gcode = result.gcode

  // Even with arc fitting enabled, helical drilling must NOT emit G2/G3
  assert(!/\bG2\b/.test(gcode), 'helical G-code should not contain G2 even with arc fitting on')
  assert(!/\bG3\b/.test(gcode), 'helical G-code should not contain G3 even with arc fitting on')
  assert(/\bG1\b/.test(gcode), 'helical G-code should contain G1 linear moves')
  assert(gcode.includes('M30'), 'helical G-code should contain M30 program end')
}

testHelicalDrillingG1NoCannedCycles()
testHelicalDrillingArcFittingNoG2G3()

// ── Helical safe-Z ordering (first-operation position establishment) ─

/** Extract Z values from rapid (G0) lines in the G-code, in order.
 *  Handles modal G0 where subsequent rapid moves omit the G0 word. */
function rapidZValues(gcode: string): number[] {
  const values: number[] = []
  let inRapid = false
  for (const line of gcode.split('\n')) {
    const trimmed = line.trim()
    // Track modal rapid state: G0 starts a rapid block, G1/G2/G3 end it
    if (trimmed.startsWith('G0')) {
      inRapid = true
    } else if (/^G[123]\b/.test(trimmed)) {
      inRapid = false
    }
    // Collect Z from rapid lines (both explicit G0 and modal continuations)
    if (inRapid || trimmed.startsWith('G0')) {
      const zMatch = trimmed.match(/Z(-?[\d.]+)/)
      if (zMatch) {
        inRapid = true  // a bare "Z..." line in rapid block
        values.push(parseFloat(zMatch[1]))
      }
    }
  }
  return values
}

function testHelicalSafeZBeforeRetractDescent(): void {
  console.log('Testing helical drilling G-code: safeZ established before retractZ descent...')

  const project = newProject('SafeZ Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: '4 mm Endmill', type: 'flat_endmill' as const, diameter: 4, defaultPlungeFeed: 150 }
  project.tools = [toolRecord]

  const circle: SketchFeature = {
    id: 'c1',
    name: 'Bore',
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProfile(20, 20, 3), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -8,
    visible: true,
    locked: false,
  }
  replaceProjectFeatures(project, [circle])

  const operation: Operation = {
    id: 'op1',
    name: 'Helical Bore Op',
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
    drillType: 'helical',
    entryRampAngle: 5,
    entryHelixDiameterPercent: 80,
  }

  const toolpath = generateDrillingToolpath(project, operation)
  assert(toolpath.moves.length > 0, 'helical drilling should produce moves')

  const result = runPostProcessor({
    project,
    definition: testDefinition(),
    operations: [{ operation, tool: normalizeToolForProject(toolRecord, project), toolpath }],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  })
  const gcode = result.gcode

  // The rapid block must establish safeZ first, then XY, then descend.
  // In the emitted G-code the postprocessor uses modal G0, so the first
  // Z-bearing line has the initial safeZ, followed by an XY line, followed
  // by a lower Z line for the retract descent.
  const zValues = rapidZValues(gcode)
  assert(zValues.length >= 2, `expected at least 2 rapid Z values, got ${zValues.length}`)
  const firstZ = zValues[0]
  assert(
    zValues.slice(1).some((z) => z < firstZ),
    `expected a Z descent below first Z ${firstZ} in ${JSON.stringify(zValues)}`,
  )

  // XY must be established before Z descends below the initial safeZ level.
  // Modal G0 lines like "X20 Y60" (no G0 prefix) carry XY positioning.
  const lines = gcode.split('\n')
  let xyEstablished = false
  let inRapid = false
  let firstZSeen: number | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('G0')) inRapid = true
    else if (/^G[123]\b/.test(trimmed)) inRapid = false

    // Track XY establishment from all rapid lines
    if (inRapid && /X-?[\d.]/.test(trimmed) && /Y-?[\d.]/.test(trimmed)) {
      xyEstablished = true
    }

    // Check Z descent ordering
    if (inRapid) {
      const zMatch = trimmed.match(/Z(-?[\d.]+)/)
      if (zMatch) {
        const z = parseFloat(zMatch[1])
        if (firstZSeen === null) {
          firstZSeen = z
        } else if (z < firstZSeen && !xyEstablished) {
          assert(false, `rapid Z descent to ${z} before XY was established (first Z was ${firstZSeen})`)
        }
      }
    }
  }
  assert(xyEstablished, 'XY position must be established in G-code')

  // Existing assertions: G1, no canned cycles, no G2/G3
  assert(/\bG1\b/.test(gcode), 'helical G-code should contain G1 linear moves')
  assert(!/G8[123]/.test(gcode), 'helical G-code should not contain canned cycles')
  assert(!/G73/.test(gcode), 'helical G-code should not contain G73')
  assert(gcode.includes('M30'), 'helical G-code should contain M30')
}

function testHelicalMoveBudgetRejection(): void {
  console.log('Testing helical move-budget exhaustion rejects with no moves and unmachinable warning...')

  const project = newProject('Rejection Test', 'mm')
  // Eligible diameter (hole=6, tool=4 → 4<6≤8) but very deep + shallow
  // ramp angle → exceeds MAX_ENTRY_DESCENT_MOVES → rejection
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: '4 mm Endmill', type: 'flat_endmill' as const, diameter: 4, defaultPlungeFeed: 150 }
  project.tools = [toolRecord]

  const circle: SketchFeature = {
    id: 'c1',
    name: 'DeepBore',
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProfile(20, 20, 3), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -500,
    visible: true,
    locked: false,
  }
  replaceProjectFeatures(project, [circle])

  const operation: Operation = {
    id: 'op1',
    name: 'Rejected Bore',
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
    drillType: 'helical',
    entryRampAngle: 0.1,
    entryHelixDiameterPercent: 80,
  }

  const toolpath = generateDrillingToolpath(project, operation)
  // Move-budget exhausted in finish-bore mode → rejection, zero moves
  assert(toolpath.moves.length === 0, 'move-budget rejection must produce zero moves')
  assert(!toolpath.drillCycles || toolpath.drillCycles.length === 0, 'rejection must have no drillCycles')
  assert(!!toolpath.warnings.find((w) => w.code === 'drillHelicalBoreUnmachinable'),
    'rejection must produce drillHelicalBoreUnmachinable warning')
  assert(!toolpath.warnings.find((w) => w.code === 'entryStrategyFallback'),
    'rejection must not produce entryStrategyFallback')
}

testHelicalSafeZBeforeRetractDescent()
testHelicalMoveBudgetRejection()

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
  movesOverride?: ToolpathMove[],
): { gcode: string; warnings: ToolpathWarning[]; stats: { moveCount: number } } {
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
    moves: movesOverride ?? circularCutMoves(),
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
  const { gcode, warnings, stats } = runArcFixture(def, { arcFittingEnabled: false })
  // Use word-boundary match — G21 (units) contains 'G2' as substring.
  assert(!/\bG2\b/.test(gcode), 'should not contain G2 when arc fitting is disabled')
  assert(!/\bG3\b/.test(gcode), 'should not contain G3 when arc fitting is disabled')
  assert(/\bG1\b/.test(gcode), 'should contain G1 linear moves')
  const arcWarnings = warnings.filter((w) => w.code === 'postArcNoCapability')
  assert(arcWarnings.length === 0, `expected no arc capability warning when disabled, got ${arcWarnings.length}`)
  assert(stats.moveCount === 8, `linear fallback should emit all 8 source moves, got ${stats.moveCount}`)
}

// ── issue #447: emitted arcs must satisfy the controller ───────

/** The 14 contiguous cut moves from the issue #447 report. */
function issue447CutMoves(): ToolpathMove[] {
  const xy: Array<[number, number]> = [
    [122.3941767939508, 167.17278330912177],
    [122.37556680190744, 167.10332987328752],
    [122.36930000002496, 167.0317],
    [122.36677898139465, 166.96007012671248],
    [122.37660115292522, 166.89061669087823],
    [122.3982010594255, 166.82545000000005],
    [122.43065538518721, 166.76655011100434],
    [122.4727110084653, 166.71570666721345],
    [122.52282307694827, 166.67446452093895],
    [122.57920194731366, 166.6440767939257],
    [122.63986756263506, 166.62546680188257],
    [122.7027096154099, 166.6192000000001],
    [122.76555166818474, 166.62546680188257],
    [122.82621728350614, 166.6440767939257],
    [122.88259615387153, 166.67446452093895],
  ]
  const points = xy.map(([x, y]) => ({ x, y, z: -1 }))
  // Lead in with a rapid, as any real toolpath does: the arc chain is only
  // meaningful relative to a position the controller has actually been given.
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { ...points[0], z: 5 } },
    { kind: 'plunge', from: { ...points[0], z: 5 }, to: { ...points[0] } },
  ]
  for (let i = 0; i < points.length - 1; i++) {
    moves.push({ kind: 'cut', from: { ...points[i] }, to: { ...points[i + 1] } })
  }
  return moves
}

/**
 * Re-derive GRBL's arc check from the emitted text alone — modal motion,
 * modal position, formatted words. Deliberately independent of the exporter's
 * own parser so the assertion tests the file, not our model of it.
 */
function assertEmittedArcsAreValid(gcode: string): number {
  let modal = ''
  let x = 0
  let y = 0
  let checked = 0

  for (const raw of gcode.split('\n')) {
    const line = raw.trim()
    const motion = line.match(/\bG(0|1|2|3)\b/)
    if (motion) modal = motion[1]

    const wordX = line.match(/X(-?[\d.]+)/)
    const wordY = line.match(/Y(-?[\d.]+)/)
    const wordI = line.match(/I(-?[\d.]+)/)
    const wordJ = line.match(/J(-?[\d.]+)/)

    if ((modal === '2' || modal === '3') && wordX && wordY && wordI && wordJ) {
      const i = parseFloat(wordI[1])
      const j = parseFloat(wordJ[1])
      const targetX = parseFloat(wordX[1])
      const targetY = parseFloat(wordY[1])
      const startRadius = Math.hypot(i, j)
      const endRadius = Math.hypot(targetX - (x + i), targetY - (y + j))
      const delta = Math.abs(endRadius - startRadius)
      // GRBL: pass under 0.005 mm, else fail past 0.5 mm or 0.1 % of radius.
      const accepted = delta <= 0.005
        || (delta <= 0.5 && delta <= 0.001 * startRadius)
      assert(accepted,
        `controller would reject "${line}" from ${x},${y}: radius delta ${delta.toFixed(6)} mm`)
      checked += 1
    }

    if (wordX) x = parseFloat(wordX[1])
    if (wordY) y = parseFloat(wordY[1])
  }

  return checked
}

function testIssue447EmittedArcsPassControllerCheck(): void {
  console.log('Testing issue #447 span exports arcs the controller accepts...')

  const def = arcTestDefinition({ motion: { ...arcTestDefinition().motion, arcFormat: 'ij' } })
  const { gcode, warnings } = runArcFixture(def, undefined, issue447CutMoves())

  const checked = assertEmittedArcsAreValid(gcode)
  assert(checked > 0, 'fixture must emit at least one I/J arc to be meaningful')
  const fallbacks = warnings.filter((w) => w.code === 'postArcFallbackLinear')
  assert(fallbacks.length === 0,
    `span should export as arcs without falling back, got ${JSON.stringify(fallbacks)}`)
}

function testIssue447RFormatExport(): void {
  console.log('Testing issue #447 span in R format...')

  const def = arcTestDefinition({ motion: { ...arcTestDefinition().motion, arcFormat: 'r' } })
  const { gcode, warnings } = runArcFixture(def, undefined, issue447CutMoves())

  assert(/\bG[23]\b/.test(gcode), 'R-format export should still emit arcs')
  assert(!/\bI-?[\d.]/.test(gcode), 'should not contain I when using R format')
  const fallbacks = warnings.filter((w) => w.code === 'postArcFallbackLinear')
  assert(fallbacks.length === 0,
    `R-format span should not fall back, got ${JSON.stringify(fallbacks)}`)
}

function testArcOutputPassesControllerCheck(): void {
  console.log('Testing that the standard arc fixture also satisfies the controller...')
  const def = arcTestDefinition({ motion: { ...arcTestDefinition().motion, arcFormat: 'ij' } })
  // Same circle as the other arc tests, led into by a rapid so the emitted
  // arcs can be checked against a position the controller actually holds.
  const circle = circularCutMoves()
  const { gcode } = runArcFixture(def, undefined, [
    { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { ...circle[0].from, z: 5 } },
    { kind: 'plunge', from: { ...circle[0].from, z: 5 }, to: { ...circle[0].from } },
    ...circle,
  ])
  const checked = assertEmittedArcsAreValid(gcode)
  assert(checked > 0, 'standard fixture must emit I/J arcs')
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
  // One source rapid becomes two safe G0 blocks, followed by one plunge and
  // one fitted arc block.
  assert(result.stats.moveCount === 4, `expected 4 emitted motion blocks, got ${result.stats.moveCount}`)
}

// ── moveCount reports emitted post-fit motion blocks ─────────────

function testArcMoveCountReflectsFittedOutput(): void {
  console.log('Testing moveCount reflects emitted arc-fitted output...')
  const def = arcTestDefinition()
  const { stats } = runArcFixture(def)
  // circularCutMoves() has 8 source chords, but the full circle is emitted as
  // four ≤90° G2 blocks. The export summary must describe the saved program.
  assert(
    stats.moveCount === 4,
    `moveCount must count emitted arc blocks (4), got ${stats.moveCount}`,
  )
}

function testCaptureMotionTrace(): void {
  console.log('Testing captureMotionTrace option...')
  const def = arcTestDefinition()
  const project = newProject('Arc Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: '6 mm Endmill' }
  project.tools = [toolRecord]
  const tool = normalizeToolForProject(toolRecord, project)
  const operation: Operation = {
    id: 'op1', name: 'Arc Op', kind: 'pocket', pass: 'rough',
    enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'stock' }, toolRef: toolRecord.id,
    stepdown: 1, stepover: 0.4, feed: 600, plungeFeed: 180, rpm: 12000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0,
    stockToLeaveAxial: 0, finishWalls: true, finishFloor: true,
    carveDepth: 1, maxCarveDepth: 1, cutDirection: 'climb',
    machiningOrder: 'level_first', debugShowRejectedCorners: false,
  }
  const toolpath = generatePocketToolpath(project, operation)
  const optimized = optimizeLinearMoves(toolpath)

  const withTrace = runPostProcessor({
    project, definition: def,
    operations: [{ operation, tool, toolpath: optimized }],
    options: { emitToolChanges: false, emitCoolant: false, captureMotionTrace: true },
  })
  assert(withTrace.motionTraces !== undefined, 'motionTraces present when captureMotionTrace=true')
  assert(withTrace.motionTraces!.length === 1, `expected 1 trace, got ${withTrace.motionTraces!.length}`)
  const trace = withTrace.motionTraces![0]
  assert(trace.operationId === 'op1', 'trace operationId matches')
  assert(Array.isArray(trace.machineMoves), 'machineMoves is array')
  assert(Array.isArray(trace.descriptors), 'descriptors is array')
  assert(typeof trace.tryFit === 'boolean', 'tryFit is boolean')

  const withoutTrace = runPostProcessor({
    project, definition: def,
    operations: [{ operation, tool, toolpath: optimized }],
    options: { emitToolChanges: false, emitCoolant: false, captureMotionTrace: false },
  })
  assert(withoutTrace.motionTraces === undefined, 'motionTraces absent when captureMotionTrace=false')
}

// ── Entry positioning: no fed move travels while descending (#467) ──

interface EmittedMotion {
  command: string
  lineIndex: number
  x: number | null
  y: number | null
  z: number | null
}

/**
 * Replays the emitted program the way a controller would — modal motion
 * command, modal axis words — and returns the motion blocks. Must be run over
 * the whole program: a modal `X.. Y..` line carries the command from an earlier
 * block, so replaying a slice misreads the first motion in it.
 */
function emittedMotions(gcode: string): EmittedMotion[] {
  const motions: EmittedMotion[] = []
  let command: string | null = null
  let x: number | null = null
  let y: number | null = null
  let z: number | null = null

  gcode.split('\n').forEach((raw, lineIndex) => {
    const line = raw.split(';')[0].trim()
    if (line.length === 0) return

    const commandMatch = line.match(/^(G0?[0123])\b/)
    if (commandMatch) {
      command = commandMatch[1]
    }

    const xMatch = line.match(/X(-?[\d.]+)/)
    const yMatch = line.match(/Y(-?[\d.]+)/)
    const zMatch = line.match(/Z(-?[\d.]+)/)
    if (!xMatch && !yMatch && !zMatch) return
    if (command === null) return

    if (xMatch) x = parseFloat(xMatch[1])
    if (yMatch) y = parseFloat(yMatch[1])
    if (zMatch) z = parseFloat(zMatch[1])
    motions.push({ command, lineIndex, x, y, z })
  })

  return motions
}

function pocketOperation(id: string, name: string): Operation {
  return {
    id, name, kind: 'pocket', pass: 'rough',
    enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds: ['pocket-feature'] }, toolRef: 't1',
    stepdown: 1, stepover: 0.4, feed: 600, plungeFeed: 180, rpm: 12000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0,
    stockToLeaveAxial: 0, finishWalls: true, finishFloor: true,
    carveDepth: 1, maxCarveDepth: 1, cutDirection: 'climb',
    machiningOrder: 'level_first', debugShowRejectedCorners: false,
  }
}

/**
 * The full app pipeline — generate, optimize, postprocess — for two operations.
 * `optimizeLinearMoves` used to delete the zero-length rapid that marks each
 * operation's entry point, so the first fed move of the program travelled
 * diagonally across the workpiece at plunge feed while descending to full
 * depth, cutting the stock wherever it crossed the surface (issue #467).
 *
 * Asserts the shape the machine needs: rapid first, then a vertical plunge.
 */
function testOperationEntryRapidsSurviveOptimization(): void {
  console.log('Testing every operation starts with a rapid, then a vertical plunge...')

  const project = newProject('Entry Test', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: '6 mm Endmill' }
  project.tools = [toolRecord]
  const tool = normalizeToolForProject(toolRecord, project)

  const pocketFeature: SketchFeature = {
    id: 'pocket-feature',
    name: 'Pocket',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(20, 20, 40, 30),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -3,
    visible: true,
    locked: false,
  }
  replaceProjectFeatures(project, [pocketFeature])

  const operations = [
    pocketOperation('op1', 'First Pocket'),
    pocketOperation('op2', 'Second Pocket'),
  ].map((operation) => {
    const toolpath = optimizeLinearMoves(generatePocketToolpath(project, operation))
    assert(toolpath.moves.length > 0, `${operation.name} should produce moves`)
    return { operation, tool, toolpath }
  })

  const gcode = runPostProcessor({
    project,
    definition: testDefinition(['; Operation {operationIndex}: {operationName}']),
    operations,
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode

  const motions = emittedMotions(gcode)
  assert(motions.length > 0, 'program should emit motion')
  assert(motions[0].command === 'G0', `program must open with a rapid, got ${motions[0].command}`)

  // Every fed move must be either a constant-Z cut or a pure-Z plunge. A G1
  // that changes XY *and* descends is the gouge this test exists to catch.
  // This covers operations 2..n; operation 1 has no preceding motion to
  // compare against, which is what the opening-rapid assertion above is for.
  let previous: EmittedMotion | null = null
  let sawPlunge = false
  for (const motion of motions) {
    if (motion.command === 'G1' && previous !== null) {
      const movedXY = motion.x !== previous.x || motion.y !== previous.y
      const descended = motion.z !== null && previous.z !== null && motion.z < previous.z
      assert(
        !(movedXY && descended),
        `G1 to (${motion.x}, ${motion.y}, ${motion.z}) travels in XY while descending from `
        + `(${previous.x}, ${previous.y}, ${previous.z})`,
      )
      if (descended) sawPlunge = true
    }
    previous = motion
  }
  assert(sawPlunge, 'expected at least one fed descent (the plunge) in the program')

  // The second operation must reposition too, not carry the first one's end
  // point into its own plunge. Modal G0 means its first block is often a bare
  // "X.. Y.." line, so this reads the replayed command, not the raw text.
  const headerLine = gcode.split('\n').findIndex((line) => line.includes('; Operation 2:'))
  assert(headerLine > 0, 'second operation header should be emitted')
  const secondEntry = motions.find((motion) => motion.lineIndex > headerLine)
  assert(secondEntry !== undefined, 'second operation should emit motion')
  assert(
    secondEntry!.command === 'G0',
    `second operation must open with a rapid, got ${secondEntry!.command}`,
  )
}

testArcOutputIJ()
testArcOutputR()
testArcDisabledLinearFallback()
testArcUnsupportedMachineWarning()
testIssue447EmittedArcsPassControllerCheck()
testIssue447RFormatExport()
testArcOutputPassesControllerCheck()
testArcNoRegressionLinear()
testArcMixedRapidAndCut()
testArcMoveCountReflectsFittedOutput()
testCaptureMotionTrace()
testOperationEntryRapidsSurviveOptimization()

console.log('gcode postprocessor tests passed')
