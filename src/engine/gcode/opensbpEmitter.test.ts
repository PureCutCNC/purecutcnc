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
 * Tests for the ShopBot part-file emitter (issue #953) and the dialect
 * delegation in `runPostProcessor`.
 *
 * Assertions read the emitted text directly wherever they can, rather than
 * going through `parseSbpMotion`, so they test the file and not our model of
 * it. The round-trip tests are the exception: there the parser is the oracle.
 *
 * Run with: npx tsx src/engine/gcode/opensbpEmitter.test.ts
 */

import { circleProfile, defaultTool, newProject } from '../../types/project'
import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { replaceProjectFeatures } from '../../test/projectFixtures'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { generateDrillingToolpath } from '../toolpaths/drilling'
import type { ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { BUNDLED_DEFINITIONS } from './definitions'
import { runPostProcessor } from './postprocessor'
import { compareMotionTraces, parseExportedMotion } from './motionDebug'
import { parseSbpMotion } from './sbpMotionParser'
import { resolveOutputDialect, validateMachineDefinition } from './types'
import type { MachineDefinition, PostProcessorOptions, PostProcessorResult } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertLines(actual: string[], expected: string[], label: string): void {
  const limit = Math.max(actual.length, expected.length)
  for (let index = 0; index < limit; index++) {
    assert(
      actual[index] === expected[index],
      `${label}: line ${index + 1} is ${JSON.stringify(actual[index])}, expected ${JSON.stringify(expected[index])}`,
    )
  }
}

// ── Fixtures ──────────────────────────────────────────────────

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  if (!found) throw new Error(`Fixture error: no bundled definition "${id}"`)
  return validateMachineDefinition(structuredClone(found))
}

function shopbot(overrides?: Partial<MachineDefinition>): MachineDefinition {
  return validateMachineDefinition({ ...bundled('shopbot'), ...overrides })
}

function pt(x: number, y: number, z: number): ToolpathPoint {
  return { x, y, z }
}

/** A chain of moves from a starting point, so `from`/`to` always join up. */
function chain(start: ToolpathPoint, steps: Array<[ToolpathMove['kind'], ToolpathPoint, number?]>): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  let from = start
  for (const [kind, to, feedScale] of steps) {
    moves.push(feedScale === undefined ? { kind, from, to } : { kind, from, to, feedScale })
    from = to
  }
  return moves
}

/**
 * A project whose machine coordinates are easy to read off: with the origin at
 * the project origin, machine X = project X, machine Y = −project Y (project
 * space is Y-down) and machine Z = project Z.
 */
function makeProject(units: 'mm' | 'inch', toolCount = 1): Project {
  const project = newProject('Post Test', units)
  project.origin = { ...project.origin, x: 0, y: 0, z: 0 }
  project.tools = Array.from({ length: toolCount }, (_, index): Tool => ({
    ...defaultTool(units, index + 1),
    id: `t${index + 1}`,
    name: `Tool ${String.fromCharCode(65 + index)}`,
  }))
  return project
}

function makeOperation(id: string, toolRef: string, overrides?: Partial<Operation>): Operation {
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
    ...overrides,
  }
}

interface OperationSpec {
  toolRef?: string
  moves: ToolpathMove[]
  overrides?: Partial<Operation>
}

function run(args: {
  units?: 'mm' | 'inch'
  definition?: MachineDefinition
  operations: OperationSpec[]
  toolCount?: number
  options?: Partial<PostProcessorOptions>
}): PostProcessorResult & { lines: string[] } {
  const units = args.units ?? 'mm'
  const project = makeProject(units, args.toolCount ?? 1)
  const definition = args.definition ?? shopbot()
  const result = runPostProcessor({
    project,
    definition,
    operations: args.operations.map((spec, index) => {
      const toolRef = spec.toolRef ?? 't1'
      const toolRecord = project.tools.find((tool) => tool.id === toolRef)
      if (!toolRecord) throw new Error(`Fixture error: no tool "${toolRef}"`)
      const operation = makeOperation(`op${index + 1}`, toolRef, spec.overrides)
      const toolpath: ToolpathResult = { operationId: operation.id, warnings: [], bounds: null, moves: spec.moves }
      return { operation, tool: normalizeToolForProject(toolRecord, project), toolpath }
    }),
    options: { emitToolChanges: true, emitCoolant: false, ...args.options },
  })
  const lines = resolveOutputDialect(definition) === 'opensbp' ? programLines(result.gcode) : result.gcode.split('\n')
  return { ...result, lines }
}

/** The program's lines, asserting the CRLF contract on the way. */
function programLines(program: string): string[] {
  assert(program.endsWith('\r\n'), 'a part file ends with a line terminator')
  assert(!/[^\r]\n/.test(program) && !program.startsWith('\n'), 'every line ends in CRLF, never a bare LF')
  return program.slice(0, -2).split('\r\n')
}

function linesStarting(lines: string[], command: string): string[] {
  return lines.filter((line) => line.startsWith(`${command},`) || line === command)
}

/** rapid to (10,-5) at safe Z, plunge, two straight cuts. */
function simplePocketMoves(): ToolpathMove[] {
  return chain(pt(0, 0, 5), [
    ['rapid', pt(10, 5, 5)],
    ['plunge', pt(10, 5, -1)],
    ['cut', pt(20, 5, -1)],
    ['cut', pt(20, 15, -1)],
    ['rapid', pt(20, 15, 5)],
  ])
}

