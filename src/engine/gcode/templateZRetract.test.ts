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
 * A machine template that is not provably inert forces a full RE-ENTRY before
 * the next motion of any kind (#1057 correction 4, Codex review pass 3).
 *
 * Corrections 1–3 repaired one axis at a time: the next rapid restated an
 * unknown X, Y, Z or rotary word, and a feed-first operation recovered its own
 * start. Four hazards survived that:
 *
 * 1. the recovery retracted to the highest point the operation reached, which
 *    for an arc-only operation is a *cutting* point, so the XY travel ran at
 *    machine Z-5 through the stock;
 * 2. both plasma piercing paths skipped the recovery entirely, so a template
 *    before a pierce (or appended to the torch-on command) left an arc's I/J
 *    measured from a point the controller was never at;
 * 3. an axis the template did *not* move was never restated, so a feed whose
 *    declared start was (50,20,-5) ran from a stale Y and cut diagonally;
 * 4. the tracked motion word was preserved across a template, so after a `G2`
 *    positioning template the next rapid was written as bare `X… Y…` and
 *    continued the arc.
 *
 * One rule replaces all of them. After any template that is not provably
 * inert, the program does what it does at the start of an operation:
 *
 *   a. rapid to the program's safe Z — the square blank's travel height, the
 *      machine-coordinate Safe Z on a bar program whose machine has that move,
 *      otherwise the height the operation's own rapids use (the generators'
 *      clearance), never a cutting point;
 *   b. restate any modal state the template moved and reset the motion word so
 *      the retract spells `G0`;
 *   c. rapid in XY and the rotary word to the point the next move starts from,
 *      every axis stated even when it is believed known;
 *   d. then the operation's ordinary approach and the move itself, so an arc
 *      always has a stated start.
 *
 * Plasma re-enters torch-off to the pierce point (no Z on the controller-owned
 * dialext); a `torchOnCommand` that itself moves is the one template that
 * cannot re-enter torch-off, so the pierce point is restated before the cut.
 * ShopBot does the same with `JZ`/`J2`. A program whose templates are all inert
 * stays byte-identical.
 *
 * Mutations that must fail these tests (restore the file from a `cp` backup):
 * - retract to the highest cutting point instead of `plannedSafeZ` → the
 *   linear/arc rows and the arc-only repro write a safe Z at the cut depth;
 * - skip the motion-word reset → the retract follows a `G2` template as a bare
 *   `Z` word, and the next block is no longer a rapid;
 * - restate only the axes believed unknown → an XY-only template skips the
 *   safe-Z retract, and a Z-only template skips the start plane;
 * - drop the plasma re-entry → both piercing rows write the cut immediately
 *   after the template;
 * - drop the feed-start recovery → the linear rows write the feed with no
 *   stated start.
 *
 * Run with: npx tsx src/engine/gcode/templateZRetract.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, getStockBounds, newProject, rectProfile, roundStock } from '../../types/project'
import type { Operation, Project, Tool } from '../../types/project'
import { withBottomSetup } from '../../test/projectFixtures'
import { exportPlasma, rectangle } from '../../test/plasmaExportFixtures'
import { getOperationSafeZ, normalizeToolForProject } from '../toolpaths/geometry'
import type { DrillCycle, ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { runPostProcessor } from './postprocessor'
import { validateMachineDefinition } from './types'
import type { MachineDefinition } from './types'
import { projectToMachinePoint } from './utils'

function bundled(id: string): MachineDefinition {
  return validateMachineDefinition(structuredClone(BUNDLED_DEFINITIONS.find((entry) => entry.id === id)!))
}

/** The two tools the tool-change cases use. */
function tools(): Tool[] {
  return [
    { ...defaultTool('mm', 1), id: 't1', name: 'Tool 1' },
    { ...defaultTool('mm', 1), id: 't2', name: 'Tool 2' },
  ]
}

function makeOperation(id: string, toolRef: string): Operation {
  return {
    id,
    name: `Op ${id}`,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'stock' },
    toolRef,
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

/**
 * A 100 × 80 × 20 block. Project Z 25 (the stock top plus the default 5 mm
 * clearance) maps to machine Z5; project Z 15 (a cut 5 mm deep) maps to
 * machine Z−5. The origin sits at the front-left top corner.
 */
function makeProject(toolIds: readonly string[], units: 'mm' | 'inch' = 'mm'): Project {
  const base = newProject('Template re-entry', units)
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  base.origin = { name: 'Origin', x: 0, y: 80, z: 20, visible: true }
  base.tools = tools()
  base.operations = toolIds.map((toolRef, index) => ({
    ...makeOperation(`op${index + 1}`, toolRef),
    setupId: base.activeSetupId,
  }))
  return base
}

/** A rapid in, a plunge, a cut, a rapid out: an operation whose first move is a rapid. */
const RAPID_MOVES: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 0, y: 0, z: 25 }, to: { x: 10, y: 70, z: 25 } },
  { kind: 'plunge', from: { x: 10, y: 70, z: 25 }, to: { x: 10, y: 70, z: 15 } },
  { kind: 'cut', from: { x: 10, y: 70, z: 15 }, to: { x: 30, y: 70, z: 15 } },
  { kind: 'rapid', from: { x: 30, y: 70, z: 15 }, to: { x: 30, y: 70, z: 25 } },
]

