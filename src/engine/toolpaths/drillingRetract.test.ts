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
 * Drilling retract-plane safety (issues #479/#481).
 *
 * Since format 3.1 `retractHeight` is a distance above the material surface.
 * While it was an absolute project-space Z, a value below the top of the
 * material was accepted verbatim, so the tool rapid-plunged into the part and —
 * on the first hole, where the postprocessor has no known machine position and
 * therefore emits Z before XY — rapid-traversed *through* it. The engine still
 * clamps a negative stored distance back to the surface; the hostile values
 * below are negatives the UI itself prevents.
 *
 * The invariant asserted here is deliberately narrower than "no rapid ever goes
 * below the stock top": G83 peck re-entries legitimately rapid back down inside
 * the hole the same cycle just drilled. What must hold is that a rapid never
 * travels in XY below the surface, and never descends below it into material no
 * fed move has opened yet.
 *
 * Run with: npx tsx src/engine/toolpaths/drillingRetract.test.ts
 */

import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { runPostProcessor } from '../gcode/postprocessor'
import { parseGcodeMotion } from '../gcode/gcodeMotionParser'
import { validateMachineDefinition } from '../gcode/types'
import type { MachineDefinition } from '../gcode/types'
import { normalizeToolForProject } from './geometry'
import { optimizeLinearMoves } from './linearMoveOptimization'
import { generateDrillingToolpath } from './drilling'
import type { ToolpathMove, ToolpathResult } from './types'

const EPS = 1e-6

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
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

const STOCK_THICKNESS = 4

function testMachineDefinition(cannedCycles = false): MachineDefinition {
  return validateMachineDefinition({
    id: 'test',
    name: 'Test',
    description: 'Test controller',
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
    cannedCycles: cannedCycles
      ? {
        drillCommand: 'G81',
        drillWithDwellCommand: 'G82',
        peckDrillCommand: 'G83',
        chipBreakDrillCommand: 'G73',
        cancelCommand: 'G80',
        retractMode: 'G98',
        peckStepWord: 'Q',
      }
      : null,
    coolant: null,
    stop: { programEndCommand: 'M30' },
  })
}

function makeCircleFeature(id: string, cx: number, cy: number, r: number): SketchFeature {
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
    z_top: STOCK_THICKNESS,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

/** 4 mm stock, two through-holes, machine origin on the stock top by default. */
function drillFixture(tool: Tool, holeRadius = 1.5, originZ = STOCK_THICKNESS): Project {
  const base = newProject('retract', 'mm')
  const stock = { ...base.stock, thickness: STOCK_THICKNESS }
  return projectWithFeatures(
    { ...base, stock, origin: { ...base.origin, z: originZ }, tools: [tool] },
    [makeCircleFeature('h1', 20, 20, holeRadius), makeCircleFeature('h2', 40, 20, holeRadius)],
  )
}

function makeDrill(diameter = 3): Tool {
  return { ...defaultTool('mm', 1), id: 't1', name: `${diameter} mm drill`, type: 'drill', diameter }
}

function makeEndmill(diameter = 2): Tool {
  return { ...defaultTool('mm', 1), id: 't1', name: `${diameter} mm endmill`, type: 'flat_endmill', diameter }
}

function drillOp(overrides: Partial<Operation>): Operation {
  return {
    id: 'op1',
    name: 'drill',
    kind: 'drilling',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['h1', 'h2'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 150,
    rpm: 18000,
    pocketPattern: 'offset',
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

function post(project: Project, operation: Operation, toolpath: ToolpathResult, cannedCycles = false): string {
  const toolRecord = project.tools.find((t) => t.id === operation.toolRef)!
  return runPostProcessor({
    project,
    definition: testMachineDefinition(cannedCycles),
    operations: [{
      operation,
      tool: normalizeToolForProject(toolRecord, project),
      toolpath: optimizeLinearMoves(toolpath),
    }],
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode
}

// ── The invariant ────────────────────────────────────────────────────

interface MotionMove {
  kind: string
  from: { x: number; y: number; z: number }
  to: { x: number; y: number; z: number }
}

/**
 * Every rapid endpoint below the material surface must sit at a location a fed
 * move has already opened to at least that depth.
 *
 * One rule covers both halves of #479. A traverse to an uncut hole at retract
 * height fails on its destination; the descent that precedes it fails on its
 * own endpoint. It still admits the motion that is genuinely safe: G83 re-entry
 * into the hole the cycle just drilled, and a helical bore retracting across the
 * floor it just cleared — both move only through material that is already gone.
 */
function assertRetractSafe(moves: MotionMove[], surfaceZ: number, label: string): void {
  const key = (p: { x: number; y: number }): string => `${p.x.toFixed(3)},${p.y.toFixed(3)}`
  const cutTo = new Map<string, number>()

  for (const move of moves) {
    if (move.kind !== 'rapid') {
      for (const point of [move.from, move.to]) {
        const k = key(point)
        cutTo.set(k, Math.min(cutTo.get(k) ?? Infinity, point.z))
      }
      continue
    }

    for (const point of [move.from, move.to]) {
      if (point.z >= surfaceZ - EPS) continue
      const alreadyCutTo = cutTo.get(key(point))
      assert(
        alreadyCutTo !== undefined && alreadyCutTo <= point.z + EPS,
        `${label}: rapid reached (${point.x}, ${point.y}, ${point.z}) — below the material surface `
        + `(${surfaceZ}) at a location no fed move has opened`,
      )
    }
  }
}

/** Same invariant, applied to the emitted program in machine coordinates. */
function assertPostedRetractSafe(gcode: string, project: Project, surfaceZ: number, label: string): void {
  const parsed = parseGcodeMotion(gcode, 'ij', ';', '')
  assert(parsed.status === 'verified', `${label}: emitted G-code should parse cleanly, got "${parsed.status}"`)
  assert(parsed.moves.length > 0, `${label}: program should emit motion`)
  assertRetractSafe(parsed.moves, surfaceZ - project.origin.z, `${label} (posted)`)
}

function rapids(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((m) => m.kind === 'rapid')
}

// ── Tests ────────────────────────────────────────────────────────────

console.log('\nDrilling retract plane (issue #479)')

test('a negative retract distance is raised to the surface and warned', () => {
  const project = drillFixture(makeDrill())
  const operation = drillOp({ drillType: 'simple', retractHeight: -2 }) // 2 below the surface
  const result = generateDrillingToolpath(project, operation)

  // Safety first, diagnostics second: the invariant is what protects the part.
  assertRetractSafe(result.moves, STOCK_THICKNESS, 'simple drilling, hostile retract')
  assertPostedRetractSafe(post(project, operation, result), project, STOCK_THICKNESS, 'simple drilling, hostile retract')

  for (const cycle of result.drillCycles ?? []) {
    assert(cycle.retractZ === STOCK_THICKNESS, `drill cycle retractZ should be clamped, got ${cycle.retractZ}`)
  }

  const warning = result.warnings.find((w) => w.code === 'drillRetractBelowStockTop')
  assert(warning !== undefined, 'a drillRetractBelowStockTop warning should be raised')
  // requested/clamped report the resolved absolute Zs (2 below the surface of
  // the 4 mm stock, raised back to 4).
  assert(warning!.params?.requested === 2, `warning should report the requested value, got ${warning!.params?.requested}`)
  assert(
    warning!.params?.clamped === STOCK_THICKNESS,
    `warning should report the clamped value ${STOCK_THICKNESS}, got ${warning!.params?.clamped}`,
  )
})

test('first hole traverses at the clearance plane, not the retract plane', () => {
  const project = drillFixture(makeDrill())
  const operation = drillOp({ drillType: 'simple', retractHeight: -2 })
  const result = generateDrillingToolpath(project, operation)

  // The zero-length entry marker that tells the postprocessor to position at
  // safeZ before descending. Without it Z is emitted before XY (issue #479).
  const first = result.moves[0]
  const safeZ = STOCK_THICKNESS + project.meta.operationClearanceZ
  assert(first.kind === 'rapid', `first move should be a rapid, got ${first.kind}`)
  assert(
    first.from.z === safeZ && first.to.z === safeZ,
    `first move should establish the clearance plane ${safeZ}, got ${first.from.z} → ${first.to.z}`,
  )

  // In the emitted program the machine must be at the clearance plane before it
  // travels anywhere in XY. Before the fix it descended to the retract plane
  // first and made that traverse 2 mm inside the stock.
  const parsed = parseGcodeMotion(post(project, operation, result), 'ij', ';', '')
  assert(parsed.status === 'verified', `emitted G-code should parse cleanly, got "${parsed.status}"`)
  const firstTraverse = parsed.moves.find(
    (m) => Math.abs(m.from.x - m.to.x) > EPS || Math.abs(m.from.y - m.to.y) > EPS,
  )
  assert(firstTraverse !== undefined, 'program should traverse in XY')
  const machineSafeZ = safeZ - project.origin.z
  assert(
    firstTraverse!.from.z >= machineSafeZ - EPS && firstTraverse!.to.z >= machineSafeZ - EPS,
    `first XY traverse should happen at the clearance plane (machine Z ${machineSafeZ}), got `
    + `${firstTraverse!.from.z} → ${firstTraverse!.to.z}`,
  )
})

test('a positive retract distance is resolved above the surface and left alone', () => {
  const project = drillFixture(makeDrill())
  // 2 above the material surface → project Z 6, below the clearance plane.
  const operation = drillOp({ drillType: 'simple', retractHeight: 2 })
  const result = generateDrillingToolpath(project, operation)

  assert(
    !result.warnings.some((w) => w.code === 'drillRetractBelowStockTop'),
    'a positive retract distance should not warn',
  )
  for (const cycle of result.drillCycles ?? []) {
    assert(cycle.retractZ === STOCK_THICKNESS + 2, `retractZ should be the surface + 2, got ${cycle.retractZ}`)
  }
  assertRetractSafe(result.moves, STOCK_THICKNESS, 'simple drilling, safe retract')
})

test('the same distance resolves to the same plane from any origin preset', () => {
  // Issue #481's motivating setup: Z-zero on the spoilboard (the "bottom left"
  // origin preset sets origin.z to 0) must not change where "2 above the
  // material" is. The stored distance is origin-independent by construction.
  const onStockTop = drillFixture(makeDrill())
  const onTable = drillFixture(makeDrill(), 1.5, 0)
  const operation = drillOp({ drillType: 'simple', retractHeight: 2 })
  const topResult = generateDrillingToolpath(onStockTop, operation)
  const tableResult = generateDrillingToolpath(onTable, operation)

  const planeOf = (result: ToolpathResult): number | null =>
    result.drillCycles && result.drillCycles.length > 0 ? result.drillCycles[0].retractZ : null
  assert(planeOf(topResult) === STOCK_THICKNESS + 2,
    `retractZ should be ${STOCK_THICKNESS + 2}, got ${planeOf(topResult)}`)
  assert(planeOf(tableResult) === planeOf(topResult),
    `origin.z must not move the retract plane, got ${planeOf(tableResult)} vs ${planeOf(topResult)}`)
})

test('retract height above the clearance plane is still capped at safe Z', () => {
  const project = drillFixture(makeDrill())
  const safeZ = STOCK_THICKNESS + project.meta.operationClearanceZ
  const operation = drillOp({ drillType: 'simple', retractHeight: 50 }) // ≫ the clearance offset
  const result = generateDrillingToolpath(project, operation)

  assert(
    !result.warnings.some((w) => w.code === 'drillRetractBelowStockTop'),
    'a retract height above safe Z should not warn about the stock top',
  )
  for (const cycle of result.drillCycles ?? []) {
    assert(cycle.retractZ === safeZ, `retractZ should be capped at safeZ ${safeZ}, got ${cycle.retractZ}`)
  }
})

test('peck re-entries into the open hole are not treated as unsafe', () => {
  const project = drillFixture(makeDrill())
  const operation = drillOp({ drillType: 'peck', peckDepth: 1.5, retractHeight: -2 })
  const result = generateDrillingToolpath(project, operation)

  // The cycle still pecks below the surface — inside the hole it has already
  // drilled, which the invariant must permit.
  const belowSurface = rapids(result.moves).filter((m) => m.to.z < STOCK_THICKNESS - EPS)
  assert(belowSurface.length > 0, 'peck cycle should still re-enter below the surface')

  assertRetractSafe(result.moves, STOCK_THICKNESS, 'peck drilling, hostile retract')
  assertPostedRetractSafe(post(project, operation, result), project, STOCK_THICKNESS, 'peck drilling, hostile retract')

  assert(
    result.warnings.some((w) => w.code === 'drillRetractBelowStockTop'),
    'peck drilling with a hostile retract height should warn',
  )
})

test('helical boring obeys the same invariant', () => {
  const project = drillFixture(makeEndmill(2))
  const operation = drillOp({ drillType: 'helical', retractHeight: -2, entryRampAngle: 5 })
  const result = generateDrillingToolpath(project, operation)

  assert(result.moves.length > 0, 'helical boring should produce moves')

  // Covers the centre → helix-start rapid, which travels in XY at the retract
  // plane and so would cut through virgin material if that plane were inside it.
  assertRetractSafe(result.moves, STOCK_THICKNESS, 'helical boring, hostile retract')
  assertPostedRetractSafe(post(project, operation, result), project, STOCK_THICKNESS, 'helical boring, hostile retract')

  assert(
    result.warnings.some((w) => w.code === 'drillRetractBelowStockTop'),
    'helical boring with a hostile retract height should warn',
  )
})

test('canned-cycle R plane carries the clamped retract height', () => {
  const project = drillFixture(makeDrill())
  const operation = drillOp({ drillType: 'simple', retractHeight: -2 })
  const result = generateDrillingToolpath(project, operation)
  const gcode = post(project, operation, result, true)

  assert(gcode.includes('G81'), 'canned-cycle machine should emit G81')
  const rWords = [...gcode.matchAll(/R(-?[\d.]+)/g)].map((m) => Number(m[1]))
  assert(rWords.length > 0, 'canned cycle should emit an R word')
  // Machine Z: stock top (project Z 4) with the origin on the stock top is 0.
  for (const r of rWords) {
    assert(r >= -EPS, `R plane should be at or above the stock top (machine Z 0), got R${r}`)
  }
})

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\ndrilling retract plane: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
