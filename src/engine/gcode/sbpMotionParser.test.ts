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
 * Tests for the ShopBot part-file motion parser (issue #953) and for the
 * exported-motion debug model built from an SBP export.
 *
 * Run with: npx tsx src/engine/gcode/sbpMotionParser.test.ts
 */

import { defaultTool, newProject } from '../../types/project'
import type { Operation } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathGenerationTrace, ToolpathMove, ToolpathPoint } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { buildExportedMotionDebugModel, parseExportedMotion } from './motionDebug'
import { runPostProcessor } from './postprocessor'
import { parseSbpMotion } from './sbpMotionParser'
import { validateMachineDefinition } from './types'
import type { MachineDefinition } from './types'
import { exportGeometryTolerance } from '../../utils/units'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function program(...lines: string[]): string {
  return lines.join('\r\n') + '\r\n'
}

function samePoint(a: ToolpathPoint, x: number, y: number, z: number): boolean {
  return Math.abs(a.x - x) < 1e-9 && Math.abs(a.y - y) < 1e-9 && Math.abs(a.z - z) < 1e-9
}

function testJogsAndMoves(): void {
  console.log('Testing jogs and moves with modal position...')
  const parsed = parseSbpMotion(program(
    'JZ,5.000',
    'J2,10.000,-5.000',
    'M3,10.000,-5.000,-1.000',
    'M2,20,-5',
    'MZ,-2',
    'MX,25',
    'MY,-9',
    'J3,0,0,5',
    'JX,3',
    'JY,4',
    // A blank parameter leaves that axis where it is.
    'M3,,7,',
  ))
  assert(parsed.status === 'verified', `expected verified, got ${parsed.status}: ${parsed.warnings.join('; ')}`)
  const kinds = parsed.moves.map((move) => move.kind).join(',')
  assert(kinds === 'rapid,rapid,linear,linear,linear,linear,linear,rapid,rapid,rapid,linear', `kinds: ${kinds}`)
  const ends: Array<[number, number, number]> = [
    [0, 0, 5], [10, -5, 5], [10, -5, -1], [20, -5, -1], [20, -5, -2], [25, -5, -2], [25, -9, -2],
    [0, 0, 5], [3, 0, 5], [3, 4, 5], [3, 7, 5],
  ]
  parsed.moves.forEach((move, index) => {
    const [x, y, z] = ends[index]
    assert(samePoint(move.to, x, y, z), `move ${index + 1} ends at ${JSON.stringify(move.to)}, expected ${x},${y},${z}`)
    if (index > 0) {
      const [px, py, pz] = ends[index - 1]
      assert(samePoint(move.from, px, py, pz), `move ${index + 1} starts where move ${index} ended`)
    }
  })
}

function testArcs(): void {
  console.log('Testing CG arcs: centre from the offsets, direction 1 = clockwise...')
  const parsed = parseSbpMotion(program(
    'J2,10,0',
    'MZ,-1',
    // Quarter arcs about the origin, radius 10.
    'CG,,0,-10,-10,0,T,1',
    'CG,,10,0,0,10,T,-1',
    // Three quarters the long way round.
    'CG,,0,10,-10,0,T,1',
  ))
  assert(parsed.status === 'verified', `expected verified, got ${parsed.status}: ${parsed.warnings.join('; ')}`)
  const arcs = parsed.moves.flatMap((move) => (move.kind === 'arc' ? [move] : []))
  assert(arcs.length === 3, `expected 3 arcs, got ${arcs.length}`)
  for (const arc of arcs) {
    assert(Math.abs(arc.center.x) < 1e-9 && Math.abs(arc.center.y) < 1e-9, `centre should be the origin, got ${JSON.stringify(arc.center)}`)
    assert(Math.abs(arc.radius - 10) < 1e-9, `radius should be 10, got ${arc.radius}`)
    assert(arc.from.z === -1 && arc.to.z === -1, 'an arc stays at the current Z')
  }
  assert(arcs[0].clockwise === true && arcs[1].clockwise === false && arcs[2].clockwise === true, 'direction 1 is clockwise, -1 counter-clockwise')
  assert(arcs[0].largeArc === false && arcs[1].largeArc === false, 'a quarter arc is not a large arc')
  assert(arcs[2].largeArc === true, 'three quarters of a circle is a large arc')
  assert(samePoint(arcs[0].to, 0, -10, -1) && samePoint(arcs[1].from, 0, -10, -1), 'arcs chain end to start')
}

