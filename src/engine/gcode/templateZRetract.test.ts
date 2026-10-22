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
 * The one restart block after a tool change (#1057 slice F).
 *
 * Frank's decision, 2026-10-21: the tool-change and end-of-program templates
 * may still do anything, so after every emitted tool change the emitter starts
 * over before the operation's own approach:
 *
 *   G90 G94 G17            distance, feed and plane modes the coordinates need
 *   <units word>           the frame the numbers are in
 *   G0 Z<safe>             a proven clearance: a square blank's travel height,
 *                          the machine-coordinate Safe Z of a bar's manual-index
 *                          program (#1054), or the operation's own rapid height
 *   G0 X… Y… [A…]          the exact point the operation's first move starts from
 *                          (the angle is stated even when it is unchanged)
 *   [G0 Z<start plane>]    only when that first move is a feed or an arc
 *
 * The tool-change template may end anywhere (`G0 Z-2`), leave the controller in
 * incremental coordinates (`G91`) or select a work coordinate; the block does
 * not trust any of it. The first operation's tool load is a tool change too, so
 * a single-tool program written with tool changes on carries the block; written
 * with tool changes off, every program is byte-identical to the base
 * (`templateByteIdentity.test.ts` pins that).
 *
 * ShopBot's part file writes the equivalent: `SA`, `JZ` to the safe Z, then `J2`
 * to the start. A manual-index program's own opening turn follows the block's
 * baseline restore and is itself a machine-coordinate retract plus a stated
 * angle (#1054), so the block does not retract a second time.
 *
 * Mutations that must fail these tests (restore the file from a `cp` backup):
 * - drop `G90` from the restart line → the `G91` template test sees the program
 *   continue in incremental mode;
 * - drop the XY restatement → the second operation's first rapid starts from
 *   the parked plane instead of the move's own start;
 * - drop the start-plane descent → the feed-first test feeds diagonally down
 *   from the safe height.
 *
 * Run with: npx tsx src/engine/gcode/templateZRetract.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, rectProfile, roundStock, getStockBounds } from '../../types/project'
import type { Operation, Project, Tool } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { runPostProcessor } from './postprocessor'
import { validateMachineDefinition } from './types'
import type { MachineDefinition } from './types'

function bundled(id: string): MachineDefinition {
  return validateMachineDefinition(structuredClone(BUNDLED_DEFINITIONS.find((entry) => entry.id === id)!))
}

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
 * clearance) maps to machine Z5; project Z 15 (a cut 5 mm deep) maps to machine
 * Z−5. The origin sits at the front-left top corner.
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

/** An operation whose first move is a feed, starting at machine (50, 60, −5). */
const FEED_FIRST_MOVES: ToolpathMove[] = [
  { kind: 'cut', from: { x: 50, y: 20, z: 15 }, to: { x: 60, y: 20, z: 15 } },
]

/**
 * The same pass at a constant angle on a round bar: it establishes A0, cuts,
 * and leaves A0.
 */
const ROTARY_MOVES: ToolpathMove[] = [
  { kind: 'rapid', from: { x: 0, y: 10, z: 30, a: 0 }, to: { x: 0, y: 10, z: 30, a: 0 } },
  { kind: 'plunge', from: { x: 0, y: 10, z: 30, a: 0 }, to: { x: 0, y: 10, z: 20, a: 0 } },
  { kind: 'cut', from: { x: 0, y: 10, z: 20, a: 0 }, to: { x: 20, y: 10, z: 20, a: 0 } },
]

/** The same moves at a non-zero angle: the restart must restate it. */
const ROTARY_45_MOVES: ToolpathMove[] = ROTARY_MOVES.map((move) => ({
  ...move,
  from: { ...move.from, a: 45 },
  to: { ...move.to, a: 45 },
}))

function postOperations(
  project: Project,
  definition: MachineDefinition,
  movesByOperation: readonly ToolpathMove[][],
  emitToolChanges = true,
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
      } as ToolpathResult,
    })),
    options: { emitToolChanges, emitCoolant: false, programName: project.meta.name },
  }).gcode
}

/** The physical lines after the last occurrence of `marker`, line numbers removed. */
function linesAfter(text: string, marker: string): string[] {
  const at = text.lastIndexOf(marker)
  assert(at >= 0, `fixture: ${JSON.stringify(marker)} is in the program\n${text}`)
  return text.slice(at + marker.length).split('\n')
    .map((line) => line.replace(/^N\d+\s+/, '').trim())
    .filter((line) => line.length > 0)
}

/**
 * The lines from the restart block on: a definition may write its tool-change
 * pause (`M0`/`M1`) as a line of its own after the command that names the
 * change, and the block begins after the whole tool-change block.
 */
function restartLines(text: string, marker: string): string[] {
  const lines = linesAfter(text, marker)
  while (lines.length > 0 && (lines[0] === 'M0' || lines[0] === 'M1')) lines.shift()
  return lines
}

