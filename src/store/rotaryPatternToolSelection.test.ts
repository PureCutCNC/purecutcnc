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
 * Physical-size V-bit choice for a Thread (issue #1016 C1 slice A4).
 *
 * A project's tools each carry a `diameter` in their *own* `units`. The thread
 * tool resolver used to rank the existing V-bits by that raw number, so a
 * 0.25 in record (6.35 mm) outranked a 6 mm record and the thread was cut with
 * the physically larger tool. A4 compares the candidates as one physical
 * length (converted with the same `convertLength` the rest of the store uses)
 * without touching the saved records, their order or their ids.
 *
 * What this file pins:
 * - a table of mixed mm/inch V-bit candidates in both project units and both
 *   input orders, including cases where the inch tool really is the smaller
 *   one (the fix is a physical comparison, not a unit preference);
 * - deterministic ties: an exact physical tie and a same-unit tie keep the
 *   project's tool order, so the same project always picks the same tool;
 * - non-V-bit tools (flat/ball) are filtered out even when they are smallest;
 * - an existing V-bit always wins over the library, with no import;
 * - the library still prefers an entry written in the project's units even
 *   when an entry in the other unit is physically smaller, and otherwise
 *   imports the physically smallest one converted into project units;
 * - the stored records, their order and their ids are unchanged, and creation
 *   is exactly one undo step (the existing path adds no tool).
 *
 * Mutations checked one at a time against these assertions:
 * - `vBits` ranking by the raw `diameter` (the original defect) → the mixed
 *   "0.25 in beats 6 mm" and three-way cases select the physically larger tool;
 * - the physical comparison replaced by a fixed unit preference → the
 *   "12 mm vs 0.25 in" counterexample fails;
 * - sorting the project's own array instead of a copy → the stored tool order
 *   assertions fail;
 * - the non-V-bit filter dropped → the flat/ball cases pick the wrong tool;
 * - the existing-first check dropped → the existing-first case imports a tool;
 * - native-unit library preference dropped → the native-preference cases pick
 *   the physically smaller other-unit entry.
 *
 * Run with: npx tsx src/store/rotaryPatternToolSelection.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, roundStock } from '../types/project'
import type { Project, Tool } from '../types/project'
import type { ToolLibraryEntry } from '../toolLibrary'
import { bundledMachines } from '../machine/registry'
import { validateMachineDefinition } from '../engine/gcode/types'
import type { MachineDefinition } from '../engine/gcode/types'
import { projectWithFeatures } from '../test/projectFixtures'
import { convertLength } from '../utils/units'
import { useProjectStore } from './projectStore'
import { switchWorkspaceFace } from './workspaceFace'

const store = () => useProjectStore.getState()

