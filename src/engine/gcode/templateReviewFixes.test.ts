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
 * The seven must-fix findings from the Codex review of #1057 slice F.
 *
 * 1. Every string field of the machine definition schema is classified, and
 *    the single-word command fields match an exact per-field pattern:
 *    `rpmCommand: "G91\nS"` must not write a motion word after the restart.
 * 2. A parameter assignment does not end a header line: `#1=1 G0Z-2` and
 *    `#1=1 g91` are refused.
 * 3. Operator text may only be substituted inside a comment, and the emitter
 *    sanitizes it for the dialect's comment syntax.
 * 4. The non-header allowlist is inert only: `G80`/`G49` (and the other
 *    state-changing words) remain legal only in the header and the tool-change/
 *    footer templates.
 * 5. After the opening manual-index turn the start XY is stated before any
 *    feed, always.
 * 6. A bar Top/Bottom restart restates the setup's A angle after every tool
 *    change.
 * 7. A bar Top/Bottom restart always uses the G53 machine retract, including
 *    on a square blank.
 *
 * Mutations that must fail these tests (restore the file from a `cp` backup):
 * - 1: stop validating `command` fields;
 * - 2: return early on a parameter assignment again;
 * - 3: replace every placeholder with `1` again;
 * - 5: drop the placement that follows the opening turn;
 * - 6: stop forcing the setup angle in the restart;
 * - 7: choose the square travel height before `barSetupProgram`.
 *
 * Run with: npx tsx src/engine/gcode/templateReviewFixes.test.ts
 */

import assert from 'node:assert/strict'
import { z } from 'zod'
import { squareStock } from '../../types/barStock'
import { defaultTool, getStockBounds, newProject, roundStock } from '../../types/project'
import type { Operation, Project, Tool } from '../../types/project'
import { withBottomSetup } from '../../test/projectFixtures'
import { syncProjectSetups } from '../../store/helpers/setups'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { runPostProcessor } from './postprocessor'
import { MACHINE_STRING_FIELDS } from './templateRules'
import { MachineDefinitionSchema, validateMachineDefinition } from './types'
import type { MachineDefinition } from './types'

// ── Fixtures ──────────────────────────────────────────────────

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(found, `fixture: bundled machine ${id}`)
  return validateMachineDefinition(structuredClone(found))
}

/** A definition with one dotted schema path replaced, and nothing else. */
function replacing(
  definition: MachineDefinition,
  path: readonly string[],
  value: unknown,
): unknown {
  const clone: unknown = structuredClone(definition)
  let target = clone as Record<string, unknown>
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>
  }
  target[path[path.length - 1]] = value
  return clone
}

function parse(definition: unknown): ReturnType<typeof MachineDefinitionSchema.safeParse> {
  return MachineDefinitionSchema.safeParse(definition)
}

/** Assert the definition is refused on `field`, naming `word`. */
/** A Zod issue path as the schema field is written in a message. */
function pathName(path: ReadonlyArray<string | number>): string {
  let name = ''
  for (const part of path) {
    if (typeof part === 'number') name += `[${part}]`
    else name += name.length > 0 ? `.${part}` : part
  }
  return name
}

function assertRefused(definition: unknown, field: string, word: string, label: string): void {
  const result = parse(definition)
  assert.equal(result.success, false, `${label}: the definition is refused`)
  if (result.success) return
  const issue = result.error.issues.find((entry) => pathName(entry.path as Array<string | number>) === field)
  assert.ok(issue, `${label}: an issue names ${field}: ${JSON.stringify(result.error.issues)}`)
  assert.ok(issue.message.includes(`"${word}"`), `${label}: the message names "${word}": ${issue.message}`)
}

function assertAccepted(definition: unknown, label: string): void {
  const result = parse(definition)
  assert.equal(
    result.success,
    true,
    `${label}: accepted${result.success ? '' : `: ${JSON.stringify(result.error.issues)}`}`,
  )
}