function testNonMotionLinesAndEnd(): void {
  console.log('Testing comments, setup lines and END...')
  const parsed = parseSbpMotion([
    "' Bracket",
    'IF %(25)=0 THEN GOTO UNIT_ERROR',
    'SA',
    '&Tool=1',
    'C9',
    'TR,12000',
    'C6',
    'MS,10.000,3.000',
    "J2,1,2 ' trailing comment, with a comma",
    '',
    'm3,4,5,-1',
    'C7',
    'END',
    "'",
    'UNIT_ERROR:',
    'MSGBOX(Wrong units. Nothing was cut.,16,Wrong units)',
    // Never reached by a program that ran: must not be read as motion.
    'M3,99,99,-99',
    'END',
  ].join('\n'))
  assert(parsed.status === 'verified', `expected verified, got ${parsed.status}: ${parsed.warnings.join('; ')}`)
  assert(parsed.moves.length === 2, `expected 2 moves, got ${parsed.moves.length}`)
  assert(samePoint(parsed.moves[0].to, 1, 2, 0), 'a trailing comment is stripped before the parameters are read')
  assert(parsed.moves[1].kind === 'linear' && samePoint(parsed.moves[1].to, 4, 5, -1), 'commands are case-insensitive')
}

function testUnsupported(): void {
  console.log('Testing anything the emitter does not write is unsupported, never guessed...')
  const cases: Array<[string, string]> = [
    ['SR', 'relative mode'],
    ['CG,,0,-10,-10,0,T,1,-0.5', 'an arc with a plunge'],
    ['CG,,0,-10,-10,0,T,1,,2', 'an arc with repetitions'],
    ['CG,,0,-10,-10,0,O,1', 'an arc offset outside the line'],
    ['CG,,0,-10,-10,0,T,2', 'an arc with an unknown direction'],
    ['CG,20,0,-10,,,T,1', 'an arc given by diameter alone'],
    ['CP,20,0,0,T,1', 'another circle command'],
    ['M3,&x,1,1', 'a variable used as a coordinate'],
    ['M3,1,2,3,4', 'too many parameters'],
    ['C3', 'a macro that may move the tool'],
    ['IF &Count = 20 THEN GOTO SKIP', 'control flow beyond the units guard'],
    ['G1 X10 Y10', 'G-code in a part file'],
    ['ZZ', 'a zeroing command'],
  ]
  for (const [line, label] of cases) {
    const parsed = parseSbpMotion(program('J2,10,0', line, 'M3,1,1,-1'))
    assert(parsed.status === 'unsupported', `${label} ("${line}") should be unsupported, got ${parsed.status}`)
    assert(parsed.warnings.length === 1 && parsed.warnings[0].startsWith('line 2:'), `${label}: the warning names the line, got ${JSON.stringify(parsed.warnings)}`)
    // The rest of the file is still read, so the view stays usable.
    assert(parsed.moves.length === 2, `${label}: the supported moves around it are kept`)
  }
}

// ── Exported-motion debug view for an SBP export ──────────────

function shopbot(): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'shopbot')
  if (!found) throw new Error('Fixture error: no bundled ShopBot definition')
  return validateMachineDefinition(structuredClone(found))
}

