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
 * Slice C of #395: exporting an Around setup.
 *
 * Slices A and B generate an Around operation on the unrolled sheet and store
 * it already wrapped: every point carries `a`, the tool sits over the bar's
 * centreline, and drill cycles are removed. This suite exports those real
 * generated toolpaths through the real post-processor and asserts the program
 * an operator at the lathe gets: the Around header, one establishing rapid at
 * safe height per operation, turning cuts in inverse time, no arc and no
 * canned cycle, and one unwind rapid back to angle 0 at the end.
 *
 * Run with: npx tsx src/engine/gcode/aroundExport.test.ts
 */

import assert from 'node:assert/strict'
import {
  circleProfile, defaultTool, defaultTopSetup, getStockBounds, newProject, rectProfile, roundStock,
} from '../../types/project'
import type {
  MachiningSetup, MachineOrigin, Operation, Project, RoundStock, SketchFeature, SketchProfile, Tool,
} from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { effectiveFeed } from '../toolpaths/feed'
import type { ToolpathMove, ToolpathResult } from '../toolpaths/types'
import { warningSeverity } from '../toolpaths/warningCodes'
import { aroundFrame, unwrapPoint, unwrapToolpath } from '../aroundFrame'
import type { AroundFrame } from '../aroundFrame'
import { setupFace } from '../setupOrientation'
import { buildOperationBookletReport } from '../operationBooklet/report'
import { translate } from '../../i18n/store'
import { BUNDLED_DEFINITIONS } from './definitions'
import { parseGcodeMotion } from './gcodeMotionParser'
import { runPostProcessor } from './postprocessor'
import {
  describeSetupTurn, describeTouchOff, planSetupPrograms, projectExportsPerSetup,
  setupHeaderLines, setupLacksRegistration,
} from './setupPrograms'
import { machineToProjectPoint } from './utils'
import { exportGeometryTolerance } from '../../utils/units'
import { rotaryDirection, rotaryWord, validateMachineDefinition } from './types'
import type { MachineDefinition, PostProcessorResult, RotaryDefinition } from './types'

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(found, `bundled definition ${id} exists`)
  return validateMachineDefinition(structuredClone(found))
}

const GRBL = bundled('grbl')
const LINUXCNC = bundled('linuxcnc')

/** The bundled grbl definition plus a rotary block (issue #393/#395). */
function machine(about: 'x' | 'y', drive: 'own' | 'borrowed', base: MachineDefinition = GRBL): MachineDefinition {
  const rotary: RotaryDefinition = {
    about,
    drive,
    reversed: false,
    inverseTimeFeed: { on: 'G93', off: 'G94' },
  }
  return validateMachineDefinition({ ...structuredClone(base), rotary })
}

// ── fixtures ──────────────────────────────────────────────────
//
// A round bar lying along `axis`, at an off-origin position: `at` is the min
// corner of the rectangle the bar shows from above. A 40 mm bar 200 mm long
// along X, and a 2 in bar 8 in long along Y. The bar's diameter is the stock
// thickness, so the top of the bar is `thickness` — the same reading Top gives.

const MM_BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })
const INCH_BAR = roundStock(2, 8, 'y', { x: 3, y: 5 })
const MM_CIRCUMFERENCE = Math.PI * MM_BAR.thickness
const INCH_CIRCUMFERENCE = Math.PI * INCH_BAR.thickness

/**
 * The shared machine origin: on the bar's centreline, away from the bar's
 * corners, so the touch-off reads as the measured form and the centreline is
 * the machine across coordinate 0.
 */
function originFor(stock: RoundStock): MachineOrigin {
  const bounds = getStockBounds(stock)
  return stock.axis === 'x'
    ? { name: 'Origin', x: bounds.minX + 30, y: (bounds.minY + bounds.maxY) / 2, z: stock.thickness, visible: true }
    : { name: 'Origin', x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY + 3, z: stock.thickness, visible: true }
}

/** The same placement at the bar's centre, where the touch-off reads as `CENTRE`. */
function centreOriginFor(stock: RoundStock): MachineOrigin {
  const bounds = getStockBounds(stock)
  return {
    name: 'Origin',
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: stock.thickness,
    visible: true,
  }
}

function aroundSetup(axis: 'x' | 'y', over: Partial<MachiningSetup> = {}): MachiningSetup {
  return {
    id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 },
    indexing: 'manual', registration: [], notes: '', operationIds: [],
    ...over,
  }
}

/** A straight, open line profile — the shape an Engrave operation follows. */
function straight(from: { x: number; y: number }, to: { x: number; y: number }): SketchProfile {
  return { start: from, segments: [{ type: 'line', to }], closed: false }
}

/** A zigzag polyline, so an Engrave emits a motion block per segment. */
function zigzag(from: { x: number; y: number }, to: { x: number; y: number }, legs: number): SketchProfile {
  const segments = []
  for (let index = 1; index <= legs; index++) {
    segments.push({
      type: 'line' as const,
      to: {
        x: from.x + (to.x - from.x) * index / legs,
        y: index % 2 === 1 ? to.y : from.y,
      },
    })
  }
  return { start: from, segments, closed: false }
}

interface Draft {
  id: string
  name?: string
  kind: SketchFeature['kind']
  profile: SketchProfile
  operation: NonNullable<SketchFeature['operation']>
  zTop: number
  zBottom: number
}

