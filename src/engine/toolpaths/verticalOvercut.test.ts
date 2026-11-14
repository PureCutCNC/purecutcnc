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
 * Bounded vertical overcut for Edge Route operations (issue #834).
 *
 * What is asserted is the machine motion: the Z the final level cuts at, that
 * the levels above it and every other kind are untouched, that a tab standing
 * on the stock bottom still holds when the final level goes below it, and that
 * no refused value produces any motion at all. The notices are checked where
 * the operator reads them — the toolpath warnings (CAM panel, booklet), the
 * CAM field notice, the booklet row, and the export's warnings and program
 * comment.
 *
 * Run with: npx tsx src/engine/toolpaths/verticalOvercut.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, rectProfile, type Operation, type Project, type Tab } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { computeOperationToolpath } from './generateOperation'
import { generateEdgeRouteToolpath } from './edge'
import { normalizeToolForProject } from './geometry'
import { warningSeverity } from './warningCodes'
import { overcutBottomZ, resolveVerticalOvercut, STOCK_BOTTOM_Z } from './verticalOvercut'
import { edgeRouteOvercutApplies } from './verticalOvercutTargets'
import type { ToolpathMove, ToolpathResult } from './types'
import { runPostProcessor } from '../gcode/postprocessor'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { buildOperationBookletReport } from '../operationBooklet/report'
import { verticalOvercutFieldNotice } from '../../components/cam/verticalOvercutNotice'

let passed = 0
let failed = 0

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

const THICKNESS = 12
const STEPDOWN = 4

function edgeOperation(kind: 'edge_route_inside' | 'edge_route_outside', patch: Partial<Operation> = {}): Operation {
  return {
    id: 'op1',
    name: 'Edge',
    kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f1'] },
    toolRef: 't1',
    stepdown: STEPDOWN,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    ...patch,
  }
}

