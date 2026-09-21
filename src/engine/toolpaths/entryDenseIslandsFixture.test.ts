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
 * `entry-helix-dense-islands.camj` still cuts exactly what it cut (issue #812).
 *
 * #812 is a pure pruning change to the helix placement search: one indexed pass
 * per clearance contour instead of up to four, plus a bounding-box skip. The
 * argument for it is that `pointToRegionDistance` returns a bit-identical value,
 * so the same placement is chosen and the same G-code comes out. Phase A of the
 * original plan — an early-out that would have been visible in the toolpath —
 * was withdrawn, which leaves this file as the *only* thing standing between a
 * refactor of `pointToRegionDistance` and a silently moved toolpath. It carries
 * the full weight of that argument, so it asserts hashes rather than counts.
 *
 * The fixture is built from scratch by `scripts/generate_entry_helix_fixture.py`
 * rather than copied: the reported project was a user's own file. It reproduces
 * the mechanism — sixteen slots one cutter wide, so the helix radius is clamped
 * to the region's own maximum clearance, and 104 tabs that `withEntryKeepOut`
 * hands to every region as islands. See `src/engine/test-fixtures/INDEX.md`.
 *
 * Every number below was measured twice on the same machine: once with `main`'s
 * `entry.ts` (`ae9bbdcc`) and once with #812's, and they matched — which is the
 * evidence, not the fact that they are written down here.
 *
 *     operation                    ms on main   ms with #812   moves
 *     Drill                                 1              1     679
 *     Edge route inside (rough)         3,534          1,168  45,882
 *     Edge route inside (finish)        7,070            852  14,241
 *     Edge route outside (rough)          245            167   5,049
 *     Edge route outside (finish)         109             59   1,115
 *     total                            10,959          2,247
 *
 * If a hash below moves, #812's premise is broken: the change is no longer
 * pruning, and the toolpath it produces is a different toolpath. Do not update
 * the hash without re-deciding the issue.
 *
 * Run with: npx tsx src/engine/toolpaths/entryDenseIslandsFixture.test.ts
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { runPostProcessor } from '../gcode/postprocessor'
import type { PostProcessorInput } from '../gcode/types'
import { normalizeProject } from '../../store/projectStore'
import type { Project } from '../../types/project'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import type { ToolpathResult } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** First 16 hex digits of the sha256 — enough to pin, short enough to read. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

interface Expectation {
  id: string
  kind: string
  label: string
  moves: number
  /** sha256 of the serialised move array. */
  hash: string
  /** Every warning the operation raises, by code. */
  warnings: Record<string, number>
}

const EXPECTED: Expectation[] = [
  {
    id: 'op0626', kind: 'drilling', label: 'Drill',
    moves: 679, hash: 'e38126d435ec9e75', warnings: {},
  },
  {
    id: 'op0627', kind: 'edge_route_inside', label: 'Edge route inside (rough)',
    moves: 45_882, hash: '502e17ae1967823f',
    warnings: { edgeNoInsideContour: 21, entryStrategyFallback: 12, entryHelixDiameterClamped: 4, tabNoIntersect: 85 },
  },
  {
    id: 'op0628', kind: 'edge_route_inside', label: 'Edge route inside (finish)',
    moves: 14_241, hash: 'a23465077e3c4fe2',
    warnings: { edgeNoInsideContour: 12, entryStrategyFallback: 17, entryHelixDiameterClamped: 3, tabNoIntersect: 95 },
  },
  {
    id: 'op0629', kind: 'edge_route_outside', label: 'Edge route outside (rough)',
    moves: 5_049, hash: '106fe9234bfbe0c6', warnings: { tabNoIntersect: 104 },
  },
  {
    id: 'op0630', kind: 'edge_route_outside', label: 'Edge route outside (finish)',
    moves: 1_115, hash: 'b8c8d0d866d1e555', warnings: { tabNoIntersect: 104 },
  },
]

/** Posted through the bundled `grbl` definition; the moves are what #812 touches, not the dialect. */
const EXPECTED_GCODE_BYTES = 1_544_960

/**
 * sha256 of the posted program, with the generation stamp normalised away.
 *
 * The stamp — `; Generated by PureCutCNC on 2026-09-21`, from
 * `postprocessor.ts`'s one `new Date()` — used to be hashed along with
 * everything else, which pinned the calendar: this fixture went red at the
 * first midnight after #817 landed, on a tree byte-identical to the one that
 * CI had passed hours earlier, and it stayed red for every later run. What this
 * file pins is #812's toolpath claim, and the per-operation move hashes above
 * carry that on their own; a clock is not part of it.
 *
 * This value replaces `b452f2eeb153982e`, recorded the same way over the raw
 * program. Same tree, same program: the only difference is that one line, and
 * the move hashes above were not re-recorded.
 */
const EXPECTED_GCODE_HASH = '68ca801bd2083994'

/** The one environment-dependent line of the program, replaced by a placeholder. */
function withoutGeneratedStamp(gcode: string): string {
  return gcode.replace(
    /^; Generated by PureCutCNC on \d{4}-\d{2}-\d{2}$/m,
    '; Generated by PureCutCNC on <date>',
  )
}

function loadFixture(): Project {
  return normalizeProject(
    JSON.parse(
      readFileSync(join('src', 'engine', 'test-fixtures', 'entry-helix-dense-islands.camj'), 'utf8'),
    ) as Project,
  )
}

// One generation shared by every assertion below — it is ~2.2 s, and nothing
// here mutates the results.
const project = loadFixture()
const generated = new Map<string, ToolpathResult>()
const posted: PostProcessorInput['operations'] = []
for (const operation of project.operations) {
  const envelope = computeOperationToolpath(project, operation)
  if (!envelope) continue
  generated.set(operation.id, envelope.result)
  const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)
  if (tool) {
    posted.push({ operation, toolpath: envelope.result, tool: normalizeToolForProject(tool, project) })
  }
}