/** Ends at machine (0, 10, 5): the stale plane a feed's start is measured from. */
const PARK_END_MOVES: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 0, y: 0, z: 25 }, to: { x: 0, y: 70, z: 25 } },
  { kind: 'plunge', from: { x: 0, y: 70, z: 25 }, to: { x: 0, y: 70, z: 15 } },
  { kind: 'rapid', from: { x: 0, y: 70, z: 15 }, to: { x: 0, y: 70, z: 25 } },
]

/**
 * An operation whose first planned step is a feed, declaring a start the
 * emitter has not tracked: machine (50, 60, −5). This is Codex's repro 3.
 */
const LINEAR_MOVES: ToolpathMove[] = [
  { kind: 'cut', from: { x: 50, y: 20, z: 15 }, to: { x: 60, y: 20, z: 15 } },
]

/** A lead-in that ends exactly where the arc operation begins: machine (40, 10). */
const ARC_LEAD_IN: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 0, y: 0, z: 25 }, to: { x: 40, y: 70, z: 25 } },
  { kind: 'cut', from: { x: 40, y: 70, z: 25 }, to: { x: 39, y: 70, z: 25 } },
  { kind: 'rapid', from: { x: 39, y: 70, z: 25 }, to: { x: 40, y: 70, z: 25 } },
]

/** A full circle around project (35, 70): arc fitting makes the first step a `G2`. */
const ARC_FIRST_MOVES: ToolpathMove[] = Array.from({ length: 36 }, (_, index) => {
  const from = (index / 36) * Math.PI * 2
  const to = ((index + 1) / 36) * Math.PI * 2
  return {
    kind: 'cut' as const,
    from: { x: 35 + 5 * Math.cos(from), y: 70 + 5 * Math.sin(from), z: 25 },
    to: { x: 35 + 5 * Math.cos(to), y: 70 + 5 * Math.sin(to), z: 25 },
  }
})

/** The same circle at project Z15 (machine Z−5): its highest point is a cutting point. */
const ARC_FIRST_LOW_MOVES: ToolpathMove[] = ARC_FIRST_MOVES.map((move) => ({
  ...move,
  from: { ...move.from, z: 15 },
  to: { ...move.to, z: 15 },
}))

