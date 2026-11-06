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
 * The bundled rotary machines (issue #1153): what they are, how a machine that
 * follows the bar resolves its axis, and the millimetre rule for controllers
 * that read the angle as a length.
 */

import assert from 'node:assert/strict'
import { BUNDLED_DEFINITIONS, BUNDLED_ROTARY_DEFINITIONS } from './definitions'
import { emitProgramWithoutPlanning, runPostProcessor } from './postprocessor'
import {
  machineExportDiagnostics,
  pinRotaryAxis,
  rotaryEnforcesMm,
  rotaryFollowsStock,
  rotaryWord,
  validateMachineDefinition,
  type MachineDefinition,
  type PostProcessorInput,
  type PostProcessorResult,
} from './types'
import { defaultOrigin, defaultTool, newProject, roundStock } from '../../types/project'
import type { MachiningSetup, Operation, Project, Tool } from '../../types/project'
import type { ToolpathMove, ToolpathPoint } from '../toolpaths/types'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { convertLength } from '../../utils/units'
import { duplicateMachineAsCustom, parseMachineImport, serializeMachineExport, validateCustomMachine } from '../../machine/registry'
import { mergeFormData, toFormData } from '../../components/machine/machineDefinitionForm'
import { rotaryFollowsStockNote, rotaryProjectNeedsMm } from '../../components/export/rotaryUnitsNotice'

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  if (!found) throw new Error(`no bundled definition "${id}"`)
  return validateMachineDefinition(structuredClone(found))
}

const ROTARY_BASES: Record<string, string> = {
  'grbl-rotary': 'grbl',
  'grbl-rotary-a': 'grbl',
  'grblhal-rotary': 'grblhal',
  'mach3-rotary': 'mach3',
  'uccnc-rotary': 'uccnc',
  'linuxcnc-rotary': 'linuxcnc',
}

// ── 1. the six machines ─────────────────────────────────────────────────────

assert.deepEqual(
  BUNDLED_ROTARY_DEFINITIONS.map((definition) => definition.id),
  Object.keys(ROTARY_BASES),
  'one bundled rotary machine per controller, plus the Grbl fork',
)
for (const raw of BUNDLED_ROTARY_DEFINITIONS) {
  assert.ok(BUNDLED_DEFINITIONS.includes(raw), `${raw.id} is in the bundled list`)
  const base = BUNDLED_DEFINITIONS.find((definition) => definition.id === ROTARY_BASES[raw.id])!
  // Strict validation: the template rules, exactly as the app writes them.
  const validated = validateMachineDefinition(structuredClone(raw))
  assert.equal(machineExportDiagnostics(validated).length, 0, `${raw.id} has no template diagnostics`)
  const { id: _id, name: _name, description: _description, rotary, ...rest } = raw
  const { id: _baseId, name: _baseName, description: _baseDescription, ...baseRest } = base
  assert.deepEqual(rest, baseRest, `${raw.id} is its base profile byte for byte, apart from its name and rotary block`)
  assert.ok(rotary, `${raw.id} has a rotary block`)
  assert.equal(rotary.about, undefined, `${raw.id} follows the bar: no fixed axis`)
  assert.equal(rotary.zeroA, undefined, `${raw.id} ships with Zero A empty`)
  assert.deepEqual(rotary.inverseTimeFeed, { on: 'G93', off: 'G94' }, `${raw.id} writes G93/G94`)
  assert.equal(rotary.reversed, false)
  assert.ok(rotaryFollowsStock(raw), `${raw.id} reads as following the stock`)
  const keys = Object.keys(raw)
  assert.equal(keys.indexOf('rotary') + 1, keys.indexOf('coordinateSystem'), `${raw.id}: the rotary key sits before the coordinate system`)
  assert.match(raw.description, /soft limits|MIN_LIMIT/, `${raw.id}: the description says how to keep A from stopping at a limit`)
}
assert.equal(bundled('grbl-rotary').rotary?.drive, 'borrowed')
for (const id of ['grbl-rotary-a', 'grblhal-rotary', 'mach3-rotary', 'uccnc-rotary', 'linuxcnc-rotary']) {
  assert.equal(bundled(id).rotary?.drive, 'own', `${id} has its own A axis`)
}
assert.match(bundled('grblhal-rotary').description, /\$376/, 'the grblHAL notes say to put A in $376')

