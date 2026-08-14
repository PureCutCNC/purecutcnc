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
 * Pocket move-stream probe — dump a project's pocket output, then compare two
 * dumps. A diagnostic tool, not a quality gate.
 *
 * Built during issue #498 to answer three questions a green test suite and a
 * clean diff could not. Each caught a real defect there, and none of them is
 * specific to that feature, so the tool outlives it:
 *
 *   1. "This change leaves existing output untouched" — checked by diffing
 *      dumped move streams field by field, not by reading a regression test
 *      that asserts what its author expected to be true.
 *   2. "The new mode only ever slows the cut" — checked GEOMETRICALLY, by
 *      matching each move's midpoint to the segment covering it in the other
 *      dump. Comparing by array index silently lies whenever the two runs split
 *      moves differently, which any feed-classification change does.
 *   3. "What does it cost" — estimated cycle time, distinct feed scales, and
 *      the arc-run proxy: maximal contiguous cut runs sharing a `feedScale`.
 *      That last one is what `sameRun` in `arcFitting.ts` keys on, so a
 *      collapse in run length predicts lost G2/G3 output before export.
 *   4. "Did it become depth-dependent" — an offset ring tree is reused at every
 *      Z, so levels cutting the same path length should be fed the same. See
 *      `levels` below; it caught a cache defect nothing else did.
 *
 * Usage:
 *   npx tsx scripts/pocket-output-probe.ts dump <project.camj|builtin> <out.json> ['{"field":value}']
 *   npx tsx scripts/pocket-output-probe.ts compare <baseline.json> <candidate.json>
 *   npx tsx scripts/pocket-output-probe.ts levels <baseline.json> <candidate.json>
 *
 * The optional third argument to `dump` is a JSON object of Operation field
 * overrides applied to every pocket operation, so one project file yields a
 * whole matrix: generate a baseline, then generate again with the field under
 * test flipped, then compare. Fixtures live in `src/engine/test-fixtures/`.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { generatePocketToolpath } from '../src/engine/toolpaths/pocket'
import { effectiveFeed } from '../src/engine/toolpaths/feed'
import { normalizeProject } from '../src/store/helpers/projectFormat'
import { projectWithFeatures } from '../src/test/projectFixtures'
import {
  circleProfile,
  defaultTool,
  newProject,
  rectProfile,
  type Operation,
  type Project,
  type SketchFeature,
  type Tool,
} from '../src/types/project'
import type { ToolpathMove } from '../src/engine/toolpaths/types'

/** [kind, fromX, fromY, fromZ, toX, toY, toZ, feedScale|null] */
type DumpedMove = [string, number, number, number, number, number, number, number | null]

interface DumpedOperation {
  operationId: string
  moveCount: number
  moves: DumpedMove[]
}

type Dump = Record<string, DumpedOperation>

const round = (value: number): number => Number(value.toFixed(6))

function dumpMove(move: ToolpathMove): DumpedMove {
  return [
    move.kind,
    round(move.from.x), round(move.from.y), round(move.from.z),
    round(move.to.x), round(move.to.y), round(move.to.z),
    move.feedScale === undefined ? null : Number(move.feedScale.toFixed(9)),
  ]
}

function loadProject(path: string): Project {
  return normalizeProject(JSON.parse(readFileSync(path, 'utf8')) as Project)
}

// ── Built-in fixture matrix ────────────────────────────────────────────────
//
// No `.camj` in `src/engine/test-fixtures/` contains a pocket operation, and a
// probe that needs a file nobody has is a probe nobody runs. These cover the
// paths a pocket change is most likely to disturb: both patterns, sharp and
// rounded corners, multi-level stepdown, stock-to-leave, an island, a neck
// barely wider than the cutter, and helix entry — which already stamps
// `feedScale` on most of its moves and so is where a feed regression shows up
// first. Pass a `.camj` path instead to probe a real project.

function endmill(id: string, diameter: number): Tool {
  return { ...defaultTool('mm', 1), id, name: `${diameter} mm endmill`, diameter, defaultStepdown: 2, defaultStepover: 0.4 }
}

function rect(id: string, x: number, y: number, w: number, h: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(x, y, w, h), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: 0,
    z_bottom: -4,
    visible: true,
    locked: false,
  }
}

function island(id: string, cx: number, cy: number, radius: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'circle',
    folderId: null,
    sketch: { profile: circleProfile(cx, cy, radius), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'add',
    z_top: 0,
    z_bottom: -4,
    visible: true,
    locked: false,
  }
}

