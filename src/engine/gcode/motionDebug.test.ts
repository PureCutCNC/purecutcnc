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
 * Tests for the exported-motion debug helpers (issue #356): eligibility,
 * the machine→project inverse transform, and the debug-model builder with
 * its exported-path-vs-source diagnostic.
 *
 * Run with: npx tsx src/engine/gcode/motionDebug.test.ts
 */

import { machineToProjectPoint, projectToMachinePoint, machineToProjectFlipsArcDirection } from './utils'
import { rotaryDirection, validateMachineDefinition, type MachineDefinition } from './types'
import type { MachineOrigin, Operation, Project } from '../../types/project'
import { defaultTool, newProject, roundStock } from '../../types/project'
import type { ToolpathGenerationTrace, ToolpathMove, ToolpathPoint } from '../toolpaths/types'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { runPostProcessor } from './postprocessor'
import { exportGeometryTolerance } from '../../utils/units'
import { parseGcodeMotion } from './gcodeMotionParser'
import {
  getExportedMotionEligibility,
  compareMotionTraces,
  buildExportedMotionDebugModel,
  parseExportedMotion,
} from './motionDebug'
import type { OperationMotionTrace } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

function pt(x: number, y: number, z: number): ToolpathPoint { return { x, y, z } }
function cut(from: ToolpathPoint, to: ToolpathPoint): ToolpathMove { return { kind: 'cut', from, to } }
function rapid(from: ToolpathPoint, to: ToolpathPoint): ToolpathMove { return { kind: 'rapid', from, to } }

function grblDefinition(): MachineDefinition {
  return validateMachineDefinition({
    id: 'test-grbl',
    name: 'TestGRBL',
    description: 'Test GRBL controller',
    fileExtension: 'nc',
    coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
    numberFormat: { decimalPlaces: { mm: 3, inch: 4 }, trailingZeros: false, leadingZero: true },
    units: { mmCommand: 'G21', inchCommand: 'G20' },
    program: { header: [], footer: [], commentPrefix: '(', commentSuffix: ')', lineNumbers: false, lineNumberIncrement: 10 },
    workCoordinates: { selectCommand: null },
    motion: { rapidCommand: 'G0', linearCommand: 'G1', cwArcCommand: 'G2', ccwArcCommand: 'G3', arcFormat: 'ij', modalMotion: true, arcInterpolation: true },
    feedSpeed: { feedCommand: 'F', rpmCommand: 'S', spindleOnCW: 'M3', spindleOnCCW: 'M4', spindleOff: 'M5', inlineWithMotion: true, modalFeedSpeed: true },
    toolChange: { commands: [], stopSpindleFirst: true, pauseAfterChange: false, pauseCommand: 'M0' },
    cannedCycles: null,
    coolant: null,
    stop: { programEndCommand: 'M30' },
  })
}

function mirroredDefinition(): MachineDefinition {
  // Axis-mirrored machine: project X → -machine X, project Y → -machine Y.
  const def = grblDefinition()
  def.coordinateSystem = { xAxis: '-X', yAxis: '-Y', zAxis: 'Z' }
  return def
}

type AxisSpec = MachineDefinition['coordinateSystem']['xAxis']

function withCoordinateSystem(xAxis: AxisSpec, yAxis: AxisSpec): MachineDefinition {
  const def = grblDefinition()
  def.coordinateSystem = { xAxis, yAxis, zAxis: 'Z' }
  return def
}

/** An own-axis rotary that turns a positive angle the other way. */
function reversedRotaryDefinition(): MachineDefinition {
  const def = grblDefinition()
  def.rotary = { about: 'x', drive: 'own', reversed: true, inverseTimeFeed: { on: 'G93', off: 'G94' } }
  return def
}

/** A borrowed rotary on a mirrored output: its direction is negative too. */
function mirroredBorrowedRotaryDefinition(): MachineDefinition {
  const def = grblDefinition()
  def.coordinateSystem = { xAxis: 'X', yAxis: '-Y', zAxis: 'Z' }
  def.rotary = { about: 'x', drive: 'borrowed', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } }
  return def
}

