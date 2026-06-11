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

import { defaultTool, newProject } from '../../types/project'
import type { Operation } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
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
console.log('gcode postprocessor tests passed')