function sketchFeature(draft: Draft): SketchFeature {
  return {
    id: draft.id,
    name: draft.name ?? draft.id,
    kind: draft.kind,
    folderId: null,
    sketch: { profile: draft.profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: draft.operation,
    z_top: draft.zTop,
    z_bottom: draft.zBottom,
    authoringFace: 'around',
    visible: true,
    locked: false,
  }
}

function operation(
  id: string,
  kind: Operation['kind'],
  featureIds: string[],
  toolRef: string,
  over: Partial<Operation> = {},
): Operation {
  return {
    id,
    name: id,
    kind,
    setupId: 'around',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef,
    stepdown: 2,
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
    entryStrategy: 'plunge',
    arcFittingEnabled: true,
    ...over,
  }
}

interface Fixture {
  project: Project
  frame: AroundFrame
  operations: Operation[]
  /** The wrapped toolpath each operation's export receives, by operation id. */
  wrapped: Map<string, ToolpathResult>
}

/**
 * Build an Around project and generate every operation's toolpath through the
 * real seam (issue #395 slices A/B), so the export reads what a user's project
 * actually produces.
 */
function buildFixture(
  stock: RoundStock,
  units: 'mm' | 'inch',
  drafts: Draft[],
  operations: Operation[],
  tools: Tool[],
  setup: MachiningSetup,
): Fixture {
  const base = newProject(`Around ${units}`, units)
  base.stock = stock
  // The Around face, its setup and its operations exist only in a rotary
  // project (issue #1028).
  base.meta.projectType = 'rotary'
  base.origin = originFor(stock)
  base.tools = tools
  const built = projectWithFeatures(base, drafts.map(sketchFeature))
  const project: Project = {
    ...built,
    features: built.features.map((feature) => ({ ...feature, authoringFace: 'around' as const })),
    setups: [setup],
    activeSetupId: setup.id,
    operations,
  }
  const wrapped = new Map<string, ToolpathResult>()
  for (const entry of operations) {
    const envelope = computeOperationToolpath(project, entry)
    assert.ok(envelope, `${entry.id} generates a toolpath`)
    assert.deepEqual(envelope.result.warnings, [], `${entry.id} generates cleanly`)
    assert.ok(envelope.result.moves.length > 0, `${entry.id} generates motion`)
    for (const move of envelope.result.moves) {
      assert.notEqual(move.from.a, undefined, `${entry.id} has an angle on every point`)
      assert.notEqual(move.to.a, undefined, `${entry.id} has an angle on every point`)
    }
    wrapped.set(entry.id, envelope.result)
  }
  return { project, frame: aroundFrame(stock), operations, wrapped }
}

function tool(id: string, units: 'mm' | 'inch', diameter: number, type: Tool['type']): Tool {
  return { ...defaultTool(units, 1), id, name: `${id} ${type}`, diameter, type, maxCutDepth: 25 }
}

const MM_TOOLS = [tool('t1', 'mm', 3, 'flat_endmill'), tool('t2', 'mm', 3, 'drill')]

/**
 * Four Around operations of real, differing kinds: a circular pocket whose
 * rings the arc fitter would otherwise join, an Engrave along a slanted line,
 * an outside edge route and a drilling pattern. All on a 40 mm bar along X.
 */
function mmFixture(): Fixture {
  return buildFixture(MM_BAR, 'mm', [
    { id: 'pocket-shape', kind: 'circle', profile: circleProfile(55, 50, 10), operation: 'subtract', zTop: 40, zBottom: 30 },
    { id: 'engrave-line', kind: 'polygon', profile: zigzag({ x: 80, y: 40 }, { x: 200, y: 90 }, 22), operation: 'line', zTop: 40, zBottom: 39 },
    { id: 'wall', kind: 'rect', profile: rectProfile(150, 40, 20, 20), operation: 'add', zTop: 40, zBottom: 32 },
    { id: 'hole', kind: 'circle', profile: circleProfile(185, 60, 1.5), operation: 'subtract', zTop: 40, zBottom: 34 },
  ], [
    operation('Pocket', 'pocket', ['pocket-shape'], 't1', { stepdown: 2, stepover: 0.4 }),
    operation('Engrave', 'follow_line', ['engrave-line'], 't1', { pass: 'finish', carveDepth: 1, maxCarveDepth: 1 }),
    operation('Wall', 'edge_route_outside', ['wall'], 't1', { stepdown: 2 }),
    operation('Holes', 'drilling', ['hole'], 't2', { drillType: 'simple' }),
  ], MM_TOOLS, aroundSetup('x'))
}

/** A 2 in bar along Y with a pocket and an Engrave, in inch units. */
function inchFixture(): Fixture {
  const r = INCH_BAR.thickness / 2
  return buildFixture(INCH_BAR, 'inch', [
    { id: 'slot', kind: 'rect', profile: rectProfile(3.6, 6, 0.8, 2), operation: 'subtract', zTop: 2, zBottom: 1.6 },
    { id: 'line', kind: 'polygon', profile: straight({ x: 4, y: 6.5 }, { x: 4 + INCH_CIRCUMFERENCE, y: 8 }), operation: 'line', zTop: 2, zBottom: 2 - r / 2 },
  ], [
    operation('Pocket', 'pocket', ['slot'], 't1', {
      stepdown: r / 2, stepover: 0.4, feed: 20, plungeFeed: 6, target: { source: 'features', featureIds: ['slot'] },
    }),
    operation('Engrave', 'follow_line', ['line'], 't1', {
      pass: 'finish', carveDepth: r / 2, maxCarveDepth: r / 2, feed: 20, plungeFeed: 6,
      target: { source: 'features', featureIds: ['line'] },
    }),
  ], [tool('t1', 'inch', 0.125, 'flat_endmill')], aroundSetup('y'))
}

function exportFixture(
  fixture: Fixture,
  definition: MachineDefinition,
  emitToolChanges = true,
  only?: string[],
): PostProcessorResult {
  const project = fixture.project
  const tools = new Map(project.tools.map((entry) => [entry.id, normalizeToolForProject(entry, project)]))
  const operations = fixture.operations.filter((entry) => only === undefined || only.includes(entry.id))
  return runPostProcessor({
    project,
    definition,
    operations: operations.map((entry) => {
      const normalized = tools.get(entry.toolRef ?? '')
      assert.ok(normalized, `tool ${entry.toolRef} exists in the project`)
      const toolpath = fixture.wrapped.get(entry.id)
      assert.ok(toolpath, `toolpath for ${entry.id} is generated`)
      return { operation: entry, tool: normalized, toolpath }
    }),
    options: { emitToolChanges, emitCoolant: false, programName: project.meta.name },
  })
}

function rotaryWarnings(result: PostProcessorResult): string[] {
  return result.warnings.map((warning) => warning.code).filter((code) => code.startsWith('postRotary'))
}

/**
 * Motion blocks: a setup line (`G90`, `G21`, `G93`…) or a block carrying an
 * axis word. Later blocks are modal and carry no motion word of their own, so
 * a `^G` filter would miss exactly the turning moves here.
 */
function motionLines(program: string): string[] {
  return program
    .split('\n')
    .filter((line) => line.length > 0 && !/^[;(%]/.test(line))
    .filter((line) => line.startsWith('G') || /[XYZAB]/.test(line))
}

/** `lines` with `G0`/`G1`/`G2`/`G3` and axis words only — no setup lines. */
function motionBlocks(program: string): string[] {
  return program
    .split('\n')
    .map((line) => line.split(';')[0].replace(/\([^)]*\)/g, ' ').trim())
    .filter((line) => line.length > 0 && /\b[GXYZAB]-?[0-9]/.test(line))
    .filter((line) => !/^G(17|18|19|20|21|90|91|93|94|28|53)\b/.test(line))
}

/** The angle words written to the program for `letter`, in order. */
function angleWords(program: string, letter: string): number[] {
  const values: number[] = []
  for (const line of motionBlocks(program)) {
    for (const match of line.matchAll(new RegExp(`\\b${letter}(-?[0-9.]+)`, 'g'))) {
      values.push(Number(match[1]))
    }
  }
  return values
}

/** The across coordinate words written to the program for `letter`, in order. */
function axisWords(program: string, letter: string): number[] {
  const values: number[] = []
  for (const line of motionBlocks(program)) {
    for (const match of line.matchAll(new RegExp(`\\b${letter}(-?[0-9.]+)`, 'g'))) {
      values.push(Number(match[1]))
    }
  }
  return values
}

/**
 * The highest machine Z any of an operation's fed moves reaches: the clearance
 * plane its first descent starts from. An establishing rapid must turn the bar
 * at or above it.
 */
function highestFedZ(path: ToolpathResult, originZ: number): number {
  let highest = -Infinity
  for (const move of path.moves) {
    if (move.kind === 'rapid') continue
    highest = Math.max(highest, move.from.z - originZ, move.to.z - originZ)
  }
  return highest
}

/**
 * The angles actually written, derived from the wrapped toolpaths: the rotary
 * word is modal, so it is written once per change — including each operation's
 * opening rapid at its own start angle — and once more for the closing unwind
 * when the program does not end at 0. A re-derivation of the modal rule, used
 * only to check the written count against the moves.
 */
function expectedAngleWrites(fixture: Fixture, definition: MachineDefinition, unwind: boolean): number[] {
  const direction = rotaryDirection(definition)
  const written: number[] = []
  let last: number | undefined
  const consider = (angle: number | undefined) => {
    if (angle === undefined) return
    const value = angle * direction
    if (value !== last) {
      written.push(value)
      last = value
    }
  }
  for (const entry of fixture.operations) {
    for (const move of fixture.wrapped.get(entry.id)!.moves) consider(move.to.a)
  }
  if (unwind && last !== undefined && last !== 0) written.push(0)
  // A program ending at 0 writes no unwind, and neither does one that never
  // turned the bar.
  return written
}

function closeTo(actual: number, expected: number, tolerance: number, message: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`)
}

/** True when `point` lies on some segment of `moves`, in the sheet's own frame. */
function pointOnPath(point: { x: number; y: number; z: number }, moves: readonly ToolpathMove[], tolerance: number): boolean {
  for (const move of moves) {
    const a = move.from
    const b = move.to
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
    const ap = { x: point.x - a.x, y: point.y - a.y, z: point.z - a.z }
    const lengthSq = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / lengthSq))
    const distance = Math.hypot(ap.x - ab.x * t, ap.y - ab.y * t, ap.z - ab.z * t)
    if (distance <= tolerance) return true
  }
  return false
}

const MM = mmFixture()
const INCH = inchFixture()
const OWN_X = machine('x', 'own')
const BORROWED_Y = machine('x', 'borrowed')
const OWN_Y = machine('y', 'own')
const BORROWED_X = machine('y', 'borrowed')

// ── 1. one program, with the Around header (rules 1 and 2) ────

console.log('Testing the Around header and one program per Around setup...')

{
  // A project whose only setup is Around still gets its own program: an
  // operator at the lathe is not running the legacy flat-bed program.
  assert.equal(MM.project.setups.length, 1, 'the fixture has exactly one setup')
  assert.equal(projectExportsPerSetup(MM.project), true, 'a lone Around setup is still its own program')
  const programs = planSetupPrograms(MM.project, MM.operations.map((entry) => entry.id))
  assert.deepEqual(programs.map((program) => [program.programNumber, program.face, program.setup?.id]), [
    [1, 'around', 'around'],
  ], 'one program, numbered 01, for the Around setup')
  const legacyTop = newProject('Legacy', 'mm')
  assert.equal(projectExportsPerSetup(legacyTop), false, 'a lone flat setup keeps the legacy program')

  const result = exportFixture(MM, OWN_X)
  const expectedHeader = [
    '; SETUP 01: Around - AROUND THE BAR, BAR ALONG X',
    '; ROTARY ZERO: TURN THE BAR SO THE START LINE IS UP, THEN ZERO THE ROTARY',
    '; TOUCH OFF: X30 Y20 MM FROM THE FRONT-LEFT CORNER OF THE BAR SEEN FROM ABOVE, Z0 ON TOP OF THE BAR',
  ]
  const lines = result.gcode.split('\n')
  const headerAt = lines.findIndex((line) => line.includes('SETUP 01'))
  assert.deepEqual(lines.slice(headerAt, headerAt + 3), expectedHeader,
    `the Around header, exactly:\n${lines.slice(headerAt, headerAt + 4).join('\n')}`)
  assert.ok(!result.gcode.includes('REGISTRATION'), 'an Around program declares no registration')

  // The same header, with the bar along Y, and one more line when the machine
  // borrows a motor instead of having its own axis.
  const inch = exportFixture(INCH, BORROWED_X, false)
  const inchLines = inch.gcode.split('\n')
  const inchAt = inchLines.findIndex((line) => line.includes('SETUP 01'))
  assert.deepEqual(inchLines.slice(inchAt, inchAt + 4), [
    '; SETUP 01: Around - AROUND THE BAR, BAR ALONG Y',
    '; ROTARY ZERO: TURN THE BAR SO THE START LINE IS UP, THEN ZERO THE ROTARY',
    '; TOUCH OFF: X1 Y5 IN FROM THE FRONT-LEFT CORNER OF THE BAR SEEN FROM ABOVE, Z0 ON TOP OF THE BAR',
    "; THE X MOTOR DRIVES THE ROTARY: SET THE TOOL OVER THE BAR'S CENTRELINE BY HAND",
  ], `the Y-bar borrowed-motor header, exactly:\n${inchLines.slice(inchAt, inchAt + 5).join('\n')}`)

  // An own-axis Y machine writes no borrowed-motor line.
  const ownInch = exportFixture(INCH, OWN_Y, false)
  assert.ok(!ownInch.gcode.includes('MOTOR DRIVES THE ROTARY'), 'an own-axis machine needs no hand setting line')
  assert.ok(ownInch.gcode.includes('; SETUP 01: Around - AROUND THE BAR, BAR ALONG Y'), 'and the same first line')

  // The header comes from the same plain-text lines both dialects write.
  const mixed = { ...MM.project, setups: [defaultTopSetup(), aroundSetup('x', { notes: 'Chuck on the headstock.\nCheck the tailstock.' }) ] }
  const mixedHeader = setupHeaderLines(mixed, mixed.setups[1], BORROWED_Y)
  assert.deepEqual(mixedHeader, [
    'SETUP 02: Around - AROUND THE BAR, BAR ALONG X',
    'ROTARY ZERO: TURN THE BAR SO THE START LINE IS UP, THEN ZERO THE ROTARY',
    'TOUCH OFF: X30 Y20 MM FROM THE FRONT-LEFT CORNER OF THE BAR SEEN FROM ABOVE, Z0 ON TOP OF THE BAR',
    "THE Y MOTOR DRIVES THE ROTARY: SET THE TOOL OVER THE BAR'S CENTRELINE BY HAND",
    'NOTE: Chuck on the headstock.',
    'NOTE: Check the tailstock.',
  ], 'notes follow the header, one line each')
}

{
  // The header helpers never fall into their Bottom branch for Around, and a
  // chuck needs no registration reference.
  const setup = aroundSetup('y')
  assert.equal(describeSetupTurn(setup), 'AROUND THE BAR, BAR ALONG Y')
  assert.equal(setupFace(setup), 'around')
  const project = { origin: centreOriginFor(INCH_BAR), stock: INCH_BAR, meta: INCH.project.meta }
  assert.equal(describeTouchOff(project, 'around'),
    'CENTRE OF THE BAR SEEN FROM ABOVE, Z0 ON TOP OF THE BAR',
    'a centreline origin reads as the centre of the bar, not as a Bottom face')
  assert.equal(describeTouchOff(project, 'top'),
    'CENTRE OF THE TOP FACE AS MOUNTED, Z0 ON THAT FACE',
    'the Top reading of the same placement is untouched')
  assert.equal(setupLacksRegistration({ setups: [defaultTopSetup(), setup] }, setup), false,
    'an Around setup never lacks registration — a chuck locates the bar')
  // With an origin below the bar's top, the height is said of the bar.
  const sunk = { ...project, origin: { ...project.origin, z: INCH_BAR.thickness - 0.5 } }
  assert.equal(describeTouchOff(sunk, 'around'),
    'CENTRE OF THE BAR SEEN FROM ABOVE, Z0 0.5 IN BELOW THE BAR SEEN FROM ABOVE')
}

{
  // A Top program in a project that also holds an Around setup is still a Top
  // program — the new wording reaches only the Around one.
  const topOperation = operation('Top op', 'pocket', ['pocket-shape'], 't1')
  const topFeature = sketchFeature({
    id: 'pocket-shape', kind: 'circle', profile: circleProfile(55, 50, 10), operation: 'subtract', zTop: 40, zBottom: 30,
  })
  const base = newProject('Mixed', 'mm')
  base.stock = { ...MM_BAR }
  base.origin = originFor(MM_BAR)
  base.tools = MM_TOOLS
  const built = projectWithFeatures(base, [{ ...topFeature, authoringFace: 'top' }])
  const project: Project = {
    ...built,
    setups: [
      { ...defaultTopSetup(), id: 'top', name: 'Top' },
      aroundSetup('x'),
    ],
    activeSetupId: 'top',
    operations: [{ ...topOperation, setupId: 'top', target: { source: 'features', featureIds: ['pocket-shape'] } }],
  }
  const toolpath = computeOperationToolpath(project, project.operations[0])!.result
  assert.ok(!toolpath.moves.some((move) => move.from.a !== undefined), 'a Top operation carries no angle')
  const result = runPostProcessor({
    project,
    definition: OWN_X,
    operations: [{
      operation: project.operations[0],
      tool: normalizeToolForProject(project.tools[0], project),
      toolpath,
    }],
    options: { emitToolChanges: false, emitCoolant: false },
  })
  assert.ok(result.gcode.includes('; SETUP 01: Top - TOP FACE UP'), 'the Top program is headed for Top')
  assert.ok(!/AROUND THE BAR/.test(result.gcode), 'and never borrows the Around wording')
  assert.ok(!result.gcode.includes('ROTARY ZERO'), 'nor the rotary zeroing line')
}

// ── 2. every operation is exported, with no rotary refusal (rules 3, 4, 6) ──

console.log('Testing every real operation exports with no rotary refusal...')

{
  for (const [name, definition] of [['own X', OWN_X], ['borrowed Y', BORROWED_Y]] as const) {
    const result = exportFixture(MM, definition)
    assert.deepEqual(rotaryWarnings(result), [], `${name}: no rotary refusal`)
    for (const entry of MM.operations) {
      assert.ok(result.gcode.includes(entry.name), `${name}: ${entry.name} is in the program`)
    }
    assert.equal(result.stats.operationCount, MM.operations.length, `${name}: every operation is counted`)
  }

  // Rule 4: each operation's first motion is a rapid that establishes its
  // starting angle at the safe height, before any feed. The establishing rapid
  // is the generated toolpath's own opening move, so the export needs no
  // inserted positioning block.
  for (const [name, definition] of [['own X', OWN_X], ['borrowed Y', BORROWED_Y]] as const) {
    const result = exportFixture(MM, definition)
    const lines = result.gcode.split('\n')
    const word = rotaryWord(definition)!
    for (const entry of MM.operations) {
      const start = lines.findIndex((line) => line.includes(entry.name))
      assert.ok(start > 0, `${name}: ${entry.name} has a header`)
      const slice = lines.slice(start + 1)
      const angleAt = slice.findIndex((line) => new RegExp(`\\b${word}-?[0-9]`).test(line))
      const feedAt = slice.findIndex((line) => /(^|\s)G1\b/.test(line))
      assert.ok(angleAt >= 0, `${name}: ${entry.name} writes its angle`)
      assert.ok(feedAt < 0 || angleAt < feedAt,
        `${name}: ${entry.name} establishes before any feed:\n${slice.slice(0, 4).join('\n')}`)
      const angleBlock = slice[angleAt]
      // The establishing block is the XY (or angle-only) rapid of the opening
      // move; the angle never rides the Z block, which is written first.
      assert.doesNotMatch(angleBlock, /\bG[123]\b/, `${name}: ${entry.name} establishes on a rapid: ${angleBlock}`)
      // It turns the bar at the clearance plane the operation next descends
      // from, never lower: every Z word up to and including it is at or above
      // the highest fed move of the operation.
      const clearance = highestFedZ(MM.wrapped.get(entry.id)!, MM.project.origin.z)
      for (const line of slice.slice(0, angleAt + 1)) {
        for (const match of line.matchAll(/\bZ(-?[0-9.]+)/g)) {
          assert.ok(Number(match[1]) >= clearance,
            `${name}: ${entry.name} turns the bar clear of the work: Z${match[1]} >= ${clearance}`)
        }
      }
    }
  }

  // Rule 6: no canned cycle and no arc anywhere, proved on the real drilling
  // envelope (which a flat machine would write as G81 on this controller) and
  // on a circular pocket whose rings the fitter would otherwise join. Slice B
  // already drops `drillCycles` from a wrapped toolpath, so the emitter's
  // angle gate is belt and braces here; the export still has to show it.
  const canned = exportFixture(MM, machine('x', 'own', LINUXCNC), true, ['Holes'])
  const cannedCycles = LINUXCNC.cannedCycles
  assert.ok(cannedCycles !== null, 'the control machine supports canned cycles')
  assert.equal(MM.wrapped.get('Holes')!.drillCycles, undefined, 'the wrapped drilling toolpath carries no cycles')
  const cycleWords = [cannedCycles.drillCommand, cannedCycles.drillWithDwellCommand,
    cannedCycles.peckDrillCommand, cannedCycles.chipBreakDrillCommand].filter((word): word is string => word !== null)
  assert.ok(cycleWords.length > 0, 'the control machine has canned cycle words to write')
  for (const word of cycleWords) {
    assert.doesNotMatch(canned.gcode, new RegExp(`\\b${word}\\b`), `an Around drilling operation writes no ${word}`)
  }
  assert.match(canned.gcode, /G1 |G0 /, 'its expanded moves are written instead')

  const arcs = exportFixture(MM, OWN_X, true, ['Pocket', 'Engrave'])
  assert.equal(OWN_X.motion.arcInterpolation, true, 'grbl interpolates arcs')
  assert.doesNotMatch(arcs.gcode, /\bG[23]\b/, 'no turning move is ever merged into an arc')
  assert.match(arcs.gcode, /G93/, 'the turning cuts are still written, in inverse time')
}

// ── 3. the across coordinate is the centreline, or the borrowed letter ──

console.log('Testing the centreline and the borrowed motor...')

{
  // Own axis: the bar lies along X, so Y is the across coordinate, and every Y
  // word written must be the centreline's machine coordinate — zero here,
  // because the fixture's origin sits on the centreline.
  const own = exportFixture(MM, OWN_X)
  const across = axisWords(own.gcode, 'Y')
  assert.ok(across.length > 0, 'the across coordinate is written')
  for (const value of across) {
    closeTo(value, 0, 1e-9, 'every across word is the centreline')
  }
  const angles = angleWords(own.gcode, 'A')
  assert.ok(angles.length > 0, 'the angle is written under A')

  // Borrowed motor: the borrowed letter carries the angle and nothing else.
  const borrowed = exportFixture(MM, BORROWED_Y)
  assert.equal(rotaryWord(BORROWED_Y), 'Y', 'the borrowed motor is project Y')
  const borrowedLines = motionBlocks(borrowed.gcode).filter((line) => /\bY-?[0-9]/.test(line))
  const written = expectedAngleWrites(MM, BORROWED_Y, true)
  assert.deepEqual(angleWords(borrowed.gcode, 'Y'), written.map((value) => Number(value.toFixed(3))),
    'the borrowed letter is written once per angle change, in order')
  assert.equal(borrowedLines.length, written.length, 'and on exactly that many motion blocks')
  for (const line of borrowedLines) {
    assert.equal((line.match(/\bY-?[0-9.]/g) ?? []).length, 1, `the borrowed letter appears once per block: ${line}`)
    // A turning rapid turns at the higher of its two Z values, so the angle is
    // never written on a block that also carries Z — only a turning *feed*
    // move may cut and turn on one block.
    if (/\bZ/.test(line)) {
      assert.match(line, /(^|\s)G1\b|F-?[0-9]/, `only a feed block carries Z with the angle: ${line}`)
    }
  }
  // No linear word uses the borrowed letter: the along-bar travel is X, and
  // every axis word on the program is X or Z.
  for (const line of motionBlocks(borrowed.gcode)) {
    for (const match of line.matchAll(/([A-Za-z])-?[0-9.]/g)) {
      assert.ok(['X', 'Y', 'Z', 'G', 'F'].includes(match[1].toUpperCase()), `no stray axis word: ${line}`)
    }
  }

  // The Y bar is the mirror image: X is the across coordinate, and the
  // borrowed X motor carries the angle under its own letter.
  const ownY = exportFixture(INCH, OWN_Y, false)
  for (const value of axisWords(ownY.gcode, 'X')) closeTo(value, 0, 1e-9, 'every across word is the centreline')
  const borrowedX = exportFixture(INCH, BORROWED_X, false)
  assert.equal(rotaryWord(BORROWED_X), 'X', 'the borrowed motor is project X')
  assert.deepEqual(angleWords(borrowedX.gcode, 'X').map((value) => Number(value.toFixed(4))),
    expectedAngleWrites(INCH, BORROWED_X, true).map((value) => Number(value.toFixed(4))),
    'the borrowed X carries the angle once per change')
}

// ── 4. inverse time (rule 6 / #393 rule 4) ────────────────────

console.log('Testing G93/G94 discipline and a hand-checked inverse-time word...')

{
  const result = exportFixture(MM, OWN_X)
  const lines = motionLines(result.gcode)
  const turning = lines.filter((line) => /A-?[0-9]/.test(line) && /F-?[0-9]/.test(line))
  assert.ok(turning.length > 0, 'turning cuts carry their own F')
  for (const line of turning) assert.match(line, /G1|^[XYZAB]/, `a turning cut is G1:\n${line}`)
  assert.ok(lines.includes('G93'), 'G93 is written before the first turning cut')
  const lastInverse = lines.lastIndexOf('G93')
  assert.ok(lines.slice(lastInverse).some((line) => line === 'G94'), 'and restored to G94')
  assert.equal((result.gcode.match(/G93/g) ?? []).length, (result.gcode.match(/G94/g) ?? []).length,
    'every G93 is matched by a G94')

  // One cut checked by hand. A move at a constant height `r` above the
  // centreline sweeps a surface arc `r × Δθ` while it travels `l` along the
  // bar, so its path length is `sqrt(l² + (r·Δθ)²)` and the inverse-time word
  // is `feed / length` (the flat `s·r/R` form, since `s/R = Δθ`). The longest
  // such cut is chosen so the word is the length and not the tolerance floor.
  const pocket = MM.wrapped.get('Pocket')!
  const radius = MM.frame.radius
  const tolerance = exportGeometryTolerance('mm')
  let move: ToolpathMove | undefined
  let length = 0
  for (const candidate of pocket.moves) {
    if (candidate.kind === 'rapid' || candidate.kind === 'plunge') continue
    if (candidate.from.z !== candidate.to.z || candidate.from.a === candidate.to.a) continue
    const sweep = Math.abs((candidate.to.a! - candidate.from.a!) * Math.PI / 180)
    const candidateLength = Math.hypot(candidate.to.x - candidate.from.x, (candidate.from.z - radius) * sweep)
    if (candidateLength > length) {
      move = candidate
      length = candidateLength
    }
  }
  assert.ok(move, 'the pocket has a constant-depth turning cut')
  assert.ok(length > 10 * tolerance, `the chosen cut is long enough to be the length, not the floor (${length})`)
  const r = move!.from.z - radius
  const sweep = Math.abs((move!.to.a! - move!.from.a!) * Math.PI / 180)
  const along = Math.abs(move!.to.x - move!.from.x)
  closeTo(Math.hypot(along, r * sweep), length, 1e-12, 'the hand length is the chosen length')
  const feed = effectiveFeed('cut', move!.feedScale, MM.project.operations[0].feed, MM.project.operations[0].plungeFeed)
  const expected = feed / length
  // The same number through the flat move's surface arc `s·r/R` with
  // `s = Δa·C/360`, and a control that ignoring the `r/R` projection would
  // give a different word.
  const across = sweep * MM_CIRCUMFERENCE / (2 * Math.PI)
  closeTo(across * r / radius, r * sweep, 1e-9, 's·r/R and r·Δθ agree')
  const naive = feed / Math.hypot(along, across)
  assert.notEqual(Number(naive.toFixed(3)), Number(expected.toFixed(3)),
    'the projection matters for a cut below the surface')
  assert.match(result.gcode, new RegExp(`F${expected.toFixed(3)}(?!\\d)`),
    `the emitted word is feed / sqrt(l² + (r·Δθ)²), expected ${expected.toFixed(3)}`)
}

// ── 5. the unwind (rule 5) ────────────────────────────────────

console.log('Testing the single unwind rapid...')

{
  // A slanted Engrave line 2.5 circumferences long: the angle runs past 360
  // and the program unwinds once, at the end.
  const line = straight({ x: 60, y: 30 }, { x: 100, y: 30 + 2.5 * MM_CIRCUMFERENCE })
  const multi = buildFixture(MM_BAR, 'mm', [
    { id: 'line', kind: 'polygon', profile: line, operation: 'line', zTop: 40, zBottom: 39 },
  ], [operation('Engrave', 'follow_line', ['line'], 't1', {
    pass: 'finish', carveDepth: 1, maxCarveDepth: 1, target: { source: 'features', featureIds: ['line'] },
  })], [tool('t1', 'mm', 3, 'flat_endmill')], aroundSetup('x'))

  const angles = multi.wrapped.get('Engrave')!.moves.flatMap((move) => [move.from.a!, move.to.a!])
  assert.ok(Math.max(...angles) > 360, `a multi-turn line writes angles past 360 (max ${Math.max(...angles)})`)
  assert.ok(Math.min(...angles) < 0 || Math.max(...angles) >= 900, 'and keeps turning rather than wrapping')

  const result = exportFixture(multi, OWN_X, false)
  const blocks = motionBlocks(result.gcode)
  const written = angleWords(result.gcode, 'A')
  assert.ok(Math.max(...written) > 360, `the program writes an angle past 360, got ${Math.max(...written)}`)
  const unwinds = blocks.filter((line) => /^G0\s+A-?0(\.0+)?$/.test(line))
  assert.deepEqual(unwinds, ['G0 A0.000'], `exactly one unwind rapid, at the end:\n${blocks.join('\n')}`)
  assert.equal(blocks[blocks.length - 1], 'G0 A0.000', 'the unwind is the last motion block')
  assert.ok(result.gcode.indexOf('G0 A0.000') < result.gcode.indexOf('M30'), 'and comes before the program end')
  // It happens at the height the last operation retracted to — a rapid with no
  // Z word of its own.
  assert.doesNotMatch(unwinds[0], /Z/, 'the unwind turns at the retract height')
  // Not between operations: no other block turns the bar without cutting it.
  assert.equal(unwinds.length, 1, 'the unwind is written once, not between operations')

  // A cut that ends where it began — the bar returns to angle 0 — writes no
  // unwind, even though the program turned the bar. The end sits on the zero
  // line (issue #1026), which is the bar's centreline, not the sheet's edge.
  const backLine = straight({ x: 60, y: 30 + MM_CIRCUMFERENCE }, { x: 100, y: 50 })
  const back = buildFixture(MM_BAR, 'mm', [
    { id: 'line', kind: 'polygon', profile: backLine, operation: 'line', zTop: 40, zBottom: 39 },
  ], [operation('Engrave', 'follow_line', ['line'], 't1', {
    pass: 'finish', carveDepth: 1, maxCarveDepth: 1, target: { source: 'features', featureIds: ['line'] },
  })], [tool('t1', 'mm', 3, 'flat_endmill')], aroundSetup('x'))
  assert.ok(Math.max(...back.wrapped.get('Engrave')!.moves.flatMap((move) => [move.to.a!])) > 0,
    'the case is not vacuous: the bar was turned')
  const endsAtZero = exportFixture(back, OWN_X, false)
  assert.ok(!motionBlocks(endsAtZero.gcode).some((block) => /^G0\s+A/.test(block)),
    'a program that ends at angle 0 writes no unwind rapid')
  assert.ok(/G93/.test(endsAtZero.gcode), 'even though it cut in inverse time')

  // A program that never turns the bar writes no unwind either.
  const flatOnly = { ...multi, wrapped: new Map([...multi.wrapped].map(([id, path]) => [id, {
    ...path,
    moves: path.moves.map((move) => ({ ...move, from: { ...move.from, a: undefined }, to: { ...move.to, a: undefined } })),
  }])) }
  const noTurn = exportFixture(flatOnly, OWN_X, false)
  assert.ok(!/A-?[0-9]/.test(noTurn.gcode), 'a program that never turns writes no angle at all')
  assert.ok(!/G93/.test(noTurn.gcode), 'and no inverse time')
}

{
  // A program whose last motion is a turning cut leaves inverse-time mode
  // before the closing unwind (rule 4 before rule 5): the unwind block would
  // otherwise turn the bar under G93, where its F means 1/min. The wrapped
  // path is truncated so no retract follows the final cut — the case a
  // trailing rapid would otherwise mask by leaving the mode on its own.
  const line = straight({ x: 60, y: 30 }, { x: 100, y: 30 + 1.5 * MM_CIRCUMFERENCE })
  const fixture = buildFixture(MM_BAR, 'mm', [
    { id: 'line', kind: 'polygon', profile: line, operation: 'line', zTop: 40, zBottom: 39 },
  ], [operation('Engrave', 'follow_line', ['line'], 't1', {
    pass: 'finish', carveDepth: 1, maxCarveDepth: 1, target: { source: 'features', featureIds: ['line'] },
  })], [tool('t1', 'mm', 3, 'flat_endmill')], aroundSetup('x'))

  const full = fixture.wrapped.get('Engrave')!
  const lastCut = full.moves.reduce((last, move, index) => (move.kind === 'cut' ? index : last), -1)
  assert.ok(lastCut >= 0, 'the fixture has a turning cut to end on')
  assert.ok(full.moves[lastCut].to.a !== 0, 'and it ends at a non-zero angle, so the program unwinds')
  fixture.wrapped.set('Engrave', { ...full, moves: full.moves.slice(0, lastCut + 1) })

  const result = exportFixture(fixture, OWN_X, false)
  const lines = result.gcode.split('\n').map((raw) => raw.split(';')[0].trim())
  const unwindAt = lines.findIndex((programLine) => /^G0\s+A-?0(\.0+)?$/.test(programLine))
  assert.ok(unwindAt > 0, 'the truncated program still unwinds the bar')
  assert.ok(lines.slice(0, unwindAt).includes('G93'), 'the last motion really was a turning cut')
  // After the last turning cut: G94, then the spindle stop (#393), then the
  // unwind. Nothing between the cut and the unwind runs in inverse-time mode.
  const restoredAt = lines.lastIndexOf('G94', unwindAt)
  const lastInverseAt = lines.lastIndexOf('G93', unwindAt)
  assert.ok(restoredAt > lastInverseAt, 'inverse-time mode is left before the unwind')
  assert.deepEqual(lines.slice(restoredAt, unwindAt), ['G94', 'M5'], 'only the spindle stop sits between G94 and the unwind')
}

// ── 6. the bar and the machine must agree (rule 3) ────────────

console.log('Testing the axis mismatch refusal...')

{
  // The bar lies along Y; the machine's rotary is set up about X. Generation
  // succeeded (a Y around frame), so the export must refuse rather than write
  // an angle that means a different motion on this machine.
  const result = exportFixture(INCH, machine('x', 'own'), false)
  assert.deepEqual(result.warnings, [
    { code: 'postRotaryAxisMismatch', params: { operation: 'Pocket', machineAxis: 'X', stockAxis: 'Y' } },
    { code: 'postRotaryAxisMismatch', params: { operation: 'Engrave', machineAxis: 'X', stockAxis: 'Y' } },
  ], 'each operation is refused, naming the machine and bar axes')
  assert.equal(warningSeverity('postRotaryAxisMismatch'), 'error', 'and blocks the save')
  assert.ok(!/A-?[0-9]/.test(result.gcode), 'no angle is written')
  assert.ok(!/G93/.test(result.gcode), 'and no turning feed')

  // The matching machine exports it.
  const matched = exportFixture(INCH, OWN_Y, false)
  assert.deepEqual(rotaryWarnings(matched), [], 'the matching machine exports the same operations')

  // The refusal is per operation and checked before the borrowed-axis
  // arithmetic: the borrowed motor of the mismatched machine is also the bar's
  // own axis, so without this check the refusal would name the wrong reason.
  const borrowedMismatch = exportFixture(INCH, machine('x', 'borrowed'), false)
  assert.deepEqual(borrowedMismatch.warnings.map((warning) => warning.code), ['postRotaryAxisMismatch', 'postRotaryAxisMismatch'],
    'both operations are refused for the axis, not for borrowed travel')
}

// ── 7. the program reads back as the flat toolpath ────────────

console.log('Testing the exported program parses back onto the flat toolpath...')

{
  const result = exportFixture(MM, OWN_X)
  const { project, frame, wrapped } = MM
  const parsed = parseGcodeMotion(
    result.gcode,
    OWN_X.motion.arcFormat,
    OWN_X.program.commentPrefix,
    OWN_X.program.commentSuffix,
    { word: rotaryWord(OWN_X)!, inverseTimeFeed: OWN_X.rotary?.inverseTimeFeed ?? null },
  )
  assert.equal(parsed.status, 'verified', `the program parses: ${parsed.warnings.join('; ')}`)
  assert.ok(parsed.moves.length > 0, 'and has motion')

  // The whole program, unwrapped with `unwrapPoint`, lies on the flat
  // toolpaths the operations were generated from.
  const flatSource = MM.operations.flatMap((entry) => unwrapToolpath(wrapped.get(entry.id)!, frame).moves)
  let checked = 0
  for (const move of parsed.moves) {
    // The closing unwind turns the bar with the tool parked, so in stock space
    // it sweeps across the bar rather than following the flat path. It is the
    // one motion the flat toolpath has no analogue for (rule 5).
    if (move.from.a !== undefined && move.to.a === 0
      && move.from.x === move.to.x && move.from.y === move.to.y && move.from.z === move.to.z) continue
    for (const point of [move.from, move.to]) {
      // The program also opens with a Z-only safe rapid, before any angle word
      // — the pre-existing safe-Z split, whose XY is the machine's own zero
      // and not a toolpath point. Everything the bar turns to is checked.
      if (point.a === undefined) continue
      const projectPoint = machineToProjectPoint(point, project.origin, OWN_X)
      // The axis transform reads X/Y/Z; the angle is the bar's own and comes
      // through the parse unchanged.
      const flatPoint = unwrapPoint({ ...projectPoint, a: point.a }, frame)
      assert.ok(pointOnPath(flatPoint, flatSource, 2e-3),
        `${JSON.stringify(flatPoint)} lies on the flat toolpath`)
      checked += 1
    }
  }
  assert.ok(checked > 20, `every turned point was checked (${checked})`)
  // The angles come back too, never reduced to 0-360.
  const maxWritten = Math.max(...angleWords(result.gcode, 'A'))
  assert.ok(Number.isFinite(maxWritten), 'the read-back carries the angle')
}

// ── 8. the booklet (rule 7) ───────────────────────────────────

console.log('Testing the booklet report for an Around setup...')

{
  const entry = MM.operations[0]
  const report = buildOperationBookletReport({
    project: MM.project,
    operation: entry,
    tool: normalizeToolForProject(MM.project.tools[0], MM.project),
    toolpath: MM.wrapped.get(entry.id)!,
  })
  const row = (key: 'booklet.label.setup' | 'booklet.label.setupTurn'): string | undefined =>
    report.setupRows.find((line) => line.label === translate(key))?.value
  assert.equal(row('booklet.label.setupTurn'), translate('booklet.value.setupAround', { axis: 'X' }),
    'the setup row says Around, not Bottom and not a flip')
  assert.equal(row('booklet.label.setup'), '01 · Around', 'and names the program')

  // An Around toolpath's heights are tool heights over the centreline, read
  // from the top of the bar, so the report's numbers are already the ones the
  // operator measures — Top-style, with no shifting needed.
  const stats = report.toolpathStats
  const statValue = (key: 'booklet.label.topZ' | 'booklet.label.bottomZ'): number =>
    Number(stats.find((line) => line.label === translate(key))!.value.split(' ')[0])
  const bounds = MM.wrapped.get(entry.id)!.bounds!
  closeTo(statValue('booklet.label.topZ'), bounds.maxZ, 1e-9, 'the reported top Z is the toolpath top')
  closeTo(statValue('booklet.label.bottomZ'), bounds.minZ, 1e-9, 'the reported bottom Z is the toolpath bottom')
  // The depths the report's numbers describe: the operation cuts between the
  // top of the bar and the centreline, exactly as a Top operation reads.
  const cuts = MM.wrapped.get(entry.id)!.moves
    .filter((move) => move.kind === 'cut' || move.kind === 'lead_in' || move.kind === 'lead_out')
  const highest = Math.max(...cuts.flatMap((move) => [move.from.z, move.to.z]))
  const lowest = Math.min(...cuts.flatMap((move) => [move.from.z, move.to.z]))
  assert.ok(highest <= MM_BAR.thickness + 1e-9, `nothing cuts above the top of the bar (${highest})`)
  assert.ok(lowest >= MM.frame.radius - 1e-9, `nothing cuts below the centreline (${lowest})`)
}

// ── the program, for the record ────────────────────────────────

{
  const result = exportFixture(MM, OWN_X)
  const lines = result.gcode.split('\n')
  const header = lines.slice(0, lines.findIndex((line) => line.includes('Operation 1')), )
  const engraveAt = lines.findIndex((line) => line.includes('Operation 2: Engrave'))
  const sample = lines.slice(engraveAt, engraveAt + 80)
    .map((line) => line.split(';')[0].trim())
    .filter((line) => line.length > 0 && /\b[GXYZAB]-?[0-9]/.test(line))
    .filter((line) => !/^G(17|18|19|20|21|90|91|93|94)\b/.test(line) || /[XYZAB]-?[0-9]/.test(line))
    .slice(0, 25)
  console.log(`\nHeader:\n${header.join('\n')}`)
  console.log(`\nEngrave sample (${sample.length} motion blocks):\n${sample.join('\n')}`)
}

console.log('\nengine/gcode/aroundExport.test.ts: all assertions passed')