const ORIGIN: MachineOrigin = { name: 'O', x: 10, y: 20, z: 0, visible: true }
const ZERO_ORIGIN: MachineOrigin = { name: 'O', x: 0, y: 0, z: 0, visible: true }

function testEligibility(): void {
  console.log('Testing exported-motion eligibility...')
  const constantZ = [cut(pt(0, 0, 0), pt(10, 0, 0)), cut(pt(10, 0, 0), pt(10, 5, 0))]
  let e = getExportedMotionEligibility(constantZ)
  assert(e.eligible, 'constant-Z pocket-like should be eligible')

  const variableZ = [cut(pt(0, 0, 0), pt(5, 0, -1))]
  e = getExportedMotionEligibility(variableZ)
  assert(!e.eligible && e.reason === 'variableZ', `variable-Z ineligible, got ${e.reason}`)

  e = getExportedMotionEligibility([rapid(pt(0, 0, 5), pt(0, 0, 0))])
  assert(!e.eligible && e.reason === 'noCutMoves', `no-cut ineligible, got ${e.reason}`)

  e = getExportedMotionEligibility({
    moves: constantZ,
    drillCycles: [{ x: 0, y: 0, clearZ: 1, retractZ: 1, bottomZ: 0, drillType: 'simple' }],
  })
  assert(!e.eligible && e.reason === 'drilling', `drilling ineligible, got ${e.reason}`)
}

function testInverseTransform(): void {
  console.log('Testing machineToProjectPoint inverts projectToMachinePoint...')
  const probes = [pt(12, 18, 0), pt(10, 20, -3), pt(0, 0, 0), pt(-5, 7, 2)]
  for (const def of [grblDefinition(), mirroredDefinition()]) {
    for (const p of probes) {
      const m = projectToMachinePoint(p, ORIGIN, def)
      const back = machineToProjectPoint(m, ORIGIN, def)
      assert(approx(back.x, p.x) && approx(back.y, p.y) && approx(back.z, p.z),
        `round-trip ${JSON.stringify(p)} -> ${JSON.stringify(back)} (${def.coordinateSystem.xAxis}/${def.coordinateSystem.yAxis})`)
    }
  }
}

function testRotaryAngleInverse(): void {
  console.log('Testing machineToProjectPoint carries the rotary angle and un-reverses it...')
  const probes: ToolpathPoint[] = [
    { x: 12, y: 18, z: 0, a: 90 },
    { x: -5, y: 7, z: 2, a: -370 },
    { x: 3, y: 4, z: 5, a: 0 },
  ]
  for (const def of [reversedRotaryDefinition(), mirroredBorrowedRotaryDefinition()]) {
    // The sign the direction contributes is negative here, so a transform that
    // forgot to divide it out would come back with the opposite angle.
    assert(rotaryDirection(def) === -1, 'the fixture makes the direction matter')
    for (const p of probes) {
      const m = projectToMachinePoint(p, ORIGIN, def)
      assert(m.a === p.a! * rotaryDirection(def), 'the program angle is the project angle times the direction')
      const back = machineToProjectPoint(m, ORIGIN, def)
      assert(approx(back.x, p.x) && approx(back.y, p.y) && approx(back.z, p.z),
        `rotary round-trip ${JSON.stringify(p)} -> ${JSON.stringify(back)}`)
      assert(back.a !== undefined && approx(back.a, p.a!),
        `the angle round-trips, got ${back.a} for ${p.a}`)
    }
  }

  // A point with no angle gains no key on the way back, exactly as before.
  const plain = machineToProjectPoint(pt(1, 2, 3), ORIGIN, reversedRotaryDefinition())
  assert(!('a' in plain), 'a point with no angle comes back with no a key')
}

// ── Reading a rotary program back (issue #393) ────────────────

/** A point carrying the stock's angle. */
function rpt(x: number, y: number, z: number, a: number): ToolpathPoint {
  return { x, y, z, a }
}

/** The grbl fixture plus a rotary block. */
function rotaryGrbl(drive: 'own' | 'borrowed'): MachineDefinition {
  const def = grblDefinition()
  def.rotary = { about: 'x', drive, reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } }
  return def
}

