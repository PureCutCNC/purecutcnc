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
 * The exported program read back as project-space motion (issue #1261):
 * Top and Bottom setups in millimetres and inches, arcs flattened, feeds and
 * `feedScale` carried, canned cycles expanded, the grblHAL `G53` footer, the
 * ShopBot dialect, the rotary angle (own axis and borrowed motor), the
 * manual-index opening turn of a bar, and the structured reasons.
 *
 * Run with: npx tsx src/engine/gcode/exportedMotion.test.ts
 */

import { defaultTool, newProject, rectProfile, roundStock } from '../../types/project'
import type { Operation, Project } from '../../types/project'
import { BOTTOM_SETUP_ID, withBottomSetup } from '../../test/projectFixtures'
import { syncProjectSetups } from '../../store/helpers/setups'
import { convertLength, exportGeometryTolerance } from '../../utils/units'
import type { Units } from '../../utils/units'
import type { DrillCycle, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { exportOperationMotion } from './exportedMotion'
import type { ExportedOperationMotion } from './exportedMotion'
import { compareExportedToInternal, exportParityTolerance, verifyExportedOperation } from './exportParity'
import { validateMachineDefinition } from './types'
import type { MachineDefinition } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  if (!found) throw new Error(`no bundled definition ${id}`)
  return validateMachineDefinition(structuredClone(found))
}

// ── Fixtures ──────────────────────────────────────────────────

function operationOf(id: string, units: Units, overrides: Partial<Operation> = {}): Operation {
  const len = (mm: number) => convertLength(mm, 'mm', units)
  return {
    id, name: `Op ${id}`, kind: 'pocket', pass: 'rough', enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'stock' }, toolRef: 't1', stepdown: len(1), stepover: 0.4,
    feed: len(600), plungeFeed: len(180), rpm: 12000, pocketPattern: 'offset', pocketAngle: 0,
    stockToLeaveRadial: 0, stockToLeaveAxial: 0, finishWalls: true, finishFloor: true,
    carveDepth: len(1), maxCarveDepth: len(1),
    ...overrides,
  }
}

/** A 100 × 80 × 20 mm block (in `units`), origin at the front-left of the top face. */
function blockProject(units: Units, face: 'top' | 'bottom', overrides: Partial<Operation> = {}): Project {
  const len = (mm: number) => convertLength(mm, 'mm', units)
  const project = newProject('Exported motion', units)
  project.stock = { ...project.stock, profile: rectProfile(0, 0, len(100), len(80)), thickness: len(20) }
  project.origin = { name: 'Origin', x: 0, y: len(80), z: len(20), visible: true }
  project.tools = [{ ...defaultTool(units, 1), id: 't1', name: 'Tool 1' }]
  const synced = syncProjectSetups({ ...project, operations: [operationOf('op1', units, { setupId: project.activeSetupId, ...overrides })] })
  return face === 'top' ? synced : withBottomSetup(synced, { operationIds: ['op1'] })
}

/**
 * A pocket pass in stock space: a plunge, a straight cut at half feed, and a
 * full circle of short chords the exporter fits as arcs. A Bottom operation
 * holds the same pass mirrored in Z: clear below the stock, cutting upward.
 */
function passMoves(units: Units, face: 'top' | 'bottom'): ToolpathMove[] {
  const len = (mm: number) => convertLength(mm, 'mm', units)
  const clear = face === 'top' ? len(25) : len(-5)
  const cut = face === 'top' ? len(15) : len(5)
  const centre = { x: len(50), y: len(40) }
  const radius = len(10)
  const at = (index: number): ToolpathPoint => {
    const angle = (index / 72) * Math.PI * 2
    return { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle), z: cut }
  }
  const start = { x: len(20), y: len(40), z: cut }
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: { ...start, z: clear }, to: { ...start, z: clear } },
    { kind: 'plunge', from: { ...start, z: clear }, to: start },
    { kind: 'cut', from: start, to: at(0), feedScale: 0.5 },
  ]
  for (let index = 0; index < 72; index += 1) moves.push({ kind: 'cut', from: at(index), to: at(index + 1) })
  moves.push({ kind: 'rapid', from: at(72), to: { ...at(72), z: clear } })
  return moves
}