/** The G-code motion blocks in a text, comments and line numbers removed. */
interface MotionBlock {
  raw: string
  /** The motion word on the block, or null for a bare axis word. */
  motion: string | null
  x?: number
  y?: number
  z?: number
  a?: number
}

function motionBlocks(lines: readonly string[]): MotionBlock[] {
  const blocks: MotionBlock[] = []
  for (const rawLine of lines) {
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
        continue
      }
      if (letter === 'X') block.x = value
      else if (letter === 'Y') block.y = value
      else if (letter === 'Z') block.z = value
      else if (letter === 'A') block.a = value
    }
    if (block.x === undefined && block.y === undefined && block.z === undefined
      && block.a === undefined && block.motion === null) {
      continue
    }
    blocks.push(block)
  }
  return blocks
}

function closeTo(actual: number | undefined, expected: number, label: string): void {
  assert(actual !== undefined, `${label}: a word is written (got ${String(actual)})`)
  assert(Math.abs(actual - expected) < 5e-4, `${label}: expected ${expected}, got ${actual}`)
}

// ── 1. The block per bundled G-code dialect ───────────────────

console.log('Testing the restart block is written per dialect after a tool change...')

/** What a machine writes between its tool change and the operation's spindle word. */
const restartByDialect: Array<{ id: string; toolChangeEnd: string; block: string[] }> = [
  {
    id: 'generic',
    toolChangeEnd: 'M0',
    block: ['G90 G94 G17', 'G21', 'G0 Z5', 'X0 Y80'],
  },
  {
    id: 'grbl',
    toolChangeEnd: 'M0 ; Tool change: Tool 1',
    block: ['G90 G94 G17', 'G21', 'G0 Z5.000', 'X0.000 Y80.000'],
  },
  {
    id: 'grblhal',
    toolChangeEnd: 'M0',
    block: ['G90 G94 G17', 'G21', 'G0 Z5.000', 'X0.000 Y80.000'],
  },
  {
    id: 'linuxcnc',
    toolChangeEnd: 'G43 H1',
    block: ['G90 G94 G17', 'G21', 'G0 Z5.000', 'X0.000 Y80.000'],
  },
  {
    id: 'mach3',
    toolChangeEnd: 'G43 H1',
    block: ['G90 G94 G17', 'G21', 'G0 Z5.000', 'X0.000 Y80.000'],
  },
  {
    id: 'uccnc',
    toolChangeEnd: 'G43 H1',
    block: ['G90 G94 G17', 'G21', 'G0 Z5.000', 'X0.000 Y80.000'],
  },
]

for (const dialect of restartByDialect) {
  const program = postOperations(makeProject(['t1']), bundled(dialect.id), [RAPID_MOVES])
  // A definition may write its tool-change pause as a separate line after the
  // line that names the change; the block begins after the whole block.
  const after = restartLines(program, dialect.toolChangeEnd)
  assert.deepEqual(after.slice(0, dialect.block.length), dialect.block,
    `${dialect.id}: the restart block follows the tool change:\n${after.slice(0, 8).join('\n')}`)
  // The block is not the operation's own motion: the spindle word follows it,
  // then the operation's first rapid.
  assert.match(after[dialect.block.length] ?? '', /^M3 S12000/,
    `${dialect.id}: the block ends before the spindle starts (${after[dialect.block.length]})`)
}

{
  // ShopBot's part file: absolute mode, a jog to the safe Z, a jog to the start.
  const program = postOperations(makeProject(['t1']), bundled('shopbot'), [RAPID_MOVES])
  const after = linesAfter(program, 'C9')
  assert.deepEqual(after.slice(0, 3), ['SA', 'JZ,5.000', 'J2,0.000,80.000'],
    `shopbot: the part-file restart follows C9:\n${after.slice(0, 6).join('\n')}`)
  assert.equal(after[3], 'TR,12000', 'shopbot: then the spindle speed and start')
}

// ── 2. A tool-change template may do anything; the block does not trust it ──

console.log('Testing a low or incremental tool-change template is restarted...')

{
  // The template ends at `G0 Z-2`. The restart states the safe height before
  // any XY word, and the template line is still written.
  const base = bundled('grbl')
  const definition: MachineDefinition = {
    ...base,
    toolChange: { ...base.toolChange, commands: ['M5', 'M6 T{toolNumber}', 'G0 Z-2'] },
  }
  const program = postOperations(makeProject(['t1']), definition, [RAPID_MOVES])
  const after = restartLines(program, 'G0 Z-2')
  assert.deepEqual(after.slice(0, 5), ['G90 G94 G17', 'G21', 'G0 Z5.000', 'X0.000 Y80.000', 'M3 S12000.000'],
    `the low template is repaired by the retract:\n${after.slice(0, 6).join('\n')}`)
}