function postOperations(
  project: Project,
  definition: MachineDefinition,
  movesByOperation: readonly ToolpathMove[][],
  drillCycles?: DrillCycle[],
): string {
  return runPostProcessor({
    project,
    definition,
    operations: project.operations.map((operation, index) => ({
      operation,
      tool: normalizeToolForProject(project.tools.find((tool) => tool.id === operation.toolRef)!, project),
      toolpath: {
        operationId: operation.id,
        warnings: [],
        bounds: null,
        moves: movesByOperation[index] ?? [],
        ...(drillCycles && index === 0 ? { drillCycles } : null),
      } as ToolpathResult,
    })),
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode
}

function withOperationHeader(id: string, template: string): MachineDefinition {
  const base = bundled(id)
  return {
    ...base,
    program: { ...base.program, operationHeader: [...base.program.operationHeader, template] },
  }
}

function machineWithToolChange(id: string, commands: string[]): MachineDefinition {
  const base = bundled(id)
  return { ...base, toolChange: { ...base.toolChange, commands } }
}

/**
 * The injected templates. Every one can move the machine or its modal state:
 * an axis word (X/Y or Z), a positioning arc, a subroutine call, and a tool
 * change. None is on the inert allowlist.
 */
const TEMPLATES = [
  'G0 X0 Y0',
  'G2 X1 Y1 I1 J0',
  'G0 Z-2',
  'o<x> call',
  'M6 T99',
] as const

// ── Emitted-motion reading ────────────────────────────────────

interface MotionBlock {
  raw: string
  /** The motion word on the block, or null for a bare axis word. */
  motion: string | null
  x?: number
  y?: number
  z?: number
  a?: number
  /** `G53`: the block is in machine coordinates. */
  machineCoordinate?: boolean
}

/** The G-code motion blocks in a text, comments and line numbers removed. */
function gcodeMotionBlocks(text: string): MotionBlock[] {
  const blocks: MotionBlock[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/\([^)]*\)/g, ' ')
    const semicolon = line.indexOf(';')
    if (semicolon >= 0) line = line.slice(0, semicolon)
    line = line.replace(/^N\d+\s+/, '').trim()
    if (line.length === 0) continue
    const block: MotionBlock = { raw: line, motion: null }
    for (const match of line.matchAll(/([A-Za-z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/g)) {
      const letter = match[1].toUpperCase()
      const value = Number(match[2])
      if (letter === 'G') {
        const code = Math.trunc(value)
        if (code >= 0 && code <= 3) block.motion = `G${code}`
        if (code === 53) block.machineCoordinate = true
        continue
      }
      if (letter === 'X') block.x = value
      else if (letter === 'Y') block.y = value
      else if (letter === 'Z') block.z = value
      else if (letter === 'A' && block.motion !== null) block.a = value
    }
    // A line with no coordinate and no motion word is a setting, not a block.
    if (block.x === undefined && block.y === undefined && block.z === undefined
      && block.a === undefined && block.motion === null) {
      continue
    }
    blocks.push(block)
  }
  return blocks
}

interface SbpBlock {
  raw: string
  command: 'JZ' | 'J2' | 'J3' | 'M3' | 'CG'
  x?: number
  y?: number
  z?: number
}

/** The SBP motion blocks in a part file. */
function sbpMotionBlocks(text: string): SbpBlock[] {
  const blocks: SbpBlock[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("'")) continue
    const [command, ...values] = line.split(',')
    const numbers = values.map(Number)
    if (command === 'JZ') blocks.push({ raw: line, command, z: numbers[0] })
    else if (command === 'J2') blocks.push({ raw: line, command, x: numbers[0], y: numbers[1] })
    else if (command === 'J3') blocks.push({ raw: line, command, x: numbers[0], y: numbers[1], z: numbers[2] })
    else if (command === 'M3') blocks.push({ raw: line, command, x: numbers[0], y: numbers[1], z: numbers[2] })
    else if (command === 'CG') blocks.push({ raw: line, command, x: numbers[1], y: numbers[2] })
  }
  return blocks
}

/** The text from the last occurrence of a template on. */
function afterLastTemplate(text: string, template: string): string {
  const at = text.lastIndexOf(template)
  assert(at >= 0, `fixture: the template ${JSON.stringify(template)} is written\n${text}`)
  return text.slice(at + template.length)
}

/** A number emitted to the definition's precision. */
function closeTo(actual: number | undefined, expected: number, label: string): void {
  assert(actual !== undefined, `${label}: a word is written (got ${String(actual)})`)
  assert(Math.abs(actual - expected) < 5e-4, `${label}: expected ${expected}, got ${actual}`)
}

// ── The table ─────────────────────────────────────────────────

interface ReentryExpectation {
  /** The safe Z the retract must state, or null when the dialect may not write Z. */
  safeZ: number | null
  /** True when the retract is in machine coordinates (`G53`). */
  machineRetract?: boolean
  /** The exact point the re-entry must state, in the emitted frame. */
  start: { x: number; y: number; a?: number }
}

interface StartKind {
  name: string
  /** The G-code definitions this start kind runs on. */
  machines: readonly string[]
  /** The program for one injected operation-header template. */
  gcode(machineId: string, template: string): string
  /** The SBP program, when ShopBot can run this start kind. */
  shopbot?: () => string
  expected: ReentryExpectation
  /** Assert the operation's own motion follows the re-entry. */
  approach(blocks: readonly MotionBlock[], text: string): void
}

const startKinds: StartKind[] = [
  {
    name: 'rapid',
    machines: ['grbl', 'linuxcnc', 'mach3'],
    gcode: (machineId, template) => postOperations(
      makeProject(['t1', 't1']),
      withOperationHeader(machineId, template),
      [RAPID_MOVES, RAPID_MOVES],
    ),
    shopbot: () => postOperations(makeProject(['t1', 't2']), bundled('shopbot'), [RAPID_MOVES, RAPID_MOVES]),
    expected: { safeZ: 5, start: { x: 0, y: 80 } },
    approach: (blocks) => {
      closeTo(blocks[2]?.x, 10, 'the rapid target X follows the start plane')
      closeTo(blocks[2]?.y, 10, 'the rapid target Y follows the start plane')
    },
  },
  {
    name: 'linear feed',
    machines: ['grbl', 'linuxcnc', 'mach3'],
    gcode: (machineId, template) => postOperations(
      makeProject(['t1', 't1']),
      withOperationHeader(machineId, template),
      [PARK_END_MOVES, LINEAR_MOVES],
    ),
    shopbot: () => postOperations(makeProject(['t1', 't2']), bundled('shopbot'), [PARK_END_MOVES, LINEAR_MOVES]),
    expected: { safeZ: 5, start: { x: 50, y: 60 } },
    approach: (blocks) => {
      // The cutter descends from the safe height to the feed's own start, then
      // the feed runs from a point the controller has been told.
      closeTo(blocks[2]?.z, -5, 'the feed start descends to its own Z')
      assert.equal(blocks[3]?.motion, 'G1')
      closeTo(blocks[3]?.x, 60, 'the feed runs to its end X')
      closeTo(blocks[3]?.y, 60, 'the feed runs to its end Y')
    },
  },
  {
    name: 'arc',
    machines: ['grbl', 'linuxcnc', 'mach3'],
    gcode: (machineId, template) => postOperations(
      makeProject(['t1', 't1']),
      withOperationHeader(machineId, template),
      [ARC_LEAD_IN, ARC_FIRST_MOVES],
    ),
    shopbot: () => postOperations(makeProject(['t1', 't2']), bundled('shopbot'), [ARC_LEAD_IN, ARC_FIRST_MOVES]),
    expected: { safeZ: 5, start: { x: 40, y: 10 } },
    approach: (blocks) => {
      assert.equal(blocks[2]?.motion, 'G2', 'the arc follows the stated start')
      closeTo(blocks[2]?.x, 35, 'the arc ends at X35 measured from X40')
    },
  },
  {
    name: 'canned drill',
    // A canned cycle exists only on this bundled machine; every dialect that
    // has one follows the same re-entry.
    machines: ['mach3'],
    gcode: (machineId, template) => {
      const project = makeProject(['t1'])
      const drilling = project.operations.map((operation) => ({
        ...operation,
        kind: 'drilling' as const,
        drillType: 'simple' as const,
      }))
      return postOperations(
        { ...project, operations: drilling },
        withOperationHeader(machineId, template),
        [[]],
        [{ x: 20, y: 20, clearZ: 25, retractZ: 25, bottomZ: 15, drillType: 'simple' }],
      )
    },
    expected: { safeZ: 5, start: { x: 20, y: 60 } },
    approach: (blocks, text) => {
      assert.ok(blocks.some((block) => block.x === 20 && block.y === 60 && block.z === -5),
        'the cycle drills at the stated plane')
      assert.match(text, /G81 X20\.000 Y60\.000 Z-5\.000 R5\.000/, 'the cycle positions from the stated plane')
    },
  },
  {
    name: 'plasma pierce',
    machines: ['grbl-plasma'],
    gcode: (machineId, template) => plasmaProgram(machineId, template),
    expected: { safeZ: 5, start: { x: 133, y: 136.3 } },
    approach: (blocks, text) => {
      // The pierce point is stated, and the first arc is measured from it:
      // I-3 from X133 is the hole centre at X130.
      assert.ok(blocks.some((block) => block.motion === 'G3'), 'the contour arc is written')
      assert.match(text, /G3 X130\.000 Y139\.300 I-3\.000 J0\.000/, 'the hole arc is measured from the stated pierce point')
    },
  },
  {
    name: 'plasma pierce (controller Z)',
    machines: ['qtplasmac'],
    gcode: (machineId, template) => plasmaProgram(machineId, template),
    // The controller's load filter strips every Z word, so the re-entry is the
    // stated XY travel alone.
    expected: { safeZ: null, start: { x: 133, y: 136.3 } },
    approach: (blocks) => {
      const arc = blocks.find((block) => block.motion === 'G3')
      assert.ok(arc, 'the contour arc is written')
      closeTo(arc?.x, 130, 'the arc ends at X130')
    },
  },
  {
    name: 'rotary/around',
    machines: ['grbl'],
    gcode: (machineId, template) => rotaryProgram(machineId, template),
    expected: { safeZ: 0, machineRetract: true, start: { x: 0, y: 0, a: 45 } },
    approach: (blocks) => {
      closeTo(blocks[2]?.z, 10, 'the plunge descends to its own start Z')
      assert.equal(blocks[3]?.motion, 'G1', 'the feed follows')
    },
  },
]

function plasmaProgram(machineId: string, template: string): string {
  const { input } = exportPlasma({
    units: 'mm',
    thickness: 2,
    machineId,
    features: [
      { id: 'plate-a', operation: 'add', profile: rectangle(20, 20, 60, 40) },
      { id: 'plate-b', operation: 'add', profile: rectangle(100, 20, 60, 40) },
    ],
    operations: [{ featureIds: ['plate-a'] }, { featureIds: ['plate-b'] }],
  })
  const base = input.definition
  const definition: MachineDefinition = {
    ...base,
    program: { ...base.program, operationHeader: [...base.program.operationHeader, template] },
  }
  return runPostProcessor({ ...input, definition }).gcode
}

function rotaryProject(): Project {
  const base = newProject('Template rotary', 'mm')
  base.stock = roundStock(20, 100, 'x')
  const bounds = getStockBounds(base.stock)
  base.origin = {
    name: 'Origin',
    x: bounds.minX,
    y: (bounds.minY + bounds.maxY) / 2,
    z: base.stock.thickness,
    visible: true,
  }
  base.tools = tools()
  base.operations = ['t1', 't2'].map((toolRef, index) => makeOperation(`rop${index + 1}`, toolRef))
  return base
}

/** The same pass at a constant angle: it establishes A45, cuts, and leaves A45. */
const ROTARY_MOVES: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 0, y: 10, z: 30, a: 45 }, to: { x: 0, y: 10, z: 30, a: 45 } },
  { kind: 'plunge', from: { x: 0, y: 10, z: 30, a: 45 }, to: { x: 0, y: 10, z: 20, a: 45 } },
  { kind: 'cut', from: { x: 0, y: 10, z: 20, a: 45 }, to: { x: 20, y: 10, z: 20, a: 45 } },
]