function toolpathOf(moves: ToolpathMove[], drillCycles?: DrillCycle[]): ToolpathResult {
  return { operationId: 'op1', warnings: [], bounds: null, moves, ...(drillCycles ? { drillCycles } : null) }
}

function exported(project: Project, definition: MachineDefinition, toolpath: ToolpathResult): ExportedOperationMotion {
  return exportOperationMotion({ project, operation: project.operations[0], toolpath, definition })
}

function near(a: ToolpathPoint, b: ToolpathPoint, tolerance: number): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.z - b.z) <= tolerance
}

// ── Tests ─────────────────────────────────────────────────────

function testTopAndBottomRoundTrip(): void {
  console.log('Testing Top and Bottom, mm and inch, come back in stock space...')
  for (const units of ['mm', 'inch'] as const) {
    for (const face of ['top', 'bottom'] as const) {
      const label = `${face} ${units}`
      const project = blockProject(units, face)
      if (face === 'bottom') assert(project.operations[0].setupId === BOTTOM_SETUP_ID, `${label}: the operation is in the Bottom setup`)
      const moves = passMoves(units, face)
      for (const id of ['grbl', 'linuxcnc', 'shopbot']) {
        const motion = exported(project, bundled(id), toolpathOf(moves))
        assert(motion.status === 'verified', `${label} ${id}: verified, got ${motion.status} ${JSON.stringify(motion.reasons)}`)
        assert(motion.program.length > 0, `${label} ${id}: a program was written`)
        // The plunge comes back where it started, in stock space.
        const plunge = motion.moves.find((move) => move.kind === 'plunge')
        const tolerance = exportGeometryTolerance(units)
        assert(plunge && near(plunge.to, moves[1].to, tolerance), `${label} ${id}: the plunge ends at the stock-space cut point, got ${JSON.stringify(plunge)}`)
        // Arcs are flattened: many more feed moves than the program has arc words.
        const feeds = motion.moves.filter((move) => move.kind !== 'rapid')
        assert(feeds.length > 20, `${label} ${id}: the arcs are flattened into short moves (${feeds.length})`)
        // Every feed move sits on the cutting height.
        const cutZ = moves[1].to.z
        assert(feeds.filter((move) => move.kind === 'cut').every((move) => Math.abs(move.to.z - cutZ) <= tolerance), `${label} ${id}: cuts at the cutting Z`)
        const parity = compareExportedToInternal(moves, motion.moves, {
          operationId: 'op1', tolerance: exportParityTolerance(units), stock: project.stock,
          feeds: { cut: project.operations[0].feed, plunge: project.operations[0].plungeFeed }, exportStatus: motion.status,
          feedQuantum: units === 'mm' ? 0.0005 : 0.00005,
        })
        assert(parity.verdict === 'verified', `${label} ${id}: parity verified, got ${parity.verdict} ${JSON.stringify(parity.deviations.slice(0, 3))}`)
      }
    }
  }
}

function testFeedsAndFeedScale(): void {
  console.log('Testing every feed move keeps the feed it ran at, feedScale included...')
  for (const id of ['grbl', 'shopbot']) {
    const project = blockProject('mm', 'top')
    const moves = passMoves('mm', 'top')
    const motion = exported(project, bundled(id), toolpathOf(moves))
    const plunge = motion.moves.find((move) => move.kind === 'plunge')
    assert(plunge?.feed !== undefined && Math.abs(plunge.feed - 180) < 1e-6, `${id}: the plunge runs at the plunge feed, got ${plunge?.feed}`)
    const slow = motion.moves.find((move) => move.kind === 'cut' && Math.abs(move.to.x - 60) < 1e-3 && Math.abs(move.to.y - 40) < 1e-3)
    assert(slow?.feed !== undefined && Math.abs(slow.feed - 300) < 0.01, `${id}: the half-feed cut runs at 300, got ${slow?.feed}`)
    assert(motion.moves.filter((move) => move.kind === 'rapid').every((move) => move.feed === undefined), `${id}: rapids carry no feed`)
  }
}

