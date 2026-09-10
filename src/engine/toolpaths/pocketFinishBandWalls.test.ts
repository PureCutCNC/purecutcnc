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
 * One pass down a wall, and a floor only where there is one (#751 §5).
 *
 * An island whose `z_top` sits below the pocket top splits the pocket at that Z.
 * The split is correct — the outline changes there — but the finish then ran a
 * *full* wall contour and a *full* floor pass in each band. So the pocket wall
 * was traced twice, leaving a witness line at a height where the wall has no
 * feature, and the floor pass at the island's Z swept the whole pocket when only
 * the island's top face has anything to skim.
 *
 * **Walls only.** The floor half of this was reverted: restricting the floor pass
 * to material-bearing ground treats the *voids* below as obstacles to inset away
 * from, when at this Z they are free space the cutter may fly over. On the
 * maintainer's `complex-pocket-test.camj` that left the island top unmachined —
 * the expanded holes met and nothing survived the inset — where the unrestricted
 * pass reached it fine. The floor needs a domain-versus-coverage split that the
 * offset-ring construction does not currently express; see #751.
 *
 * **The parity corpus does not cover this.** It stayed 169/169 byte-identical
 * across the change, because no corpus project has a multi-band finish. These
 * cases are the only guard, which is why they assert per-Z move counts rather
 * than a total.
 */

import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { Operation, PocketPattern, Project, SketchFeature } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { generatePocketToolpath } from './pocket'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

function feature(
  id: string,
  operation: SketchFeature['operation'],
  x: number,
  y: number,
  w: number,
  h: number,
  zBottom: number,
  zTop = 20,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

const tool = { ...defaultTool('mm', 1), id: 't1', diameter: 3 }

function operation(pattern: PocketPattern, floors = true): Operation {
  return {
    id: 'op1',
    name: 'Finish',
    kind: 'pocket',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['pocket'] },
    toolRef: 't1',
    stepdown: 3,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: pattern,
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: floors,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

// mm explicitly: the inch default's 4 x 3 x 0.75 stock would clip this away.
const body = () => feature('body', 'add', 10, 10, 80, 60, 0)
/** Pocket floor at 14; its wall therefore runs 20 down to 14, unbroken. */
const pocket = () => feature('pocket', 'subtract', 20, 20, 60, 40, 14)

interface LevelStats { count: number, minX: number, maxX: number }

/** Cut moves per Z, with the X extent each level actually reaches. */
function movesByZ(features: SketchFeature[], pattern: PocketPattern, floors = true): Map<number, LevelStats> {
  const op = operation(pattern, floors)
  const base = projectWithFeatures(
    newProject('finish-band-walls', 'mm'),
    features.map((row) => ({ ...row, definitionId: row.id })),
  )
  const project: Project = { ...base, tools: [tool], operations: [op] }
  const result = generatePocketToolpath(project, op)
  const byZ = new Map<number, LevelStats>()
  for (const move of result.moves) {
    if (move.kind !== 'cut' && move.kind !== 'lead_in') continue
    const z = Number(move.to.z.toFixed(2))
    const stats = byZ.get(z) ?? { count: 0, minX: Infinity, maxX: -Infinity }
    stats.count += 1
    stats.minX = Math.min(stats.minX, move.to.x)
    stats.maxX = Math.max(stats.maxX, move.to.x)
    byZ.set(z, stats)
  }
  return byZ
}

console.log('\nPocket finish: one pass down a wall, a floor only where there is one')

for (const pattern of ['offset', 'parallel'] as const) {
  console.log(`\n  pattern: ${pattern}`)

  const plain = movesByZ([body(), pocket()], pattern)
  const deep = plain.get(14)?.count ?? 0

  // ── 1. Baseline: no island, one band, one pass ────────────────────
  check(
    `${pattern}: without an island the finish is a single pass at the floor`,
    plain.size === 1 && deep > 0,
    `expected one Z level, got ${[...plain.entries()].map(([z, n]) => `Z${z}:${n}`).join(' ')}`,
  )

  // ── 2. The island's Z carries far less than a full pass ───────────
  {
    // `z_top` 17 is deliberately off the pocket floor and below the pocket top,
    // so the resolver splits the pocket there.
    const withIsland = movesByZ([body(), pocket(), feature('isl', 'add', 35, 30, 20, 20, 0, 17)], pattern)
    const atIslandTop = withIsland.get(17)?.count ?? 0
    const atFloor = withIsland.get(14)?.count ?? 0
    check(
      `${pattern}: the island's Z is still machined`,
      atIslandTop > 0,
      'the island top face got no pass at all — it needs skimming',
    )
    check(
      `${pattern}: the wall contour is not repeated there`,
      atIslandTop < deep,
      `Z17 has ${atIslandTop} moves against a full pass of ${deep} — nothing was dropped`,
    )
    // The decisive wall test runs with **floors off**, so the only thing that can
    // appear at the island's Z is a wall contour. With floors on, the floor pass
    // still sweeps the whole pocket there — see the header — and its extent
    // masks whatever the wall did, which is how an earlier version of this case
    // passed while the dedup was disabled.
    const wallsOnly = movesByZ([body(), pocket(), feature('isl', 'add', 35, 30, 20, 20, 0, 17)], pattern, false)
    check(
      `${pattern}: no wall contour is emitted where the wall carries on below`,
      (wallsOnly.get(17)?.count ?? 0) === 0,
      `Z17 emitted ${wallsOnly.get(17)?.count ?? 0} wall moves spanning `
        + `${((wallsOnly.get(17)?.maxX ?? 0) - (wallsOnly.get(17)?.minX ?? 0)).toFixed(1)}`
        + ' — the pocket wall is being finished twice',
    )
    check(
      `${pattern}: the wall is still finished once, at its true bottom`,
      (wallsOnly.get(14)?.count ?? 0) > 0,
      'the wall was dropped from both bands and never finished at all',
    )
    check(
      `${pattern}: the deepest pass still finishes the whole region`,
      atFloor > 0,
      'the floor pass at the pocket bottom went missing',
    )
  }

  // ── 3. Where the island sits does not change the cost ─────────────
  {
    // The saving must come from the wall continuing and the floor being absent,
    // not from a Z that happens to land on the stepdown ladder.
    const counts = [16, 17, 19].map((zTop) => {
      const rows = movesByZ([body(), pocket(), feature('isl', 'add', 35, 30, 20, 20, 0, zTop)], pattern)
      return rows.get(zTop)?.count ?? 0
    })
    check(
      `${pattern}: the island's Z costs the same wherever it sits`,
      counts.every((count) => count === counts[0]),
      `expected equal counts for z_top 16/17/19, got ${counts.join(', ')}`,
    )
  }

  // ── 4. An island reaching the top adds no band at all ─────────────
  {
    const fullHeight = movesByZ([body(), pocket(), feature('isl', 'add', 35, 30, 20, 20, 0, 20)], pattern)
    check(
      `${pattern}: an island reaching the stock top stays a single pass`,
      fullHeight.size === 1,
      `expected one Z level, got ${[...fullHeight.entries()].map(([z, v]) => `Z${z}:${v.count}`).join(' ')}`,
    )
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