function project(options: {
  operation: 'add' | 'subtract'
  zBottom?: number
  maxSpoilboardCutDepth?: number
  tabs?: Tab[]
  units?: 'mm' | 'inch'
}): Project {
  const base = newProject()
  const units = options.units ?? 'mm'
  const withMeta: Project = {
    ...base,
    meta: {
      ...base.meta,
      units,
      ...(options.maxSpoilboardCutDepth === undefined ? {} : { maxSpoilboardCutDepth: options.maxSpoilboardCutDepth }),
    },
    stock: { ...base.stock, thickness: THICKNESS },
    tools: [{ ...defaultTool(units, 1), id: 't1', name: 'em6', diameter: 6, units: 'mm', maxCutDepth: 30 }],
    tabs: options.tabs ?? [],
  }
  return projectWithFeatures(withMeta, [
    {
      id: 'f1',
      name: 'Part',
      kind: 'rect',
      folderId: null,
      sketch: {
        profile: rectProfile(20, 20, 80, 60),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: options.operation,
      z_top: THICKNESS,
      z_bottom: options.zBottom ?? 0,
      visible: true,
      locked: false,
    },
  ] as never)
}

function cutMoves(result: ToolpathResult): ToolpathMove[] {
  return result.moves.filter((move) => move.kind !== 'rapid')
}

function minCutZ(result: ToolpathResult): number {
  return Math.min(...cutMoves(result).flatMap((move) => [move.from.z, move.to.z]))
}

/** The Z of every flat cutting level, rounded, highest first. */
function cutLevels(result: ToolpathResult): number[] {
  const levels = new Set<number>()
  for (const move of cutMoves(result)) {
    if (Math.abs(move.from.z - move.to.z) <= 1e-9) levels.add(Number(move.from.z.toFixed(6)))
  }
  return [...levels].sort((a, b) => b - a)
}

function codes(result: ToolpathResult): string[] {
  return result.warnings.map((warning) => warning.code)
}

function toolpath(projectValue: Project, operation: Operation): ToolpathResult {
  const envelope = computeOperationToolpath(projectValue, operation)
  assert(envelope, 'the operation generates')
  return envelope.result
}

const KINDS = ['edge_route_outside', 'edge_route_inside'] as const
const featureOperationFor = (kind: typeof KINDS[number]): 'add' | 'subtract' => kind === 'edge_route_outside' ? 'add' : 'subtract'

// ── Zero and absent keep today's motion ──────────────────────────────

for (const kind of KINDS) {
  test(`${kind}: absent, zero and an unset limit produce identical motion`, () => {
    const legacy = toolpath(project({ operation: featureOperationFor(kind) }), edgeOperation(kind))
    const zero = toolpath(project({ operation: featureOperationFor(kind), maxSpoilboardCutDepth: 1 }), edgeOperation(kind, { verticalOvercut: 0 }))
    assert.ok(legacy.moves.length > 0, 'the route cuts')
    assert.deepEqual(zero.moves, legacy.moves, 'zero overcut is the legacy motion')
    assert.deepEqual(zero.warnings, legacy.warnings, 'and says nothing new')
    assert.equal(minCutZ(legacy), 0, 'the legacy route stops at the stock bottom')
  })
}

// ── A valid overcut deepens only the final level ─────────────────────

for (const kind of KINDS) {
  test(`${kind}: the final bottom goes down by the overcut, the levels above do not move`, () => {
    const legacy = toolpath(project({ operation: featureOperationFor(kind) }), edgeOperation(kind))
    const overcut = toolpath(
      project({ operation: featureOperationFor(kind), maxSpoilboardCutDepth: 1 }),
      edgeOperation(kind, { verticalOvercut: 0.5 }),
    )
    assert.deepEqual(cutLevels(legacy), [8, 4, 0])
    // Stepdown still bounds every pass: the levels the route already cut stay
    // where they were, and the overcut is one shallow final level below them
    // rather than a last step deeper than the stepdown allows.
    assert.deepEqual(cutLevels(overcut), [8, 4, 0, -0.5], 'only a final level below the old bottom was added')
    assert.equal(minCutZ(overcut), -0.5, 'nothing cuts below the requested overcut')
    assert.ok(codes(overcut).includes('edgeVerticalOvercut'), 'the overcut is announced')
    const warning = overcut.warnings.find((entry) => entry.code === 'edgeVerticalOvercut')
    assert.equal(warning?.params?.amount, '0.5 mm', 'the amount is in project units')
    assert.equal(warningSeverity('edgeVerticalOvercut'), 'warning', 'a valid overcut does not block export')
  })

  test(`${kind}: a finish pass cuts its single level at the overcut depth`, () => {
    const finish = toolpath(
      project({ operation: featureOperationFor(kind), maxSpoilboardCutDepth: 1 }),
      edgeOperation(kind, { pass: 'finish', verticalOvercut: 0.25 }),
    )
    assert.deepEqual(cutLevels(finish), [-0.25])
  })

  test(`${kind}: an overcut equal to the project maximum is allowed`, () => {
    const atLimit = toolpath(
      project({ operation: featureOperationFor(kind), maxSpoilboardCutDepth: 0.8 }),
      edgeOperation(kind, { verticalOvercut: 0.8 }),
    )
    assert.equal(minCutZ(atLimit), -0.8)
  })
}

test('edge_route_outside trochoidal: the overcut reaches the orbits too', () => {
  const trochoidal = toolpath(
    project({ operation: 'add', maxSpoilboardCutDepth: 1 }),
    edgeOperation('edge_route_outside', {
      edgeStrategy: 'trochoidal',
      trochoidalCutWidth: 9,
      trochoidalAdvance: 0.35,
      entryStrategy: 'helix',
      verticalOvercut: 0.5,
    }),
  )
  assert.ok(trochoidal.moves.length > 0, 'the trochoidal route cuts')
  assert.ok(Math.abs(minCutZ(trochoidal) + 0.5) <= 1e-6, `deepest cut is -0.5, got ${minCutZ(trochoidal)}`)
})

// ── The spoilboard floor ─────────────────────────────────────────────

test('the overcut is measured from the stock bottom, and never past the spoilboard floor', () => {
  // A part modelled 0.8 below the stock is already deeper than 0.5 below the
  // stock bottom, so the overcut adds nothing to it.
  const deeper = toolpath(
    project({ operation: 'add', zBottom: -0.8, maxSpoilboardCutDepth: 1 }),
    edgeOperation('edge_route_outside', { verticalOvercut: 0.5 }),
  )
  assert.ok(Math.abs(minCutZ(deeper) + 0.8) <= 1e-9, `keeps its own bottom, got ${minCutZ(deeper)}`)
  // A part modelled 0.2 below the stock goes to 0.5 below the stock bottom.
  const shallower = toolpath(
    project({ operation: 'add', zBottom: -0.2, maxSpoilboardCutDepth: 1 }),
    edgeOperation('edge_route_outside', { verticalOvercut: 0.5 }),
  )
  assert.ok(Math.abs(minCutZ(shallower) + 0.5) <= 1e-9, `goes to -0.5, got ${minCutZ(shallower)}`)
  // A part already modelled below the floor keeps exactly its own bottom.
  const below = toolpath(
    project({ operation: 'add', zBottom: -2, maxSpoilboardCutDepth: 1 }),
    edgeOperation('edge_route_outside', { verticalOvercut: 0.5 }),
  )
  assert.equal(minCutZ(below), -2)
  const ok = { kind: 'ok' as const, amount: 0.5, limit: 1 }
  assert.equal(STOCK_BOTTOM_Z, 0)
  assert.equal(overcutBottomZ(-2, -2, ok, 0), -2, 'below the floor: untouched')
  assert.equal(overcutBottomZ(0, 0.4, ok, 0), -0.5, 'the leave does not eat into the overcut')
  assert.equal(overcutBottomZ(3, 3, ok, 0), 3, 'a target above the stock bottom is not overcut')
  assert.equal(overcutBottomZ(10, 10.5, ok, 10), 9.5, 'measured from whatever the stock bottom is')
  assert.equal(overcutBottomZ(10, 10, { kind: 'ok', amount: 1, limit: 1 }, 10), 9, 'at the limit reaches the floor exactly')
})

// ── Axial stock to leave does not eat into the overcut ───────────────

for (const kind of KINDS) {
  for (const { leave, label } of [
    { leave: 0.5, label: 'leave > overcut' },
    { leave: 0.1, label: 'leave < overcut' },
    { leave: 0, label: 'leave = 0' },
  ]) {
    test(`${kind}: ${label} — the final level is 0.3 below the stock bottom`, () => {
      const result = toolpath(
        project({ operation: featureOperationFor(kind), maxSpoilboardCutDepth: 1 }),
        edgeOperation(kind, { verticalOvercut: 0.3, stockToLeaveAxial: leave }),
      )
      assert.ok(Math.abs(minCutZ(result) + 0.3) <= 1e-9, `final level at -0.3, got ${minCutZ(result)}`)
      const levels = cutLevels(result)
      assert.equal(levels[levels.length - 1], -0.3)
      // The leave still applies above: without overcut the route stops at the leave.
      const plain = toolpath(project({ operation: featureOperationFor(kind) }), edgeOperation(kind, { stockToLeaveAxial: leave }))
      assert.ok(Math.abs(minCutZ(plain) - leave) <= 1e-9, `without overcut the leave holds, got ${minCutZ(plain)}`)
      assert.deepEqual(levels.slice(0, -1).filter((z) => z > leave + 1e-9), cutLevels(plain).filter((z) => z > leave + 1e-9), 'the levels above the leave do not move')
      const warning = result.warnings.find((entry) => entry.code === 'edgeVerticalOvercut')
      assert.equal(warning?.params?.amount, '0.3 mm', 'the warning states the real depth below the stock bottom')
    })
  }
}

// ── A target that stops inside the material is not overcut ───────────

for (const kind of KINDS) {
  test(`${kind}: a target above the stock bottom keeps its motion and announces no spoilboard cut`, () => {
    const plain = toolpath(project({ operation: featureOperationFor(kind), zBottom: 5 }), edgeOperation(kind))
    const projectValue = project({ operation: featureOperationFor(kind), zBottom: 5, maxSpoilboardCutDepth: 1 })
    const operation = edgeOperation(kind, { verticalOvercut: 0.3 })
    const set = toolpath(projectValue, operation)
    assert.ok(plain.moves.length > 0)
    assert.deepEqual(set.moves, plain.moves, 'motion is unchanged')
    assert.ok(!codes(set).includes('edgeVerticalOvercut'), 'no spoilboard warning')
    assert.equal(edgeRouteOvercutApplies(projectValue, operation), false)
    assert.deepEqual(
      verticalOvercutFieldNotice(projectValue, operation),
      { tone: 'info', key: 'cam.operation.verticalOvercutNotApplied', params: { amount: '0.3 mm' } },
      'the CAM panel notes the overcut is set but not applied',
    )
  })
}

test('through-ness is read in the operation\'s setup frame', () => {
  // Modelled from the top down to Z 3: not through on the Top setup, but on a
  // Bottom setup the stock is turned over and the same target reaches the
  // stock bottom of that frame.
  const base = project({ operation: 'add', zBottom: 3, maxSpoilboardCutDepth: 1 })
  const operation = edgeOperation('edge_route_outside', { verticalOvercut: 0.3, setupId: 'setup-bottom' })
  const topOperation = { ...operation, setupId: base.setups[0].id }
  assert.equal(edgeRouteOvercutApplies(base, topOperation), false, 'not through on Top')
  const bottomSetup = { ...base.setups[0], id: 'setup-bottom', name: 'Bottom', orientation: { axis: 'x' as const, angleDeg: 180 }, operationIds: [] }
  const flipped = { ...base, setups: [...base.setups, bottomSetup] }
  assert.equal(edgeRouteOvercutApplies(flipped, operation), true, 'through on Bottom')
})

// ── Refused values produce no motion ─────────────────────────────────

const REFUSED: Array<{ name: string; overcut: unknown; limit?: number }> = [
  { name: 'negative', overcut: -0.5, limit: 1 },
  { name: 'NaN', overcut: Number.NaN, limit: 1 },
  { name: 'Infinity', overcut: Number.POSITIVE_INFINITY, limit: 1 },
  { name: 'null (a non-finite value after JSON)', overcut: null, limit: 1 },
  { name: 'a string from a hand-edited file', overcut: '0.5', limit: 1 },
  { name: 'over the project limit', overcut: 1.5, limit: 1 },
  { name: 'any overcut with no limit set', overcut: 0.5 },
  { name: 'any overcut on a negative limit', overcut: 0.5, limit: -1 },
]

for (const kind of KINDS) {
  for (const refused of REFUSED) {
    test(`${kind}: ${refused.name} generates no motion and blocks export`, () => {
      const operation = edgeOperation(kind, { verticalOvercut: refused.overcut as number })
      const result = toolpath(project({ operation: featureOperationFor(kind), maxSpoilboardCutDepth: refused.limit }), operation)
      assert.equal(result.moves.length, 0, 'no motion at all')
      assert.deepEqual(codes(result), ['edgeVerticalOvercutInvalid'])
      assert.equal(warningSeverity('edgeVerticalOvercutInvalid'), 'error')
    })
  }
}

test('a project limit reduced after the fact refuses the operation, never clamps it', () => {
  const operation = edgeOperation('edge_route_outside', { verticalOvercut: 0.8 })
  const allowed = toolpath(project({ operation: 'add', maxSpoilboardCutDepth: 1 }), operation)
  assert.equal(minCutZ(allowed), -0.8)
  const reduced = toolpath(project({ operation: 'add', maxSpoilboardCutDepth: 0.5 }), operation)
  assert.equal(reduced.moves.length, 0)
  const warning = reduced.warnings[0]
  assert.equal(warning?.code, 'edgeVerticalOvercutInvalid')
  assert.equal(warning?.params?.amount, '0.8 mm')
  assert.equal(warning?.params?.limit, '0.5 mm')
  assert.equal(operation.verticalOvercut, 0.8, 'the stored value is untouched')
})

test('other operation kinds ignore a stray overcut', () => {
  const pocket = edgeOperation('edge_route_inside', { kind: 'pocket', verticalOvercut: 5 })
  assert.equal(resolveVerticalOvercut(project({ operation: 'subtract' }), pocket).kind, 'none')
  const legacy = toolpath(project({ operation: 'subtract' }), { ...pocket, verticalOvercut: undefined })
  const stray = toolpath(project({ operation: 'subtract' }), pocket)
  assert.deepEqual(stray.moves, legacy.moves, 'pocket motion is unchanged')
  assert.deepEqual(stray.warnings, legacy.warnings)
})

// ── Tabs still hold below the stock bottom ───────────────────────────

/** Does the segment pass through the open rectangle? Sampled finely; the tab is 8 mm wide. */
function segmentCrossesRect(move: ToolpathMove, rect: { x: number; y: number; w: number; h: number }): boolean {
  const samples = 200
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples
    const x = move.from.x + (move.to.x - move.from.x) * t
    const y = move.from.y + (move.to.y - move.from.y) * t
    if (x > rect.x + 1e-6 && x < rect.x + rect.w - 1e-6 && y > rect.y + 1e-6 && y < rect.y + rect.h - 1e-6) return true
  }
  return false
}

