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

import { circleProfile, defaultTool, newProject } from '../../types/project'
import type { Operation, SketchFeature } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { generateDrillingToolpath } from '../toolpaths/drilling'
import type { ToolpathResult } from '../toolpaths/types'
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

testOperationHeaderDescription()
testEmptyDescriptionIsSkipped()
testMultilineDescription()
testLegacyDefinitionFallback()

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
): { gcode: string; warnings: string[] } {
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
  project.features = [circle]

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

console.log('gcode postprocessor tests passed')