function testCannedCyclesExpand(): void {
  console.log('Testing canned cycles come back as the controller\'s plunges...')
  for (const drillType of ['simple', 'peck', 'dwell', 'chip_breaking'] as const) {
    const project = blockProject('mm', 'top', { kind: 'drilling', drillType, peckDepth: 2 })
    const cycles: DrillCycle[] = [10, 30].map((x) => ({
      x, y: 40, clearZ: 25, retractZ: 21, bottomZ: 14, drillType, peckDepth: 2, dwellTime: 0.5,
    }))
    const moves: ToolpathMove[] = []
    for (const cycle of cycles) {
      moves.push({ kind: 'rapid', from: { x: cycle.x, y: cycle.y, z: 25 }, to: { x: cycle.x, y: cycle.y, z: 21 } })
      moves.push({ kind: 'plunge', from: { x: cycle.x, y: cycle.y, z: 21 }, to: { x: cycle.x, y: cycle.y, z: 14 } })
      moves.push({ kind: 'rapid', from: { x: cycle.x, y: cycle.y, z: 14 }, to: { x: cycle.x, y: cycle.y, z: 25 } })
    }
    const toolpath = toolpathOf(moves, cycles)
    const motion = exported(project, bundled('linuxcnc'), toolpath)
    const command = { simple: 'G81', peck: 'G83', dwell: 'G82', chip_breaking: 'G73' }[drillType]
    assert(motion.program.includes(command), `${drillType}: the program writes ${command}`)
    assert(motion.status === 'verified', `${drillType}: verified, got ${motion.status} ${JSON.stringify(motion.reasons)}`)
    const plunges = motion.moves.filter((move) => move.kind === 'plunge')
    const pecked = drillType === 'peck' || drillType === 'chip_breaking'
    assert(pecked ? plunges.length === 8 : plunges.length === 2, `${drillType}: ${pecked ? 'four pecks' : 'one plunge'} per hole, got ${plunges.length}`)
    for (const x of [10, 30]) {
      const deepest = Math.min(...plunges.filter((move) => Math.abs(move.to.x - x) < 1e-6).map((move) => move.to.z))
      assert(Math.abs(deepest - 14) < 1e-6, `${drillType}: the hole at X${x} reaches the bottom, got ${deepest}`)
    }
    assert(plunges.every((move) => move.feed === 180), `${drillType}: every plunge keeps the plunge F`)
    if (drillType === 'chip_breaking') {
      assert(motion.reasons.some((reason) => reason.code === 'chipBreakRetractApproximate' && reason.severity === 'info' && reason.count === 2),
        `the approximation is listed once with its count, got ${JSON.stringify(motion.reasons)}`)
    }
    const { parity } = verifyExportedOperation({ project, operation: project.operations[0], toolpath, definition: bundled('linuxcnc') })
    assert(parity.verdict === 'verified', `${drillType}: parity verified, got ${parity.verdict} ${JSON.stringify(parity.deviations.slice(0, 2))}`)
  }
}

function testGrblhalFooterIsUnderstood(): void {
  console.log('Testing the grblHAL G53 footer no longer makes the program unsupported...')
  const project = blockProject('mm', 'top')
  const definition = bundled('grblhal')
  assert(definition.program.footer.includes('G0 G53 Z0'), 'the bundled footer retracts in machine coordinates')
  const motion = exported(project, definition, toolpathOf(passMoves('mm', 'top')))
  assert(motion.status === 'verified', `verified, got ${motion.status} ${JSON.stringify(motion.reasons)}`)
  assert(motion.reasons.some((reason) => reason.code === 'machineCoordinateRetract' && reason.severity === 'info'), 'the retract is listed as info')
}