function rotaryMachine(): MachineDefinition {
  const base = bundled('grbl')
  return validateMachineDefinition({
    ...structuredClone(base),
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
    toolChange: { ...base.toolChange, commands: ['M5', 'M6 T{toolNumber}'] },
  })
}

function rotaryProgram(machineId: string, template: string): string {
  const machine = rotaryMachine()
  assert.equal(machineId, 'grbl')
  return postOperations(
    rotaryProject(),
    { ...machine, program: { ...machine.program, operationHeader: [...machine.program.operationHeader, template] } },
    [ROTARY_MOVES, ROTARY_MOVES],
  )
}

/**
 * Every G-code program whose last template is the injected one: the first
 * motion after it is the re-entry, nothing moves before it, and every axis of
 * the start point is stated. The expected values are literals of the machine
 * frame, not re-derived from the emitter's own helpers.
 */
for (const kind of startKinds) {
  for (const machineId of kind.machines) {
    for (const template of TEMPLATES) {
      const label = `${machineId}/${kind.name}/${template}`
      const gcode = kind.gcode(machineId, template)
      const tail = afterLastTemplate(gcode, template)
      const blocks = gcodeMotionBlocks(tail)
      const { expected } = kind
      if (expected.safeZ === null) {
        // Controller-owned piercing writes no Z: the stated XY travel is the
        // re-entry, and it spells the rapid itself.
        assert.equal(blocks[0]?.motion, 'G0', `${label}: the XY re-entry spells G0`)
        closeTo(blocks[0]?.x, expected.start.x, `${label}: re-entry X`)
        closeTo(blocks[0]?.y, expected.start.y, `${label}: re-entry Y`)
      } else {
        assert.equal(blocks[0]?.motion, 'G0', `${label}: the safe-Z retract restates G0`)
        assert.notEqual(blocks[0]?.motion, 'G1', `${label}: no feed move precedes the retract`)
        closeTo(blocks[0]?.z, expected.safeZ, `${label}: safe Z`)
        assert.equal(blocks[0]?.x, undefined, `${label}: the retract moves Z alone`)
        assert.equal(blocks[0]?.y, undefined, `${label}: the retract moves Z alone`)
        if (expected.machineRetract) {
          assert.equal(blocks[0]?.machineCoordinate, true, `${label}: the bar retract is in machine coordinates`)
        }
        assert.ok(blocks[1]?.motion === null || blocks[1]?.motion === 'G0',
          `${label}: the start plane continues the rapid (${String(blocks[1]?.motion)})`)
        closeTo(blocks[1]?.x, expected.start.x, `${label}: start X`)
        closeTo(blocks[1]?.y, expected.start.y, `${label}: start Y`)
        assert.equal(blocks[1]?.z, undefined, `${label}: the start plane states no Z`)
        if (expected.start.a !== undefined) {
          closeTo(blocks[1]?.a, expected.start.a, `${label}: the rotary word is stated`)
        }
      }
      kind.approach(blocks, tail)
    }
  }
  if (kind.shopbot) {
    const label = `shopbot/${kind.name}/C9`
    const partFile = kind.shopbot()
    const tail = afterLastTemplate(partFile, 'C9')
    const blocks = sbpMotionBlocks(tail)
    const { expected } = kind
    assert.equal(blocks[0]?.command, 'JZ', `${label}: the safe-Z jog comes first`)
    closeTo(blocks[0]?.z, expected.safeZ!, `${label}: safe Z`)
    assert.equal(blocks[1]?.command, 'J2', `${label}: the start plane follows`)
    closeTo(blocks[1]?.x, expected.start.x, `${label}: start X`)
    closeTo(blocks[1]?.y, expected.start.y, `${label}: start Y`)
  }
}