function tools(): Tool[] {
  return [
    { ...defaultTool('mm', 1), id: 't1', name: 'Tool 1' },
    { ...defaultTool('mm', 1), id: 't2', name: 'Tool 2' },
  ]
}

function makeOperation(id: string, toolRef: string, name = `Op ${id}`): Operation {
  return {
    id,
    name,
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
 * A rotary bar project with `operationIds` in one Top or Bottom setup. A bar's
 * Top/Bottom program is the manual-index program the restart rules are about:
 * its own opening turn names the face, so its retracts are in machine
 * coordinates.
 */
function barProject(
  shape: 'round' | 'square',
  face: 'top' | 'bottom',
  operationIds: readonly string[] = ['rough', 'finish'],
): Project {
  const base = newProject('Review Bar', 'mm')
  const bar = shape === 'round' ? roundStock(20, 100, 'x') : squareStock(20, 100, 'x')
  const bounds = getStockBounds(bar)
  const centre = (bounds.minY + bounds.maxY) / 2
  const project = syncProjectSetups({
    ...base,
    meta: { ...base.meta, projectType: 'rotary' },
    stock: bar,
    origin: { name: 'Origin', x: bounds.minX, y: centre, z: bar.thickness, visible: true },
    tools: tools(),
    operations: [
      makeOperation('rough', 't1'),
      makeOperation('finish', 't2'),
    ],
  })
  return face === 'top'
    ? project
    : withBottomSetup(project, { axis: 'x', operationIds: [...operationIds] })
}

function rotaryMachine(): MachineDefinition {
  return validateMachineDefinition({
    ...structuredClone(bundled('grbl')),
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

/** A pass that travels only along the bar, clear above (Top) or below (Bottom). */
function barMoves(face: 'top' | 'bottom'): ToolpathMove[] {
  const clearance = face === 'top' ? 25 : -5
  const cut = face === 'top' ? 15 : 5
  const at = (along: number, z: number): ToolpathPoint => ({ x: along, y: 10, z })
  return [
    { kind: 'rapid', from: at(0, clearance), to: at(10, clearance) },
    { kind: 'plunge', from: at(10, clearance), to: at(10, cut) },
    { kind: 'cut', from: at(10, cut), to: at(30, cut) },
    { kind: 'rapid', from: at(30, cut), to: at(30, clearance) },
  ]
}

/** One pass whose first move is a feed, so the start plane matters. */
const FEED_FIRST: ToolpathMove[] = [
  { kind: 'cut', from: { x: 50, y: 20, z: 15 }, to: { x: 60, y: 20, z: 15 } },
]

function post(
  project: Project,
  definition: MachineDefinition,
  operationIds: readonly string[],
  moves: ToolpathMove[],
  emitToolChanges = true,
): string {
  return runPostProcessor({
    project,
    definition,
    operations: operationIds.map((id) => {
      const operation = project.operations.find((entry) => entry.id === id)
      assert.ok(operation, `fixture: operation ${id}`)
      return {
        operation,
        tool: normalizeToolForProject(project.tools.find((tool) => tool.id === operation.toolRef)!, project),
        toolpath: { operationId: id, warnings: [], bounds: null, moves } as ToolpathResult,
      }
    }),
    options: { emitToolChanges, emitCoolant: false },
  }).gcode
}

/** The physical lines after the last occurrence of `marker`, line numbers removed. */
function linesAfter(program: string, marker: string): string[] {
  const at = program.lastIndexOf(marker)
  assert.ok(at >= 0, `fixture: ${JSON.stringify(marker)} is in the program\n${program}`)
  return program.slice(at + marker.length).split('\n')
    .map((line) => line.replace(/^N\d+\s+/, '').trim())
    .filter((line) => line.length > 0)
}

/** A program's code with every comment removed, as `lineCode` reads it. */
function codeOnly(program: string): string {
  return program.split('\n').map((line) => {
    let code = line.replace(/\([^)]*\)/g, ' ')
    const semicolon = code.indexOf(';')
    if (semicolon >= 0) code = code.slice(0, semicolon)
    return code
  }).join('\n')
}

// ── 1. Every string field is classified; command fields are exact ──

console.log('Testing every schema string field is classified...')

interface SchemaNode {
  type?: string | string[]
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  anyOf?: SchemaNode[]
  oneOf?: SchemaNode[]
  allOf?: SchemaNode[]
  $ref?: string
  $defs?: Record<string, SchemaNode>
}

function stringPaths(
  node: SchemaNode,
  path: string[],
  inArray: boolean,
  root: SchemaNode,
): string[] {
  // Zod may hoist a reused sub-schema into `$defs`; resolve it so a field it
  // contains cannot hide from this enumeration.
  if (node.$ref !== undefined) {
    const target = root.$defs?.[node.$ref.split('/').pop() ?? '']
    return target === undefined ? [] : stringPaths(target, path, inArray, root)
  }
  if (node.type === 'string' || (Array.isArray(node.type) && node.type.includes('string'))) {
    return [path.join('.') + (inArray ? '[]' : '')]
  }
  if (node.type === 'array') return stringPaths(node.items ?? {}, path, true, root)
  const paths: string[] = []
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    paths.push(...stringPaths(child, [...path, key], false, root))
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    for (const child of node[key] ?? []) paths.push(...stringPaths(child, path, inArray, root))
  }
  return paths
}

{
  const schema = z.toJSONSchema(MachineDefinitionSchema, {
    io: 'input',
    unrepresentable: 'any',
  }) as unknown as SchemaNode
  const schemaPaths = new Set(stringPaths(schema, [], false, schema))
  const classified = new Set(MACHINE_STRING_FIELDS.map(
    (field) => field.path.join('.') + (field.array ? '[]' : ''),
  ))
  for (const path of schemaPaths) {
    assert.ok(classified.has(path), `schema string field "${path}" has no class in MACHINE_STRING_FIELDS`)
  }
  for (const path of classified) {
    assert.ok(schemaPaths.has(path), `classification "${path}" names no schema string field`)
  }
  assert.ok(schemaPaths.size >= 40, `fixture: the schema has the expected fields (${schemaPaths.size})`)
}

console.log('Testing a single-word command field refuses an injected word...')

const commandCases: Array<{
  label: string
  machine: string
  path: readonly string[]
  valid: string
  invalid: string
  word: string
}> = [
  { label: 'rapid command', machine: 'grbl', path: ['motion', 'rapidCommand'], valid: 'G00', invalid: 'G0 X0', word: 'G0 X0' },
  { label: 'linear command', machine: 'grbl', path: ['motion', 'linearCommand'], valid: 'G1', invalid: 'G1\nG91', word: 'G91' },
  { label: 'clockwise arc command', machine: 'grbl', path: ['motion', 'cwArcCommand'], valid: 'G2', invalid: 'G2 X0', word: 'G2 X0' },
  { label: 'counter-clockwise arc command', machine: 'grbl', path: ['motion', 'ccwArcCommand'], valid: 'G3', invalid: 'G3 Z-1', word: 'G3 Z-1' },
  { label: 'feed command', machine: 'grbl', path: ['feedSpeed', 'feedCommand'], valid: 'F', invalid: 'F\nG91', word: 'G91' },
  { label: 'RPM command', machine: 'grbl', path: ['feedSpeed', 'rpmCommand'], valid: 'S', invalid: 'G91\nS', word: 'G91' },
  { label: 'RPM command with a value', machine: 'grbl', path: ['feedSpeed', 'rpmCommand'], valid: 'S', invalid: 'S12000', word: 'S12000' },
  { label: 'peck-step word', machine: 'mach3', path: ['cannedCycles', 'peckStepWord'], valid: 'Q', invalid: 'Q\nG0', word: 'G0' },
  {
    label: 'machine-coordinate rapid',
    machine: 'grbl',
    path: ['motion', 'machineCoordinateCommand'],
    valid: 'G53 G0',
    invalid: 'G53 G0 X0',
    word: 'G53 G0 X0',
  },
  {
    label: 'probe command',
    machine: 'grbl-plasma',
    path: ['plasma', 'touchOff', 'probeCommand'],
    valid: 'G38.2',
    invalid: 'G38.2\nG91',
    word: 'G91',
  },
  {
    label: 'set-zero command',
    machine: 'grbl-plasma',
    path: ['plasma', 'touchOff', 'setZeroCommand'],
    valid: 'G10 L20 P0',
    invalid: 'G10 L20 P0\nG0 X0',
    word: 'G0 X0',
  },
]

for (const testCase of commandCases) {
  const base = bundled(testCase.machine)
  assertAccepted(replacing(base, testCase.path, testCase.valid), `${testCase.label}: valid form`)
  assertRefused(
    replacing(base, testCase.path, testCase.invalid),
    testCase.path.join('.'),
    testCase.word,
    `${testCase.label}: injected word`,
  )
}

// ShopBot's command fields are commented in the bundled definition; that form
// is still accepted, and a second word still is not.
{
  const shopbot = bundled('shopbot')
  assertAccepted(replacing(shopbot, ['motion', 'rapidCommand'], "' G0"), 'ShopBot rapid form')
  assertRefused(replacing(shopbot, ['motion', 'rapidCommand'], "' G0 X0"), 'motion.rapidCommand', "' G0 X0", 'ShopBot with an axis')
}

// A blank RPM word is the bundled plasma case and stays legal.
assertAccepted(replacing(bundled('grbl-plasma'), ['feedSpeed', 'rpmCommand'], ''), 'blank RPM')
assertAccepted(replacing(bundled('grbl'), ['feedSpeed', 'rpmCommand'], 'S'), 'RPM prefix')

// ── 2. An assignment does not hide the rest of the line ───────

console.log('Testing a header assignment does not hide trailing words...')

{
  const grbl = bundled('grbl')
  const header = (line: string): unknown => replacing(grbl, ['program', 'header'], [line])
  assertAccepted(header('#<holes> = 1'), 'a bare assignment')
  assertAccepted(header('#1=1'), 'a bare numeric assignment')
  assertRefused(header('#1=1 G0Z-2'), 'program.header[0]', 'G0', 'compact motion after an assignment')
  assertRefused(header('#1=1 g91'), 'program.header[0]', 'G91', 'lower-case mode after an assignment')
  assertRefused(header('#<x> = 1 G0Z-2'), 'program.header[0]', 'G0', 'named assignment then motion')
  assertRefused(header('#1=1 X0'), 'program.header[0]', 'X0', 'assignment then an axis word')
  // A bare `%`, modal setup and a non-moving M code are still header words.
  assertAccepted(header('G90 G17 G40 G49 G80 G94 M52 P1'), 'modal header')
}

// ── 3. Operator text lives in comments only ───────────────────

console.log('Testing operator text is refused outside a comment...')

{
  const grbl = bundled('grbl')
  const withHeader = (line: string): unknown => replacing(grbl, ['program', 'header'], [line])
  assertAccepted(withHeader('( {operationName} )'), 'operator text inside a parenthesised comment')
  assertAccepted(withHeader('; {toolName}'), 'operator text inside a semicolon comment')
  assertRefused(withHeader('F{operationName}'), 'program.header[0]', '{operationName}', 'operator text as code')
  assertRefused(withHeader('{programName} G0'), 'program.header[0]', '{programName}', 'operator text before code')

  assertAccepted(
    replacing(grbl, ['program', 'operationHeader'], ['; {operationName}']),
    'an operation header may name the operation in its comment',
  )
  assertRefused(
    replacing(grbl, ['program', 'operationHeader'], ['{operationName}']),
    'program.operationHeader[0]',
    '{operationName}',
    'an operation header may not emit the name as code',
  )

  assertRefused(
    replacing(grbl, ['toolChange', 'commands'], ['M6 T{operationName}']),
    'toolChange.commands[0]',
    '{operationName}',
    'even an anything template may not put operator text in code',
  )
  assertRefused(
    replacing(grbl, ['stop', 'programEndCommand'], '{toolName}'),
    'stop.programEndCommand',
    '{toolName}',
    'the program-end command is checked too',
  )
  assertRefused(
    replacing(grbl, ['program', 'header'], ['G90 {notAPlaceholder}']),
    'program.header[0]',
    '{notAPlaceholder}',
    'an unknown placeholder is refused',
  )
}

console.log('Testing the emitter sanitizes operator text for the comment syntax...')

{
  const project = newProject('Evil ) G91 ( name ; still one line', 'mm')
  project.stock = { ...project.stock, thickness: 20 }
  project.origin = { name: 'Origin', x: 0, y: 80, z: 20, visible: true }
  project.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Tool ) G91 ( 1' }]
  project.operations = [{
    ...makeOperation('op1', 't1', 'Op ) G91\nM5 ( name'),
    setupId: project.activeSetupId,
  }]
  const moves: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 0, y: 0, z: 25 }, to: { x: 10, y: 70, z: 25 } },
    { kind: 'cut', from: { x: 10, y: 70, z: 15 }, to: { x: 30, y: 70, z: 15 } },
  ]
  for (const id of ['generic', 'grbl']) {
    const definition = bundled(id)
    const program = runPostProcessor({
      project,
      definition,
      operations: [{
        operation: project.operations[0],
        tool: normalizeToolForProject(project.tools[0], project),
        toolpath: { operationId: 'op1', warnings: [], bounds: null, moves } as ToolpathResult,
      }],
      options: { emitToolChanges: false, emitCoolant: false },
    }).gcode
    // The injected words are inside comments, so the code never carries them.
    assert.ok(!/\bG91\b/.test(codeOnly(program)), `${id}: the comment cannot close into code:\n${program}`)
    // A `( … )` dialect writes one well-formed comment per line, never a second
    // pair that would mean an escaped comment.
    if (id === 'generic') {
      const comments = program.split('\n').filter((line) => line.trimStart().startsWith('('))
      assert.ok(comments.length > 0, 'generic: the operator comments are written')
      for (const line of comments) {
        assert.equal((line.match(/\(/g) ?? []).length, 1, `generic: one opening marker: ${line}`)
        assert.equal((line.match(/\)/g) ?? []).length, 1, `generic: one closing marker: ${line}`)
      }
      assert.ok(program.includes('( Evil G91 name still one line )'), 'generic: the project name is sanitized')
      assert.ok(program.includes('( Operation 1: Op G91 M5 name )'), 'generic: the operation name is sanitized')
      assert.ok(program.includes('( Tool 1: Tool G91 1 )'), 'generic: the tool name is sanitized')
    } else {
      assert.ok(program.includes('; Evil G91 name still one line'), 'grbl: the project name is sanitized')
      assert.ok(program.includes('; Operation 1: Op G91 M5 name'), 'grbl: the operation name is sanitized')
    }
  }
}

