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

import type { MachineDefinition } from '../../engine/gcode/types'
import { rotaryWord } from '../../engine/gcode/types'
import {
  joinLines,
  splitLines,
  toFormData,
  mergeFormData,
  validateDef,
} from './machineDefinitionForm'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertDeepEqual<T>(actual: T, expected: T, message: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    throw new Error(
      `${message}\n  expected: ${b}\n  actual:   ${a}`,
    )
  }
}

/** Minimal valid machine definition for testing. */
function makeTestDef(overrides?: Partial<MachineDefinition>): MachineDefinition {
  return {
    id: 'test-machine',
    name: 'Test Machine',
    description: 'A test machine definition',
    builtin: false,
    fileExtension: 'nc',
    coordinateSystem: { xAxis: 'X', yAxis: 'Y', zAxis: 'Z' },
    numberFormat: { decimalPlaces: { mm: 3, inch: 4 }, trailingZeros: false, leadingZero: false },
    units: { mmCommand: 'G21', inchCommand: 'G20' },
    program: {
      header: ['G90', 'G17'],
      operationHeader: [],
      footer: ['M30'],
      commentPrefix: '(',
      commentSuffix: ')',
      lineNumbers: false,
      lineNumberIncrement: 1,
    },
    workCoordinates: { selectCommand: 'G54' },
    motion: {
      rapidCommand: 'G00',
      linearCommand: 'G01',
      cwArcCommand: 'G02',
      ccwArcCommand: 'G03',
      arcFormat: 'ij',
      modalMotion: true,
      arcInterpolation: false,
    },
    feedSpeed: {
      feedCommand: 'F',
      rpmCommand: 'S',
      spindleOnCW: 'M03',
      spindleOnCCW: 'M04',
      spindleOff: 'M05',
      inlineWithMotion: false,
      modalFeedSpeed: true,
    },
    toolChange: {
      commands: ['T[TOOL]', 'M06'],
      stopSpindleFirst: true,
      pauseAfterChange: false,
      pauseCommand: 'M00',
    },
    cannedCycles: null,
    coolant: {
      floodOnCommand: 'M8',
      mistOnCommand: 'M7',
      coolantOffCommand: 'M9',
    },
    stop: { programEndCommand: 'M30' },
    ...overrides,
  } as MachineDefinition
}

// ── line-array helpers ──────────────────────────────────────────

{
  const lines = ['G90', 'G17', '', 'M30']
  const joined = joinLines(lines)
  assert(joined === 'G90\nG17\n\nM30', 'joinLines produces newline-separated text')
  const roundTripped = splitLines(joined)
  assertDeepEqual(roundTripped, lines, 'splitLines round-trips through joinLines')
}

{
  const text = 'G90\r\nG17\r\nM30'
  const lines = splitLines(text)
  assertDeepEqual(lines, ['G90', 'G17', 'M30'], 'splitLines strips CR from CRLF')
}

{
  assertDeepEqual(splitLines(''), [''], 'splitLines of empty string returns single empty string')
  assertDeepEqual(joinLines([]), '', 'joinLines of empty array returns empty string')
}

{
  // blank-line preservation
  const text = 'G90\n\nM30'
  const lines = splitLines(text)
  assertDeepEqual(lines, ['G90', '', 'M30'], 'splitLines preserves blank lines')
}

// ── toFormData ──────────────────────────────────────────────────

{
  const def = makeTestDef()
  const form = toFormData(def)

  assert(form.name === 'Test Machine', 'toFormData: name')
  assert(form.fileExtension === 'nc', 'toFormData: fileExtension')
  assert(form.mmCommand === 'G21', 'toFormData: mmCommand')
  assert(form.inchCommand === 'G20', 'toFormData: inchCommand')
  assert(form.header === 'G90\nG17', 'toFormData: header joined')
  assert(form.footer === 'M30', 'toFormData: footer joined')
  assert(form.operationHeader === '', 'toFormData: empty operationHeader')
  assert(form.toolChangeCommands === 'T[TOOL]\nM06', 'toFormData: toolChangeCommands joined')
  assert(form.floodOnCommand === 'M8', 'toFormData: floodOnCommand')
  assert(form.mistOnCommand === 'M7', 'toFormData: mistOnCommand')
  assert(form.coolantOffCommand === 'M9', 'toFormData: coolantOffCommand')
}