function testDebugModelForSbpExport(): void {
  console.log('Testing the exported-motion debug model verifies an SBP export...')
  const project = newProject('Debug', 'mm')
  const toolRecord = { ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }
  project.tools = [toolRecord]
  const operation: Operation = {
    id: 'op1',
    name: 'Circle',
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

  // A full circle of 5° chords at one depth, then a straight exit.
  const points: ToolpathPoint[] = []
  for (let index = 0; index <= 72; index++) {
    const angle = (Math.PI * 2 * index) / 72
    points.push({ x: 60 + 20 * Math.cos(angle), y: 50 + 20 * Math.sin(angle), z: 2 })
  }
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 0, y: 0, z: 30 }, to: { ...points[0], z: 30 } },
    { kind: 'plunge', from: { ...points[0], z: 30 }, to: points[0] },
  ]
  for (let index = 0; index < points.length - 1; index++) {
    moves.push({ kind: 'cut', from: points[index], to: points[index + 1] })
  }
  moves.push({ kind: 'cut', from: points[72], to: { x: 95, y: 50, z: 2 } })
  moves.push({ kind: 'rapid', from: { x: 95, y: 50, z: 2 }, to: { x: 95, y: 50, z: 30 } })

  const definition = shopbot()
  const result = runPostProcessor({
    project,
    definition,
    operations: [{
      operation,
      tool: normalizeToolForProject(toolRecord, project),
      toolpath: { operationId: operation.id, warnings: [], bounds: null, moves },
    }],
    options: { emitToolChanges: true, emitCoolant: false, captureMotionTrace: true },
  })
  const postprocessorTrace = result.motionTraces?.[0]
  assert(!!postprocessorTrace, 'the SBP export captures a motion trace')
  if (!postprocessorTrace) return

  const trace: ToolpathGenerationTrace = {
    operationId: operation.id,
    raw: { operationId: operation.id, moves, warnings: [], bounds: null },
    optimized: { operationId: operation.id, moves, warnings: [], bounds: null },
  }
  const model = buildExportedMotionDebugModel({
    trace,
    parsed: parseExportedMotion(result.gcode, definition),
    postprocessorTrace,
    origin: project.origin,
    definition,
    tolerance: exportGeometryTolerance('mm'),
  })
  assert(model.diagnostic.state === 'verified', `expected verified, got ${JSON.stringify(model.diagnostic.warnings)}`)
  assert(model.metrics.emitted.arcCw + model.metrics.emitted.arcCcw === 4, `the circle is 4 exported arcs, got ${JSON.stringify(model.metrics.emitted)}`)
  assert(model.metrics.emitted.linear === 2, `plunge and exit are linear, got ${model.metrics.emitted.linear}`)
  assert(model.metrics.emitted.rapid === 3, `three jogs, got ${model.metrics.emitted.rapid}`)
  assert(model.zLevels.length === 1, 'one cutting level')
  assert(model.zLevelStats[0].exportedSegs === 5, `the level shows 4 arcs and the exit, got ${model.zLevelStats[0].exportedSegs}`)
  // The exported layer is drawn back in project space.
  const firstArc = model.layers.exported.segments.find((segment) => segment.kind === 'arc')
  assert(!!firstArc && !!firstArc.center, 'the exported layer contains an arc with a centre')
  if (firstArc?.center) {
    assert(Math.abs(firstArc.center.x - 60) < 0.01 && Math.abs(firstArc.center.y - 50) < 0.01,
      `the arc centre maps back to the project circle, got ${JSON.stringify(firstArc.center)}`)
  }

  // A G-code parser reading the same text sees none of it: the dispatch matters.
  const gcodeDefinition = validateMachineDefinition({ ...definition, outputDialect: 'gcode' })
  const misread = parseExportedMotion(result.gcode, gcodeDefinition)
  assert(misread.moves.length !== parseSbpMotion(result.gcode).moves.length, 'reading SBP as G-code does not find the same motion')
}

testJogsAndMoves()
testArcs()
testNonMotionLinesAndEnd()
testUnsupported()
testDebugModelForSbpExport()

console.log('sbp motion parser tests passed')
