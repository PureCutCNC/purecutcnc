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
 * Qualification chains through touching subtracts (#751 §3).
 *
 * #526 made qualification **one hop** from the target and pinned it with a test
 * ("a subtract that only touches another subtract must not change the region").
 * That is deliberately superseded here: a subtract reaching the target only
 * through another subtract is still unowned void the model says is gone, so a
 * clearing pass that machines around it leaves material that is not there —
 * #526's own complaint, one hop further out.
 *
 * The cost of that decision, and it is real: an operation's extent is no longer
 * readable from its target. Measured, a five-link chain grew a pocket from 800
 * to 1800 — geometry four hops from anything it targets. Accepted knowingly, with
 * `MAX_CHAINED_NON_TARGET_SUBTRACTS` as the rail.
 *
 * The limit is **not** a performance guard. Measured resolve time: 0.5 ms with no
 * chain, 3.8 ms at 25 links, 11.5 ms at 50, 40.7 ms at 100 — all inside a frame,
 * and much of the growth is the region genuinely getting bigger rather than
 * discovery working harder. It is a rail against runaway scope, and it says so
 * when it binds rather than quietly serving a short region.
 */

import { newProject, rectProfile } from '../../types/project'
import type { Operation, Project, SketchFeature } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { resolvePocketRegions } from './resolver'
import type { ResolvedPocketResult } from './types'

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
    z_top: 20,
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
  stepdown: 2,
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

/**
 * A target pocket at x 2..6, then `links` subtracts marching right, each one
 * touching only its predecessor. Only the first ever touches the target, so
 * anything past it is reachable by chaining alone.
 *
 * mm explicitly: the inch default's 4 x 3 x 0.75 stock would clip this away.
 */
function chained(links: number): Project {
  const span = 4 + links * 4
  const features: SketchFeature[] = [
    feature('body', 'add', 0, 0, span + 8, 40, 0),
    feature('pocket', 'subtract', 2, 10, 4, 20, 14),
  ]
  for (let index = 0; index < links; index += 1) {
    features.push(feature(`s${index}`, 'subtract', 6 + index * 4, 12, 4, 16, 14))
  }
  const base = projectWithFeatures(
    newProject('subtract-chain', 'mm'),
    features.map((row) => ({ ...row, definitionId: row.id })),
  )
  return { ...base, operations: [operation] }
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

function area(result: ResolvedPocketResult): number {
  return result.bands.reduce(
    (total, band) => total + band.regions.reduce((sum, region) => sum + ring(region.outer), 0),
    0,
  )
}

const limitWarnings = (result: ResolvedPocketResult) =>
  (result.warnings ?? []).filter((warning) => warning.code === 'subtractChainLimitReached')

console.log('\nQualification chains through touching subtracts')

// ── 1. Each link adds its own area — the chain really is followed ───
{
  const areas = [0, 1, 2, 3, 4, 5].map((links) => area(resolvePocketRegions(chained(links), operation)))
  check(
    'every added link grows the region',
    areas.every((value, index) => index === 0 || value > areas[index - 1]),
    `expected a strictly growing series, got ${areas.join(', ')}`,
  )
  check(
    'a link four hops from the target still joins',
    areas[5] > areas[1],
    `five links (${areas[5]}) should exceed one (${areas[1]}) — chaining stopped early`,
  )
}

// ── 2. The limit binds exactly at MAX_CHAINED_NON_TARGET_SUBTRACTS ──
{
  // 64 is the constant. Asserted at the boundary rather than by importing it,
  // so changing the constant without meaning to fails here.
  const under = resolvePocketRegions(chained(64), operation)
  const over = resolvePocketRegions(chained(65), operation)
  check(
    'a 64-link chain is followed in full and stays quiet',
    limitWarnings(under).length === 0,
    `expected no warning at 64 links, got ${JSON.stringify(limitWarnings(under))}`,
  )
  check(
    'a 65-link chain warns rather than truncating silently',
    limitWarnings(over).length === 1,
    `expected one subtractChainLimitReached at 65 links, got ${JSON.stringify(over.warnings)}`,
  )
  check(
    'the warning names the limit and the operation',
    limitWarnings(over)[0]?.params?.limit === 64 && limitWarnings(over)[0]?.params?.operation === 'Pocket',
    `expected {limit: 64, operation: 'Pocket'}, got ${JSON.stringify(limitWarnings(over)[0]?.params)}`,
  )
  check(
    'truncating stops the region growing past the limit',
    Math.abs(area(over) - area(under)) < 1e-6,
    `65 links resolved to ${area(over)}, 64 to ${area(under)} — the cap did not hold`,
  )
}

// ── 3. A subtract touching nothing is still not folded ──────────────
{
  // #526's guarantee for every existing project survives transitivity: only
  // *contact* chains, so an unconnected subtract changes nothing at all.
  const stray = feature('stray', 'subtract', 2, 32, 4, 4, 14)
  const strayProject = projectWithFeatures(
    newProject('subtract-chain', 'mm'),
    [
      feature('body', 'add', 0, 0, 20, 40, 0),
      feature('pocket', 'subtract', 2, 10, 4, 20, 14),
      feature('s0', 'subtract', 6, 12, 4, 16, 14),
      stray,
    ].map((row) => ({ ...row, definitionId: row.id })),
  )
  const withoutStray = projectWithFeatures(
    newProject('subtract-chain', 'mm'),
    [
      feature('body', 'add', 0, 0, 20, 40, 0),
      feature('pocket', 'subtract', 2, 10, 4, 20, 14),
      feature('s0', 'subtract', 6, 12, 4, 16, 14),
    ].map((row) => ({ ...row, definitionId: row.id })),
  )
  check(
    'a subtract touching neither the target nor the chain changes nothing',
    Math.abs(
      area(resolvePocketRegions({ ...strayProject, operations: [operation] }, operation))
      - area(resolvePocketRegions({ ...withoutStray, operations: [operation] }, operation)),
    ) < 1e-6,
    'an unconnected subtract joined the region — contact is no longer what chains',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