// ── 2. which machines enforce millimetres ───────────────────────────────────

const ENFORCES_MM: Record<string, boolean> = {
  'grbl-rotary': true, // borrowed motor: always
  'grbl-rotary-a': true, // own A, flagged
  'grblhal-rotary': false,
  'mach3-rotary': false,
  'uccnc-rotary': false,
  'linuxcnc-rotary': false,
}
for (const [id, enforces] of Object.entries(ENFORCES_MM)) {
  assert.equal(rotaryEnforcesMm(bundled(id)), enforces, `${id}: millimetres ${enforces ? 'enforced' : 'not enforced'}`)
}
assert.equal(bundled('grbl-rotary-a').rotary?.angleScalesWithUnits, true, 'the fork carries the flag')
assert.equal(bundled('grbl-rotary').rotary?.angleScalesWithUnits, undefined, 'the borrowed machine needs no flag: the drive decides')
for (const id of ['grblhal-rotary', 'mach3-rotary', 'uccnc-rotary', 'linuxcnc-rotary']) {
  assert.ok(!('angleScalesWithUnits' in bundled(id).rotary!), `${id} writes no flag key`)
}
assert.equal(rotaryEnforcesMm(bundled('grbl')), false, 'no rotary block, no rule')
// Borrowed is mm whatever the flag says: a custom machine cannot opt out.
assert.equal(
  rotaryEnforcesMm(validateMachineDefinition({ ...bundled('grbl-rotary'), rotary: { ...bundled('grbl-rotary').rotary!, angleScalesWithUnits: false } })),
  true,
  'a borrowed motor is millimetre-only even with the flag cleared',
)

// ── 3. resolving the bar axis ───────────────────────────────────────────────

const barX = roundStock(20, 100, 'x')
const barY = roundStock(20, 100, 'y')
const block = newProject('Block', 'mm').stock
const ownFollowing = bundled('linuxcnc-rotary')
assert.equal(pinRotaryAxis(ownFollowing, barX).rotary?.about, 'x')
assert.equal(pinRotaryAxis(ownFollowing, barY).rotary?.about, 'y', 'a machine that follows the bar takes the bar axis')
assert.equal(pinRotaryAxis(ownFollowing, block).rotary?.about, 'x', 'stock that is not a bar reads as X')
assert.equal(pinRotaryAxis(ownFollowing, null).rotary?.about, 'x')
const explicitX = validateMachineDefinition({ ...ownFollowing, id: 'explicit-x', rotary: { ...ownFollowing.rotary!, about: 'x' } })
assert.equal(pinRotaryAxis(explicitX, barY).rotary?.about, 'x', 'an explicit axis wins over the stock')
const router = bundled('grbl')
assert.equal(pinRotaryAxis(router, barY), router, 'a machine without a rotary block is returned unchanged')
assert.equal(pinRotaryAxis(explicitX, barY), explicitX, 'an explicit axis is returned unchanged')
// The pinned copy keeps the key order a hand-made block has.
assert.deepEqual(Object.keys(pinRotaryAxis(ownFollowing, barY).rotary!), ['about', 'drive', 'reversed', 'inverseTimeFeed'])
// The borrowed letter follows the bar.
const borrowed = bundled('grbl-rotary')
assert.equal(rotaryWord(pinRotaryAxis(borrowed, barX)), 'Y', 'a bar along X borrows the Y motor')
assert.equal(rotaryWord(pinRotaryAxis(borrowed, barY)), 'X', 'a bar along Y borrows the X motor')

// ── 4. copies always name their axis ────────────────────────────────────────

const duplicateOnY = duplicateMachineAsCustom(borrowed, [], barY)
assert.equal(duplicateOnY.rotary?.about, 'y', 'a duplicate copies the axis resolved against the open project')
assert.equal(duplicateMachineAsCustom(borrowed, []).rotary?.about, 'x', 'with no project the duplicate reads as X')
assert.equal(duplicateMachineAsCustom(explicitX, [], barY).rotary?.about, 'x', 'a duplicate of an explicit machine keeps its axis')
// The editor round trip keeps the block: the form has no "follows the bar"
// choice, so an unset copy would load as "no rotary" and lose it on save.
const roundTrip = mergeFormData(duplicateOnY, toFormData(duplicateOnY))
assert.deepEqual(roundTrip.rotary, duplicateOnY.rotary, 'duplicate → editor form → save keeps the rotary block')
assert.equal(validateCustomMachine({ ...borrowed, id: 'stored' }).ok?.rotary?.about, 'x', 'the custom library never stores an unset axis')
const imported = parseMachineImport(serializeMachineExport(borrowed), [], barY)
assert.equal(imported.ok?.rotary?.about, 'y', 'an exported bundled rotary machine imports with the open project\'s axis')