/**
 * `n` chords of a circle of radius `r` about (cx, cy) in project space at
 * constant Z, starting at angle 0. Project space is Y-down, so increasing
 * angle here is clockwise on the machine.
 */
function circleMoves(cx: number, cy: number, r: number, n: number, reverse = false): ToolpathMove[] {
  const points: ToolpathPoint[] = []
  for (let index = 0; index <= n; index++) {
    const angle = (Math.PI * 2 * (reverse ? -index : index)) / n
    points.push(pt(cx + r * Math.cos(angle), cy + r * Math.sin(angle), -1))
  }
  return chain(pt(points[0].x, points[0].y, 5), [
    ['plunge', points[0]],
    ...points.slice(1).map((point): [ToolpathMove['kind'], ToolpathPoint] => ['cut', point]),
  ])
}

/** `n` chords along part of a circle, from `startAngle` over `sweep` radians. */
function partialArcMoves(cx: number, cy: number, r: number, startAngle: number, sweep: number, n: number): ToolpathMove[] {
  const points: ToolpathPoint[] = []
  for (let index = 0; index <= n; index++) {
    const angle = startAngle + (sweep * index) / n
    points.push(pt(cx + r * Math.cos(angle), cy + r * Math.sin(angle), -1))
  }
  return chain(pt(0, 0, 5), [
    ['rapid', pt(points[0].x, points[0].y, 5)],
    ['plunge', points[0]],
    ...points.slice(1).map((point): [ToolpathMove['kind'], ToolpathPoint] => ['cut', point]),
  ])
}

/** The #447 span: a small-radius trochoid whose points sit off the output grid. */
function issue447Moves(): ToolpathMove[] {
  const xy: Array<[number, number]> = [
    [122.3941767939508, 167.17278330912177],
    [122.37556680190744, 167.10332987328752],
    [122.36930000002496, 167.0317],
    [122.36677898139465, 166.96007012671248],
    [122.37660115292522, 166.89061669087823],
    [122.3982010594255, 166.82545000000005],
    [122.43065538518721, 166.76655011100434],
    [122.4727110084653, 166.71570666721345],
    [122.52282307694827, 166.67446452093895],
    [122.57920194731366, 166.6440767939257],
    [122.63986756263506, 166.62546680188257],
    [122.7027096154099, 166.6192000000001],
    [122.76555166818474, 166.62546680188257],
    [122.82621728350614, 166.6440767939257],
    [122.88259615387153, 166.67446452093895],
  ]
  const points = xy.map(([x, y]) => pt(x, y, -1))
  return chain(pt(0, 0, 5), [
    ['rapid', pt(points[0].x, points[0].y, 5)],
    ['plunge', points[0]],
    ...points.slice(1).map((point): [ToolpathMove['kind'], ToolpathPoint] => ['cut', point]),
  ])
}

interface EmittedArc {
  line: string
  start: { x: number; y: number }
  end: { x: number; y: number }
  center: { x: number; y: number }
  /** The centre offsets as written. */
  offset: { i: number; j: number }
  direction: number
}

/**
 * Re-derive every arc from the emitted text alone: modal position from the
 * jog/move lines, centre from the previous emitted position plus the offsets.
 * Deliberately independent of `parseSbpMotion`.
 */
function emittedArcs(lines: string[]): EmittedArc[] {
  const arcs: EmittedArc[] = []
  let x = 0
  let y = 0
  for (const line of lines) {
    const fields = line.split(',')
    const number = (index: number): number => {
      const value = Number(fields[index])
      assert(fields[index] !== '' && Number.isFinite(value), `"${line}": field ${index} should be a number`)
      return value
    }
    switch (fields[0]) {
      case 'J2':
      case 'J3':
      case 'M3':
        x = number(1)
        y = number(2)
        break
      case 'CG': {
        assert(fields.length === 8, `"${line}" should have exactly 8 fields`)
        assert(fields[1] === '', `"${line}": the diameter field is left blank when a centre is given`)
        assert(fields[6] === 'T', `"${line}": arcs cut on the line (T), with no tool-radius offset`)
        const end = { x: number(2), y: number(3) }
        const offset = { i: number(4), j: number(5) }
        arcs.push({ line, start: { x, y }, end, center: { x: x + offset.i, y: y + offset.j }, offset, direction: number(7) })
        x = end.x
        y = end.y
        break
      }
    }
  }
  return arcs
}

// ── Dialect delegation ────────────────────────────────────────

function testDialectDefaultsToGcode(): void {
  console.log('Testing a definition without outputDialect is G-code and gains no key...')
  for (const definition of BUNDLED_DEFINITIONS) {
    const parsed = validateMachineDefinition(structuredClone(definition))
    if (definition.id === 'shopbot') {
      assert(resolveOutputDialect(parsed) === 'opensbp', 'the ShopBot definition exports SBP')
      continue
    }
    assert(resolveOutputDialect(parsed) === 'gcode', `${definition.id} should resolve to G-code`)
    // A saved project embeds the parsed definition: parsing must not add the
    // field, or every existing project would change on its next save.
    assert(!('outputDialect' in parsed), `${definition.id} must not gain an outputDialect key when parsed`)
  }
}