{
  // nullable fields
  const def = makeTestDef({
    units: { mmCommand: null, inchCommand: null },
    coolant: null,
  })
  const form = toFormData(def)
  assert(form.mmCommand === '', 'toFormData: null mmCommand becomes empty string')
  assert(form.inchCommand === '', 'toFormData: null inchCommand becomes empty string')
  assert(form.floodOnCommand === '', 'toFormData: null coolant -> empty strings')
  assert(form.mistOnCommand === '', 'toFormData: null coolant -> empty mist')
  assert(form.coolantOffCommand === '', 'toFormData: null coolant -> empty off')
}

// ── mergeFormData ───────────────────────────────────────────────

{
  const def = makeTestDef()
  const form = toFormData(def)
  form.name = 'Modified Machine'
  form.header = 'G90\nG17\nG54'
  form.floodOnCommand = 'M50'

  const merged = mergeFormData(def, form)
  assert(merged.name === 'Modified Machine', 'mergeFormData: name updated')
  assertDeepEqual(merged.program.header, ['G90', 'G17', 'G54'], 'mergeFormData: header re-split')
  assert(merged.coolant?.floodOnCommand === 'M50', 'mergeFormData: coolant flood updated')

  // Unchanged fields preserved
  assert(merged.fileExtension === 'nc', 'mergeFormData: unchanged field preserved')
  assert(merged.motion.arcFormat === 'ij', 'mergeFormData: non-form field preserved')
  assert(merged.coolant?.mistOnCommand === 'M7', 'mergeFormData: unchanged coolant field preserved')
}

{
  // The output dialect has no form field (issue #953): editing a ShopBot
  // machine in the focused form must not turn it into a G-code machine.
  const def = makeTestDef({ outputDialect: 'opensbp', fileExtension: 'sbp' })
  const form = toFormData(def)
  form.name = 'Shop ShopBot'
  const merged = mergeFormData(def, form)
  assert(merged.outputDialect === 'opensbp', 'mergeFormData: output dialect preserved')
  const validated = validateDef(merged)
  assert(validated.ok?.outputDialect === 'opensbp', 'validateDef: output dialect survives validation')
}

{
  // operationHeader round-trip
  const def = makeTestDef({ program: { ...makeTestDef().program, operationHeader: ['G00 Z10', 'G01 Z-5'] } })
  const form = toFormData(def)
  assert(form.operationHeader === 'G00 Z10\nG01 Z-5', 'toFormData: operationHeader')
  const merged = mergeFormData(def, form)
  assertDeepEqual(merged.program.operationHeader, ['G00 Z10', 'G01 Z-5'], 'mergeFormData: operationHeader round-trip')
}

{
  // toolChangeCommands round-trip
  const def = makeTestDef({ toolChange: { ...makeTestDef().toolChange, commands: ['T1', 'M06', 'G43 H1'] } })
  const form = toFormData(def)
  assert(form.toolChangeCommands === 'T1\nM06\nG43 H1', 'toFormData: multi-line toolChange')
  const merged = mergeFormData(def, form)
  assertDeepEqual(merged.toolChange.commands, ['T1', 'M06', 'G43 H1'], 'mergeFormData: toolChange round-trip')
}

{
  // Coolant: create object from form fields when source def has coolant: null.
  const def = makeTestDef({ coolant: null })
  const form = toFormData(def)
  form.floodOnCommand = 'M8'
  form.mistOnCommand = ''
  form.coolantOffCommand = 'M9'
  const merged = mergeFormData(def, form)
  assert(merged.coolant !== null, 'mergeFormData: coolant created from form when source was null')
  assert(merged.coolant!.floodOnCommand === 'M8', 'mergeFormData: coolant floodOn set')
  assert(merged.coolant!.mistOnCommand === '', 'mergeFormData: coolant mistOn empty')
  assert(merged.coolant!.coolantOffCommand === 'M9', 'mergeFormData: coolant off set')
}

{
  // Coolant: stays null when all fields empty and source was null.
  const def = makeTestDef({ coolant: null })
  const form = toFormData(def)
  form.floodOnCommand = ''
  form.mistOnCommand = ''
  form.coolantOffCommand = ''
  const merged = mergeFormData(def, form)
  assert(merged.coolant === null, 'mergeFormData: coolant stays null when all empty')
}