/** A 20 mm round bar along project X, origin on its centreline at the top. */
function rotaryProject(): Project {
  const project = newProject('Rotary readback', 'mm')
  project.stock = roundStock(20, 100, 'x')
  project.origin = { name: 'Origin', x: 0, y: 10, z: 20, visible: true }
  project.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Test End Mill' }]
  return project
}

function rotaryOperation(): Operation {
  return {
    id: 'op-rotary',
    name: 'Rotary',
    description: '',
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
  }
}

/** Export one hand-built turning toolpath and return the program and its trace. */
function exportRotary(def: MachineDefinition, moves: ToolpathMove[]): { gcode: string; trace: OperationMotionTrace } {
  const project = rotaryProject()
  const operation = rotaryOperation()
  const result = runPostProcessor({
    project,
    definition: def,
    operations: [{
      operation,
      tool: normalizeToolForProject(project.tools[0], project),
      toolpath: { operationId: operation.id, warnings: [], bounds: null, moves },
    }],
    options: { emitToolChanges: false, emitCoolant: false, captureMotionTrace: true },
  })
  const trace = result.motionTraces?.[0]
  assert(trace !== undefined, 'the export captured a motion trace')
  return { gcode: result.gcode, trace: trace! }
}

/**
 * Export a turning program on the own-axis and the borrowed-motor machines,
 * parse it back, and require the planned machine points, angles and feed modes.
 * The borrowed case also pins that its letter is never read as a coordinate.
 */
function testRotaryProgramReadback(): void {
  console.log('Testing an exported rotary program parses back to the planned motion...')
  const tolerance = exportGeometryTolerance('mm')

  for (const drive of ['own', 'borrowed'] as const) {
    const definition = rotaryGrbl(drive)
    const moves: ToolpathMove[] = [
      { kind: 'rapid', from: rpt(0, 10, 30, 0), to: rpt(0, 10, 30, 0) },
      { kind: 'plunge', from: rpt(0, 10, 30, 0), to: rpt(0, 10, 20, 0) },
      { kind: 'cut', from: rpt(0, 10, 20, 0), to: rpt(10, 10, 20, 90) },
      { kind: 'cut', from: rpt(10, 10, 20, 90), to: rpt(20, 10, 20, 90) },
    ]
    const { gcode, trace } = exportRotary(definition, moves)
    const parsed = parseExportedMotion(gcode, definition)
    // The program ends at 90°, so it carries the closing machine-coordinate
    // retract (#1054 fix 2). That block is not a work position, so the parse
    // cannot be reported as verified (#1054 fix 4); everything else must read
    // back unchanged.
    assert(parsed.status === 'unsupported', `${drive}: parsed ${parsed.status}: ${parsed.warnings.join('; ')}`)
    assert(
      parsed.warnings.length === 2 && parsed.warnings.every((warning) => warning.includes('G53')),
      `${drive}: the only warnings are the machine-coordinate retract, got ${JSON.stringify(parsed.warnings)}`,
    )

    const feedMoves = parsed.moves.filter((m) => m.kind !== 'rapid')
    assert(feedMoves.length === 3, `${drive}: plunge + turning cut + straight cut, got ${feedMoves.length}`)
    const inverse = parsed.moves.filter((m) => m.inverseTimeFeed !== undefined)
    assert(inverse.length === 1, `${drive}: exactly the turning move runs in inverse time, got ${inverse.length}`)
    assert(inverse[0].to.a === 90, `${drive}: the turning move is the one that turns`)

    // The word read back is the number the exporter wrote, not merely "some"
    // inverse-time feed: the program emits G93 directly before the turning move.
    const gcodeLines = gcode.split(/\r?\n/).map((line) => line.trim())
    const g93Index = gcodeLines.findIndex((line) => line.startsWith('G93'))
    assert(g93Index >= 0, `${drive}: the program switches to inverse time`)
    const exportedF = gcodeLines[g93Index + 1].match(/F(-?[0-9.]+)/)
    assert(exportedF !== null, `${drive}: the turning move states its own F word`)
    assert(
      inverse[0].inverseTimeFeed === Number(exportedF![1]),
      `${drive}: the parsed inverse-time F is the exported one, got ${inverse[0].inverseTimeFeed} vs ${exportedF![1]}`,
    )

    // The angles come back as planned: A0 on the plunge, A90 on both cuts.
    const angles = feedMoves.map((m) => m.to.a)
    assert(JSON.stringify(angles) === '[0,90,90]', `${drive}: angles ${JSON.stringify(angles)}`)

    // The view's own comparison still matches every endpoint and angle; the
    // only diagnostic is that the machine-coordinate retract cannot be placed
    // in the work frame (#1054 fix 4).
    const diagnostic = compareMotionTraces(parsed, trace, tolerance)
    assert(
      diagnostic.warnings.length === 1 && diagnostic.warnings[0].kind === 'unsupported',
      `${drive}: ${JSON.stringify(diagnostic.warnings)}`,
    )

    if (drive === 'borrowed') {
      for (const m of parsed.moves) {
        assert(m.to.y === 0, `the borrowed letter is never read as linear Y, got ${m.to.y}`)
      }
    }
  }
}