function testDelegationByDialect(): void {
  console.log('Testing runPostProcessor delegates on the dialect alone...')
  const moves = simplePocketMoves()
  const grbl = bundled('grbl')
  const asGcode = run({ definition: grbl, operations: [{ moves }] }).gcode
  assert(asGcode.includes('G1 ') && !asGcode.includes('M3,'), 'a G-code definition exports G-code')
  assert(!asGcode.includes('\r'), 'G-code output keeps its LF line endings')

  // An explicit 'gcode' is the same program as an absent field.
  const explicit = run({ definition: validateMachineDefinition({ ...grbl, outputDialect: 'gcode' }), operations: [{ moves }] }).gcode
  assert(explicit === asGcode, 'outputDialect "gcode" must not change the program')

  // The dialect — not the definition's id, name or extension — selects SBP.
  const grblAsSbp = run({
    definition: validateMachineDefinition({ ...grbl, outputDialect: 'opensbp' }),
    operations: [{ moves }],
  }).lines
  const shopbotLines = run({ operations: [{ moves }] }).lines
  assertLines(grblAsSbp, shopbotLines, 'the same dialect and number format give the same program')
}

// ── Program structure ─────────────────────────────────────────

function testProgramStructure(): void {
  console.log('Testing the full program: header, units guard, speeds, motion, footer...')
  const { lines, stats, warnings } = run({
    operations: [{ moves: simplePocketMoves(), overrides: { name: 'Boss Pocket', description: 'Clear the boss\nLeave the tabs' } }],
    options: { programName: 'Bracket' },
  })
  const dateLine = lines[1]
  assert(/^' Generated by PureCutCNC on \d{4}-\d{2}-\d{2}$/.test(dateLine), `unexpected date line: ${dateLine}`)
  assertLines(lines, [
    "' Bracket",
    dateLine,
    "' ShopBot part file, units: mm",
    'IF %(25)=0 THEN GOTO UNIT_ERROR',
    'SA',
    "'",
    "' Operation 1: Boss Pocket",
    "' Description: Clear the boss",
    "' Description: Leave the tabs",
    "' Tool 1: Tool A",
    '&Tool=1',
    'C9',
    'TR,12000',
    'C6',
    // The first rapid starts from an unknown position: Z, then XY.
    'JZ,5.000',
    'J2,10.000,-5.000',
    // 600 mm/min and 180 mm/min, in mm per second.
    'MS,10.000,3.000',
    'M3,10.000,-5.000,-1.000',
    'M3,20.000,-5.000,-1.000',
    'M3,20.000,-15.000,-1.000',
    'JZ,5.000',
    'C7',
    'END',
    "'",
    'UNIT_ERROR:',
    'MSGBOX(This part file is in mm but the control software is set to inches. Nothing was cut.,16,Wrong units)',
    'END',
  ], 'program')
  assert(warnings.length === 0, `expected no warnings, got ${JSON.stringify(warnings)}`)
  assert(stats.lineCount === lines.length, 'lineCount counts every physical line')
  assert(stats.moveCount === 6, `moveCount counts jogs, moves and arcs only, got ${stats.moveCount}`)
  assert(stats.operationCount === 1, 'operationCount')

  // Nothing but SBP: no G-code words, no line numbers.
  for (const line of lines) {
    assert(!/^N\d/.test(line) && !/^[GM]\d+(\s|$)/.test(line), `"${line}" looks like G-code`)
  }
}

function testEmptyDescriptionAndCommentSafety(): void {
  console.log('Testing comments stay on one line and an empty description is skipped...')
  const { lines } = run({
    operations: [{ moves: simplePocketMoves(), overrides: { name: 'Edge\r\nM3,0,0,-50', description: '' } }],
  })
  assert(!lines.some((line) => line.includes('Description:')), 'an empty description writes no line')
  assert(lines.includes("' Operation 1: Edge M3,0,0,-50"), 'a line break in a name must not start a new line')
  assert(!lines.includes('M3,0,0,-50'), 'operation text must never become a command')
}

function testUnitsGuard(): void {
  console.log('Testing the units guard refuses the other unit system...')
  const mm = run({ units: 'mm', operations: [{ moves: simplePocketMoves() }] }).lines
  const inch = run({ units: 'inch', operations: [{ moves: simplePocketMoves() }] }).lines

  // %(25) is 0 for inches and 1 for millimetres: each program jumps away on
  // the value it must not run under.
  assert(mm.includes('IF %(25)=0 THEN GOTO UNIT_ERROR'), 'a mm program refuses a control set to inches')
  assert(inch.includes('IF %(25)=1 THEN GOTO UNIT_ERROR'), 'an inch program refuses a control set to mm')

  for (const [label, lines] of [['mm', mm], ['inch', inch]] as const) {
    const guard = lines.findIndex((line) => line.startsWith('IF %(25)='))
    const firstCommand = lines.findIndex((line) => !line.startsWith("'"))
    assert(guard === firstCommand, `${label}: the guard is the first command, before anything can move`)

    // The error block is unreachable except through the guard.
    const programEnd = lines.indexOf('END')
    const label_ = lines.indexOf('UNIT_ERROR:')
    assert(programEnd > 0 && label_ > programEnd, `${label}: the UNIT_ERROR block sits after the program's END`)
    assert(lines[label_ + 1].startsWith('MSGBOX('), `${label}: the label is followed by a message box`)
    assert(lines[label_ + 2] === 'END' && lines.length === label_ + 3, `${label}: the error block ends the file`)
    // MSGBOX(body, button type, title): a comma inside the body would split it.
    assert(lines[label_ + 1].split(',').length === 3, `${label}: the message body must not contain a comma`)
    assert(
      lines.slice(programEnd + 1).every((line) => !/^(J|M\d|M[XYZ]|CG)/.test(line)),
      `${label}: nothing after END may move the tool`,
    )
  }
  assert(inch[inch.indexOf('UNIT_ERROR:') + 1].includes('is in inches but the control software is set to mm'),
    'the inch message names the units the right way round')
}

// ── Speeds ────────────────────────────────────────────────────

function testSpeedsAreUnitsPerSecond(): void {
  console.log('Testing feeds per minute become speeds per second, in mm and inch...')
  const mm = run({
    units: 'mm',
    operations: [{ moves: simplePocketMoves(), overrides: { feed: 1500, plungeFeed: 400 } }],
  }).lines
  assertLines(linesStarting(mm, 'MS'), ['MS,25.000,6.667'], 'mm speeds')

  const inch = run({
    units: 'inch',
    operations: [{ moves: simplePocketMoves(), overrides: { feed: 90, plungeFeed: 25 } }],
  }).lines
  assertLines(linesStarting(inch, 'MS'), ['MS,1.5000,0.4167'], 'inch speeds')
  assert(inch.includes('M3,10.0000,-5.0000,-1.0000'), 'inch coordinates use the inch precision')
}

function testSpeedFallsBackToToolDefaults(): void {
  console.log('Testing an operation without its own feeds uses the tool defaults...')
  const project = makeProject('mm')
  const tool = normalizeToolForProject(project.tools[0], project)
  const { lines } = run({ operations: [{ moves: simplePocketMoves(), overrides: { feed: 0, plungeFeed: 0, rpm: 0 } }] })
  const expected = `MS,${(tool.defaultFeed / 60).toFixed(3)},${(tool.defaultPlungeFeed / 60).toFixed(3)}`
  assertLines(linesStarting(lines, 'MS'), [expected], 'tool default speeds')
  assert(lines.includes(`TR,${Math.round(tool.defaultRpm)}`), 'the spindle speed falls back to the tool default')
}

function testSpeedOnlyWhenChanged(): void {
  console.log('Testing MS is written only when a speed changes...')
  // Two plunge/cut cycles at one feed: one MS for the whole operation.
  const steady = run({
    operations: [{
      moves: chain(pt(0, 0, 5), [
        ['rapid', pt(10, 5, 5)],
        ['plunge', pt(10, 5, -1)],
        ['cut', pt(20, 5, -1)],
        ['cut', pt(20, 15, -1)],
        ['plunge', pt(20, 15, -2)],
        ['cut', pt(10, 15, -2)],
        ['cut', pt(10, 5, -2)],
      ]),
    }],
  }).lines
  assertLines(linesStarting(steady, 'MS'), ['MS,10.000,3.000'], 'steady feed')

  // A slowed cut (feedScale 0.5) between two full-feed cuts: down, then back.
  const scaled = run({
    operations: [{
      moves: chain(pt(0, 0, 5), [
        ['rapid', pt(10, 5, 5)],
        ['plunge', pt(10, 5, -1)],
        ['cut', pt(20, 5, -1)],
        ['cut', pt(30, 5, -1), 0.5],
        ['cut', pt(40, 5, -1), 0.5],
        ['cut', pt(50, 5, -1)],
      ]),
    }],
  }).lines
  const motion = scaled.filter((line) => line.startsWith('MS,') || line.startsWith('M3,'))
  assertLines(motion, [
    'MS,10.000,3.000',
    'M3,10.000,-5.000,-1.000',
    'M3,20.000,-5.000,-1.000',
    'MS,5.000,3.000',
    'M3,30.000,-5.000,-1.000',
    'M3,40.000,-5.000,-1.000',
    'MS,10.000,3.000',
    'M3,50.000,-5.000,-1.000',
  ], 'scaled feed')
}

function testSpeedPerAxis(): void {
  console.log('Testing XY speed follows the move feed and Z speed the plunge feed...')
  // A ramp is a plunge that also travels in XY: it must not run at the cut
  // feed, so the XY speed drops to the plunge feed and comes back afterwards.
  const ramp = run({
    operations: [{
      moves: chain(pt(0, 0, 5), [
        ['rapid', pt(10, 5, 5)],
        ['plunge', pt(10, 5, 0)],
        ['plunge', pt(20, 5, -1)],
        ['cut', pt(30, 5, -1)],
      ]),
    }],
  }).lines
  assertLines(ramp.filter((line) => line.startsWith('MS,') || line.startsWith('M3,')), [
    // A straight-down plunge sets no XY speed of its own: the pair starts at
    // the operation's cut and plunge feeds.
    'MS,10.000,3.000',
    'M3,10.000,-5.000,0.000',
    'MS,3.000,3.000',
    'M3,20.000,-5.000,-1.000',
    'MS,10.000,3.000',
    'M3,30.000,-5.000,-1.000',
  ], 'ramp')

  // A cut that also descends is held to the plunge feed on Z.
  const descendingCut = run({
    operations: [{
      moves: chain(pt(0, 0, 5), [
        ['rapid', pt(10, 5, 5)],
        ['plunge', pt(10, 5, 0)],
        ['cut', pt(20, 5, -1)],
      ]),
    }],
  }).lines
  assertLines(linesStarting(descendingCut, 'MS'), ['MS,10.000,3.000'], 'descending cut')

  // …and never above its own feed, even when the plunge feed is the higher one.
  const fastPlunge = run({
    operations: [{
      overrides: { feed: 600, plungeFeed: 900 },
      moves: chain(pt(0, 0, 5), [
        ['rapid', pt(10, 5, 5)],
        ['plunge', pt(10, 5, 0)],
        ['cut', pt(20, 5, -1)],
      ]),
    }],
  }).lines
  assertLines(linesStarting(fastPlunge, 'MS'), ['MS,10.000,15.000', 'MS,10.000,10.000'], 'plunge feed above cut feed')

  // A level cut slowed below the plunge feed does not travel in Z, so it
  // leaves the Z speed alone.
  const slowLevelCut = run({
    operations: [{
      moves: chain(pt(0, 0, 5), [
        ['rapid', pt(10, 5, 5)],
        ['plunge', pt(10, 5, -1)],
        ['cut', pt(20, 5, -1), 0.2],
      ]),
    }],
  }).lines
  assertLines(linesStarting(slowLevelCut, 'MS'), ['MS,10.000,3.000', 'MS,2.000,3.000'], 'level cut below the plunge feed')
}

// ── Arcs ──────────────────────────────────────────────────────

function testArcDirectionAndCenter(): void {
  console.log('Testing CG direction and centre offsets measured from the emitted start...')
  for (const reverse of [false, true]) {
    const { lines, warnings } = run({ operations: [{ moves: circleMoves(30, 40, 10, 72, reverse) }] })
    const arcs = emittedArcs(lines)
    // A full circle splits into sub-arcs of at most 90°.
    assert(arcs.length === 4, `expected 4 quarter arcs, got ${arcs.length}`)
    assert(warnings.length === 0, `expected no warnings, got ${JSON.stringify(warnings)}`)
    assert(!lines.some((line) => line.startsWith('M3,') && line.endsWith(',-1.000') && line !== 'M3,40.000,-40.000,-1.000'),
      'the circle is cut with arcs, not chords')

    for (const arc of arcs) {
      // Increasing angle in Y-down project space is clockwise on the machine.
      assert(arc.direction === (reverse ? -1 : 1), `"${arc.line}": direction should be ${reverse ? -1 : 1} (1 = clockwise)`)
      // Machine centre is (30, −40).
      assert(Math.abs(arc.center.x - 30) <= 0.0011 && Math.abs(arc.center.y + 40) <= 0.0011,
        `"${arc.line}": centre from the emitted start is ${arc.center.x},${arc.center.y}, expected 30,-40`)
      // The direction written has to be the way round the arc actually goes.
      const cross = (arc.start.x - arc.center.x) * (arc.end.y - arc.center.y)
        - (arc.start.y - arc.center.y) * (arc.end.x - arc.center.x)
      assert(Math.sign(cross) === (arc.direction === 1 ? -1 : 1),
        `"${arc.line}": a quarter arc from ${arc.start.x},${arc.start.y} turns the other way`)
    }
  }
}

/** How far apart an arc's start and end radii are, as the control software computes them. */
function radiusDisagreement(arc: EmittedArc, offset = arc.offset): number {
  const startRadius = Math.hypot(offset.i, offset.j)
  const endRadius = Math.hypot(arc.end.x - (arc.start.x + offset.i), arc.end.y - (arc.start.y + offset.j))
  return Math.abs(endRadius - startRadius)
}

function testArcCenterUsesEmittedStart(): void {
  console.log('Testing arc offsets are valid from the rounded position the control software holds...')
  const fixtures: Array<[string, 'mm' | 'inch', ToolpathMove[]]> = [
    ['#447 trochoid', 'mm', issue447Moves()],
    ['off-grid circle', 'mm', circleMoves(30.0004, 40.0007, 7.3331, 72)],
    ['partial arc', 'mm', partialArcMoves(30.0004, 40.0007, 4.3, 0.3, Math.PI * 0.3, 72)],
    ['off-grid circle', 'inch', circleMoves(3.00004, 4.00007, 0.73331, 72)],
    ['partial arc', 'inch', partialArcMoves(3.00004, 4.00007, 0.43, 0.3, Math.PI * 0.3, 72)],
  ]
  for (const [label, units, moves] of fixtures) {
    const { lines, warnings } = run({ units, operations: [{ moves }] })
    const arcs = emittedArcs(lines)
    assert(arcs.length > 0, `${label} (${units}): fixture must emit at least one arc to be meaningful`)
    assert(!warnings.some((warning) => warning.code === 'postArcFallbackLinear'),
      `${label} (${units}): span should export as arcs without falling back, got ${JSON.stringify(warnings)}`)

    const step = Math.pow(10, -(units === 'mm' ? 3 : 4))
    const mmPerUnit = units === 'mm' ? 1 : 25.4
    for (const arc of arcs) {
      const delta = radiusDisagreement(arc)
      const startRadius = Math.hypot(arc.offset.i, arc.offset.j)
      // The same budget the G-code path holds itself to (GRBL's arc check).
      assert(delta * mmPerUnit <= 0.005 || (delta * mmPerUnit <= 0.5 && delta <= 0.001 * startRadius),
        `${label} (${units}): "${arc.line}" from ${arc.start.x},${arc.start.y}: radius differs by ${(delta * mmPerUnit).toFixed(6)} mm between start and end`)

      // The offsets are chosen on the output grid to make the two radii agree
      // as seen from the position actually written on the previous line. Had
      // they been measured from the un-rounded start, or simply rounded, a
      // neighbouring grid point would agree better.
      for (const di of [-1, 0, 1]) {
        for (const dj of [-1, 0, 1]) {
          const neighbour = radiusDisagreement(arc, { i: arc.offset.i + di * step, j: arc.offset.j + dj * step })
          assert(delta <= neighbour + step * 1e-6,
            `${label} (${units}): "${arc.line}" from ${arc.start.x},${arc.start.y}: offsets ${di},${dj} grid steps away agree better (${neighbour} vs ${delta})`)
        }
      }
    }
  }
}

function testArcFallbackWritesLines(): void {
  console.log('Testing an arc run the formatted output cannot represent is written as its original moves...')
  // On a 0.1 mm output grid this span has no pair of offsets whose two radii
  // agree: the shared pipeline drops the fit and reports it.
  const moves = partialArcMoves(30.004, 40.007, 4.3, 0.3, Math.PI * 0.3, 72)
  const coarse = shopbot({ numberFormat: { ...shopbot().numberFormat, decimalPlaces: { mm: 1, inch: 4 } } })
  const fallen = run({ definition: coarse, operations: [{ moves }] })
  assert(fallen.warnings.filter((warning) => warning.code === 'postArcFallbackLinear').length === 1,
    `the dropped fit is reported, got ${JSON.stringify(fallen.warnings)}`)
  assert(linesStarting(fallen.lines, 'CG').length === 0, 'a rejected run leaves no arc behind')
  assert(linesStarting(fallen.lines, 'M3').length === 73, 'the plunge and every original chord are written')

  // The same span at the normal precision is one arc: the fixture is about
  // the fallback, not about a span that never fitted.
  const fitted = run({ operations: [{ moves }] })
  assert(linesStarting(fitted.lines, 'CG').length === 1 && fitted.warnings.length === 0, 'the span fits at 0.001 mm')
}

function testArcsRespectOperationAndMachine(): void {
  console.log('Testing arcs are skipped when the operation or the machine rules them out...')
  const moves = circleMoves(30, 40, 10, 72)

  const disabled = run({ operations: [{ moves, overrides: { arcFittingEnabled: false } }] })
  assert(linesStarting(disabled.lines, 'CG').length === 0, 'arc fitting off writes no CG')
  assert(linesStarting(disabled.lines, 'M3').length === 73, 'every chord is written as a move')
  assert(disabled.warnings.length === 0, 'turning arcs off is not a warning')

  const noArcs = run({
    definition: shopbot({ motion: { ...shopbot().motion, arcInterpolation: false } }),
    operations: [{ moves }],
  })
  assert(linesStarting(noArcs.lines, 'CG').length === 0, 'a machine without arcs writes no CG')
  assert(noArcs.warnings.some((warning) => warning.code === 'postArcNoCapability'),
    'arcs that were found but cannot be written are reported')
}

// ── Tool changes and spindle ──────────────────────────────────

function testToolChange(): void {
  console.log('Testing &Tool/C9 tool changes with the spindle stopped around them...')
  const { lines, warnings } = run({
    toolCount: 2,
    operations: [
      { toolRef: 't1', moves: simplePocketMoves() },
      { toolRef: 't2', moves: simplePocketMoves(), overrides: { rpm: 16000 } },
      { toolRef: 't2', moves: simplePocketMoves(), overrides: { rpm: 16000 } },
    ],
  })
  const control = lines.filter((line) => /^(&Tool=|C\d|TR,|MS,)/.test(line))
  assertLines(control, [
    '&Tool=1',
    'C9',
    'TR,12000',
    'C6',
    'MS,10.000,3.000',
    'C7',
    '&Tool=2',
    'C9',
    'TR,16000',
    'C6',
    // A tool-change macro may set speeds of its own: they are restated even
    // though this operation's are the same as the last one's.
    'MS,10.000,3.000',
    'C7',
  ], 'tool change')
  assert(warnings.length === 0, `expected no warnings, got ${JSON.stringify(warnings)}`)

  // The spindle is never running when C9 is called.
  let spindleOn = false
  for (const line of lines) {
    if (line === 'C6') spindleOn = true
    if (line === 'C7') spindleOn = false
    if (line === 'C9') assert(!spindleOn, 'C9 must not be called with the spindle running')
  }
  assert(lines.indexOf('END') === lines.lastIndexOf('C7') + 1, 'the spindle stops right before the program ends')
}

function testToolChangesDisabled(): void {
  console.log('Testing tool changes turned off are reported, not written...')
  const { lines, warnings } = run({
    toolCount: 2,
    options: { emitToolChanges: false },
    operations: [
      { toolRef: 't1', moves: simplePocketMoves() },
      { toolRef: 't2', moves: simplePocketMoves() },
    ],
  })
  assert(!lines.some((line) => line === 'C9' || line.startsWith('&Tool=')), 'no tool change is written')
  assert(linesStarting(lines, 'C6').length === 1 && linesStarting(lines, 'C7').length === 1, 'the spindle runs through')
  const reported = warnings.filter((warning) => warning.code === 'postToolChangesDisabled')
  assert(reported.length === 1, `the change that was not made is reported once, got ${JSON.stringify(warnings)}`)
}

function testCoolantIsReported(): void {
  console.log('Testing a coolant request is reported, never silently dropped...')
  const withCoolant = run({ operations: [{ moves: simplePocketMoves() }], options: { emitCoolant: true } })
  assert(withCoolant.warnings.some((warning) => warning.code === 'postNoCoolantCommands'), 'coolant request is reported')
  const without = run({ operations: [{ moves: simplePocketMoves() }] })
  assertLines(withCoolant.lines, without.lines, 'coolant changes no line')
}

// ── Drilling ──────────────────────────────────────────────────

function testDrillingIsExpanded(): void {
  console.log('Testing drilling is written as its expanded moves...')
  const project = makeProject('mm')
  const toolRecord: Tool = { ...project.tools[0], name: '3 mm Drill', type: 'drill', diameter: 3, defaultPlungeFeed: 150 }
  project.tools = [toolRecord]
  const hole: SketchFeature = {
    id: 'c1',
    name: 'Hole',
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProfile(20, 20, 5), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -6,
    visible: true,
    locked: false,
  }
  replaceProjectFeatures(project, [hole])
  const operation = makeOperation('op1', 't1', {
    kind: 'drilling',
    target: { source: 'features', featureIds: ['c1'] },
    stepdown: 2,
    drillType: 'peck',
    peckDepth: 2,
  })
  const toolpath = generateDrillingToolpath(project, operation)
  if (!toolpath.drillCycles || toolpath.drillCycles.length === 0) {
    throw new Error('Fixture error: drillCycles missing or empty')
  }
  const result = runPostProcessor({
    project,
    definition: shopbot(),
    operations: [{ operation, tool: normalizeToolForProject(toolRecord, project), toolpath }],
    options: { emitToolChanges: true, emitCoolant: false },
  })
  const lines = programLines(result.gcode)
  assert(!lines.some((line) => /G8\d|G73/.test(line)), 'no canned cycle reaches a part file')
  assert(!result.warnings.some((warning) => warning.code === 'postCannedCycleUnsupported'),
    'expanding a drill cycle is the normal path here, not a fallback to warn about')

  // The hole is drilled where the cycle says, to the depth the cycle says.
  const cycle = toolpath.drillCycles[0]
  const bottom = (cycle.bottomZ - project.origin.z).toFixed(3)
  const at = `${(cycle.x - project.origin.x).toFixed(3)},${(project.origin.y - cycle.y).toFixed(3)}`
  assert(lines.includes(`J2,${at}`), `the drill jogs over the hole at ${at}`)
  assert(lines.includes(`M3,${at},${bottom}`), `the drill reaches the bottom of the hole at Z ${bottom}`)
  const plunges = lines.filter((line) => line.startsWith(`M3,${at},`))
  assert(plunges.length >= 3, `a peck cycle is several plunges, got ${plunges.length}`)
  assertLines(linesStarting(lines, 'MS'), ['MS,10.000,3.000'], 'drilling speeds')

  const fedMoves = toolpath.moves.filter((move) => move.kind !== 'rapid').length
  assert(linesStarting(lines, 'M3').length === fedMoves, 'every fed move of the cycle is written')
}

// ── Round trip ────────────────────────────────────────────────

function mixedMoves(): ToolpathMove[] {
  const circle = circleMoves(30.0004, 40.0007, 7.3331, 72)
  const last = circle[circle.length - 1].to
  return [
    { kind: 'rapid', from: pt(0, 0, 5), to: pt(circle[0].from.x, circle[0].from.y, 5) },
    ...circle,
    ...chain(last, [
      ['cut', pt(55.12345, 40.0007, -1)],
      ['cut', pt(55.12345, 61.98765, -1)],
      ['rapid', pt(55.12345, 61.98765, 5)],
      ['rapid', pt(12.5, 12.5, 5)],
      ['plunge', pt(12.5, 12.5, -2.3333)],
      ['cut', pt(18.75, 12.5, -2.3333)],
      ['rapid', pt(18.75, 12.5, 5)],
    ]),
  ]
}

function testRoundTrip(): void {
  console.log('Testing the emitted program parses back to the machine-coordinate trace...')
  for (const units of ['mm', 'inch'] as const) {
    const result = run({
      units,
      operations: [{ moves: mixedMoves() }],
      options: { captureMotionTrace: true },
    })
    const trace = result.motionTraces?.[0]
    assert(!!trace, `${units}: a motion trace is captured`)
    if (!trace) return
    const parsed = parseSbpMotion(result.gcode)
    assert(parsed.status === 'verified', `${units}: the emitter writes nothing its own parser rejects: ${parsed.warnings.join('; ')}`)
    assert(parsed.moves.length === result.stats.moveCount,
      `${units}: one parsed move per counted motion line (${parsed.moves.length} vs ${result.stats.moveCount})`)

    // Output precision: a written coordinate is within half a grid step of
    // the machine coordinate it stands for.
    const halfStep = 0.5 * Math.pow(10, -(units === 'mm' ? 3 : 4))
    const tolerance = halfStep * 1.0001

    const fedParsed = parsed.moves.filter((move) => move.kind !== 'rapid')
    assert(trace.tryFit, `${units}: fixture should fit arcs`)
    const fedSource = trace.descriptors.filter((descriptor) => descriptor.kind === 'arc' || descriptor.moveKind !== 'rapid')
    assert(fedParsed.length === fedSource.length,
      `${units}: fed move count differs (${fedParsed.length} parsed, ${fedSource.length} planned)`)
    assert(fedSource.some((descriptor) => descriptor.kind === 'arc'), `${units}: fixture should contain arcs`)
    fedSource.forEach((descriptor, index) => {
      const got = fedParsed[index]
      const want = descriptor.kind === 'arc' ? descriptor.endPoint : descriptor.point
      assert(
        Math.abs(got.to.x - want.x) <= tolerance && Math.abs(got.to.y - want.y) <= tolerance && Math.abs(got.to.z - want.z) <= tolerance,
        `${units}: fed move ${index + 1} ends at ${got.to.x},${got.to.y},${got.to.z}, planned ${want.x},${want.y},${want.z}`,
      )
      assert(got.kind === (descriptor.kind === 'arc' ? 'arc' : 'linear'), `${units}: fed move ${index + 1} kind`)
      if (descriptor.kind === 'arc' && got.kind === 'arc') {
        assert(got.clockwise === descriptor.clockwise, `${units}: arc ${index + 1} direction`)
        const center = { x: descriptor.startPoint.x + descriptor.centerOffsets.i, y: descriptor.startPoint.y + descriptor.centerOffsets.j }
        // The centre is rebuilt from a rounded start and rounded offsets.
        assert(Math.hypot(got.center.x - center.x, got.center.y - center.y) <= 4 * tolerance,
          `${units}: arc ${index + 1} centre ${got.center.x},${got.center.y}, planned ${center.x},${center.y}`)
      }
    })

    // Rapids: every planned rapid's end point is reached by a jog.
    const rapidTargets = trace.descriptors.flatMap((descriptor) => (
      descriptor.kind === 'linear' && descriptor.moveKind === 'rapid' ? [descriptor.point] : []
    ))
    let cursor = 0
    for (const target of rapidTargets) {
      const index = parsed.moves.findIndex((move, moveIndex) => moveIndex >= cursor && move.kind === 'rapid'
        && Math.abs(move.to.x - target.x) <= tolerance && Math.abs(move.to.y - target.y) <= tolerance && Math.abs(move.to.z - target.z) <= tolerance)
      assert(index >= 0, `${units}: no jog reaches the planned rapid target ${target.x},${target.y},${target.z}`)
      cursor = index + 1
    }

    // And the debug view's own comparison agrees, through its dialect dispatch.
    const viaDispatch = parseExportedMotion(result.gcode, shopbot())
    assert(viaDispatch.moves.length === parsed.moves.length, `${units}: the debug view parses SBP for an SBP definition`)
    const diagnostic = compareMotionTraces(viaDispatch, trace, 4 * tolerance)
    assert(diagnostic.state === 'verified', `${units}: debug comparison: ${JSON.stringify(diagnostic.warnings)}`)
  }
}

function testSafeZSplitOfRapids(): void {
  console.log('Testing rapids use the shared safe-Z split: Z alone first, then XY...')
  const { lines } = run({
    operations: [{
      moves: chain(pt(0, 0, 5), [
        ['rapid', pt(10, 5, 5)],
        ['plunge', pt(10, 5, -1)],
        // One rapid that changes Z and XY together must not travel diagonally.
        ['rapid', pt(40, 25, 5)],
        ['rapid', pt(40, 25, 5)],
      ]),
    }],
  })
  const jogs = lines.filter((line) => line.startsWith('J'))
  assertLines(jogs, ['JZ,5.000', 'J2,10.000,-5.000', 'JZ,5.000', 'J2,40.000,-25.000'], 'jogs')
}

// ── Builds that predate the dialect ───────────────────────────

function testOlderBuildWritesNoMotion(): void {
  console.log('Testing a build that ignores outputDialect writes comments, not G-code...')
  // What such a build keeps of the definition: everything but the field it
  // does not know. It then takes the G-code path with these command words.
  const { outputDialect: _dropped, ...legacyView } = bundled('shopbot')
  const legacy = validateMachineDefinition(legacyView)
  assert(resolveOutputDialect(legacy) === 'gcode', 'fixture: the legacy view takes the G-code path')

  const program = run({
    definition: legacy,
    toolCount: 2,
    operations: [
      { toolRef: 't1', moves: mixedMoves() },
      { toolRef: 't2', moves: simplePocketMoves() },
    ],
  }).gcode
  const lines = program.split('\n')
  assert(lines.length > 20, 'fixture should produce a real program')
  for (const line of lines) {
    assert(line.startsWith("'") || line === 'END',
      `an older build would write "${line}" into a .sbp: every line must be a comment or END`)
  }
}

testDialectDefaultsToGcode()
testDelegationByDialect()
testProgramStructure()
testEmptyDescriptionAndCommentSafety()
testUnitsGuard()
testSpeedsAreUnitsPerSecond()
testSpeedFallsBackToToolDefaults()
testSpeedOnlyWhenChanged()
testSpeedPerAxis()
testArcDirectionAndCenter()
testArcCenterUsesEmittedStart()
testArcFallbackWritesLines()
testArcsRespectOperationAndMachine()
testToolChange()
testToolChangesDisabled()
testCoolantIsReported()
testDrillingIsExpanded()
testRoundTrip()
testSafeZSplitOfRapids()
testOlderBuildWritesNoMotion()

console.log('opensbp emitter tests passed')