// ── 4. Only the header and the tool-change/footer may change state ──

console.log('Testing state-changing words are refused inside the program...')

{
  const grblhal = bundled('grblhal')
  assert.ok(grblhal.coolant, 'fixture: grblhal has coolant')
  for (const word of ['G40', 'G49', 'G61', 'G64', 'G80', 'G97']) {
    assertRefused(
      replacing(grblhal, ['coolant', 'floodOnCommand'], `M8\n${word}`),
      'coolant.floodOnCommand',
      word,
      `${word} in a coolant template`,
    )
  }
  assertRefused(
    replacing(bundled('grbl'), ['feedSpeed', 'spindleOnCW'], 'M3 G49'),
    'feedSpeed.spindleOnCW',
    'G49',
    'G49 in a spindle-on template',
  )
  assertRefused(
    replacing(bundled('grbl'), ['program', 'operationHeader'], ['G80']),
    'program.operationHeader[0]',
    'G80',
    'G80 in an operation header',
  )
  // The header may still set them up, and the tool change and footer may still
  // do anything, because both are outside the running program's motion.
  assertAccepted(
    replacing(bundled('linuxcnc'), ['program', 'header'], ['G90 G17 G40 G49 G80 G94']),
    'G80/G49 in the program header',
  )
  assertAccepted(
    replacing(bundled('linuxcnc'), ['toolChange', 'commands'], ['M5', 'G49', 'G80']),
    'G80/G49 in a tool-change template',
  )
  assertAccepted(
    replacing(bundled('grblhal'), ['program', 'footer'], ['G49', 'G80']),
    'G80/G49 in the footer',
  )
}

