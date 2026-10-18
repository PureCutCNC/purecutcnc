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

import assert from 'node:assert/strict'
import { defaultRoundWorkholding } from '../../../store/helpers/roundWorkholding'
import { normalizeToolForProject } from '../../../engine/toolpaths/geometry'
import { rotaryAlongRange } from '../../../engine/toolpaths/rotaryModel'
import { squareStock } from '../../../types/barStock'
import {
  defaultTool,
  getStockBounds,
  newProject,
  type Clamp,
  type Project,
  type SquareStock,
  type Tool,
} from '../../../types/project'
import { rotarySolidChuckNotes } from './rotarySolidChuckNote'

interface Fixture {
  project: Project
  blank: SquareStock
  tool: Tool
}

/** A square blank with the default chuck and one flat end mill (#1016 C2 F4). */
function fixture(
  units: 'mm' | 'inch',
  axis: 'x' | 'y' = 'x',
  at: { x: number; y: number } = { x: 0, y: 0 },
): Fixture {
  const blank = units === 'mm'
    ? squareStock(25, 120, axis, at)
    : squareStock(1, 5, axis, at)
  const chuck: Clamp = {
    ...defaultRoundWorkholding('chuck', blank, units),
    id: 'chuck',
    name: 'Chuck',
    visible: true,
  }
  const tool: Tool = {
    ...defaultTool(units, 1),
    id: 't-flat',
    name: 'Flat',
    type: 'flat_endmill',
    diameter: units === 'mm' ? 12 : 0.5,
  }
  return {
    blank,
    tool,
    project: {
      ...newProject('chuck note', units),
      stock: blank,
      clamps: [chuck],
      tools: [tool],
    },
  }
}

/** The absolute band the dialog would post for a chuck-end start/length. */
function generatorRange(f: Fixture, start: number, length: number): {
  alongStart: number
  alongEnd: number
  range: { start: number; end: number } | null
} {
  const bounds = getStockBounds(f.blank)
  const alongStart = f.blank.axis === 'x'
    ? bounds.minX + start
    : bounds.maxY - start - length
  const alongEnd = alongStart + length
  return {
    alongStart,
    alongEnd,
    range: rotaryAlongRange(
      f.blank,
      f.project.clamps,
      { min: alongStart, max: alongEnd },
      normalizeToolForProject(f.tool, f.project),
      { chuckEnd: 0, tailEnd: 0 },
    ),
  }
}

// ── A start under the default chuck — mm ──────────────────────────────
// The 25 mm blank's default chuck holds the first 15 mm; the Ø12 cutter adds
// its 6 mm radius, so the generator starts at 21 mm. The note must carry the
// generator's number, not the chuck body alone.
{
  const f = fixture('mm')
  const { alongStart, alongEnd, range } = generatorRange(f, 10, 30)
  assert.ok(range, 'the generator has a range for 10..40 on the 25 mm blank')
  assert.equal(range.start, 21, 'the fixture sanity-checks the default chuck + cutter radius')
  const notes = rotarySolidChuckNotes(f.project, f.tool.id, alongStart, alongEnd)
  assert.equal(notes.length, 1)
  const [note] = notes
  assert.equal(note.kind, 'start')
  if (note.kind !== 'start') throw new Error('expected a start note')
  assert.equal(note.support, 'chuck')
  assert.equal(note.held, 15, 'the note names the chuck body, not the clearance')
  assert.equal(note.effective, range.start, 'the effective start is the generator boundary from the chuck end')
}

// ── A smaller cutter moves the note with the tool ────────────────────
{
  const f = fixture('mm')
  const tool: Tool = { ...f.tool, diameter: 6 }
  const withSmallTool: Fixture = { ...f, tool, project: { ...f.project, tools: [tool] } }
  const { alongStart, alongEnd } = generatorRange(withSmallTool, 10, 30)
  const notes = rotarySolidChuckNotes(withSmallTool.project, tool.id, alongStart, alongEnd)
  assert.equal(notes.length, 1)
  const [note] = notes
  assert.equal(note.kind, 'start')
  if (note.kind !== 'start') throw new Error('expected a start note')
  assert.equal(note.held, 15, 'the chuck still holds the same body')
  assert.equal(note.effective, 18, 'the smaller cutter clears the chuck by its 3 mm radius')
}

// ── A start past the chuck — no note ─────────────────────────────────
{
  const f = fixture('mm')
  const { alongStart, alongEnd, range } = generatorRange(f, 25, 15)
  assert.ok(range)
  assert.equal(range.start, 25, 'the generator starts at the requested start')
  assert.deepEqual(rotarySolidChuckNotes(f.project, f.tool.id, alongStart, alongEnd), [])
}

// ── The whole requested band sits under the chuck ────────────────────
{
  const f = fixture('mm')
  const { alongStart, alongEnd, range } = generatorRange(f, 0, 10)
  assert.equal(range, null, 'the generator has nothing to cut in 0..10')
  assert.deepEqual(rotarySolidChuckNotes(f.project, f.tool.id, alongStart, alongEnd), [{ kind: 'all' }])
}

// ── A bar along Y measures from its chuck end, not the absolute end ──
// The dialog's start is maxY - start - length on a Y bar, so the generator's
// absolute end is the chuck-side boundary. The note must report 21 from the
// chuck end, not the absolute 99.
{
  const f = fixture('mm', 'y')
  const { alongStart, alongEnd, range } = generatorRange(f, 10, 30)
  assert.ok(range)
  const bounds = getStockBounds(f.blank)
  assert.equal(range.end, bounds.maxY - 21, 'the absolute end is 21 mm from the chuck end')
  const notes = rotarySolidChuckNotes(f.project, f.tool.id, alongStart, alongEnd)
  assert.equal(notes.length, 1)
  const [note] = notes
  assert.equal(note.kind, 'start', 'the chunk end is the dialog start on a Y bar')
  if (note.kind !== 'start') throw new Error('expected a start note')
  assert.equal(note.support, 'chuck')
  assert.equal(note.held, 15)
  assert.equal(note.effective, bounds.maxY - range.end, 'the note is measured from the chuck end')
}

// ── A shifted bar measures from its own chuck end ────────────────────
{
  const f = fixture('mm', 'x', { x: 50, y: 10 })
  const { alongStart, alongEnd, range } = generatorRange(f, 10, 30)
  assert.ok(range)
  const bounds = getStockBounds(f.blank)
  assert.equal(range.start, bounds.minX + 21, 'the absolute start includes the bar offset')
  const notes = rotarySolidChuckNotes(f.project, f.tool.id, alongStart, alongEnd)
  assert.equal(notes.length, 1)
  const [note] = notes
  assert.equal(note.kind, 'start')
  if (note.kind !== 'start') throw new Error('expected a start note')
  assert.equal(note.effective, range.start - bounds.minX, 'the note is relative to the chuck end')
}

// ── The same rule in inches ──────────────────────────────────────────
{
  const f = fixture('inch')
  const { alongStart, alongEnd, range } = generatorRange(f, 0.25, 1)
  assert.ok(range)
  const notes = rotarySolidChuckNotes(f.project, f.tool.id, alongStart, alongEnd)
  assert.equal(notes.length, 1)
  const [note] = notes
  assert.equal(note.kind, 'start')
  if (note.kind !== 'start') throw new Error('expected a start note')
  assert.equal(note.support, 'chuck')
  assert.ok(note.held > 0.59 && note.held < 0.591, 'the inch chuck holds 15 mm converted')
  assert.equal(note.effective, range.start, 'the effective start stays in project units')
}