// ── 5. the editor checkbox ──────────────────────────────────────────────────

const ownCopy = duplicateMachineAsCustom(bundled('grblhal-rotary'), [], barX)
const ticked = mergeFormData(ownCopy, { ...toFormData(ownCopy), rotaryAngleScalesWithUnits: true })
assert.equal(ticked.rotary?.angleScalesWithUnits, true, 'ticking the box sets the flag')
assert.equal(toFormData(ticked).rotaryAngleScalesWithUnits, true, 'and it reads back ticked')
const cleared = mergeFormData(ticked, { ...toFormData(ticked), rotaryAngleScalesWithUnits: false })
assert.ok(!('angleScalesWithUnits' in cleared.rotary!), 'clearing the box removes the key')
const onBorrowed = mergeFormData(duplicateOnY, { ...toFormData(duplicateOnY), rotaryAngleScalesWithUnits: true })
assert.ok(!('angleScalesWithUnits' in onBorrowed.rotary!), 'a borrowed drive never writes the flag')

// ── 6. a Zero A line needs a fixed letter on a borrowed motor ───────────────

const borrowedWithZeroA = { ...borrowed, rotary: { ...borrowed.rotary!, zeroA: 'G92 Y0' } }
assert.ok(
  machineExportDiagnostics(borrowedWithZeroA).some((diagnostic) => diagnostic.field === 'rotary.zeroA'),
  'an unpinned borrowed machine refuses a Zero A line',
)
assert.equal(
  machineExportDiagnostics(pinRotaryAxis(borrowedWithZeroA, barX) as MachineDefinition).length,
  0,
  'the same line is fine once the axis is fixed',
)

// ── 7. export: the bar axis follows the stock ───────────────────────────────

function smokeTool(): Tool {
  return { ...defaultTool('mm', 1), id: 't1', name: 'Smoke endmill', units: 'mm', type: 'flat_endmill', diameter: 3, maxCutDepth: 25 }
}

/** A point on the bar: `along` the bar axis, on its centreline across it. */
function point(axis: 'x' | 'y', along: number, z: number, a: number | undefined, units: 'mm' | 'inch'): ToolpathPoint {
  const len = (value: number) => convertLength(value, 'mm', units)
  const base = axis === 'x' ? { x: len(along), y: len(10), z: len(z) } : { x: len(10), y: len(along), z: len(z) }
  return a === undefined ? base : { ...base, a }
}

function turningMoves(axis: 'x' | 'y', units: 'mm' | 'inch'): ToolpathMove[] {
  const p = (along: number, z: number, a: number) => point(axis, along, z, a, units)
  return [
    { kind: 'rapid', from: p(10, 30, 0), to: p(20, 30, 0) },
    { kind: 'plunge', from: p(20, 30, 0), to: p(20, 14, 0) },
    { kind: 'cut', from: p(20, 14, 0), to: p(40, 14, 90) },
    { kind: 'cut', from: p(40, 14, 90), to: p(50, 14, 90) },
  ]
}

function flatMoves(axis: 'x' | 'y', units: 'mm' | 'inch'): ToolpathMove[] {
  const p = (along: number, z: number) => point(axis, along, z, undefined, units)
  return [
    { kind: 'rapid', from: p(60, 30), to: p(60, 30) },
    { kind: 'plunge', from: p(60, 30), to: p(60, 18) },
    { kind: 'cut', from: p(60, 18), to: p(80, 18) },
  ]
}

interface SmokeOptions {
  axis?: 'x' | 'y'
  units?: 'mm' | 'inch'
  /** Put both operations in a manual-index Top setup instead of Around. */
  topSetup?: boolean
  /** Leave out the turning operation. */
  flatOnly?: boolean
}