function makeTrace(): ToolpathGenerationTrace {
  const raw = {
    operationId: 'op',
    moves: [cut(pt(0, 0, 0), pt(5, 0, 0)), cut(pt(5, 0, 0), pt(10, 0, 0)), cut(pt(10, 0, 0), pt(15, 0, 0))],
    warnings: [],
    bounds: null,
  }
  const optimized = { ...raw, moves: [cut(pt(0, 0, 0), pt(15, 0, 0))] }
  return { operationId: 'op', raw, optimized }
}

function makePostprocessorTrace(): OperationMotionTrace {
  return {
    operationId: 'op',
    machineMoves: [rapid(pt(0, 0, 5), pt(0, 0, 0)), cut(pt(0, 0, 0), pt(15, 0, 0))],
    descriptors: [],
    tryFit: false,
  }
}

function testBuildModelVerified(): void {
  console.log('Testing buildExportedMotionDebugModel — merged segments + verified diagnostic...')
  const trace = makeTrace()
  const parsed = parseGcodeMotion('G0 X0 Y0 Z0\nG1 X15 Y0 Z0 F100', 'ij', '(', ')')
  const ppTrace = makePostprocessorTrace()
  const model = buildExportedMotionDebugModel({
    trace, parsed, postprocessorTrace: ppTrace,
    origin: ZERO_ORIGIN, definition: grblDefinition(), tolerance: 0.01,
  })
  assert(model.metrics.rawMoveCount === 3, `rawMoveCount ${model.metrics.rawMoveCount}`)
  assert(model.metrics.optimizedMoveCount === 1, `optimizedMoveCount ${model.metrics.optimizedMoveCount}`)
  assert(model.metrics.removedMoveCount === 2, `removedMoveCount ${model.metrics.removedMoveCount}`)
  assert(model.metrics.emitted.linear === 1, `emitted.linear ${model.metrics.emitted.linear}`)
  assert(model.zLevels.length === 1 && approx(model.zLevels[0], 0), `zLevels ${JSON.stringify(model.zLevels)}`)
  assert(model.diagnostic.state === 'verified',
    `expected verified, got ${model.diagnostic.state}: ${JSON.stringify(model.diagnostic.warnings)}`)
}

function testDiagnosticCountMismatch(): void {
  console.log('Testing diagnostic flags a segment-count mismatch...')
  const parsed = parseGcodeMotion('G0 X0 Y0 Z0\nG1 X15 Y0 Z0\nG1 X20 Y0 Z0', 'ij', '(', ')')
  const diag = compareMotionTraces(parsed, makePostprocessorTrace(), 0.01)
  assert(diag.state === 'warning', `expected warning, got ${diag.state}`)
  assert(diag.warnings.some((w) => w.kind === 'countMismatch'), 'countMismatch warning')
}