function testRotaryOwnAndBorrowed(): void {
  console.log('Testing a turning program comes back with its angle, own axis and borrowed motor...')
  const project = newProject('Rotary exported motion', 'mm')
  project.stock = roundStock(20, 100, 'x')
  project.origin = { name: 'Origin', x: 0, y: 10, z: 20, visible: true }
  project.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Tool 1' }]
  const withOp = syncProjectSetups({ ...project, operations: [operationOf('op1', 'mm', { setupId: project.activeSetupId })] })
  const p = (x: number, z: number, a: number): ToolpathPoint => ({ x, y: 10, z, a })
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: p(0, 30, 0), to: p(0, 30, 0) },
    { kind: 'plunge', from: p(0, 30, 0), to: p(0, 19, 0) },
    { kind: 'cut', from: p(0, 19, 0), to: p(10, 19, 90) },
    { kind: 'cut', from: p(10, 19, 90), to: p(20, 19, 90) },
    { kind: 'rapid', from: p(20, 19, 90), to: p(20, 30, 90) },
  ]
  for (const id of ['grblhal-rotary', 'grbl-rotary']) {
    const definition = BUNDLED_DEFINITIONS.find((candidate) => candidate.id === id)!
    const motion = exported(withOp, validateMachineDefinition(structuredClone(definition)), toolpathOf(moves))
    assert(motion.status === 'verified', `${id}: verified, got ${motion.status} ${JSON.stringify(motion.reasons)}`)
    const turning = motion.moves.find((move) => move.inverseTimeFeed !== undefined)
    assert(turning && turning.to.a !== undefined && Math.abs(turning.to.a - 90) < 1e-3, `${id}: the turning move ends at A90`)
    assert(Math.abs(turning.to.y - 10) < 1e-6, `${id}: the across coordinate is the bar's`)
    if (id === 'grbl-rotary') {
      // The Y motor drives the bar: the program has no linear Y at all.
      assert(motion.reasons.some((reason) => reason.code === 'axisNotStated' && reason.axis === 'y'), `${id}: the unstated Y is listed`)
    }
    const { parity } = verifyExportedOperation({ project: withOp, operation: withOp.operations[0], toolpath: toolpathOf(moves), definition })
    assert(parity.verdict === 'verified', `${id}: parity verified, got ${parity.verdict} ${JSON.stringify(parity.deviations.slice(0, 2))}`)
    // A mm-only machine refuses the same program in inches, and says so.
  }
  const inch = { ...withOp, meta: { ...withOp.meta, units: 'inch' as const } }
  const refused = exported(inch, bundled('grbl-rotary'), toolpathOf(moves))
  assert(refused.status === 'failed', `an inch program on a mm-only rotary is refused, got ${refused.status}`)
  assert(refused.reasons.some((reason) => reason.code === 'operationRefused'), 'with operationRefused')
  assert(refused.postWarnings.some((warning) => warning.code === 'postRotaryInchUnits'), 'and the post\'s own warning')
}