function smokeProject(options: SmokeOptions = {}): Project {
  const { axis = 'x', units = 'mm', topSetup = false } = options
  const len = (value: number) => convertLength(value, 'mm', units)
  const base = newProject('Bundled rotary smoke', units)
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  const stock = roundStock(len(20), len(100), axis)
  base.stock = stock
  base.origin = defaultOrigin(stock)
  base.tools = [smokeTool()]
  const top: MachiningSetup = {
    id: 'setup-top', name: 'Top', orientation: { axis, angleDeg: 0 }, indexing: 'manual',
    registration: [], notes: '', operationIds: [],
  }
  const around: MachiningSetup = { ...top, id: 'around', name: 'Around', kind: 'around' }
  base.setups = [top, around]
  const setupId = topSetup ? top.id : around.id
  const operation = (id: string, name: string): Operation => ({
    ...defaultOperationForTarget({ ...base, stock }, 'pocket', 'rough', { source: 'stock' }, 0),
    id, name, setupId, toolRef: 't1',
  })
  return { ...base, activeSetupId: setupId, operations: [operation('turn', 'Turn'), operation('flat', 'Flat')] }
}

function smokeInput(definition: MachineDefinition, options: SmokeOptions = {}): PostProcessorInput {
  const { axis = 'x', units = 'mm', topSetup = false, flatOnly = false } = options
  const project = smokeProject(options)
  const tool = normalizeToolForProject(project.tools[0], project)
  const toolpath = (operation: Operation, moves: ToolpathMove[]) => ({ operation, tool, toolpath: { operationId: operation.id, warnings: [], bounds: null, moves } })
  const [turn, flat] = project.operations
  const operations = [
    // A Top program turns the bar through its setup, so its moves carry no angle.
    ...(flatOnly ? [] : [toolpath(turn, topSetup ? flatMoves(axis, units) : turningMoves(axis, units))]),
    toolpath(flat, flatMoves(axis, units)),
  ]
  return {
    project,
    definition,
    operations,
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }
}

function exportSmoke(definition: MachineDefinition, options: SmokeOptions = {}): PostProcessorResult {
  return runPostProcessor(smokeInput(definition, options))
}

function motionLines(gcode: string): string[] {
  return gcode.split('\n').filter((line) => /^(?:N\d+\s+)?G[0-3]\b/.test(line.trim()) || /^(?:N\d+\s+)?[XYZA]-?\d/.test(line.trim()))
}

function codes(result: PostProcessorResult): string[] {
  return result.warnings.map((warning) => warning.code)
}

for (const axis of ['x', 'y'] as const) {
  const letter = axis === 'x' ? 'Y' : 'X'
  const result = exportSmoke(borrowed, { axis })
  assert.ok(result.gcode.length > 0, `borrowed, bar along ${axis.toUpperCase()}: exports`)
  assert.deepEqual(codes(result).filter((code) => code.startsWith('postRotary')), [], `borrowed, bar along ${axis.toUpperCase()}: no rotary refusal`)
  assert.ok(result.gcode.includes(`${letter}90.000`), `borrowed, bar along ${axis.toUpperCase()}: the angle is written under ${letter}`)
  assert.ok(!/\bA-?\d/.test(result.gcode), 'a borrowed motor writes no A')
  // The borrowed axis carries only angles — 0, the 90° turn and the closing
  // whole turn to 0 up (#1103) — never the bar's 10 mm centreline, which a
  // linear move would write.
  for (const match of result.gcode.matchAll(new RegExp(`\\b${letter}(-?\\d+(?:\\.\\d+)?)`, 'g'))) {
    assert.ok(Number(match[1]) % 90 === 0, `borrowed, bar along ${axis.toUpperCase()}: ${letter}${match[1]} is an angle, not a coordinate`)
  }
  assert.ok(result.gcode.includes('G21'), 'the program is in millimetres')
}