function near(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

// ── fixtures ──────────────────────────────────────────────────

type Units = 'mm' | 'inch'

interface BarSpec {
  axis: 'x' | 'y'
  units: Units
  at: { x: number; y: number }
}

const MM_BAR: BarSpec = { axis: 'x', units: 'mm', at: { x: 10, y: 30 } }
const INCH_BAR: BarSpec = { axis: 'y', units: 'inch', at: { x: 3, y: 5 } }

function barStock(spec: BarSpec): ReturnType<typeof roundStock> {
  return spec.axis === 'x' ? roundStock(40, 200, 'x', spec.at) : roundStock(2, 8, 'y', spec.at)
}

function rotaryMachine(axis: 'x' | 'y'): MachineDefinition {
  const base = structuredClone(bundledMachines()[0])
  return validateMachineDefinition({
    ...base,
    id: `around-${axis}-tool-selection`,
    rotary: { about: axis, drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

/** A V-bit record in `units`. Cut values differ per unit like the app's defaults. */
function vbit(id: string, units: Units, diameter: number): Tool {
  return {
    ...defaultTool(units, 1),
    id,
    name: `${id} 60 V-bit`,
    units,
    type: 'v_bit',
    diameter,
    vBitAngle: 60,
    maxCutDepth: 0,
    defaultFeed: units === 'mm' ? 600 : 24,
    defaultPlungeFeed: units === 'mm' ? 200 : 8,
    defaultStepdown: units === 'mm' ? 0.4 : 0.02,
  }
}

function nonVbit(id: string, units: Units, diameter: number, type: 'flat_endmill' | 'ball_endmill'): Tool {
  return { ...vbit(id, units, diameter), name: `${id} ${type}`, type }
}

function libraryEntry(id: string, units: Units, diameter: number): ToolLibraryEntry {
  const { id: _id, ...entry } = vbit(id, units, diameter)
  void _id
  return { ...entry, key: id }
}

/** A rotary project in `spec.units` whose only tools are `tools`, switched onto Around. */
function loadRotary(spec: BarSpec, tools: Tool[]): Project {
  const base = newProject(`Tool selection ${spec.axis}`, spec.units)
  base.meta.projectType = 'rotary'
  base.stock = barStock(spec)
  const machine = rotaryMachine(spec.axis)
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = tools
  store().loadProject(projectWithFeatures(base, []))
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  return store().project
}

/** A thread the fixture bar can carry, in `units`. */
function threadInput(units: Units): { kind: 'thread'; start: number; length: number; pitch: number; depth: number } {
  return units === 'mm'
    ? { kind: 'thread', start: 20, length: 40, pitch: 2, depth: 1.2 }
    : { kind: 'thread', start: 1.5, length: 3, pitch: 0.05, depth: 0.1 }
}

/** The candidate's diameter as one physical length in millimetres. */
function physicalMm(diameter: number, units: Units): number {
  return convertLength(diameter, units, 'mm')
}

// ── mixed-unit candidate tables ───────────────────────────────

interface Candidate {
  id: string
  units: Units
  diameter: number
  type?: 'flat_endmill' | 'ball_endmill'
}

interface SelectionCase {
  label: string
  candidates: Candidate[]
  /** The id the thread must be cut with: the physically smallest candidate. */
  expected: string
}

const c = (id: string, units: Units, diameter: number, type?: Candidate['type']): Candidate => ({ id, units, diameter, ...(type ? { type } : {}) })

/**
 * A diameter that is an *exact* floating tie with `0.5 in` under the shared
 * conversion, so the tie test exercises the stable sort rather than a float
 * rounding accident.
 */
const HALF_INCH_MM = convertLength(0.5, 'inch', 'mm')

const SELECTION_CASES: SelectionCase[] = [
  {
    label: '6 mm beats 0.25 in — the inch tool is physically larger (the defect)',
    candidates: [c('small-mm', 'mm', 6), c('large-inch', 'inch', 0.25)],
    expected: 'small-mm',
  },
  {
    label: '6 mm beats 0.25 in with the input order reversed',
    candidates: [c('large-inch', 'inch', 0.25), c('small-mm', 'mm', 6)],
    expected: 'small-mm',
  },
  {
    label: 'three mixed candidates — 6 mm is smaller than both inch tools',
    candidates: [c('half-inch', 'inch', 0.5), c('six-mm', 'mm', 6), c('quarter-inch', 'inch', 0.25)],
    expected: 'six-mm',
  },
  {
    label: 'three mixed candidates in reversed order — 6 mm is still the smallest',
    candidates: [c('quarter-inch', 'inch', 0.25), c('six-mm', 'mm', 6), c('half-inch', 'inch', 0.5)],
    expected: 'six-mm',
  },
  {
    label: 'counterexample — the inch tool really is physically smaller (12 mm vs 0.25 in)',
    candidates: [c('twelve-mm', 'mm', 12), c('quarter-inch', 'inch', 0.25)],
    expected: 'quarter-inch',
  },
  {
    label: 'counterexample in reversed order — the inch tool is still the smaller one',
    candidates: [c('quarter-inch', 'inch', 0.25), c('twelve-mm', 'mm', 12)],
    expected: 'quarter-inch',
  },
  {
    label: 'same-unit mm candidates keep the raw ordering',
    candidates: [c('six-mm', 'mm', 6), c('three-mm', 'mm', 3)],
    expected: 'three-mm',
  },
  {
    label: 'same-unit inch candidates keep the raw ordering',
    candidates: [c('half-inch', 'inch', 0.5), c('quarter-inch', 'inch', 0.25)],
    expected: 'quarter-inch',
  },
  {
    label: 'same-unit exact tie keeps the project order',
    candidates: [c('first-mm', 'mm', 6), c('second-mm', 'mm', 6)],
    expected: 'first-mm',
  },
  {
    label: 'same-unit exact tie keeps the project order when reversed',
    candidates: [c('second-mm', 'mm', 6), c('first-mm', 'mm', 6)],
    expected: 'second-mm',
  },
  {
    label: 'exact cross-unit physical tie (0.5 in vs its mm equivalent) keeps the project order',
    candidates: [c('half-inch', 'inch', 0.5), c('half-inch-mm', 'mm', HALF_INCH_MM)],
    expected: 'half-inch',
  },
  {
    label: 'exact cross-unit physical tie keeps the project order when reversed',
    candidates: [c('half-inch-mm', 'mm', HALF_INCH_MM), c('half-inch', 'inch', 0.5)],
    expected: 'half-inch-mm',
  },
  {
    label: 'a smaller flat endmill is ignored',
    candidates: [c('tiny-flat', 'mm', 1, 'flat_endmill'), c('small-vbit', 'mm', 6)],
    expected: 'small-vbit',
  },
  {
    label: 'a smaller flat endmill is ignored with the input order reversed',
    candidates: [c('small-vbit', 'mm', 6), c('tiny-flat', 'mm', 1, 'flat_endmill')],
    expected: 'small-vbit',
  },
  {
    label: 'a smaller ball endmill is ignored against an inch V-bit',
    candidates: [c('tiny-ball', 'mm', 0.5, 'ball_endmill'), c('quarter-inch', 'inch', 0.25)],
    expected: 'quarter-inch',
  },
  {
    label: 'a tiny other-unit flat endmill is ignored',
    candidates: [c('tiny-flat-inch', 'inch', 0.05, 'flat_endmill'), c('six-mm', 'mm', 6)],
    expected: 'six-mm',
  },
]

console.log('Testing the physically smallest existing V-bit across mixed units...')
{
  for (const projectUnits of ['mm', 'inch'] as const) {
    for (const testCase of SELECTION_CASES) {
      // The table itself must name the physically smallest V-bit candidate, so
      // a wrong expectation cannot silently encode the bug.
      const expectedCandidate = testCase.candidates.find((entry) => entry.id === testCase.expected)
      assert.ok(expectedCandidate, `${testCase.label}: the expected id is one of the candidates`)
      assert.equal(expectedCandidate.type, undefined, `${testCase.label}: the expected candidate is a V-bit`)
      const expectedMm = physicalMm(expectedCandidate.diameter, expectedCandidate.units)
      for (const candidate of testCase.candidates.filter((entry) => entry.type === undefined)) {
        assert.ok(
          expectedMm <= physicalMm(candidate.diameter, candidate.units) + 1e-12,
          `${testCase.label}: the expected tool is the physical smallest V-bit`,
        )
      }

      const bar = projectUnits === 'mm' ? MM_BAR : INCH_BAR
      const tools = testCase.candidates.map((candidate) => (
        candidate.type ? nonVbit(candidate.id, candidate.units, candidate.diameter, candidate.type) : vbit(candidate.id, candidate.units, candidate.diameter)
      ))
      loadRotary(bar, tools)
      const beforeTools = structuredClone(store().project.tools)
      const beforeOrder = store().project.tools.map((tool) => tool.id)
      const historyBefore = store().history.past.length
      const tag = `${projectUnits} project — ${testCase.label}`

      const result = store().addRotaryPattern(threadInput(projectUnits))
      assert.ok(result.ok, `${tag}: the thread is created (${result.ok ? '' : result.reason})`)
      if (!result.ok) throw new Error('unreachable')
      const project = store().project
      const operation = project.operations.find((entry) => entry.id === result.operationId)
      assert.ok(operation, `${tag}: the operation exists`)
      assert.equal(operation.toolRef, testCase.expected, `${tag}: cut with the physically smallest V-bit`)

      // The saved records are not reordered, rewritten or replaced.
      assert.deepEqual(project.tools, beforeTools, `${tag}: the stored tool records are unchanged`)
      assert.deepEqual(project.tools.map((tool) => tool.id), beforeOrder, `${tag}: the stored tool order is unchanged`)
      assert.equal(project.tools.length, beforeTools.length, `${tag}: the existing path imports nothing`)

      // Exactly one undo step, and it leaves the saved records alone.
      assert.equal(store().history.past.length, historyBefore + 1, `${tag}: exactly one history entry`)
      store().undo()
      assert.equal(store().project.operations.length, 0, `${tag}: undo removes the operation`)
      assert.deepEqual(store().project.tools, beforeTools, `${tag}: undo leaves the stored tools`)
      store().redo()
      assert.equal(store().project.operations[0].toolRef, testCase.expected, `${tag}: redo keeps the selection`)
    }
  }
}

// ── existing-first ────────────────────────────────────────────

console.log('Testing an existing V-bit wins over a physically smaller library entry...')
{
  loadRotary(MM_BAR, [vbit('large-existing', 'mm', 12)])
  const beforeTools = structuredClone(store().project.tools)
  const historyBefore = store().history.past.length
  const result = store().addRotaryPattern(threadInput('mm'), [libraryEntry('eighth-inch', 'inch', 0.125)])
  assert.ok(result.ok, 'the thread is created')
  if (!result.ok) throw new Error('unreachable')
  const project = store().project
  const operation = project.operations.find((entry) => entry.id === result.operationId)
  assert.ok(operation, 'the operation exists')
  assert.equal(operation.toolRef, 'large-existing', 'the existing V-bit is used, not the smaller library one')
  assert.deepEqual(project.tools, beforeTools, 'no library tool is imported')
  assert.equal(store().history.past.length, historyBefore + 1, 'the existing path is one undo step')
}

// ── library native preference and conversion ──────────────────

console.log('Testing the library prefers the project unit, then the physical smallest...')
{
  // A smaller entry in the project's own units beats a physically smaller
  // entry in the other unit — the documented native preference is preserved.
  const nativeCases = [
    {
      label: 'mm project prefers its mm entry over a smaller inch one',
      bar: MM_BAR,
      library: [libraryEntry('eighth-inch', 'inch', 0.125), libraryEntry('six-mm', 'mm', 6)],
      units: 'mm' as const,
      diameter: 6,
    },
    {
      label: 'inch project prefers its inch entry over a smaller mm one',
      bar: INCH_BAR,
      library: [libraryEntry('three-mm', 'mm', 3), libraryEntry('half-inch', 'inch', 0.5)],
      units: 'inch' as const,
      diameter: 0.5,
    },
  ]

  for (const testCase of nativeCases) {
    loadRotary(testCase.bar, [])
    const historyBefore = store().history.past.length
    const result = store().addRotaryPattern(threadInput(testCase.bar.units), testCase.library)
    assert.ok(result.ok, `${testCase.label}: the thread is created`)
    if (!result.ok) throw new Error('unreachable')
    const project = store().project
    const operation = project.operations.find((entry) => entry.id === result.operationId)
    assert.ok(operation, `${testCase.label}: the operation exists`)
    const imported = project.tools.find((tool) => tool.id === operation.toolRef)
    assert.ok(imported, `${testCase.label}: the imported tool exists`)
    assert.equal(imported.units, testCase.units, `${testCase.label}: the native-unit entry was imported`)
    near(imported.diameter, testCase.diameter, `${testCase.label}: the native entry keeps its size`)
    assert.equal(project.tools.length, 1, `${testCase.label}: exactly one tool was imported`)
    assert.equal(store().history.past.length, historyBefore + 1, `${testCase.label}: the import is the same undo step`)
    store().undo()
    assert.equal(store().project.tools.length, 0, `${testCase.label}: one undo removes the imported tool`)
  }

  // With no entry in the project's units, the physically smallest other-unit
  // entry is imported, converted into project units.
  loadRotary(MM_BAR, [])
  const result = store().addRotaryPattern(threadInput('mm'), [
    libraryEntry('half-inch', 'inch', 0.5),
    libraryEntry('quarter-inch', 'inch', 0.25),
  ])
  assert.ok(result.ok, 'the fallback import succeeds')
  if (!result.ok) throw new Error('unreachable')
  const project = store().project
  const operation = project.operations.find((entry) => entry.id === result.operationId)
  assert.ok(operation, 'the operation exists')
  const imported = project.tools.find((tool) => tool.id === operation.toolRef)
  assert.ok(imported, 'the imported tool exists')
  assert.equal(imported.units, 'mm', 'the imported tool lands in project units')
  near(imported.diameter, convertLength(0.25, 'inch', 'mm'), 'the physically smallest inch entry was converted')
}

console.log('All rotary pattern tool-selection tests passed.')