for (const shape of ['rect', 'smooth'] as const) {
  test(`edge_route_outside: a ${shape} tab on the stock bottom still holds at the overcut level`, () => {
    // Straddles the part's bottom edge (y = 20), so the tool-centre path crosses it.
    const tab: Tab = { id: 'tb1', name: 'Tab', x: 46, y: 12, w: 8, h: 12, z_top: 3, z_bottom: 0, visible: true, shape }
    const result = toolpath(
      project({ operation: 'add', maxSpoilboardCutDepth: 1, tabs: [tab] }),
      edgeOperation('edge_route_outside', { verticalOvercut: 0.5 }),
    )
    assert.equal(minCutZ(result), -0.5, 'the route still overcuts away from the tab')
    const footprint = { x: tab.x, y: tab.y, w: tab.w, h: tab.h }
    const severing = cutMoves(result).filter((move) => Math.max(move.from.z, move.to.z) < 0 && segmentCrossesRect(move, footprint))
    assert.equal(severing.length, 0, `no overcut-level move crosses the tab footprint (${severing.length} did)`)
  })
}

test('edge_route_outside: with no overcut a tab is handled exactly as before', () => {
  const tab: Tab = { id: 'tb1', name: 'Tab', x: 46, y: 12, w: 8, h: 12, z_top: 3, z_bottom: 0, visible: true, shape: 'rect' }
  const legacy = toolpath(project({ operation: 'add', tabs: [tab] }), edgeOperation('edge_route_outside'))
  const zero = toolpath(project({ operation: 'add', maxSpoilboardCutDepth: 1, tabs: [tab] }), edgeOperation('edge_route_outside', { verticalOvercut: 0 }))
  assert.deepEqual(zero.moves, legacy.moves)
})