function pocketOperation(id: string, featureIds: string[], overrides: Partial<Operation>): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18_000,
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
    ...overrides,
  }
}

function builtinProject(): Project {
  const features: SketchFeature[] = [
    rect('plain', 0, 0, 60, 60),
    rect('withIsland', 100, 0, 60, 60),
    island('islandCore', 130, 30, 8),
    rect('neckLeft', 0, 100, 34, 40),
    rect('neckMiddle', 34, 116, 12, 8),
    rect('neckRight', 46, 100, 34, 40),
  ]
  const base = newProject('pocket-output-probe', 'mm')
  const project = projectWithFeatures({ ...base, tools: [endmill('t1', 6)] }, features)

  const slot = { pocketSlotFeedPercent: 40 }
  project.operations = [
    pocketOperation('offset-basic', ['plain'], {}),
    pocketOperation('offset-slotfeed', ['plain'], slot),
    pocketOperation('offset-sharp', ['plain'], { ...slot, roundOutsideCorners: false }),
    pocketOperation('offset-rounded', ['plain'], { ...slot, roundOutsideCorners: true }),
    pocketOperation('offset-multilevel', ['plain'], { ...slot, stepdown: 0.8 }),
    pocketOperation('offset-stockleave', ['plain'], { ...slot, stockToLeaveRadial: 0.5 }),
    pocketOperation('offset-helix', ['plain'], { ...slot, entryStrategy: 'helix', entryRampAngle: 5, entryHelixDiameterPercent: 60 }),
    pocketOperation('parallel', ['plain'], { ...slot, pocketPattern: 'parallel' }),
    pocketOperation('parallel-45', ['plain'], { ...slot, pocketPattern: 'parallel', pocketAngle: 45 }),
    pocketOperation('island', ['withIsland', 'islandCore'], slot),
    pocketOperation('neck', ['neckLeft', 'neckMiddle', 'neckRight'], slot),
  ]
  return project
}

function dump(projectPath: string, outPath: string, overridesJson?: string): void {
  const project = projectPath === 'builtin' ? builtinProject() : loadProject(projectPath)
  const overrides = overridesJson ? JSON.parse(overridesJson) as Partial<Operation> : {}
  const pockets = project.operations.filter((operation) => operation.kind === 'pocket')
  if (pockets.length === 0) {
    console.error(`no pocket operations in ${projectPath}`)
    process.exitCode = 1
    return
  }

  const out: Dump = {}
  for (const operation of pockets) {
    const applied = { ...operation, ...overrides } as Operation
    const result = generatePocketToolpath(project, applied)
    out[`${operation.name || operation.id}`] = {
      operationId: operation.id,
      moveCount: result.moves.length,
      moves: result.moves.map(dumpMove),
    }
  }
  writeFileSync(outPath, JSON.stringify(out))
  console.log(`wrote ${outPath}`)
  for (const [label, entry] of Object.entries(out)) {
    const scaled = entry.moves.filter((move) => move[7] !== null).length
    console.log(`  ${label}: ${entry.moveCount} moves, ${scaled} feed-scaled`)
  }
}

const CUT_KINDS = new Set(['cut', 'lead-in', 'lead-out'])

function length3(move: DumpedMove): number {
  return Math.hypot(move[4] - move[1], move[5] - move[2], move[6] - move[3])
}

/** Scale of the move in `moves` whose segment contains `point`, or null. */
function scaleAtPoint(moves: DumpedMove[], point: [number, number, number]): number | null {
  for (const move of moves) {
    if (move[0] === 'rapid') continue
    const total = length3(move)
    if (total <= 0) continue
    const toStart = Math.hypot(point[0] - move[1], point[1] - move[2], point[2] - move[3])
    const toEnd = Math.hypot(point[0] - move[4], point[1] - move[5], point[2] - move[6])
    if (Math.abs(toStart + toEnd - total) < 1e-6 * Math.max(1, total)) {
      return move[7] === null ? 1 : move[7]
    }
  }
  return null
}

/** Maximal contiguous cut runs sharing a feedScale — what arc fitting can join. */
function arcRuns(moves: DumpedMove[]): number[] {
  const runs: number[] = []
  let current = 0
  let previousScale: number | null | undefined
  let previousTo: [number, number, number] | null = null
  for (const move of moves) {
    if (!CUT_KINDS.has(move[0])) {
      if (current > 0) runs.push(current)
      current = 0
      previousScale = undefined
      previousTo = null
      continue
    }
    const contiguous = previousTo !== null
      && Math.hypot(move[1] - previousTo[0], move[2] - previousTo[1], move[3] - previousTo[2]) < 1e-6
    if (current > 0 && contiguous && move[7] === previousScale) {
      current += 1
    } else {
      if (current > 0) runs.push(current)
      current = 1
    }
    previousScale = move[7]
    previousTo = [move[4], move[5], move[6]]
  }
  if (current > 0) runs.push(current)
  return runs
}

