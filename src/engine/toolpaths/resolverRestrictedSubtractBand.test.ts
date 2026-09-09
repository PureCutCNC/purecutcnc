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
 * A folded subtract's floor gets its own band, not the whole pocket's (#751 §5).
 *
 * A non-target subtract's Z span was becoming a band boundary for the entire
 * region, so a small feature inside an island split the pocket into an extra
 * full-region pass at its floor. Measured on the maintainer's
 * `complex-pocket-test.camj`: a 0.098 in² circle inside an island forced a third
 * pass over 5.6 in², and held the rough to 0.050/0.050/0.060 bands against a
 * 0.125 stepdown — the stepdown was never once reached. Rough went 5 140 cut
 * moves to 3 634, finish 409 to 287, with every level other than the circle's
 * floor unchanged move for move.
 *
 * That file lives in `work/`, which is gitignored, so its shape is rebuilt here:
 * a body, a pocket target inside it, an island whose top is below the stock top,
 * and a subtract biting into that island and bottoming out above the pocket
 * floor. The deep subtract that pulls the pocket past its own floor is left out
 * — that is #751 §6, undecided.
 */

import { newProject, rectProfile } from '../../types/project'
import type { Operation, SketchFeature } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { resolvePocketRegions } from './resolver'
import type { ResolvedPocketBand, ResolvedPocketResult } from './types'

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

const operation: Operation = {
  id: 'op1',
  name: 'Pocket',
  kind: 'pocket',
  pass: 'rough',
  enabled: true,
  showToolpath: true,
  debugToolpath: false,
  target: { source: 'features', featureIds: ['pocket'] },
  toolRef: null,
  stepdown: 3,
  stepover: 0.5,
  feed: 100,
  plungeFeed: 50,
  rpm: 10000,
  pocketPattern: 'offset',
  pocketAngle: 0,
  stockToLeaveRadial: 0,
  stockToLeaveAxial: 0,
  finishWalls: false,
  finishFloor: false,
  carveDepth: 0,
  maxCarveDepth: 0,
}

// mm explicitly: the inch default's 4 x 3 x 0.75 stock would clip this away.
function resolve(features: SketchFeature[]): ResolvedPocketResult {
  const base = projectWithFeatures(
    newProject('restricted-band', 'mm'),
    features.map((row) => ({ ...row, definitionId: row.id })),
  )
  return resolvePocketRegions({ ...base, operations: [operation] }, operation)
}

function ring(points: { x: number, y: number }[]): number {
  let sum = 0
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

function bandArea(band: ResolvedPocketBand): number {
  return band.regions.reduce(
    (total, region) => total + ring(region.outer)
      - region.islands.reduce((holes, island) => holes + ring(island), 0),
    0,
  )
}

/** Material the operation removes: every band's area times its own height. */
function sweptVolume(result: ResolvedPocketResult): number {
  return result.bands.reduce(
    (total, band) => total + bandArea(band) * Math.abs(band.topZ - band.bottomZ),
    0,
  )
}

function bandAt(result: ResolvedPocketResult, topZ: number, bottomZ: number): ResolvedPocketBand | undefined {
  return result.bands.find((band) => (
    Math.abs(band.topZ - topZ) < 1e-9 && Math.abs(band.bottomZ - bottomZ) < 1e-9
  ))
}

// `complex-pocket-test.camj` in miniature. Stock 20 tall.
const body = () => feature('body', 'add', 10, 10, 80, 60, 0)
/** The operation's target: floor at 14. */
const pocket = () => feature('pocket', 'subtract', 20, 20, 60, 40, 14)
/** Island whose top (17) is below the stock top, as Rect 4 is in the real file. */
const island = () => feature('island', 'add', 30, 30, 30, 20, 0, 17)
/** Bites the island, bottoming out at 16 — above the pocket's floor of 14. */
const bite = () => feature('bite', 'subtract', 35, 33, 10, 8, 16)

console.log('\nA folded subtract floors its own band, not the pocket\'s')

const withoutBite = resolve([body(), pocket(), island()])
const withBite = resolve([body(), pocket(), island(), bite()])

// ── 1. The bite does not split the main region at its floor ─────────
{
  const main = bandAt(withBite, 17, 14)
  check(
    'the main region spans 17..14 in one band, not split at the bite floor',
    main !== undefined,
    `expected a 17..14 band; got ${withBite.bands.map((b) => `${b.topZ}..${b.bottomZ}`).join(' ')}`,
  )
}

// ── 2. The bite gets its own band, carrying only its own area ───────
{
  const restricted = bandAt(withBite, 17, 16)
  const main = bandAt(withBite, 17, 14)
  check(
    'the bite gets its own 17..16 band',
    restricted !== undefined,
    `expected a 17..16 band; got ${withBite.bands.map((b) => `${b.topZ}..${b.bottomZ}`).join(' ')}`,
  )
  if (restricted && main) {
    check(
      'that band carries only the bite, not the whole region',
      bandArea(restricted) < bandArea(main) / 10,
      `restricted band area ${bandArea(restricted)} is not small against the main ${bandArea(main)}`,
    )
    check(
      'the bite area matches the island material it removes (10 x 8 = 80 mm²)',
      Math.abs(bandArea(restricted) - 80) < 1e-6,
      `expected 80 mm², got ${bandArea(restricted)}`,
    )
  }
}

// ── 3. Nothing is left uncut: swept volume is conserved ─────────────
{
  // Without the bite the pocket sweeps its own region over its full depth; with
  // it, exactly the bite's own volume (80 mm² over 17..16) is added.
  const expected = sweptVolume(withoutBite) + 80
  check(
    'swept volume gains exactly the bite, nothing more and nothing less',
    Math.abs(sweptVolume(withBite) - expected) < 1e-6,
    `expected ${expected}, got ${sweptVolume(withBite)}`,
  )
}

// ── 4. A bite stopping short at the TOP is restricted too ──────────
{
  // Same defect mirrored: a subtract reaching the pocket floor but starting
  // below the pocket's top was splitting the whole region at its top edge —
  // measured, a 200 mm² bite cut the 2000 mm² main region into 20..17 and
  // 17..14. Either end being strictly inside the target's span qualifies.
  //
  // Asserted structurally rather than by naming bands: this fixture's island
  // has a `z_top` of 17, so the main region is already split there by the
  // island — legitimately, and that is #751 §5's island half, still open. What
  // the bite must not do is split it any *further*. So: the main bands come
  // back untouched and exactly one band is added, the bite's own.
  const shortTop = feature('bite', 'subtract', 35, 33, 10, 8, 14, 17)
  const result = resolve([body(), pocket(), island(), shortTop])
  const shape = (results: ResolvedPocketResult) => results.bands
    .map((band) => `${band.topZ}..${band.bottomZ}=${bandArea(band).toFixed(0)}`)
    .sort()
  const added = shape(result).filter((row) => !shape(withoutBite).includes(row))
  check(
    'a bite starting below the target top leaves the main bands untouched',
    shape(withoutBite).every((row) => shape(result).includes(row)),
    `main bands changed: ${shape(withoutBite).join(' ')} -> ${shape(result).join(' ')}`,
  )
  check(
    'it adds exactly one band, carrying only the bite',
    added.length === 1 && added[0] === '17..14=80',
    `expected one added band '17..14=80', got [${added.join(', ')}]`,
  )
  check(
    'swept volume is conserved across the top-restricted case too',
    Math.abs(sweptVolume(result) - (sweptVolume(withoutBite) + 80 * 3)) < 1e-6,
    `expected ${sweptVolume(withoutBite) + 80 * 3}, got ${sweptVolume(result)}`,
  )
}

// ── 5. A bite ending AT the pocket floor still adds no band ─────────
{
  // #526's own case. The main band already terminates there, so a restricted
  // band would split the region for nothing.
  const atFloor = resolve([body(), pocket(), island(), feature('bite', 'subtract', 35, 33, 10, 8, 14)])
  check(
    'a bite bottoming out at the pocket floor adds no band of its own',
    atFloor.bands.length === withoutBite.bands.length,
    `expected ${withoutBite.bands.length} bands as without the bite, got ${atFloor.bands.length}`,
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