// ── Inch projects ────────────────────────────────────────────────────

test('an inch project states the amount in inches', () => {
  const notice = verticalOvercutFieldNotice(
    project({ operation: 'add', units: 'inch', maxSpoilboardCutDepth: 0.04 }),
    edgeOperation('edge_route_outside', { verticalOvercut: 0.02 }),
  )
  assert.deepEqual(notice, { tone: 'warning', key: 'cam.operation.verticalOvercutNotice', params: { amount: '0.02 in' } })
})

// ── CAM panel notice ─────────────────────────────────────────────────

test('the CAM field notice is a warning for a valid overcut and an error for a refused one', () => {
  const meta = project({ operation: 'subtract', maxSpoilboardCutDepth: 1 })
  assert.equal(verticalOvercutFieldNotice(meta, edgeOperation('edge_route_outside')), null, 'no notice without an overcut')
  assert.equal(verticalOvercutFieldNotice(meta, edgeOperation('edge_route_outside', { verticalOvercut: 0 })), null)
  assert.deepEqual(
    verticalOvercutFieldNotice(meta, edgeOperation('edge_route_inside', { verticalOvercut: 0.5 })),
    { tone: 'warning', key: 'cam.operation.verticalOvercutNotice', params: { amount: '0.5 mm' } },
  )
  assert.deepEqual(
    verticalOvercutFieldNotice(meta, edgeOperation('edge_route_inside', { verticalOvercut: 2 })),
    { tone: 'error', key: 'cam.operation.verticalOvercutInvalid', params: { amount: '2 mm', limit: '1 mm' } },
  )
})