// A machine that follows the bar posts exactly what the same machine with the
// bar's axis written in posts: the resolution is the only difference.
for (const id of Object.keys(ROTARY_BASES)) {
  for (const axis of ['x', 'y'] as const) {
    const following = bundled(id)
    const pinned = validateMachineDefinition({ ...following, rotary: { about: axis, ...following.rotary! } })
    assert.equal(
      exportSmoke(following, { axis }).gcode,
      exportSmoke(pinned, { axis }).gcode,
      `${id}, bar along ${axis.toUpperCase()}: following the bar posts what the explicit axis posts`,
    )
  }
}
// A custom machine that names X keeps the mismatch refusal on a Y bar.
assert.ok(
  codes(exportSmoke(explicitX, { axis: 'y' })).includes('postRotaryAxisMismatch'),
  'an explicit X machine is still refused on a bar along Y',
)
assert.ok(
  !codes(exportSmoke(ownFollowing, { axis: 'y' })).includes('postRotaryAxisMismatch'),
  'a machine that follows the bar is never mismatched',
)

// ── 8. export: millimetres where the controller scales the angle ────────────

for (const id of ['grbl-rotary', 'grbl-rotary-a']) {
  for (const axis of ['x', 'y'] as const) {
    const definition = bundled(id)
    const label = `${id}, inch, bar along ${axis.toUpperCase()}`
    const result = exportSmoke(definition, { axis, units: 'inch' })
    const refused = result.warnings.filter((warning) => warning.code === 'postRotaryInchUnits')
    assert.equal(refused.length, 1, `${label}: the turning operation is refused`)
    assert.deepEqual(refused[0].params, { operation: 'Turn', machine: definition.name }, `${label}: the warning names the operation and the machine`)
    assert.ok(result.gcode.includes('Flat'), `${label}: the flat operation still exports`)
    assert.ok(!result.gcode.includes('Turn'), `${label}: the turning operation is not in the program`)
    assert.ok(result.gcode.includes('G20'), `${label}: what remains is an inch program`)
    const rotaryLetter = rotaryWord(pinRotaryAxis(definition, smokeProject({ axis, units: 'inch' }).stock))!
    assert.ok(
      !motionLines(result.gcode).some((line) => new RegExp(`\\b${rotaryLetter}-?\\d`).test(line)),
      `${label}: no motion line writes the rotary word ${rotaryLetter}`,
    )
    // In millimetres the same program turns.
    const mm = exportSmoke(definition, { axis })
    assert.ok(!codes(mm).includes('postRotaryInchUnits'), `${id}, mm: nothing refused for units`)
    assert.ok(mm.gcode.includes(`${rotaryLetter}90.000`), `${id}, mm: the turn is written`)
  }
}

// Own-A controllers that allow inch post the turn in inch, unchanged.
for (const id of ['grblhal-rotary', 'mach3-rotary', 'uccnc-rotary', 'linuxcnc-rotary']) {
  const definition = bundled(id)
  const result = exportSmoke(definition, { units: 'inch' })
  assert.ok(!codes(result).includes('postRotaryInchUnits'), `${id}, inch: not refused`)
  assert.ok(result.gcode.includes('G20'), `${id}, inch: an inch program`)
  assert.ok(result.gcode.includes('A90.0000'), `${id}, inch: the angle is written under A, in degrees`)
}

// The flag decides on an own axis: the same machine, flag on and off.
{
  const off = duplicateMachineAsCustom(bundled('grblhal-rotary'), [], barX)
  const on = validateMachineDefinition({ ...off, rotary: { ...off.rotary!, angleScalesWithUnits: true } })
  assert.ok(!codes(exportSmoke(off, { units: 'inch' })).includes('postRotaryInchUnits'), 'flag off: inch turns export')
  assert.ok(codes(exportSmoke(on, { units: 'inch' })).includes('postRotaryInchUnits'), 'flag on: inch turns are refused')
}

// A manual-index Top program turns the bar through its setup; in inch on a
// millimetre-only machine the whole program is refused.
{
  const fork = bundled('grbl-rotary-a')
  const inch = exportSmoke(fork, { topSetup: true, units: 'inch' })
  assert.equal(inch.gcode, '', 'manual-index turn in inch on the fork: no program')
  assert.ok(codes(inch).includes('postRotaryInchUnits'), 'manual-index turn in inch: refused for units')
  const mm = exportSmoke(fork, { topSetup: true })
  assert.ok(/\bA0\.000\b/.test(mm.gcode), 'manual-index turn in mm: the program turns the bar to A0')
  const allowed = exportSmoke(bundled('grblhal-rotary'), { topSetup: true, units: 'inch' })
  assert.ok(/\bA0\.0000\b/.test(allowed.gcode), 'manual-index turn in inch on grblHAL: allowed')
}