/** Cycle-time estimate through the shared feed helper, so it matches the app. */
function estimatedMinutes(moves: DumpedMove[], cutFeed: number, plungeFeed: number): number {
  let total = 0
  for (const move of moves) {
    if (move[0] === 'rapid') continue
    const distance = length3(move)
    if (distance <= 0) continue
    const kind = move[0] as 'cut' | 'plunge' | 'lead-in' | 'lead-out'
    total += distance / effectiveFeed(kind, move[7] ?? undefined, cutFeed, plungeFeed)
  }
  return total
}

function compare(baselinePath: string, candidatePath: string): void {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Dump
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')) as Dump

  console.log('=== 1. identical? ===')
  let identical = true
  for (const [label, base] of Object.entries(baseline)) {
    const other = candidate[label]
    if (!other) {
      console.log(`  MISSING  ${label}`)
      identical = false
      continue
    }
    if (JSON.stringify(base.moves) === JSON.stringify(other.moves)) continue
    identical = false
    console.log(`  DIFFERS  ${label}: ${base.moveCount} -> ${other.moveCount} moves`)
    const limit = Math.min(base.moves.length, other.moves.length)
    for (let index = 0; index < limit; index += 1) {
      if (JSON.stringify(base.moves[index]) !== JSON.stringify(other.moves[index])) {
        console.log(`           first difference at move ${index}`)
        console.log(`             baseline  ${JSON.stringify(base.moves[index])}`)
        console.log(`             candidate ${JSON.stringify(other.moves[index])}`)
        break
      }
    }
  }
  console.log(identical ? '  RESULT: byte-identical' : '  RESULT: differs')

  console.log('\n=== 2. does the candidate ever RAISE a feed? (geometric) ===')
  let violations = 0
  for (const [label, base] of Object.entries(baseline)) {
    const other = candidate[label]
    if (!other) continue
    let checked = 0
    let raised = 0
    for (const move of other.moves) {
      if (move[0] === 'rapid') continue
      const midpoint: [number, number, number] = [
        (move[1] + move[4]) / 2, (move[2] + move[5]) / 2, (move[3] + move[6]) / 2,
      ]
      const baseScale = scaleAtPoint(base.moves, midpoint)
      if (baseScale === null) continue
      checked += 1
      if ((move[7] ?? 1) > baseScale + 1e-9) raised += 1
    }
    violations += raised
    console.log(`  ${label}: checked ${checked}, raised ${raised}`)
  }
  console.log(`  RESULT: ${violations} raised`)

  console.log('\n=== 3. cost and arc-run fragmentation ===')
  console.log('  (cycle time uses nominal 800/300 feeds; the ratio is what matters)')
  for (const [label, base] of Object.entries(baseline)) {
    const other = candidate[label]
    if (!other) continue
    for (const [tag, entry] of [['baseline ', base], ['candidate', other]] as const) {
      const runs = arcRuns(entry.moves)
      const scales = new Set(entry.moves.filter((move) => move[7] !== null).map((move) => move[7]))
      console.log(
        `  ${label} ${tag}: moves=${String(entry.moveCount).padStart(6)}`
        + ` scales=${String(scales.size + 1).padStart(2)}`
        + ` runs=${String(runs.length).padStart(5)}`
        + ` longest=${String(runs.length ? Math.max(...runs) : 0).padStart(5)}`
        + ` minutes=${estimatedMinutes(entry.moves, 800, 300).toFixed(3)}`,
      )
    }
  }
}

/** Per-level cut length and length-weighted mean feed scale. */
interface LevelStat {
  z: number
  length: number
  meanScale: number
}

/**
 * Summarise each step level by *length-weighted mean feed scale*, not by
 * comparing move arrays.
 *
 * Array comparison is the wrong instrument here and gave a false clean result
 * before this was corrected: a change that alters where moves are split makes
 * every level's array differ from every other, so a shape-then-feed comparison
 * silently excludes exactly the levels it was built to inspect. Weighting by
 * path length is immune to how the path happens to be chopped up — the same
 * reason the never-raise check compares geometrically.
 */