// ── 5. After the opening turn the start is placed before any feed ──

console.log('Testing the opening turn is followed by the start XY before a feed...')

{
  const machine = rotaryMachine()
  const project = barProject('round', 'top', ['rough'])
  for (const emitToolChanges of [true, false]) {
    const program = post(project, machine, ['rough'], FEED_FIRST, emitToolChanges)
    const lines = program.split('\n')
    const turnAt = lines.findIndex((line) => line === 'G0 A0.000')
    assert.ok(turnAt > 0, `the opening turn is posted (tool changes ${emitToolChanges}):\n${program}`)
    const feedAt = lines.findIndex((line, index) => index > turnAt && /^G1\b/.test(line))
    assert.ok(feedAt > turnAt, `the feed follows the turn:\n${program}`)
    const placement = lines.slice(turnAt + 1, feedAt)
    assert.ok(
      placement.some((line) => /^X[-0-9.]+ Y[-0-9.]+$/.test(line)),
      `tool changes ${emitToolChanges}: the start XY is placed after the turn and before the feed: ${JSON.stringify(placement)}`,
    )
    assert.ok(
      placement.some((line) => /^Z[-0-9.]+$/.test(line)),
      `tool changes ${emitToolChanges}: the start plane is placed too: ${JSON.stringify(placement)}`,
    )
  }
}