function testManualIndexBar(): void {
  console.log('Testing a Bottom operation on a bar: the opening A180 is the setup frame...')
  const base = newProject('Manual index', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(20, 100, 'x')
  base.origin = { name: 'Origin', x: 0, y: 10, z: 20, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Tool 1' }]
  for (const face of ['top', 'bottom'] as const) {
    const synced = syncProjectSetups({ ...base, operations: [operationOf('op1', 'mm', { setupId: base.activeSetupId })] })
    const project = face === 'top' ? synced : withBottomSetup(synced, { operationIds: ['op1'] })
    // A flat cut across the bar's top (Top) or bottom (Bottom), in stock space.
    const z = face === 'top' ? 19 : 1
    const clear = face === 'top' ? 30 : -10
    const moves: ToolpathMove[] = [
      { kind: 'rapid', from: { x: 10, y: 10, z: clear }, to: { x: 10, y: 10, z: clear } },
      { kind: 'plunge', from: { x: 10, y: 10, z: clear }, to: { x: 10, y: 10, z } },
      { kind: 'cut', from: { x: 10, y: 10, z }, to: { x: 40, y: 10, z } },
      { kind: 'rapid', from: { x: 40, y: 10, z }, to: { x: 40, y: 10, z: clear } },
    ]
    const definition = bundled('grblhal-rotary')
    const motion = exported(project, definition, toolpathOf(moves))
    assert(motion.program.includes(face === 'top' ? 'A0' : 'A180'), `${face}: the program turns the bar to its face`)
    assert(motion.status === 'verified', `${face}: verified, got ${motion.status} ${JSON.stringify(motion.reasons)}`)
    const cut = motion.moves.find((move) => move.kind === 'cut')
    assert(cut && cut.to.a === undefined, `${face}: the cut carries no angle: the setup frame is the turn`)
    assert(cut && Math.abs(cut.to.z - z) < 1e-3, `${face}: the cut is at stock Z ${z}, got ${cut?.to.z}`)
    assert(
      motion.reasons.some((reason) => reason.code === 'manualIndexTurnRemoved') === (face === 'bottom'),
      `${face}: the removed turn is listed only when there was one, got ${JSON.stringify(motion.reasons)}`,
    )
    const { parity } = verifyExportedOperation({ project, operation: project.operations[0], toolpath: toolpathOf(moves), definition })
    assert(parity.verdict === 'verified', `${face}: parity verified, got ${parity.verdict} ${JSON.stringify(parity.deviations.slice(0, 2))}`)
  }
}

function testReasonsAreCodes(): void {
  console.log('Testing a refusal comes back as failed with codes, never English...')
  const project = blockProject('mm', 'top')
  const noTool = exportOperationMotion({
    project: { ...project, tools: [] }, operation: project.operations[0], toolpath: toolpathOf(passMoves('mm', 'top')), definition: bundled('grbl'),
  })
  assert(noTool.status === 'failed' && noTool.reasons[0]?.code === 'noTool', `no tool is failed/noTool, got ${JSON.stringify(noTool.reasons)}`)
  const motion = exported(project, bundled('uccnc'), toolpathOf(passMoves('mm', 'top')))
  for (const reason of motion.reasons) {
    assert(/^[a-zA-Z]+$/.test(reason.code), `a reason is a code, got ${reason.code}`)
  }
}

function testChangedProgramIsCaught(): void {
  console.log('Testing a program that cuts something else is caught end to end...')
  for (const face of ['top', 'bottom'] as const) {
    const project = blockProject('mm', face)
    const moves = passMoves('mm', face)
    const options = {
      operationId: 'op1', tolerance: exportParityTolerance('mm'), stock: project.stock,
      feeds: { cut: 600, plunge: 180 }, feedQuantum: 0.0005,
    }
    // Post a toolpath whose circle is 0.2 mm larger, compare with the real one.
    const larger = moves.map((move, index) => index < 3 || move.kind === 'rapid' ? move : {
      ...move,
      from: { ...move.from, x: 50 + (move.from.x - 50) * 1.02, y: 40 + (move.from.y - 40) * 1.02 },
      to: { ...move.to, x: 50 + (move.to.x - 50) * 1.02, y: 40 + (move.to.y - 40) * 1.02 },
    })
    const motion = exported(project, bundled('grbl'), toolpathOf(larger))
    const parity = compareExportedToInternal(moves, motion.moves, { ...options, exportStatus: motion.status })
    assert(parity.verdict === 'deviation' && Math.abs(parity.maxDistance - 0.2) < 0.02, `${face}: a 0.2 mm larger circle is caught, got ${parity.verdict} ${parity.maxDistance}`)
    // Both faces cut 5 mm into the face that is up: machine Z-5 either way,
    // so the read-back really undid the Bottom turn rather than echoing it.
    const real = exported(project, bundled('grbl'), toolpathOf(moves))
    assert(/^G1 X20\.000 Y40\.000 Z-5\.000 /m.test(real.program), `${face}: the program cuts at machine Z-5:\n${real.program}`)
  }
}

testTopAndBottomRoundTrip()
testChangedProgramIsCaught()
testFeedsAndFeedScale()
testCannedCyclesExpand()
testGrblhalFooterIsUnderstood()
testRotaryOwnAndBorrowed()
testManualIndexBar()
testReasonsAreCodes()

console.log('exportedMotion tests passed')