function testBuildModelNoPositioningRapid(): void {
  console.log('Testing a program whose first move is a cut (no positioning rapid, like Mach3)...')
  // Mirrors the Mach3 fixture: setup codes then G1 straight into the plunge —
  // no G0 to establish a position first. The first segment's `from` is the
  // unknown initial position, so the diagnostic must compare end points only,
  // and the exported layer's machine-Z must map back to the project cutting Z.
  const optimized = {
    operationId: 'op',
    moves: [
      { kind: 'plunge' as const, from: pt(0, 0, 0.2), to: pt(0, 0, -0.05) },
      { kind: 'cut' as const, from: pt(0, 0, -0.05), to: pt(5, 0, -0.05) },
    ],
    warnings: [],
    bounds: null,
  }
  const trace = { operationId: 'op', raw: optimized, optimized }
  const parsed = parseGcodeMotion('G1 X0 Y0 Z-0.05 F100\nG1 X5 Y0 Z-0.05', 'ij', '(', ')')
  const ppTrace: OperationMotionTrace = {
    operationId: 'op',
    machineMoves: optimized.moves,
    descriptors: [],
    tryFit: false,
  }
  const model = buildExportedMotionDebugModel({
    trace, parsed, postprocessorTrace: ppTrace,
    origin: ZERO_ORIGIN, definition: grblDefinition(), tolerance: 0.01,
  })
  assert(model.diagnostic.state === 'verified',
    `expected verified, got ${model.diagnostic.state}: ${JSON.stringify(model.diagnostic.warnings)}`)
  assert(model.zLevels.length === 1 && approx(model.zLevels[0], -0.05), `zLevels ${JSON.stringify(model.zLevels)}`)
  // The exported layer must render at the cutting Z (machine-Z mapped to project-Z + snapped).
  const exportedCut = model.layers.exported.segments.find((s) => s.cutting && Math.abs(s.z - model.zLevels[0]) < 1e-6)
  assert(exportedCut != null, 'exported layer has a cutting segment at the cutting Z')
}

function testInitialPlungeIsNotComparedAsPlanarCut(): void {
  console.log('Testing that an implicit-start plunge does not trigger an arc-deviation warning...')
  // The first emitted G1 ends at this plunge point, but G-code contains no
  // matching start position. Its reconstructed XY line therefore cannot be
  // compared against the planar cutting toolpath; only the following cut can.
  const optimized = {
    operationId: 'op',
    moves: [
      { kind: 'plunge' as const, from: pt(2, 5, 0.2), to: pt(2, 5, -0.05) },
      { kind: 'cut' as const, from: pt(2, 5, -0.05), to: pt(5, 5, -0.05) },
    ],
    warnings: [],
    bounds: null,
  }
  const trace = { operationId: 'op', raw: optimized, optimized }
  const parsed = parseGcodeMotion('G1 X2 Y-5 Z-0.05 F100\nG1 X5 Y-5 Z-0.05', 'ij', '(', ')')
  const ppTrace: OperationMotionTrace = {
    operationId: 'op',
    machineMoves: [
      { kind: 'plunge', from: pt(2, -5, 0.2), to: pt(2, -5, -0.05) },
      { kind: 'cut', from: pt(2, -5, -0.05), to: pt(5, -5, -0.05) },
    ],
    descriptors: [],
    tryFit: false,
  }
  const model = buildExportedMotionDebugModel({
    trace, parsed, postprocessorTrace: ppTrace,
    origin: ZERO_ORIGIN, definition: grblDefinition(), tolerance: 0.01,
  })
  assert(model.diagnostic.state === 'verified',
    `expected verified, got ${model.diagnostic.state}: ${JSON.stringify(model.diagnostic.warnings)}`)
}

function testExportedLayerInProjectCoords(): void {
  console.log('Testing the exported layer is mapped back to project coordinates...')
  // With a non-zero origin and identity axis mapping, the parsed machine coords
  // must be shifted back into project space for the exported layer.
  const trace = makeTrace()
  const parsed = parseGcodeMotion('G0 X0 Y0 Z0\nG1 X15 Y0 Z0', 'ij', '(', ')')
  const ppTrace = makePostprocessorTrace()
  const model = buildExportedMotionDebugModel({
    trace, parsed, postprocessorTrace: ppTrace,
    origin: ORIGIN, definition: grblDefinition(), tolerance: 0.01,
  })
  const exportedCut = model.layers.exported.segments.find((s) => s.cutting && s.kind === 'linear')
  assert(exportedCut != null, 'exported layer has a cutting segment')
  // machine (15,0,0) + origin (10,20,0): project x = 15+10 = 25, y = 20-0 = 20.
  assert(approx(exportedCut!.to.x, 25) && approx(exportedCut!.to.y, 20),
    `exported endpoint in project coords ${JSON.stringify(exportedCut!.to)}`)
}