// ── Inert templates stay byte-identical ───────────────────────

function testInertTemplateByteIdentity(): void {
  console.log('Testing an inert template leaves every other byte unchanged...')
  // `G94` and a comment can move nothing and change no modal state. The program
  // must be exactly the one without them, line for line.
  const project = makeProject(['t1', 't1'])
  const plain = postOperations(project, bundled('grbl'), [RAPID_MOVES, RAPID_MOVES])
  for (const template of ['G94', '; G0 X0 Y0', 'M5']) {
    const inert = postOperations(project, withOperationHeader('grbl', template), [RAPID_MOVES, RAPID_MOVES])
    const without = (gcode: string) => gcode.split('\n').filter((line) => line !== template)
    assert.deepEqual(without(inert), without(plain), `${template}: an inert template changes nothing but its own line`)
  }
  const program = postOperations(makeProject(['t1']), bundled('grbl'), [RAPID_MOVES])
  assert.ok(!program.includes('Z5.000\nX0.000 Y80.000'), 'a template-free program does not re-enter')
}

// ── Codex review pass 3, repro 1 ─────────────────────────────

function testArcOnlyOperationRetractsAboveTheCut(): void {
  console.log('Testing an arc-only operation at machine Z-5 retracts above the stock...')
  // The highest point of this operation is the cut plane itself. Retracting to
  // it would rapid the XY travel through the stock at Z-5; the re-entry must use
  // the operation's safe height (project 25 → machine 5), which the operation
  // never visits because it has no rapid.
  const template = 'G0 Z-2'
  const project = makeProject(['t1'])
  const gcode = postOperations(project, withOperationHeader('grbl', template), [ARC_FIRST_LOW_MOVES])
  const tail = afterLastTemplate(gcode, template)
  const blocks = gcodeMotionBlocks(tail)
  closeTo(blocks[0]?.z, 5, 'the retract is the stock clearance, not the Z-5 cut plane')
  closeTo(blocks[1]?.x, 40, 'the arc start is stated')
  closeTo(blocks[1]?.y, 10, 'the arc start is stated')
  closeTo(blocks[2]?.z, -5, 'the cutter descends to the arc plane')
  assert.equal(blocks[3]?.motion, 'G2', 'the arc follows')
  const expectedSafe = projectToMachinePoint(
    { x: 0, y: 0, z: getOperationSafeZ(project) },
    project.origin,
    bundled('grbl'),
  ).z
  assert.equal(expectedSafe, 5, 'fixture: the generator safe height is machine Z5')
  // ShopBot gets the same clearance in its own words.
  const partFile = postOperations(makeProject(['t1', 't2']), bundled('shopbot'), [ARC_FIRST_LOW_MOVES, ARC_FIRST_LOW_MOVES])
  const sbp = sbpMotionBlocks(afterLastTemplate(partFile, 'C9'))
  assert.equal(sbp[0]?.command, 'JZ')
  closeTo(sbp[0]?.z, 5, 'the SBP safe jog is the clearance, not the cut plane')
}

