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
 * The export dialog's rotary-zeroing note (#1103 slice ca-h, part 3).
 *
 * The note is the only place the operator is told to start with A zeroed at
 * 0 up, so it must appear for **every** program that turns the bar — including
 * a Top or Bottom program, whose turn is emitted from its setup and leaves no
 * angle on any toolpath move. Asking only the moves answered "nothing to zero"
 * about a program containing `G0 A0` (#1152 correction round 1, finding 4).
 *
 * Run with: npx tsx src/components/export/rotaryZeroNotice.test.ts
 */

import assert from 'node:assert/strict'
import { reportedGrblCopy, reportedRotaryProject } from '../../test/reportedRotaryMachines'
import { validateMachineDefinition } from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import type { Project } from '../../types/project'
import type { ToolpathMove } from '../../engine/toolpaths/types'
import { shouldShowRotaryZeroNotice } from './rotaryZeroNotice'

const MACHINE = reportedGrblCopy()
const PROJECT = reportedRotaryProject(MACHINE, MACHINE.id)

/** A flat cut: no A on any move, as a Top/Bottom program's toolpath is. */
const FLAT: ToolpathMove[] = [
  { kind: 'cut', from: { x: 0, y: 0, z: -1 }, to: { x: 10, y: 0, z: -1 } },
]

/** One move that commands A, as an Around program's toolpath does. */
const TURNING: ToolpathMove[] = [
  { kind: 'cut', from: { x: 0, y: 0, z: -1, a: 0 }, to: { x: 10, y: 0, z: -1, a: 90 } },
]

function program(face: 'top' | 'bottom' | 'around', moves: ToolpathMove[]) {
  return { face, operations: [{ toolpath: { moves } }] }
}

function withRotary(patch: Partial<NonNullable<MachineDefinition['rotary']>>): MachineDefinition {
  assert(MACHINE.rotary, 'fixture: the reported machine has a rotary block')
  return validateMachineDefinition({
    ...structuredClone(MACHINE),
    rotary: { ...structuredClone(MACHINE.rotary), ...patch },
  })
}

function withoutRotary(): MachineDefinition {
  const { rotary: _rotary, ...rest } = structuredClone(MACHINE)
  return validateMachineDefinition(rest)
}

const flatProject: Project = PROJECT

// A Top program turns the bar through its setup's manual-index turn, even
// though no move carries A. This is the finding: it used to answer false.
assert.equal(
  shouldShowRotaryZeroNotice([program('top', FLAT)], MACHINE, flatProject),
  true,
  'a Top program that turns the bar by manual index shows the note',
)
assert.equal(
  shouldShowRotaryZeroNotice([program('bottom', FLAT)], MACHINE, flatProject),
  true,
  'and so does a Bottom program',
)

// The machine's own Zero A line replaces the operator's zeroing, so the note
// is not shown; this holds for a manual-index program too.
assert.equal(
  shouldShowRotaryZeroNotice([program('top', FLAT)], withRotary({ zeroA: 'G10 L20 P1 A0' }), flatProject),
  false,
  'a machine that zeroes A itself shows no note',
)
assert.equal(
  shouldShowRotaryZeroNotice([program('top', FLAT)], withoutRotary(), flatProject),
  false,
  'a machine with no rotary axis shows no note',
)

// A flat project (no bar, no manual indexing) has nothing to zero even when a
// program's setup is called Top.
const milling: Project = { ...PROJECT, meta: { ...PROJECT.meta, projectType: 'milling' } }
assert.equal(
  shouldShowRotaryZeroNotice([program('top', FLAT)], MACHINE, milling),
  false,
  'a manual-index turn on a non-rotary project is not a turn of the bar',
)

// Without a setup the emitter plans no manual-index turn either, so a flat
// program has nothing to zero.
const setUpLess: Project = { ...PROJECT, setups: [] }
assert.equal(
  shouldShowRotaryZeroNotice([program('top', FLAT)], MACHINE, setUpLess),
  false,
  'a project with no setup gets no manual-index turn and needs no note',
)

// The existing case still holds: an Around program that commands A.
assert.equal(
  shouldShowRotaryZeroNotice([program('around', TURNING)], MACHINE, flatProject),
  true,
  'an Around program that commands A shows the note',
)
assert.equal(
  shouldShowRotaryZeroNotice([program('around', FLAT)], MACHINE, flatProject),
  false,
  'an Around program that commands no A has nothing to zero',
)

// A borrowed motor turns the other axis; the note still applies because the
// emitter can turn that word.
assert.equal(
  shouldShowRotaryZeroNotice(
    [program('top', FLAT)],
    validateMachineDefinition({
      ...structuredClone(MACHINE),
      rotary: { ...structuredClone(MACHINE.rotary), drive: 'borrowed' },
    }),
    flatProject,
  ),
  true,
  'a borrowed-motor machine turns its own word for a manual-index program',
)

// Any one turning program is enough: the dialog shows a single note.
assert.equal(
  shouldShowRotaryZeroNotice(
    [program('around', FLAT), program('bottom', FLAT)],
    MACHINE,
    flatProject,
  ),
  true,
  'one turning program among several is enough',
)

console.log('rotary zero notice tests passed')