// ── Export: warning, refusal and program comment ─────────────────────

function post(projectValue: Project, operation: Operation, definitionId: string) {
  const definition = BUNDLED_DEFINITIONS.find((candidate) => candidate.id === definitionId)
  assert(definition, `${definitionId} is bundled`)
  const tool = normalizeToolForProject(projectValue.tools[0], projectValue)
  const operationRow = { ...operation }
  return runPostProcessor({
    project: { ...projectValue, operations: [operationRow] },
    operations: [{ operation: operationRow, tool, toolpath: generateEdgeRouteToolpath(projectValue, operationRow) }],
    definition,
    options: { emitToolChanges: true, emitCoolant: false },
  })
}

for (const definitionId of ['generic', 'shopbot']) {
  test(`${definitionId}: export warns about a valid overcut and writes it into the program`, () => {
    const projectValue = project({ operation: 'add', maxSpoilboardCutDepth: 1 })
    const result = post(projectValue, edgeOperation('edge_route_outside', { verticalOvercut: 0.5 }), definitionId)
    const warning = result.warnings.find((entry) => entry.code === 'edgeVerticalOvercut')
    assert.equal(warning?.params?.amount, '0.5 mm')
    assert.ok(!result.warnings.some((entry) => warningSeverity(entry.code) === 'error'), 'a valid overcut exports')
    assert.match(result.gcode, /WARNING: vertical overcut 0\.5 mm below the stock bottom/)
  })

  test(`${definitionId}: no overcut, no notice and no comment`, () => {
    const projectValue = project({ operation: 'add', maxSpoilboardCutDepth: 1 })
    const result = post(projectValue, edgeOperation('edge_route_outside'), definitionId)
    assert.ok(!result.warnings.some((entry) => entry.code.startsWith('edgeVerticalOvercut')))
    assert.doesNotMatch(result.gcode, /vertical overcut/i)
  })

  test(`${definitionId}: a refused overcut blocks the export`, () => {
    // Even with a stale toolpath that does go deep, the row decides.
    const projectValue = project({ operation: 'add', maxSpoilboardCutDepth: 0.2 })
    const result = post(projectValue, edgeOperation('edge_route_outside', { verticalOvercut: 0.5 }), definitionId)
    const refusal = result.warnings.find((entry) => entry.code === 'edgeVerticalOvercutInvalid')
    assert.ok(refusal, 'the refusal is in the program warnings')
    assert.equal(warningSeverity(refusal.code), 'error', 'and it is an error, which disables Save')
  })
}

