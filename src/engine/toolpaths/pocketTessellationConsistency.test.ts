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
 * Diagnostic + regression tests for issue #359 — pocket tessellation
 * resolution degrades when a circle is broken by an island.
 *
 * Run with: npx tsx src/engine/toolpaths/pocketTessellationConsistency.test.ts
 */

import type { Operation, Project, SketchFeature, Tool } from '../../types/project'
import { circleProfile, defaultTool, newProject } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { generatePocketToolpath } from './pocket'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ── Fixtures ──────────────────────────────────────────────────────

function makeCircleFeature(
  id: string, op: SketchFeature['operation'], cx: number, cy: number, r: number,
  zTop: number, zBottom: number,
): SketchFeature {
  return {
    id, name: id, kind: 'circle', folderId: null,
    sketch: { profile: circleProfile(cx, cy, r), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: op,
    z_top: zTop, z_bottom: zBottom,
    visible: true, locked: false,
  }
}

interface PocketTestConfig {
  roundOutsideCorners: boolean
  pass: 'rough' | 'finish'
}

function buildPocket(endmillDia: number, hasIsland: boolean, cfg: PocketTestConfig): { project: Project; operation: Operation } {
  const tool: Tool = {
    ...defaultTool('inch', 1),
    id: 't1', name: `${endmillDia}" endmill`,
    diameter: endmillDia,
    defaultStepdown: 0.1,
    defaultStepover: 0.4,
  }
  const outer = makeCircleFeature('a', 'subtract', 0, 0, 1.0, 0, -0.5)
  const features: SketchFeature[] = [outer]
  if (hasIsland) features.push(makeCircleFeature('b', 'add', 0, 0.85, 0.18, 0, -0.5))
  const project = projectWithFeatures({ ...newProject('test', 'inch'), tools: [tool] }, features)
  project.stock = { ...project.stock, thickness: 0.75 }

  const op: Operation = {
    id: 'op1', name: 'op', kind: 'pocket', pass: cfg.pass,
    enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds: ['a'] },
    toolRef: 't1',
    stepdown: 0.1, stepover: 0.4,
    feed: 40, plungeFeed: 20, rpm: 12000,
    pocketPattern: 'offset', pocketAngle: 0,
    roundOutsideCorners: cfg.roundOutsideCorners,
    stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: cfg.pass === 'finish',
    finishFloor: false,
    carveDepth: 0.5, maxCarveDepth: 0.5,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
  return { project, operation: op }
}

// ── Chord-sagitta measurement ─────────────────────────────────────

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function chordSagitta(chordLen: number, radius: number): number {
  if (chordLen <= 0 || radius <= 0) return 0
  const half = chordLen / 2
  if (half >= radius) return radius
  return radius - Math.sqrt(radius * radius - half * half)
}

function extractContours(cutMoves: ToolpathMove[], z: number): Array<{ x: number; y: number }[]> {
  const zMoves = cutMoves.filter((m) =>
    m.kind === 'cut' && Math.abs(m.from.z - z) < 1e-6 && Math.abs(m.to.z - z) < 1e-6,
  )
  if (zMoves.length === 0) return []
  const lists: Array<{ x: number; y: number }[]> = []
  let cur: { x: number; y: number }[] = [{ x: zMoves[0].from.x, y: zMoves[0].from.y }]
  for (const m of zMoves) {
    const last = cur[cur.length - 1]
    if (Math.abs(m.from.x - last.x) > 1e-6 || Math.abs(m.from.y - last.y) > 1e-6) {
      if (cur.length >= 3) lists.push(cur)
      cur = [{ x: m.from.x, y: m.from.y }]
    }
    cur.push({ x: m.to.x, y: m.to.y })
  }
  if (cur.length >= 3) lists.push(cur)
  return lists
}

function maxChordSagittaInContours(contours: Array<{ x: number; y: number }[]>, radius: number): number {
  let maxSag = 0
  for (const pts of contours) {
    for (let i = 0; i < pts.length; i++) {
      const sag = chordSagitta(dist(pts[i], pts[(i + 1) % pts.length]), radius)
      if (sag > maxSag) maxSag = sag
    }
  }
  return maxSag
}

// ── Tests ─────────────────────────────────────────────────────────

function testChordSagitta(label: string, cfg: PocketTestConfig) {
  const full = buildPocket(0.25, false, cfg)
  const broken = buildPocket(0.25, true, cfg)
  const fullRes = generatePocketToolpath(full.project, full.operation)
  const brokenRes = generatePocketToolpath(broken.project, broken.operation)
  const wallR = 1.0 - 0.125

  let fullSag = 0, brokenSag = 0
  for (const z of fullRes.stepLevels) {
    const s = maxChordSagittaInContours(extractContours(fullRes.moves, z), wallR)
    if (s > fullSag) fullSag = s
  }
  for (const z of brokenRes.stepLevels) {
    const s = maxChordSagittaInContours(extractContours(brokenRes.moves, z), wallR)
    if (s > brokenSag) brokenSag = s
  }

  console.log(`\n${label}`)
  console.log(`  full max sagitta:    ${fullSag.toFixed(6)}"`)
  console.log(`  broken max sagitta:  ${brokenSag.toFixed(6)}"`)
  const ratio = fullSag > 1e-12 ? brokenSag / fullSag : 1
  console.log(`  ratio:               ${ratio.toFixed(2)}x`)
  if (brokenSag > fullSag * 1.1 && brokenSag > 0.0005) {
    console.log(`  ⚠ DEGRADATION (${((ratio - 1) * 100).toFixed(0)}%)`)
  } else {
    console.log(`  ✓ Consistent`)
  }
  assert(fullSag > 0, `${label}: full sagitta should be > 0`)
  assert(brokenSag > 0, `${label}: broken sagitta should be > 0`)
}

// ── Driver ────────────────────────────────────────────────────────

try {
  testChordSagitta('Generator: finish, no rounding',  { pass: 'finish', roundOutsideCorners: false })
  testChordSagitta('Generator: finish, rounding ON',  { pass: 'finish', roundOutsideCorners: true })
  testChordSagitta('Generator: rough, no rounding',   { pass: 'rough',  roundOutsideCorners: false })
  testChordSagitta('Generator: rough, rounding ON',   { pass: 'rough',  roundOutsideCorners: true })
  console.log('\nAll pocket tessellation consistency tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}