// The emitter's backstop: handed the turning operation the planner would have
// dropped, it refuses the program whole.
{
  const input = smokeInput(bundled('grbl-rotary-a'), { units: 'inch' })
  const result = emitProgramWithoutPlanning(input)
  assert.equal(result.gcode, '', 'backstop: no program text')
  assert.deepEqual(codes(result), ['postRotaryInchUnits'], 'backstop: refused for units')
  const allowed = emitProgramWithoutPlanning(smokeInput(bundled('grblhal-rotary'), { units: 'inch' }))
  assert.ok(allowed.gcode.length > 0, 'backstop: an own axis that allows inch is not refused')
}

// A template that turns the bar is refused in inch too, even when no operation
// turns (Codex review of #1153): a footer `G0 A90` on the fork would turn 2286°.
{
  const fork = duplicateMachineAsCustom(bundled('grbl-rotary-a'), [], barX)
  const turningFooter = validateMachineDefinition({ ...fork, program: { ...fork.program, footer: ['G0 A90'] } })
  const inch = exportSmoke(turningFooter, { units: 'inch', flatOnly: true })
  assert.equal(inch.gcode, '', 'inch, a footer that writes A on the fork: no program')
  assert.deepEqual(codes(inch), ['postRotaryInchUnits'], 'refused for units')
  const mm = exportSmoke(turningFooter, { flatOnly: true })
  assert.ok(mm.gcode.includes('G0 A90'), 'the same footer in mm is left alone, as before')
  const hal = duplicateMachineAsCustom(bundled('grblhal-rotary'), [], barX)
  const halFooter = validateMachineDefinition({ ...hal, program: { ...hal.program, footer: ['G0 A90'] } })
  assert.ok(exportSmoke(halFooter, { units: 'inch', flatOnly: true }).gcode.includes('G0 A90'), 'a machine that allows inch keeps its footer')
}

// A program with no angle is never refused for units, on any rotary machine.
for (const id of Object.keys(ROTARY_BASES)) {
  const result = exportSmoke(bundled(id), { units: 'inch', flatOnly: true })
  assert.ok(!codes(result).includes('postRotaryInchUnits'), `${id}, inch, no turn: not refused`)
}

// ── 9. the notices ──────────────────────────────────────────────────────────

{
  const inchRotary = smokeProject({ units: 'inch' })
  const mmRotary = smokeProject()
  const inchMilling: Project = { ...newProject('Milling', 'inch') }
  inchMilling.meta.projectType = 'milling'
  assert.equal(rotaryProjectNeedsMm(inchRotary, bundled('grbl-rotary')), true, 'inch rotary project on the borrowed machine: notice')
  assert.equal(rotaryProjectNeedsMm(inchRotary, bundled('grbl-rotary-a')), true, 'inch rotary project on the fork: notice')
  assert.equal(rotaryProjectNeedsMm(mmRotary, bundled('grbl-rotary')), false, 'mm project: no notice')
  assert.equal(rotaryProjectNeedsMm(inchRotary, bundled('grblhal-rotary')), false, 'a machine that allows inch: no notice')
  assert.equal(rotaryProjectNeedsMm(inchMilling, bundled('grbl-rotary')), false, 'a project that is not rotary: no notice, whatever the machine')
  assert.equal(rotaryProjectNeedsMm(inchRotary, null), false, 'no machine: no notice')

  assert.deepEqual(rotaryFollowsStockNote(smokeProject({ axis: 'y' }), bundled('linuxcnc-rotary')), { kind: 'own', axis: 'Y' })
  assert.deepEqual(rotaryFollowsStockNote(smokeProject({ axis: 'x' }), borrowed), { kind: 'borrowed', axis: 'X', motor: 'Y' })
  assert.deepEqual(rotaryFollowsStockNote(smokeProject({ axis: 'y' }), borrowed), { kind: 'borrowed', axis: 'Y', motor: 'X' })
  assert.equal(rotaryFollowsStockNote(smokeProject({ axis: 'y' }), explicitX), null, 'an explicit machine gets no note')
  assert.equal(rotaryFollowsStockNote(inchMilling, borrowed), null, 'a project that is not rotary gets no note')
}

console.log('engine/gcode/bundledRotaryMachines.test.ts: all assertions passed')