console.log('\nentry-helix-dense-islands fixture')

test('fixture still describes the repro: 35 features, 104 tabs, five operations, one 1/4in endmill', () => {
  assert(project.meta.units === 'inch', `expected an inch project, got ${project.meta.units}`)
  assert(project.features.length === 35, `expected 35 features, got ${project.features.length}`)
  assert(project.operations.length === 5, `expected 5 operations, got ${project.operations.length}`)
  const diameters = new Set(project.tools.map((tool) => tool.diameter))
  assert(diameters.size === 1 && diameters.has(0.25),
    `expected a single 1/4in cutter, got ${[...diameters].join(', ')}`)
  assert(project.tabs.length === 104, `expected 104 tabs, got ${project.tabs.length}`)
  const strategies = new Set(
    project.operations
      .filter((operation) => operation.kind !== 'drilling')
      .map((operation) => operation.entryStrategy),
  )
  // 63.7 s of the reported 64.6 s was the ramped (helix) entry path; with
  // `entryStrategy` forced to `plunge` the same five operations took 859 ms.
  // The tabs matter as much as the strategy: `withEntryKeepOut` hands all 104
  // keep-out loops to every clearance region as islands, which is what makes
  // one candidate cell rescan ~2,100 contour points.
  assert(strategies.size === 1 && strategies.has('helix'),
    `the repro is the helix entry path; got entry strategies ${[...strategies].join(', ')}`)
})

for (const expectation of EXPECTED) {
  test(`${expectation.label}: ${expectation.moves.toLocaleString('en-US')} moves, unchanged`, () => {
    const result = generated.get(expectation.id)
    assert(result !== undefined, `fixture must still contain ${expectation.id} (${expectation.label})`)
    const operation = project.operations.find((candidate) => candidate.id === expectation.id)
    assert(operation?.kind === expectation.kind,
      `expected ${expectation.id} to be a ${expectation.kind}, got ${String(operation?.kind)}`)
    assert(result.moves.length === expectation.moves,
      `expected ${expectation.moves} moves, got ${result.moves.length}`)
    const hash = digest(JSON.stringify(result.moves))
    assert(hash === expectation.hash,
      `move hash ${hash}, expected ${expectation.hash}. #812 is pruning only — the same placement, `
      + 'the same moves. A different hash means the placement search now picks a different centre, '
      + 'which is a machining change and not what the issue approved.')
  })

  test(`${expectation.label}: warnings unchanged`, () => {
    const result = generated.get(expectation.id)
    assert(result !== undefined, `fixture must still contain ${expectation.id}`)
    const actual: Record<string, number> = {}
    for (const warning of result.warnings) actual[warning.code] = (actual[warning.code] ?? 0) + 1
    const codes = new Set([...Object.keys(expectation.warnings), ...Object.keys(actual)])
    for (const code of codes) {
      assert(actual[code] === expectation.warnings[code],
        `expected ${expectation.warnings[code] ?? 0} ${code} warnings, got ${actual[code] ?? 0}`)
    }
  })
}

test('the posted G-code is byte-identical but for its generation stamp', () => {
  const definition = BUNDLED_DEFINITIONS.find((candidate) => candidate.id === 'grbl')
  assert(definition !== undefined, 'the bundled grbl definition must exist')
  assert(posted.length === EXPECTED.length,
    `expected all ${EXPECTED.length} operations to post, got ${posted.length}`)
  const result = runPostProcessor({
    project,
    definition,
    operations: posted,
    options: { emitToolChanges: false, emitCoolant: false, programName: 'entry-812' },
  })
  assert(result.gcode.length === EXPECTED_GCODE_BYTES,
    `expected ${EXPECTED_GCODE_BYTES} bytes of G-code, got ${result.gcode.length}`)
  const hash = digest(withoutGeneratedStamp(result.gcode))
  assert(hash === EXPECTED_GCODE_HASH,
    `G-code hash ${hash}, expected ${EXPECTED_GCODE_HASH} — the machine sees a different program`)
})

console.log(`\nentry-helix-dense-islands fixture: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
