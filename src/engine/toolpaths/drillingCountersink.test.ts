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
 * V-bit countersinking (issue #489).
 *
 * The dimension the operator enters is the finished mouth diameter; the plunge
 * depth is derived from it and the V-bit's included angle. Two things therefore
 * have to hold and are asserted here for both a 90° and an 82° cutter: the tip
 * stops at exactly `D / (2·tan(θ/2))` below *that target's own* top face, and
 * every rejected configuration emits no motion at all rather than a plunge to
 * some approximated depth.
 *
 * The third property is a postprocessor one: countersink output must stay
 * expanded G0/G1. No canned cycle can express "plunge to a depth derived from a
 * cone angle", so a machine that supports G81 must still receive linear moves.
 *
 * Run with: npx tsx src/engine/toolpaths/drillingCountersink.test.ts
 */

import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import type { MachineDefinition } from '../gcode/types'
import { normalizeToolForProject } from './geometry'
import { optimizeLinearMoves } from './linearMoveOptimization'
import { countersinkTipDepth, generateDrillingToolpath } from './drilling'
import type { ToolpathMove, ToolpathResult } from './types'

const EPS = 1e-9

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, tolerance = 1e-9): boolean {
  return Math.abs(a - b) <= tolerance
}

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────

const STOCK_THICKNESS = 18

/** A machine that *does* support canned cycles, so the linear-output claim bites. */
function cannedCycleMachine(): MachineDefinition {
  return validateMachineDefinition({
    id: 'test',
    name: 'Test',
    description: 'Test controller with canned cycles',
    builtin: false,
    fileExtension: 'nc',
    coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
    numberFormat: { decimalPlaces: { mm: 3, inch: 4 }, trailingZeros: false, leadingZero: true },
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
      cancelCommand: 'G80',
      retractMode: 'G98',
      peckStepWord: 'Q',
    },
    coolant: null,
    stop: { programEndCommand: 'M30' },
  })
}

function circleFeature(id: string, cx: number, cy: number, r: number, topZ = STOCK_THICKNESS): SketchFeature {
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
    z_top: topZ,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

/** A non-circular target: valid geometry, but nothing a countersink can seat in. */
function rectFeature(id: string): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(60, 10, 20, 20),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: STOCK_THICKNESS,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function vBit(angle: number, diameter = 12.7, maxCutDepth = 0): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 't1',
    name: `${angle}° V-bit`,
    type: 'v_bit',
    diameter,
    vBitAngle: angle,
    maxCutDepth,
  }
}

function drill(diameter = 3): Tool {
  return { ...defaultTool('mm', 1), id: 't1', name: `${diameter} mm drill`, type: 'drill', diameter }
}

function fixture(tool: Tool, features: SketchFeature[]): Project {
  const base = newProject('countersink', 'mm')
  return projectWithFeatures(
    { ...base, stock: { ...base.stock, thickness: STOCK_THICKNESS }, tools: [tool] },
    features,
  )
}