{
  // The template selects incremental distance mode. The restart restates G90
  // before the first coordinate word, and the units word follows it.
  const base = bundled('grbl')
  const definition: MachineDefinition = {
    ...base,
    toolChange: { ...base.toolChange, commands: ['M5', 'M6 T{toolNumber}', 'G91'] },
  }
  const program = postOperations(makeProject(['t1']), definition, [RAPID_MOVES])
  const after = restartLines(program, 'G91')
  assert.deepEqual(after.slice(0, 2), ['G90 G94 G17', 'G21'],
    `G90 is restored before any coordinate:\n${after.slice(0, 6).join('\n')}`)
}

// ── 3. Two tool changes, two blocks; the second operation starts where it says ──

console.log('Testing a two-tool program restarts after each change...')

{
  const program = postOperations(makeProject(['t1', 't2']), bundled('grbl'), [RAPID_MOVES, RAPID_MOVES])
  assert.equal((program.match(/G90 G94 G17/g) ?? []).length, 2,
    'one restart block per emitted tool change')
  const after = restartLines(program, 'M0 ; Tool change: Tool 2')
  assert.deepEqual(after.slice(0, 4), ['G90 G94 G17', 'G21', 'G0 Z5.000', 'X0.000 Y80.000'],
    'the second block follows the second change')

  // The first operation's own rapid follows the first block, so the block's
  // plane is not treated as the operation's target.
  const first = motionBlocks(restartLines(program, 'M0 ; Tool change: Tool 1'))
  assert.equal(first[0]?.motion, 'G0', 'the restart retract is a rapid')
  closeTo(first[0]?.z, 5, 'the restart retract is the operation clearance')
  closeTo(first[1]?.x, 0, 'the restart states the start X')
  closeTo(first[1]?.y, 80, 'the restart states the start Y')
  assert.equal(first[1]?.z, undefined, 'the stated plane carries no Z')
  closeTo(first[2]?.x, 10, 'the operation rapid follows')
  closeTo(first[2]?.y, 10, 'the operation rapid follows')
}

// ── 4. A feed-first operation descends to its own plane ───────

console.log('Testing a feed-first operation after a tool change descends to its start plane...')

{
  const program = postOperations(makeProject(['t1']), bundled('grbl'), [FEED_FIRST_MOVES])
  const blocks = motionBlocks(restartLines(program, 'M0 ; Tool change: Tool 1'))
  closeTo(blocks[0]?.z, 5, 'the restart retracts to the operation clearance')
  closeTo(blocks[1]?.x, 50, 'the restart states the feed start X')
  closeTo(blocks[1]?.y, 60, 'the restart states the feed start Y')
  assert.ok(blocks[2]?.motion === null || blocks[2]?.motion === 'G0',
    `the start-plane descent continues the rapid (${String(blocks[2]?.motion)})`)
  closeTo(blocks[2]?.z, -5, 'the descent reaches the feed plane, not the safe height')
  assert.equal(blocks[2]?.x, undefined, 'the descent moves Z alone')
  assert.equal(blocks[3]?.motion, 'G1', 'then the feed runs')
  closeTo(blocks[3]?.x, 60, 'the feed runs to the end X')
  closeTo(blocks[3]?.y, 60, 'the feed runs at the start Y, never diagonally from the safe height')
}

// ── 5. A rotary machine states the angle ─────────────────────

console.log('Testing a rotary machine states the angle in the restart block...')

{
  const rotaryMachine: MachineDefinition = validateMachineDefinition({
    ...structuredClone(bundled('grbl')),
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  const project = newProject('Rotary restart', 'mm')
  project.stock = roundStock(20, 100, 'x')
  const bounds = getStockBounds(project.stock)
  project.origin = {
    name: 'Origin',
    x: bounds.minX,
    y: (bounds.minY + bounds.maxY) / 2,
    z: project.stock.thickness,
    visible: true,
  }
  project.tools = tools()
  project.operations = [{ ...makeOperation('op1', 't1'), setupId: project.activeSetupId }]
  const program = postOperations(project, rotaryMachine, [ROTARY_45_MOVES])
  const blocks = motionBlocks(restartLines(program, 'M0 ; Tool change: Tool 1'))
  assert.equal(blocks[0]?.motion, 'G0', 'the restart retract is a rapid')
  closeTo(blocks[0]?.z, 10, 'the retract is above the bar')
  closeTo(blocks[1]?.a, 45, 'the restart states the operation start angle')
  closeTo(blocks[1]?.x, 0, 'and its plane')
  closeTo(blocks[1]?.y, 0, 'and its plane')
}

// ── 7. Tool changes off: no block ───────────────────────────

console.log('Testing a program with tool changes off writes no restart block...')

{
  const program = postOperations(makeProject(['t1']), bundled('grbl'), [RAPID_MOVES], false)
  assert.ok(!program.includes('G90 G94 G17'), 'no restart without a tool change')
  assert.ok(!program.includes('M0 ; Tool change'), 'no tool-change template either')
}

console.log('gcode tool-change restart tests passed')