function testArcDirectionFlipParity(): void {
  console.log('Testing machineToProjectFlipsArcDirection parity across axis mappings...')
  const cases: { x: AxisSpec; y: AxisSpec; flips: boolean }[] = [
    { x: 'X', y: 'Y', flips: false },     // identity
    { x: '-X', y: '-Y', flips: false },   // 180° rotation — chirality preserved
    { x: '-X', y: 'Y', flips: true },     // single mirror
    { x: 'X', y: '-Y', flips: true },     // single mirror
    { x: 'Y', y: 'X', flips: true },      // axis swap
    { x: '-Y', y: 'X', flips: false },    // swap + mirror = rotation
  ]
  for (const c of cases) {
    const def = withCoordinateSystem(c.x, c.y)
    assert(machineToProjectFlipsArcDirection(def) === c.flips,
      `xAxis=${c.x} yAxis=${c.y}: expected flips=${c.flips}`)
  }
}

function testMirroredMachineFlipsExportedArc(): void {
  console.log('Testing a mirrored machine flips the exported layer arc direction...')
  // Machine-space CW quarter arc (G2) from (1,0) to (0,-1) about the origin.
  const parsed = parseGcodeMotion('G0 X1 Y0 Z-1\nG2 X0 Y-1 Z-1 I-1 J0 F100', 'ij', '(', ')')
  const build = (definition: MachineDefinition) => buildExportedMotionDebugModel({
    trace: makeTrace(), parsed, postprocessorTrace: makePostprocessorTrace(),
    origin: ZERO_ORIGIN, definition, tolerance: 0.01,
  }).layers.exported.segments.find((s) => s.kind === 'arc')

  const identity = build(grblDefinition())
  assert(identity != null && identity.clockwise === true,
    `identity mapping keeps machine CW, got ${JSON.stringify(identity)}`)

  const mirrored = build(withCoordinateSystem('-X', 'Y'))
  assert(mirrored != null && mirrored.clockwise === false,
    `mirrored X flips the rendered arc to CCW, got ${JSON.stringify(mirrored)}`)
  // Endpoints/centre still map through the inverse transform: machine (1,0)
  // with xAxis '-X' → project (-1, 0).
  assert(approx(mirrored!.from.x, -1) && approx(mirrored!.from.y, 0),
    `mirrored arc start in project coords ${JSON.stringify(mirrored!.from)}`)

  const rotated = build(mirroredDefinition())
  assert(rotated != null && rotated.clockwise === true,
    `180° mapping (-X/-Y) keeps machine CW, got ${JSON.stringify(rotated)}`)
}

// ── Arc-vs-source comparison (issue #370) ────────────────────────────
// A fitted arc is verified against the reference *vertices* it spans, not the
// chords between them. These cover both directions of that change: the false
// positive it removes, and the real faults it must still catch.

/** Chord approximation of a circular sweep at `stepDeg`, as the toolpath holds it. */
function circleChords(radius: number, toDeg: number, stepDeg: number, z: number): ToolpathPoint[] {
  const pts: ToolpathPoint[] = []
  for (let deg = 0; deg <= toDeg; deg += stepDeg) {
    const a = (deg * Math.PI) / 180
    pts.push(pt(radius * Math.cos(a), radius * Math.sin(a), z))
  }
  return pts
}

function chordMoves(pts: ToolpathPoint[]): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  for (let i = 0; i < pts.length - 1; i++) moves.push(cut(pts[i], pts[i + 1]))
  return moves
}

/**
 * Large-radius curve whose chord sagitta exceeds the tolerance. The exported
 * arc is correct — it is the *more* accurate path — so this must verify.
 * Before #370 the chord-based comparison charged it the full 0.0285 mm sagitta
 * and reported a deviation.
 */