// ── Codex review pass 3, repro 2 ─────────────────────────────

function testTorchOnTemplateCannotLeaveAnArcUnstated(): void {
  console.log('Testing a moving torch-on template re-states the pierce point before the arc...')
  for (const machineId of ['grbl-plasma', 'qtplasmac']) {
    const { input } = exportPlasma({
      units: 'mm',
      thickness: 2,
      machineId,
      features: [{ id: 'plate-a', operation: 'add', profile: rectangle(20, 20, 60, 40) }],
      operations: [{ featureIds: ['plate-a'] }],
    })
    const base = input.definition
    const definition: MachineDefinition = {
      ...base,
      plasma: { ...base.plasma!, torchOnCommand: `${base.plasma!.torchOnCommand}\nG0 X0 Y0` },
    }
    const gcode = runPostProcessor({ ...input, definition }).gcode
    const at = gcode.indexOf('G0 X0 Y0')
    assert(at >= 0, `${machineId}: the fixture's torch-on macro moves the torch`)
    const afterTorchOn = gcode.slice(at + 'G0 X0 Y0'.length)
    const blocks = gcodeMotionBlocks(afterTorchOn)
    // The very next motion is the stated pierce point, so the first arc's I/J
    // is measured from a point the controller was told.
    assert.equal(blocks[0]?.motion, 'G0', `${machineId}: the pierce point is restated as a rapid`)
    closeTo(blocks[0]?.x, 53, `${machineId}: pierce X is restated`)
    closeTo(blocks[0]?.y, 136.3, `${machineId}: pierce Y is restated`)
    const firstArc = blocks.find((block) => block.motion === 'G3')
    assert.ok(firstArc, `${machineId}: the contour arc is written`)
    assert.match(gcode, /G3 X50\.000 Y139\.300 I-3\.000 J0\.000/,
      `${machineId}: the arc is measured from the restated pierce point`)
  }
}