function levelStats(moves: DumpedMove[]): LevelStat[] {
  const byLevel = new Map<number, { length: number; weighted: number }>()
  for (const move of moves) {
    // Entry moves descend continuously, so each would land in its own "level"
    // and swamp the comparison. Only fed cutting at a settled Z is meaningful.
    if (!CUT_KINDS.has(move[0])) continue
    if (Math.abs(move[3] - move[6]) > 1e-9) continue
    const distance = Math.hypot(move[4] - move[1], move[5] - move[2])
    if (distance <= 0) continue
    const z = Number(move[6].toFixed(3))
    const entry = byLevel.get(z) ?? { length: 0, weighted: 0 }
    entry.length += distance
    entry.weighted += distance * (move[7] ?? 1)
    byLevel.set(z, entry)
  }
  return [...byLevel.entries()]
    .map(([z, entry]) => ({ z, length: entry.length, meanScale: entry.weighted / entry.length }))
    .sort((a, b) => b.z - a.z)
}

/**
 * Depth dependence, measured against a baseline rather than in absolute terms.
 *
 * An offset ring tree is built once and reused at every Z, so the levels that
 * repeat the same XY path should also be fed identically. But *universal* depth
 * invariance is the wrong property to assert, and asserting it produced four
 * false positives before this was corrected: the bottom level legitimately
 * carries the finish-floor pass, and helix entry descends continuously so
 * grouping its moves by Z is meaningless. Both show up in legacy output.
 *
 * The real property is comparative: **a change must not make a level fed
 * differently from its identically-shaped siblings when the baseline fed them
 * the same.** That cancels the finish-floor and entry artifacts, because the
 * baseline exhibits them too.
 *
 * This caught a per-band cache whose miss rate grew with depth, silently
 * charging slot feed to 71% of the bottom level and 35% of the top. Nothing
 * else caught it: being wrong in the *slow* direction breaks no assertion.
 */
function levels(baselinePath: string, candidatePath: string): void {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Dump
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')) as Dump
  const SPREAD_TOLERANCE = 0.02
  let failures = 0

  for (const [label, base] of Object.entries(baseline)) {
    const other = candidate[label]
    if (!other) continue
    const baseStats = levelStats(base.moves)
    const candidateStats = levelStats(other.moves)
    if (candidateStats.length < 2) {
      console.log(`  ${label}: single level, skipped`)
      continue
    }

    // Only levels cutting the same length of path are comparable; the bottom
    // level legitimately carries the finish-floor pass and is excluded here
    // rather than treated as a defect.
    const topLength = candidateStats[0].length
    const comparable = candidateStats.filter((stat) => Math.abs(stat.length - topLength) < 1e-6)
    const baseComparable = baseStats.filter((stat) => Math.abs(stat.length - baseStats[0].length) < 1e-6)
    if (comparable.length < 2) {
      console.log(`  ${label}: fewer than two comparable levels, skipped`)
      continue
    }

    const spread = (stats: LevelStat[]): number =>
      Math.max(...stats.map((s) => s.meanScale)) - Math.min(...stats.map((s) => s.meanScale))
    const baseSpread = baseComparable.length >= 2 ? spread(baseComparable) : 0
    const candidateSpread = spread(comparable)

    if (candidateSpread <= Math.max(baseSpread, SPREAD_TOLERANCE)) {
      console.log(`  ${label}: OK — ${comparable.length} comparable levels, mean-feed spread ${candidateSpread.toFixed(4)}`)
    } else {
      failures += 1
      console.log(`  ${label}: *** DEPTH-DEPENDENT *** mean-feed spread ${candidateSpread.toFixed(4)} (baseline ${baseSpread.toFixed(4)})`)
      for (const stat of comparable) {
        console.log(`      Z=${String(stat.z).padStart(6)}  length=${stat.length.toFixed(1)}mm  mean feed=${stat.meanScale.toFixed(4)}`)
      }
    }
  }
  console.log(failures === 0 ? '\nRESULT: no new depth dependence' : `\nRESULT: ${failures} operation(s) newly depth-dependent`)
  if (failures > 0) process.exitCode = 1
}

const [mode, first, second, third] = process.argv.slice(2)
if (mode === 'dump' && first && second) {
  dump(first, second, third)
} else if (mode === 'compare' && first && second) {
  compare(first, second)
} else if (mode === 'levels' && first && second) {
  levels(first, second)
} else {
  console.error('usage:')
  console.error('  pocket-output-probe.ts dump <project.camj|builtin> <out.json> [\'{"field":value}\']')
  console.error('  pocket-output-probe.ts compare <baseline.json> <candidate.json>')
  console.error('  pocket-output-probe.ts levels <baseline.json> <candidate.json>')
  process.exitCode = 1
}