function testFittedArcOverCoarseChordsVerifies(): void {
  console.log('Testing a correctly fitted arc over coarse source chords verifies (issue #370)...')
  const radius = 30
  const z = -1
  const pts = circleChords(radius, 90, 5, z)
  const sagitta = radius * (1 - Math.cos((2.5 * Math.PI) / 180))
  assert(sagitta > 0.01, `fixture must exceed tolerance to be meaningful, sagitta ${sagitta}`)

  const optimized = { operationId: 'op', moves: chordMoves(pts), warnings: [], bounds: null }
  const trace = { operationId: 'op', raw: optimized, optimized }
  // Project (x,y) → machine (x,-y) under identity axes at a zero origin, so the
  // quarter circle runs machine (30,0) → (0,-30) clockwise about the centre.
  const parsed = parseGcodeMotion(`G0 X${radius} Y0 Z${z}\nG2 X0 Y-${radius} Z${z} I-${radius} J0 F100`, 'ij', '(', ')')
  const ppTrace: OperationMotionTrace = {
    operationId: 'op',
    machineMoves: [rapid(pt(radius, 0, 5), pt(radius, 0, z)), cut(pt(radius, 0, z), pt(0, -radius, z))],
    descriptors: [
      { kind: 'linear', point: pt(radius, 0, z), moveKind: 'rapid' },
      {
        kind: 'arc',
        startPoint: pt(radius, 0, z),
        endPoint: pt(0, -radius, z),
        centerOffsets: { i: -radius, j: 0 },
        clockwise: true,
        runId: 0,
        runFallback: [{ kind: 'linear', point: pt(0, -radius, z), moveKind: 'cut' }],
      },
    ],
    tryFit: true,
  }
  const model = buildExportedMotionDebugModel({
    trace, parsed, postprocessorTrace: ppTrace,
    origin: ZERO_ORIGIN, definition: grblDefinition(), tolerance: 0.01,
  })
  assert(model.diagnostic.state === 'verified',
    `expected verified, got ${model.diagnostic.state}: ${JSON.stringify(model.diagnostic.warnings)}`)
}

/** Shared fixture builder for the fault cases: same chords, swapped-in G-code. */
function modelForExportedGcode(gcode: string, pts: ToolpathPoint[], z: number) {
  const optimized = { operationId: 'op', moves: chordMoves(pts), warnings: [], bounds: null }
  const trace = { operationId: 'op', raw: optimized, optimized }
  const first = pts[0]
  const last = pts[pts.length - 1]
  const ppTrace: OperationMotionTrace = {
    operationId: 'op',
    machineMoves: [
      rapid(pt(first.x, -first.y, 5), pt(first.x, -first.y, z)),
      cut(pt(first.x, -first.y, z), pt(last.x, -last.y, z)),
    ],
    descriptors: [],
    tryFit: false,
  }
  return buildExportedMotionDebugModel({
    trace, parsed: parseGcodeMotion(gcode, 'ij', '(', ')'), postprocessorTrace: ppTrace,
    origin: ZERO_ORIGIN, definition: grblDefinition(), tolerance: 0.01,
  })
}

/** A displaced arc centre lifts the source vertices off the arc. */
function testWrongArcCentreStillWarns(): void {
  console.log('Testing a displaced arc centre still warns (issue #370 must not mask faults)...')
  const radius = 30
  const z = -1
  const pts = circleChords(radius, 90, 5, z)
  // J0.2 puts the centre at (0, 0.2) instead of the origin.
  const model = modelForExportedGcode(
    `G0 X${radius} Y0 Z${z}\nG2 X0 Y-${radius} Z${z} I-${radius} J0.2 F100`, pts, z)
  assert(model.diagnostic.warnings.some((w) => w.kind === 'arcDeviation'),
    `expected an arcDeviation warning, got ${JSON.stringify(model.diagnostic.warnings)}`)
}

/** A spurious arc fitted across a straight run bulges away from its interior vertices. */
function testSpuriousArcOverStraightRunStillWarns(): void {
  console.log('Testing a spurious arc across a straight run still warns (issue #370)...')
  const z = -1
  const pts = [pt(0, 0, z), pt(10, 0, z), pt(20, 0, z)]
  // Arc of radius ~50.99 about (10,-50) in machine space — bulges ~0.99 away
  // from the collinear interior vertex at (10,0).
  const model = modelForExportedGcode(`G0 X0 Y0 Z${z}\nG3 X20 Y0 Z${z} I10 J-50 F100`, pts, z)
  assert(model.diagnostic.warnings.some((w) => w.kind === 'arcDeviation'),
    `expected an arcDeviation warning, got ${JSON.stringify(model.diagnostic.warnings)}`)
}

