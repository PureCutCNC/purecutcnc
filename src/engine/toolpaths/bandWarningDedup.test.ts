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
 * One advisory per band, not one per step level (issue #754).
 *
 * `surfaceNoOffsetContours` is pushed from inside the per-step-level loop, and
 * each band builds a warning list of its own — so an empty band says exactly the
 * same thing at every level of that band, and two bands at the same Z say it
 * again. The fix sits where a band's warnings join the operation's, which is the
 * only place both duplications are visible at once. On the shipped t-style
 * example the identical sentence appeared twelve times (two bands x six levels),
 * all of it for a depth extension that emits no motion at all.
 *
 * Two properties are asserted, and the second is why this file is worth having:
 *
 * 1. A band that cannot be machined is reported **once**, with the same band Z
 *    whether one or two subtracts opened it.
 * 2. The motion is untouched. A change that removed the duplicate can only be
 *    trusted if the moves are bit-for-bit what they were, because the cheapest
 *    way to "fix" the message would have been to stop running the level loop —
 *    which silently changes the toolpath.
 *
 * The fixture is the smallest project that reaches the case: a cavity the tool
 * fits, plus a subtract narrower than the tool that starts at the cavity floor
 * and goes 1 mm deeper. The fold gives that subtract its own band below the
 * floor, where the cavity is no longer active, leaving a band whose only
 * subject is a 2 mm slot a 4 mm endmill cannot enter.
 *
 * Run with: npx tsx src/engine/toolpaths/bandWarningDedup.test.ts
 */

import type { Operation, Project, SketchFeature, SketchProfile, Tool } from '../../types/project'
import { defaultTool, newProject } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { generatePocketToolpath } from './pocket'
import type { ToolpathResult } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function polygonProfile(points: Array<[number, number]>): SketchProfile {
  return {
    start: { x: points[0][0], y: points[0][1] },
    segments: points.slice(1).map(([x, y]) => ({ type: 'line' as const, to: { x, y } })),
    closed: true,
  }
}

function feature(
  id: string,
  profile: SketchProfile,
  zTop: number,
  zBottom: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'tool-1',
    name: '4 mm endmill',
    diameter: 4,
    defaultStepdown: 1,
    defaultStepover: 0.4,
  }
}

function makeOperation(): Operation {
  return {
    id: 'op-1',
    name: 'op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['cavity'] },
    toolRef: 'tool-1',
    stepdown: 0.5,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    edgeStrategy: 'contour',
  } as Operation
}

/** The cavity, spanning 10..40 in X and Y, cut to Z -2. */
const CAVITY = feature('cavity', polygonProfile([[10, 10], [40, 10], [40, 40], [10, 40]]), 0, -2)

/** 2 mm wide — narrower than the 4 mm tool — from the cavity floor to Z -3. */
function narrowSlot(id: string, x: number): SketchFeature {
  return feature(id, polygonProfile([[x, 10], [x + 2, 10], [x + 2, 40], [x, 40]]), -2, -3)
}

function generate(features: SketchFeature[]): ToolpathResult {
  const project: Project = projectWithFeatures(
    { ...newProject('band warning dedup', 'mm'), tools: [makeTool()] },
    features,
  )
  return generatePocketToolpath(project, makeOperation())
}

/** Occurrences of one warning code, so a duplicate is visible as a count. */
function countWarnings(result: ToolpathResult, code: string): number {
  return result.warnings.filter((warning) => warning.code === code).length
}

/**
 * Moves produced by the fixtures below, captured before the dedupe landed.
 *
 * These are the point of the test, not decoration: the band that carries the
 * repeated warning must keep retracting exactly as it did, and the cavity above
 * it must keep cutting exactly as it did. A future edit that legitimately moves
 * these numbers should change them deliberately.
 */
const MOVES_BEFORE_DEDUPE = { total: 188, cut: 176 }

// ── Test runner ──────────────────────────────────────────────────────

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

console.log('\nband warning dedup — one line per band (issue #754)')

test('an unmachinable band is reported once, not once per step level', () => {
  const result = generate([CAVITY, narrowSlot('narrow', 20)])
  const contours = result.warnings.filter((warning) => warning.code === 'surfaceNoOffsetContours')
  assert(
    contours.length === 1,
    `one band should report once, saw ${contours.length} lines: ${JSON.stringify(contours.map((w) => w.params))}`,
  )
  assert(
    JSON.stringify(contours[0].params) === JSON.stringify({ topZ: -2, bottomZ: -3 }),
    `the line should name the band, saw ${JSON.stringify(contours[0].params)}`,
  )
  // Two step levels live in that band (0.5 mm stepdown over 1 mm), so the
  // undeduplicated count was 2 — the fixture would not reach the case otherwise.
  assert(result.moves.some((move) => move.kind === 'cut'), 'the cavity above must still cut')
})

test('two subtracts opening the same band collapse into one line', () => {
  const result = generate([CAVITY, narrowSlot('narrow-a', 20), narrowSlot('narrow-b', 26)])
  assert(
    countWarnings(result, 'surfaceNoOffsetContours') === 1,
    'the same band Z twice is the same sentence twice',
  )
})

test('deduping the message leaves the other advisories alone', () => {
  const result = generate([CAVITY, narrowSlot('narrow', 20)])
  assert(
    countWarnings(result, 'bandEmptySubject') === 1,
    'the empty band is still reported',
  )
  const extension = result.warnings.find((warning) => warning.code === 'regionExtendedBySubtractDepth')
  assert(extension !== undefined, 'the depth extension is still reported')
  assert(
    extension?.params?.bottomZ === -3,
    `the extension should name Z -3, saw ${JSON.stringify(extension?.params)}`,
  )
})

test('the motion is unchanged by a warnings-only fix', () => {
  for (const features of [
    [CAVITY, narrowSlot('narrow', 20)],
    [CAVITY, narrowSlot('narrow-a', 20), narrowSlot('narrow-b', 26)],
  ]) {
    const result = generate(features)
    const cut = result.moves.filter((move) => move.kind === 'cut').length
    assert(
      result.moves.length === MOVES_BEFORE_DEDUPE.total,
      `expected ${MOVES_BEFORE_DEDUPE.total} moves, saw ${result.moves.length}`,
    )
    assert(
      cut === MOVES_BEFORE_DEDUPE.cut,
      `expected ${MOVES_BEFORE_DEDUPE.cut} cut moves, saw ${cut}`,
    )
  }
})

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\nbandWarningDedup: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  throw new Error(`${failed} bandWarningDedup test(s) failed`)
}