// ── validateDef ─────────────────────────────────────────────────

{
  const def = makeTestDef()
  const result = validateDef(def)
  assert(result.ok !== undefined, 'validateDef: valid definition returns ok')
  assert(result.error === undefined, 'validateDef: no error on valid def')
  assert(result.ok!.name === 'Test Machine', 'validateDef: parsed definition preserved')
}

{
  // Missing required fields
  const result = validateDef({ id: 'bad', name: 'Bad' })
  assert(result.ok === undefined, 'validateDef: invalid definition returns no ok')
  assert(result.error !== undefined, 'validateDef: error message present')
  assert(typeof result.error === 'string', 'validateDef: error is a string')
  assert(result.error!.length > 0, 'validateDef: error message non-empty')
}

{
  // Bad enum value
  const def = makeTestDef()
  ;(def as unknown as Record<string, unknown>).motion = { ...def.motion, arcFormat: 'INVALID' }
  const result = validateDef(def)
  assert(result.ok === undefined, 'validateDef: bad arcFormat rejected')
  assert(
    result.error!.toLowerCase().includes('arc'),
    `validateDef: error message mentions arc-related issue, got: ${result.error}`,
  )
}

{
  // Not an object
  const result = validateDef(null)
  assert(result.ok === undefined, 'validateDef: null rejected')
  assert(result.error !== undefined, 'validateDef: null produces error')
}

// ── rotary axis (issue #393) ────────────────────────────────────