/**
 * A closed contour repeats its opening vertex at the end, so the last arc's end
 * point matches both. Each arc must still be measured against only the run it
 * covers — otherwise the final arc claims the whole loop and every vertex
 * outside its 90° sweep is scored against an endpoint.
 */
function testClosedContourArcsSpanOnlyTheirOwnRun(): void {
  console.log('Testing arcs on a closed contour span only their own run (issue #370)...')
  const radius = 30
  const z = -1
  const pts = circleChords(radius, 360, 5, z)
  const optimized = { operationId: 'op', moves: chordMoves(pts), warnings: [], bounds: null }
  const trace = { operationId: 'op', raw: optimized, optimized }
  // Full circle emitted the way arc fitting splits it: four ≤90° G2 sub-arcs.
  const parsed = parseGcodeMotion([
    `G0 X${radius} Y0 Z${z}`,
    `G2 X0 Y-${radius} Z${z} I-${radius} J0 F100`,
    `G2 X-${radius} Y0 Z${z} I0 J${radius}`,
    `G2 X0 Y${radius} Z${z} I${radius} J0`,
    `G2 X${radius} Y0 Z${z} I0 J-${radius}`,
  ].join('\n'), 'ij', '(', ')')
  const ppTrace: OperationMotionTrace = {
    operationId: 'op',
    machineMoves: [
      rapid(pt(radius, 0, 5), pt(radius, 0, z)),
      cut(pt(radius, 0, z), pt(0, -radius, z)),
      cut(pt(0, -radius, z), pt(-radius, 0, z)),
      cut(pt(-radius, 0, z), pt(0, radius, z)),
      cut(pt(0, radius, z), pt(radius, 0, z)),
    ],
    descriptors: [],
    tryFit: false,
  }
  const model = buildExportedMotionDebugModel({
    trace, parsed, postprocessorTrace: ppTrace,
    origin: ZERO_ORIGIN, definition: grblDefinition(), tolerance: 0.01,
  })
  const deviations = model.diagnostic.warnings.filter((w) => w.kind === 'arcDeviation')
  assert(deviations.length === 0,
    `closed contour should report no arc deviation, got ${JSON.stringify(deviations)}`)
}

/**
 * An arc joining the right endpoints the *short* way, over a run that swept the
 * long way round. Endpoints match, so an endpoint-only check would pass it, but
 * the machine would cut a completely different path — the intervening vertices
 * fall outside the arc's sweep.
 */
function testMajorArcTakenTheShortWayStillWarns(): void {
  console.log('Testing an arc that takes the short way round a major-arc run still warns (issue #370)...')
  const radius = 30
  const z = -1
  // Source sweeps 270°: project (30,0) → (0,-30) the long way round.
  const pts = circleChords(radius, 270, 5, z)
  // Exported joins the same endpoints with a 90° arc instead.
  const model = modelForExportedGcode(
    `G0 X${radius} Y0 Z${z}\nG3 X0 Y${radius} Z${z} I-${radius} J0 F100`, pts, z)
  assert(model.diagnostic.warnings.some((w) => w.kind === 'arcDeviation'),
    `expected an arcDeviation warning, got ${JSON.stringify(model.diagnostic.warnings)}`)
}

testEligibility()
testInverseTransform()
testRotaryAngleInverse()
testRotaryProgramReadback()
testArcDirectionFlipParity()
testMirroredMachineFlipsExportedArc()
testBuildModelVerified()
testBuildModelNoPositioningRapid()
testInitialPlungeIsNotComparedAsPlanarCut()
testDiagnosticCountMismatch()
testExportedLayerInProjectCoords()
testFittedArcOverCoarseChordsVerifies()
testWrongArcCentreStillWarns()
testSpuriousArcOverStraightRunStillWarns()
testClosedContourArcsSpanOnlyTheirOwnRun()
testMajorArcTakenTheShortWayStillWarns()

console.log('motionDebug tests passed')
