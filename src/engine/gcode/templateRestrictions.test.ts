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
 * Machine-template restrictions (#1057 slice F).
 *
 * Frank's decision, 2026-10-21: no motion or modal change except in the
 * tool-change and end-of-program templates; after a tool change the emitter
 * writes one full restart block; a definition that breaks the rule is refused.
 *
 * This file pins the schema half:
 *
 * 1. every template field is covered, and a motion/axis/mode/macro word in one
 *    of the restricted classes is refused with a message naming the field and
 *    the word;
 * 2. the tool-change block, the footer and the program-end command accept
 *    anything, because the emitter restarts after the first and nothing follows
 *    the others;
 * 3. every bundled definition still validates unchanged;
 * 4. the program header accepts exactly its class (modal setup, units, work
 *    coordinate, program number, parameter assignment, comments, non-moving M
 *    codes) and the purpose templates accept exactly their own words.
 *
 * Mutations that must fail these tests (restore the file from a `cp` backup):
 * - accept a motion word in an inert template (drop the `INERT_G_COMMANDS`
 *   check) → the spindle-on / coolant / operation-header refusals pass and the
 *   suite fails;
 * - treat the header as `anything` → the header motion and `G91` refusals pass;
 * - drop the O-word/expression refusal → `o<x> call` in the inverse-time
 *   template passes.
 *
 * Run with: npx tsx src/engine/gcode/templateRestrictions.test.ts
 */

import assert from 'node:assert/strict'
import { BUNDLED_DEFINITIONS } from './definitions'
import { validateMachineDefinition } from './types'
import type { MachineDefinition } from './types'
import { validateCustomMachine } from '../../machine/registry'

function bundled(id: string): MachineDefinition {
  const definition = BUNDLED_DEFINITIONS.find((entry) => entry.id === id)
  assert.ok(definition, `fixture: bundled machine ${id}`)
  return validateMachineDefinition(structuredClone(definition))
}

interface RefusalIssue {
  path: Array<string | number>
  message: string
}

/** The issues a definition's refusal carries, parsed out of the ZodError. */
function refusalIssues(definition: unknown, label = 'definition'): RefusalIssue[] {
  try {
    validateMachineDefinition(definition)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const match = text.match(/^\[[\s\S]*\]/)
    if (match) {
      try {
        const parsed: unknown = JSON.parse(match[0])
        if (Array.isArray(parsed)) return parsed as RefusalIssue[]
      } catch {
        // Not the JSON shape; fall through to the raw text.
      }
    }
    return [{ path: [], message: text }]
  }
  assert.fail(`${label}: the definition was accepted, expected a template refusal`)
}

/** Assert one field/word refusal, and that the message names both. */
function assertRefused(
  label: string,
  definition: unknown,
  field: string,
  word: string,
): void {
  const issues = refusalIssues(definition, label)
  const issue = issues.find((entry) => entry.message.startsWith(`${field}:`))
  assert.ok(issue, `${label}: a refusal names the template field (${field}): ${JSON.stringify(issues)}`)
  assert.ok(issue.message.includes('is not allowed'), `${label}: the message says the word is not allowed: ${issue.message}`)
  assert.ok(issue.message.includes(`"${word}"`), `${label}: the message names the offending word (${word}): ${issue.message}`)
}

// ── 1. Every restricted template field refuses a motion word ──

console.log('Testing the restricted template fields refuse a motion word...')

interface FieldCase {
  label: string
  field: string
  /** The template text that must be refused, and the word named in the message. */
  text: string
  word: string
  /** Which bundled definition the case is built on. */
  machine: string
  apply(definition: MachineDefinition): MachineDefinition
}

const fieldCases: FieldCase[] = [
  {
    label: 'program header motion',
    field: 'program.header[0]',
    text: 'G0 Z-2',
    word: 'G0',
    machine: 'grbl',
    apply: (definition) => ({ ...definition, program: { ...definition.program, header: ['G0 Z-2'] } }),
  },
  {
    label: 'program header axis word',
    field: 'program.header[0]',
    text: 'X0',
    word: 'X0',
    machine: 'grbl',
    apply: (definition) => ({ ...definition, program: { ...definition.program, header: ['X0'] } }),
  },
  {
    label: 'program header incremental mode',
    field: 'program.header[0]',
    text: 'G91',
    word: 'G91',
    machine: 'grbl',
    apply: (definition) => ({ ...definition, program: { ...definition.program, header: ['G91'] } }),
  },
  {
    label: 'operation header motion',
    field: 'program.operationHeader[0]',
    text: 'G0 X0 Y0',
    word: 'G0',
    machine: 'grbl',
    apply: (definition) => ({
      ...definition,
      program: { ...definition.program, operationHeader: ['G0 X0 Y0'] },
    }),
  },
  {
    label: 'spindle-on motion',
    field: 'feedSpeed.spindleOnCW',
    text: 'M3',
    word: 'G0',
    machine: 'grbl',
    apply: (definition) => ({
      ...definition,
      feedSpeed: { ...definition.feedSpeed, spindleOnCW: 'M3\nG0 Z-2' },
    }),
  },
  {
    label: 'spindle-off axis word',
    field: 'feedSpeed.spindleOff',
    text: 'M5',
    word: 'Z-2',
    machine: 'grbl',
    apply: (definition) => ({
      ...definition,
      feedSpeed: { ...definition.feedSpeed, spindleOff: 'M5 Z-2' },
    }),
  },
  {
    label: 'coolant incremental mode',
    field: 'coolant.floodOnCommand',
    text: 'M8',
    word: 'G91',
    machine: 'grblhal',
    apply: (definition) => {
      assert.ok(definition.coolant, 'fixture: grblhal has coolant')
      return {
        ...definition,
        coolant: { ...definition.coolant, floodOnCommand: 'M8\nG91' },
      }
    },
  },
  {
    label: 'pause motion',
    field: 'toolChange.pauseCommand',
    text: 'M0',
    word: 'G0',
    machine: 'grbl',
    apply: (definition) => ({
      ...definition,
      toolChange: { ...definition.toolChange, pauseCommand: 'M0\nG0 Z-2' },
    }),
  },
  {
    label: 'units template motion',
    field: 'units.mmCommand',
    text: 'G21',
    word: 'G0',
    machine: 'grbl',
    apply: (definition) => ({
      ...definition,
      units: { ...definition.units, mmCommand: 'G21 G0 Z-2' },
    }),
  },
  {
    label: 'work-coordinate select motion',
    field: 'workCoordinates.selectCommand',
    text: 'G54',
    word: 'G0',
    machine: 'grbl',
    apply: (definition) => ({
      ...definition,
      workCoordinates: { ...definition.workCoordinates, selectCommand: 'G54 G0 Z-2' },
    }),
  },
  {
    label: 'inverse-time on subroutine call',
    field: 'rotary.inverseTimeFeed.on',
    text: 'G93',
    word: 'o<x>',
    machine: 'rotary-grbl',
    apply: (definition) => {
      assert.ok(definition.rotary, 'fixture: the rotary machine has a rotary block')
      return {
        ...definition,
        rotary: { ...definition.rotary, inverseTimeFeed: { on: 'o<x> call', off: 'G94' } },
      }
    },
  },
  {
    label: 'inverse-time off wrong mode',
    field: 'rotary.inverseTimeFeed.off',
    text: 'G93',
    word: 'G93',
    machine: 'rotary-grbl',
    apply: (definition) => {
      assert.ok(definition.rotary, 'fixture: the rotary machine has a rotary block')
      return {
        ...definition,
        rotary: { ...definition.rotary, inverseTimeFeed: { on: 'G93', off: 'G93' } },
      }
    },
  },
  {
    label: 'torch-on axis word',
    field: 'plasma.torchOnCommand',
    text: 'M3 S1000',
    word: 'X0',
    machine: 'grbl-plasma',
    apply: (definition) => {
      assert.ok(definition.plasma, 'fixture: grbl-plasma has a plasma block')
      return {
        ...definition,
        plasma: { ...definition.plasma, torchOnCommand: 'M3 S1000\nX0' },
      }
    },
  },
  {
    label: 'torch-off non-torch M code',
    field: 'plasma.torchOffCommand',
    text: 'M5',
    word: 'M8',
    machine: 'grbl-plasma',
    apply: (definition) => {
      assert.ok(definition.plasma, 'fixture: grbl-plasma has a plasma block')
      return { ...definition, plasma: { ...definition.plasma, torchOffCommand: 'M8' } }
    },
  },
  {
    label: 'material/THC axis word',
    field: 'plasma.materialWaitCommand',
    text: 'M66 P3 L3 Q1',
    word: 'X0',
    machine: 'qtplasmac',
    apply: (definition) => {
      assert.ok(definition.plasma, 'fixture: qtplasmac has a plasma block')
      return {
        ...definition,
        plasma: { ...definition.plasma, materialWaitCommand: 'M66 P3 L3 Q1\nX0' },
      }
    },
  },
  {
    label: 'THC motion word',
    field: 'plasma.thcOnCommand',
    text: 'M63 P2',
    word: 'G0',
    machine: 'qtplasmac',
    apply: (definition) => {
      assert.ok(definition.plasma, 'fixture: qtplasmac has a plasma block')
      return { ...definition, plasma: { ...definition.plasma, thcOnCommand: 'M63 P2\nG0 Z0' } }
    },
  },
  {
    label: 'canned-cycle command is a motion word',
    field: 'cannedCycles.drillCommand',
    text: 'G81',
    word: 'G0',
    machine: 'mach3',
    apply: (definition) => {
      assert.ok(definition.cannedCycles, 'fixture: mach3 has canned cycles')
      return {
        ...definition,
        cannedCycles: { ...definition.cannedCycles, drillCommand: 'G0' },
      }
    },
  },
  {
    label: 'canned-cycle cancel moves',
    field: 'cannedCycles.cancelCommand',
    text: 'G80',
    word: 'G0',
    machine: 'mach3',
    apply: (definition) => {
      assert.ok(definition.cannedCycles, 'fixture: mach3 has canned cycles')
      return {
        ...definition,
        cannedCycles: { ...definition.cannedCycles, cancelCommand: 'G80\nG0 X0 Y0' },
      }
    },
  },
]

for (const testCase of fieldCases) {
  const definition = testCase.machine === 'rotary-grbl'
    ? (() => {
      const base = bundled('grbl')
      return validateMachineDefinition({
        ...structuredClone(base),
        id: 'rotary-grbl',
        rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
      })
    })()
    : bundled(testCase.machine)
  assertRefused(testCase.label, testCase.apply(definition), testCase.field, testCase.word)
}
assert.equal(fieldCases.length >= 18, true, 'the fixture covers every restricted template field family')

// ── 2. Tool change, footer and program end accept anything ────

console.log('Testing the tool-change and end-of-program templates accept anything...')

{
  // The two templates the emitter is allowed to distrust: after a tool change
  // it writes one full restart block, and nothing follows the footer.
  const base = bundled('linuxcnc')
  const accepted = validateMachineDefinition({
    ...structuredClone(base),
    toolChange: {
      ...base.toolChange,
      commands: ['M5', 'M6 T{toolNumber}', 'G43 H{toolNumber}', 'G0 Z-2', 'G91', 'o<toolchange> call', 'G53 G0 Z0'],
    },
    program: { ...base.program, footer: ['G0 G53 Z0', 'G28 G91 Z0', 'M5'] },
    stop: { programEndCommand: 'M30' },
  })
  assert.ok(accepted.toolChange.commands.length === 7, 'the tool-change block keeps every command')
  assert.deepEqual(accepted.program.footer, ['G0 G53 Z0', 'G28 G91 Z0', 'M5'], 'the footer keeps every line')
}

{
  // The header's own class: modal setup, units, WCS, a program number, a
  // parameter assignment, comments and non-moving M codes.
  const base = bundled('grbl')
  const accepted = validateMachineDefinition({
    ...structuredClone(base),
    program: {
      ...base.program,
      header: ['%', 'O0001 (part)', 'G90 G94 G17 G40 G49 G80 G92.1 G97', 'G21', 'G54', 'M52 P1', '#<holes> = 1', '; a comment'],
    },
  })
  assert.equal(accepted.program.header.length, 8, 'the header keeps every line')
}

{
  // Purpose templates keep exactly their own word. The bundled QtPlasmaC
  // definition is the real case: `M3 $0 S1`, `F#<_hal[...]>` and `M52 P1`.
  const qtplasmac = bundled('qtplasmac')
  assert.ok(qtplasmac.plasma, 'fixture: qtplasmac has a plasma block')
  assert.equal(qtplasmac.plasma.torchOnCommand, 'M3 $0 S1', 'the QtPlasmaC torch word is accepted')
  assert.equal(qtplasmac.plasma.materialFeedCommand, 'F#<_hal[plasmac.cut-feed-rate]>',
    'the controller-owned feed expression is accepted')
  assert.ok(qtplasmac.program.header.includes('#<holes> = 1'), 'the parameter assignment header line is accepted')
}

// ── 3. Every bundled definition validates unchanged ───────────

console.log('Testing every bundled machine definition still validates...')
for (const definition of BUNDLED_DEFINITIONS) {
  const parsed = validateMachineDefinition(structuredClone(definition))
  assert.equal(parsed.id, definition.id, `${definition.id}: parses`)
  assert.equal(parsed.builtin, true, `${definition.id}: stays builtin`)
}

// ── 4. Machine import shows the refusal ──────────────────────

console.log('Testing machine import reports the template refusal...')
{
  const base = bundled('grbl')
  const custom = {
    ...structuredClone(base),
    id: 'my-machine',
    name: 'My machine',
    builtin: false,
    program: { ...base.program, operationHeader: ['G0 X0 Y0'] },
  }
  const imported = validateCustomMachine(custom)
  assert.equal(imported.ok, undefined, 'the import is refused')
  assert.ok(imported.error?.includes('program.operationHeader'), `the import names the field: ${imported.error}`)
  assert.ok(imported.error?.includes('"G0"'), `the import names the word: ${imported.error}`)
}

console.log('gcode template restriction tests passed')