for (const definitionId of ['generic', 'shopbot']) {
  test(`${definitionId}: an overcut with no through target is not announced in the export`, () => {
    const projectValue = project({ operation: 'add', zBottom: 5, maxSpoilboardCutDepth: 1 })
    const result = post(projectValue, edgeOperation('edge_route_outside', { verticalOvercut: 0.5 }), definitionId)
    assert.ok(!result.warnings.some((entry) => entry.code.startsWith('edgeVerticalOvercut')), 'no spoilboard warning')
    assert.doesNotMatch(result.gcode, /vertical overcut/i, 'no spoilboard comment')
  })
}

// ── Booklet ──────────────────────────────────────────────────────────

test('the booklet prints the overcut row and the warning', () => {
  const projectValue = project({ operation: 'add', maxSpoilboardCutDepth: 1 })
  const tool = normalizeToolForProject(projectValue.tools[0], projectValue)
  const operation = edgeOperation('edge_route_outside', { verticalOvercut: 0.5 })
  const withOp = { ...projectValue, operations: [operation] }
  const report = buildOperationBookletReport({
    project: withOp,
    operation,
    tool,
    toolpath: generateEdgeRouteToolpath(withOp, operation),
    generatedAt: new Date(0),
  })
  const row = report.settingRows.find((entry) => entry.label === 'Vertical overcut')
  assert.equal(row?.value, '0.5 mm')
  assert.ok(report.warnings.some((text) => text.includes('0.5 mm') && text.toLowerCase().includes('spoilboard')), 'the warning names the amount')

  const plain = edgeOperation('edge_route_outside')
  const plainReport = buildOperationBookletReport({
    project: { ...projectValue, operations: [plain] },
    operation: plain,
    tool,
    toolpath: generateEdgeRouteToolpath(projectValue, plain),
    generatedAt: new Date(0),
  })
  assert.ok(!plainReport.settingRows.some((entry) => entry.label === 'Vertical overcut'), 'no row without an overcut')
})

test('the booklet says an overcut with no through target is not applied', () => {
  const projectValue = project({ operation: 'add', zBottom: 5, maxSpoilboardCutDepth: 1 })
  const tool = normalizeToolForProject(projectValue.tools[0], projectValue)
  const operation = edgeOperation('edge_route_outside', { verticalOvercut: 0.5 })
  const withOp = { ...projectValue, operations: [operation] }
  const report = buildOperationBookletReport({
    project: withOp,
    operation,
    tool,
    toolpath: generateEdgeRouteToolpath(withOp, operation),
    generatedAt: new Date(0),
  })
  const row = report.settingRows.find((entry) => entry.label === 'Vertical overcut')
  assert.equal(row?.value, '0.5 mm (not applied: no target cuts through to the stock bottom)')
  assert.ok(!report.warnings.some((text) => text.toLowerCase().includes('spoilboard')), 'no spoilboard warning')
})

console.log(`\n  verticalOvercut: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