function drillOp(overrides: Partial<Operation>): Operation {
  return {
    id: 'op1',
    name: 'countersink',
    kind: 'drilling',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['h1'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 150,
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
    ...overrides,
  } as Operation
}

function post(project: Project, operation: Operation, toolpath: ToolpathResult): string {
  const toolRecord = project.tools.find((t) => t.id === operation.toolRef)!
  return runPostProcessor({
    project,
    definition: cannedCycleMachine(),
    operations: [{
      operation,
      tool: normalizeToolForProject(toolRecord, project),
      toolpath: optimizeLinearMoves(toolpath),
    }],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode
}

function plunges(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((m) => m.kind === 'plunge')
}

/** No cut at all: the whole point of every rejection below. */
function assertNoCut(result: ToolpathResult, code: string, label: string): void {
  assert(result.moves.length === 0, `${label}: expected no moves, got ${result.moves.length}`)
  assert((result.drillCycles ?? []).length === 0, `${label}: expected no drill cycles`)
  assert(
    result.warnings.some((w) => w.code === code),
    `${label}: expected a ${code} warning, got [${result.warnings.map((w) => w.code).join(', ')}]`,
  )
}

// ── Derived depth ────────────────────────────────────────────────────

console.log('\nCountersink depth derivation (issue #489)')

test('90° V-bit: a 6 mm mouth plunges 3 mm (tan 45° = 1)', () => {
  const project = fixture(vBit(90), [circleFeature('h1', 20, 20, 1.5)])
  const operation = drillOp({ drillType: 'countersink', countersinkDiameter: 6 })
  const result = generateDrillingToolpath(project, operation)

  const cut = plunges(result.moves)
  assert(cut.length === 1, `expected exactly 1 plunge, got ${cut.length}`)
  assert(approx(cut[0].to.z, STOCK_THICKNESS - 3), `plunge should stop at Z ${STOCK_THICKNESS - 3}, got ${cut[0].to.z}`)
  assert(approx(countersinkTipDepth(6, 90) ?? 0, 3), 'tip depth helper should agree')
})

test('82° V-bit: depth follows D / (2·tan(θ/2)), not the 90° shortcut', () => {
  const project = fixture(vBit(82), [circleFeature('h1', 20, 20, 1.5)])
  const operation = drillOp({ drillType: 'countersink', countersinkDiameter: 8 })
  const result = generateDrillingToolpath(project, operation)

  const expectedDepth = 8 / (2 * Math.tan((41 * Math.PI) / 180))
  assert(approx(expectedDepth, 4.6015, 1e-4), `sanity: 82° depth for an 8 mm mouth is ~4.6015, computed ${expectedDepth}`)

  const cut = plunges(result.moves)
  assert(cut.length === 1, `expected exactly 1 plunge, got ${cut.length}`)
  assert(
    approx(cut[0].to.z, STOCK_THICKNESS - expectedDepth, 1e-9),
    `plunge should stop at Z ${STOCK_THICKNESS - expectedDepth}, got ${cut[0].to.z}`,
  )
  // A 90° cutter would have gone to 4 mm — assert the angle actually mattered.
  assert(!approx(cut[0].to.z, STOCK_THICKNESS - 4, 1e-3), 'depth must depend on the included angle')
})

test('depth is measured from each target’s own top face', () => {
  // Second hole sits in a feature whose top is 4 mm below the stock top.
  const project = fixture(vBit(90), [
    circleFeature('h1', 20, 20, 1.5),
    circleFeature('h2', 60, 20, 1.5, STOCK_THICKNESS - 4),
  ])
  const operation = drillOp({
    drillType: 'countersink',
    countersinkDiameter: 6,
    target: { source: 'features', featureIds: ['h1', 'h2'] },
  })
  const result = generateDrillingToolpath(project, operation)

  const cut = plunges(result.moves)
  assert(cut.length === 2, `expected 2 plunges, got ${cut.length}`)
  const depthOf = (x: number): number => {
    const move = cut.find((m) => approx(m.to.x, x))!
    const topZ = approx(x, 20) ? STOCK_THICKNESS : STOCK_THICKNESS - 4
    return topZ - move.to.z
  }
  assert(approx(depthOf(20), 3), `hole at the stock top should plunge 3 mm, got ${depthOf(20)}`)
  assert(approx(depthOf(60), 3), `recessed hole should also plunge 3 mm below its own face, got ${depthOf(60)}`)
})

test('motion is centre-plunge and retract: rapid in at safe Z, feed down, rapid out', () => {
  const project = fixture(vBit(90), [circleFeature('h1', 20, 20, 1.5)])
  const operation = drillOp({ drillType: 'countersink', countersinkDiameter: 6 })
  const result = generateDrillingToolpath(project, operation)
  const safeZ = STOCK_THICKNESS + project.meta.operationClearanceZ

  const first = result.moves[0]
  assert(first.kind === 'rapid', `first move should be a rapid, got ${first.kind}`)
  assert(
    first.from.z === safeZ && first.to.z === safeZ,
    `first move should establish the clearance plane ${safeZ}, got ${first.from.z} → ${first.to.z}`,
  )

  const cut = plunges(result.moves)[0]
  assert(approx(cut.from.x, 20) && approx(cut.from.y, 20), 'plunge must stay locked on the hole centre in X/Y')
  assert(approx(cut.to.x, 20) && approx(cut.to.y, 20), 'plunge must not move in X/Y')
  assert(cut.from.z > cut.to.z, 'plunge must descend')

  const last = result.moves[result.moves.length - 1]
  assert(last.kind === 'rapid' && approx(last.to.z, safeZ), `should retract to safe Z ${safeZ}, got ${last.to.z}`)

  // No rapid may descend below the surface. Countersinking never re-enters a
  // hole the way a peck cycle does, so the destination rule is absolute here:
  // the only rapid that touches the cone bottom is the retract *out* of it.
  for (const move of result.moves.filter((m) => m.kind === 'rapid')) {
    assert(
      move.to.z >= STOCK_THICKNESS - EPS,
      `rapid descended to Z ${move.to.z}, below the surface ${STOCK_THICKNESS}`,
    )
  }
})

// ── Fail-closed rejections ───────────────────────────────────────────

console.log('\nCountersink rejections emit no cut')

test('no V-bit assigned: a drill bit produces no countersink', () => {
  const project = fixture(drill(3), [circleFeature('h1', 20, 20, 1.5)])
  const result = generateDrillingToolpath(project, drillOp({ drillType: 'countersink', countersinkDiameter: 6 }))
  assertNoCut(result, 'drillCountersinkNeedsVBit', 'drill bit')
  assert(
    !result.warnings.some((w) => w.code === 'drillNotDrillBit'),
    'a countersink operation must not also advise fitting a drill bit',
  )
})

test('unusable V-bit angle produces no countersink', () => {
  const project = fixture({ ...vBit(90), vBitAngle: 180 }, [circleFeature('h1', 20, 20, 1.5)])
  const result = generateDrillingToolpath(project, drillOp({ drillType: 'countersink', countersinkDiameter: 6 }))
  assertNoCut(result, 'vBitAngleRange', 'flat V-bit')
})

test('missing or zero diameter produces no countersink', () => {
  const project = fixture(vBit(90), [circleFeature('h1', 20, 20, 1.5)])
  assertNoCut(
    generateDrillingToolpath(project, drillOp({ drillType: 'countersink' })),
    'drillCountersinkDiameterPositive',
    'undefined diameter',
  )
  assertNoCut(
    generateDrillingToolpath(project, drillOp({ drillType: 'countersink', countersinkDiameter: 0 })),
    'drillCountersinkDiameterPositive',
    'zero diameter',
  )
})

test('mouth wider than the cutter produces no countersink', () => {
  const project = fixture(vBit(90, 10), [circleFeature('h1', 20, 20, 1.5)])
  const result = generateDrillingToolpath(project, drillOp({ drillType: 'countersink', countersinkDiameter: 12 }))
  assertNoCut(result, 'drillCountersinkExceedsToolDiameter', 'mouth beyond cutter')

  // The boundary case is usable: a mouth exactly at the cutter diameter cuts.
  const atLimit = generateDrillingToolpath(project, drillOp({ drillType: 'countersink', countersinkDiameter: 10 }))
  assert(plunges(atLimit.moves).length === 1, 'a mouth exactly at the cutter diameter should still cut')
})

test('plunge deeper than the tool’s max cut depth produces no countersink', () => {
  const project = fixture(vBit(90, 12.7, 2), [circleFeature('h1', 20, 20, 1.5)])
  // 6 mm mouth on a 90° bit needs 3 mm of plunge; the tool is limited to 2 mm.
  const result = generateDrillingToolpath(project, drillOp({ drillType: 'countersink', countersinkDiameter: 6 }))
  assertNoCut(result, 'drillCountersinkDepthExceedsToolMax', 'over max cut depth')

  // maxCutDepth 0 means "unset" and must not reject anything.
  const unset = fixture(vBit(90, 12.7, 0), [circleFeature('h1', 20, 20, 1.5)])
  const allowed = generateDrillingToolpath(unset, drillOp({ drillType: 'countersink', countersinkDiameter: 6 }))
  assert(plunges(allowed.moves).length === 1, 'an unset max cut depth should not reject the countersink')
})

test('a tool limited to exactly its cone height still cuts a full-diameter countersink', () => {
  // The natural way to describe a V-bit: it cannot plunge past its own cone
  // height, so maxCutDepth is exactly D / (2·tan(θ/2)) — here 12 / 2 = 6.
  // Asking that same bit for its full 12 mm mouth re-derives 6 in floating
  // point as 6.000000000000001, so an exact `>` comparison would reject the
  // most ordinary countersink the tool can make.
  const derived = 12 / (2 * Math.tan(Math.PI / 4))
  assert(derived > 6, `sanity: the derivation must land above 6 to make this bite, got ${derived}`)

  const project = fixture(vBit(90, 12, 6), [circleFeature('h1', 20, 20, 1.5)])
  const result = generateDrillingToolpath(project, drillOp({ drillType: 'countersink', countersinkDiameter: 12 }))

  const cut = plunges(result.moves)
  assert(cut.length === 1, `expected the countersink to cut, got ${cut.length} plunges`)
  assert(
    !result.warnings.some((w) => w.code === 'drillCountersinkDepthExceedsToolMax'),
    'a plunge at exactly the tool limit must not be rejected',
  )
  assert(approx(cut[0].to.z, STOCK_THICKNESS - 6, 1e-9), `should plunge to the full 6 mm, got ${cut[0].to.z}`)

  // The tolerance must stay tight enough to still catch a real overrun.
  const overrun = generateDrillingToolpath(
    fixture(vBit(90, 12, 5.9), [circleFeature('h1', 20, 20, 1.5)]),
    drillOp({ drillType: 'countersink', countersinkDiameter: 12 }),
  )
  assertNoCut(overrun, 'drillCountersinkDepthExceedsToolMax', '0.1 mm past the limit')
})

test('mouth no wider than the hole skips that target and leaves the others cut', () => {
  const project = fixture(vBit(90), [
    circleFeature('h1', 20, 20, 4),   // 8 mm hole — a 6 mm mouth cannot seat in it
    circleFeature('h2', 60, 20, 1.5), // 3 mm hole — fine
  ])
  const operation = drillOp({
    drillType: 'countersink',
    countersinkDiameter: 6,
    target: { source: 'features', featureIds: ['h1', 'h2'] },
  })
  const result = generateDrillingToolpath(project, operation)

  const cut = plunges(result.moves)
  assert(cut.length === 1, `only the small hole should be countersunk, got ${cut.length} plunges`)
  assert(approx(cut[0].to.x, 60), `the surviving plunge should be at the 3 mm hole, got x=${cut[0].to.x}`)

  const warning = result.warnings.find((w) => w.code === 'drillCountersinkNotLargerThanHole')
  assert(warning !== undefined, 'the oversized hole should warn')
  assert(warning!.params?.name === 'h1', `the warning should name the skipped target, got ${warning!.params?.name}`)
  assert(warning!.params?.holeDiameter === 8, `the warning should report the hole diameter, got ${warning!.params?.holeDiameter}`)

  // A rejected target must not become the origin of the next hole's traverse:
  // every rapid stays at or above the surface, and the surviving plunge is the
  // only descent.
  const rejectedCentre = result.moves.some((m) => approx(m.to.x, 20) && m.to.z < STOCK_THICKNESS - EPS)
  assert(!rejectedCentre, 'no motion may descend at the rejected target')
})

test('non-circular targets are skipped, not countersunk', () => {
  const project = fixture(vBit(90), [circleFeature('h1', 20, 20, 1.5), rectFeature('r1')])
  const operation = drillOp({
    drillType: 'countersink',
    countersinkDiameter: 6,
    target: { source: 'features', featureIds: ['h1', 'r1'] },
  })
  const result = generateDrillingToolpath(project, operation)

  assert(plunges(result.moves).length === 1, 'only the circle should be countersunk')
  assert(
    result.warnings.some((w) => w.code === 'drillTargetsNotCircles'),
    'a non-circular target should warn',
  )
})

// ── Output shape and non-regression ──────────────────────────────────

console.log('\nCountersink output and non-regression')

test('countersink posts as linear motion even on a canned-cycle machine', () => {
  const project = fixture(vBit(90), [circleFeature('h1', 20, 20, 1.5), circleFeature('h2', 60, 20, 1.5)])
  const operation = drillOp({
    drillType: 'countersink',
    countersinkDiameter: 6,
    target: { source: 'features', featureIds: ['h1', 'h2'] },
  })
  const result = generateDrillingToolpath(project, operation)

  assert((result.drillCycles ?? []).length === 0, 'countersinking must record no drill cycles')

  const gcode = post(project, operation, result)
  for (const canned of ['G81', 'G82', 'G83', 'G73', 'G80']) {
    assert(!gcode.includes(canned), `countersink output must not contain ${canned}`)
  }
  assert(gcode.includes('G1'), 'countersink output should feed with G1')

  // Sanity check the fixture itself: the same machine and holes DO get a canned
  // cycle in simple mode, so the assertion above is about countersinking and not
  // about a machine definition that never emits G81.
  const simpleProject = fixture(drill(3), [circleFeature('h1', 20, 20, 1.5), circleFeature('h2', 60, 20, 1.5)])
  const simpleOp = drillOp({ drillType: 'simple', target: { source: 'features', featureIds: ['h1', 'h2'] } })
  const simpleGcode = post(simpleProject, simpleOp, generateDrillingToolpath(simpleProject, simpleOp))
  assert(simpleGcode.includes('G81'), 'the test machine should emit G81 for simple drilling')
})

test('legacy drilling operations are untouched by the new field', () => {
  const project = fixture(drill(3), [circleFeature('h1', 20, 20, 1.5), circleFeature('h2', 60, 20, 1.5)])
  const targets = { source: 'features' as const, featureIds: ['h1', 'h2'] }

  // A saved operation from before #489 has neither drillType nor countersinkDiameter.
  const legacy = generateDrillingToolpath(project, drillOp({ target: targets }))
  const explicit = generateDrillingToolpath(project, drillOp({ drillType: 'simple', target: targets }))
  assert(
    JSON.stringify(legacy.moves) === JSON.stringify(explicit.moves),
    'an operation with no drillType must still generate simple drilling motion',
  )
  assert((legacy.drillCycles ?? []).length === 2, 'legacy drilling must still record its canned cycles')

  // A stray countersink diameter on a non-countersink operation changes nothing.
  const withDiameter = generateDrillingToolpath(project, drillOp({ target: targets, countersinkDiameter: 6 }))
  assert(
    JSON.stringify(withDiameter.moves) === JSON.stringify(legacy.moves),
    'countersinkDiameter must not affect a non-countersink drill type',
  )

  for (const drillType of ['peck', 'dwell', 'chip_breaking'] as const) {
    const baseline = generateDrillingToolpath(project, drillOp({ drillType, peckDepth: 3, target: targets }))
    const polluted = generateDrillingToolpath(
      project,
      drillOp({ drillType, peckDepth: 3, countersinkDiameter: 6, target: targets }),
    )
    assert(
      JSON.stringify(baseline.moves) === JSON.stringify(polluted.moves),
      `${drillType} drilling must be unchanged by countersinkDiameter`,
    )
    assert(
      (baseline.drillCycles ?? []).length === 2,
      `${drillType} drilling must still record canned cycles`,
    )
  }
})

test('countersinkTipDepth rejects angles that cannot form a cone', () => {
  assert(countersinkTipDepth(6, 0) === null, '0° has no cone')
  assert(countersinkTipDepth(6, 180) === null, '180° is flat')
  assert(approx(countersinkTipDepth(10, 60) ?? 0, 10 / (2 * Math.tan(Math.PI / 6))), '60° follows the formula')
})

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\ndrilling countersink: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