// ── 7. A bar restart always uses the G53 machine retract ──────

console.log('Testing a square bar restart uses the G53 machine retract...')

{
  const project = barProject('square', 'top')
  const program = post(project, rotaryMachine(), ['rough', 'finish'], barMoves('top'))
  const after = linesAfter(program, 'M0 ; Tool change: Tool 2')
  while (after[0] === 'M0' || after[0] === 'M1') after.shift()
  assert.equal(after[0], 'G90 G94 G17', `the second restart restores the modes:\n${after.slice(0, 8).join('\n')}`)
  assert.equal(after[1], 'G21', 'then the units word')
  assert.equal(after[2], 'G53 G0 Z0.000', 'then the machine-coordinate retract, not the square travel height')
  assert.match(after[3] ?? '', /^G0 X[-0-9.]+ Y[-0-9.]+ A0\.000$/, 'then the placement')
  // The square travel height (11 + 10√2 in this fixture) never appears in the
  // restart: a work-coordinate height is not proof after a tool change.
  assert.ok(!after.slice(0, 5).some((line) => /^G0 Z5\.142$/.test(line)), 'no work-coordinate square retract in the restart')
}

// ── 6. A bar restart restates the setup angle ─────────────────

console.log('Testing a bar Top/Bottom restart restates the setup angle...')

{
  for (const face of ['top', 'bottom'] as const) {
    for (const shape of ['round', 'square'] as const) {
      const project = barProject(shape, face)
      const program = post(project, rotaryMachine(), ['rough', 'finish'], barMoves(face))
      const after = linesAfter(program, 'M0 ; Tool change: Tool 2')
      const angle = face === 'bottom' ? 180 : 0
      const angleLine = after.find((line) => line.includes(`A${angle.toFixed(3)}`))
      assert.ok(
        angleLine !== undefined,
        `${shape} ${face}: the second restart states A${angle}:\n${after.slice(0, 8).join('\n')}`,
      )
      // It is on the placement block, not left to the operation's path.
      assert.match(angleLine, /^G0 X[-0-9.]+ Y[-0-9.]+ A/, `${shape} ${face}: XY and the setup angle together (${angleLine})`)
    }
  }
}

console.log('gcode template review fix tests passed')