/** A valid rotary block, so only the field under test varies. */
function makeRotary(
  overrides: Partial<NonNullable<MachineDefinition['rotary']>> = {},
): NonNullable<MachineDefinition['rotary']> {
  return { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' }, ...overrides }
}

{
  // A machine without a rotary axis round-trips with no key at all.
  const def = makeTestDef()
  const form = toFormData(def)
  assert(form.rotaryAbout === 'none', 'toFormData: no rotary block reads as none')
  assert(form.rotaryDrive === 'own', 'toFormData: drive defaults to own in the form')
  assert(form.rotaryReversed === false, 'toFormData: reversed defaults to false in the form')
  const merged = mergeFormData(def, form)
  assert(!('rotary' in merged), 'mergeFormData: no rotary key when the form has none')
  assertDeepEqual(merged, def, 'mergeFormData: a definition without a rotary block round-trips unchanged')
}

for (const about of ['x', 'y'] as const) {
  for (const drive of ['own', 'borrowed'] as const) {
    const def = makeTestDef({ rotary: makeRotary({ about, drive }) })
    const form = toFormData(def)
    assert(form.rotaryAbout === about, `toFormData: rotary about ${about}`)
    assert(form.rotaryDrive === drive, `toFormData: rotary drive ${drive}`)
    const merged = mergeFormData(def, form)
    assertDeepEqual(merged.rotary, def.rotary, `mergeFormData: rotary ${about}/${drive} round-trips`)
  }
}

{
  const def = makeTestDef({ rotary: makeRotary({ reversed: true }) })
  const form = toFormData(def)
  assert(form.rotaryReversed === true, 'toFormData: reversed rotary')
  assert(mergeFormData(def, form).rotary?.reversed === true, 'mergeFormData: reversed kept')
}

{
  // Choosing a rotary axis for the first time supplies every default.
  const def = makeTestDef()
  const form = toFormData(def)
  form.rotaryAbout = 'y'
  const merged = mergeFormData(def, form)
  assertDeepEqual(
    merged.rotary,
    { about: 'y', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
    'mergeFormData: first rotary axis gets drive own, not reversed, default inverse-time commands',
  )
}

{
  // None removes the block entirely, and the result validates without a key.
  const def = makeTestDef({ rotary: makeRotary() })
  const form = toFormData(def)
  form.rotaryAbout = 'none'
  const merged = mergeFormData(def, form)
  assert(!('rotary' in merged), 'mergeFormData: None removes the rotary key')
  const validated = validateDef(merged)
  assert(validated.ok !== undefined, `validateDef: definition without a rotary block validates (${validated.error ?? ''})`)
  assert(!('rotary' in validated.ok!), 'validateDef: parsed definition carries no rotary key')
}

{
  // An explicit null inverse-time feed survives every one of the three controls.
  const def = makeTestDef({ rotary: makeRotary({ inverseTimeFeed: null }) })
  const form = toFormData(def)
  form.rotaryAbout = 'y'
  form.rotaryDrive = 'borrowed'
  form.rotaryReversed = true
  const merged = mergeFormData(def, form)
  assert(merged.rotary?.inverseTimeFeed === null, 'mergeFormData: explicit null inverseTimeFeed is kept')
}

{
  // Custom inverse-time commands are kept too.
  const custom = { on: 'G93.1', off: 'G94.1' }
  const def = makeTestDef({ rotary: makeRotary({ inverseTimeFeed: custom }) })
  const form = toFormData(def)
  form.rotaryDrive = 'borrowed'
  const merged = mergeFormData(def, form)
  assertDeepEqual(merged.rotary?.inverseTimeFeed, custom, 'mergeFormData: custom inverse-time commands kept')
}

{
  // A plasma machine cannot carry the block, so converting drops it.
  const def = makeTestDef({ rotary: makeRotary() })
  const form = toFormData(def)
  form.machineKind = 'plasma'
  form.torchOnCommand = 'M3'
  form.torchOffCommand = 'M5'
  form.materialSelectCommand = 'M190 P{materialNumber}'
  form.materialWaitCommand = 'M66 P3 L3 Q1'
  form.materialFeedCommand = 'F#<_hal[plasmac.cut-feed-rate]>'
  const merged = mergeFormData(def, form)
  assert(!('rotary' in merged), 'mergeFormData: switching to plasma drops the rotary block')
  const validated = validateDef(merged)
  assert(validated.ok !== undefined, `validateDef: plasma conversion without rotary validates (${validated.error ?? ''})`)
  assert(validated.ok!.machineKind === 'plasma', 'validateDef: plasma kind kept')
  assert(validated.ok!.plasma !== undefined, 'validateDef: plasma block created')
}

{
  // Nor can a ShopBot, so the dialect conversion drops it.
  const def = makeTestDef({
    outputDialect: 'opensbp',
    fileExtension: 'sbp',
    rotary: makeRotary(),
  })
  const merged = mergeFormData(def, toFormData(def))
  assert(!('rotary' in merged), 'mergeFormData: a ShopBot dialect drops the rotary block')
  const validated = validateDef(merged)
  assert(validated.ok !== undefined, `validateDef: ShopBot conversion without rotary validates (${validated.error ?? ''})`)
  assert(validated.ok!.outputDialect === 'opensbp', 'validateDef: output dialect kept')
}

{
  // The program word is read from the definition's coordinate system, not
  // hard-coded: project Y mapped to machine X is still the Y motor.
  const identity = makeTestDef({ rotary: makeRotary({ drive: 'borrowed' }) })
  assert(rotaryWord(identity) === 'Y', 'rotaryWord: identity mapping borrows the Y motor')
  const mapped = makeTestDef({
    coordinateSystem: { xAxis: 'X', yAxis: 'X', zAxis: 'Z' },
    rotary: makeRotary({ drive: 'borrowed' }),
  })
  const form = toFormData(mapped)
  assert(rotaryWord(mergeFormData(mapped, form)) === 'X', 'mergeFormData: mapped coordinate system shows the machine letter X')
  form.rotaryDrive = 'own'
  assert(rotaryWord(mergeFormData(mapped, form)) === 'A', 'mergeFormData: its own axis always shows A')
}

{
  // A borrowed Z motor is refused, and the message names the Drive field so
  // the dialog can show it there.
  const def = makeTestDef({
    coordinateSystem: { xAxis: 'X', yAxis: 'Z', zAxis: 'Y' },
    rotary: makeRotary(),
  })
  const form = toFormData(def)
  form.rotaryDrive = 'borrowed'
  const result = validateDef(mergeFormData(def, form))
  assert(result.ok === undefined, 'validateDef: borrowing the Z motor is refused')
  assert(
    result.error!.includes('cannot borrow the Z motor'),
    `validateDef: borrowed-Z message, got: ${result.error}`,
  )
  assert(
    result.error!.includes('(at rotary.drive)'),
    `validateDef: borrowed-Z error points at the Driven by field, got: ${result.error}`,
  )
}

console.log('machineDefinitionForm.test.ts — all assertions passed')