// ── Codex review pass 3, repro 3 ─────────────────────────────

function testKnownButDifferentStartCoordinates(): void {
  console.log('Testing a feed that starts where the emitter was not restates X and Y...')
  // The template parks X alone; the tracked Y stays 10 while the feed declares
  // Y60. Repairing only the unknown axis emitted X50, then Z-5, and the feed cut
  // diagonally from Y10. Every planar axis is stated now.
  const template = 'G0 X0'
  const gcode = postOperations(
    makeProject(['t1', 't1']),
    withOperationHeader('grbl', template),
    [PARK_END_MOVES, LINEAR_MOVES],
  )
  const tail = afterLastTemplate(gcode, template)
  const blocks = gcodeMotionBlocks(tail)
  closeTo(blocks[0]?.z, 5, 'the safe retract is stated even though the template moved no Z')
  assert.ok(blocks[1]?.motion === null || blocks[1]?.motion === 'G0', 'the start plane continues the rapid')
  closeTo(blocks[1]?.x, 50, 'the start X is stated')
  closeTo(blocks[1]?.y, 60, 'the start Y is stated, not the stale 10')
  closeTo(blocks[2]?.z, -5, 'the descent follows the stated plane')
  assert.equal(blocks[3]?.motion, 'G1')
  closeTo(blocks[3]?.x, 60, 'the feed runs to its end')
  closeTo(blocks[3]?.y, 60, 'the feed runs at the start Y, never diagonally from Y10')
}

// ── Codex review pass 3, repro 4 ─────────────────────────────

function testTemplateMotionModeIsRestated(): void {
  console.log('Testing a G2 positioning template cannot leave the controller in arc mode...')
  // Operation two's first rapid targets the XY operation one ended at, so a
  // stale motion word used to emit a bare `X… Y…` block — an arc continuation
  // to the controller. The retract now spells G0 before it.
  const template = 'G2 X1 Y1 I1 J0'
  const parkMoves: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 30, y: 70, z: 25 }, to: { x: 30, y: 70, z: 25 } },
    { kind: 'plunge', from: { x: 30, y: 70, z: 25 }, to: { x: 30, y: 70, z: 15 } },
    { kind: 'cut', from: { x: 30, y: 70, z: 15 }, to: { x: 10, y: 70, z: 15 } },
    { kind: 'rapid', from: { x: 10, y: 70, z: 15 }, to: { x: 30, y: 70, z: 25 } },
  ]
  const gcode = postOperations(
    makeProject(['t1', 't1']),
    withOperationHeader('grbl', template),
    [parkMoves, parkMoves],
  )
  const tail = afterLastTemplate(gcode, template)
  const blocks = gcodeMotionBlocks(tail)
  assert.equal(blocks[0]?.motion, 'G0', 'the first block after the template is a rapid')
  assert.ok(blocks[0]?.z !== undefined, 'and it is the safe-Z retract')
  assert.ok(blocks[1]?.motion === null || blocks[1]?.motion === 'G0', 'the start plane continues the rapid')
  closeTo(blocks[1]?.x, 30, 'the parked plane is restated')
  closeTo(blocks[1]?.y, 10, 'the parked plane is restated')
}

// ── The original #1057 repro, in a Bottom setup ──────────────

function testTwoToolsBottomRepro(): void {
  console.log('Testing the two-tool Bottom repro writes the retract before the XY rapid...')
  const base = makeProject(['t1', 't2'])
  base.operations = base.operations.map((operation) => ({
    ...operation,
    setupId: base.activeSetupId,
  }))
  const project = withBottomSetup(base, { axis: 'x', operationIds: base.operations.map((operation) => operation.id) })
  const bottomMoves: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 0, y: 0, z: -5 }, to: { x: 10, y: 70, z: -5 } },
    { kind: 'plunge', from: { x: 10, y: 70, z: -5 }, to: { x: 10, y: 70, z: 5 } },
    { kind: 'cut', from: { x: 10, y: 70, z: 5 }, to: { x: 30, y: 70, z: 5 } },
    { kind: 'rapid', from: { x: 30, y: 70, z: 5 }, to: { x: 30, y: 70, z: -5 } },
  ]
  const definition = machineWithToolChange('grbl', ['M0 ; Tool change: {toolName}', 'G0 Z-2'])
  const gcode = postOperations(project, definition, [bottomMoves, bottomMoves])
  const tail = afterLastTemplate(gcode, 'G0 Z-2')
  const blocks = gcodeMotionBlocks(tail)
  closeTo(blocks[0]?.z, 5, 'the retract is the flipped setup safe Z')
  assert.equal(blocks[0]?.motion, 'G0', 'the retract restates G0')
  closeTo(blocks[1]?.x, 0, 'the operation start X is stated')
  closeTo(blocks[1]?.y, 0, 'the operation start Y is stated')
  closeTo(blocks[2]?.x, 10, 'the rapid target follows')
  closeTo(blocks[2]?.y, 70, 'the rapid target follows')
  closeTo(blocks[3]?.z, -5, 'the plunge runs at the target plane, not the template Z')
}

// ── A turned setup maps the fallback clearance to its own face ─

function testBottomFallbackSafeZ(): void {
  console.log('Testing a Bottom feed-first operation retracts above the face that is up...')
  // The generator's clearance is a height above the face being cut, measured in
  // the setup-local frame. A Bottom operation turns the stock over, so the same
  // project height maps to the other side: the retract must be machine Z5, not
  // the flipped canonical value (which would be below the table).
  const base = makeProject(['t1'])
  const project = withBottomSetup(base, { axis: 'x', operationIds: base.operations.map((operation) => operation.id) })
  const feedFirst: ToolpathMove[] = [
    { kind: 'cut', from: { x: 50, y: 20, z: 5 }, to: { x: 60, y: 20, z: 5 } },
  ]
  const template = 'G0 Z-2'
  const gcode = postOperations(project, withOperationHeader('grbl', template), [feedFirst])
  const blocks = gcodeMotionBlocks(afterLastTemplate(gcode, template))
  closeTo(blocks[0]?.z, 5, 'the retract is above the flipped face, not below the table')
  assert.equal(blocks[0]?.motion, 'G0')
  closeTo(blocks[1]?.x, 50, 'the feed start X is stated')
  closeTo(blocks[1]?.y, 20, 'the feed start Y is stated')
  closeTo(blocks[2]?.z, -5, 'the descent reaches the flipped cut plane')
}

// ── A units/plane/distance switch is not inert ───────────────

function testModalSwitchIsNotInert(): void {
  console.log('Testing a template that changes the distance mode forces a re-entry...')
  // `G91` leaves the controller in incremental mode; the next absolute word
  // would be read as a delta. The re-entry restates G90 before any coordinate.
  for (const [template, restore] of [['G91', 'G90'], ['G18', 'G17'], ['G20', 'G21']] as const) {
    const gcode = postOperations(
      makeProject(['t1', 't1']),
      withOperationHeader('grbl', template),
      [RAPID_MOVES, RAPID_MOVES],
    )
    const tail = afterLastTemplate(gcode, template)
    const restoreAt = tail.indexOf(`${restore}\n`)
    const safeAt = tail.indexOf('\nG0 Z5.000')
    assert(restoreAt >= 0, `${template}: ${restore} is restated`)
    assert(restoreAt < safeAt || safeAt < 0, `${template}: ${restore} comes before the first motion`)
    const blocks = gcodeMotionBlocks(tail)
    assert.equal(blocks[0]?.motion, 'G0', `${template}: the re-entry still spells G0`)
  }
  // An mm program's own G21, and the absolute G90, are inert.
  const plain = postOperations(makeProject(['t1', 't1']), bundled('grbl'), [RAPID_MOVES, RAPID_MOVES])
  const same = postOperations(makeProject(['t1', 't1']), withOperationHeader('grbl', 'G21'), [RAPID_MOVES, RAPID_MOVES])
  const without = (gcode: string) => gcode.split('\n').filter((line) => line !== 'G21')
  assert.deepEqual(without(same), without(plain), 'the program\'s own units command is inert')
}

testInertTemplateByteIdentity()
testArcOnlyOperationRetractsAboveTheCut()
testTorchOnTemplateCannotLeaveAnArcUnstated()
testKnownButDifferentStartCoordinates()
testTemplateMotionModeIsRestated()
testTwoToolsBottomRepro()
testBottomFallbackSafeZ()
testModalSwitchIsNotInert()

console.log('gcode template re-entry tests passed')
